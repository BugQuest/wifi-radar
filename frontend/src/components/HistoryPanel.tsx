import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";
import type { SnapshotPayload } from "../store";

const PRO = window.location.protocol === "https:" ? "https:" : "http:";
const API = `${PRO}//${window.location.host}/api`;

interface PresenceEvent {
  ts: number;
  active: boolean;
  x: number;
  z: number;
  confidence: number;
  sources: number;
  kind: string;
}

const RANGES: { label: string; minutes: number }[] = [
  { label: "15m", minutes: 15 },
  { label: "1h",  minutes: 60 },
  { label: "6h",  minutes: 360 },
  { label: "24h", minutes: 1440 },
];

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function fmtRel(ts: number): string {
  const dt = Date.now() / 1000 - ts;
  if (dt < 60) return `${dt.toFixed(0)}s ago`;
  if (dt < 3600) return `${(dt / 60).toFixed(0)}m ago`;
  if (dt < 86400) return `${(dt / 3600).toFixed(1)}h ago`;
  return `${(dt / 86400).toFixed(1)}d ago`;
}

const PRESENCE_KIND_COLOR: Record<string, string> = {
  enter: "text-emerald-400",
  leave: "text-zinc-500",
  move: "text-radar-accent",
};

export function HistoryPanel() {
  const visible = useStore((s) => s.panels.history);
  const togglePanel = useStore((s) => s.togglePanel);
  const replayMode = useStore((s) => s.replayMode);
  const replayAt = useStore((s) => s.replayAt);
  const setReplayMode = useStore((s) => s.setReplayMode);
  const setReplayAt = useStore((s) => s.setReplayAt);
  const setReplaySnapshot = useStore((s) => s.setReplaySnapshot);
  const drag = useDraggable();

  const [minutes, setMinutes] = useState(60);
  const [timestamps, setTimestamps] = useState<number[]>([]);  // newest first
  const [presence, setPresence] = useState<PresenceEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Cache fetched snapshots by exact ts so dragging the slider back and forth
  // doesn't pound the backend.
  const snapshotCache = useRef<Map<number, SnapshotPayload>>(new Map());

  // Refresh history listings whenever the range changes (or the panel opens).
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    setLoading(true);
    setErr(null);
    Promise.all([
      fetch(`${API}/history/snapshots?since_minutes=${minutes}&limit=2000`).then((r) => r.json()),
      fetch(`${API}/history/presence?since_minutes=${minutes}&limit=500`).then((r) => r.json()),
    ])
      .then(([snaps, pres]) => {
        if (!alive) return;
        setTimestamps((snaps?.timestamps ?? []) as number[]);
        setPresence((pres?.events ?? []) as PresenceEvent[]);
      })
      .catch((e) => alive && setErr(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [visible, minutes]);

  // Whenever replayAt changes, fetch the matching snapshot (cached).
  useEffect(() => {
    if (!replayMode || replayAt == null) return;
    const cached = snapshotCache.current.get(replayAt);
    if (cached) {
      setReplaySnapshot(cached);
      return;
    }
    let alive = true;
    fetch(`${API}/history/snapshot?ts=${replayAt}`)
      .then((r) => r.json())
      .then((data) => {
        if (!alive) return;
        const payload = data?.payload as SnapshotPayload | undefined;
        if (payload) {
          snapshotCache.current.set(replayAt, payload);
          setReplaySnapshot(payload);
        }
      })
      .catch(() => { /* swallow — UI keeps last snapshot */ });
    return () => { alive = false; };
  }, [replayMode, replayAt, setReplaySnapshot]);

  // Reverse so the slider goes left = old, right = new (matches intuition).
  const slider = useMemo(() => {
    const asc = [...timestamps].reverse();
    return asc;
  }, [timestamps]);

  const sliderIdx = useMemo(() => {
    if (replayAt == null || slider.length === 0) return slider.length - 1;
    let best = 0;
    let bestDt = Infinity;
    for (let i = 0; i < slider.length; i++) {
      const dt = Math.abs(slider[i] - replayAt);
      if (dt < bestDt) { bestDt = dt; best = i; }
    }
    return best;
  }, [slider, replayAt]);

  const startReplay = (ts?: number) => {
    setReplayMode(true);
    const t = ts ?? (slider.length > 0 ? slider[slider.length - 1] : null);
    setReplayAt(t);
  };

  const stopReplay = () => {
    setReplayMode(false);
    setReplayAt(null);
    setReplaySnapshot(null);
  };

  if (!visible) return null;

  return (
    <div
      className="
        absolute right-2 top-2 left-2 max-h-[calc(100vh-1rem)]
        sm:right-3 sm:top-16 sm:left-auto sm:w-[26rem] sm:max-h-[calc(100vh-5rem)]
        flex flex-col bg-radar-panel/95 border border-radar-border rounded font-mono text-[10px] z-20
      "
      style={drag.style}
    >
      <div
        {...drag.headerProps}
        className="flex items-center gap-2 px-3 py-2 border-b border-radar-border hover:bg-radar-bg/60 select-none shrink-0"
      >
        <span className="text-zinc-300 uppercase tracking-wider">⏱ History</span>
        <span className={`ml-1 text-[9px] px-1.5 py-0.5 rounded border ${
          replayMode ? "border-radar-accent text-radar-accent bg-radar-accent/10 animate-pulse" : "border-radar-border text-zinc-500"
        }`}>{replayMode ? "REPLAY" : "LIVE"}</span>
        <span className="ml-auto text-zinc-500">{slider.length} snaps · {presence.length} ev</span>
        <button
          onClick={() => togglePanel("history")}
          className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1"
          title="Close"
        >×</button>
      </div>

      {/* Range selector + replay toggle */}
      <div className="px-3 py-2 border-b border-radar-border/40 flex items-center gap-1.5 flex-wrap">
        <span className="text-zinc-400 uppercase tracking-wider">window</span>
        {RANGES.map((r) => (
          <button
            key={r.label}
            onClick={() => setMinutes(r.minutes)}
            className={`px-1.5 py-0.5 rounded border ${
              minutes === r.minutes
                ? "border-radar-accent text-radar-accent bg-radar-accent/10"
                : "border-radar-border text-zinc-500 hover:text-radar-accent hover:border-radar-accent"
            }`}
          >
            {r.label}
          </button>
        ))}
        <span className="ml-auto" />
        {!replayMode ? (
          <button
            onClick={() => startReplay()}
            disabled={slider.length === 0}
            className="px-2 py-0.5 rounded border border-radar-accent text-radar-accent hover:bg-radar-accent/10 disabled:opacity-40"
          >▶ replay</button>
        ) : (
          <button
            onClick={stopReplay}
            className="px-2 py-0.5 rounded border border-emerald-400 text-emerald-400 hover:bg-emerald-400/10"
          >● go live</button>
        )}
      </div>

      {/* Timeline scrubber */}
      {replayMode && slider.length > 0 && (
        <div className="px-3 py-2 border-b border-radar-border/40 flex flex-col gap-1">
          <input
            type="range"
            min={0}
            max={Math.max(0, slider.length - 1)}
            value={sliderIdx}
            onChange={(e) => setReplayAt(slider[Number(e.target.value)])}
            className="w-full accent-radar-accent"
          />
          <div className="flex justify-between text-[9px] text-zinc-500">
            <span>{slider[0] ? fmtTime(slider[0]) : "—"}</span>
            <span className="text-radar-accent">
              {replayAt ? `${fmtTime(replayAt)} (${fmtRel(replayAt)})` : "—"}
            </span>
            <span>{slider[slider.length - 1] ? fmtTime(slider[slider.length - 1]) : "—"}</span>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setReplayAt(slider[Math.max(0, sliderIdx - 10)])}
              className="flex-1 px-1.5 py-0.5 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent">
              «« −50s
            </button>
            <button onClick={() => setReplayAt(slider[Math.max(0, sliderIdx - 1)])}
              className="flex-1 px-1.5 py-0.5 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent">
              « −5s
            </button>
            <button onClick={() => setReplayAt(slider[Math.min(slider.length - 1, sliderIdx + 1)])}
              className="flex-1 px-1.5 py-0.5 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent">
              +5s »
            </button>
            <button onClick={() => setReplayAt(slider[Math.min(slider.length - 1, sliderIdx + 10)])}
              className="flex-1 px-1.5 py-0.5 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent">
              +50s »»
            </button>
          </div>
        </div>
      )}

      {err && (
        <div className="px-3 py-1.5 text-red-400 text-[10px] break-all">{err}</div>
      )}

      {/* Lists */}
      <div className="flex-1 overflow-y-auto">
        {/* Presence events */}
        <div className="px-3 py-1.5 text-zinc-400 uppercase tracking-wider border-b border-radar-border/40 sticky top-0 bg-radar-panel/95">
          Presence events
        </div>
        {presence.length === 0 ? (
          <div className="px-3 py-2 text-zinc-500">No presence transition in this window.</div>
        ) : (
          presence.map((e, i) => (
            <button
              key={`${e.ts}-${i}`}
              onClick={() => { setReplayMode(true); setReplayAt(e.ts); }}
              className="w-full text-left px-3 py-1.5 hover:bg-radar-bg/50 border-b border-radar-border/20 flex items-center gap-2"
            >
              <span className={`uppercase text-[9px] w-10 ${PRESENCE_KIND_COLOR[e.kind] ?? "text-zinc-300"}`}>{e.kind}</span>
              <span className="text-zinc-400 tabular-nums w-16">{fmtTime(e.ts)}</span>
              <span className="text-zinc-500 tabular-nums">
                x={e.x.toFixed(1)} z={e.z.toFixed(1)}
              </span>
              <span className="ml-auto text-zinc-500 text-[9px]">
                conf {(e.confidence * 100).toFixed(0)}% · {e.sources}src
              </span>
            </button>
          ))
        )}

        {/* Snapshot index — useful to jump to specific moments */}
        <div className="px-3 py-1.5 text-zinc-400 uppercase tracking-wider border-b border-radar-border/40 sticky top-0 bg-radar-panel/95">
          Snapshots ({timestamps.length})
        </div>
        {loading && <div className="px-3 py-2 text-zinc-500">loading…</div>}
        {!loading && timestamps.length === 0 && (
          <div className="px-3 py-2 text-zinc-500">No snapshots yet. Backend needs ~5s of uptime per snap.</div>
        )}
        {!loading && timestamps.slice(0, 30).map((ts) => (
          <button
            key={ts}
            onClick={() => { setReplayMode(true); setReplayAt(ts); }}
            className={`w-full text-left px-3 py-1 hover:bg-radar-bg/50 border-b border-radar-border/20 flex items-center gap-2 ${
              replayAt === ts ? "bg-radar-accent/10" : ""
            }`}
          >
            <span className="text-zinc-400 tabular-nums w-16">{fmtTime(ts)}</span>
            <span className="text-zinc-600 text-[9px]">{fmtRel(ts)}</span>
          </button>
        ))}
        {timestamps.length > 30 && (
          <div className="px-3 py-1.5 text-zinc-600 text-[9px]">… {timestamps.length - 30} more (use the scrubber to access)</div>
        )}
      </div>
    </div>
  );
}
