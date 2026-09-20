"""Orchestrate parse -> clean -> daily aggregation over all raw files.

Runs one station-year file per worker task. Per-file cleaning statistics are
summed into data/processed/pipeline_stats.json together with wall time and peak
memory so that the preprocessing dashboard shows measured numbers.

Outputs:
  data/interim/<year>/<station>.parquet   cleaned hourly rows (provenance / queries)
  data/daily/daily.parquet                all station-day rows
  data/processed/pipeline_stats.json      counts, sizes, timings
"""

from __future__ import annotations

import json
import os
import resource
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

import polars as pl

from pipeline.aggregate import hourly_to_daily
from pipeline.clean import clean
from pipeline.config import DAILY_DIR, INTERIM_DIR, PROCESSED_DIR, RAW_DIR, YEARS
from pipeline.parse import RAW_COLUMNS, parse_file


def _merge(acc: dict, s: dict) -> None:
    for k, v in s.items():
        if isinstance(v, dict):
            acc.setdefault(k, {})
            _merge(acc[k], v)
        elif isinstance(v, (int, float)):
            acc[k] = acc.get(k, 0) + v


def process_file(path: Path) -> tuple[dict, pl.DataFrame | None]:
    year = path.parent.name
    raw = parse_file(path)
    if raw.height == 0:
        return {"files": 1, "raw_bytes_gz": path.stat().st_size, "raw_records": 0, "empty_files": 1}, None
    hourly, stats = clean(raw)
    stats["files"] = 1
    stats["raw_bytes_gz"] = path.stat().st_size
    out_dir = INTERIM_DIR / year
    out_dir.mkdir(exist_ok=True)
    hourly.write_parquet(out_dir / f"{path.stem}.parquet", compression="zstd")
    daily = hourly_to_daily(hourly)
    return stats, daily


def main(years: list[int]) -> None:
    files = sorted(p for y in years for p in (RAW_DIR / str(y)).glob("*.gz"))
    print(f"{len(files)} raw files", file=sys.stderr)
    t0 = time.time()
    acc: dict = {"years": years, "raw_columns": RAW_COLUMNS}
    dailies: list[pl.DataFrame] = []
    with ProcessPoolExecutor(max_workers=os.cpu_count()) as ex:
        futs = [ex.submit(process_file, p) for p in files]
        for i, f in enumerate(as_completed(futs), 1):
            stats, daily = f.result()
            _merge(acc, stats)
            if daily is not None:
                dailies.append(daily)
            if i % 1000 == 0:
                print(f"{i}/{len(files)} {time.time() - t0:.0f}s", file=sys.stderr)
    daily_all = pl.concat(dailies, how="vertical_relaxed")
    DAILY_DIR.mkdir(exist_ok=True)
    daily_all.write_parquet(DAILY_DIR / "daily.parquet", compression="zstd")
    acc["processing_seconds"] = round(time.time() - t0, 1)
    acc["peak_rss_mb_parent"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1)
    acc["peak_rss_mb_worker_max"] = round(resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024, 1)
    acc["daily_rows"] = daily_all.height
    acc["stations_with_data"] = daily_all["station_id"].n_unique()
    acc["interim_bytes_parquet"] = sum(p.stat().st_size for p in INTERIM_DIR.rglob("*.parquet"))
    acc["daily_bytes_parquet"] = (DAILY_DIR / "daily.parquet").stat().st_size
    acc["cpu_count"] = os.cpu_count()
    (PROCESSED_DIR / "pipeline_stats.json").write_text(json.dumps(acc, indent=2))
    print(json.dumps({k: v for k, v in acc.items() if not isinstance(v, (dict, list))}, indent=2))


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]] or YEARS)
