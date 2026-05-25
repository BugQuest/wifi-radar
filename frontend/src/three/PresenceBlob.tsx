import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../store";

// Glowing blob on the floor at the estimated presence centroid. Size scales
// with intensity, color shifts from blue (low) → orange (high). Lerps smoothly.
export function PresenceBlob() {
  const presence = useStore((s) => s.presence);
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const matRef = useRef<THREE.MeshBasicMaterial>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame(({ clock }) => {
    if (!groupRef.current || !meshRef.current || !matRef.current) return;
    const t = clock.getElapsedTime();

    if (!presence?.position) {
      // Fade out
      matRef.current.opacity += (0 - matRef.current.opacity) * 0.1;
      if (ringMatRef.current) ringMatRef.current.opacity += (0 - ringMatRef.current.opacity) * 0.1;
      meshRef.current.scale.setScalar(meshRef.current.scale.x + (0.1 - meshRef.current.scale.x) * 0.1);
      return;
    }

    const tgt = new THREE.Vector3(presence.position.x, 0.05, presence.position.z);
    groupRef.current.position.lerp(tgt, 0.18);

    const intensity = presence.intensity;
    const correlation = Math.max(0, presence.correlation);
    const targetScale = 0.4 + intensity * 1.6 + Math.sin(t * 3) * 0.08;
    const cur = meshRef.current.scale.x;
    meshRef.current.scale.setScalar(cur + (targetScale - cur) * 0.18);

    // Color: cyan (low motion) → orange (high motion)
    const c = new THREE.Color().lerpColors(
      new THREE.Color("#22d3ee"),
      new THREE.Color("#f59e0b"),
      intensity,
    );
    matRef.current.color.copy(c);
    matRef.current.opacity += (0.55 * (0.3 + 0.7 * correlation) - matRef.current.opacity) * 0.18;

    if (ringRef.current && ringMatRef.current) {
      const ringScale = targetScale * (1.6 + Math.sin(t * 2) * 0.15);
      const rc = ringRef.current.scale.x;
      ringRef.current.scale.setScalar(rc + (ringScale - rc) * 0.1);
      ringMatRef.current.color.copy(c);
      ringMatRef.current.opacity += (0.2 * intensity - ringMatRef.current.opacity) * 0.1;
    }
  });

  return (
    <group ref={groupRef}>
      <mesh ref={meshRef} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.35, 32]} />
        <meshBasicMaterial ref={matRef} color="#22d3ee" transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh ref={ringRef} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.4, 0.45, 32]} />
        <meshBasicMaterial ref={ringMatRef} color="#22d3ee" transparent opacity={0} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {presence?.position && presence.intensity > 0.1 && (
        <Html position={[0, 0.4, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }}>
          <div className="px-2 py-0.5 bg-radar-bg/90 border border-radar-accent/50 rounded text-[10px] font-mono whitespace-nowrap">
            <span className="text-radar-accent">presence</span>
            <span className="text-zinc-400 ml-2">
              ({presence.position.x.toFixed(1)}, {presence.position.z.toFixed(1)})m · i={(presence.intensity * 100).toFixed(0)}% · ρ={presence.correlation.toFixed(2)}
            </span>
          </div>
        </Html>
      )}
    </group>
  );
}
