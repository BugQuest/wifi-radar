import { useMemo } from "react";
import * as THREE from "three";
import { useStore } from "../store";

// Line strip showing the last N presence centroid positions, fading with age.
// Uses <primitive> with a pre-built THREE.Line to bypass the JSX <line> ↔ SVG
// element collision that breaks the runtime in TS + R3F.
export function MotionTrail() {
  const presence = useStore((s) => s.presence);

  const lineObject = useMemo(() => {
    if (!presence?.history || presence.history.length < 2) return null;
    const positions: number[] = [];
    const colors: number[] = [];
    const now = Date.now() / 1000;
    const baseColor = new THREE.Color("#22d3ee");
    for (const pt of presence.history) {
      positions.push(pt.x, 0.02, pt.z);
      const age = Math.max(0, now - pt.ts);
      const alpha = Math.exp(-age / 8.0);
      colors.push(baseColor.r * alpha, baseColor.g * alpha, baseColor.b * alpha);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    const mat = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
    });
    const line = new THREE.Line(geo, mat);
    return line;
  }, [presence?.history]);

  if (!lineObject) return null;
  return <primitive object={lineObject} />;
}
