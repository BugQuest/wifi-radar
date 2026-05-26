import { useStore } from "../store";
import { useDraggable } from "../lib/useDraggable";
import type { LayerKey } from "../store";

interface LayerRow {
  key: LayerKey;
  icon: string;
  label: string;
  hint: string;
}

const ROWS: LayerRow[] = [
  { key: "sensors",     icon: "📡", label: "Sensors",       hint: "Capteurs + cercles de portée" },
  { key: "devices",     icon: "📱", label: "Devices",       hint: "MAC sniffés (sphères pulsantes)" },
  { key: "trails",      icon: "〰️", label: "Trails",        hint: "Trajectoires (selected + multi)" },
  { key: "heatmap",     icon: "🔥", label: "Heatmap",       hint: "Splat gaussien d'activité au sol" },
  { key: "presence",    icon: "👤", label: "Presence",      hint: "Centroïde de présence (blob)" },
  { key: "grid",        icon: "▦",  label: "Grid / sol",    hint: "Quadrillage de référence" },
  { key: "rssiVectors", icon: "📶", label: "RSSI vectors",  hint: "Lignes capteur↔device, couleur=RSSI" },
];

export function LayersPanel() {
  const visible = useStore((s) => s.panels.layers);
  const togglePanel = useStore((s) => s.togglePanel);
  const layers = useStore((s) => s.layers);
  const toggleLayer = useStore((s) => s.toggleLayer);
  const drag = useDraggable();

  if (!visible) return null;

  return (
    <div
      className="
        absolute right-2 top-2 left-2 max-h-[calc(100vh-1rem)]
        sm:right-3 sm:top-16 sm:left-auto sm:w-64 sm:max-h-[calc(100vh-5rem)]
        flex flex-col bg-radar-panel/95 border border-radar-border rounded font-mono text-[10px] z-20
      "
      style={drag.style}
    >
      <div
        {...drag.headerProps}
        className="flex items-center gap-2 px-3 py-2 border-b border-radar-border hover:bg-radar-bg/60 select-none shrink-0"
      >
        <span className="text-zinc-300 uppercase tracking-wider">🎛️ Layers</span>
        <span className="ml-auto text-zinc-500">
          {Object.values(layers).filter(Boolean).length}/{ROWS.length}
        </span>
        <button
          onClick={() => togglePanel("layers")}
          className="text-zinc-500 hover:text-zinc-200 text-base leading-none px-1"
          title="Close"
        >×</button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {ROWS.map((r) => {
          const on = layers[r.key];
          return (
            <button
              key={r.key}
              onClick={() => toggleLayer(r.key)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 border-b border-radar-border/30 text-left transition-colors ${
                on ? "text-zinc-200 hover:bg-radar-accent/5" : "text-zinc-500 hover:bg-radar-bg/40"
              }`}
              title={r.hint}
            >
              <span className={`w-4 h-4 inline-flex items-center justify-center border rounded-sm ${
                on ? "border-radar-accent bg-radar-accent/20 text-radar-accent" : "border-radar-border text-transparent"
              }`}>
                {on ? "✓" : ""}
              </span>
              <span className="text-sm leading-none">{r.icon}</span>
              <span className="flex-1 truncate">{r.label}</span>
            </button>
          );
        })}
      </div>

      <div className="px-3 py-1.5 border-t border-radar-border/40 text-[9px] text-zinc-600 shrink-0 flex gap-2">
        <button
          onClick={() => {
            for (const r of ROWS) if (!layers[r.key]) toggleLayer(r.key);
          }}
          className="hover:text-radar-accent"
        >all on</button>
        <span>·</span>
        <button
          onClick={() => {
            for (const r of ROWS) if (layers[r.key]) toggleLayer(r.key);
          }}
          className="hover:text-radar-accent"
        >all off</button>
      </div>
    </div>
  );
}
