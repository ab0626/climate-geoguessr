"""FastAPI backend. All numbers come from data/processed artefacts; the API only
looks things up, computes distances/scores, and formats responses."""

from __future__ import annotations

import random
import time
import uuid
from pathlib import Path

import polars as pl
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.clue import make_clue
from backend.scoring import MAX_SCORE, PERFECT_RADIUS_MI, SCALE_MI, score_for_distance
from backend.store import get_store, haversine_mi
from features.build import FEATURE_COLUMNS, FEATURE_DEFS
from pipeline.config import (
    END_YEAR,
    MIN_DAYS_FRACTION,
    MIN_OBS_PER_DAY,
    PHYSICAL_BOUNDS,
    QC_FAIL_CODES,
    START_YEAR,
)

app = FastAPI(title="Climate GeoGuessr API")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

ROUNDS: dict[str, dict] = {}
ROUND_SECONDS = 45
LATENCY_MS: dict[str, list[float]] = {}


@app.middleware("http")
async def record_latency(request, call_next):
    t0 = time.perf_counter()
    response = await call_next(request)
    if request.url.path.startswith("/api/"):
        # collapse ids (contain digits/dashes) so /api/locations/<id> and /api/round/<id>/guess pool
        parts = ["{id}" if any(ch.isdigit() for ch in p) else p for p in request.url.path.split("/")]
        LATENCY_MS.setdefault(f"{request.method} {'/'.join(parts)}", []).append(
            (time.perf_counter() - t0) * 1000
        )
    return response


def latency_summary() -> dict[str, dict]:
    out = {}
    for k, v in LATENCY_MS.items():
        v_sorted = sorted(v)
        out[k] = {
            "n": len(v),
            "p50_ms": round(v_sorted[len(v) // 2], 2),
            "p95_ms": round(v_sorted[min(len(v) - 1, int(len(v) * 0.95))], 2),
            "max_ms": round(v_sorted[-1], 2),
        }
    return out


PUBLIC_LOCATION_FIELDS = [
    "station_id",
    "name",
    "state",
    "lat",
    "lon",
    "elev_m",
    "cluster",
    "pc1",
    "pc2",
    "silhouette",
]


def public_location(loc: dict) -> dict:
    out = {k: loc.get(k) for k in PUBLIC_LOCATION_FIELDS}
    out["features"] = {c: loc[c] for c in FEATURE_COLUMNS}
    out["percentiles"] = {c: loc[f"pct_{c}"] for c in FEATURE_COLUMNS}
    out["coverage"] = {
        "n_hourly_reports": loc["n_hourly_reports"],
        "n_days_with_data": loc["n_days_with_data"],
        "n_valid_days": loc["n_valid_days"],
        "valid_day_fraction": loc["valid_day_fraction"],
        "first_day": str(loc["first_day"]),
        "last_day": str(loc["last_day"]),
        "n_years": loc["n_years"],
        "n_temp_days": loc["n_temp_days"],
        "n_dewpoint_days": loc["n_dewpoint_days"],
        "n_wind_days": loc["n_wind_days"],
        "n_visibility_days": loc["n_visibility_days"],
        "n_days_with_precip_report": loc["n_days_with_precip_report"],
        "n_precip_24h_days": loc["n_precip_24h_days"],
        "n_precip_stuck_days": loc["n_precip_stuck_days"],
        "n_precip_implausible_days": loc["n_precip_implausible_days"],
    }
    return out


class Guess(BaseModel):
    lat: float
    lon: float


@app.get("/api/health")
def health():
    s = get_store()
    return {"locations": len(s.ids), "clusters": len(s.clusters)}


@app.post("/api/round")
def new_round():
    s = get_store()
    target = random.choice(s.ids)
    loc = s.get(target)
    clue = make_clue(loc)
    rid = uuid.uuid4().hex[:12]
    ROUNDS[rid] = {"target": target, "started": time.time()}
    if len(ROUNDS) > 5000:
        for k in list(ROUNDS)[:1000]:
            ROUNDS.pop(k, None)
    return {"round_id": rid, "clue": clue["text"], "clue_source": clue["source"], "seconds": ROUND_SECONDS}


@app.post("/api/round/{round_id}/guess")
def submit_guess(round_id: str, guess: Guess):
    s = get_store()
    rnd = ROUNDS.get(round_id)
    if not rnd:
        raise HTTPException(404, "unknown round")
    target = s.get(rnd["target"])
    dist = float(haversine_mi(guess.lat, guess.lon, target["lat"], target["lon"]))
    nearest_id, nearest_mi = s.nearest_station(guess.lat, guess.lon)
    nearest = s.get(nearest_id)
    cdist = s.climate_distance(target["station_id"], nearest_id)
    tz, gz = s.z_vector(target["station_id"]), s.z_vector(nearest_id)
    per_feature = [
        {
            "feature": c,
            "label": FEATURE_DEFS[c]["label"],
            "unit": FEATURE_DEFS[c]["unit"],
            "target": target[c],
            "guess": nearest[c],
            "target_pct": target[f"pct_{c}"],
            "guess_pct": nearest[f"pct_{c}"],
            "z_gap": abs(tz[c] - gz[c]),
        }
        for c in FEATURE_COLUMNS
    ]
    cluster = s.clusters[target["cluster"]]
    clue = make_clue(target)
    elapsed = time.time() - rnd["started"]
    return {
        "round_id": round_id,
        "distance_mi": dist,
        "score": score_for_distance(dist),
        "max_score": MAX_SCORE,
        "elapsed_seconds": elapsed,
        "target": public_location(target),
        "guess": {"lat": guess.lat, "lon": guess.lon},
        "nearest_station_to_guess": public_location(nearest) | {"distance_from_guess_mi": nearest_mi},
        "climate_distance": cdist,
        "climate_similarity_pct": s.similarity_pct(cdist),
        "per_feature": per_feature,
        "cluster": {
            "cluster": cluster["cluster"],
            "size": cluster["size"],
            "traits": cluster["traits"],
            "states": cluster["states"],
        },
        "same_cluster": target["cluster"] == nearest["cluster"],
        "clue_facts": clue["facts"],
        "neighbors": s.neighbors_of(target["station_id"]),
    }


@app.get("/api/locations")
def locations():
    s = get_store()
    cols = [
        "station_id",
        "name",
        "state",
        "lat",
        "lon",
        "cluster",
        "pc1",
        "pc2",
        "silhouette",
        "valid_day_fraction",
    ] + FEATURE_COLUMNS
    return s.locations.select(cols).to_dicts()


@app.get("/api/locations/{station_id}")
def location(station_id: str):
    s = get_store()
    try:
        loc = s.get(station_id)
    except KeyError:
        raise HTTPException(404, "unknown station") from None
    out = public_location(loc)
    out["neighbors"] = s.neighbors_of(station_id)
    out["z"] = s.z_vector(station_id)
    out["cluster_info"] = s.clusters[loc["cluster"]]
    return out


@app.get("/api/similarity/{a}/{b}")
def similarity(a: str, b: str):
    s = get_store()
    d = s.climate_distance(a, b)
    la, lb = s.get(a), s.get(b)
    return {
        "climate_distance": d,
        "similarity_pct": s.similarity_pct(d),
        "geo_distance_mi": float(haversine_mi(la["lat"], la["lon"], lb["lat"], lb["lon"])),
    }


@app.get("/api/clusters")
def clusters():
    return get_store().clusters


@app.get("/api/diagnostics")
def diagnostics():
    return get_store().diagnostics


@app.get("/api/pipeline")
def pipeline():
    s = get_store()
    return {
        "window": {"start_year": START_YEAR, "end_year": END_YEAR},
        "ingest": {k: v for k, v in s.ingest_summary.items() if k != "missing_keys"},
        "ingest_missing_files": len(s.ingest_summary.get("missing_keys", [])),
        "stats": s.pipeline_stats,
        "coverage": s.coverage,
        "rules": {
            "qc_fail_codes": sorted(QC_FAIL_CODES),
            "physical_bounds": PHYSICAL_BOUNDS,
            "min_obs_per_day": MIN_OBS_PER_DAY,
            "min_valid_day_fraction": MIN_DAYS_FRACTION,
        },
        "feature_defs": FEATURE_DEFS,
        "final": {
            "locations": len(s.ids),
            "features": len(FEATURE_COLUMNS),
            "clusters": len(s.clusters),
            "locations_bytes_parquet": (
                Path(__file__).resolve().parents[1] / "data/processed/locations.parquet"
            )
            .stat()
            .st_size,
        },
        "query_latency_this_process": latency_summary(),
        "scoring": {
            "max_score": MAX_SCORE,
            "scale_mi": SCALE_MI,
            "perfect_radius_mi": PERFECT_RADIUS_MI,
            "formula": "max * exp(-(d - r0)/scale)",
        },
    }


@app.get("/api/explore/extremes")
def extremes(feature: str, top: int = 10, direction: str = "high"):
    s = get_store()
    if feature not in FEATURE_COLUMNS:
        raise HTTPException(400, "unknown feature")
    df = s.locations.sort(feature, descending=direction == "high").head(top)
    return df.select(
        "station_id", "name", "state", "lat", "lon", "cluster", feature, f"pct_{feature}"
    ).to_dicts()


@app.get("/api/explore/outliers")
def outliers(top: int = 15):
    """Locations far from every cluster centroid: low silhouette + large distance to own centroid."""
    s = get_store()
    df = s.locations.sort("silhouette").head(top)
    return df.select("station_id", "name", "state", "lat", "lon", "cluster", "silhouette").to_dicts()


@app.get("/api/explore/twins")
def twins(min_geo_mi: float = 1000, top: int = 15):
    """Climate twins: most similar pairs that are geographically far apart."""
    s = get_store()
    df = s.neighbors.filter(pl.col("geo_distance_mi") >= min_geo_mi).sort("climate_distance").head(top)
    rows = df.to_dicts()
    for r in rows:
        a, b = s.get(r["station_id"]), s.get(r["neighbor_id"])
        r["a"] = {"name": a["name"], "state": a["state"], "lat": a["lat"], "lon": a["lon"]}
        r["b"] = {"name": b["name"], "state": b["state"], "lat": b["lat"], "lon": b["lon"]}
    return rows


DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if DIST.exists():
    app.mount("/", StaticFiles(directory=DIST, html=True), name="frontend")
