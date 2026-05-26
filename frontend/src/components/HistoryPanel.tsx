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

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m < 60) return `${m}m ${String(s).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

interface Session {
  t_start: number;
  t_end: number | null;   // null = still ongoing (no leave event yet)
  duration: number;
  peak_confidence: number;
  avg_confidence: number;
  move_count: number;
  bbox: { x_min: number; x_max: number; z_min: number; z_max: number };
  enter_x: number;
  enter_z: number;
  partial: boolean;       // true if no preceding enter — window started mid-session
}

/**
 * Walk presence_events oldest-first, group enter→leave into sessions.  Events
 * come from /api/history/presence already sorted newest first; we reverse to
 * process chronologically.
 *
 * A session opens on `enter`, accumulates `move` confidence + bbox, closes on
 * `leave`.  An open session at the end of the list is treated as ongoing
 * (t_end=null).  Edge case: a leave without preceding enter → ignore (no
 * session to close).
 */
function deriveSessions(events: PresenceEvent[]): Session[] {
  const chrono = [...events].reverse();
  const sessions: Session[] = [];
  let cur: Session | null = null;
  const accumulate = (s: Session, ev: PresenceEvent) => {
    s.peak_confidence = Math.max(s.peak_confidence, ev.confidence);
    s.bbox.x_min = Math.min(s.bbox.x_min, ev.x);
    s.bbox.x_max = Math.max(s.bbox.x_max, ev.x);
    s.bbox.z_min = Math.min(s.bbox.z_min, ev.z);
    s.bbox.z_max = Math.max(s.bbox.z_max, ev.z);
  };
  let confSum = 0;
  let confSamples = 0;
  for (const ev of chrono) {
    if (ev.kind === "enter") {
      if (cur) {
        // Flush the previous open session (it never got a leave).  Treated
        // as ongoing for display purposes — duration = last move - start.
        cur.avg_confidence = confSamples > 0 ? confSum / confSamples : cur.peak_confidence;
        cur.duration = (ev.ts - cur.t_start);  // bound at the next enter
        sessions.push(cur);
      }
      cur = {
        t_start: ev.ts,
        t_end: null,
        duration: 0,
        peak_confidence: ev.confidence,
        avg_confidence: ev.confidence,
        move_count: 0,
        bbox: { x_min: ev.x, x_max: ev.x, z_min: ev.z, z_max: ev.z },
        enter_x: ev.x,
        enter_z: ev.z,
        partial: false,
      };
      confSum = ev.confidence;
      confSamples = 1;
    } else if (ev.kind === "move") {
      if (!cur) {
        // Move without preceding enter: window started mid-session.  Treat
        // the first move we see as a partial session start.
        cur = {
          t_start: ev.ts,
          t_end: null,
          duration: 0,
          peak_confidence: ev.confidence,
          avg_confidence: ev.confidence,
          move_count: 1,
          bbox: { x_min: ev.x, x_max: ev.x, z_min: ev.z, z_max: ev.z },
          enter_x: ev.x,
          enter_z: ev.z,
          partial: true,
        };
        confSum = ev.confidence;
        confSamples = 1;
      } else {
        cur.move_count++;
        accumulate(cur, ev);
        confSum += ev.confidence;
        confSamples++;
      }
    } else if (ev.kind === "leave") {
      if (cur) {
        accumulate(cur, ev);
        confSum += ev.confidence;
        confSamples++;
        cur.t_end = ev.ts;
        cur.duration = ev.ts - cur.t_start;
        cur.avg_confidence = confSamples > 0 ? confSum / confSamples : cur.peak_confidence;
        sessions.push(cur);
        cur = null;
        confSum = 0;
        confSamples = 0;
      }
      // else: orphan leave — ignore.
    }
  }
  if (cur) {
    cur.avg_confidence = confSamples > 0 ? confSum / confSamples : cur.peak_confidence;
    cur.duration = Date.now() / 1000 - cur.t_start;
    sessions.push(cur);
  }
  // Return newest first to match the rest of the panel.
  return sessions.reverse();
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
  const [tab, setTab] = useState<"sessions" | "transitions">("sessions");
  // Auto-playback: when `playing`, an interval advances replayAt one snapshot
  // step every `playPeriodMs`.  Speed buttons just change that period.
  const [playing, setPlaying] = useState(false);
  const [playPeriodMs, setPlayPeriodMs] = useState(500);  // 1× = 500ms (one snap / 0.5s)
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

  const sessions = useMemo(() => deriveSessions(presence), [presence]);

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

  // Auto-playback: advance one snapshot per tick.  Stops at the end (= live).
  useEffect(() => {
    if (!playing || !replayMode || slider.length === 0) return;
    const id = window.setInterval(() => {
      const idx = sliderIdx;
      if (idx >= slider.length - 1) {
        setPlaying(false);   // reached "now" — exit play
        return;
      }
      setReplayAt(slider[idx + 1]);
    }, playPeriodMs);
    return () => window.clearInterval(id);
  }, [playing, replayMode, playPeriodMs, sliderIdx, slider, setReplayAt]);

  // Leaving replay also stops playback.
  useEffect(() => {
    if (!replayMode && playing) setPlaying(false);
  }, [replayMode, playing]);

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
            onChange={(e) => {
              setPlaying(false);
              setReplayAt(slider[Number(e.target.value)]);
            }}
            className="w-full accent-radar-accent"
          />
          <div className="flex justify-between text-[9px] text-zinc-500">
            <span>{slider[0] ? fmtTime(slider[0]) : "—"}</span>
            <span className="text-radar-accent">
              {replayAt ? `${fmtTime(replayAt)} (${fmtRel(replayAt)})` : "—"}
            </span>
            <span>{slider[slider.length - 1] ? fmtTime(slider[slider.length - 1]) : "—"}</span>
          </div>
          {/* Playback row: play/pause + speed presets */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPlaying((p) => !p)}
              disabled={sliderIdx >= slider.length - 1 && !playing}
              className={`px-2 py-0.5 rounded border ${
                playing
                  ? "border-radar-warn text-radar-warn bg-radar-warn/10"
                  : "border-radar-accent text-radar-accent hover:bg-radar-accent/10"
              } disabled:opacity-40`}
              title={playing ? "Pause" : "Play"}
            >
              {playing ? "⏸" : "▶"}
            </button>
            <span className="text-zinc-600 text-[9px]">speed</span>
            {[
              { label: "1×", ms: 500 },
              { label: "2×", ms: 250 },
              { label: "4×", ms: 125 },
              { label: "8×", ms: 60 },
            ].map((s) => (
              <button
                key={s.label}
                onClick={() => setPlayPeriodMs(s.ms)}
                className={`px-1.5 py-0.5 rounded border text-[9px] ${
                  playPeriodMs === s.ms
                    ? "border-radar-accent text-radar-accent bg-radar-accent/10"
                    : "border-radar-border text-zinc-500 hover:border-radar-accent hover:text-radar-accent"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
          {/* Jump shortcuts */}
          <div className="flex gap-1">
            <button onClick={() => { setPlaying(false); setReplayAt(slider[Math.max(0, sliderIdx - 10)]); }}
              className="flex-1 px-1.5 py-0.5 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent">
              «« −50s
            </button>
            <button onClick={() => { setPlaying(false); setReplayAt(slider[Math.max(0, sliderIdx - 1)]); }}
              className="flex-1 px-1.5 py-0.5 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent">
              « −5s
            </button>
            <button onClick={() => { setPlaying(false); setReplayAt(slider[Math.min(slider.length - 1, sliderIdx + 1)]); }}
              className="flex-1 px-1.5 py-0.5 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent">
              +5s »
            </button>
            <button onClick={() => { setPlaying(false); setReplayAt(slider[Math.min(slider.length - 1, sliderIdx + 10)]); }}
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
        {/* Tabbed header for the two presence views */}
        <div className="px-2 py-1.5 border-b border-radar-border/40 sticky top-0 bg-radar-panel/95 flex items-center gap-1">
          <button
            onClick={() => setTab("sessions")}
            className={`px-2 py-0.5 rounded border ${
              tab === "sessions"
                ? "border-radar-accent text-radar-accent bg-radar-accent/10"
                : "border-radar-border text-zinc-500 hover:border-radar-accent hover:text-radar-accent"
            }`}
          >Sessions ({sessions.length})</button>
          <button
            onClick={() => setTab("transitions")}
            className={`px-2 py-0.5 rounded border ${
              tab === "transitions"
                ? "border-radar-accent text-radar-accent bg-radar-accent/10"
                : "border-radar-border text-zinc-500 hover:border-radar-accent hover:text-radar-accent"
            }`}
          >Transitions ({presence.length})</button>
        </div>

        {/* Sessions tab — enter→leave aggregated. */}
        {tab === "sessions" && (
          sessions.length === 0 ? (
            <div className="px-3 py-2 text-zinc-500">No presence session in this window.</div>
          ) : (
            sessions.map((s, i) => {
              const ongoing = s.t_end === null;
              const dx = s.bbox.x_max - s.bbox.x_min;
              const dz = s.bbox.z_max - s.bbox.z_min;
              const span = Math.hypot(dx, dz);
              return (
                <button
                  key={`${s.t_start}-${i}`}
                  onClick={() => { setReplayMode(true); setReplayAt(s.t_start); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-radar-bg/50 border-b border-radar-border/20 flex flex-col gap-0.5"
                  title={s.partial ? "Window started mid-session" : ""}
                >
                  <div className="flex items-center gap-2">
                    <span className={`text-[9px] uppercase w-12 ${
                      ongoing ? "text-emerald-400 animate-pulse" : s.partial ? "text-yellow-400" : "text-zinc-400"
                    }`}>
                      {ongoing ? "ongoing" : s.partial ? "partial" : "session"}
                    </span>
                    <span className="text-zinc-400 tabular-nums">{fmtTime(s.t_start)}</span>
                    {s.t_end !== null && (
                      <span className="text-zinc-600 tabular-nums">→ {fmtTime(s.t_end)}</span>
                    )}
                    <span className="ml-auto text-radar-accent tabular-nums">{fmtDuration(s.duration)}</span>
                  </div>
                  <div className="flex items-center gap-2 text-[9px] text-zinc-500 pl-12">
                    <span>peak <span className="text-zinc-300">{(s.peak_confidence * 100).toFixed(0)}%</span></span>
                    <span>avg <span className="text-zinc-300">{(s.avg_confidence * 100).toFixed(0)}%</span></span>
                    <span>{s.move_count} moves</span>
                    {span > 0.1 && <span>span {span.toFixed(1)}m</span>}
                  </div>
                </button>
              );
            })
          )
        )}

        {/* Transitions tab — raw enter/leave/move events. */}
        {tab === "transitions" && (
          presence.length === 0 ? (
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
          )
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
