import { memo, useMemo, useState } from "react";
import { useStore } from "../store";
import { useThrottled } from "../lib/useThrottled";
import { colorFromMac, rssiToDistance, formatDistance } from "../lib/colors";
import type { Device } from "../lib/types";

function rssiBar(rssi: number): { width: string; color: string } {
  const pct = Math.max(0, Math.min(100, ((rssi + 95) / 70) * 100));
  const color = rssi > -50 ? "#34d399" : rssi > -70 ? "#facc15" : "#f87171";
  return { width: `${pct}%`, color };
}

function age(ts: number, nowSec: number): string {
  const dt = nowSec - ts;
  if (dt < 60) return `${Math.round(dt)}s`;
  if (dt < 3600) return `${Math.round(dt / 60)}m`;
  return `${Math.round(dt / 3600)}h`;
}

function focusShadow(sel: boolean, hov: boolean, c: string): string | undefined {
  if (sel) return `0 0 8px ${c}`;
  if (hov) return `0 0 4px ${c}`;
  return undefined;
}

interface RowProps {
  device: Device;
  nowSec: number;
  isSelected: boolean;
  isHovered: boolean;
  onClick: () => void;
  onEnter: () => void;
  onLeave: () => void;
}

function positionLine(device: Device): { label: string; coords: string; sensors?: string } | null {
  if (device.position_2d) {
    const { x, z, sensors_used } = device.position_2d;
    const r = Math.hypot(x, z);
    return {
      label: "2D",
      coords: `(${x.toFixed(1)}, ${z.toFixed(1)})m · r=${r.toFixed(1)}m`,
      sensors: sensors_used.join(""),
    };
  }
  if (device.bilateration) {
    const { x, z, sensors_used } = device.bilateration;
    return {
      label: "1D",
      coords: `(${x.toFixed(1)}, ${z.toFixed(1)})m`,
      sensors: sensors_used.join(""),
    };
  }
  const rssiBy = device.rssi_by_sensor ?? {};
  const sids = Object.keys(rssiBy);
  if (sids.length === 0) return null;
  const bestSid = sids.reduce((a, b) => (rssiBy[a]! > rssiBy[b]! ? a : b));
  const d = rssiToDistance(rssiBy[bestSid]!);
  return { label: "~", coords: `${formatDistance(d)} from`, sensors: bestSid };
}

const Row = memo(function Row({ device, nowSec, isSelected, isHovered, onClick, onEnter, onLeave }: RowProps) {
  const bar = rssiBar(device.last_rssi);
  const c = colorFromMac(device.mac);
  const pos = positionLine(device);
  return (
    <div
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onClick={onClick}
      className={`px-3 py-2 border-b border-radar-border/60 cursor-pointer transition-colors duration-200 ${
        isSelected
          ? "bg-radar-accent/10 border-l-2 border-l-radar-accent"
          : isHovered
          ? "bg-radar-bg/80"
          : "hover:bg-radar-bg/60"
      }`}
    >
      <div className="flex items-center gap-2 text-xs">
        <span
          className="w-2 h-2 rounded-full shrink-0 transition-shadow"
          style={{ background: c, boxShadow: focusShadow(isSelected, isHovered, c) }}
        />
        <span className="font-semibold text-zinc-100 truncate">{device.vendor}</span>
        <span className="ml-auto text-zinc-500 tabular-nums">{age(device.last_seen, nowSec)}</span>
      </div>
      <div className="text-[10px] text-zinc-500 font-mono mt-0.5">{device.mac}</div>
      <div className="flex items-center gap-2 mt-1">
        <div className="flex-1 h-1 bg-radar-bg rounded overflow-hidden">
          <div
            style={{ width: bar.width, background: bar.color }}
            className="h-full transition-all duration-500 ease-out"
          />
        </div>
        <span className="text-[10px] text-zinc-400 w-12 text-right tabular-nums">{device.last_rssi} dBm</span>
      </div>
      {pos && (
        <div className="flex items-center gap-1 mt-1 text-[10px] tabular-nums">
          <span className={`px-1 rounded ${pos.label === "2D" ? "bg-radar-accent/15 text-radar-accent" : "bg-radar-bg text-zinc-500"}`}>
            {pos.label}
          </span>
          <span className="text-zinc-300">{pos.coords}</span>
          {pos.sensors && <span className="text-zinc-500">{pos.sensors}</span>}
        </div>
      )}
      <div className="flex gap-1 mt-1 flex-wrap text-[9px]">
        {Object.entries(device.kinds).map(([k, n]) => (
          <span key={k} className="px-1 py-px bg-radar-bg border border-radar-border rounded text-zinc-400 tabular-nums">
            {k}:{n}
          </span>
        ))}
        <span className="ml-auto text-zinc-500 tabular-nums">{device.packets} pkts</span>
      </div>
    </div>
  );
});

export function DeviceList() {
  const rawDevices = useStore((s) => s.devices);
  const selectedMac = useStore((s) => s.selectedMac);
  const hoveredMac = useStore((s) => s.hoveredMac);
  const setSelected = useStore((s) => s.setSelected);
  const setHovered = useStore((s) => s.setHovered);
  const visible = useStore((s) => s.panels.list);
  const togglePanel = useStore((s) => s.togglePanel);
  const [sortBy, setSortBy] = useState<"recent" | "rssi" | "packets">("recent");
  const [filter, setFilter] = useState("");

  // Throttle expensive list re-renders to 500ms; we don't need 60fps for a text list.
  const devices = useThrottled(rawDevices, 500);
  // nowSec is also throttled, so "5s ago"/"6s ago" stops jittering every animation frame.
  const nowSec = useThrottled(Math.floor(Date.now() / 1000), 1000);

  const sorted = useMemo(() => {
    const arr = [...devices.values()];
    const f = filter.trim().toLowerCase();
    const filtered = f
      ? arr.filter((d) => d.mac.includes(f) || d.vendor.toLowerCase().includes(f))
      : arr;
    if (sortBy === "rssi") {
      // Bucket RSSI to 5dB to stop micro-fluctuations from reshuffling adjacent rows.
      filtered.sort((a, b) => {
        const ra = Math.round(a.last_rssi / 5) * 5;
        const rb = Math.round(b.last_rssi / 5) * 5;
        return rb - ra || a.mac.localeCompare(b.mac);
      });
    } else if (sortBy === "packets") {
      // Log-bucket packets so two devices with 312 vs 318 packets don't swap places constantly.
      filtered.sort((a, b) => {
        const la = Math.floor(Math.log10(a.packets + 1) * 10);
        const lb = Math.floor(Math.log10(b.packets + 1) * 10);
        return lb - la || a.mac.localeCompare(b.mac);
      });
    } else {
      // Bucket last_seen to 5s windows; within a bucket sort alphabetically for stability.
      filtered.sort((a, b) => {
        const ba = Math.floor(a.last_seen / 5);
        const bb = Math.floor(b.last_seen / 5);
        return bb - ba || a.mac.localeCompare(b.mac);
      });
    }
    return filtered;
  }, [devices, sortBy, filter]);

  if (!visible) return null;
  return (
    <div
      className="
        fixed inset-x-0 bottom-0 top-24 z-30
        md:static md:inset-auto md:z-auto md:w-80 md:shrink-0
        flex flex-col bg-radar-panel/95 backdrop-blur border-l border-radar-border
      "
    >
      <div className="px-3 py-2 border-b border-radar-border flex flex-col gap-2">
        <div className="flex items-center">
          <h2 className="text-xs uppercase tracking-wider text-zinc-400">📋 Devices ({devices.size})</h2>
          <button
            onClick={() => togglePanel("list")}
            className="ml-auto text-zinc-500 hover:text-zinc-200 text-lg leading-none px-1"
            title="Hide list"
          >×</button>
        </div>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter MAC / vendor..."
          className="bg-radar-bg border border-radar-border rounded px-2 py-1 text-xs text-zinc-200 focus:outline-none focus:border-radar-accent"
        />
        <div className="flex gap-1 text-[10px]">
          {(["recent", "rssi", "packets"] as const).map((k) => (
            <button
              key={k}
              onClick={() => setSortBy(k)}
              className={`px-2 py-0.5 rounded border transition-colors ${
                sortBy === k
                  ? "border-radar-accent text-radar-accent"
                  : "border-radar-border text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {k}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {sorted.map((d) => (
          <Row
            key={d.mac}
            device={d}
            nowSec={nowSec}
            isSelected={selectedMac === d.mac}
            isHovered={hoveredMac === d.mac}
            onClick={() => setSelected(selectedMac === d.mac ? null : d.mac)}
            onEnter={() => setHovered(d.mac)}
            onLeave={() => {
              if (hoveredMac === d.mac) setHovered(null);
            }}
          />
        ))}
        {sorted.length === 0 && (
          <div className="p-4 text-center text-xs text-zinc-500">No devices yet — listening...</div>
        )}
      </div>
    </div>
  );
}
