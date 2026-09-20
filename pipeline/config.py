"""Single source of truth for pipeline parameters. Every threshold that affects
a displayed number lives here so it can be cited from the Advanced Metrics UI."""

from __future__ import annotations

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = PROJECT_ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
INTERIM_DIR = DATA_DIR / "interim"  # parsed + cleaned hourly parquet, per year
DAILY_DIR = DATA_DIR / "daily"  # station-day aggregates
PROCESSED_DIR = DATA_DIR / "processed"  # feature table, clusters, metrics
for _d in (RAW_DIR, INTERIM_DIR, DAILY_DIR, PROCESSED_DIR):
    _d.mkdir(parents=True, exist_ok=True)

S3_BASE = "https://noaa-isd-pds.s3.amazonaws.com"

# Study window. Chosen after inspecting isd-history.csv: CONUS station count is
# flat (~2.5-2.6k) from 2010 on, so a recent 10-year block gives a stable network
# and a long-enough averaging period for seasonal climatology (WMO uses 30y;
# 10y is the compromise for compute + hackathon time). See docs/METHODOLOGY.md.
START_YEAR = 2015
END_YEAR = 2024
YEARS = list(range(START_YEAR, END_YEAR + 1))

# lat_min, lat_max, lon_min, lon_max
CONUS_BBOX = (24.0, 50.0, -125.0, -66.0)

# ISD QC flag codes that mean "failed a quality check". Everything else
# (0,1,4,5,9 and letter codes for data-source annotations) is kept.
QC_FAIL_CODES = {"2", "3", "6", "7"}

# Physical plausibility bounds (applied after QC flags). Units are SI as parsed.
PHYSICAL_BOUNDS = {
    "temp_c": (-60.0, 60.0),
    "dewpoint_c": (-70.0, 40.0),
    "wind_speed_ms": (0.0, 75.0),
    "slp_hpa": (900.0, 1090.0),
    "visibility_m": (0.0, 160_000.0),
    "ceiling_m": (0.0, 22_000.0),
    "precip_mm": (0.0, 500.0),
    "snow_depth_cm": (0.0, 500.0),
    "sky_cover_oktas": (0.0, 8.0),
}

# Report types that are actual point-in-time surface observations:
#   FM-15 METAR, FM-16 SPECI, FM-12 SYNOP, FM-13 SHIP/coastal, CRN05 US Climate
#   Reference Network 5-minute, MESOW mesonet, SY-MT synoptic+METAR merged.
# Dropped: SOD/SOM (daily/monthly summaries -> would double count), SHEF
# (hydrological coded messages), SURF (radiation network product).
HOURLY_REPORT_TYPES = {
    "FM-12",
    "FM-13",
    "FM-15",
    "FM-16",
    "CRN05",
    "MESOW",
    "SY-MT",
    "SY-SA",
    "SAO",
    "SAOSP",
    "AUTO",
    "AERO",
}

# Minimum hourly observations for a station-day to count as a valid temperature day
MIN_OBS_PER_DAY = 18
# Minimum valid days for a station to keep a variable in the climatology
MIN_DAYS_FRACTION = 0.70  # of the 10-year window
