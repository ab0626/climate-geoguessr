# Data pipeline

Every number below is read from `data/processed/pipeline_stats.json`,
`data/processed/coverage.json` or `data/raw/ingest_summary.json`, all of which
are written by the code and committed. Nothing is estimated.

## 1. Source

**NOAA Integrated Surface Database (ISD)**, public S3 bucket `noaa-isd-pds`.

* Station catalogue: `isd-history.csv` (29,661 rows inspected).
* Observations: one gzip file per station-year, `data/<year>/<USAF>-<WBAN>-<year>.gz`,
  fixed-width ASCII records (105-char mandatory section + variable additional
  sections).

### Why this subset

The global archive is tens of thousands of stations and >100 years; most of it
is irrelevant for a CONUS climate game and would cost days of download. The
subset was chosen from the catalogue *before* downloading anything:

| Rule | Reason | Result |
| --- | --- | --- |
| `CTRY == US` and lat 24–50, lon −125 to −66 | contiguous US only (no AK/HI/territories: separate climate regimes, sparse network) | — |
| station `BEGIN ≤ 2015-01-01` and `END ≥ 2024-12-31` | station operated across the whole window, so every station has the same averaging period | **2,509 candidate stations** |
| window 2015–2024 | CONUS station count in the catalogue is flat (~2.5–2.6 k) from 2010 onward; 10 years is long enough for seasonal means and short enough to process on one machine. It is a *decadal climatology*, not a 30-year WMO normal | 10 years |

Geographic unit: **the station**. Counties, grids or H3 cells would require
interpolation between stations, which is a modelling step that would need to be
defended separately. Stations keep the direct observational provenance of every
number in the UI.

## 2. Ingest (`pipeline/ingest.py`)

* 2,509 stations × 10 years = **25,090 files requested**.
* **24,529 downloaded**, **561 missing** on S3 (station listed in the catalogue
  but no file for that year). Missing files are listed in `ingest_summary.json`.
* **18,680,110,212 bytes (18.7 GB) gzip on disk**, 315 s wall time with 32 concurrent
  connections and retry.

## 3. Parse (`pipeline/parse.py`)

Fixed-width slices from the ISD format document. Parsed fields (28 raw columns):

`usaf, wban, datetime_raw, lat, lon, report_type, wind_dir(+qc), wind_type,
wind_speed_ms(+qc), ceiling_m(+qc), visibility_m(+qc), temp_c(+qc),
dewpoint_c(+qc), slp_hpa(+qc), precip_period_h, precip_mm(+qc) [AA1],
snow_depth_cm(+qc) [AJ1], sky_cover_oktas(+qc) [GF1]`

* **Sentinels → null**: `+9999` temp/dewpoint, `9999` wind speed, `99999`
  ceiling/SLP, `999999` visibility, `999` wind dir, `9999` precip / snow depth,
  `99` sky cover. Counted per variable as "missing" in the raw non-null table.
* **Unit scaling**: temp, dewpoint, wind speed, SLP and precip are stored ×10 in
  ISD and divided back; everything is kept in SI (°C, m/s, hPa, mm, m, cm,
  oktas). Conversion to °F / mph / inches happens once, in feature building.
* **509,956,311 raw records** across the 24,529 files.

Raw non-null counts (share of records with a value):

| Variable | Non-null | % |
| --- | ---: | ---: |
| temp | 494,109,802 | 96.9 |
| wind speed | 381,900,902 | 74.9 |
| dew point | 344,531,653 | 67.6 |
| visibility | 338,576,008 | 66.4 |
| ceiling | 331,428,439 | 65.0 |
| wind dir | 286,010,243 | 56.1 |
| sky cover (GF1) | 194,813,165 | 38.2 |
| SLP | 123,662,455 | 24.3 |
| precip (AA1) | 112,789,734 | 22.1 |
| snow depth (AJ1) | 1,641,864 | 0.3 |

## 4. Clean (`pipeline/clean.py`)

Applied in order; each step's removals are counted.

1. **Report-type filter.** Keep point-in-time observations
   (`FM-15` METAR 315.6 M, `CRN05` 134.5 M, `FM-16` SPECI 24.5 M, `FM-13` 22.9 M,
   `FM-12` 4.3 M, `SY-MT`, `MESOW`, …). Drop `SOD`/`SOM` daily/monthly summaries
   (would double-count the hourlies they summarise), `SHEF` (hydrological coded
   messages) and `SURF` (radiation product).
   **8,088,968 records dropped.**
2. **ISD QC flags.** A value whose QC code is in `{2,3,6,7}` (failed a check) is
   nulled; the row is kept. **2,957,118 values nulled**, mostly ceiling (817,696),
   visibility (804,359), temp (477,750), SLP (395,577).
3. **Physical bounds.** temp −60…60 °C, dewpoint −70…40 °C, wind 0…75 m/s,
   SLP 900…1090 hPa, visibility ≤160 km, ceiling ≤22 km, precip 0…500 mm,
   snow depth 0…500 cm, sky 0…8 oktas. **2,939,999 values nulled** — 2,939,990 of
   them are GF1 sky-cover codes 9/10 ("obscured"/"partial obscuration") which are
   not an okta count, plus 9 temperatures.
4. **One row per station-hour.** METAR + SPECI + CRN 5-minute reports produce
   several records in the same hour; they are collapsed to one row (mean of
   numeric values, vector-mean wind direction, max of AA1 1-h / 24-h precip and AJ1 snow depth).
   **291,649,134 records collapsed.**

Result: **210,218,209 clean hourly rows**, 3.06 GB Parquet (`data/interim/`).

## 5. Aggregate to station-days (`pipeline/aggregate.py`)

* **Local day** = UTC shifted by `round(lon / 15)` hours (solar time; no DST). Needed
  so that daily max/min and "day" precipitation totals aren't split at 00 UTC
  (which is 4–8 pm local across CONUS).
* Per station-day: mean/max/min temp, mean dewpoint, mean wind, mean visibility,
  mean SLP, mean sky cover, max snow depth, sum of 1-h precip, count of hours with
  each variable.
* **Valid day** = ≥ 18 hours with a temperature value (`MIN_OBS_PER_DAY`).
* **Precipitation on a valid day** with no AA1 report is treated as 0 mm (ASOS
  omits AA1 when there is nothing to report). Days that are *not* valid get null,
  not 0.
* **Gauge plausibility flags**: `precip_stuck_gauge` (≥ 6 identical non-zero
  1-h totals of ≥ 5 mm, e.g. Mena AR reporting 45.7 mm every hour →
  1,097 mm/day) and `precip_implausible` (daily sum > 300 mm). Either sets
  the day's precipitation to null, not the sum. Stations with ≥ 5 flagged days
  lose all precipitation features (features/build.py).

Result: **8,724,373 station-day rows**, 2,501 stations with data, 336 MB Parquet.

Runtime for parse → clean → aggregate: **367 s** on 8 cores, parent peak RSS
2,712 MB, worst worker peak RSS 408 MB.

## 6. Station selection for the climatology (`features/build.py`)

| Step | Stations |
| --- | ---: |
| with any daily data | 2,501 |
| dropped: < 70 % valid days over 2015–2024 | −201 |
| dropped: a required feature is null | −473 |
| **kept** | **1,827** |

The 473 break down as (a station can hit several): 322 lack precipitation because
their AA1 section appears on < 2 % of valid days (no reporting gauge — their
"0 in/yr" would be absence of data, not a desert), 19 have an untrusted gauge
(≥ 5 stuck/implausible days; 92 stuck and 236 implausible station-days were
nulled overall), 294 lack dew point, 6 lack wind.

Variable coverage over valid station-days (drives which variables became
features):

| Variable | % of valid days | Decision |
| --- | ---: | --- |
| temperature | 100.0 | features |
| wind | 99.0 | feature |
| dew point | 87.2 | features (stations without it dropped) |
| visibility | 83.6 | shown, **not** a model feature (ASOS saturates at 10 mi) |
| sky cover | 76.6 | shown per station only |
| SLP | 57.6 | shown per station only |
| any 1-h precip report | 55.7 | features with gauge rule |
| 24-h precip totals | 4.2 | not used |
| snow depth | 0.4 | not used; frozen-precip days are the proxy |

Feature build time 0.66 s. Clustering ~ tens of seconds (`cluster_diagnostics.json → clustering_seconds`).

## 7. Final artefacts (`data/processed/`, committed)

| File | Size | Contents |
| --- | ---: | --- |
| `locations.parquet` | 540 KB | 1,827 stations: metadata, features, percentiles, cluster, PCA coords |
| `station_features.parquet` / `_all` | 353 / 445 KB | model table / every station with coverage columns |
| `neighbors.parquet` | 370 KB | 10 nearest climate neighbours per station |
| `pair_distance_quantiles.npy` | 6.8 MB | sorted pairwise climate distances (for similarity %) |
| `clusters.json` | 16 KB | centroids, traits, sizes, states |
| `cluster_diagnostics.json` | 21 KB | model selection, stability, ablation, PCA, geo signal |
| `pipeline_stats.json`, `coverage.json`, `feature_defs.json` | — | the numbers on this page + per-feature provenance |

18.7 GB raw → 530 KB playable table.
