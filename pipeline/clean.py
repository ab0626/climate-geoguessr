"""Cleaning + quality filtering of parsed ISD records.

Every rule here is counted so the "rows removed / values nulled" numbers in the
Advanced Metrics view are measured, not estimated.

Steps (in order):
  1. keep_hourly_reports  - drop daily/monthly summary records (SOD, SOM) that
                            would double count real observations
  2. apply_qc_flags       - null values whose ISD QC flag is in QC_FAIL_CODES
  3. apply_physical_bounds- null values outside plausible physical range
  4. dedupe_hours         - collapse multiple reports within the same clock hour
                            into one (mean for continuous vars, sum for precip
                            1-hour totals) so specials (FM-16) don't overweight
"""

from __future__ import annotations

import polars as pl

from pipeline.config import HOURLY_REPORT_TYPES, PHYSICAL_BOUNDS, QC_FAIL_CODES

QC_PAIRS = {
    "temp_c": "temp_qc",
    "dewpoint_c": "dewpoint_qc",
    "wind_speed_ms": "wind_speed_qc",
    "wind_dir": "wind_dir_qc",
    "slp_hpa": "slp_qc",
    "visibility_m": "visibility_qc",
    "ceiling_m": "ceiling_qc",
    "precip_mm": "precip_qc",
    "snow_depth_cm": "snow_depth_qc",
    "sky_cover_oktas": "sky_cover_qc",
}

CONTINUOUS_VARS = [
    "temp_c",
    "dewpoint_c",
    "wind_speed_ms",
    "slp_hpa",
    "visibility_m",
    "ceiling_m",
    "sky_cover_oktas",
]


def keep_hourly_reports(df: pl.DataFrame, stats: dict) -> pl.DataFrame:
    counts = df.group_by("report_type").len()
    stats["report_type_counts"] = dict(zip(counts["report_type"].to_list(), counts["len"].to_list()))
    out = df.filter(pl.col("report_type").is_in(list(HOURLY_REPORT_TYPES)))
    stats["rows_dropped_non_hourly_report"] = df.height - out.height
    return out


def apply_qc_flags(df: pl.DataFrame, stats: dict) -> pl.DataFrame:
    exprs = []
    qc_stats = {}
    for var, qc in QC_PAIRS.items():
        fail = pl.col(qc).is_in(list(QC_FAIL_CODES)) & pl.col(var).is_not_null()
        qc_stats[var] = int(df.select(fail.sum()).item())
        exprs.append(pl.when(fail).then(None).otherwise(pl.col(var)).alias(var))
    stats["values_nulled_qc_flag"] = qc_stats
    return df.with_columns(exprs)


def apply_physical_bounds(df: pl.DataFrame, stats: dict) -> pl.DataFrame:
    exprs = []
    oob = {}
    for var, (lo, hi) in PHYSICAL_BOUNDS.items():
        bad = pl.col(var).is_not_null() & ~pl.col(var).is_between(lo, hi)
        oob[var] = int(df.select(bad.sum()).item())
        exprs.append(pl.when(bad).then(None).otherwise(pl.col(var)).alias(var))
    stats["values_nulled_out_of_range"] = oob
    return df.with_columns(exprs)


def dedupe_hours(df: pl.DataFrame, stats: dict) -> pl.DataFrame:
    """One row per station-hour. Precipitation: only AA1 1-hour periods are
    summed here; longer periods are kept in separate columns for validation."""
    df = df.with_columns(pl.col("obs_time").dt.truncate("1h").alias("hour"))
    aggs = [pl.col(v).mean().alias(v) for v in CONTINUOUS_VARS]
    # Wind direction: mean of unit vectors to avoid 350/10 -> 180 artefacts
    rad = pl.col("wind_dir").radians()
    aggs += [
        pl.when(pl.col("wind_speed_ms").is_not_null()).then(rad.sin()).otherwise(None).mean().alias("wind_u"),
        pl.when(pl.col("wind_speed_ms").is_not_null()).then(rad.cos()).otherwise(None).mean().alias("wind_v"),
        pl.when(pl.col("precip_period_h") == 1)
        .then(pl.col("precip_mm"))
        .otherwise(None)
        .max()
        .alias("precip_1h_mm"),
        pl.when(pl.col("precip_period_h") == 24)
        .then(pl.col("precip_mm"))
        .otherwise(None)
        .max()
        .alias("precip_24h_mm"),
        pl.col("snow_depth_cm").max().alias("snow_depth_cm"),
        pl.len().alias("n_reports"),
    ]
    out = df.group_by("station_id", "lat", "lon", "hour").agg(aggs).sort("hour")
    stats["rows_collapsed_same_hour"] = df.height - out.height
    return out


def clean(df: pl.DataFrame) -> tuple[pl.DataFrame, dict]:
    stats: dict = {"raw_records": df.height}
    stats["raw_nonnull"] = {v: int(df[v].is_not_null().sum()) for v in QC_PAIRS}
    df = keep_hourly_reports(df, stats)
    df = apply_qc_flags(df, stats)
    df = apply_physical_bounds(df, stats)
    df = dedupe_hours(df, stats)
    stats["clean_hourly_rows"] = df.height
    stats["clean_nonnull"] = {
        v: int(df[v].is_not_null().sum()) for v in CONTINUOUS_VARS + ["precip_1h_mm", "snow_depth_cm"]
    }
    return df, stats
