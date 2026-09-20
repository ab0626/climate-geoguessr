import { useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip as RTooltip, XAxis, YAxis, ZAxis } from "recharts";
import { api, CLUSTER_COLORS, fmt, fmtBytes, fmtInt, ordinal, type Cluster, type Diagnostics, type FeatureDef, type Location, type MapLocation, type Pipeline } from "./api";
import { LocationPanel } from "./LocationPanel";
import { clusterHighlights, featureLabel } from "./climate";
import { FeatureDescription } from "./FeatureDescription";

const US_CENTER: [number, number] = [38.5, -96.5];
const SECTIONS = ["Pipeline", "Cluster map", "Feature map", "Feature space", "Similarity", "Diagnostics", "Queries", "Methodology"] as const;
type Section = (typeof SECTIONS)[number];

function colorScale(v: number, lo: number, hi: number) {
  const t = Math.max(0, Math.min(1, (v - lo) / (hi - lo || 1)));
  const h = (1 - t) * 240;
  return `hsl(${h}, 80%, 55%)`;
}
function quantile(a: number[], q: number) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(q * (s.length - 1))]; }

export function Explore({ initialStation }: { initialStation: string | null }) {
  const [section, setSection] = useState<Section>(initialStation ? "Similarity" : "Pipeline");
  const [locs, setLocs] = useState<MapLocation[]>([]);
  const [clusters, setClusters] = useState<Cluster[]>([]);
  const [pipe, setPipe] = useState<Pipeline | null>(null);
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  useEffect(() => {
    api.locations().then(setLocs); api.clusters().then(setClusters); api.pipeline().then(setPipe); api.diagnostics().then(setDiag);
  }, []);
  return (
    <div className="explore">
      <nav className="subnav">{SECTIONS.map((s) => <button key={s} className={s === section ? "active" : ""} onClick={() => setSection(s)}>{s}</button>)}</nav>
      <div className="explore-body">
        {section === "Pipeline" && pipe && <PipelineView p={pipe} />}
        {section === "Cluster map" && <ClusterMap locs={locs} clusters={clusters} />}
        {section === "Feature map" && pipe && <FeatureMap locs={locs} defs={pipe.feature_defs} />}
        {section === "Feature space" && diag && <FeatureSpace locs={locs} diag={diag} />}
        {section === "Similarity" && <Similarity locs={locs} initial={initialStation} />}
        {section === "Diagnostics" && diag && pipe && <DiagnosticsView diag={diag} clusters={clusters} defs={pipe.feature_defs} />}
        {section === "Queries" && pipe && <Queries defs={pipe.feature_defs} />}
        {section === "Methodology" && pipe && diag && <Methodology p={pipe} diag={diag} />}
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return <div className="stat"><div className="muted small">{label}</div><div className="stat-v">{value}</div>{sub && <div className="muted small">{sub}</div>}</div>;
}

function PipelineView({ p }: { p: Pipeline }) {
  const s = p.stats as Record<string, any>;
  const c = p.coverage as Record<string, any>;
  const rawRecords = s.raw_records as number;
  const nulledQc = Object.values((s.values_nulled_qc_flag ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
  const nulledRange = Object.values((s.values_nulled_out_of_range ?? {}) as Record<string, number>).reduce((a, b) => a + b, 0);
  const rawBytes = s.raw_bytes_gz as number;
  return (
    <div className="stack">
      <div className="card">
        <div className="tag">NOAA ISD · {p.window.start_year}–{p.window.end_year}</div>
        <h2>Millions of observations. A map you can play.</h2>
        <p className="muted">Ten years of weather, distilled into the climate of each place.</p>
        <div className="flow">
          <div className="stage">
            <div className="stage-title">THE STARTING POINT</div>
            <Stat label="Raw observation records" value={fmtInt(rawRecords)} />
            <p className="muted small">Real measurements from weather stations across the contiguous United States.</p>
          </div>
          <div className="arrow">→</div>
          <div className="stage final-stage">
            <div className="stage-title">READY TO EXPLORE</div>
            <div className="summary-stats">
            <Stat label="Playable locations" value={fmtInt(p.final.locations)} />
            <Stat label="Climate features" value={`${p.final.features}`} />
            <Stat label="Clusters" value={`${p.final.clusters}`} />
            <Stat label="Final table size" value={fmtBytes(p.final.locations_bytes_parquet)} sub={`${(rawBytes / p.final.locations_bytes_parquet).toFixed(0)}× smaller than raw gzip`} />
            </div>
          </div>
        </div>
        <p className="muted small">Counts come from the pipeline run behind this build. Open the audit below for the full record.</p>
      </div>
      <details className="card disclosure">
        <summary>Pipeline audit · coverage, processing &amp; performance</summary>
        <div className="summary-stats">
          <Stat label="Downloaded station-year files" value={fmtInt(s.files)} sub={`${p.ingest_missing_files} station-year files unavailable`} />
          <Stat label="Raw archive" value={fmtBytes(rawBytes)} sub={`download ${fmtInt(p.ingest.seconds as number)} s`} />
          <Stat label="QC / range values removed" value={`${fmtInt(nulledQc)} / ${fmtInt(nulledRange)}`} />
          <Stat label="Clean hourly rows" value={fmtInt(s.clean_hourly_rows)} sub={fmtBytes(s.interim_bytes_parquet)} />
          <Stat label="Station-day rows" value={fmtInt(s.daily_rows)} sub={fmtBytes(s.daily_bytes_parquet)} />
          <Stat label="Processing time" value={`${fmtInt(s.processing_seconds)} s`} sub={`${s.cpu_count} cores · peak worker ${fmtInt(s.peak_rss_mb_worker_max)} MB`} />
          <Stat label="Stations excluded" value={fmtInt((c.stations_dropped_low_coverage as number) + (c.stations_dropped_missing_feature as number))} sub={`${fmtInt(c.stations_dropped_low_coverage)} low coverage · ${fmtInt(c.stations_dropped_missing_feature)} incomplete features`} />
          <Stat label="Reports consolidated" value={fmtInt(s.rows_collapsed_same_hour)} sub={`${fmtInt(s.rows_dropped_non_hourly_report)} non-observation records dropped`} />
        </div>
      <div className="grid2">
        <div className="card">
          <h3>Raw non-null counts per parsed variable</h3>
          <table className="tbl"><thead><tr><th>Variable</th><th>Non-null raw</th><th>% of records</th><th>QC nulled</th><th>Range nulled</th></tr></thead>
            <tbody>{Object.entries((s.raw_nonnull ?? {}) as Record<string, number>).map(([k, v]) => (
              <tr key={k}><td>{k}</td><td>{fmtInt(v)}</td><td>{fmt((100 * v) / rawRecords)}%</td><td>{fmtInt(s.values_nulled_qc_flag?.[k])}</td><td>{fmtInt(s.values_nulled_out_of_range?.[k])}</td></tr>
            ))}</tbody></table>
        </div>
        <div className="card">
          <h3>Variable coverage → feature selection</h3>
          <p className="muted small">Share of valid station-days with a value, across all stations. Variables below ~50% were not used as features.</p>
          <table className="tbl"><thead><tr><th>Variable</th><th>Coverage</th><th>Decision</th></tr></thead>
            <tbody>{Object.entries((c.variable_coverage_pct_of_valid_days ?? {}) as Record<string, number>).map(([k, v]) => (
              <tr key={k}><td>{k}</td><td><div className="bar" style={{ width: `${v}%` }} /> {fmt(v)}%</td><td className="muted small">{k === "visibility" ? "shown, excluded from model (ASOS saturates at 10 mi)" : k === "slp" || k === "sky" ? "shown per station, not a model feature" : v >= 50 ? "used" : "excluded (sparse)"}</td></tr>
            ))}
              <tr><td>precip (any 1-h report on the day)</td><td>{fmt(c.pct_valid_days_with_any_1h_precip_report)}%</td><td className="muted small">used; absent report = 0 on operating days; stations reporting on &lt;2% of days treated as no gauge</td></tr>
            </tbody></table>
          {p.query_latency_this_process && Object.keys(p.query_latency_this_process).length > 0 && (<>
            <h4>API query latency (this server process, measured)</h4>
            <table className="tbl"><thead><tr><th>Endpoint</th><th>n</th><th>p50</th><th>p95</th><th>max</th></tr></thead>
              <tbody>{Object.entries(p.query_latency_this_process).map(([k, v]) => <tr key={k}><td>{k}</td><td>{v.n}</td><td>{v.p50_ms} ms</td><td>{v.p95_ms} ms</td><td>{v.max_ms} ms</td></tr>)}</tbody></table>
          </>)}
          <h4>Report types seen</h4>
          <div className="chips">{Object.entries((s.report_type_counts ?? {}) as Record<string, number>).sort((a, b) => b[1] - a[1]).map(([k, v]) => <span className="chip" key={k}>{k.trim()} {fmtInt(v)}</span>)}</div>
        </div>
      </div>
      </details>
    </div>
  );
}

function ClusterMap({ locs, clusters }: { locs: MapLocation[]; clusters: Cluster[] }) {
  const [sel, setSel] = useState<number | null>(null);
  return (
    <div className="split">
      <div className="map-box">
        <MapContainer center={US_CENTER} zoom={4} style={{ height: "100%" }}>
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" attribution="Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors" maxZoom={16} /><TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}" maxZoom={16} />
          {locs.map((l) => (
            <CircleMarker key={l.station_id} center={[l.lat, l.lon]} radius={sel == null || sel === l.cluster ? 4 : 2}
              pathOptions={{ color: CLUSTER_COLORS[l.cluster], fillOpacity: sel == null || sel === l.cluster ? 0.85 : 0.15, stroke: false }}>
              <Tooltip>{l.name}, {l.state} · cluster #{l.cluster}</Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <div className="side scroll">
        <div className="card"><h3>Find a climate family</h3><p className="muted small">Select a group to highlight its stations. Numbers run from cooler to warmer annual averages.</p>
          <details className="disclosure"><summary>What do silhouette and “sd” mean?</summary>
            <p className="muted small">Silhouette measures how closely stations fit their own group compared with the nearest other group. Near 1: clearly separated. Near 0: overlapping climates. Below 0: closer, on average, to another group. Each card shows the group's average.</p>
            <p className="muted small">“sd” means standard deviations from the average station: +1 is one standard deviation above average; −1 is below. These describe climate differences, not confidence.</p>
          </details>
          {clusters.map((c) => (
            <div key={c.cluster} className={`cluster-card ${sel === c.cluster ? "active" : ""}`}>
              <button className="cluster-pick" aria-pressed={sel === c.cluster} onClick={() => setSel(sel === c.cluster ? null : c.cluster)}>
                <span className="dot" style={{ background: CLUSTER_COLORS[c.cluster] }} />
                <b>Group {c.cluster}</b><span className="muted small">{fmtInt(c.size)} locations</span>
              </button>
              <ul className="cluster-traits">{clusterHighlights(c.centroid_z).map((trait) => <li key={trait}>{trait}</li>)}</ul>
              <p className="muted small">Most represented states · {c.states.filter(Boolean).slice(0, 5).join(", ")}</p>
              <details className="disclosure">
                <summary>Cluster statistics</summary>
                <p className="small">Average silhouette <b>{fmt(c.silhouette, 2)}</b></p>
                <table className="tbl"><tbody>{Object.entries(c.centroid_z).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4).map(([key, value]) => <tr key={key}><td>{featureLabel(key)}</td><td>{value > 0 ? "+" : ""}{fmt(value)} sd</td></tr>)}</tbody></table>
              </details>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FeatureMap({ locs, defs }: { locs: MapLocation[]; defs: Record<string, FeatureDef> }) {
  const feats = Object.keys(defs);
  const [f, setF] = useState(feats[0]);
  const vals = locs.map((l) => l[f] as number).filter((v) => v != null);
  const lo = quantile(vals, 0.02), hi = quantile(vals, 0.98);
  return (
    <div className="split">
      <div className="map-box">
        <MapContainer center={US_CENTER} zoom={4} style={{ height: "100%" }}>
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" attribution="Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors" maxZoom={16} /><TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}" maxZoom={16} />
          {locs.map((l) => (
            <CircleMarker key={l.station_id} center={[l.lat, l.lon]} radius={4} pathOptions={{ color: colorScale(l[f] as number, lo, hi), fillOpacity: 0.9, stroke: false }}>
              <Tooltip>{l.name}, {l.state}: {fmt(l[f] as number)} {defs[f].unit}</Tooltip>
            </CircleMarker>
          ))}
        </MapContainer>
      </div>
      <div className="side scroll">
        <div className="card"><h3>Feature map</h3>
          <select aria-label="Map feature" value={f} onChange={(e) => setF(e.target.value)}>{feats.map((k) => <option key={k} value={k}>{featureLabel(k)}</option>)}</select>
          <div className="legend"><span>{fmt(lo)}</span><div className="legend-bar" /><span>{fmt(hi)} {defs[f].unit}</span></div>
          <p className="muted small">Blue = lower · red = higher. Colours stop changing beyond the 2nd and 98th percentiles.</p>
          <FeatureDescription feature={f} definition={defs[f]} />
        </div>
      </div>
    </div>
  );
}

function FeatureSpace({ locs, diag }: { locs: MapLocation[]; diag: Diagnostics }) {
  const byCluster = useMemo(() => {
    const m: Record<number, MapLocation[]> = {};
    locs.forEach((l) => (m[l.cluster] ??= []).push(l));
    return m;
  }, [locs]);
  const ev = diag.pca_explained_variance_ratio as number[];
  const load = (k: string) => Object.entries(diag[k] as Record<string, number>).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4).map(([f, v]) => `${featureLabel(f)} (${v > 0 ? "+" : ""}${v.toFixed(2)})`).join(", ");
  return (
    <div className="split">
      <div className="map-box card" style={{ padding: 8 }}>
        <ResponsiveContainer width="100%" height="100%">
          <ScatterChart margin={{ top: 10, right: 20, bottom: 20, left: 0 }}>
            <CartesianGrid stroke="#333" />
            <XAxis dataKey="pc1" type="number" name="PC1" stroke="#aaa" label={{ value: `PC1 (${fmt(100 * ev[0], 0)}% var)`, position: "insideBottom", fill: "#aaa", dy: 14 }} />
            <YAxis dataKey="pc2" type="number" name="PC2" stroke="#aaa" label={{ value: `PC2 (${fmt(100 * ev[1], 0)}%)`, angle: -90, position: "insideLeft", fill: "#aaa" }} />
            <ZAxis range={[18, 18]} />
            <RTooltip cursor={{ strokeDasharray: "3 3" }} content={({ payload }) => payload?.[0] ? <div className="tt">{(payload[0].payload as MapLocation).name}, {(payload[0].payload as MapLocation).state} · #{(payload[0].payload as MapLocation).cluster}</div> : null} />
            {Object.entries(byCluster).map(([c, pts]) => <Scatter key={c} data={pts} fill={CLUSTER_COLORS[+c]} fillOpacity={0.8} />)}
          </ScatterChart>
        </ResponsiveContainer>
      </div>
      <div className="side scroll">
        <div className="card"><div className="tag">A map of climate, not geography</div><h3>Why use PCA?</h3>
          <p>We cannot draw {diag.n_features} dimensions on a screen. PCA combines the climate features into two axes, giving each station a place on this chart.</p>
          <ul className="reading-list">
            <li><b>Nearby dots</b> have similar profiles in this view. Look for climate neighbours and groups that overlap.</li>
            <li><b>Colour</b> shows the station's climate cluster. Hover over a dot to identify it.</li>
            <li><b>{fmt(100 * (ev[0] + ev[1]), 0)}% of variation</b> is captured here. The remaining detail is lost, so nearby dots can still differ in other features.</li>
          </ul>
          <p className="muted small">Clustering and climate similarity use all {diag.n_features} standardized features. The two-axis projection is only a visual aid; the game score uses geographic distance.</p>
          <details className="disclosure"><summary>How to read the axes</summary>
          <p className="muted small">PC1 captures the largest direction of variation; PC2 captures the largest remaining direction at a right angle to it. Loadings are the feature weights: a positive weight increases toward the positive end of that axis.</p>
          <table className="tbl kv"><tbody>
            <tr><td>Explained variance</td><td>{ev.map((v, i) => `PC${i + 1} ${fmt(100 * v, 0)}%`).join(" · ")}</td></tr>
            <tr><td>PC1 loadings</td><td className="small">{load("pca_loadings_pc1")}</td></tr>
            <tr><td>PC2 loadings</td><td className="small">{load("pca_loadings_pc2")}</td></tr>
          </tbody></table>
          </details>
        </div>
      </div>
    </div>
  );
}

function Similarity({ locs, initial }: { locs: MapLocation[]; initial: string | null }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Location | null>(null);
  useEffect(() => { if (initial) api.location(initial).then(setSel); }, [initial]);
  const matches = q.length >= 2 ? locs.filter((l) => `${l.name} ${l.state} ${l.station_id}`.toLowerCase().includes(q.toLowerCase())).slice(0, 12) : [];
  return (
    <div className="split">
      <div className="map-box">
        <MapContainer center={US_CENTER} zoom={4} style={{ height: "100%" }}>
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" attribution="Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors" maxZoom={16} /><TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}" maxZoom={16} />
          {locs.map((l) => <CircleMarker key={l.station_id} center={[l.lat, l.lon]} radius={2} pathOptions={{ color: "#666", stroke: false, fillOpacity: 0.5 }} eventHandlers={{ click: () => api.location(l.station_id).then(setSel) }} />)}
          {sel && <CircleMarker center={[sel.lat, sel.lon]} radius={9} pathOptions={{ color: "#fff", fillColor: CLUSTER_COLORS[sel.cluster], fillOpacity: 1 }} />}
          {sel?.neighbors?.map((n) => (
            <span key={n.neighbor_id}>
              <Polyline positions={[[sel.lat, sel.lon], [n.lat, n.lon]]} pathOptions={{ color: CLUSTER_COLORS[n.cluster], weight: 1.5, opacity: 0.7 }} />
              <CircleMarker center={[n.lat, n.lon]} radius={6} pathOptions={{ color: CLUSTER_COLORS[n.cluster], fillOpacity: 0.9 }}><Tooltip>{n.name}, {n.state} · {fmt(n.similarity_pct)}% · {fmtInt(n.geo_distance_mi)} mi</Tooltip></CircleMarker>
            </span>
          ))}
        </MapContainer>
      </div>
      <div className="side scroll">
        <div className="card">
          <h3>Similarity view</h3>
          <input placeholder="Search station name / state / id…" value={q} onChange={(e) => setQ(e.target.value)} />
          {matches.map((m) => <div key={m.station_id} className="match" onClick={() => { api.location(m.station_id).then(setSel); setQ(""); }}>{m.name}, {m.state} <span className="muted small">{m.station_id}</span></div>)}
          <p className="muted small">Or click any grey dot on the map. Lines connect the 10 nearest neighbours in climate-feature space.</p>
        </div>
        {sel && <LocationPanel location={sel} />}
      </div>
    </div>
  );
}

function DiagnosticsView({ diag, clusters, defs }: { diag: Diagnostics; clusters: Cluster[]; defs: Record<string, any> }) {
  const ms = diag.model_selection as any[];
  const geo = diag.geographic_signal;
  const abl = diag.feature_ablation as Record<string, { silhouette: number; ari_vs_full: number }>;
  const fr = diag.between_within_f_ratio as Record<string, number>;
  const feats = diag.features as string[];
  const maxSil = Math.max(...ms.map((r) => r.kmeans_silhouette));
  return (
    <div className="stack">
      <details className="card disclosure">
        <summary>Model selection &amp; cluster stability</summary>
      <div className="grid2">
        <div className="card"><h3>Model selection</h3>
          <p className="muted small">Rule: {diag.k_rule}. Chosen k = <b>{diag.chosen_k}</b>, silhouette {fmt(diag.final_silhouette, 3)}. Three algorithms were compared at every k; k-means and Ward agree closely, GMM BIC keeps decreasing (it rewards more components on continuous gradients and was not used for the choice).</p>
          <table className="tbl"><thead><tr><th>k</th><th>k-means sil.</th><th>Ward sil.</th><th>GMM sil.</th><th>GMM BIC</th><th>Calinski-Harabasz</th></tr></thead>
            <tbody>{ms.map((r) => <tr key={r.k} className={r.k === diag.chosen_k ? "hl" : ""}><td>{r.k}</td><td><div className="bar" style={{ width: `${100 * r.kmeans_silhouette / maxSil}%` }} />{fmt(r.kmeans_silhouette, 3)}</td><td>{fmt(r.ward_silhouette, 3)}</td><td>{fmt(r.gmm_silhouette, 3)}</td><td>{fmtInt(r.gmm_bic)}</td><td>{fmtInt(r.kmeans_calinski_harabasz)}</td></tr>)}</tbody></table>
        </div>
        <div className="card"><h3>Stability</h3>
          <table className="tbl kv"><tbody>
            <tr><td>ARI, refit on random 80% subsets ({diag.stability.reps}×)</td><td>{fmt(diag.stability.subsample_80pct_ari_mean, 3)} ± {fmt(diag.stability.subsample_80pct_ari_std, 3)}</td></tr>
            <tr><td>ARI, refit with N(0, 0.1 sd) noise added</td><td>{fmt(diag.stability["gaussian_noise_0.1sd_ari_mean"], 3)} ± {fmt(diag.stability["gaussian_noise_0.1sd_ari_std"], 3)}</td></tr>
            <tr><td>Min / mean centroid separation (z units)</td><td>{fmt(diag.min_centroid_separation_z, 2)} / {fmt(diag.mean_centroid_separation_z, 2)}</td></tr>
          </tbody></table>
          <p className="muted small">ARI = adjusted Rand index between the production labels and a refit (1 = identical partition, 0 = random). Climate is a continuum, so a silhouette around 0.2–0.3 is expected: clusters are convenient regions on a gradient, not discrete populations. That is stated as a limitation, not hidden.</p>
          <h4>Per-cluster</h4>
          <table className="tbl"><thead><tr><th>#</th><th>size</th><th>within var</th><th>silhouette</th></tr></thead><tbody>{clusters.map((c) => <tr key={c.cluster}><td><span className="dot" style={{ background: CLUSTER_COLORS[c.cluster] }} />{c.cluster}</td><td>{c.size}</td><td>{fmt(c.within_variance, 2)}</td><td>{fmt(c.silhouette, 3)}</td></tr>)}</tbody></table>
        </div>
      </div>
      </details>
        <div className="card"><h3>Which features help locate a place?</h3>
          <p>Using all features, the median location error is <b>{fmt(geo.all_features_median_error_mi)} miles</b>.</p>
          <ol className="reading-list">
            <li>For each station, find its five closest climate neighbours, excluding the station itself.</li>
            <li>Average their coordinates, giving more weight to closer climate matches. Measure the miles from that estimate to the real station.</li>
            <li>Remove one feature, repeat for every station, and take the middle error. That is <b>“Error without it.”</b></li>
          </ol>
          <p className="muted small">A positive change means removing the feature worsened this estimate. A negative change means it improved. Correlated features can replace one another; this is a diagnostic on this station network, not causal importance or a held-out accuracy score.</p>
          <div className="table-scroll">
          <table className="tbl"><thead><tr><th>Feature removed</th><th>Error without it</th><th>Change from all features</th></tr></thead>
            <tbody>{feats.map((f) => (
              <tr key={f}><td>{featureLabel(f)}</td>
                <td>{fmt(geo.without_feature_median_error_mi[f])} mi</td>
                <td className={geo.without_feature_median_error_mi[f] > geo.all_features_median_error_mi ? "pos" : "neg"}>{geo.without_feature_median_error_mi[f] > geo.all_features_median_error_mi ? "+" : ""}{fmt(geo.without_feature_median_error_mi[f] - geo.all_features_median_error_mi)} mi</td></tr>
            ))}</tbody></table>
          </div>
          <details className="disclosure"><summary>Single-feature &amp; clustering diagnostics</summary>
          <div className="table-scroll"><table className="tbl"><thead><tr><th>Feature</th><th>Error using only this feature</th><th>Silhouette without it</th><th>ARI vs full</th><th>F ratio</th></tr></thead>
            <tbody>{feats.map((f) => <tr key={f}><td>{featureLabel(f)}</td><td>{fmtInt(geo.single_feature_median_error_mi[f])} mi</td><td>{fmt(abl[f].silhouette, 3)}</td><td>{fmt(abl[f].ari_vs_full, 2)}</td><td>{fmt(fr[f], 0)}</td></tr>)}</tbody>
          </table></div>
          <p className="muted small">F ratio = between-cluster / within-cluster variance of the z-scored feature (higher = feature separates the clusters more). Ablation silhouette is recomputed in the reduced space (not directly comparable to the full-space value, but ARI shows how much the partition changes).</p>
          </details>
        </div>
      <div className="card"><h3>Which features move together?</h3>
        <p className="muted small">Pearson correlation across stations: <b>+1</b> = rise together · <b>0</b> = little linear relationship · <b>−1</b> = move in opposite directions. Red is positive, blue is negative.</p>
        <div className="table-scroll" role="region" aria-label="Feature correlation matrix" tabIndex={0}>
          <table className="correlation-table">
            <caption>Feature correlation · values rounded to two decimals</caption>
            <thead><tr><th scope="col">Feature</th>{feats.map((f, i) => <th scope="col" key={f} title={featureLabel(f)}>{i + 1}</th>)}</tr></thead>
            <tbody>{feats.map((a, i) => <tr key={a}><th scope="row">{i + 1}. {featureLabel(a)}</th>{feats.map((b) => {
              const v: number = diag.feature_correlation[a][b];
              return <td key={b} title={`${defs[a]?.label ?? a} × ${defs[b]?.label ?? b}: ${v.toFixed(2)}`} style={{ background: v > 0 ? `rgba(226,87,89,${Math.abs(v) * 0.65})` : `rgba(78,121,167,${Math.abs(v) * 0.65})` }}>{v.toFixed(2)}</td>;
            })}</tr>)}</tbody>
          </table>
        </div>
        <p className="muted small">Column numbers match the numbered row labels. Strongly correlated features repeat some information, so equal feature weights give related groups of features more influence.</p>
      </div>
    </div>
  );
}

function Queries({ defs }: { defs: Record<string, any> }) {
  const feats = Object.keys(defs);
  const [f, setF] = useState("annual_precip_in");
  const [dir, setDir] = useState<"high" | "low">("high");
  const [ext, setExt] = useState<any[]>([]);
  const [out, setOut] = useState<any[]>([]);
  const [tw, setTw] = useState<any[]>([]);
  useEffect(() => { api.extremes(f, dir).then(setExt); }, [f, dir]);
  useEffect(() => { api.outliers().then(setOut); api.twins().then(setTw); }, []);
  return (
    <div className="stack">
      <div className="grid2">
        <div className="card"><h3>Which regions have unusually high/low values?</h3>
          <div className="row gap"><select aria-label="Ranked feature" value={f} onChange={(e) => setF(e.target.value)}>{feats.map((k) => <option key={k} value={k}>{featureLabel(k)}</option>)}</select><select aria-label="Ranking direction" value={dir} onChange={(e) => setDir(e.target.value === "low" ? "low" : "high")}><option value="high">highest</option><option value="low">lowest</option></select></div>
          {f === "frozen_precip_days_per_year" && <p className="muted small">Snow days is a cold-and-wet-day proxy, not observed snowfall.</p>}
          <table className="tbl"><tbody>{ext.map((r) => <tr key={r.station_id}><td><span className="dot" style={{ background: CLUSTER_COLORS[r.cluster] }} />{r.name}, {r.state}</td><td>{fmt(r[f], 1)} {defs[f].unit}</td><td className="muted small">{ordinal(r[`pct_${f}`])} pct</td></tr>)}</tbody></table>
        </div>
        <div className="card"><h3>Climate twins: similar climate, far apart</h3>
          <p className="muted small">Nearest-neighbour pairs ≥ 1,000 miles apart, ranked by climate distance. Demonstrates that similarity is a property of the fingerprint, not geography.</p>
          <table className="tbl"><tbody>{tw.map((r, i) => <tr key={i}><td>{r.a.name}, {r.a.state}</td><td>↔</td><td>{r.b.name}, {r.b.state}</td><td>{fmt(r.similarity_pct)}%</td><td className="muted small">{fmtInt(r.geo_distance_mi)} mi</td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="card"><h3>Climate outliers (lowest silhouette)</h3>
        <p className="muted small">Locations that sit between clusters or far from all of them — these are where the representation is weakest and the game is hardest.</p>
        <div className="chips">{out.map((r) => <span key={r.station_id} className="chip"><span className="dot" style={{ background: CLUSTER_COLORS[r.cluster] }} />{r.name}, {r.state} · s={fmt(r.silhouette, 2)}</span>)}</div>
      </div>
    </div>
  );
}

function Methodology({ p, diag }: { p: Pipeline; diag: Diagnostics }) {
  return (
    <div className="stack">
      <div className="grid2">
        <div className="card"><h3>Why weather stations?</h3>
          <ul className="reading-list">
            <li><b>{fmtInt(p.final.locations)} locations</b> across the contiguous United States, each linked to real NOAA observations.</li>
            <li><b>Direct measurements:</b> a station's profile describes its own location. Filling counties or grid cells without stations would require a spatial model.</li>
            <li><b>Climate groups:</b> clustering connects stations with similar conditions, even when they are far apart.</li>
          </ul>
        </div>
        <div className="card"><h3>Time window: why {p.window.start_year}–{p.window.end_year}?</h3>
          <ul className="reading-list">
            <li><b>Ten complete years</b> give us seasonal averages across many weather events.</li>
            <li><b>A consistent window</b> lets us compare places over the same period.</li>
            <li><b>A decadal snapshot:</b> formal WMO climate normals use 30 years. Unusual years still influence these averages.</li>
          </ul>
        </div>
      </div>
      <div className="grid2">
        <div className="card"><h3>How climate similarity works</h3>
          <ul className="reading-list">
            <li><b>{diag.n_features} features</b> describe temperature, precipitation, humidity and wind.</li>
            <li><b>A shared scale:</b> features are standardized before measuring distance, so inches and degrees can be compared with equal feature weights.</li>
            <li><b>A relative score:</b> 90% similarity means this pair is closer in climate than 90% of all station pairs.</li>
            <li><b>PCA is the picture:</b> the chart compresses the features into two axes; climate distances still use all of them.</li>
          </ul>
        </div>
        <div className="card"><h3>How the game works</h3>
          <ul className="reading-list">
            <li><b>Map accuracy earns points:</b> up to {String(p.scoring.max_score)} for a guess within {String(p.scoring.perfect_radius_mi)} miles. Points decrease exponentially with distance beyond that radius.</li>
            <li><b>Climate is a second comparison:</b> your click uses the nearest station for climate similarity, independently of your geographic score.</li>
            <li><b>Clues come from the data:</b> deterministic descriptions use measured climate features. Optional AI rewrites are checked for names and unsupported numbers.</li>
          </ul>
        </div>
      </div>
      <div className="card"><h3>Known limitations</h3>
        <ul className="reading-list">
          <li><b>Precipitation can read low.</b> Missing hourly reports on operating days are treated as zero; gauges can miss frozen precipitation. Faulty gauges can escape the quality checks.</li>
          <li><b>“Snow days” is a proxy.</b> It counts cold days with precipitation, not observed snow or snow depth.</li>
          <li><b>Station ≠ region.</b> A station represents its own footprint (airports dominate). Mountain climates are under-sampled.</li>
          <li><b>Clusters are a partition of a continuum.</b> Silhouette ~{fmt(diag.final_silhouette, 2)}; boundaries are soft and outliers exist (see Queries).</li>
          <li><b>Correlated features overlap.</b> Related temperature features give temperature more influence in the climate distance.</li>
        </ul>
      </div>
    </div>
  );
}
