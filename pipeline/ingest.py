"""Download raw ISD station-year files from the NOAA public S3 bucket.

Files are kept exactly as downloaded (gzipped fixed-width text) under
data/raw/<year>/<usaf>-<wban>-<year>.gz so the pipeline is re-runnable and the
raw storage size can be measured. Missing objects (404) are recorded, not fatal.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

import httpx
import polars as pl

from pipeline.config import RAW_DIR, S3_BASE, YEARS

CONCURRENCY = 48


async def _fetch(
    client: httpx.AsyncClient, sem: asyncio.Semaphore, key: str, dest: Path
) -> tuple[str, str, int]:
    if dest.exists():
        return key, "cached", dest.stat().st_size
    async with sem:
        for attempt in range(4):
            try:
                r = await client.get(f"{S3_BASE}/{key}")
                if r.status_code == 404:
                    return key, "missing", 0
                r.raise_for_status()
                dest.write_bytes(r.content)
                return key, "downloaded", len(r.content)
            except (httpx.HTTPError, OSError):
                await asyncio.sleep(1.5 * (attempt + 1))
        return key, "error", 0


async def download(station_ids: list[str], years: list[int]) -> dict:
    jobs = []
    for y in years:
        (RAW_DIR / str(y)).mkdir(exist_ok=True)
        for sid in station_ids:
            jobs.append((f"data/{y}/{sid}-{y}.gz", RAW_DIR / str(y) / f"{sid}-{y}.gz"))
    sem = asyncio.Semaphore(CONCURRENCY)
    t0 = time.time()
    results: list[tuple[str, str, int]] = []
    async with httpx.AsyncClient(timeout=120) as client:
        tasks = [_fetch(client, sem, k, d) for k, d in jobs]
        for i, coro in enumerate(asyncio.as_completed(tasks), 1):
            results.append(await coro)
            if i % 1000 == 0:
                done_bytes = sum(r[2] for r in results)
                print(
                    f"{i}/{len(jobs)} files, {done_bytes / 1e9:.2f} GB, {time.time() - t0:.0f}s",
                    file=sys.stderr,
                )
    status = {}
    for _, s, _ in results:
        status[s] = status.get(s, 0) + 1
    summary = {
        "files_requested": len(jobs),
        "status_counts": status,
        "bytes_on_disk": sum(r[2] for r in results),
        "seconds": round(time.time() - t0, 1),
        "missing_keys": [k for k, s, _ in results if s == "missing"],
    }
    return summary


if __name__ == "__main__":
    cand = pl.read_parquet(RAW_DIR / "candidate_stations.parquet")
    years = [int(a) for a in sys.argv[1:]] or YEARS
    summary = asyncio.run(download(cand["station_id"].to_list(), years))
    (RAW_DIR / "ingest_summary.json").write_text(json.dumps(summary, indent=2))
    print({k: v for k, v in summary.items() if k != "missing_keys"})
