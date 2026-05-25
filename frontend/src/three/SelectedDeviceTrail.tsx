import { useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../store";

// Line strip + cone arrow showing the path and current velocity of the
// currently selected device (built from accumulated trilateration positions).
export function SelectedDeviceTrail() {
  const positions = useStore((s) => s.selectedPositions);

  const trail = useMemo(() => {
    if (!positions || positions.length < 2) return null;
    const pts: number[] = [];
    const cols: number[] = [];
    const now = positions[positions.length - 1].ts;
    const base = new THREE.Color("#f59e0b");
    for (const p of positions) {
      pts.push(p.x, 0.04, p.z);
      const age = Math.max(0, now - p.ts);
      const a = Math.exp(-age / 20.0); // fades over ~20s
      cols.push(base.r * a, base.g * a, base.b * a);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cols, 3));
    const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, linewidth: 2 });
    return new THREE.Line(geo, mat);
  }, [positions]);

  // Velocity vector arrow at the latest point.
  const arrow = useMemo(() => {
    if (!positions || positions.length < 2) return null;
    const last = positions[positions.length - 1];
    // Average over last few points for stability.
    const tail = positions.slice(-Math.min(positions.length, 6));
    const dt = tail[tail.length - 1].ts - tail[0].ts;
    if (dt <= 0.001) return null;
    const vx = (tail[tail.length - 1].x - tail[0].x) / dt;
    const vz = (tail[tail.length - 1].z - tail[0].z) / dt;
    const speed = Math.hypot(vx, vz);
    if (speed < 0.05) return null; // too slow to bother drawing
    const dir = new THREE.Vector3(vx, 0, vz).normalize();
    const len = Math.min(1.5, Math.max(0.3, speed));
    const origin = new THREE.Vector3(last.x, 0.05, last.z);
    return new THREE.ArrowHelper(dir, origin, len, 0xf59e0b, 0.18, 0.12);
  }, [positions]);

  if (!trail) return null;
  return (
    <group>
      <primitive object={trail} />
      {arrow && <primitive object={arrow} />}
    </group>
  );
}
