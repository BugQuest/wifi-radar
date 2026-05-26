import { create } from "zustand";
import type { Device, Sensor, Stats, WsEvent, CsiEvent, PresenceState, PortStats, SystemStats } from "../lib/types";
import type { WsState } from "../lib/ws";

interface PulseTick {
  mac: string;
  ts: number;
}

// Position log for the selected device (rolling), used to draw its trail and
// estimate its velocity vector.
export interface PosLogEntry {
  ts: number;
  x: number;
  z: number;
  conf: number;
}

export type PanelKey = "diagnostics" | "presence" | "list" | "waterfall" | "system" | "config" | "calibration" | "firmware" | "layers" | "history";

// One frame of historical state fetched from /api/history/snapshot.  Mirrors
// the backend's _scene_payload(): a small, replay-friendly slice of devices,
// sensors and presence at a given timestamp.
export interface SnapshotPos {
  x: number;
  z: number;
  confidence: number;
}
export interface SnapshotTrailPoint {
  ts: number;
  x: number;
  z: number;
}
export interface SnapshotDevice {
  mac: string;
  rssi: number;
  last_seen: number;
  pos: SnapshotPos | null;
  trail?: SnapshotTrailPoint[];
}
export interface SnapshotHeatmap {
  size: number;       // grid edge (e.g. 40)
  max: number;        // raw max for scale ref
  values: number[];   // length = size*size, each ∈ [0, 127]
}
export interface SnapshotSensor {
  id: string;
  x: number;
  z: number;
  connected: boolean;
  sniff_rate: number;
  csi_rate: number;
}
export interface SnapshotPayload {
  v: number;
  devices: SnapshotDevice[];
  sensors: SnapshotSensor[];
  presence: { position?: { x: number; z: number } | null; intensity?: number; correlation?: number } | null;
  heatmap?: SnapshotHeatmap | null;
}

// Toggleable 3D-scene render layers.  Backed by zustand so any UI surface can
// drive them.  Default to "everything visible" — the user pares down what they
// don't need.
export type LayerKey =
  | "sensors"        // SensorDraggable nodes + range rings
  | "devices"        // sniffed MACs as orbs
  | "trails"         // motion trails for selected + multi-device
  | "heatmap"        // ground-plane gaussian splat of activity
  | "presence"       // presence centroid blob
  | "grid"           // floor reference grid
  | "rssiVectors";   // lines sensor ↔ device colored by RSSI

export type LayerVisibility = Record<LayerKey, boolean>;

// One in-progress capture window during path-loss calibration.
export interface CalibrationCapture {
  sensor: string;       // sid (r0, r1...)
  mac: string;          // colon-formatted MAC
  distance_m: number;
  t_start: number;
  t_end: number;
  samples: number[];    // raw RSSI values collected
}

export type PanelVisibility = Record<PanelKey, boolean>;

interface RadarStore {
  connState: WsState;
  devices: Map<string, Device>;
  sensors: Map<string, Sensor>;
  baselineHalfM: number;
  stats: Stats;
  csiHistory: CsiEvent[];
  lastPulse: PulseTick | null;
  selectedMac: string | null;
  hoveredMac: string | null;
  presence: PresenceState | null;
  ports: PortStats[];
  system: SystemStats | null;

  // Per-selected-device rolling buffers (cleared on selection change)
  selectedPackets: { ts: number; sid: string; k: string; rssi: number; ch: number; len: number }[];
  selectedCsi: CsiEvent[];
  selectedPositions: PosLogEntry[];
  soloMode: boolean;
  focusTrigger: number;     // bumped to ask Scene3D to fly camera to selected
  panels: PanelVisibility;
  layers: LayerVisibility;
  // Replay (history) mode.  When `replayMode` is true, Scene3D substitutes the
  // devices / presence layers with whatever is in `replaySnapshot`.  Live
  // updates keep flowing into devices / sensors / presence as usual so toggling
  // back to live mode is instant.
  replayMode: boolean;
  replayAt: number | null;            // timestamp the user is scrubbing to
  replaySnapshot: SnapshotPayload | null;
  calibrationMode: boolean;   // when true, sensors can be dragged in the floor plane
  // Path-loss calibration runtime state
  pathLossCapture: CalibrationCapture | null;

  setConnState: (s: WsState) => void;
  applyEvent: (ev: WsEvent) => void;
  setSelected: (mac: string | null) => void;
  setHovered: (mac: string | null) => void;
  setSoloMode: (v: boolean) => void;
  triggerFocus: () => void;
  togglePanel: (k: PanelKey) => void;
  toggleLayer: (k: LayerKey) => void;
  setReplayMode: (v: boolean) => void;
  setReplayAt: (ts: number | null) => void;
  setReplaySnapshot: (s: SnapshotPayload | null) => void;
  toggleCalibration: () => void;
  updateSensorPosition: (sid: string, x: number, z: number) => void;
  startPathLossCapture: (sensor: string, mac: string, distance_m: number, duration_s: number) => void;
  stopPathLossCapture: () => void;
}

const RSSI_HISTORY_LIMIT = 60;
const SELECTED_PACKETS_LIMIT = 60;
const SELECTED_CSI_LIMIT = 80;
const SELECTED_POSITIONS_LIMIT = 120;

const emptyStats: Stats = {
  sniff_count: 0,
  csi_count: 0,
  sniff_rate: 0,
  csi_rate: 0,
  sta_connected: false,
  channel: 0,
  ap_rssi: 0,
};

const CSI_HISTORY_LIMIT = 256;

export const useStore = create<RadarStore>((set, get) => ({
  connState: "connecting",
  devices: new Map(),
  sensors: new Map(),
  baselineHalfM: 2.0,
  stats: emptyStats,
  csiHistory: [],
  lastPulse: null,
  selectedMac: null,
  hoveredMac: null,
  presence: null,
  ports: [],
  system: null,
  selectedPackets: [],
  selectedCsi: [],
  selectedPositions: [],
  soloMode: false,
  focusTrigger: 0,
  panels: { diagnostics: true, presence: true, list: true, waterfall: true, system: true, config: false, calibration: false, firmware: false, layers: false, history: false },
  layers: { sensors: true, devices: true, trails: true, heatmap: true, presence: true, grid: true, rssiVectors: false },
  replayMode: false,
  replayAt: null,
  replaySnapshot: null,
  calibrationMode: false,
  pathLossCapture: null,

  setConnState: (s) => set({ connState: s }),
  setSelected: (mac) =>
    set({
      selectedMac: mac,
      // Reset buffers on new selection.
      selectedPackets: [],
      selectedCsi: [],
      selectedPositions: [],
    }),
  setHovered: (mac) => set({ hoveredMac: mac }),
  setSoloMode: (v) => set({ soloMode: v }),
  triggerFocus: () => set((s) => ({ focusTrigger: s.focusTrigger + 1 })),
  togglePanel: (k) => set((s) => ({ panels: { ...s.panels, [k]: !s.panels[k] } })),
  toggleLayer: (k) => set((s) => ({ layers: { ...s.layers, [k]: !s.layers[k] } })),
  setReplayMode: (v) => set({ replayMode: v, replayAt: v ? null : null, replaySnapshot: v ? null : null }),
  setReplayAt: (ts) => set({ replayAt: ts }),
  setReplaySnapshot: (snap) => set({ replaySnapshot: snap }),
  toggleCalibration: () => set((s) => ({ calibrationMode: !s.calibrationMode })),
  updateSensorPosition: (sid, x, z) =>
    set((s) => {
      const next = new Map(s.sensors);
      const sensor = next.get(sid);
      if (sensor) {
        next.set(sid, { ...sensor, position_x: x, position_z: z });
      }
      return { sensors: next };
    }),
  startPathLossCapture: (sensor, mac, distance_m, duration_s) => {
    const now = Date.now() / 1000;
    set({
      pathLossCapture: {
        sensor,
        mac,
        distance_m,
        t_start: now,
        t_end: now + duration_s,
        samples: [],
      },
    });
  },
  stopPathLossCapture: () => set({ pathLossCapture: null }),

  applyEvent: (ev) => {
    switch (ev.t) {
      case "snapshot": {
        const m = new Map<string, Device>();
        for (const d of ev.devices) {
          m.set(d.mac, { ...d, rssi_history: [d.last_rssi] });
        }
        const sensors = new Map<string, Sensor>();
        for (const s of ev.sensors ?? []) sensors.set(s.id, s);
        set({
          devices: m,
          stats: ev.stats,
          sensors,
          baselineHalfM: ev.baseline_half_m ?? get().baselineHalfM,
          presence: ev.presence ?? null,
          ports: ev.ports ?? [],
          system: ev.system ?? null,
        });
        break;
      }
      case "stats": {
        const { t: _t, sensors: incomingSensors, presence, ports, system, ...stats } = ev;
        const next: Partial<RadarStore> = { stats };
        if (incomingSensors) {
          const sensors = new Map<string, Sensor>();
          for (const s of incomingSensors) sensors.set(s.id, s);
          next.sensors = sensors;
        }
        if (presence !== undefined) next.presence = presence;
        if (ports !== undefined) next.ports = ports;
        if (system !== undefined) next.system = system;
        set(next);
        break;
      }
      case "sniff": {
        const macHex = ev.src;
        if (macHex.length !== 12) return;
        const mac = macHex.match(/.{2}/g)!.join(":");
        const sid = ev.sid ?? "?";
        // Path-loss calibration: while a capture is active, accumulate RSSI from
        // the configured (sensor, mac). Auto-stop when t_end passes.
        const cur0 = get();
        if (cur0.pathLossCapture) {
          const c = cur0.pathLossCapture;
          if (ev.ts > c.t_end) {
            set({ pathLossCapture: { ...c, t_end: c.t_end } });
            // Mark as ended by clearing if no more samples expected. We keep
            // samples for the panel to read; the panel decides when to drop.
          } else if (sid === c.sensor && mac === c.mac) {
            set({ pathLossCapture: { ...c, samples: [...c.samples, ev.rssi] } });
          }
        }
        const devices = new Map(get().devices);
        const now = ev.ts;
        const existing = devices.get(mac);
        // Per-selected-device rolling packet buffer
        const cur = get();
        let selectedPackets = cur.selectedPackets;
        let selectedPositions = cur.selectedPositions;
        if (cur.selectedMac === mac) {
          const pkts = [
            ...cur.selectedPackets,
            { ts: ev.ts, sid, k: ev.k, rssi: ev.rssi, ch: ev.ch, len: ev.len },
          ];
          if (pkts.length > SELECTED_PACKETS_LIMIT) pkts.shift();
          selectedPackets = pkts;
          // Position log: if the device has a fresh 2D estimate, push it.
          const pos = existing?.position_2d;
          if (pos) {
            const last = cur.selectedPositions[cur.selectedPositions.length - 1];
            if (!last || Math.abs(last.x - pos.x) > 0.05 || Math.abs(last.z - pos.z) > 0.05 || ev.ts - last.ts > 0.5) {
              const next = [...cur.selectedPositions, { ts: ev.ts, x: pos.x, z: pos.z, conf: pos.confidence }];
              if (next.length > SELECTED_POSITIONS_LIMIT) next.shift();
              selectedPositions = next;
            }
          }
        }
        if (existing) {
          const hist = existing.rssi_history ?? [];
          const newHist = hist.length >= RSSI_HISTORY_LIMIT
            ? [...hist.slice(1), ev.rssi]
            : [...hist, ev.rssi];
          devices.set(mac, {
            ...existing,
            last_seen: now,
            last_rssi: ev.rssi,
            packets: existing.packets + 1,
            kinds: { ...existing.kinds, [ev.k]: (existing.kinds[ev.k] || 0) + 1 },
            rssi_by_sensor: { ...(existing.rssi_by_sensor ?? {}), [sid]: ev.rssi },
            last_seen_by_sensor: { ...(existing.last_seen_by_sensor ?? {}), [sid]: now },
            rssi_history: newHist,
          });
        } else {
          devices.set(mac, {
            mac,
            vendor: "...",
            first_seen: now,
            last_seen: now,
            last_rssi: ev.rssi,
            packets: 1,
            kinds: { [ev.k]: 1 },
            rssi_by_sensor: { [sid]: ev.rssi },
            last_seen_by_sensor: { [sid]: now },
            rssi_history: [ev.rssi],
          });
        }
        set({ devices, lastPulse: { mac, ts: now }, selectedPackets, selectedPositions });
        break;
      }
      case "csi": {
        const cur = get();
        const csiHistory = [...cur.csiHistory, ev].slice(-CSI_HISTORY_LIMIT);
        let selectedCsi = cur.selectedCsi;
        if (cur.selectedMac) {
          // ev.src is hex (12 chars), selectedMac is colon-separated. Compare normalized.
          const evMac = ev.src.length === 12 ? ev.src.match(/.{2}/g)!.join(":") : ev.src;
          if (evMac === cur.selectedMac) {
            selectedCsi = [...cur.selectedCsi, ev].slice(-SELECTED_CSI_LIMIT);
          }
        }
        set({ csiHistory, selectedCsi });
        break;
      }
    }
  },
}));
