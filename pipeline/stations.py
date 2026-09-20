"""Station selection from the ISD station history (isd-history.csv).

Selection rule (see docs/DATA_PIPELINE.md):
  * country == US and coordinates inside the contiguous-US bounding box
  * station history overlaps the whole study window (BEGIN <= start year, END >= end year)
The history file only tells us a station *existed*; actual observation coverage
is measured after parsing and used for a second, data-driven filter.
"""

from __future__ import annotations

from pathlib import Path

import polars as pl

from pipeline.config import CONUS_BBOX, END_YEAR, RAW_DIR, START_YEAR

HISTORY_URL = "https://noaa-isd-pds.s3.amazonaws.com/isd-history.csv"
HISTORY_PATH = RAW_DIR / "isd-history.csv"


def load_history(path: Path = HISTORY_PATH) -> pl.DataFrame:
    h = pl.read_csv(path, infer_schema_length=0)
    return h.select(
        pl.col("USAF").alias("usaf"),
        pl.col("WBAN").alias("wban"),
        (pl.col("USAF") + "-" + pl.col("WBAN")).alias("station_id"),
        pl.col("STATION NAME").alias("name"),
        pl.col("CTRY").alias("country"),
        pl.col("STATE").alias("state"),
        pl.col("ICAO").alias("icao"),
        pl.col("LAT").cast(pl.Float64, strict=False).alias("lat"),
        pl.col("LON").cast(pl.Float64, strict=False).alias("lon"),
        pl.col("ELEV(M)").cast(pl.Float64, strict=False).alias("elev_m"),
        pl.col("BEGIN").str.slice(0, 4).cast(pl.Int32, strict=False).alias("begin_year"),
        pl.col("END").str.slice(0, 4).cast(pl.Int32, strict=False).alias("end_year"),
    )


def select_candidate_stations(
    history: pl.DataFrame, start_year: int = START_YEAR, end_year: int = END_YEAR
) -> pl.DataFrame:
    lat_min, lat_max, lon_min, lon_max = CONUS_BBOX
    return history.filter(
        (pl.col("country") == "US")
        & pl.col("lat").is_between(lat_min, lat_max)
        & pl.col("lon").is_between(lon_min, lon_max)
        & (pl.col("begin_year") <= start_year)
        & (pl.col("end_year") >= end_year)
    ).sort("station_id")


if __name__ == "__main__":
    hist = load_history()
    cand = select_candidate_stations(hist)
    out = RAW_DIR / "candidate_stations.parquet"
    cand.write_parquet(out)
    print(f"history rows={hist.height} candidates={cand.height} -> {out}")
