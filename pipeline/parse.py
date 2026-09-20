"""Parse raw NOAA ISD fixed-width records into typed columnar tables.

ISD format reference: https://www.ncei.noaa.gov/pub/data/noaa/isd-format-document.pdf

Every record has a 105-char mandatory section (station, time, position, wind,
ceiling, visibility, temperature, dew point, sea-level pressure) followed by
optional "additional data" sections identified by 3-char tags (AA1 = liquid
precipitation, AJ1 = snow depth, GF1 = sky cover, ...).

This module does *parsing only* (bytes -> typed values + QC flags). Sentinel
values (9999, 99999, ...) are converted to null here because they are format
level missing markers, not measurements. Physical-range and QC-flag filtering
happens in ``pipeline/clean.py`` so that the two steps can be measured
separately.
"""

from __future__ import annotations

import gzip
from pathlib import Path

import polars as pl

# (name, start, end, scale, sentinel) for the mandatory section, 0-indexed slices.
MANDATORY_FIELDS = [
    ("usaf", 4, 10, None, None),
    ("wban", 10, 15, None, None),
    ("datetime_raw", 15, 27, None, None),
    ("lat", 28, 34, 1000.0, "+99999"),
    ("lon", 34, 41, 1000.0, "+999999"),
    ("report_type", 41, 46, None, None),
    ("wind_dir", 60, 63, 1.0, "999"),
    ("wind_dir_qc", 63, 64, None, None),
    ("wind_type", 64, 65, None, None),
    ("wind_speed_ms", 65, 69, 10.0, "9999"),
    ("wind_speed_qc", 69, 70, None, None),
    ("ceiling_m", 70, 75, 1.0, "99999"),
    ("ceiling_qc", 75, 76, None, None),
    ("visibility_m", 78, 84, 1.0, "999999"),
    ("visibility_qc", 84, 85, None, None),
    ("temp_c", 87, 92, 10.0, "+9999"),
    ("temp_qc", 92, 93, None, None),
    ("dewpoint_c", 93, 98, 10.0, "+9999"),
    ("dewpoint_qc", 98, 99, None, None),
    ("slp_hpa", 99, 104, 10.0, "99999"),
    ("slp_qc", 104, 105, None, None),
]

# Additional-data sections we extract, as regexes over the tail of the record.
# AA1: liquid precip. period(2h) depth(4, mm*10) condition(1) qc(1)
# AJ1: snow depth. depth(4, cm) condition(1) qc(1) ...
# GF1: sky cover. total coverage(2, oktas) opaque(2) qc(1) ...
ADDITIONAL_PATTERNS = {
    "precip_period_h": (r"AA1(\d{2})\d{4}.\d", 1.0, "99"),
    "precip_mm": (r"AA1\d{2}(\d{4}).\d", 10.0, "9999"),
    "precip_qc": (r"AA1\d{2}\d{4}.(\d)", None, None),
    "snow_depth_cm": (r"AJ1(\d{4}).\d", 1.0, "9999"),
    "snow_depth_qc": (r"AJ1\d{4}.(\d)", None, None),
    "sky_cover_oktas": (r"GF1(\d{2})\d{2}\d", 1.0, "99"),
    "sky_cover_qc": (r"GF1\d{2}\d{2}(\d)", None, None),
}

RAW_COLUMNS = [f[0] for f in MANDATORY_FIELDS] + list(ADDITIONAL_PATTERNS)


def _read_lines(path: Path) -> pl.DataFrame:
    with gzip.open(path, "rt", encoding="latin-1") as fh:
        lines = fh.read().split("\n")
    lines = [ln for ln in lines if len(ln) >= 105]
    return pl.DataFrame({"line": lines})


def parse_file(path: Path) -> pl.DataFrame:
    """Parse one station-year gz file into a typed DataFrame (one row per record)."""
    df = _read_lines(path)
    exprs: list[pl.Expr] = []
    for name, start, end, scale, sentinel in MANDATORY_FIELDS:
        col = pl.col("line").str.slice(start, end - start)
        if sentinel is not None:
            col = pl.when(col == sentinel).then(None).otherwise(col)
        if scale is not None:
            col = col.cast(pl.Float64, strict=False) / scale
        exprs.append(col.alias(name))
    tail = pl.col("line").str.slice(105)
    for name, (pattern, scale, sentinel) in ADDITIONAL_PATTERNS.items():
        col = tail.str.extract(pattern, 1)
        if sentinel is not None:
            col = pl.when(col == sentinel).then(None).otherwise(col)
        if scale is not None:
            col = col.cast(pl.Float64, strict=False) / scale
        exprs.append(col.alias(name))
    out = df.select(exprs)
    out = out.with_columns(
        pl.col("datetime_raw").str.strptime(pl.Datetime("us"), "%Y%m%d%H%M", strict=False).alias("obs_time"),
        (pl.col("usaf") + "-" + pl.col("wban")).alias("station_id"),
    ).drop("datetime_raw")
    return out


def parse_many(paths: list[Path]) -> pl.DataFrame:
    frames = [parse_file(p) for p in paths]
    return pl.concat(frames, how="vertical_relaxed") if frames else pl.DataFrame()
