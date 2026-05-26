import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";
import type { PortStats } from "../lib/types";

const PRO = window.location.protocol === "https:" ? "https:" : "http:";
const API = `${PRO}//${window.location.host}/api`;

function age(ts: number): string {
  if (!ts) return "—";
  const dt = Date.now() / 1000 - ts;
  if (dt < 1) return "<1s";
  if (dt < 60) return `${dt.toFixed(0)}s`;
  if (dt < 3600) return `${(dt / 60).toFixed(0)}m`;
  return `${(dt / 3600).toFixed(0)}h`;
}

function SidEditor({ sid }: { sid: string }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(sid);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!sid) return <span>—</span>;

  const cancel = () => { setEditing(false); setDraft(sid); setErr(null); };
  const apply = async () => {
    const v = draft.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_-]{0,15}$/.test(v)) {
      setErr("[a-z0-9_-], starts with a letter, max 16");
      return;
    }
    if (v === sid) { setEditing(false); return; }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${API}/sensors/${encodeURIComponent(sid)}/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ new_sid: v }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.detail ?? `${r.status}`);
      setEditing(false);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!editing) {
    return (
      <>
        <span className="truncate">{sid}</span>
        <button
          onClick={() => { setDraft(sid); setEditing(true); }}
          className="text-zinc-500 hover:text-radar-accent text-[9px] uppercase tracking-wider ml-1"
          title="Rename sensor (persists to NVS, ESP reboots)"
        >
          ✎
        </button>
      </>
    );
  }
  return (
    <span className="flex items-center gap-1 w-full">
      <input
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") apply();
          if (e.key === "Escape") cancel();
        }}
        disabled={busy}
        className="flex-1 min-w-0 bg-radar-bg/60 border border-radar-border rounded px-1 text-zinc-200 outline-none focus:border-radar-accent"
      />
      <button onClick={apply} disabled={busy} className="text-emerald-400 hover:text-emerald-300 text-[10px]">{busy ? "…" : "✓"}</button>
      <button onClick={cancel} disabled={busy} className="text-zinc-500 hover:text-red-400 text-[10px]">✕</button>
      {err && <span className="text-red-400 text-[9px] absolute mt-4">{err}</span>}
    </span>
  );
}

function statusOf(p: PortStats): { label: string; color: string } {
  const now = Date.now() / 1000;
  if (p.error) return { label: "ERROR", color: "#ef4444" };
  if (!p.connected) return { label: "closed", color: "#71717a" };
  if (p.bytes_received === 0) return { label: "no bytes", color: "#facc15" };
  if (p.events_published === 0) {
    return { label: "garbage", color: "#f59e0b" };
  }
  if (now - p.last_event_ts > 5) return { label: "stalled", color: "#facc15" };
  return { label: "alive", color: "#34d399" };
}

export function SensorDiagnostics() {
  const ports = useStore((s) => s.ports);
  const sensors = useStore((s) => s.sensors);
  const visible = useStore((s) => s.panels.diagnostics);
  const togglePanel = useStore((s) => s.togglePanel);
  const [collapsed, setCollapsed] = useState(false);
  const drag = useDraggable();

  // Track ping rate from the first reporting sensor (they all share the same
  // value once a set-rate has been broadcast).
  const reportedPingMs = [...sensors.values()].find((s) => s.ping_interval_ms > 0)?.ping_interval_ms ?? 0;
  const [pingMs, setPingMs] = useState<number>(reportedPingMs || 50);
  const [pingBusy, setPingBusy] = useState(false);
  const [pingMsg, setPingMsg] = useState<string | null>(null);

  // When the firmware-reported value changes (e.g. after a successful push), keep
  // the input in sync as long as the user isn't actively editing.
  useEffect(() => {
    if (reportedPingMs > 0 && !pingBusy) {
      setPingMs(reportedPingMs);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reportedPingMs]);

  const applyPingRate = async () => {
    setPingBusy(true);
    setPingMsg(null);
    try {
      const r = await fetch(`${API}/ping-rate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ interval_ms: pingMs }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data?.detail ?? `${r.status}`);
      setPingMsg(`pushed to ${data.count ?? 0} sensor(s)`);
    } catch (e) {
      setPingMsg(`error: ${String(e)}`);
    } finally {
      setPingBusy(false);
      setTimeout(() => setPingMsg(null), 3000);
    }
  };

  if (!visible) return null;

  return (
    <div
      className="
        absolute right-2 top-2 left-2 max-h-[calc(100vh-1rem)]
        sm:right-3 sm:top-16 sm:left-auto sm:w-80 sm:max-h-[calc(100vh-5rem)]
        flex flex-col bg-radar-panel/95 border border-radar-border rounded font-mono text-[10px] z-20
      "
      style={drag.style}
    >
      <div
        {...drag.headerProps}
        className="flex items-center gap-2 px-3 py-2 border-b border-radar-border hover:bg-radar-bg/60 select-none shrink-0"
      >
        <span className="text-zinc-300 uppercase tracking-wider">📡 Sensors diagnostic</span>
        <span className="ml-auto text-zinc-500">
          {ports.length}p · {sensors.size}s
        </span>
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="text-zinc-500 hover:text-zinc-200 px-1"
          title="Collapse / expand"
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <button
          onClick={() => togglePanel("diagnostics")}
          className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1"
          title="Close"
        >×</button>
      </div>
      {!collapsed && (
        <div className="flex-1 overflow-y-auto">
          {/* Ping-rate control: broadcasts set_ping_rate to all ESP32s. Lower
              interval = more frames on the channel = higher CSI rate. */}
          <div className="px-3 py-2 border-b border-radar-border/40 flex items-center gap-2 flex-wrap">
            <span className="text-zinc-400 uppercase tracking-wider">CSI ping</span>
            <input
              type="number"
              min={10}
              max={5000}
              step={10}
              value={pingMs}
              onChange={(e) => setPingMs(Math.max(10, Math.min(5000, Number(e.target.value) || 0)))}
              className="w-16 bg-radar-bg/60 border border-radar-border rounded px-1.5 py-0.5 text-zinc-200 tabular-nums text-right outline-none focus:border-radar-accent"
            />
            <span className="text-zinc-500">ms</span>
            <span className="text-zinc-600">({pingMs > 0 ? (1000 / pingMs).toFixed(1) : "0"} Hz)</span>
            <button
              onClick={applyPingRate}
              disabled={pingBusy || pingMs < 10 || pingMs > 5000}
              className="ml-auto px-2 py-0.5 rounded border border-radar-border text-radar-accent hover:bg-radar-accent/10 disabled:opacity-50"
            >
              {pingBusy ? "…" : "apply"}
            </button>
            {pingMsg && (
              <span className={`w-full text-[10px] ${pingMsg.startsWith("error") ? "text-red-400" : "text-emerald-400"}`}>
                {pingMsg}
              </span>
            )}
          </div>
          {ports.length === 0 ? (
            <div className="px-3 py-3 text-zinc-500">
              No serial ports discovered. Check `ls /dev/ttyUSB*` on the Pi.
            </div>
          ) : (
            ports.map((p) => {
              const st = statusOf(p);
              const sensor = [...sensors.values()].find((s) => s.id === p.last_sid_seen);
              return (
                <div key={p.device} className="px-3 py-2 border-b border-radar-border/40">
                  <div className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ background: st.color }} />
                    <span className="text-zinc-200">{p.device}</span>
                    <span className="text-zinc-500">@{p.baud}</span>
                    <span className="ml-auto" style={{ color: st.color }}>{st.label}</span>
                  </div>
                  {p.error && <div className="text-red-400 mt-0.5 break-all">{p.error}</div>}
                  <div className="grid grid-cols-3 gap-x-2 gap-y-0.5 mt-1 text-zinc-500">
                    <span>sid</span>
                    <span className="col-span-2 text-radar-accent flex items-center gap-1">
                      <SidEditor sid={p.last_sid_seen} />
                    </span>
                    <span>bytes</span>
                    <span className="col-span-2 text-zinc-300 tabular-nums">{p.bytes_received.toLocaleString()}</span>
                    <span>lines</span>
                    <span className="col-span-2 text-zinc-300 tabular-nums">{p.lines_seen.toLocaleString()}</span>
                    <span>events</span>
                    <span className="col-span-2 text-emerald-400 tabular-nums">{p.events_published.toLocaleString()}</span>
                    <span>last byte</span>
                    <span className="col-span-2 text-zinc-400">{age(p.last_byte_ts)}</span>
                    <span>last event</span>
                    <span className="col-span-2 text-zinc-400">{age(p.last_event_ts)}</span>
                    {(p.rejected_boundary + p.rejected_json + p.rejected_type + p.rejected_sid) > 0 && (
                      <>
                        <span>rejected</span>
                        <span className="col-span-2 text-yellow-400 tabular-nums">
                          b={p.rejected_boundary} j={p.rejected_json} t={p.rejected_type} s={p.rejected_sid}
                        </span>
                      </>
                    )}
                    {sensor && (
                      <>
                        <span className="border-t border-radar-border/40 col-span-3 mt-1 pt-1 text-zinc-500">sensor</span>
                        <span>STA</span>
                        <span className="col-span-2" style={{ color: sensor.connected ? "#34d399" : "#facc15" }}>
                          {sensor.connected ? `✓ associated` : "not associated to AP"}
                        </span>
                        {sensor.connected && (
                          <>
                            <span>SSID</span>
                            <span className="col-span-2 text-radar-accent font-semibold truncate" title={sensor.ssid}>
                              {sensor.ssid || "<unknown>"}
                            </span>
                            <span>signal</span>
                            <span className="col-span-2 text-zinc-300 tabular-nums">{sensor.ap_rssi} dBm · ch.{sensor.channel}</span>
                          </>
                        )}
                        <span>drops</span>
                        <span className="col-span-2 text-zinc-400 tabular-nums">{sensor.drops.toLocaleString()}</span>
                        <span>ring</span>
                        <span className="col-span-2 text-zinc-400">{sensor.ring_free} B free</span>
                        {sensor.ping_interval_ms > 0 && (
                          <>
                            <span>ping</span>
                            <span className="col-span-2 text-zinc-300 tabular-nums">
                              <span className="text-emerald-400">{sensor.ping_recv.toLocaleString()}</span>
                              {" / "}
                              <span className={sensor.ping_lost > 0 ? "text-yellow-400" : "text-zinc-500"}>
                                {sensor.ping_lost.toLocaleString()} lost
                              </span>
                              <span className="text-zinc-500"> @ {sensor.ping_interval_ms}ms</span>
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
