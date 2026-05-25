import { useRef } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";

interface Props {
  id: string;
  position: [number, number, number];
  alive: boolean;          // serial port is emitting events
  connected: boolean;      // STA is associated to AP (separate, optional)
  ssid?: string;
  rssiToAp: number;
  rate: number;            // sniff/s — drives the halo intensity
}

const COLOR_ALIVE = "#22d3ee";          // alive + STA connected (best)
const COLOR_ALIVE_NOAP = "#f59e0b";     // alive but STA not associated
const COLOR_DEAD = "#71717a";           // not emitting

export function SensorNode({ id, position, alive, connected, ssid, rssiToAp, rate }: Props) {
  const innerRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const color = !alive ? COLOR_DEAD : connected ? COLOR_ALIVE : COLOR_ALIVE_NOAP;

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();
    if (innerRef.current) innerRef.current.rotation.y = t * 0.4;
    if (haloRef.current) {
      const intensity = Math.min(1, rate / 50);
      const s = 1 + Math.sin(t * 2) * 0.05 + intensity * 0.15;
      haloRef.current.scale.setScalar(s);
      (haloRef.current.material as THREE.MeshBasicMaterial).opacity = 0.06 + intensity * 0.12;
    }
  });

  return (
    <group position={position}>
      <mesh ref={innerRef}>
        <icosahedronGeometry args={[0.45, 1]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.4} wireframe />
      </mesh>
      <mesh ref={haloRef}>
        <sphereGeometry args={[0.7, 24, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0.08} depthWrite={false} />
      </mesh>
      <pointLight color={color} intensity={1.4} distance={14} decay={1.4} />
      <Html position={[0, 0.95, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }}>
        <div className="px-2 py-0.5 text-[10px] font-mono whitespace-nowrap bg-radar-bg/80 border border-radar-border rounded text-zinc-200">
          <span style={{ color }}>{id}</span>
          {!alive ? (
            <span className="text-radar-danger"> · dead</span>
          ) : connected ? (
            <>
              <span className="text-radar-accent"> · {ssid || "AP"}</span>
              <span className="text-zinc-500"> ({rssiToAp} dBm)</span>
            </>
          ) : (
            <span className="text-radar-warn"> · sniffing (no AP)</span>
          )}
        </div>
      </Html>
    </group>
  );
}
