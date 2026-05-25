import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { colorFromMac, withAlpha, rssiToDistance, formatDistance } from "../lib/colors";
import { useDraggable } from "../lib/useDraggable";
import { TrilaterationDebug } from "./TrilaterationDebug";

function age(ts: number): string {
  const dt = Date.now() / 1000 - ts;
  if (dt < 60) return `${Math.round(dt)}s ago`;
  if (dt < 3600) return `${Math.round(dt / 60)}m ago`;
  return `${Math.round(dt / 3600)}h ago`;
}

function duration(start: number, end: number): string {
  const dt = Math.max(0, end - start);
  if (dt < 60) return `${dt.toFixed(0)}s`;
  if (dt < 3600) return `${(dt / 60).toFixed(1)}m`;
  return `${(dt / 3600).toFixed(1)}h`;
}

// Mini sparkline for RSSI history (dBm vs time index).
function RssiSparkline({ values, color }: { values: number[]; color: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);

    if (values.length < 2) {
      ctx.fillStyle = "#52525b";
      ctx.font = "10px monospace";
      ctx.fillText("(no data yet)", 4, H / 2 + 4);
      return;
    }

    const min = -95;
    const max = -25;
    const span = max - min;
    const xs = values.map((_, i) => (i / (values.length - 1)) * W);
    const ys = values.map((v) => H - ((Math.max(min, Math.min(max, v)) - min) / span) * H);

    // Grid lines at -30, -50, -70, -90
    ctx.strokeStyle = "#1a2440";
    ctx.lineWidth = 1;
    [-30, -50, -70, -90].forEach((dbm) => {
      const y = H - ((dbm - min) / span) * H;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    });

    // Fill under line
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, withAlpha(color, 0.4));
    grad.addColorStop(1, withAlpha(color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(xs[0], H);
    for (let i = 0; i < xs.length; i++) ctx.lineTo(xs[i], ys[i]);
    ctx.lineTo(xs[xs.length - 1], H);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < xs.length; i++) {
      if (i === 0) ctx.moveTo(xs[i], ys[i]);
      else ctx.lineTo(xs[i], ys[i]);
    }
    ctx.stroke();

    // Last point
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(xs[xs.length - 1], ys[ys.length - 1], 2.5, 0, Math.PI * 2);
    ctx.fill();
  }, [values, color]);

  return <canvas ref={canvasRef} width={300} height={70} className="w-full h-[70px]" />;
}

function rssiQuality(rssi: number): { label: string; color: string } {
  if (rssi > -50) return { label: "Excellent", color: "#34d399" };
  if (rssi > -65) return { label: "Good", color: "#a3e635" };
  if (rssi > -75) return { label: "Fair", color: "#facc15" };
  if (rssi > -85) return { label: "Weak", color: "#fb923c" };
  return { label: "Very weak", color: "#f87171" };
}

function velocityFrom(positions: { ts: number; x: number; z: number }[]): { speed: number; bearing: number } | null {
  if (positions.length < 2) return null;
  const tail = positions.slice(-Math.min(positions.length, 8));
  const dt = tail[tail.length - 1].ts - tail[0].ts;
  if (dt < 0.05) return null;
  const dx = tail[tail.length - 1].x - tail[0].x;
  const dz = tail[tail.length - 1].z - tail[0].z;
  const vx = dx / dt;
  const vz = dz / dt;
  const speed = Math.hypot(vx, vz);
  const bearing = (Math.atan2(vz, vx) * 180 / Math.PI + 360) % 360;
  return { speed, bearing };
}

function packetKindColor(k: string): string {
  switch (k) {
    case "beacon": return "#a3e635";
    case "probe-req": return "#22d3ee";
    case "probe-resp": return "#06b6d4";
    case "data": return "#facc15";
    case "auth":
    case "assoc-req":
    case "assoc-resp": return "#fb923c";
    case "deauth": return "#f87171";
    default: return "#71717a";
  }
}

export function DeviceDetail() {
  const selectedMac = useStore((s) => s.selectedMac);
  const devices = useStore((s) => s.devices);
  const setSelected = useStore((s) => s.setSelected);
  const soloMode = useStore((s) => s.soloMode);
  const setSoloMode = useStore((s) => s.setSoloMode);
  const triggerFocus = useStore((s) => s.triggerFocus);
  const selectedPackets = useStore((s) => s.selectedPackets);
  const selectedPositions = useStore((s) => s.selectedPositions);
  const selectedCsi = useStore((s) => s.selectedCsi);
  const [showDebug, setShowDebug] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "ok" | "err">("idle");
  const [vendorLookup, setVendorLookup] = useState<{
    loading: boolean;
    data?: { company?: string; addressL1?: string; addressL2?: string; addressL3?: string; countryName?: string; type?: string };
    error?: string;
  } | null>(null);
  const drag = useDraggable();

  // Reset cached lookup + copy feedback when the user selects another device.
  useEffect(() => {
    setVendorLookup(null);
    setCopyState("idle");
  }, [selectedMac]);

  if (!selectedMac) return null;
  const d = devices.get(selectedMac);
  if (!d) return null;

  const color = colorFromMac(d.mac);
  const quality = rssiQuality(d.last_rssi);
  const totalKinds = Object.values(d.kinds).reduce((a, b) => a + b, 0);
  const history = d.rssi_history ?? [];
  const avg =
    history.length > 0 ? history.reduce((a, b) => a + b, 0) / history.length : d.last_rssi;
  const min = history.length > 0 ? Math.min(...history) : d.last_rssi;
  const max = history.length > 0 ? Math.max(...history) : d.last_rssi;
  const velocity = velocityFrom(selectedPositions);

  const copyMac = async () => {
    const text = d.mac;
    // Async Clipboard API is gated behind a secure context (HTTPS or localhost).
    // We typically run on http://<host>.local so we have to fall back to the
    // legacy execCommand approach via a transient textarea.
    let ok = false;
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      // fall through to legacy path
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    setCopyState(ok ? "ok" : "err");
    setTimeout(() => setCopyState("idle"), 1500);
  };

  // Manual vendor lookup. macvendorlookup.com doesn't send CORS headers so we
  // go through the backend proxy at /api/oui-lookup/<mac> which also caches.
  const fetchVendor = async () => {
    if (vendorLookup?.data) return; // already loaded
    setVendorLookup({ loading: true });
    try {
      const r = await fetch(`/api/oui-lookup/${encodeURIComponent(d.mac)}`);
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status}${txt ? `: ${txt.slice(0, 80)}` : ""}`);
      }
      const json = await r.json();
      const first = Array.isArray(json?.results) && json.results.length > 0 ? json.results[0] : null;
      if (!first) {
        setVendorLookup({ loading: false, error: "no result" });
      } else {
        setVendorLookup({ loading: false, data: first });
      }
    } catch (e) {
      setVendorLookup({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div
      className="
        absolute left-2 top-2 right-2 max-h-[calc(100vh-1rem)]
        sm:left-4 sm:top-4 sm:right-auto sm:w-80 sm:max-h-[calc(100vh-2rem)]
        flex flex-col bg-radar-panel/95 border border-radar-border rounded-lg shadow-2xl backdrop-blur z-20 overflow-hidden
      "
      style={drag.style}
    >
      <div
        {...drag.headerProps}
        className="flex items-center gap-2 px-3 py-2 border-b border-radar-border shrink-0 select-none"
        style={{ ...drag.headerProps.style, background: withAlpha(color, 0.1) }}
      >
        <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color, boxShadow: `0 0 8px ${color}` }} />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-zinc-100 truncate">{d.vendor}</div>
          <div className="text-[10px] text-zinc-400 font-mono">{d.mac}</div>
        </div>
        <button
          onClick={() => setSelected(null)}
          className="text-zinc-500 hover:text-zinc-200 text-lg leading-none px-1"
          aria-label="Close"
        >×</button>
      </div>

      <div className="flex gap-1 px-2 py-1.5 border-b border-radar-border bg-radar-bg/40 text-[10px] shrink-0">
        <button
          onClick={triggerFocus}
          className="flex-1 px-2 py-1 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent text-zinc-300 transition-colors"
          title="Camera flies to device"
        >
          🎯 Focus
        </button>
        <button
          onClick={() => setSoloMode(!soloMode)}
          className={`flex-1 px-2 py-1 rounded border transition-colors ${
            soloMode
              ? "border-radar-accent text-radar-accent bg-radar-accent/10"
              : "border-radar-border text-zinc-300 hover:border-radar-accent hover:text-radar-accent"
          }`}
          title="Dim other devices, filter CSI"
        >
          🔇 Solo {soloMode ? "ON" : "OFF"}
        </button>
        <button
          onClick={copyMac}
          className={`px-2 py-1 rounded border transition-colors ${
            copyState === "ok"
              ? "border-emerald-500 text-emerald-400 bg-emerald-500/10"
              : copyState === "err"
              ? "border-radar-danger text-radar-danger"
              : "border-radar-border text-zinc-300 hover:border-radar-accent hover:text-radar-accent"
          }`}
          title="Copy MAC to clipboard"
        >
          {copyState === "ok" ? "✓" : copyState === "err" ? "✗" : "📋"}
        </button>
        <button
          onClick={fetchVendor}
          disabled={vendorLookup?.loading}
          className={`px-2 py-1 rounded border transition-colors ${
            vendorLookup?.data
              ? "border-radar-accent text-radar-accent bg-radar-accent/10"
              : vendorLookup?.error
              ? "border-radar-danger text-radar-danger"
              : "border-radar-border text-zinc-300 hover:border-radar-accent hover:text-radar-accent"
          }`}
          title="Fetch vendor info from macvendorlookup.com (manual)"
        >
          {vendorLookup?.loading ? "…" : "🌐"}
        </button>
        <button
          onClick={() => setShowDebug(true)}
          className="px-2 py-1 rounded border border-radar-border hover:border-radar-accent hover:text-radar-accent text-zinc-300 transition-colors"
          title="Show trilateration math step-by-step"
        >
          🔍
        </button>
      </div>

      {vendorLookup && (vendorLookup.loading || vendorLookup.data || vendorLookup.error) && (
        <div className="px-3 py-2 border-b border-radar-border bg-radar-bg/40 text-[10px] shrink-0">
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="uppercase tracking-wider text-zinc-500 text-[9px]">
              🌐 macvendorlookup.com
            </span>
            <button
              onClick={() => setVendorLookup(null)}
              className="ml-auto text-zinc-500 hover:text-zinc-300"
              title="Clear"
            >
              ✕
            </button>
          </div>
          {vendorLookup.loading && <div className="text-zinc-400">Looking up…</div>}
          {vendorLookup.error && (
            <div className="text-radar-danger">
              {vendorLookup.error.includes("CORS") || vendorLookup.error.includes("NetworkError")
                ? "Network/CORS blocked — voir DevTools"
                : `Error: ${vendorLookup.error}`}
            </div>
          )}
          {vendorLookup.data && (
            <div className="space-y-0.5">
              <div className="text-zinc-100 font-semibold">
                {vendorLookup.data.company || "(unknown company)"}
              </div>
              {(vendorLookup.data.addressL1 || vendorLookup.data.addressL2 || vendorLookup.data.addressL3) && (
                <div className="text-zinc-400">
                  {[vendorLookup.data.addressL1, vendorLookup.data.addressL2, vendorLookup.data.addressL3]
                    .filter(Boolean)
                    .join(", ")}
                </div>
              )}
              {vendorLookup.data.countryName && (
                <div className="text-zinc-400">📍 {vendorLookup.data.countryName}</div>
              )}
              {vendorLookup.data.type && (
                <div className="text-zinc-500">type: {vendorLookup.data.type}</div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex-1 overflow-y-auto">
      <div className="px-3 py-2 grid grid-cols-2 gap-2 text-xs">
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">RSSI</span>
          <span className="font-semibold" style={{ color: quality.color }}>
            {d.last_rssi} dBm
          </span>
          <span className="text-[10px] text-zinc-400">{quality.label}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Packets</span>
          <span className="font-semibold text-zinc-100">{d.packets.toLocaleString()}</span>
          <span className="text-[10px] text-zinc-400">{totalKinds} typed</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">First seen</span>
          <span className="text-zinc-100">{age(d.first_seen)}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Last seen</span>
          <span className="text-zinc-100">{age(d.last_seen)}</span>
        </div>
        <div className="col-span-2 flex flex-col">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Active duration</span>
          <span className="text-zinc-100">{duration(d.first_seen, d.last_seen)}</span>
        </div>
      </div>

      {d.rssi_by_sensor && Object.keys(d.rssi_by_sensor).length > 0 && (
        <div className="px-3 pb-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">RSSI &amp; distance per sensor</div>
          <div className="flex flex-col gap-1">
            {Object.entries(d.rssi_by_sensor).sort(([a], [b]) => a.localeCompare(b)).map(([sid, rssi]) => {
              const q = rssiQuality(rssi);
              const pct = Math.max(0, Math.min(100, ((rssi + 95) / 70) * 100));
              const est = rssiToDistance(rssi);
              return (
                <div key={sid} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-radar-accent w-6">{sid}</span>
                  <div className="flex-1 h-1.5 bg-radar-bg rounded overflow-hidden">
                    <div style={{ width: `${pct}%`, background: q.color }} className="h-full" />
                  </div>
                  <span className="text-zinc-400 tabular-nums w-12 text-right">{rssi} dBm</span>
                  <span className="text-zinc-500 tabular-nums w-12 text-right">~{formatDistance(est)}</span>
                </div>
              );
            })}
          </div>
          {d.position_2d && (() => {
            const x = d.position_2d.x;
            const z = d.position_2d.z;
            const r = Math.hypot(x, z);
            const bearing = (Math.atan2(z, x) * 180 / Math.PI + 360) % 360;
            return (
              <div className="mt-2 px-2 py-1 bg-radar-accent/10 border border-radar-accent/40 rounded text-[10px] space-y-0.5">
                <div>
                  <span className="text-zinc-500">Trilateration position : </span>
                  <span className="text-radar-accent font-mono">
                    ⟨{x.toFixed(2)}, {z.toFixed(2)}⟩ m
                  </span>
                </div>
                <div className="text-zinc-400">
                  <span className="text-zinc-500">distance origine </span>
                  <span className="text-zinc-200 font-mono">{r.toFixed(2)} m</span>
                  <span className="text-zinc-500"> · bearing </span>
                  <span className="text-zinc-200 font-mono">{bearing.toFixed(0)}°</span>
                </div>
                <div className="text-zinc-400">
                  <span className="text-zinc-500">residual </span>
                  <span className="text-zinc-200 font-mono">{d.position_2d.residual_m.toFixed(2)} m</span>
                  <span className="text-zinc-500"> · confidence </span>
                  <span className="text-zinc-200 font-mono">{(d.position_2d.confidence * 100).toFixed(0)}%</span>
                </div>
                <div className="text-zinc-500">
                  sensors : <span className="text-zinc-300 font-mono">{d.position_2d.sensors_used.join(", ")}</span>
                </div>
              </div>
            );
          })()}
          {!d.position_2d && d.bilateration && (
            <div className="mt-2 px-2 py-1 bg-radar-bg border border-radar-border rounded text-[10px]">
              <span className="text-zinc-500">Bilateration (2 sensors): </span>
              <span className="text-radar-accent font-mono">
                Δ{d.bilateration.delta_rssi > 0 ? "+" : ""}{d.bilateration.delta_rssi.toFixed(1)} dB
              </span>
              <span className="text-zinc-500"> · pos </span>
              <span className="text-zinc-200 font-mono">
                ({d.bilateration.x.toFixed(1)}, {d.bilateration.z.toFixed(1)})
              </span>
              <span className="text-zinc-500"> · conf </span>
              <span className="text-zinc-200 font-mono">{(d.bilateration.confidence * 100).toFixed(0)}%</span>
            </div>
          )}
        </div>
      )}

      <div className="px-3 pb-2">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">RSSI history (last {history.length})</span>
          <span className="text-[10px] text-zinc-400 font-mono">
            min {min} · avg {avg.toFixed(1)} · max {max}
          </span>
        </div>
        <div className="bg-radar-bg border border-radar-border rounded">
          <RssiSparkline values={history} color={color} />
        </div>
      </div>

      {velocity && (
        <div className="px-3 pb-2">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Velocity (from position log)</div>
          <div className="flex items-center gap-2 px-2 py-1 bg-radar-bg border border-radar-border rounded text-xs">
            <span className="text-radar-warn font-mono tabular-nums text-base">
              {velocity.speed.toFixed(2)} m/s
            </span>
            <span className="text-zinc-500 text-[10px]">
              bearing <span className="text-zinc-300 font-mono">{velocity.bearing.toFixed(0)}°</span>
            </span>
            <span className="ml-auto text-[10px] text-zinc-500">{selectedPositions.length} pts</span>
          </div>
          {velocity.speed > 0.5 && (
            <div className="text-[9px] text-radar-warn mt-1">
              {velocity.speed > 1.5 ? "🏃 fast" : velocity.speed > 0.8 ? "🚶 walking" : "⤴ moving slowly"}
            </div>
          )}
        </div>
      )}

      <div className="px-3 pb-3">
        <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Frame types</div>
        <div className="flex flex-wrap gap-1">
          {Object.entries(d.kinds)
            .sort(([, a], [, b]) => b - a)
            .map(([k, n]) => {
              const pct = totalKinds > 0 ? (n / totalKinds) * 100 : 0;
              return (
                <div
                  key={k}
                  className="flex flex-col px-2 py-1 bg-radar-bg border border-radar-border rounded min-w-[64px]"
                >
                  <span className="text-[10px] text-zinc-400">{k}</span>
                  <span className="text-xs font-semibold text-zinc-100">
                    {n} <span className="text-[10px] text-zinc-500">({pct.toFixed(0)}%)</span>
                  </span>
                </div>
              );
            })}
        </div>
      </div>

      <div className="px-3 pb-3">
        <div className="flex items-baseline justify-between mb-1">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">Live feed</span>
          <span className="text-[10px] text-zinc-500 tabular-nums">
            {selectedPackets.length} pkts · {selectedCsi.length} CSI samples
          </span>
        </div>
        <div className="bg-radar-bg border border-radar-border rounded max-h-32 overflow-y-auto font-mono text-[10px]">
          {selectedPackets.length === 0 ? (
            <div className="px-2 py-2 text-zinc-500 text-center">listening…</div>
          ) : (
            [...selectedPackets].reverse().slice(0, 30).map((p, idx) => {
              const dt = Date.now() / 1000 - p.ts;
              return (
                <div key={selectedPackets.length - idx} className="flex items-center gap-2 px-2 py-0.5 border-b border-radar-border/40 last:border-0">
                  <span className="w-6 text-zinc-500 tabular-nums">{dt < 1 ? "now" : `${dt.toFixed(0)}s`}</span>
                  <span className="w-6 text-radar-accent">{p.sid}</span>
                  <span className="w-16 truncate" style={{ color: packetKindColor(p.k) }}>{p.k}</span>
                  <span className="w-12 text-right tabular-nums text-zinc-300">{p.rssi}</span>
                  <span className="w-8 text-right tabular-nums text-zinc-500">ch{p.ch}</span>
                  <span className="ml-auto text-zinc-500 tabular-nums">{p.len}B</span>
                </div>
              );
            })
          )}
        </div>
      </div>
      </div>
      {showDebug && <TrilaterationDebug onClose={() => setShowDebug(false)} />}
    </div>
  );
}
