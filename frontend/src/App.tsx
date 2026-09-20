import { useState } from "react";
import "leaflet/dist/leaflet.css";
import { Game } from "./Game";
import { Explore } from "./Explore";

export default function App() {
  const [tab, setTab] = useState<"play" | "explore">("play");
  const [station, setStation] = useState<string | null>(null);
  return (
    <div className="app">
      <header>
        <div className="brand">Climate<span>Guessr</span> <span className="muted small">· NOAA ISD 2015–2024 · {"Voloridge data explorer"}</span></div>
        <nav>
          <button className={tab === "play" ? "active" : ""} onClick={() => setTab("play")}>Play</button>
          <button className={tab === "explore" ? "active" : ""} onClick={() => setTab("explore")}>Explore the signal</button>
        </nav>
      </header>
      <main>
        {tab === "play" ? <Game onOpenExplore={(id) => { setStation(id); setTab("explore"); }} /> : <Explore initialStation={station} />}
      </main>
    </div>
  );
}
