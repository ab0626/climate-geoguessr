"""Climate feature engineering: station-day rows -> one climate fingerprint per station.

Each feature has a definition entry in FEATURE_DEFS (source fields, aggregation,
units, missing-data rule) which is exported to data/processed/feature_defs.json
and shown verbatim in the Advanced Metrics provenance panel.

Coverage handling: yearly totals (precipitation, count-type features) are
normalised by valid days, i.e. `sum / n_valid_days * 365.25`, so a station with
80% valid days is not reported 20% drier. Means are simple means over valid days.
Stations whose valid-day fraction is below MIN_DAYS_FRACTION are dropped.
"""

from __future__ import annotations

import json
import time

import polars as pl

from pipeline.config import (
    DAILY_DIR,
    END_YEAR,
    MAX_FLAGGED_PRECIP_DAYS,
    MIN_DAYS_FRACTION,
    PROCESSED_DIR,
    RAW_DIR,
    START_YEAR,
)

WINDOW_DAYS = (END_YEAR - START_YEAR + 1) * 365.25
MM_TO_IN = 1 / 25.4
MS_TO_MPH = 2.23694


def c_to_f(expr: pl.Expr) -> pl.Expr:
    return expr * 9 / 5 + 32


FEATURE_DEFS: dict[str, dict] = {
    "annual_mean_temp_f": {
        "label": "Annual mean temperature",
        "unit": "°F",
        "fields": ["ISD mandatory air temperature (pos 88-92) + QC flag (93)"],
        "aggregation": "hourly mean -> daily mean (days with >=18 valid hours) -> mean over all valid days",
        "missing": "days with <18 hourly temps excluded",
        "group": "temperature",
    },
    "winter_mean_temp_f": {
        "label": "Winter (DJF) mean temperature",
        "unit": "°F",
        "fields": ["air temperature"],
        "aggregation": "mean of valid daily means for months 12,1,2",
        "missing": "as annual",
        "group": "temperature",
    },
    "summer_mean_temp_f": {
        "label": "Summer (JJA) mean temperature",
        "unit": "°F",
        "fields": ["air temperature"],
        "aggregation": "mean of valid daily means for months 6,7,8",
        "missing": "as annual",
        "group": "temperature",
    },
    "seasonal_temp_range_f": {
        "label": "Seasonal range (summer - winter)",
        "unit": "°F",
        "fields": ["air temperature"],
        "aggregation": "summer_mean_temp_f - winter_mean_temp_f",
        "missing": "derived",
        "group": "temperature",
    },
    "diurnal_temp_range_f": {
        "label": "Mean diurnal range (daily max - min)",
        "unit": "°F",
        "fields": ["air temperature"],
        "aggregation": "mean over valid days of (max hourly - min hourly)",
        "missing": "as annual",
        "group": "temperature",
    },
    "hot_days_per_year": {
        "label": "Days >= 90°F per year",
        "unit": "days/yr",
        "fields": ["air temperature"],
        "aggregation": "count(valid days with daily max >= 32.2°C) / n_valid_days * 365.25",
        "missing": "normalised by valid days",
        "group": "temperature",
    },
    "freeze_days_per_year": {
        "label": "Days with min <= 32°F per year",
        "unit": "days/yr",
        "fields": ["air temperature"],
        "aggregation": "count(valid days with daily min <= 0°C) / n_valid_days * 365.25",
        "missing": "normalised by valid days",
        "group": "temperature",
    },
    "annual_precip_in": {
        "label": "Annual precipitation",
        "unit": "in",
        "fields": ["ISD AA1 liquid precipitation, 1-hour period, depth (mm) + QC"],
        "aggregation": "sum of 1-h totals per local day (0 if station operating but no report) -> sum / n_days_with_known_precip * 365.25",
        "missing": "days with <18 temp hours, stuck-gauge days (>=6 identical non-zero 1-h totals >=5 mm) and days >300 mm -> null (not 0); stations with >=5 flagged days have no trusted gauge",
        "group": "precipitation",
    },
    "wet_days_per_year": {
        "label": "Wet days (>= 0.04 in) per year",
        "unit": "days/yr",
        "fields": ["AA1 1-hour precipitation"],
        "aggregation": "count(days with known precip >= 1 mm) / n_days_with_known_precip * 365.25",
        "missing": "normalised by days with known precipitation",
        "group": "precipitation",
    },
    "summer_precip_fraction": {
        "label": "Share of precipitation falling in JJA",
        "unit": "fraction",
        "fields": ["AA1 1-hour precipitation"],
        "aggregation": "sum(precip, months 6-8) / sum(precip, all months)",
        "missing": "valid days only",
        "group": "precipitation",
    },
    "frozen_precip_days_per_year": {
        "label": "Frozen-precipitation days per year (proxy for snow days)",
        "unit": "days/yr",
        "fields": ["AA1 1-hour precipitation", "air temperature"],
        "aggregation": "count(days with known precip >= 1 mm and daily mean temp <= 0°C) / n_days_with_known_precip * 365.25",
        "missing": "AJ1 snow depth coverage was too sparse at ASOS stations; this proxy uses temperature + precipitation only",
        "group": "snow",
    },
    "summer_dewpoint_f": {
        "label": "Summer (JJA) mean dew point",
        "unit": "°F",
        "fields": ["ISD mandatory dew point (pos 94-98) + QC flag (99)"],
        "aggregation": "hourly mean -> daily mean -> mean over JJA valid days",
        "missing": "hourly nulls skipped",
        "group": "humidity",
    },
    "annual_dewpoint_depression_f": {
        "label": "Mean dew-point depression (T - Td)",
        "unit": "°F",
        "fields": ["air temperature", "dew point"],
        "aggregation": "mean over valid days of (daily mean temp - daily mean dew point); larger = drier air",
        "missing": "hourly nulls skipped",
        "group": "humidity",
    },
    "mean_wind_mph": {
        "label": "Mean wind speed",
        "unit": "mph",
        "fields": ["ISD mandatory wind speed (pos 66-69, m/s*10) + QC flag (70)"],
        "aggregation": "hourly mean -> daily mean -> mean over valid days",
        "missing": "hourly nulls skipped; calm reported as 0",
        "group": "wind",
    },
}

# Visibility is computed and shown per station but excluded from the model:
# ASOS sensors cap at 10 mi so ~all stations saturate near the cap (sd 0.9 mi)
# and a single non-ASOS site reporting 40 mi became a +35 sd singleton cluster.
DESCRIPTIVE_DEFS = {
    "mean_visibility_mi": {
        "label": "Mean visibility",
        "unit": "mi",
        "fields": ["ISD mandatory visibility (pos 79-84, m) + QC flag (85)"],
        "aggregation": "hourly mean -> daily mean -> mean over valid days",
        "missing": "hourly nulls skipped",
        "group": "other",
        "in_model": False,
        "note": "ASOS visibility saturates at 10 mi; excluded from clustering/similarity",
    },
}

FEATURE_COLUMNS = list(FEATURE_DEFS)
PRECIP_FEATURES = [
    "annual_precip_in",
    "wet_days_per_year",
    "summer_precip_fraction",
    "frozen_precip_days_per_year",
]
# Minimum share of valid days with at least one AA1 1-hour report for the
# station to be considered as having a reporting precipitation gauge.
MIN_PRECIP_REPORT_FRACTION = 0.02


def build_station_features(daily: pl.DataFrame) -> pl.DataFrame:
    d = daily.with_columns(
        pl.col("day").dt.month().alias("month"),
        pl.col("day").dt.year().alias("year"),
    ).with_columns(
        pl.col("month").is_in([12, 1, 2]).alias("is_winter"),
        pl.col("month").is_in([6, 7, 8]).alias("is_summer"),
    )
    v = pl.col("valid_day")
    valid_cnt = v.sum()
    per_year = 365.25 / valid_cnt
    precip_per_year = 365.25 / pl.col("precip_mm").count()

    feats = d.group_by("station_id").agg(
        pl.len().alias("n_days_with_data"),
        valid_cnt.alias("n_valid_days"),
        pl.col("n_reports").sum().alias("n_hourly_reports"),
        pl.col("day").min().alias("first_day"),
        pl.col("day").max().alias("last_day"),
        pl.col("year").n_unique().alias("n_years"),
        pl.col("temp_mean_c").count().alias("n_temp_days"),
        pl.col("dewpoint_mean_c").filter(v).count().alias("n_dewpoint_days"),
        pl.col("wind_mean_ms").filter(v).count().alias("n_wind_days"),
        pl.col("visibility_mean_m").filter(v).count().alias("n_visibility_days"),
        pl.col("slp_mean_hpa").filter(v).count().alias("n_slp_days"),
        pl.col("sky_cover_mean_oktas").filter(v).count().alias("n_sky_days"),
        pl.col("snow_depth_max_cm").filter(v).count().alias("n_snow_depth_days"),
        (pl.col("n_precip_1h_reports") > 0).filter(v).sum().alias("n_days_with_precip_report"),
        pl.col("precip_24h_mm").filter(v).count().alias("n_precip_24h_days"),
        pl.col("precip_stuck_gauge").filter(v).sum().alias("n_precip_stuck_days"),
        pl.col("precip_implausible").filter(v).sum().alias("n_precip_implausible_days"),
        # temperature
        c_to_f(pl.col("temp_mean_c").mean()).alias("annual_mean_temp_f"),
        c_to_f(pl.col("temp_mean_c").filter(pl.col("is_winter")).mean()).alias("winter_mean_temp_f"),
        c_to_f(pl.col("temp_mean_c").filter(pl.col("is_summer")).mean()).alias("summer_mean_temp_f"),
        ((pl.col("temp_max_c") - pl.col("temp_min_c")).mean() * 9 / 5).alias("diurnal_temp_range_f"),
        ((pl.col("temp_max_c") >= 32.2).sum() * per_year).alias("hot_days_per_year"),
        ((pl.col("temp_min_c") <= 0.0).sum() * per_year).alias("freeze_days_per_year"),
        # precipitation
        (pl.col("precip_mm").sum() * precip_per_year * MM_TO_IN).alias("annual_precip_in"),
        ((pl.col("precip_mm") >= 1.0).sum() * precip_per_year).alias("wet_days_per_year"),
        (pl.col("precip_mm").filter(pl.col("is_summer")).sum() / pl.col("precip_mm").sum()).alias(
            "summer_precip_fraction"
        ),
        (((pl.col("precip_mm") >= 1.0) & (pl.col("temp_mean_c") <= 0.0)).sum() * precip_per_year).alias(
            "frozen_precip_days_per_year"
        ),
        # humidity
        c_to_f(pl.col("dewpoint_mean_c").filter(v & pl.col("is_summer")).mean()).alias("summer_dewpoint_f"),
        ((pl.col("temp_mean_c") - pl.col("dewpoint_mean_c")).filter(v).mean() * 9 / 5).alias(
            "annual_dewpoint_depression_f"
        ),
        # wind / other
        (pl.col("wind_mean_ms").filter(v).mean() * MS_TO_MPH).alias("mean_wind_mph"),
        (pl.col("visibility_mean_m").filter(v).mean() / 1609.344).alias("mean_visibility_mi"),
        (pl.col("slp_mean_hpa").filter(v).mean()).alias("mean_slp_hpa"),
        (pl.col("sky_cover_mean_oktas").filter(v).mean()).alias("mean_sky_cover_oktas"),
        (pl.col("snow_depth_max_cm").filter(v).mean()).alias("mean_snow_depth_cm"),
    )
    # A station whose AA1 section essentially never appears has no reporting
    # precipitation gauge; its "0 in/yr" is absence of data, not a desert. A
    # station with repeated stuck/implausible days has a gauge that cannot be
    # trusted even on the days that pass the daily checks.
    n_flagged = pl.col("n_precip_stuck_days") + pl.col("n_precip_implausible_days")
    has_gauge = (
        pl.col("n_days_with_precip_report") >= MIN_PRECIP_REPORT_FRACTION * pl.col("n_valid_days")
    ) & (n_flagged < MAX_FLAGGED_PRECIP_DAYS)
    feats = feats.with_columns(
        (pl.col("summer_mean_temp_f") - pl.col("winter_mean_temp_f")).alias("seasonal_temp_range_f"),
        (pl.col("n_valid_days") / WINDOW_DAYS).alias("valid_day_fraction"),
        n_flagged.alias("n_precip_flagged_days"),
        (n_flagged >= MAX_FLAGGED_PRECIP_DAYS).alias("precip_gauge_unreliable"),
        has_gauge.alias("has_precip_gauge"),
        *[pl.when(has_gauge).then(pl.col(c)).otherwise(None).alias(c) for c in PRECIP_FEATURES],
    )
    return feats


def main() -> None:
    t0 = time.time()
    daily = pl.read_parquet(DAILY_DIR / "daily.parquet")
    stations = pl.read_parquet(RAW_DIR / "candidate_stations.parquet")
    feats = build_station_features(daily)
    all_stations = feats.join(stations, on="station_id", how="left")
    all_stations.write_parquet(PROCESSED_DIR / "station_features_all.parquet")

    enough_days = all_stations.filter(pl.col("valid_day_fraction") >= MIN_DAYS_FRACTION)
    finite = pl.all_horizontal([pl.col(c).is_not_null() & pl.col(c).is_finite() for c in FEATURE_COLUMNS])
    keep = enough_days.filter(finite)
    keep.write_parquet(PROCESSED_DIR / "station_features.parquet")
    missing_feature_counts = {
        c: int(enough_days[c].is_null().sum() + (~enough_days[c].fill_null(0.0).is_finite()).sum())
        for c in FEATURE_COLUMNS
    }

    coverage = {
        "stations_with_any_data": all_stations.height,
        "stations_kept": keep.height,
        "stations_dropped_low_coverage": all_stations.height - enough_days.height,
        "stations_dropped_missing_feature": enough_days.height - keep.height,
        "stations_precip_gauge_unreliable": int(enough_days["precip_gauge_unreliable"].sum()),
        "station_days_precip_stuck_gauge": int(all_stations["n_precip_stuck_days"].sum()),
        "station_days_precip_implausible": int(all_stations["n_precip_implausible_days"].sum()),
        "stations_missing_each_feature": {k: v for k, v in missing_feature_counts.items() if v},
        "min_valid_day_fraction": MIN_DAYS_FRACTION,
        "window_days": WINDOW_DAYS,
        "variable_coverage_pct_of_valid_days": {
            k: round(
                100 * float(all_stations[f"n_{k}_days"].sum()) / float(all_stations["n_valid_days"].sum()), 2
            )
            for k in ["temp", "dewpoint", "wind", "visibility", "slp", "sky", "snow_depth", "precip_24h"]
        },
        "pct_valid_days_with_any_1h_precip_report": round(
            100
            * float(all_stations["n_days_with_precip_report"].sum())
            / float(all_stations["n_valid_days"].sum()),
            2,
        ),
        "feature_build_seconds": round(time.time() - t0, 2),
    }
    (PROCESSED_DIR / "coverage.json").write_text(json.dumps(coverage, indent=2))
    (PROCESSED_DIR / "feature_defs.json").write_text(
        json.dumps({**FEATURE_DEFS, **DESCRIPTIVE_DEFS}, indent=2)
    )
    print(json.dumps(coverage, indent=2))
    print(keep.select(FEATURE_COLUMNS).describe())


if __name__ == "__main__":
    main()
