import { useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import type { Device } from "../lib/types";
import { colorFromMac, rssiToRadius } from "../lib/colors";
import { useStore } from "../store";

interface Props {
  device: Device;
  sensorPositions: Map<string, [number, number, number]>;
}

const TAU_SEC = 1.8;
const SCALE_PULSE = 0.45;
const EMISSIVE_BASE = 0.45;
const EMISSIVE_PULSE = 1.3;
const SCALE_LERP = 0.18;

export function DeviceOrbit({ device, sensorPositions }: Props) {
  const groupRef = useRef<THREE.Group>(null);
  const meshRef = useRef<THREE.Mesh>(null);
  const haloRef = useRef<THREE.Mesh>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const targetScale = useRef(1);
  const color = useMemo(() => colorFromMac(device.mac), [device.mac]);
  const selectedMac = useStore((s) => s.selectedMac);
  const hoveredMac = useStore((s) => s.hoveredMac);
  const soloMode = useStore((s) => s.soloMode);
  const setSelected = useStore((s) => s.setSelected);
  const setHovered = useStore((s) => s.setHovered);
  const isSelected = selectedMac === device.mac;
  const isHovered = hoveredMac === device.mac;
  const isFocused = isSelected || isHovered;
  // When solo mode is on AND a device is selected, fade everything else far down.
  const dimmed = soloMode && selectedMac !== null && !isSelected;

  const angleHash = useMemo(() => {
    let h = 0;
    for (let i = 0; i < device.mac.length; i++) h = (h * 33 + device.mac.charCodeAt(i)) >>> 0;
    return (h % 1000) / 1000 * Math.PI * 2;
  }, [device.mac]);

  // Position priority — each tier degrades both accuracy and the opacity we
  // give the rendered sphere, so the user can see at a glance whether a
  // device is really localized (solid) or just hash-placed on an uncertainty
  // ring (faded).
  const { position, certainty } = useMemo<{ position: [number, number, number]; certainty: number }>(() => {
    if (device.position_2d) {
      return {
        position: [device.position_2d.x, 0, device.position_2d.z],
        certainty: 0.6 + 0.4 * Math.min(1, device.position_2d.confidence),
      };
    }
    if (device.bilateration) {
      return {
        position: [device.bilateration.x, 0, device.bilateration.z],
        certainty: 0.45,
      };
    }
    const rssiBy = device.rssi_by_sensor ?? {};
    const sids = Object.keys(rssiBy);
    if (sids.length > 0) {
      const bestSid = sids.reduce((a, b) => (rssiBy[a]! > rssiBy[b]! ? a : b));
      const sensorPos = sensorPositions.get(bestSid) ?? [0, 0, 0];
      const r = rssiToRadius(rssiBy[bestSid]!);
      // Only the distance is real here — angle is hashed, so we keep it
      // visually subdued to communicate "device is somewhere on this ring".
      return {
        position: [sensorPos[0] + Math.cos(angleHash) * r, 0, sensorPos[2] + Math.sin(angleHash) * r],
        certainty: 0.22,
      };
    }
    const r = rssiToRadius(device.last_rssi);
    return {
      position: [Math.cos(angleHash) * r, 0, Math.sin(angleHash) * r],
      certainty: 0.15,
    };
  }, [device.position_2d, device.bilateration, device.rssi_by_sensor, device.last_rssi, sensorPositions, angleHash]);

  useFrame(({ clock }) => {
    if (!groupRef.current || !meshRef.current) return;
    groupRef.current.position.set(position[0], position[1], position[2]);

    const dt = Math.max(0, Date.now() / 1000 - device.last_seen);
    const activity = Math.exp(-dt / TAU_SEC);
    const focus = isSelected ? 1.55 : isHovered ? 1.3 : 1.0;
    targetScale.current = (1 + activity * SCALE_PULSE) * focus;

    const cur = meshRef.current.scale.x;
    const next = cur + (targetScale.current - cur) * SCALE_LERP;
    meshRef.current.scale.setScalar(next);

    if (materialRef.current) {
      const targetEmissive = EMISSIVE_BASE + activity * EMISSIVE_PULSE + (isFocused ? 0.6 : 0);
      materialRef.current.emissiveIntensity +=
        (targetEmissive - materialRef.current.emissiveIntensity) * SCALE_LERP;
      // Opacity reflects positional certainty AND solo mode.
      const baseOpacity = isFocused ? Math.max(0.85, certainty) : certainty;
      const targetOpacity = dimmed ? 0.06 : baseOpacity;
      materialRef.current.transparent = true;
      materialRef.current.opacity += (targetOpacity - materialRef.current.opacity) * SCALE_LERP;
    }

    if (haloRef.current) {
      const breathe = isSelected ? 1 + Math.sin(clock.elapsedTime * 3) * 0.08 : 1;
      const cs = haloRef.current.scale.x;
      const ns = cs + (breathe - cs) * SCALE_LERP;
      haloRef.current.scale.setScalar(ns);
      const mat = haloRef.current.material as THREE.MeshBasicMaterial;
      const targetOpacity = isSelected ? 0.3 : isHovered ? 0.18 : activity * 0.08;
      mat.opacity += (targetOpacity - mat.opacity) * SCALE_LERP;
    }
  });

  const stop = (e: ThreeEvent<PointerEvent | MouseEvent>) => {
    e.stopPropagation();
  };

  return (
    <group ref={groupRef}>
      <mesh ref={haloRef}>
        <sphereGeometry args={[0.45, 24, 24]} />
        <meshBasicMaterial color={color} transparent opacity={0} depthWrite={false} />
      </mesh>
      <mesh
        ref={meshRef}
        onPointerOver={(e) => { stop(e); setHovered(device.mac); document.body.style.cursor = "pointer"; }}
        onPointerOut={(e) => { stop(e); if (hoveredMac === device.mac) setHovered(null); document.body.style.cursor = ""; }}
        onClick={(e) => { stop(e); setSelected(isSelected ? null : device.mac); }}
      >
        <sphereGeometry args={[0.18, 16, 16]} />
        <meshStandardMaterial ref={materialRef} color={color} emissive={color} emissiveIntensity={EMISSIVE_BASE} />
      </mesh>
      {isHovered && !isSelected && (
        <Html
          position={[0, 0.45, 0]}
          center
          distanceFactor={10}
          zIndexRange={[10, 0]}
          style={{ pointerEvents: "none" }}
        >
          <div className="px-2 py-1 bg-radar-bg/90 border border-radar-border rounded text-[11px] text-zinc-100 whitespace-nowrap shadow-lg">
            <div className="font-semibold" style={{ color }}>{device.vendor}</div>
            <div className="text-zinc-400">
              {device.mac} · {device.last_rssi} dBm
              {device.position_2d ? (
                <span className="ml-1 text-radar-accent">
                  · 2D ({device.position_2d.x.toFixed(1)}, {device.position_2d.z.toFixed(1)}) m
                </span>
              ) : device.bilateration ? (
                <span className="ml-1 text-radar-accent">
                  · Δ{device.bilateration.delta_rssi > 0 ? "+" : ""}{device.bilateration.delta_rssi} dB
                </span>
              ) : (
                <span className="ml-1 text-radar-warn">
                  · ~{Math.hypot(position[0], position[2]).toFixed(1)}m (angle inconnu)
                </span>
              )}
            </div>
          </div>
        </Html>
      )}
    </group>
  );
}
