"""Unit tests for the deterministic parts of the pipeline using a synthetic ISD record."""

import gzip
from pathlib import Path

import polars as pl

from backend.scoring import MAX_SCORE, score_for_distance
from pipeline.aggregate import hourly_to_daily
from pipeline.clean import clean
from pipeline.parse import parse_file


def isd_line(
    hour: int,
    day: int = 15,
    temp_tenths: str = "+0215",
    report: str = "FM-15",
    temp_qc: str = "1",
    tail: str = "",
) -> str:
    # 105-char mandatory section, laid out per the ISD format document.
    line = (
        "0165"  # variable length
        "725300"  # USAF
        "94846"  # WBAN
        f"202001{day:02d}{hour:02d}00"  # yyyymmddhhmm
        "4"  # source
        "+41995"  # lat
        "-087934"  # lon
        f"{report:<5}"  # report type
        "+0201"  # elevation
        "ORD  "  # call letters
        "V020"  # QC process
        "270"  # wind dir
        "1"  # wind dir qc
        "N"  # wind type
        "0046"  # wind speed m/s*10
        "1"
        "22000"  # ceiling m
        "1"
        "9"  # ceiling determination
        "N"  # cavok
        "016093"  # visibility m
        "1"
        "9"  # variability
        "9"
        f"{temp_tenths}"  # temp C*10
        f"{temp_qc}"
        "+0150"  # dew point
        "1"
        "10132"  # slp hPa*10
        "1"
    )
    assert len(line) == 105, len(line)
    return line + tail


def LOCAL_DAY() -> list[str]:
    """24 UTC hours covering one local solar day at lon -87.9 (UTC-6)."""
    return [isd_line(h) for h in range(6, 24)] + [isd_line(h, day=16) for h in range(0, 6)]


def write_gz(path: Path, lines: list[str]) -> Path:
    with gzip.open(path, "wt") as fh:
        fh.write("\n".join(lines) + "\n")
    return path


def test_parse_mandatory_and_additional(tmp_path):
    p = write_gz(tmp_path / "x.gz", [isd_line(0, tail="ADDAA101002591")])
    df = parse_file(p)
    row = df.row(0, named=True)
    assert row["temp_c"] == 21.5
    assert row["dewpoint_c"] == 15.0
    assert row["slp_hpa"] == 1013.2
    assert row["wind_speed_ms"] == 4.6
    assert row["lat"] == 41.995 and row["lon"] == -87.934
    assert row["precip_period_h"] == 1.0 and row["precip_mm"] == 2.5
    assert row["report_type"].strip() == "FM-15"


def test_parse_sentinel_is_null(tmp_path):
    p = write_gz(tmp_path / "x.gz", [isd_line(0, temp_tenths="+9999")])
    assert parse_file(p)["temp_c"][0] is None


def test_clean_drops_summaries_and_qc_failures(tmp_path):
    lines = LOCAL_DAY()
    lines.append(isd_line(3, day=16, report="SOD"))  # daily summary -> dropped
    lines.append(
        isd_line(5, day=16, temp_tenths="+0999", temp_qc="3")
    )  # QC fail -> nulled, collapsed into hour 5
    lines.append(isd_line(6, temp_tenths="+0800"))  # 80 C -> out of physical range -> null
    p = write_gz(tmp_path / "x.gz", lines)
    clean_df, stats = clean(parse_file(p))
    assert stats["rows_dropped_non_hourly_report"] == 1
    assert stats["values_nulled_qc_flag"]["temp_c"] == 1
    assert stats["values_nulled_out_of_range"]["temp_c"] == 1
    assert clean_df.height == 24  # one row per hour
    # the 80 C value was nulled, so the hour-6 mean is the remaining valid report
    assert clean_df.filter(pl.col("hour").dt.hour() == 6)["temp_c"][0] == 21.5


def test_daily_requires_min_obs(tmp_path):
    full = LOCAL_DAY()
    p = write_gz(tmp_path / "full.gz", full)
    clean_df, _ = clean(parse_file(p))
    daily = hourly_to_daily(clean_df)
    assert daily.height == 1
    assert daily["valid_day"][0]
    assert abs(daily["temp_mean_c"][0] - 21.5) < 1e-6

    sparse = [isd_line(h) for h in range(6, 16)]
    p2 = write_gz(tmp_path / "sparse.gz", sparse)
    clean2, _ = clean(parse_file(p2))
    daily2 = hourly_to_daily(clean2)
    assert not daily2["valid_day"][0]


def test_daily_precip_stuck_gauge(tmp_path):
    # AA1 1-h total 45.7 mm repeated every hour -> stuck gauge, precip unknown
    stuck = [isd_line(h, tail="ADDAA101045791") for h in range(6, 24)] + [
        isd_line(h, day=16, tail="ADDAA101045791") for h in range(0, 6)
    ]
    clean_df, _ = clean(parse_file(write_gz(tmp_path / "stuck.gz", stuck)))
    daily = hourly_to_daily(clean_df)
    assert daily["valid_day"][0]
    assert daily["precip_stuck_gauge"][0]
    assert daily["precip_mm"][0] is None

    # Same depth reported in only 3 hours (a real storm) is kept and summed
    real = [isd_line(h, tail="ADDAA101045791" if h in (12, 13, 14) else "") for h in range(6, 24)] + [
        isd_line(h, day=16) for h in range(0, 6)
    ]
    clean2, _ = clean(parse_file(write_gz(tmp_path / "real.gz", real)))
    daily2 = hourly_to_daily(clean2)
    assert not daily2["precip_stuck_gauge"][0]
    assert abs(daily2["precip_mm"][0] - 3 * 45.7) < 1e-6

    # Varying 60-150 mm "hourly" totals summing past 300 mm/day -> implausible, unknown
    amounts = ["0606", "1232", "1448", "0993"]  # 60.6, 123.2, 144.8, 99.3 mm
    noisy = [
        isd_line(h, tail=f"ADDAA101{amounts[h - 12]}91" if 12 <= h < 16 else "") for h in range(6, 24)
    ] + [isd_line(h, day=16) for h in range(0, 6)]
    clean3, _ = clean(parse_file(write_gz(tmp_path / "noisy.gz", noisy)))
    daily3 = hourly_to_daily(clean3)
    assert not daily3["precip_stuck_gauge"][0]
    assert daily3["precip_implausible"][0]
    assert daily3["precip_mm"][0] is None


def test_scoring():
    assert score_for_distance(0) == MAX_SCORE
    assert score_for_distance(15) == MAX_SCORE
    assert 0 < score_for_distance(1000) < score_for_distance(100) < MAX_SCORE
    assert score_for_distance(20000) == 0
