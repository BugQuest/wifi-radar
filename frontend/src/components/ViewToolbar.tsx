import { useStore } from "../store";
import type { PanelKey } from "../store";

const PRO = window.location.protocol === "https:" ? "https:" : "http:";
const API = `${PRO}//${window.location.host}/api`;

interface ToolEntry {
  key: PanelKey;
  icon: string;
  label: string;
}

const ENTRIES: ToolEntry[] = [
  { key: "diagnostics", icon: "📡", label: "Sensors diagnostic" },
  { key: "presence", icon: "👤", label: "Presence panel" },
  { key: "list", icon: "📋", label: "Device list" },
  { key: "waterfall", icon: "🌊", label: "CSI waterfall" },
  { key: "system", icon: "💻", label: "Pi system monitor" },
  { key: "config", icon: "⚙️", label: "WiFi configuration" },
];

export function ViewToolbar() {
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const calibrationMode = useStore((s) => s.calibrationMode);
  const toggleCalibration = useStore((s) => s.toggleCalibration);
  const sensors = useStore((s) => s.sensors);

  const resetCalibration = async () => {
    if (!window.confirm("Reset all sensor positions to auto-layout?")) return;
    for (const sid of [...sensors.keys()]) {
      try {
        await fetch(`${API}/sensors/${encodeURIComponent(sid)}/position`, { method: "DELETE" });
      } catch {}
    }
  };

  return (
    <div className="flex items-center gap-0.5 sm:gap-1">
      {ENTRIES.map((e) => {
        const on = panels[e.key];
        return (
          <button
            key={e.key}
            onClick={() => togglePanel(e.key)}
            title={`${on ? "Hide" : "Show"} ${e.label}`}
            className={`px-1.5 sm:px-2 py-1 rounded border text-sm transition-colors ${
              on
                ? "border-radar-accent text-radar-accent bg-radar-accent/10"
                : "border-radar-border text-zinc-500 hover:border-radar-accent hover:text-radar-accent"
            }`}
          >
            {e.icon}
          </button>
        );
      })}
      <button
        onClick={toggleCalibration}
        title={calibrationMode ? "Lock sensor positions" : "Drag-calibrate sensors"}
        className={`px-1.5 sm:px-2 py-1 rounded border text-sm transition-colors ml-0.5 sm:ml-1 ${
          calibrationMode
            ? "border-radar-warn text-radar-warn bg-radar-warn/10 animate-pulse"
            : "border-radar-border text-zinc-500 hover:border-radar-warn hover:text-radar-warn"
        }`}
      >
        📐
      </button>
      {calibrationMode && (
        <button
          onClick={resetCalibration}
          title="Reset all sensor positions to auto-layout"
          className="px-2 py-1 rounded border border-radar-border text-zinc-500 hover:border-radar-danger hover:text-radar-danger text-xs"
        >
          reset
        </button>
      )}
    </div>
  );
}
