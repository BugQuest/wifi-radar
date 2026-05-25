import { useStore } from "../store";
import { useThrottled } from "../lib/useThrottled";
import { ViewToolbar } from "./ViewToolbar";

function Pill({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex flex-col px-3 py-1.5 bg-radar-panel/80 border border-radar-border rounded">
      <span className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</span>
      <span className={`text-sm font-semibold ${accent ? "text-radar-accent" : "text-zinc-100"}`}>
        {value}
      </span>
    </div>
  );
}

export function StatsBar() {
  const stats = useStore((s) => s.stats);
  const rawDevices = useStore((s) => s.devices);
  const conn = useStore((s) => s.connState);
  // Device count throttled so the top bar doesn't tick every sniff event.
  const devices = useThrottled(rawDevices, 500);
  const sensors = useStore((s) => s.sensors);

  return (
    <div className="flex items-center gap-2 px-2 sm:px-3 py-2 bg-radar-bg/90 border-b border-radar-border overflow-x-auto shrink-0">
      <div className="flex items-center gap-2 shrink-0">
        <span
          className={`w-2.5 h-2.5 rounded-full ${
            conn === "open"
              ? "bg-emerald-400 shadow-[0_0_6px_#34d399]"
              : conn === "connecting"
              ? "bg-yellow-400 animate-pulse"
              : "bg-red-500"
          }`}
        />
        <span className="text-xs text-zinc-400 hidden sm:inline">{conn}</span>
      </div>
      <span className="text-radar-accent font-semibold text-sm sm:text-base shrink-0">RADAR</span>
      <Pill label="Sensors" value={`${sensors.size || 0}`} accent={sensors.size > 0} />
      <Pill label="Devices" value={`${devices.size}`} accent />
      <Pill label="Sniff/s" value={stats.sniff_rate.toFixed(1)} />
      <Pill label="CSI/s" value={stats.csi_rate.toFixed(1)} />
      <Pill label="Channel" value={`${stats.channel || "-"}`} />
      <Pill label="AP RSSI" value={stats.sta_connected ? `${stats.ap_rssi} dBm` : "off"} accent={stats.sta_connected} />
      {[...sensors.values()].sort((a, b) => a.id.localeCompare(b.id)).map((s) => (
        <div key={s.id} className="flex flex-col px-2 py-1.5 bg-radar-panel/80 border border-radar-border rounded">
          <span className="text-[10px] uppercase tracking-wider text-zinc-500">{s.id}</span>
          <span className={`text-xs font-mono ${s.connected ? "text-radar-accent" : "text-radar-danger"}`}>
            {s.connected ? `${s.sniff_rate.toFixed(0)}/s` : "off"}
            {s.drops > 0 && <span className="text-radar-warn ml-1">!{s.drops}</span>}
          </span>
        </div>
      ))}
      <div className="ml-auto flex items-center gap-3 shrink-0">
        <span className="text-xs text-zinc-500 hidden lg:inline">
          Σ sniff {stats.sniff_count.toLocaleString()} · csi {stats.csi_count.toLocaleString()}
        </span>
        <ViewToolbar />
      </div>
    </div>
  );
}
