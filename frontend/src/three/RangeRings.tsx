import * as THREE from "three";
import { useMemo } from "react";

const RADII = [3, 6, 9, 12];

export function RangeRings() {
  const rings = useMemo(
    () =>
      RADII.map((r) => {
        const geo = new THREE.RingGeometry(r - 0.02, r + 0.02, 96);
        geo.rotateX(-Math.PI / 2);
        return { r, geo };
      }),
    []
  );

  return (
    <group>
      {rings.map(({ r, geo }) => (
        <mesh key={r} geometry={geo}>
          <meshBasicMaterial color="#22d3ee" transparent opacity={0.18} side={THREE.DoubleSide} />
        </mesh>
      ))}
    </group>
  );
}
