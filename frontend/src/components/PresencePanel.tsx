import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";

function intensityColor(i: number): string {
  if (i < 0.05) return "#52525b";
  if (i < 0.3) return "#22d3ee";
  if (i < 0.7) return "#facc15";
  return "#f59e0b";
}

export function PresencePanel() {
  const presence = useStore((s) => s.presence);
  const sensors = useStore((s) => s.sensors);
  const visible = useStore((s) => s.panels.presence);
  const togglePanel = useStore((s) => s.togglePanel);
  const drag = useDraggable();
  if (!visible) return null;
  if (!presence) {
    return (
      <div className="absolute left-3 bottom-3 px-3 py-2 bg-radar-panel/90 border border-radar-border rounded text-[10px] text-zinc-500 z-20" style={drag.style}>
        <div {...drag.headerProps} className="flex items-center gap-2 select-none">
          <span>👤 presence: no data</span>
          <button onClick={() => togglePanel("presence")} className="ml-auto text-zinc-500 hover:text-zinc-200 px-1" title="Close">×</button>
        </div>
      </div>
    );
  }
  const sids = [...sensors.keys()].sort();
  const intensityPct = (presence.intensity * 100).toFixed(0);
  const corrLabel =
    presence.correlation > 0.5
      ? "agreed"
      : presence.correlation > 0.2
      ? "weak"
      : "noise";
  return (
    <div className="absolute left-2 right-2 bottom-2 sm:left-3 sm:right-auto sm:bottom-3 sm:w-64 px-3 py-2 bg-radar-panel/90 border border-radar-border rounded font-mono z-20" style={drag.style}>
      <div {...drag.headerProps} className="flex items-center gap-2 mb-1 select-none">
        <span
          className="w-2 h-2 rounded-full"
          style={{ background: intensityColor(presence.intensity) }}
        />
        <span className="text-[11px] uppercase tracking-wider text-zinc-300">👤 presence</span>
        <span className="ml-auto text-[10px] text-zinc-500">
          {presence.position
            ? `(${presence.position.x.toFixed(1)}, ${presence.position.z.toFixed(1)}) m`
            : "no signal"}
        </span>
        <button onClick={() => togglePanel("presence")} className="text-zinc-500 hover:text-zinc-200 px-1" title="Close">×</button>
      </div>
      <div className="flex items-center gap-2 text-[10px] mb-1">
        <span className="text-zinc-500 w-14">intensity</span>
        <div className="flex-1 h-1 bg-radar-bg rounded overflow-hidden">
          <div
            className="h-full transition-all duration-300"
            style={{ width: `${intensityPct}%`, background: intensityColor(presence.intensity) }}
          />
        </div>
        <span className="text-zinc-300 w-8 text-right">{intensityPct}%</span>
      </div>
      <div className="flex items-center gap-2 text-[10px] mb-2">
        <span className="text-zinc-500 w-14">cross-ρ</span>
        <div className="flex-1 h-1 bg-radar-bg rounded overflow-hidden">
          <div
            className="h-full bg-radar-accent transition-all duration-300"
            style={{ width: `${Math.max(0, presence.correlation) * 100}%` }}
          />
        </div>
        <span className="text-zinc-300 w-12 text-right">{corrLabel}</span>
      </div>
      <div className="text-[10px] text-zinc-500 mb-1">activity / sensor</div>
      {sids.map((sid) => {
        const a = presence.sensor_activity[sid] ?? 0;
        const pct = Math.min(100, (a / 500) * 100);
        return (
          <div key={sid} className="flex items-center gap-2 text-[10px]">
            <span className="text-radar-accent w-6">{sid}</span>
            <div className="flex-1 h-1 bg-radar-bg rounded overflow-hidden">
              <div className="h-full bg-zinc-400" style={{ width: `${pct}%` }} />
            </div>
            <span className="text-zinc-400 w-12 text-right tabular-nums">{a.toFixed(0)}</span>
          </div>
        );
      })}
    </div>
  );
}
