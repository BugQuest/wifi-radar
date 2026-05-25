// Deterministic color from a string (MAC), HSL with steady saturation/lightness.
export function colorFromMac(mac: string): string {
  let h = 0;
  for (let i = 0; i < mac.length; i++) {
    h = (h * 31 + mac.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360}, 70%, 60%)`;
}

// Distance estimate from RSSI in real meters, visually clamped to [0.5, 15].
// 1 scene unit = 1 meter, so this radius matches the floor grid coordinates.
// Beyond 15 m the visual radius saturates (the path-loss extrapolation is
// noisy that far anyway, so we don't pretend to know).
export function rssiToRadius(rssi: number): number {
  const dist = rssiToDistance(rssi);
  return Math.max(0.5, Math.min(15, dist));
}

// Estimate distance in meters from RSSI using the log-distance path-loss model:
//   RSSI(d) = RSSI_0 - 10·n·log10(d)
// RSSI_0 is the calibrated RSSI at 1 m (-30 dBm typical indoor 2.4 GHz),
// n is the path-loss exponent (~2 free space, 2.5-4 indoor).
export function rssiToDistance(rssi: number, rssi0 = -30, n = 2.5): number {
  return Math.pow(10, (rssi0 - rssi) / (10 * n));
}

// Format a distance with adaptive precision.
export function formatDistance(d: number): string {
  if (d < 0.1) return "<0.1m";
  if (d < 10) return `${d.toFixed(1)}m`;
  if (d < 100) return `${d.toFixed(0)}m`;
  return `${(d / 1000).toFixed(1)}km`;
}

// Apply an alpha (0..1) to a color string returned by colorFromMac, supporting
// both hsl(...) and #rrggbb forms. Naive `color + "66"` breaks for HSL since
// CSS doesn't accept a trailing hex suffix on hsl().
export function withAlpha(color: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  if (color.startsWith("hsl(") || color.startsWith("HSL(")) {
    return color.replace(/hsl\(/i, "hsla(").replace(/\)$/, `, ${a})`);
  }
  if (color.startsWith("#") && (color.length === 7 || color.length === 4)) {
    const hex = color.length === 4
      ? "#" + [...color.slice(1)].map((c) => c + c).join("")
      : color;
    const aa = Math.round(a * 255).toString(16).padStart(2, "0");
    return hex + aa;
  }
  return color;
}
