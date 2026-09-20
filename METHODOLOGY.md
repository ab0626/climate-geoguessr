# Methodology

## Design choices (and the alternatives rejected)

| Decision | Chosen | Rejected | Why |
| --- | --- | --- | --- |
| Geographic unit | NOAA station | county, 0.5° grid, H3 cell | any areal unit needs interpolation between stations; the station keeps 1:1 provenance from observation to displayed number |
| Time window | 2015–2024 (10 y) | 1991–2020 WMO normal | 3× the download/compute; the catalogue shows the CONUS network is stable from 2010, so 10 y gives every station the same averaging period. Documented as decadal, not "normal" |
| Time base | local solar day (`round(lon/15)` h offset) | UTC day | 00 UTC is late afternoon in CONUS; UTC days split the diurnal cycle and rain events |
| Precip source | AA1 1-hour totals summed per day | AA1 24-h totals, `SOD` daily summary | 24-h totals are reported at station-specific hours that straddle local days (only 4 % of days carry one); SOD would double count and is not an observation |
| Snow | frozen-precipitation days (precip ≥ 1 mm and mean T ≤ 0 °C) | AJ1 snow depth | AJ1 present on 0.4 % of station-days |
| Visibility | descriptive only | model feature | ASOS visibility caps at 10 mi so nearly every station saturates (sd 0.9 mi); a single non-ASOS site reporting 40 mi became a +35 sd singleton cluster |
| Scaling | z-score, equal weights | min-max, expert weights | z-scores make "1 unit" comparable across °F, inches and days; weights would be an untestable prior |
| Clustering | k-means, k = 8 | Ward, GMM | compared on silhouette / BIC (table in METRICS.md); k-means was best or tied at every k ≥ 6, and its centroids are directly interpretable as "typical station" |
| Similarity | percentile of pairwise Euclidean distance | cosine, correlation | a percentile ("more similar than X % of all station pairs") is calibrated to the real distribution and needs no magic constant |

## Features (14 in the model, all from `features/build.py`)

Every feature has an entry in `data/processed/feature_defs.json` with: label,
unit, ISD fields, aggregation, missing-value rule and group. The UI shows that
entry next to every value. Summary:

| Feature | Fields | Aggregation over valid station-days (2015–2024) |
| --- | --- | --- |
| annual_mean_temp_f | mandatory temp | mean of daily mean temp |
| winter_mean_temp_f / summer_mean_temp_f | temp | mean of daily mean temp, DJF / JJA |
| seasonal_temp_range_f | temp | summer − winter |
| diurnal_temp_range_f | temp | mean of (daily max − daily min) |
| hot_days_per_year | temp | days with max ≥ 90 °F (32.2 °C) ÷ valid days × 365.25 |
| freeze_days_per_year | temp | days with min ≤ 32 °F ÷ valid days × 365.25 |
| annual_precip_in | AA1 1-h | Σ daily precip ÷ days with known precip × 365.25 |
| wet_days_per_year | AA1 1-h | days ≥ 1 mm (0.04 in), annualised |
| summer_precip_fraction | AA1 1-h | JJA precip ÷ annual precip |
| frozen_precip_days_per_year | AA1 1-h + temp | days with ≥ 1 mm and mean T ≤ 0 °C, annualised |
| summer_dewpoint_f | mandatory dew point | JJA mean of daily mean dew point |
| annual_dewpoint_depression_f | temp, dew point | mean of (T − Td) |
| mean_wind_mph | mandatory wind speed | mean of daily mean wind |

Descriptive extras shown per station but not in the model: mean visibility,
mean sea-level pressure, mean sky cover, valid-day fraction, days with a
precipitation report, days with a 24-h total.

Missing-value rules that matter:

* A day counts only with ≥ 18 hourly temperatures; otherwise **all** its daily
  values are null (not 0).
* Precipitation on a valid day with no AA1 report is 0 (ASOS omits the group
  when dry) — *unless* the station reports AA1 on < 2 % of its valid days, in
  which case it has no gauge and all four precipitation features are null and
  the station is excluded from the model table.
* Daily precipitation plausibility (LIMITATIONS.md → Precipitation): a valid
  day whose non-zero 1-h totals are all identical, ≥ 6 in number and ≥ 5 mm is
  a **stuck gauge**; a day summing to > 300 mm is **implausible**. Both get
  null (unknown) precipitation and leave the precipitation denominators. A
  station with ≥ 5 such days has no trusted gauge: precipitation features are
  null and it is excluded from the model table like a no-gauge station.
* Stations missing any model feature are excluded rather than imputed.

## Clustering (`clustering/run.py`)

1. `StandardScaler` on the 14 features (means and scales stored in
   `cluster_diagnostics.json` so any value can be reproduced).
2. For k = 3…12: k-means (n_init = 10, seed 0), Ward agglomerative, Gaussian mixture
   (n_init = 3, full covariance). Record silhouette, inertia, Calinski–Harabasz, BIC.
3. Rule: **argmax k-means silhouette with k ≥ 5** (k = 3 has a higher silhouette
   but is just "cold / mild / hot"; the floor forces the model to split moisture
   and continentality as well). Chosen **k = 8**.
4. Diagnostics: per-cluster silhouette and within-variance; centroid separation
   in z units; feature ablation (re-cluster without each feature, report
   silhouette and ARI vs the full model); stability (25 × 80 % subsample ARI and
   25 × N(0, 0.1 sd) noise ARI); between/within F ratio per feature; PCA
   explained variance and loadings; feature correlation matrix.
5. Geographic signal test: 5-NN distance-weighted regression of (lat, lon) from
   z-scored features, self excluded → median great-circle error. This is the
   honest answer to "does climate identify place?".

Cluster traits shown in the UI are the four features whose centroid
z-score has the largest magnitude, rendered as "high/low <label> (±x sd)".

## Similarity and neighbours (`backend/store.py`)

* Climate distance = Euclidean distance between two stations' z-vectors.
* Similarity % = share of all 1,827 × 1,826 / 2 station pairs whose distance is
  **larger** than this pair's (via `searchsorted` on the stored sorted pairwise
  distances). 100 % = the two most similar stations in the table.
* Nearest climate neighbours: 10 smallest distances, precomputed.
* A map click is mapped to the nearest station by great-circle distance; the
  UI states that station and how far it is from the click.

## Scoring (`backend/scoring.py`)

```
d  = haversine(guess, target)              # miles, R = 3958.8
score = 5000                               if d ≤ 15
      = round(5000 · exp(−(d − 15) / 1250)) otherwise
```

Half the points at ~880 mi; ~500 pt at 2,900 mi. The perfect radius (15 mi)
absorbs click imprecision at continental zoom.

## Clues (`backend/clue.py`)

Deterministic: each of temperature (summer & winter), humidity, precipitation,
seasonality, snow proxy, wind and diurnal range is mapped to a phrase by the
station's **percentile rank** within the 1,827-station table (bands at 15/35/65/85).
The list of (feature, value, percentile) facts used is returned with the clue and
shown after the reveal as "Signal found".

Optional LLM rewrite (only if `OPENAI_API_KEY` is set): the model is given the
template sentence and the facts, asked to rephrase without adding information.
The output is accepted only if it contains no numbers absent from the facts and
none of the target's name, state or ICAO tokens; otherwise the template is used. The UI labels the clue as "deterministic template" or "LLM rewrite (verified)".

## What the LLM never touches

Parsing, QC, aggregation, missingness, features, scaling, clustering,
similarity, scoring, diagnostics, or any number displayed in the UI.
