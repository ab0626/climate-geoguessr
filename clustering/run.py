"""Normalisation, clustering, similarity and signal diagnostics on the feature table.

Everything here is deterministic (fixed seeds) and writes:
  data/processed/locations.parquet      feature table + cluster id + PCA coords + percentiles
  data/processed/clusters.json          per-cluster size, centroid (real units), z-centroid, top traits
  data/processed/cluster_diagnostics.json  model selection, stability, ablation, geographic signal
  data/processed/neighbors.parquet      top-K climate neighbours per station
  data/processed/pair_distance_quantiles.npy  sorted pairwise distances (for similarity %)

Similarity definition (docs/METHODOLOGY.md): d = Euclidean distance between
z-scored feature vectors (all FEATURE_COLUMNS, equal weights). The similarity
shown as a percentage is the share of *all* station pairs whose distance is
larger than d, i.e. "this pair is climatically closer than X% of all pairs".
"""

from __future__ import annotations

import json
import time

import numpy as np
import polars as pl
from scipy.spatial.distance import pdist
from sklearn.cluster import AgglomerativeClustering, KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import adjusted_rand_score, calinski_harabasz_score, silhouette_score
from sklearn.mixture import GaussianMixture
from sklearn.neighbors import KNeighborsRegressor, NearestNeighbors
from sklearn.preprocessing import StandardScaler

from features.build import FEATURE_COLUMNS, FEATURE_DEFS
from pipeline.config import PROCESSED_DIR

SEED = 42
K_RANGE = range(3, 13)
N_NEIGHBORS = 10
EARTH_MI = 3958.8


def haversine_mi(lat1, lon1, lat2, lon2):
    lat1, lon1, lat2, lon2 = map(np.radians, (lat1, lon1, lat2, lon2))
    a = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 2 * EARTH_MI * np.arcsin(np.sqrt(a))


def select_k(z: np.ndarray) -> tuple[int, dict]:
    rows = []
    for k in K_RANGE:
        km = KMeans(k, n_init=10, random_state=SEED).fit(z)
        ag = AgglomerativeClustering(k, linkage="ward").fit(z)
        gm = GaussianMixture(k, n_init=3, random_state=SEED, covariance_type="full").fit(z)
        rows.append(
            {
                "k": k,
                "kmeans_silhouette": float(silhouette_score(z, km.labels_)),
                "kmeans_inertia": float(km.inertia_),
                "kmeans_calinski_harabasz": float(calinski_harabasz_score(z, km.labels_)),
                "ward_silhouette": float(silhouette_score(z, ag.labels_)),
                "gmm_bic": float(gm.bic(z)),
                "gmm_silhouette": float(silhouette_score(z, gm.predict(z))),
            }
        )
    # Choice rule: highest k-means silhouette among k >= 5. Very small k (3-4)
    # often wins raw silhouette by only splitting "cold vs hot" which is not a
    # useful game representation; the >=5 floor is an interpretability choice
    # and is stated as such in the UI.
    eligible = [r for r in rows if r["k"] >= 5]
    best = max(eligible, key=lambda r: r["kmeans_silhouette"])
    return best["k"], {
        "model_selection": rows,
        "chosen_k": best["k"],
        "k_rule": "argmax k-means silhouette, k>=5",
    }


def stability(z: np.ndarray, k: int, labels: np.ndarray, reps: int = 25) -> dict:
    rng = np.random.default_rng(SEED)
    aris = []
    for _ in range(reps):
        idx = rng.choice(len(z), size=int(0.8 * len(z)), replace=False)
        sub = KMeans(k, n_init=10, random_state=int(rng.integers(1e9))).fit(z[idx])
        aris.append(adjusted_rand_score(labels[idx], sub.labels_))
    noise_aris = []
    for _ in range(reps):
        zn = z + rng.normal(0, 0.1, z.shape)
        lab = KMeans(k, n_init=10, random_state=int(rng.integers(1e9))).fit(zn).labels_
        noise_aris.append(adjusted_rand_score(labels, lab))
    return {
        "subsample_80pct_ari_mean": float(np.mean(aris)),
        "subsample_80pct_ari_std": float(np.std(aris)),
        "gaussian_noise_0.1sd_ari_mean": float(np.mean(noise_aris)),
        "gaussian_noise_0.1sd_ari_std": float(np.std(noise_aris)),
        "reps": reps,
    }


def geo_signal(z: np.ndarray, latlon: np.ndarray, cols: list[str]) -> dict:
    """How much geographic information is in the fingerprint: leave-one-out style
    kNN regression of (lat, lon) from features, reported as median error in miles."""

    def score(x: np.ndarray) -> float:
        nn = KNeighborsRegressor(n_neighbors=5, weights="distance").fit(x, latlon)
        # exclude self: query k+1 and drop the first neighbour
        dist, idx = NearestNeighbors(n_neighbors=6).fit(x).kneighbors(x)
        idx, dist = idx[:, 1:], dist[:, 1:]
        w = 1 / np.maximum(dist, 1e-6)
        pred = (latlon[idx] * w[..., None]).sum(1) / w.sum(1, keepdims=True)
        del nn
        return float(np.median(haversine_mi(latlon[:, 0], latlon[:, 1], pred[:, 0], pred[:, 1])))

    base = score(z)
    ablation = {}
    for i, c in enumerate(cols):
        ablation[c] = score(np.delete(z, i, axis=1))
    single = {c: score(z[:, [i]]) for i, c in enumerate(cols)}
    return {
        "method": "5-NN (distance weighted) regression of lat/lon from z-scored features, self excluded; median great-circle error",
        "all_features_median_error_mi": base,
        "without_feature_median_error_mi": ablation,
        "single_feature_median_error_mi": single,
    }


def main() -> None:
    t0 = time.time()
    df = pl.read_parquet(PROCESSED_DIR / "station_features.parquet").sort("station_id")
    X = df.select(FEATURE_COLUMNS).to_numpy()
    scaler = StandardScaler().fit(X)
    z = scaler.transform(X)

    k, selection = select_k(z)
    km = KMeans(k, n_init=20, random_state=SEED).fit(z)
    labels = km.labels_
    # relabel clusters by ascending mean annual temperature for readability
    temp_i = FEATURE_COLUMNS.index("annual_mean_temp_f")
    order = np.argsort([X[labels == c, temp_i].mean() for c in range(k)])
    remap = {old: new for new, old in enumerate(order)}
    labels = np.array([remap[c] for c in labels])

    pca = PCA(n_components=min(5, z.shape[1]), random_state=SEED).fit(z)
    pcs = pca.transform(z)

    sil_all = float(silhouette_score(z, labels))
    ablation = {}
    for i, c in enumerate(FEATURE_COLUMNS):
        zz = np.delete(z, i, axis=1)
        lab = KMeans(k, n_init=10, random_state=SEED).fit(zz).labels_
        ablation[c] = {
            "silhouette": float(silhouette_score(zz, lab)),
            "ari_vs_full": float(adjusted_rand_score(labels, lab)),
        }

    # between/within variance per feature (ANOVA-style F ratio)
    f_ratio = {}
    for i, c in enumerate(FEATURE_COLUMNS):
        grand = z[:, i].mean()
        between = sum(len(z[labels == g]) * (z[labels == g, i].mean() - grand) ** 2 for g in range(k)) / (
            k - 1
        )
        within = sum(((z[labels == g, i] - z[labels == g, i].mean()) ** 2).sum() for g in range(k)) / (
            len(z) - k
        )
        f_ratio[c] = float(between / within)

    latlon = df.select("lat", "lon").to_numpy()
    geo = geo_signal(z, latlon, FEATURE_COLUMNS)

    # pairwise distances -> similarity percentile lookup
    pd_all = np.sort(pdist(z))
    np.save(PROCESSED_DIR / "pair_distance_quantiles.npy", pd_all.astype(np.float32))

    # neighbours in climate space
    nn = NearestNeighbors(n_neighbors=N_NEIGHBORS + 1).fit(z)
    dist, idx = nn.kneighbors(z)
    ids = df["station_id"].to_list()
    neigh_rows = []
    for i in range(len(ids)):
        for rank in range(1, N_NEIGHBORS + 1):
            j = idx[i, rank]
            neigh_rows.append(
                {
                    "station_id": ids[i],
                    "neighbor_id": ids[j],
                    "rank": rank,
                    "climate_distance": float(dist[i, rank]),
                    "similarity_pct": float(100 * (1 - np.searchsorted(pd_all, dist[i, rank]) / len(pd_all))),
                    "geo_distance_mi": float(
                        haversine_mi(latlon[i, 0], latlon[i, 1], latlon[j, 0], latlon[j, 1])
                    ),
                }
            )
    pl.DataFrame(neigh_rows).write_parquet(PROCESSED_DIR / "neighbors.parquet")

    # percentiles per feature
    pct_cols = []
    for c in FEATURE_COLUMNS:
        pct_cols.append((pl.col(c).rank("average") / pl.len() * 100).alias(f"pct_{c}"))
    out = df.with_columns(pct_cols).with_columns(
        pl.Series("cluster", labels.astype(int)),
        pl.Series("pc1", pcs[:, 0]),
        pl.Series("pc2", pcs[:, 1]),
        pl.Series("pc3", pcs[:, 2]),
        pl.Series("silhouette", silhouette_samples_safe(z, labels)),
    )
    out.write_parquet(PROCESSED_DIR / "locations.parquet")

    # cluster summaries
    clusters = []
    for g in range(k):
        m = labels == g
        zc = z[m].mean(0)
        top = np.argsort(-np.abs(zc))[:4]
        traits = []
        for i in top:
            direction = "high" if zc[i] > 0 else "low"
            traits.append(
                f"{direction} {FEATURE_DEFS[FEATURE_COLUMNS[i]]['label'].lower()} ({zc[i]:+.1f} sd)"
            )
        clusters.append(
            {
                "cluster": g,
                "size": int(m.sum()),
                "centroid": {c: float(v) for c, v in zip(FEATURE_COLUMNS, X[m].mean(0))},
                "centroid_z": {c: float(v) for c, v in zip(FEATURE_COLUMNS, zc)},
                "within_variance": float(((z[m] - zc) ** 2).sum(1).mean()),
                "silhouette": float(np.mean(out.filter(pl.col("cluster") == g)["silhouette"].to_numpy())),
                "traits": traits,
                "states": out.filter(pl.col("cluster") == g)["state"]
                .value_counts()
                .sort("count", descending=True)
                .head(6)["state"]
                .to_list(),
                "centroid_lat": float(latlon[m, 0].mean()),
                "centroid_lon": float(latlon[m, 1].mean()),
            }
        )
    (PROCESSED_DIR / "clusters.json").write_text(json.dumps(clusters, indent=2))

    centroid_dists = pdist(np.array([[c["centroid_z"][f] for f in FEATURE_COLUMNS] for c in clusters]))
    diag = {
        **selection,
        "n_locations": int(len(z)),
        "n_features": len(FEATURE_COLUMNS),
        "features": FEATURE_COLUMNS,
        "normalisation": "z-score per feature (StandardScaler), equal weights",
        "scaler_mean": dict(zip(FEATURE_COLUMNS, map(float, scaler.mean_))),
        "scaler_scale": dict(zip(FEATURE_COLUMNS, map(float, scaler.scale_))),
        "final_silhouette": sil_all,
        "min_centroid_separation_z": float(centroid_dists.min()),
        "mean_centroid_separation_z": float(centroid_dists.mean()),
        "pca_explained_variance_ratio": [float(v) for v in pca.explained_variance_ratio_],
        "pca_loadings_pc1": dict(zip(FEATURE_COLUMNS, map(float, pca.components_[0]))),
        "pca_loadings_pc2": dict(zip(FEATURE_COLUMNS, map(float, pca.components_[1]))),
        "stability": stability(z, k, labels),
        "feature_ablation": ablation,
        "between_within_f_ratio": f_ratio,
        "geographic_signal": geo,
        "feature_correlation": {
            FEATURE_COLUMNS[i]: {
                FEATURE_COLUMNS[j]: float(np.corrcoef(z[:, i], z[:, j])[0, 1])
                for j in range(len(FEATURE_COLUMNS))
            }
            for i in range(len(FEATURE_COLUMNS))
        },
        "pair_distance_quantiles": {
            q: float(np.quantile(pd_all, q)) for q in (0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9)
        },
        "clustering_seconds": round(time.time() - t0, 1),
    }
    (PROCESSED_DIR / "cluster_diagnostics.json").write_text(json.dumps(diag, indent=2))
    print(
        json.dumps(
            {
                k_: v
                for k_, v in diag.items()
                if k_
                in ("chosen_k", "final_silhouette", "stability", "geographic_signal", "clustering_seconds")
            },
            indent=1,
        )
    )
    for c in clusters:
        print(c["cluster"], c["size"], c["states"][:4], c["traits"][:2])


def silhouette_samples_safe(z, labels):
    from sklearn.metrics import silhouette_samples

    return silhouette_samples(z, labels)


if __name__ == "__main__":
    main()
