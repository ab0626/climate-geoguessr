import { useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip } from "react-leaflet";
import { CartesianGrid, ResponsiveContainer, Scatter, ScatterChart, Tooltip as RTooltip, XAxis, YAxis, ZAxis } from "recharts";
import { api, CLUSTER_COLORS, fmt, fmtBytes, fmtInt, ordinal, type Cluster, type Diagnostics, type Location, type MapLocation, type Pipeline } from "./api";
import { LocationPanel } from "./LocationPanel";

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
        <h2>Before / after preprocessing</h2>
        <p className="muted">All numbers below are measured by the pipeline run that produced this build (data/processed/pipeline_stats.json). Nothing is estimated.</p>
        <div className="flow">
          <div className="stage">
            <div className="stage-title">RAW · NOAA ISD {p.window.start_year}–{p.window.end_year}</div>
            <Stat label="Station-year files downloaded" value={fmtInt(s.files)} sub={`${p.ingest_missing_files} listed stations had no file`} />
            <Stat label="Raw observation records" value={fmtInt(rawRecords)} />
            <Stat label="Raw size (gzip)" value={fmtBytes(rawBytes)} sub={`download ${fmtInt(p.ingest.seconds as number)} s`} />
            <Stat label="Raw fields parsed" value={`${(s.raw_columns as string[])?.length ?? "–"}`} sub="mandatory section + AA1 / AJ1 / GF1" />
            <Stat label="Candidate stations" value={fmtInt(c.stations_with_any_data)} />
          </div>
          <div className="arrow">→</div>
          <div className="stage">
            <div className="stage-title">CLEANED · hourly</div>
            <Stat label="Non-observation records dropped" value={fmtInt(s.rows_dropped_non_hourly_report)} sub="SOD/SOM summaries, SHEF, SURF" />
            <Stat label="Values nulled by ISD QC flag" value={fmtInt(nulledQc)} sub="codes 2,3,6,7" />
            <Stat label="Values nulled out of physical range" value={fmtInt(nulledRange)} />
            <Stat label="Reports collapsed to one per hour" value={fmtInt(s.rows_collapsed_same_hour)} />
            <Stat label="Clean hourly rows" value={fmtInt(s.clean_hourly_rows)} sub={`${fmtBytes(s.interim_bytes_parquet)} parquet`} />
          </div>
          <div className="arrow">→</div>
          <div className="stage">
            <div className="stage-title">AGGREGATED · daily</div>
            <Stat label="Station-day rows" value={fmtInt(s.daily_rows)} sub={`${fmtBytes(s.daily_bytes_parquet)} parquet`} />
            <Stat label="Stations kept" value={fmtInt(c.stations_kept)} sub={`${fmtInt(c.stations_dropped_low_coverage)} dropped <70% valid days · ${fmtInt(c.stations_dropped_missing_feature)} missing a feature (no dew point / no gauge)`} />
            <Stat label="Processing wall time" value={`${fmtInt(s.processing_seconds)} s`} sub={`${s.cpu_count} cores · peak worker RSS ${fmtInt(s.peak_rss_mb_worker_max)} MB`} />
          </div>
          <div className="arrow">→</div>
          <div className="stage">
            <div className="stage-title">STRUCTURED</div>
            <Stat label="Playable locations" value={fmtInt(p.final.locations)} />
            <Stat label="Climate features" value={`${p.final.features}`} />
            <Stat label="Clusters" value={`${p.final.clusters}`} />
            <Stat label="Final table size" value={fmtBytes(p.final.locations_bytes_parquet)} sub={`${(rawBytes / p.final.locations_bytes_parquet).toFixed(0)}× smaller than raw gzip`} />
          </div>
        </div>
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
        <div className="card"><h3>US climate clusters</h3><p className="muted small">k-means on z-scored fingerprints. Clusters are numbered coldest → hottest by mean annual temperature. Click to isolate.</p>
          {clusters.map((c) => (
            <div key={c.cluster} className={`cluster-row ${sel === c.cluster ? "active" : ""}`} onClick={() => setSel(sel === c.cluster ? null : c.cluster)}>
              <span className="dot" style={{ background: CLUSTER_COLORS[c.cluster] }} />
              <div><b>#{c.cluster}</b> · {c.size} locations · silhouette {fmt(c.silhouette, 2)}<div className="muted small">{c.traits.slice(0, 3).join(" · ")}</div><div className="muted small">mostly {c.states.filter(Boolean).slice(0, 5).join(", ")}</div></div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function FeatureMap({ locs, defs }: { locs: MapLocation[]; defs: Record<string, any> }) {
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
      <div className="side">
        <div className="card"><h3>Feature map</h3>
          <select value={f} onChange={(e) => setF(e.target.value)}>{feats.map((k) => <option key={k} value={k}>{defs[k].label}</option>)}</select>
          <div className="legend"><span>{fmt(lo)}</span><div className="legend-bar" /><span>{fmt(hi)} {defs[f].unit}</span></div>
          <p className="muted small">Colour scale clipped to the 2nd–98th percentile. <b>Aggregation:</b> {defs[f].aggregation}</p>
          <p className="muted small"><b>Source:</b> {defs[f].fields.join("; ")}</p>
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
  const load = (k: string) => Object.entries(diag[k] as Record<string, number>).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4).map(([f, v]) => `${f} (${v > 0 ? "+" : ""}${v.toFixed(2)})`).join(", ");
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
        <div className="card"><h3>Climate feature space (PCA)</h3>
          <p className="muted small">{diag.n_locations} locations × {diag.n_features} z-scored features projected onto the first two principal components. Colour = k-means cluster (fit in the full {diag.n_features}-D space, not on the projection).</p>
          <table className="tbl kv"><tbody>
            <tr><td>Explained variance</td><td>{ev.map((v, i) => `PC${i + 1} ${fmt(100 * v, 0)}%`).join(" · ")}</td></tr>
            <tr><td>PC1 loadings</td><td className="small">{load("pca_loadings_pc1")}</td></tr>
            <tr><td>PC2 loadings</td><td className="small">{load("pca_loadings_pc2")}</td></tr>
          </tbody></table>
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
      <div className="grid2">
        <div className="card"><h3>Feature signal: which features matter?</h3>
          <p className="muted small"><b>Geographic signal</b> — predict a station's lat/lon from its fingerprint alone (5-NN in feature space, self excluded). All features: median error <b>{fmtInt(geo.all_features_median_error_mi)} mi</b>. Removing a feature that carries unique geographic information makes the error grow; a feature alone shows how much it localises by itself.</p>
          <table className="tbl"><thead><tr><th>Feature</th><th>Error without it</th><th>Alone</th><th>Ablation silhouette</th><th>ARI vs full</th><th>F ratio</th></tr></thead>
            <tbody>{feats.map((f) => (
              <tr key={f}><td>{defs[f]?.label ?? f}</td>
                <td className={geo.without_feature_median_error_mi[f] > geo.all_features_median_error_mi ? "pos" : "neg"}>{fmtInt(geo.without_feature_median_error_mi[f])} mi</td>
                <td>{fmtInt(geo.single_feature_median_error_mi[f])} mi</td>
                <td>{fmt(abl[f].silhouette, 3)}</td><td>{fmt(abl[f].ari_vs_full, 2)}</td><td>{fmt(fr[f], 0)}</td></tr>
            ))}</tbody></table>
          <p className="muted small">F ratio = between-cluster / within-cluster variance of the z-scored feature (higher = feature separates the clusters more). Ablation silhouette is recomputed in the reduced space (not directly comparable to the full-space value, but ARI shows how much the partition changes).</p>
        </div>
        <div className="card"><h3>Feature correlation (redundancy check)</h3>
          <div className="heat">
            <div className="heat-row"><div className="heat-lbl" />{feats.map((f) => <div key={f} className="heat-col-lbl" title={f}>{f.slice(0, 6)}</div>)}</div>
            {feats.map((a) => <div key={a} className="heat-row"><div className="heat-lbl" title={a}>{defs[a]?.label.slice(0, 22)}</div>{feats.map((b) => { const v = diag.feature_correlation[a][b]; return <div key={b} className="heat-cell" title={`${a} × ${b}: ${v.toFixed(2)}`} style={{ background: v > 0 ? `rgba(226,87,89,${Math.abs(v)})` : `rgba(78,121,167,${Math.abs(v)})` }} />; })}</div>)}
          </div>
          <p className="muted small">Red = positive, blue = negative correlation. Temperature features are strongly inter-correlated by construction (winter/summer/annual) — this is deliberate: the game clue talks about seasons, and k-means with equal weights treats the temperature block as roughly 3× weight, which matches how people reason about climate. Alternatives are discussed in METHODOLOGY.md.</p>
        </div>
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
          <div className="row gap"><select value={f} onChange={(e) => setF(e.target.value)}>{feats.map((k) => <option key={k} value={k}>{defs[k].label}</option>)}</select><select value={dir} onChange={(e) => setDir(e.target.value as any)}><option value="high">highest</option><option value="low">lowest</option></select></div>
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
  const rules = p.rules as any;
  return (
    <div className="stack">
      <div className="grid2">
        <div className="card"><h3>Geographic representation: why stations?</h3>
          <p className="small">We evaluated stations, counties, regular grid cells, H3 cells and learned regions. The ISD network has ~{p.final.locations} CONUS stations with ≥70% valid days over {p.window.start_year}–{p.window.end_year}; that is already a fairly even ~40–60 mile spacing. Counties (3,100) would leave ~40% of counties with zero stations and force interpolation; coarse grids/H3 would average distinct microclimates (e.g. coastal vs inland California cells) and destroy the signal we want players to detect. Stations are the only unit where every displayed number is a direct aggregation of real observations with no spatial model, which is what makes provenance tractable. Learned clusters are used <i>on top</i> of stations as the second representation layer (the "hybrid" option).</p>
        </div>
        <div className="card"><h3>Time window: why {p.window.start_year}–{p.window.end_year}?</h3>
          <p className="small">The station history file shows the CONUS network grew from ~1,200 stations (2000) to ~2,600 (2010) and has been flat since. A ten-year block from 2015 is the longest recent window with a stable network, long enough to average out single anomalous years (2015–16 El Niño, 2021 heat dome are in the window) and small enough (18.7 GB gzip) to reprocess from raw in minutes. WMO climate normals use 30 years; we document that our values are a decadal climatology, not normals.</p>
        </div>
      </div>
      <div className="grid2">
        <div className="card"><h3>Cleaning rules (pipeline/config.py)</h3>
          <table className="tbl kv"><tbody>
            <tr><td>Report types kept</td><td>hourly / synoptic observations only; SOD, SOM daily & monthly summaries dropped</td></tr>
            <tr><td>QC codes rejected</td><td>{rules.qc_fail_codes.join(", ")} (ISD "suspect" / "erroneous")</td></tr>
            <tr><td>Physical bounds</td><td className="small">{Object.entries(rules.physical_bounds as Record<string, [number, number]>).map(([k, [a, b]]) => `${k} ${a}…${b}`).join(" · ")}</td></tr>
            <tr><td>Hourly de-duplication</td><td>mean of all reports within a clock hour (specials would otherwise over-weight storms)</td></tr>
            <tr><td>Local day</td><td>UTC shifted by round(lon/15) hours</td></tr>
            <tr><td>Valid day</td><td>≥ {rules.min_obs_per_day} hourly temperature values</td></tr>
            <tr><td>Station kept</td><td>≥ {100 * rules.min_valid_day_fraction}% valid days in window, all features finite</td></tr>
          </tbody></table>
        </div>
        <div className="card"><h3>Similarity & scoring</h3>
          <table className="tbl kv"><tbody>
            <tr><td>Normalisation</td><td>{diag.normalisation}</td></tr>
            <tr><td>Distance</td><td>Euclidean in z-space, {diag.n_features} features, equal weights</td></tr>
            <tr><td>Similarity %</td><td>share of all {fmtInt(diag.n_locations * (diag.n_locations - 1) / 2)} station pairs with a larger distance. Median pair distance = {fmt(diag.pair_distance_quantiles["0.5"], 2)}; 5% of pairs are closer than {fmt(diag.pair_distance_quantiles["0.05"], 2)}.</td></tr>
            <tr><td>Score</td><td>{String((p.scoring as any).formula)} with max {String((p.scoring as any).max_score)}, r0 = {String((p.scoring as any).perfect_radius_mi)} mi, scale = {String((p.scoring as any).scale_mi)} mi</td></tr>
            <tr><td>Clue</td><td>Deterministic template from percentile bands (no numbers, no names). Optional LLM rewrite is constrained to listed facts and rejected if it contains numbers or identifying tokens.</td></tr>
          </tbody></table>
        </div>
      </div>
      <div className="card"><h3>Known limitations</h3>
        <ul className="small">
          <li><b>Precipitation from 1-hour ASOS totals.</b> Hours without a report are treated as zero on days when the station was operating. Frozen precipitation is under-caught by tipping-bucket gauges; totals in snowy climates are biased low. The independent 24-h AA1 totals are shown per station as a cross-check.</li>
          <li><b>No true snowfall.</b> ISD AJ1 snow depth was present on too few station-days at ASOS sites (see Pipeline → coverage). "Frozen-precipitation days" (≥1 mm on a day with mean temp ≤ 0 °C) is a proxy and is labelled as such.</li>
          <li><b>Station ≠ region.</b> A station represents its own footprint (airports dominate). Mountain climates are under-sampled.</li>
          <li><b>Clusters are a partition of a continuum.</b> Silhouette ~{fmt(diag.final_silhouette, 2)}; boundaries are soft and outliers exist (see Queries).</li>
          <li><b>Decadal, not normals.</b> 2015–2024 was warmer than the 1991–2020 normals nearly everywhere.</li>
          <li><b>Sea-level pressure, ceiling and sky cover</b> were excluded for coverage, not because they lack signal.</li>
        </ul>
      </div>
    </div>
  );
}
