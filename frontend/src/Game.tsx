import { useEffect, useRef, useState } from "react";
import { CircleMarker, MapContainer, Marker, Polyline, TileLayer, useMapEvents } from "react-leaflet";
import L from "leaflet";
import { api, CLUSTER_COLORS, fmt, fmtInt, ordinal, type Result, type Round } from "./api";
import { LocationPanel } from "./LocationPanel";

const US_CENTER: [number, number] = [38.5, -96.5];
const pin = (color: string) =>
  L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9], html: `<div style="width:18px;height:18px;border-radius:50%;background:${color};border:3px solid #fff;box-shadow:0 0 0 2px ${color}"></div>` });

function ClickCatcher({ onPick, disabled }: { onPick: (lat: number, lon: number) => void; disabled: boolean }) {
  useMapEvents({ click: (e) => !disabled && onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

type Phase = "idle" | "guessing" | "result";

export function Game({ onOpenExplore }: { onOpenExplore: (stationId: string) => void }) {
  const [round, setRound] = useState<Round | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [guess, setGuess] = useState<[number, number] | null>(null);
  const [left, setLeft] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const [totals, setTotals] = useState({ rounds: 0, score: 0 });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const timer = useRef<number | null>(null);

  const start = async () => {
    setBusy(true);
    const r = await api.newRound();
    setRound(r); setGuess(null); setResult(null); setShowAdvanced(false); setTimedOut(false); setLeft(r.seconds); setPhase("guessing"); setBusy(false);
  };

  useEffect(() => {
    if (phase !== "guessing") return;
    timer.current = window.setInterval(() => setLeft((s) => s - 1), 1000);
    return () => { if (timer.current) window.clearInterval(timer.current); };
  }, [phase]);

  useEffect(() => {
    if (phase === "guessing" && left <= 0) submit(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const submit = async (timeout = false) => {
    if (!round || phase !== "guessing") return;
    const g = guess ?? (timeout ? US_CENTER : null);
    if (!g) return;
    const noGuess = timeout && !guess;
    setBusy(true);
    const raw = await api.guess(round.round_id, g[0], g[1]);
    const res = noGuess ? { ...raw, score: 0 } : raw;
    setTimedOut(noGuess); setResult(res); setPhase("result"); setBusy(false);
    setTotals((t) => ({ rounds: t.rounds + 1, score: t.score + res.score }));
  };

  const t = result?.target;

  return (
    <div className="game">
      <div className="game-side">
        {phase === "idle" && (
          <div className="card">
            <h2>Where is this climate?</h2>
            <p className="muted">You get a description derived from ten years of NOAA surface observations. Click the map where you think the station is. Closer guesses score more (max 5,000).</p>
            <button className="primary" onClick={start} disabled={busy}>Start round</button>
          </div>
        )}
        {phase === "guessing" && round && (
          <div className="card">
            <div className="row between"><span className="tag">CLUE · {round.clue_source === "template" ? "deterministic template" : "LLM, verified"}</span><span className={`timer ${left <= 10 ? "urgent" : ""}`}>{Math.max(left, 0)}s</span></div>
            <p className="clue">{round.clue}</p>
            <p className="muted small">{guess ? `Guess: ${guess[0].toFixed(2)}, ${guess[1].toFixed(2)}` : "Click the map to place your guess."}</p>
            <button className="primary" onClick={() => submit()} disabled={!guess || busy}>Submit guess</button>
          </div>
        )}
        {phase === "result" && result && t && (
          <>
            <div className="card score-card">
              <div className="score">{result.score.toLocaleString()} <span className="muted">/ {result.max_score.toLocaleString()}</span></div>
              <div className="big">{timedOut ? "Time's up — no guess placed" : `${fmtInt(result.distance_mi)} miles away`}</div>
              <div className="muted">Target: <b>{t.name}</b>{t.state ? `, ${t.state}` : ""} · station {t.station_id}</div>
              <div className="row gap" style={{ marginTop: 10 }}>
                <button className="primary" onClick={start} disabled={busy}>Next round</button>
                <button onClick={() => setShowAdvanced((s) => !s)}>{showAdvanced ? "Hide" : "Advanced metrics"}</button>
                <button onClick={() => onOpenExplore(t.station_id)}>Explore the signal</button>
              </div>
            </div>
            <div className="card">
              <h3>Signal found</h3>
              <ul className="facts">
                {result.clue_facts.slice(0, 5).map((f) => (
                  <li key={f.feature}><span>{f.label}</span><b>{ordinal(f.percentile)} percentile</b><span className="muted">{fmt(f.value)} {f.unit}</span></li>
                ))}
              </ul>
              <div className="row between" style={{ marginTop: 8 }}>
                <span>Climate cluster <b style={{ color: CLUSTER_COLORS[result.cluster.cluster] }}>#{result.cluster.cluster}</b> · {result.cluster.size} locations</span>
              </div>
              <div className="muted small">{result.cluster.traits.slice(0, 3).join(" · ")}</div>
              {!timedOut && (<>
              <div className="sim">
                <div><div className="muted small">Geographic distance</div><b>{fmtInt(result.distance_mi)} mi</b></div>
                <div><div className="muted small">Climate similarity (guess vs target)</div><b>{fmt(result.climate_similarity_pct)}%</b></div>
                <div><div className="muted small">Same cluster?</div><b>{result.same_cluster ? "yes" : "no"}</b></div>
              </div>
              <p className="muted small">Similarity = share of all {"station"} pairs whose climate distance (Euclidean, z-scored features) is larger than this pair's. Your guess is represented by the nearest station, {result.nearest_station_to_guess.name} ({fmtInt(result.nearest_station_to_guess.distance_from_guess_mi)} mi from your click).</p>
              </>)}
            </div>
            {showAdvanced && (
              <>
                {!timedOut && <div className="card">
                  <h3>Guess vs target · per feature</h3>
                  <table className="tbl">
                    <thead><tr><th>Feature</th><th>Target</th><th>Guess</th><th>gap (sd)</th></tr></thead>
                    <tbody>
                      {result.per_feature.map((f) => (
                        <tr key={f.feature}><td>{f.label}</td><td>{fmt(f.target)} {f.unit}</td><td>{fmt(f.guess)} {f.unit}</td><td><div className="bar" style={{ width: `${Math.min(f.z_gap, 3) / 3 * 100}%` }} /> {fmt(f.z_gap, 2)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted small">Climate distance = {fmt(result.climate_distance, 3)} (L2 norm of the gap column). Elapsed {fmt(result.elapsed_seconds, 0)}s.</p>
                </div>}
                <LocationPanel location={{ ...t, neighbors: result.neighbors }} />
              </>
            )}
          </>
        )}
        <div className="muted small" style={{ padding: "0 4px" }}>Session: {totals.rounds} rounds · {totals.score.toLocaleString()} pts</div>
      </div>
      <div className="game-map">
        <MapContainer center={US_CENTER} zoom={4} minZoom={3} style={{ height: "100%", width: "100%" }}>
          <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}" attribution="Tiles &copy; Esri &mdash; Esri, HERE, Garmin, OpenStreetMap contributors" maxZoom={16} />
          {phase === "result" && <TileLayer url="https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}" maxZoom={16} />}
          <ClickCatcher disabled={phase !== "guessing"} onPick={(la, lo) => setGuess([la, lo])} />
          {guess && <Marker position={guess} icon={pin("#f28e2b")} />}
          {phase === "result" && result && t && (
            <>
              <Marker position={[t.lat, t.lon]} icon={pin("#59a14f")} />
              {!timedOut && <Polyline positions={[[result.guess.lat, result.guess.lon], [t.lat, t.lon]]} pathOptions={{ color: "#fff", dashArray: "6 8", weight: 2 }} />}
              {result.neighbors.map((n) => (
                <CircleMarker key={n.neighbor_id} center={[n.lat, n.lon]} radius={5} pathOptions={{ color: CLUSTER_COLORS[n.cluster], fillOpacity: 0.8 }} />
              ))}
            </>
          )}
        </MapContainer>
      </div>
    </div>
  );
}
