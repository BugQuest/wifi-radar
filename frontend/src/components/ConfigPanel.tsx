import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";
import type { WifiConfig, ScannedAP } from "../lib/types";

const PRO = window.location.protocol === "https:" ? "https:" : "http:";
const API = `${PRO}//${window.location.host}/api`;

function signalColor(s: number): string {
  if (s >= 75) return "#34d399";
  if (s >= 50) return "#a3e635";
  if (s >= 30) return "#facc15";
  return "#fb923c";
}

function signalBars(s: number): string {
  // Unicode bar levels
  if (s >= 80) return "▰▰▰▰";
  if (s >= 60) return "▰▰▰▱";
  if (s >= 40) return "▰▰▱▱";
  if (s >= 20) return "▰▱▱▱";
  return "▱▱▱▱";
}

function channelFromFreq(mhz: number): number {
  if (mhz < 2412) return 0;
  if (mhz === 2484) return 14;
  return Math.round((mhz - 2407) / 5);
}

export function ConfigPanel() {
  const visible = useStore((s) => s.panels.config);
  const togglePanel = useStore((s) => s.togglePanel);
  const drag = useDraggable();

  const sensors = useStore((s) => s.sensors);

  const [configs, setConfigs] = useState<WifiConfig[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [aps, setAps] = useState<ScannedAP[]>([]);
  const [scanning, setScanning] = useState(false);
  const [showApPicker, setShowApPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [applying, setApplying] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const [applyAt, setApplyAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [notes, setNotes] = useState("");
  const [showPw, setShowPw] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${API}/configs`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setConfigs(data.configs ?? []);
      setActiveName(data.active_name ?? null);
      setError(null);
    } catch (e) {
      setError(`load failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const scan = async () => {
    setScanning(true);
    setError(null);
    setShowApPicker(true);
    try {
      const r = await fetch(`${API}/aps`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setAps(data.aps ?? []);
    } catch (e) {
      setError(`scan failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setScanning(false);
    }
  };

  const save = async () => {
    if (!name.trim() || !ssid.trim()) {
      setError("name and SSID are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const r = await fetch(`${API}/configs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ssid, password, notes }),
      });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`HTTP ${r.status}: ${txt}`);
      }
      setName("");
      setSsid("");
      setPassword("");
      setNotes("");
      await refresh();
    } catch (e) {
      setError(`save failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const del = async (cfgName: string) => {
    if (!window.confirm(`Delete config "${cfgName}" ?`)) return;
    try {
      const r = await fetch(`${API}/configs/${encodeURIComponent(cfgName)}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (e) {
      setError(`delete failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const activate = async (cfgName: string) => {
    try {
      const r = await fetch(`${API}/configs/${encodeURIComponent(cfgName)}/activate`, { method: "POST" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await refresh();
    } catch (e) {
      setError(`activate failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const apply = async (cfgName: string) => {
    setApplying(cfgName);
    setApplyResult(null);
    setError(null);
    try {
      const r = await fetch(`${API}/configs/${encodeURIComponent(cfgName)}/apply`, { method: "POST" });
      if (!r.ok) {
        const txt = await r.text();
        throw new Error(`HTTP ${r.status}: ${txt}`);
      }
      const data = await r.json();
      setApplyResult(`Pushed to ${data.count}/${data.known_devices?.length ?? 0} ESPs. Reboot in ~1s.`);
      setApplyAt(Date.now());
      await refresh();
    } catch (e) {
      setError(`apply failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplying(null);
    }
  };

  const useAp = (ap: ScannedAP) => {
    setSsid(ap.ssid);
    if (!name.trim()) setName(ap.ssid);
    setShowApPicker(false);
  };

  const loadFromConfig = (cfg: WifiConfig) => {
    setName(cfg.name);
    setSsid(cfg.ssid);
    setPassword(cfg.password);
    setNotes(cfg.notes ?? "");
  };

  if (!visible) return null;

  return (
    <div
      className="absolute left-4 bottom-4 w-96 max-h-[calc(100vh-2rem)] flex flex-col bg-radar-panel/95 border border-radar-border rounded-lg shadow-2xl backdrop-blur z-20 overflow-hidden"
      style={drag.style}
    >
      <div
        {...drag.headerProps}
        className="flex items-center gap-2 px-3 py-2 border-b border-radar-border shrink-0 select-none bg-radar-bg/60"
      >
        <span className="text-sm font-semibold text-zinc-100">⚙️ WiFi configuration</span>
        <span className="ml-auto text-[10px] text-zinc-500">{configs.length} saved</span>
        <button onClick={() => togglePanel("config")} className="text-zinc-500 hover:text-zinc-200 text-lg leading-none px-1" title="Close">×</button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
        {error && (
          <div className="px-2 py-1 bg-radar-danger/10 border border-radar-danger/40 rounded text-radar-danger">
            {error}
          </div>
        )}
        {applyResult && (
          <div className="px-2 py-2 bg-emerald-500/10 border border-emerald-500/40 rounded text-emerald-300 space-y-1">
            <div>✓ {applyResult}</div>
            {applyAt && (
              <div className="text-[10px] text-zinc-300 space-y-0.5 mt-1">
                <div className="text-zinc-500 uppercase tracking-wider">Sensor reconnect status</div>
                {[...sensors.values()].sort((a, b) => a.id.localeCompare(b.id)).map((s) => {
                  const since = (Date.now() - applyAt) / 1000;
                  const justRebooted = since < 8;
                  return (
                    <div key={s.id} className="flex items-center gap-2 font-mono">
                      <span className="text-radar-accent w-6">{s.id}</span>
                      <span className={s.connected ? "text-emerald-400" : justRebooted ? "text-radar-warn" : "text-radar-danger"}>
                        {s.connected
                          ? `✓ associated to ${s.ap_rssi != 0 ? `${s.ap_rssi} dBm` : "AP"} on ch.${s.channel}`
                          : justRebooted
                          ? `… rebooting (${since.toFixed(0)}s)`
                          : "✗ still not associated"}
                      </span>
                    </div>
                  );
                })}
                {sensors.size === 0 && (
                  <div className="text-zinc-500">(no sensors yet — wait for first heartbeat)</div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Saved configs */}
        <section>
          <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Saved configurations</h3>
          {configs.length === 0 ? (
            <div className="px-2 py-3 text-zinc-500 text-center bg-radar-bg/40 border border-radar-border rounded">
              No saved config yet. Use the form below to add one.
            </div>
          ) : (
            <div className="space-y-1">
              {configs.map((c) => {
                const isActive = activeName === c.name;
                return (
                  <div
                    key={c.name}
                    className={`px-2 py-2 rounded border ${isActive ? "border-radar-accent bg-radar-accent/10" : "border-radar-border bg-radar-bg/40"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${isActive ? "bg-radar-accent shadow-[0_0_6px_#22d3ee]" : "bg-zinc-600"}`} />
                      <span className="font-semibold text-zinc-100">{c.name}</span>
                      {isActive && <span className="text-[9px] text-radar-accent uppercase ml-1">active</span>}
                      <span className="ml-auto text-[10px] text-zinc-400 font-mono">{c.ssid}</span>
                    </div>
                    {c.notes && <div className="text-[10px] text-zinc-500 mt-1">{c.notes}</div>}
                    <div className="flex gap-1 mt-1.5">
                      <button
                        onClick={() => apply(c.name)}
                        disabled={applying === c.name}
                        className="flex-1 px-2 py-1 rounded border border-radar-warn text-radar-warn bg-radar-warn/10 hover:bg-radar-warn/20 transition-colors text-[10px] font-semibold disabled:opacity-50"
                        title="Push to all connected ESP32s (they reboot)"
                      >
                        {applying === c.name ? "applying…" : "🚀 Apply"}
                      </button>
                      {!isActive && (
                        <button
                          onClick={() => activate(c.name)}
                          className="px-2 py-1 rounded border border-radar-accent text-radar-accent hover:bg-radar-accent/10 transition-colors text-[10px]"
                          title="Mark active without pushing"
                        >
                          ✓
                        </button>
                      )}
                      <button
                        onClick={() => loadFromConfig(c)}
                        className="px-2 py-1 rounded border border-radar-border text-zinc-300 hover:border-radar-accent hover:text-radar-accent transition-colors text-[10px]"
                        title="Load into form"
                      >
                        ✎
                      </button>
                      <button
                        onClick={() => del(c.name)}
                        className="px-2 py-1 rounded border border-radar-border text-zinc-500 hover:border-radar-danger hover:text-radar-danger transition-colors text-[10px]"
                      >
                        🗑
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Add / edit form */}
        <section>
          <h3 className="text-[10px] uppercase tracking-wider text-zinc-500 mb-2">Add / edit configuration</h3>
          <div className="space-y-2">
            <div>
              <label className="block text-[10px] text-zinc-500 mb-0.5">Name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Home WiFi"
                className="w-full bg-radar-bg border border-radar-border rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-radar-accent"
              />
            </div>
            <div>
              <div className="flex items-center mb-0.5">
                <label className="text-[10px] text-zinc-500">SSID</label>
                <button
                  onClick={scan}
                  disabled={scanning}
                  className="ml-auto text-[10px] px-2 py-0.5 rounded border border-radar-border text-zinc-300 hover:border-radar-accent hover:text-radar-accent transition-colors disabled:opacity-50"
                >
                  {scanning ? "scanning…" : aps.length > 0 ? `🔍 ${aps.length} APs` : "🔍 scan APs"}
                </button>
              </div>
              <input
                value={ssid}
                onChange={(e) => setSsid(e.target.value)}
                placeholder="WiFi network name"
                className="w-full bg-radar-bg border border-radar-border rounded px-2 py-1 text-xs text-zinc-100 font-mono focus:outline-none focus:border-radar-accent"
              />
            </div>
            <div>
              <div className="flex items-center mb-0.5">
                <label className="text-[10px] text-zinc-500">Password</label>
                <button
                  onClick={() => setShowPw((v) => !v)}
                  className="ml-auto text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  {showPw ? "hide" : "show"}
                </button>
              </div>
              <input
                type={showPw ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="WPA2 password (empty for open)"
                className="w-full bg-radar-bg border border-radar-border rounded px-2 py-1 text-xs text-zinc-100 font-mono focus:outline-none focus:border-radar-accent"
              />
            </div>
            <div>
              <label className="block text-[10px] text-zinc-500 mb-0.5">Notes (optional)</label>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="e.g. used for outdoor tests"
                className="w-full bg-radar-bg border border-radar-border rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:border-radar-accent"
              />
            </div>
            <button
              onClick={save}
              disabled={saving || !name.trim() || !ssid.trim()}
              className="w-full px-3 py-1.5 rounded border border-radar-accent text-radar-accent bg-radar-accent/10 hover:bg-radar-accent/20 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-xs font-semibold"
            >
              {saving ? "saving…" : "💾 Save configuration"}
            </button>
          </div>
        </section>

        <section className="text-[10px] text-zinc-500 border-t border-radar-border pt-2 space-y-1">
          <p><span className="text-radar-warn">🚀 Apply</span> : pousse la config aux ESP32 par UART, sauve en NVS, reboot &amp; reconnect (~3-5 s).</p>
          <p><span className="text-radar-accent">✓ Activate</span> : marque actif côté Pi sans pousser aux ESP.</p>
          <p><span className="text-zinc-400">✎ Edit</span> : pré-remplit le formulaire.</p>
        </section>
      </div>

      {showApPicker && (
        <div className="fixed inset-0 bg-black/60 z-30 flex items-center justify-center p-4" onClick={() => setShowApPicker(false)}>
          <div
            className="bg-radar-panel border border-radar-border rounded-lg shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 px-4 py-2 border-b border-radar-border bg-radar-accent/10 shrink-0">
              <span className="text-radar-accent">🔍</span>
              <div className="flex-1">
                <div className="text-sm font-semibold text-zinc-100">Available access points</div>
                <div className="text-[10px] text-zinc-400">{aps.length} AP(s) on 2.4 GHz · click to select</div>
              </div>
              <button
                onClick={scan}
                disabled={scanning}
                className="text-[10px] px-2 py-1 rounded border border-radar-border text-zinc-300 hover:border-radar-accent hover:text-radar-accent disabled:opacity-50"
                title="Rescan"
              >
                {scanning ? "…" : "↻ rescan"}
              </button>
              <button onClick={() => setShowApPicker(false)} className="text-zinc-500 hover:text-zinc-200 text-xl leading-none px-2">×</button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {scanning && aps.length === 0 ? (
                <div className="px-4 py-8 text-zinc-500 text-center text-xs">scanning… (≈3-5 s)</div>
              ) : aps.length === 0 ? (
                <div className="px-4 py-8 text-zinc-500 text-center text-xs">No APs found. Make sure wlan0 isn't busy in AP mode.</div>
              ) : (
                aps.map((ap) => {
                  const ch = channelFromFreq(ap.freq_mhz);
                  const secured = (ap.security || "").trim() !== "" && ap.security !== "--";
                  return (
                    <button
                      key={`${ap.ssid}-${ap.freq_mhz}`}
                      onClick={() => useAp(ap)}
                      className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-radar-bg/60 border-b border-radar-border/40 last:border-0 transition-colors"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-mono text-zinc-100 truncate">
                          {ap.ssid || <span className="text-zinc-500">&lt;hidden&gt;</span>}
                        </div>
                        <div className="text-[10px] text-zinc-500 flex items-center gap-2 mt-0.5">
                          <span>ch{ch || "?"} · {ap.freq_mhz} MHz</span>
                          <span>·</span>
                          <span className={secured ? "text-radar-accent" : "text-radar-warn"}>
                            {secured ? `🔒 ${ap.security}` : "📡 open"}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-0.5">
                        <span className="font-mono text-sm tabular-nums" style={{ color: signalColor(ap.signal) }}>
                          {signalBars(ap.signal)}
                        </span>
                        <span className="text-[10px] text-zinc-400 font-mono tabular-nums">{ap.signal}%</span>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
