import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";

export function Sensor() {
  const innerRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (innerRef.current) {
      innerRef.current.rotation.y = t * 0.4;
    }
    if (haloRef.current) {
      const s = 1 + Math.sin(t * 2) * 0.06;
      haloRef.current.scale.set(s, s, s);
    }
  });

  return (
    <group>
      <mesh ref={innerRef}>
        <icosahedronGeometry args={[0.6, 1]} />
        <meshStandardMaterial color="#22d3ee" emissive="#22d3ee" emissiveIntensity={1.6} wireframe />
      </mesh>
      <mesh ref={haloRef}>
        <sphereGeometry args={[0.85, 24, 24]} />
        <meshBasicMaterial color="#22d3ee" transparent opacity={0.08} />
      </mesh>
      <pointLight color="#22d3ee" intensity={2} distance={20} decay={1.4} />
    </group>
  );
}
