import { useEffect, useMemo, useRef } from "react";
import { Canvas, useThree, useFrame } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import type { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import * as THREE from "three";
import { useStore } from "../store";
import { SensorNode } from "../three/SensorNode";
import { SensorDraggable } from "../three/SensorDraggable";
import { DeviceOrbit } from "../three/DeviceOrbit";
import { CSIField } from "../three/CSIField";
import { RangeRings } from "../three/RangeRings";
import { Floor } from "../three/Floor";
import { HeatmapFloor } from "../three/HeatmapFloor";
import { PresenceBlob } from "../three/PresenceBlob";
import { MotionTrail } from "../three/MotionTrail";
import { SelectedDeviceTrail } from "../three/SelectedDeviceTrail";
import { RssiVectors } from "../three/RssiVectors";

// Smoothly fly OrbitControls' target and camera to the selected device on
// focusTrigger. Uses a time-bound easing (700ms easeOutCubic), so once the
// animation ends the camera is free for the user. Also any drag/zoom by the
// user immediately cancels the in-flight animation.
function CameraFocus({ controlsRef }: { controlsRef: React.RefObject<OrbitControlsImpl | null> }) {
  const { camera } = useThree();
  const devices = useStore((s) => s.devices);
  const selectedMac = useStore((s) => s.selectedMac);
  const focusTrigger = useStore((s) => s.focusTrigger);

  const animStartMs = useRef<number | null>(null);
  const camFrom = useRef<THREE.Vector3>(new THREE.Vector3());
  const camTo = useRef<THREE.Vector3>(new THREE.Vector3());
  const tgtFrom = useRef<THREE.Vector3>(new THREE.Vector3());
  const tgtTo = useRef<THREE.Vector3>(new THREE.Vector3());
  const DURATION_MS = 700;

  // Trigger animation when user clicks Focus (focusTrigger bumps).
  useEffect(() => {
    if (focusTrigger === 0 || !selectedMac) return;
    const d = devices.get(selectedMac);
    if (!d) return;
    let x = 0, z = 0;
    if (d.position_2d) { x = d.position_2d.x; z = d.position_2d.z; }
    else if (d.bilateration) { x = d.bilateration.x; z = d.bilateration.z; }
    else { return; }
    const c = controlsRef.current;
    if (!c) return;
    tgtFrom.current.copy(c.target);
    tgtTo.current.set(x, 0, z);
    const offsetDist = 6;
    const azimuth = Math.atan2(camera.position.x - x, camera.position.z - z);
    const elev = Math.PI / 6;
    camFrom.current.copy(camera.position);
    camTo.current.set(
      x + offsetDist * Math.cos(elev) * Math.sin(azimuth),
      offsetDist * Math.sin(elev) + 2,
      z + offsetDist * Math.cos(elev) * Math.cos(azimuth),
    );
    animStartMs.current = performance.now();
  }, [focusTrigger, selectedMac, devices, camera, controlsRef]);

  // Cancel any in-flight animation as soon as the user starts interacting.
  useEffect(() => {
    const c = controlsRef.current;
    if (!c) return;
    const cancel = () => {
      animStartMs.current = null;
    };
    c.addEventListener("start", cancel);
    return () => c.removeEventListener("start", cancel);
  }, [controlsRef]);

  useFrame(() => {
    if (animStartMs.current === null) return;
    const c = controlsRef.current;
    if (!c) return;
    const elapsed = performance.now() - animStartMs.current;
    const t = Math.min(1, elapsed / DURATION_MS);
    const ease = 1 - Math.pow(1 - t, 3); // easeOutCubic
    camera.position.copy(camFrom.current).lerp(camTo.current, ease);
    c.target.copy(tgtFrom.current).lerp(tgtTo.current, ease);
    c.update();
    if (t >= 1) animStartMs.current = null;
  });

  return null;
}

export function Scene3D() {
  const devices = useStore((s) => s.devices);
  const sensors = useStore((s) => s.sensors);
  const csiHistory = useStore((s) => s.csiHistory);
  const calibrationMode = useStore((s) => s.calibrationMode);
  const layers = useStore((s) => s.layers);
  const controlsRef = useRef<OrbitControlsImpl | null>(null);

  const sortedSensorIds = useMemo(() => [...sensors.keys()].sort(), [sensors]);
  // Sensor positions come from the backend now (authoritative — same coordinate
  // system used by the trilateration math).
  const positions = useMemo(() => {
    const m = new Map<string, [number, number, number]>();
    for (const id of sortedSensorIds) {
      const s = sensors.get(id)!;
      m.set(id, [s.position_x, 0, s.position_z]);
    }
    return m;
  }, [sortedSensorIds, sensors]);

  return (
    <Canvas camera={{ position: [0, 8, 16], fov: 50 }} dpr={[1, 2]}>
      <color attach="background" args={["#05070d"]} />
      <ambientLight intensity={0.2} />

      {layers.grid && <Floor />}
      {layers.heatmap && <HeatmapFloor />}
      {layers.sensors && <RangeRings />}
      <CSIField recent={csiHistory} />
      {layers.trails && <MotionTrail />}
      {layers.presence && <PresenceBlob />}
      {layers.trails && <SelectedDeviceTrail />}
      {layers.rssiVectors && <RssiVectors />}
      <CameraFocus controlsRef={controlsRef} />

      {layers.sensors && sortedSensorIds.length === 0 && (
        <SensorNode id="…" position={[0, 0, 0]} alive={false} connected={false} rssiToAp={0} rate={0} />
      )}
      {layers.sensors && sortedSensorIds.map((id) => {
        const s = sensors.get(id)!;
        // "alive" = we got events from this sid recently
        const alive = s.sniff_rate > 0 || s.csi_rate > 0;
        return (
          <SensorDraggable
            key={id}
            id={id}
            position={positions.get(id)!}
            alive={alive}
            connected={s.connected}
            ssid={s.ssid}
            rssiToAp={s.ap_rssi}
            rate={s.sniff_rate}
          />
        );
      })}

      {layers.devices && [...devices.values()].map((d) => (
        <DeviceOrbit
          key={d.mac}
          device={d}
          sensorPositions={positions}
        />
      ))}

      <OrbitControls
        ref={controlsRef}
        enabled={!calibrationMode}
        enableDamping
        dampingFactor={0.08}
        minDistance={4}
        maxDistance={40}
      />
    </Canvas>
  );
}
