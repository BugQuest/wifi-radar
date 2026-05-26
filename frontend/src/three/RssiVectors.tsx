import { useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../store";

/**
 * Draws a line from each sensor to each device it currently observes,
 * coloured by RSSI strength.
 *
 *   strong  ≥ -50 dBm  →  emerald-400  (#34d399)
 *   medium  -50..-65    →  amber-300   (#fcd34d)
 *   weak    -65..-80    →  orange-500  (#f97316)
 *   very weak < -80     →  rose-600    (#e11d48)
 *
 * Each device has at most N sensor lines (we cap by recent rssi freshness via
 * the backend's `rssi_by_sensor` map; only sensors whose last seen for this
 * device is within ~10s are drawn).
 */
const FRESH_WINDOW_SEC = 10;

function rssiColor(rssi: number): THREE.Color {
  if (rssi >= -50) return new THREE.Color("#34d399");
  if (rssi >= -65) return new THREE.Color("#fcd34d");
  if (rssi >= -80) return new THREE.Color("#f97316");
  return new THREE.Color("#e11d48");
}

export function RssiVectors() {
  const devices = useStore((s) => s.devices);
  const sensors = useStore((s) => s.sensors);
  const hoveredMac = useStore((s) => s.hoveredMac);
  const selectedMac = useStore((s) => s.selectedMac);

  const lines = useMemo(() => {
    const out: { key: string; points: Float32Array; colors: Float32Array; opacity: number }[] = [];
    const now = Date.now() / 1000;
    for (const dev of devices.values()) {
      // Need a 2D position estimate to anchor the device end of each line.
      const pos = dev.position_2d;
      if (!pos) continue;
      // Highlight selected/hovered, dim others to keep the scene readable.
      const isFocus = dev.mac === selectedMac || dev.mac === hoveredMac;
      const baseOpacity = isFocus ? 0.9 : 0.18;
      for (const [sid, rssi] of Object.entries(dev.rssi_by_sensor ?? {})) {
        const lastSeen = dev.last_seen_by_sensor?.[sid];
        if (!lastSeen || now - lastSeen > FRESH_WINDOW_SEC) continue;
        const sensor = sensors.get(sid);
        if (!sensor) continue;
        const points = new Float32Array(6);
        points[0] = sensor.position_x;
        points[1] = 0.05;
        points[2] = sensor.position_z;
        points[3] = pos.x;
        points[4] = 0.05;
        points[5] = pos.z;
        const c = rssiColor(rssi);
        const colors = new Float32Array(6);
        colors.set([c.r, c.g, c.b, c.r, c.g, c.b]);
        out.push({
          key: `${dev.mac}:${sid}`,
          points,
          colors,
          opacity: baseOpacity,
        });
      }
    }
    return out;
  }, [devices, sensors, hoveredMac, selectedMac]);

  if (lines.length === 0) return null;

  return (
    <group>
      {lines.map(({ key, points, colors, opacity }) => {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(points, 3));
        geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        const mat = new THREE.LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity,
          depthWrite: false,
        });
        // We build THREE.Line manually because <line> in JSX clashes with the
        // SVG line element and confuses r3f's type inference.
        const obj = new THREE.Line(geom, mat);
        return <primitive key={key} object={obj} />;
      })}
    </group>
  );
}
