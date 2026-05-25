import type { Device, Sensor } from "./types";

const PATH_LOSS_RSSI_0 = -30;
const PATH_LOSS_N = 2.5;
const FRESH_SEC = 8;

export interface TrilatStep {
  sid: string;
  x: number;       // sensor x in meters
  z: number;       // sensor z in meters
  rssi: number;    // dBm
  fresh: boolean;
  age_s: number;
  d_est: number;   // estimated distance from path-loss
}

export interface TrilatResult {
  fresh: TrilatStep[];    // sensors used (≥3)
  stale: TrilatStep[];    // sensors with stale RSSI
  pathLoss: { rssi0: number; n: number; formula: string };
  // Linearized least-squares working values:
  reference: TrilatStep | null;
  rows: { a0: number; a1: number; b: number; sid: string }[];
  normal: { ata00: number; ata01: number; ata11: number; atb0: number; atb1: number; det: number } | null;
  solution: { x: number; z: number } | null;
  perSensorResidual: { sid: string; actual_d: number; expected_d: number; diff: number }[];
  rms: number;
  confidence: number;
  // Final reasoning explaining why result is or isn't usable
  verdict: string;
}

export function computeTrilatDebug(device: Device, sensors: Map<string, Sensor>): TrilatResult {
  const now = Date.now() / 1000;
  const rssiBy = device.rssi_by_sensor ?? {};
  const lastSeenBy = device.last_seen_by_sensor ?? {};
  const allSteps: TrilatStep[] = [];
  for (const sid of [...sensors.keys()].sort()) {
    const s = sensors.get(sid)!;
    const rssi = rssiBy[sid];
    if (rssi === undefined) continue;
    const t = lastSeenBy[sid] ?? 0;
    const age = now - t;
    const d_est = Math.pow(10, (PATH_LOSS_RSSI_0 - rssi) / (10 * PATH_LOSS_N));
    allSteps.push({ sid, x: s.position_x, z: s.position_z, rssi, fresh: age <= FRESH_SEC, age_s: age, d_est });
  }
  const fresh = allSteps.filter((s) => s.fresh);
  const stale = allSteps.filter((s) => !s.fresh);

  const result: TrilatResult = {
    fresh,
    stale,
    pathLoss: {
      rssi0: PATH_LOSS_RSSI_0,
      n: PATH_LOSS_N,
      formula: `RSSI(d) = ${PATH_LOSS_RSSI_0} − 10 × ${PATH_LOSS_N} × log₁₀(d)  ⇒  d = 10^((${PATH_LOSS_RSSI_0} − RSSI) / ${10 * PATH_LOSS_N})`,
    },
    reference: null,
    rows: [],
    normal: null,
    solution: null,
    perSensorResidual: [],
    rms: 0,
    confidence: 0,
    verdict: "",
  };

  if (fresh.length < 3) {
    result.verdict =
      fresh.length === 2
        ? `Seulement 2 capteurs frais → bilatération 1D (pas de position 2D possible).`
        : fresh.length === 1
        ? `Un seul capteur frais → orbite simple autour de ${fresh[0].sid}.`
        : `Aucun capteur frais (cutoff ${FRESH_SEC} s) → pas de positionnement.`;
    return result;
  }

  // Linear-LSQ trilateration using fresh[0] as reference
  const [ref, ...rest] = fresh;
  result.reference = ref;
  for (const p of rest) {
    const a0 = 2 * (p.x - ref.x);
    const a1 = 2 * (p.z - ref.z);
    const b =
      (p.x * p.x + p.z * p.z - p.d_est * p.d_est) -
      (ref.x * ref.x + ref.z * ref.z - ref.d_est * ref.d_est);
    result.rows.push({ a0, a1, b, sid: p.sid });
  }

  let ata00 = 0,
    ata01 = 0,
    ata11 = 0,
    atb0 = 0,
    atb1 = 0;
  for (const r of result.rows) {
    ata00 += r.a0 * r.a0;
    ata01 += r.a0 * r.a1;
    ata11 += r.a1 * r.a1;
    atb0 += r.a0 * r.b;
    atb1 += r.a1 * r.b;
  }
  const det = ata00 * ata11 - ata01 * ata01;
  result.normal = { ata00, ata01, ata11, atb0, atb1, det };

  if (Math.abs(det) < 1e-9) {
    result.verdict = `Matrice singulière (det ≈ 0) — les capteurs sont colinéaires ou les distances incohérentes. Pas de solution unique.`;
    return result;
  }

  const x = (ata11 * atb0 - ata01 * atb1) / det;
  const z = (-ata01 * atb0 + ata00 * atb1) / det;
  result.solution = { x, z };

  let rss = 0;
  for (const p of fresh) {
    const actual = Math.hypot(x - p.x, z - p.z);
    const diff = actual - p.d_est;
    rss += diff * diff;
    result.perSensorResidual.push({ sid: p.sid, actual_d: actual, expected_d: p.d_est, diff });
  }
  result.rms = Math.sqrt(rss / fresh.length);

  const maxRssi = Math.max(...fresh.map((f) => f.rssi));
  const confResidual = Math.exp(-result.rms / 8);
  const confSignal = Math.min(1, Math.max(0, (maxRssi + 95) / 70));
  result.confidence = confResidual * confSignal;

  result.verdict =
    result.rms < 2
      ? `✓ Très bon fit : résidu RMS ${result.rms.toFixed(2)} m. Trilatération fiable.`
      : result.rms < 5
      ? `~ Fit correct, résidu ${result.rms.toFixed(2)} m. Position indicative, marge d'erreur ~${result.rms.toFixed(1)} m.`
      : `! Mauvais fit, résidu RMS ${result.rms.toFixed(2)} m — RSSI bruité ou path-loss model désaligné avec l'environnement réel.`;
  return result;
}
