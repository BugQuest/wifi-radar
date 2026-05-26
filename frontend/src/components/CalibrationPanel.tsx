import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";

interface DataPoint {
  distance_m: number;
  mean_rssi: number;
  std_rssi: number;
  count: number;
  sensor: string;
  mac: string;
}

interface FitResult {
  rssi_0: number;
  n: number;
  r2: number;
}

// Linear regression on (x_i = log10(d_i), y_i = mean_rssi_i) for the model
// RSSI = RSSI_0 - 10*n*log10(d). Returns RSSI_0 = intercept, n = -slope / 10.
function fitPathLoss(points: DataPoint[]): FitResult | null {
  if (points.length < 2) return null;
  const N = points.length;
  const xs = points.map((p) => Math.log10(Math.max(0.05, p.distance_m)));
  const ys = points.map((p) => p.mean_rssi);
  const meanX = xs.reduce((a, b) => a + b, 0) / N;
  const meanY = ys.reduce((a, b) => a + b, 0) / N;
  let num = 0, den = 0;
  for (let i = 0; i < N; i++) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  if (Math.abs(den) < 1e-9) return null;
  const slope = num / den;
  const intercept = meanY - slope * meanX;
  // R² = 1 - SS_res / SS_tot
  let ss_res = 0, ss_tot = 0;
  for (let i = 0; i < N; i++) {
    const pred = intercept + slope * xs[i];
    ss_res += (ys[i] - pred) ** 2;
    ss_tot += (ys[i] - meanY) ** 2;
  }
  const r2 = ss_tot > 1e-9 ? 1 - ss_res / ss_tot : 1;
  return { rssi_0: intercept, n: -slope / 10, r2 };
}

function stats(values: number[]): { mean: number; std: number } {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

export function CalibrationPanel() {
  const visible = useStore((s) => s.panels.calibration);
  const togglePanel = useStore((s) => s.togglePanel);
  const sensors = useStore((s) => s.sensors);
  const devices = useStore((s) => s.devices);
  const capture = useStore((s) => s.pathLossCapture);
  const start = useStore((s) => s.startPathLossCapture);
  const stop = useStore((s) => s.stopPathLossCapture);
  const drag = useDraggable();

  const [sensor, setSensor] = useState("");
  const [mac, setMac] = useState("");
  const [distance, setDistance] = useState("1.0");
  const [duration, setDuration] = useState("5");
  const [points, setPoints] = useState<DataPoint[]>([]);
  const [serverPathLoss, setServerPathLoss] = useState<{ rssi_0: number; n: number } | null>(null);
  const [applyMsg, setApplyMsg] = useState<string | null>(null);

  const sensorIds = useMemo(() => [...sensors.keys()].sort(), [sensors]);
  const sortedDevices = useMemo(
    () =>
      [...devices.values()]
        .filter((d) => Date.now() / 1000 - d.last_seen < 30)
        .sort((a, b) => b.last_rssi - a.last_rssi)
        .slice(0, 50),
    [devices]
  );

  useEffect(() => {
    if (!visible) return;
    fetch("/api/path-loss")
      .then((r) => r.json())
      .then((d) => setServerPathLoss(d))
      .catch(() => {});
  }, [visible, applyMsg]);

  useEffect(() => {
    if (sensorIds.length > 0 && !sensor) setSensor(sensorIds[0]);
  }, [sensorIds, sensor]);

  // Auto-finalize a capture once its t_end has passed, push to points.
  useEffect(() => {
    if (!capture) return;
    const now = Date.now() / 1000;
    if (now < capture.t_end) {
      const id = setTimeout(() => {
        // re-trigger the effect at t_end
        const c = useStore.getState().pathLossCapture;
        if (!c) return;
        if (Date.now() / 1000 >= c.t_end) {
          const s = stats(c.samples);
          if (c.samples.length >= 3) {
            setPoints((prev) => [
              ...prev,
              {
                distance_m: c.distance_m,
                mean_rssi: s.mean,
                std_rssi: s.std,
                count: c.samples.length,
                sensor: c.sensor,
                mac: c.mac,
              },
            ]);
          }
          stop();
        }
      }, (capture.t_end - now) * 1000 + 100);
      return () => clearTimeout(id);
    }
  }, [capture, stop]);

  if (!visible) return null;

  const fit = fitPathLoss(points);
  const captureProgress = capture
    ? Math.min(100, ((Date.now() / 1000 - capture.t_start) / (capture.t_end - capture.t_start)) * 100)
    : 0;

  const beginSample = () => {
    const d = parseFloat(distance);
    const dur = parseFloat(duration);
    if (!sensor || !mac || !(d > 0) || !(dur > 0)) return;
    start(sensor, mac, d, dur);
  };

  const applyFit = async () => {
    if (!fit) return;
    setApplyMsg(null);
    try {
      const r = await fetch("/api/path-loss", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rssi_0: fit.rssi_0, n: fit.n }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setApplyMsg(`✓ Applied: RSSI_0 = ${data.rssi_0.toFixed(2)} dBm, n = ${data.n.toFixed(3)}`);
    } catch (e) {
      setApplyMsg(`✗ ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const resetPoints = () => {
    if (window.confirm("Clear all measured points?")) setPoints([]);
  };

  return (
    <div
      className="
        absolute left-2 right-2 top-2 max-h-[calc(100vh-1rem)]
        sm:left-1/2 sm:right-auto sm:top-16 sm:-translate-x-1/2 sm:w-[28rem] sm:max-h-[calc(100vh-5rem)]
        flex flex-col bg-radar-panel/95 border border-radar-border rounded-lg shadow-2xl backdrop-blur z-20 overflow-hidden
      "
      style={drag.style}
    >
      <div
        {...drag.headerProps}
        className="flex items-center gap-2 px-3 py-2 border-b border-radar-border shrink-0 select-none bg-radar-bg/60"
      >
        <span className="text-sm font-semibold text-zinc-100">📏 Path-loss calibration</span>
        <span className="ml-auto text-[10px] text-zinc-500">{points.length} pts</span>
        <button onClick={() => togglePanel("calibration")} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none px-1" title="Close">×</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3 text-xs">
        {serverPathLoss && (
          <div className="px-2 py-1 bg-radar-bg border border-radar-border rounded text-[11px]">
            <span className="text-zinc-500">Current calibration: </span>
            <span className="text-zinc-200 font-mono">
              RSSI_0 = {serverPathLoss.rssi_0.toFixed(2)} dBm · n = {serverPathLoss.n.toFixed(3)}
            </span>
          </div>
        )}

        <section className="space-y-2">
          <h3 className="text-[10px] uppercase tracking-wider text-zinc-500">1. Measure a point</h3>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">sensor</span>
              <select
                value={sensor}
                onChange={(e) => setSensor(e.target.value)}
                className="bg-radar-bg border border-radar-border rounded px-2 py-1 text-zinc-100 focus:outline-none focus:border-radar-accent"
              >
                {sensorIds.length === 0 && <option value="">(no sensors)</option>}
                {sensorIds.map((sid) => (
                  <option key={sid} value={sid}>{sid}</option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">target MAC (top by RSSI)</span>
              <select
                value={mac}
                onChange={(e) => setMac(e.target.value)}
                className="bg-radar-bg border border-radar-border rounded px-2 py-1 text-zinc-100 font-mono focus:outline-none focus:border-radar-accent"
              >
                <option value="">(pick a device)</option>
                {sortedDevices.map((d) => (
                  <option key={d.mac} value={d.mac}>
                    {d.last_rssi} dBm · {d.mac} · {d.vendor.slice(0, 14)}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">distance (m)</span>
              <input
                type="number"
                step="0.1"
                min="0.1"
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
                className="bg-radar-bg border border-radar-border rounded px-2 py-1 text-zinc-100 font-mono focus:outline-none focus:border-radar-accent"
              />
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[10px] text-zinc-500">duration (s)</span>
              <input
                type="number"
                step="1"
                min="2"
                max="60"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="bg-radar-bg border border-radar-border rounded px-2 py-1 text-zinc-100 font-mono focus:outline-none focus:border-radar-accent"
              />
            </label>
          </div>

          {capture ? (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="flex-1 h-1.5 bg-radar-bg rounded overflow-hidden">
                  <div className="h-full bg-radar-warn transition-all" style={{ width: `${captureProgress}%` }} />
                </div>
                <span className="text-[10px] text-radar-warn tabular-nums">
                  {capture.samples.length} samples
                </span>
                <button
                  onClick={stop}
                  className="px-2 py-0.5 text-[10px] rounded border border-radar-danger text-radar-danger hover:bg-radar-danger/10"
                >
                  abort
                </button>
              </div>
              <div className="text-[10px] text-zinc-500">
                capturing on {capture.sensor} for {capture.mac} @ {capture.distance_m}m…
              </div>
            </div>
          ) : (
            <button
              onClick={beginSample}
              disabled={!sensor || !mac || !(parseFloat(distance) > 0)}
              className="w-full px-3 py-1.5 rounded border border-radar-accent text-radar-accent bg-radar-accent/10 hover:bg-radar-accent/20 disabled:opacity-40 disabled:cursor-not-allowed text-xs font-semibold"
            >
              📡 Sample {duration}s
            </button>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center">
            <h3 className="text-[10px] uppercase tracking-wider text-zinc-500">2. Measured points</h3>
            {points.length > 0 && (
              <button
                onClick={resetPoints}
                className="ml-auto text-[10px] text-zinc-500 hover:text-radar-danger"
              >
                clear all
              </button>
            )}
          </div>
          {points.length === 0 ? (
            <div className="px-2 py-3 text-center text-zinc-500 bg-radar-bg/40 border border-radar-border rounded text-[11px]">
              Add ≥ 3 measurements at different distances.
            </div>
          ) : (
            <div className="bg-radar-bg border border-radar-border rounded font-mono">
              <table className="w-full text-[10px]">
                <thead className="text-zinc-500 border-b border-radar-border">
                  <tr>
                    <th className="px-2 py-1 text-left">sensor</th>
                    <th className="px-2 py-1 text-left">MAC</th>
                    <th className="px-2 py-1 text-right">d (m)</th>
                    <th className="px-2 py-1 text-right">RSSI</th>
                    <th className="px-2 py-1 text-right">σ</th>
                    <th className="px-2 py-1 text-right">N</th>
                    <th className="px-2 py-1"></th>
                  </tr>
                </thead>
                <tbody>
                  {points.map((p, i) => (
                    <tr key={i} className="border-b border-radar-border/40">
                      <td className="px-2 py-1 text-radar-accent">{p.sensor}</td>
                      <td className="px-2 py-1 text-zinc-400 truncate max-w-[6rem]">{p.mac.slice(-8)}</td>
                      <td className="px-2 py-1 text-right text-zinc-200 tabular-nums">{p.distance_m.toFixed(2)}</td>
                      <td className="px-2 py-1 text-right text-zinc-200 tabular-nums">{p.mean_rssi.toFixed(1)}</td>
                      <td className="px-2 py-1 text-right text-zinc-500 tabular-nums">{p.std_rssi.toFixed(1)}</td>
                      <td className="px-2 py-1 text-right text-zinc-500 tabular-nums">{p.count}</td>
                      <td className="px-2 py-1 text-right">
                        <button
                          onClick={() => setPoints((prev) => prev.filter((_, j) => j !== i))}
                          className="text-zinc-500 hover:text-radar-danger"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {fit && (
          <section className="space-y-2">
            <h3 className="text-[10px] uppercase tracking-wider text-zinc-500">3. Fit + apply</h3>
            <div className="px-3 py-2 bg-radar-accent/10 border border-radar-accent/40 rounded font-mono text-[11px] space-y-0.5">
              <div>
                <span className="text-zinc-500">RSSI_0 = </span>
                <span className="text-radar-accent">{fit.rssi_0.toFixed(2)} dBm</span>
                <span className="text-zinc-500"> (at 1 m)</span>
              </div>
              <div>
                <span className="text-zinc-500">n = </span>
                <span className="text-radar-accent">{fit.n.toFixed(3)}</span>
                <span className="text-zinc-500"> (path-loss exponent)</span>
              </div>
              <div>
                <span className="text-zinc-500">R² = </span>
                <span className={fit.r2 > 0.9 ? "text-emerald-400" : fit.r2 > 0.7 ? "text-radar-warn" : "text-radar-danger"}>
                  {fit.r2.toFixed(3)}
                </span>
                <span className="text-zinc-500"> ({fit.r2 > 0.9 ? "excellent" : fit.r2 > 0.7 ? "fair" : "poor — add more pts"})</span>
              </div>
            </div>
            <button
              onClick={applyFit}
              className="w-full px-3 py-1.5 rounded border border-radar-warn text-radar-warn bg-radar-warn/10 hover:bg-radar-warn/20 text-xs font-semibold"
            >
              🚀 Apply to backend trilateration
            </button>
            {applyMsg && (
              <div className={`px-2 py-1 rounded text-[10px] ${applyMsg.startsWith("✓") ? "bg-emerald-500/10 text-emerald-300 border border-emerald-500/40" : "bg-radar-danger/10 text-radar-danger border border-radar-danger/40"}`}>
                {applyMsg}
              </div>
            )}
          </section>
        )}

        <section className="text-[10px] text-zinc-500 border-t border-radar-border pt-2 space-y-1">
          <p>
            <span className="text-zinc-300 font-semibold">Workflow :</span> place un device émetteur stable (téléphone hotspot) à
            distance connue d'UN capteur, mesure pendant 5-10 s, ajoute le point. Recommence à
            ≥ 3 distances différentes (ex. 1 m, 3 m, 5 m). Le fit donne RSSI_0 et n
            spécifiques à ton environnement.
          </p>
          <p>R² &gt; 0.9 = bon fit. R² faible = bruit RF élevé ou device qui bouge.</p>
        </section>
      </div>
    </div>
  );
}
