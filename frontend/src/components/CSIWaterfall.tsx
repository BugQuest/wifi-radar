import { useEffect, useRef } from "react";
import { useStore } from "../store";
import { useThrottled } from "../lib/useThrottled";

// Render a scrolling "waterfall": time on X, subcarrier index on Y, color = CSI amplitude.
// Each CSI event paints a vertical strip from data[].
export function CSIWaterfall() {
  // When a device is selected and solo mode is on, show only its CSI.
  const selectedMac = useStore((s) => s.selectedMac);
  const soloMode = useStore((s) => s.soloMode);
  const selectedCsi = useStore((s) => s.selectedCsi);
  const allCsi = useStore((s) => s.csiHistory);
  const sourceCsi = soloMode && selectedMac ? selectedCsi : allCsi;
  const csi = useThrottled(sourceCsi, 200);
  const visible = useStore((s) => s.panels.waterfall);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || csi.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = "#05070d";
    ctx.fillRect(0, 0, W, H);

    const SUBCARRIERS = 64;
    const stripW = Math.max(2, W / Math.max(1, csi.length));

    csi.forEach((ev, idx) => {
      const x = idx * stripW;
      for (let s = 0; s < SUBCARRIERS; s++) {
        // each subcarrier = (imag, real) pair → amplitude = sqrt(i*i + r*r)
        const i = ev.data[s * 2] ?? 0;
        const r = ev.data[s * 2 + 1] ?? 0;
        const amp = Math.min(127, Math.sqrt(i * i + r * r));
        const norm = amp / 127;
        const y = (s / SUBCARRIERS) * H;
        const yh = H / SUBCARRIERS;
        // viridis-ish ramp
        const hue = 200 - norm * 200;
        const light = 20 + norm * 50;
        ctx.fillStyle = `hsl(${hue}, 80%, ${light}%)`;
        ctx.fillRect(x, y, stripW + 1, yh + 1);
      }
    });
  }, [csi]);

  const togglePanel = useStore((s) => s.togglePanel);
  if (!visible) return null;
  return (
    <div className="h-32 bg-radar-bg border-t border-radar-border flex flex-col">
      <div className="px-3 py-1 border-b border-radar-border flex items-center gap-3">
        <span className="text-xs uppercase tracking-wider text-zinc-400">🌊 CSI Waterfall</span>
        <span className="text-[10px] text-zinc-500">{csi.length} samples · 64 subcarriers</span>
        {soloMode && selectedMac && (
          <span className="text-[10px] text-radar-accent">solo: {selectedMac}</span>
        )}
        <button
          onClick={() => togglePanel("waterfall")}
          className="ml-auto text-zinc-500 hover:text-zinc-200 text-lg leading-none px-1"
          title="Hide waterfall"
        >×</button>
      </div>
      <canvas ref={canvasRef} width={1200} height={100} className="flex-1 w-full" />
    </div>
  );
}
