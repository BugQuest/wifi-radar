import { useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import type { CsiEvent } from "../lib/types";

interface Props {
  recent: CsiEvent[];
}

// Particle cloud whose agitation reflects CSI variance. With one ESP32 we can't position
// real entities in space, so we render a diffuse "energy field" around the sensor that
// breathes faster when CSI shows motion in the medium.
const COUNT = 1500;

export function CSIField({ recent }: Props) {
  const pointsRef = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const p = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      // Spherical shell distribution, radius 3-12
      const r = 3 + Math.random() * 9;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      p[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      p[i * 3 + 1] = r * Math.cos(phi) * 0.4;
      p[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
    }
    return p;
  }, []);

  // Rolling CSI variance: how much do consecutive samples differ?
  const variance = useMemo(() => {
    if (recent.length < 2) return 0;
    let total = 0;
    const last5 = recent.slice(-5);
    for (let i = 1; i < last5.length; i++) {
      const a = last5[i - 1].data;
      const b = last5[i].data;
      const n = Math.min(a.length, b.length);
      let s = 0;
      for (let j = 0; j < n; j++) s += Math.abs(a[j] - b[j]);
      total += s / n;
    }
    return total / Math.max(1, last5.length - 1);
  }, [recent]);

  useFrame(({ clock }) => {
    if (!pointsRef.current) return;
    const t = clock.getElapsedTime();
    const mat = pointsRef.current.material as THREE.PointsMaterial;
    // Higher variance → brighter, more agitated
    const energy = Math.min(1, variance / 30);
    mat.opacity = 0.15 + energy * 0.5;
    mat.size = 0.04 + energy * 0.06;
    pointsRef.current.rotation.y = t * (0.02 + energy * 0.1);
  });

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#22d3ee" size={0.05} sizeAttenuation transparent opacity={0.2} depthWrite={false} />
    </points>
  );
}
