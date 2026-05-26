export interface Bilateration {
  x: number;              // world coords (meters), on the floor plane
  z: number;
  delta_rssi: number;     // rssi_A - rssi_B (positive = closer to A)
  confidence: number;     // 0..1
  sensors_used: string[];
}

export interface Position2D {
  x: number;              // world coords (meters)
  z: number;
  confidence: number;     // 0..1
  residual_m: number;     // fit quality (smaller = better)
  sensors_used: string[];
}

export interface Device {
  mac: string;
  vendor: string;
  first_seen: number;
  last_seen: number;
  last_rssi: number;
  packets: number;
  kinds: Record<string, number>;
  rssi_by_sensor?: Record<string, number>;
  last_seen_by_sensor?: Record<string, number>;
  bilateration?: Bilateration | null;
  position_2d?: Position2D | null;
  // Frontend-only: rolling RSSI history for sparkline (most recent last).
  rssi_history?: number[];
}

export interface Sensor {
  id: string;
  port: string;
  position_x: number;
  position_z: number;
  first_seen: number;
  last_heartbeat: number;
  connected: boolean;
  ssid: string;
  channel: number;
  ap_rssi: number;
  drops: number;
  ring_free: number;
  sniff_count: number;
  csi_count: number;
  sniff_rate: number;
  csi_rate: number;
  ping_recv: number;
  ping_lost: number;
  ping_interval_ms: number;
}

export interface Stats {
  sniff_count: number;
  csi_count: number;
  sniff_rate: number;
  csi_rate: number;
  sta_connected: boolean;
  channel: number;
  ap_rssi: number;
}

export interface SniffEvent {
  t: "sniff";
  ts: number;
  sid?: string;
  k: string;
  src: string;
  dst: string;
  rssi: number;
  ch: number;
  len: number;
}

export interface CsiEvent {
  t: "csi";
  ts: number;
  sid?: string;
  src: string;
  rssi: number;
  ch: number;
  len: number;
  data: number[];
}

export interface HeatmapState {
  size: number;        // cells per side
  extent_m: number;    // world half-extent in meters
  max: number;         // current max accumulated value (for legend)
  values: number[];    // size*size int8 row-major (x-axis = i, z-axis = j)
}

export interface PresenceCandidate {
  x: number;
  z: number;
  intensity: number;     // raw heatmap value at the peak
  confidence: number;    // 0..1 (peak / global max)
}

export interface PresenceState {
  sensor_activity: Record<string, number>;
  position: { x: number; z: number } | null;
  intensity: number;
  correlation: number;
  history: { ts: number; x: number; z: number; i: number }[];
  last_update: number;
  heatmap?: HeatmapState;
  // Multi-body candidates — N local maxima of the heatmap, sorted by intensity.
  // Stateless across frames (persistent IDs come with the "sessions" feature).
  presences?: PresenceCandidate[];
}

export interface SystemStats {
  ts: number;
  cpu_percent: number;
  cpu_per_core: number[];
  temperature_c: number | null;
  load_avg: [number, number, number];
  cpu_count: number;
  uptime_s: number;
  mem_total_kb: number;
  mem_available_kb: number;
  mem_free_kb: number;
  mem_used_pct: number;
  throttled_raw: number | null;
  throttled_flags: string[];
  disk_total_gb: number;
  disk_used_gb: number;
  disk_pct: number;
}

export interface WifiConfig {
  name: string;
  ssid: string;
  password: string;
  created_ts: number;
  notes?: string;
}

export interface ScannedAP {
  ssid: string;
  signal: number;       // 0..100 from nmcli
  security: string;
  freq_mhz: number;
}

export interface PortStats {
  device: string;
  baud: number;
  connected: boolean;
  bytes_received: number;
  lines_seen: number;
  events_published: number;
  rejected_boundary: number;
  rejected_json: number;
  rejected_type: number;
  rejected_sid: number;
  last_byte_ts: number;
  last_event_ts: number;
  last_sid_seen: string;
  error: string;
}

export interface SnapshotEvent {
  t: "snapshot";
  devices: Device[];
  stats: Stats;
  sensors?: Sensor[];
  baseline_half_m?: number;
  presence?: PresenceState;
  ports?: PortStats[];
  system?: SystemStats;
}

export interface StatsEvent extends Stats {
  t: "stats";
  sensors?: Sensor[];
  presence?: PresenceState;
  ports?: PortStats[];
  system?: SystemStats;
}

export type WsEvent = SniffEvent | CsiEvent | SnapshotEvent | StatsEvent | { t: "log"; msg: string; ts: number };
