import { useState } from "react";
import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";
import type { PortStats } from "../lib/types";

function age(ts: number): string {
  if (!ts) return "—";
  const dt = Date.now() / 1000 - ts;
  if (dt < 1) return "<1s";
  if (dt < 60) return `${dt.toFixed(0)}s`;
  if (dt < 3600) return `${(dt / 60).toFixed(0)}m`;
  return `${(dt / 3600).toFixed(0)}h`;
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

  if (!visible) return null;

  return (
    <div
      className="absolute right-3 top-16 w-80 max-h-[calc(100vh-5rem)] flex flex-col bg-radar-panel/95 border border-radar-border rounded font-mono text-[10px] z-20"
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
                    <span className="col-span-2 text-radar-accent">{p.last_sid_seen || "—"}</span>
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
