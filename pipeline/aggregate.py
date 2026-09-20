"""Temporal aggregation: cleaned hourly rows -> station-day rows.

Days are *local solar days*: obs_time shifted by lon/15 hours. Using UTC days
would split US nights across two days and bias Tmax/Tmin. A day is "valid" for
temperature-type variables only if it has >= MIN_OBS_PER_DAY hourly values,
which prevents partial days (outages) from skewing extremes.

Daily precipitation = sum of AA1 1-hour totals in the day. ASOS stations report
the 1-hour total only when it is non-zero, so a day with a valid temperature
record but no 1-hour precip report is treated as 0 mm. Days where the station
was not operating (fewer than MIN_OBS_PER_DAY hours) get null precip, not 0.
The independent AA1 24-hour totals are kept as `precip_24h_mm` for validation.
"""

from __future__ import annotations

import polars as pl

from pipeline.config import MIN_OBS_PER_DAY


def hourly_to_daily(hourly: pl.DataFrame) -> pl.DataFrame:
    local = pl.col("hour") + pl.duration(hours=(pl.col("lon") / 15.0).round(0).cast(pl.Int32))
    df = hourly.with_columns(local.dt.date().alias("day"))
    out = df.group_by("station_id", "day").agg(
        pl.col("temp_c").count().alias("n_temp_hours"),
        pl.col("n_reports").sum().alias("n_reports"),
        pl.col("temp_c").mean().alias("temp_mean_c"),
        pl.col("temp_c").max().alias("temp_max_c"),
        pl.col("temp_c").min().alias("temp_min_c"),
        pl.col("dewpoint_c").mean().alias("dewpoint_mean_c"),
        pl.col("wind_speed_ms").mean().alias("wind_mean_ms"),
        pl.col("wind_speed_ms").max().alias("wind_max_ms"),
        pl.col("wind_u").mean().alias("wind_u"),
        pl.col("wind_v").mean().alias("wind_v"),
        pl.col("slp_hpa").mean().alias("slp_mean_hpa"),
        pl.col("visibility_m").mean().alias("visibility_mean_m"),
        pl.col("sky_cover_oktas").mean().alias("sky_cover_mean_oktas"),
        pl.col("sky_cover_oktas").count().alias("n_sky_hours"),
        pl.col("precip_1h_mm").sum().alias("precip_1h_sum_mm"),
        pl.col("precip_1h_mm").count().alias("n_precip_1h_reports"),
        pl.col("precip_24h_mm").max().alias("precip_24h_mm"),
        pl.col("snow_depth_cm").max().alias("snow_depth_max_cm"),
        pl.col("snow_depth_cm").count().alias("n_snow_hours"),
    )
    valid = pl.col("n_temp_hours") >= MIN_OBS_PER_DAY
    out = out.with_columns(
        valid.alias("valid_day"),
        pl.when(valid).then(pl.col("precip_1h_sum_mm").fill_null(0.0)).otherwise(None).alias("precip_mm"),
        pl.when(valid).then(pl.col("temp_mean_c")).otherwise(None).alias("temp_mean_c"),
        pl.when(valid).then(pl.col("temp_max_c")).otherwise(None).alias("temp_max_c"),
        pl.when(valid).then(pl.col("temp_min_c")).otherwise(None).alias("temp_min_c"),
    )
    return out.sort("station_id", "day")
