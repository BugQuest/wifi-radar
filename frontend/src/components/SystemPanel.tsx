import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";

function tempColor(t: number | null): string {
  if (t == null) return "#71717a";
  if (t < 50) return "#34d399";
  if (t < 65) return "#a3e635";
  if (t < 75) return "#facc15";
  if (t < 82) return "#fb923c";
  return "#f87171";
}

function cpuColor(p: number): string {
  if (p < 30) return "#34d399";
  if (p < 60) return "#a3e635";
  if (p < 85) return "#facc15";
  return "#f87171";
}

function memColor(p: number): string {
  if (p < 60) return "#34d399";
  if (p < 80) return "#facc15";
  return "#f87171";
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function Bar({ pct, color }: { pct: number; color: string }) {
  return (
    <div className="flex-1 h-1.5 bg-radar-bg rounded overflow-hidden">
      <div className="h-full transition-all duration-500 ease-out" style={{ width: `${Math.min(100, pct)}%`, background: color }} />
    </div>
  );
}

export function SystemPanel() {
  const system = useStore((s) => s.system);
  const visible = useStore((s) => s.panels.system);
  const togglePanel = useStore((s) => s.togglePanel);
  const drag = useDraggable();

  if (!visible) return null;

  if (!system) {
    return (
      <div className="absolute right-3 bottom-3 px-3 py-2 bg-radar-panel/95 border border-radar-border rounded text-[10px] text-zinc-500 z-20" style={drag.style}>
        <div {...drag.headerProps} className="flex items-center gap-2 select-none">
          <span>💻 system: no data</span>
          <button onClick={() => togglePanel("system")} className="ml-auto text-zinc-500 hover:text-zinc-200 px-1" title="Close">×</button>
        </div>
      </div>
    );
  }

  const cpuC = cpuColor(system.cpu_percent);
  const memC = memColor(system.mem_used_pct);
  const tempC = tempColor(system.temperature_c);
  const memUsedGB = (system.mem_total_kb - system.mem_available_kb) / (1024 * 1024);
  const memTotalGB = system.mem_total_kb / (1024 * 1024);
  const loadPct = system.cpu_count > 0 ? (system.load_avg[0] / system.cpu_count) * 100 : 0;

  return (
    <div
      className="absolute right-3 bottom-3 w-72 bg-radar-panel/95 border border-radar-border rounded font-mono text-[10px] z-20"
      style={drag.style}
    >
      <div {...drag.headerProps} className="flex items-center gap-2 px-3 py-1.5 border-b border-radar-border select-none">
        <span className="text-zinc-300 uppercase tracking-wider">💻 Pi system</span>
        <span className="ml-auto text-zinc-500">up {fmtUptime(system.uptime_s)}</span>
        <button onClick={() => togglePanel("system")} className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1" title="Close">×</button>
      </div>

      <div className="p-3 space-y-2">
        <div className="flex items-center gap-2">
          <span className="w-12 text-zinc-500">CPU</span>
          <Bar pct={system.cpu_percent} color={cpuC} />
          <span className="w-12 text-right tabular-nums" style={{ color: cpuC }}>{system.cpu_percent.toFixed(0)}%</span>
        </div>
        {system.cpu_per_core.length > 0 && (
          <div className="flex items-center gap-1 pl-14">
            {system.cpu_per_core.map((p, i) => (
              <div
                key={i}
                className="flex-1 h-1 rounded"
                style={{ background: cpuColor(p), opacity: 0.6 }}
                title={`core ${i}: ${p.toFixed(0)}%`}
              />
            ))}
          </div>
        )}

        <div className="flex items-center gap-2">
          <span className="w-12 text-zinc-500">temp</span>
          <Bar pct={system.temperature_c != null ? Math.min(100, (system.temperature_c / 90) * 100) : 0} color={tempC} />
          <span className="w-12 text-right tabular-nums" style={{ color: tempC }}>
            {system.temperature_c != null ? `${system.temperature_c.toFixed(1)}°C` : "—"}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <span className="w-12 text-zinc-500">RAM</span>
          <Bar pct={system.mem_used_pct} color={memC} />
          <span className="w-12 text-right tabular-nums" style={{ color: memC }}>{system.mem_used_pct.toFixed(0)}%</span>
        </div>
        <div className="pl-14 text-zinc-500 tabular-nums">
          {memUsedGB.toFixed(2)} / {memTotalGB.toFixed(2)} GB
        </div>

        <div className="flex items-center gap-2">
          <span className="w-12 text-zinc-500">load</span>
          <Bar pct={Math.min(100, loadPct)} color={cpuColor(loadPct)} />
          <span className="w-20 text-right tabular-nums text-zinc-300">
            {system.load_avg[0].toFixed(2)} {system.load_avg[1].toFixed(2)} {system.load_avg[2].toFixed(2)}
          </span>
        </div>
        <div className="pl-14 text-[9px] text-zinc-500">
          load avg 1m / 5m / 15m · {system.cpu_count} cores
        </div>

        {system.disk_total_gb > 0 && (
          <>
            <div className="flex items-center gap-2">
              <span className="w-12 text-zinc-500">disk /</span>
              <Bar pct={system.disk_pct} color={memColor(system.disk_pct)} />
              <span className="w-12 text-right tabular-nums" style={{ color: memColor(system.disk_pct) }}>{system.disk_pct.toFixed(0)}%</span>
            </div>
            <div className="pl-14 text-zinc-500 tabular-nums">
              {system.disk_used_gb.toFixed(1)} / {system.disk_total_gb.toFixed(1)} GB
            </div>
          </>
        )}

        {system.throttled_flags.length > 0 && (
          <div className="mt-2 px-2 py-1 bg-radar-danger/10 border border-radar-danger/40 rounded">
            <div className="text-radar-danger uppercase tracking-wider text-[9px] mb-0.5">⚠ throttling detected</div>
            {system.throttled_flags.map((f) => (
              <div key={f} className="text-radar-danger">{f}</div>
            ))}
          </div>
        )}
        {system.throttled_raw === 0 && (
          <div className="text-[9px] text-emerald-500 tabular-nums">throttle status: 0x0 (clean)</div>
        )}
      </div>
    </div>
  );
}
