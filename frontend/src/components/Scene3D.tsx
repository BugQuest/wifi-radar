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
  const replayMode = useStore((s) => s.replayMode);
  const replaySnapshot = useStore((s) => s.replaySnapshot);
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
      {/* Heatmap: live grid in normal mode, the snapshot's grid in replay. */}
      {!replayMode && layers.heatmap && <HeatmapFloor />}
      {replayMode && layers.heatmap && replaySnapshot?.heatmap && (
        <HeatmapFloor override={replaySnapshot.heatmap} />
      )}
      {layers.sensors && <RangeRings />}
      {!replayMode && layers.csiField && <CSIField recent={csiHistory} />}
      {layers.trails && !replayMode && <MotionTrail />}
      {/* Live presence blob OR historical presence marker (sphere at the
          snapshot's centroid). */}
      {layers.presence && !replayMode && <PresenceBlob />}
      {layers.presence && replayMode && replaySnapshot?.presence?.position && (
        <mesh position={[replaySnapshot.presence.position.x, 0.2, replaySnapshot.presence.position.z]}>
          <sphereGeometry args={[0.25, 24, 24]} />
          <meshStandardMaterial color="#fb923c" emissive="#fb923c" emissiveIntensity={0.5} transparent opacity={0.85} />
        </mesh>
      )}
      {layers.trails && !replayMode && <SelectedDeviceTrail />}
      {layers.rssiVectors && !replayMode && <RssiVectors />}
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

      {/* Live devices */}
      {layers.devices && !replayMode && [...devices.values()].map((d) => (
        <DeviceOrbit
          key={d.mac}
          device={d}
          sensorPositions={positions}
        />
      ))}
      {/* Historical devices: render simple coloured spheres at the snapshot's
          positions.  We deliberately don't reuse DeviceOrbit because it relies
          on live RSSI history / pulsing that doesn't apply to a snapshot. */}
      {layers.devices && replayMode && (replaySnapshot?.devices ?? [])
        .filter((d) => d.pos)
        .map((d) => (
          <mesh key={d.mac} position={[d.pos!.x, 0.15, d.pos!.z]}>
            <sphereGeometry args={[0.18, 16, 16]} />
            <meshStandardMaterial
              color={d.rssi > -55 ? "#34d399" : d.rssi > -75 ? "#fbbf24" : "#f87171"}
              emissive={d.rssi > -55 ? "#10b981" : d.rssi > -75 ? "#f59e0b" : "#dc2626"}
              emissiveIntensity={0.4}
              transparent
              opacity={Math.max(0.4, d.pos!.confidence)}
            />
          </mesh>
        ))}
      {/* Historical trails: one line strip per device with ≥2 trail points. */}
      {layers.trails && replayMode && (replaySnapshot?.devices ?? [])
        .filter((d) => (d.trail?.length ?? 0) >= 2)
        .map((d) => {
          const pts = d.trail!;
          const N = pts.length;
          const positions = new Float32Array(N * 3);
          const colors = new Float32Array(N * 3);
          for (let i = 0; i < N; i++) {
            positions[i * 3] = pts[i].x;
            positions[i * 3 + 1] = 0.08;
            positions[i * 3 + 2] = pts[i].z;
            // Fade from translucent (oldest) to bright (newest).
            const a = (i + 1) / N;
            colors[i * 3] = 0.94 * a;     // hot pink-ish trail
            colors[i * 3 + 1] = 0.36 * a;
            colors[i * 3 + 2] = 0.78 * a;
          }
          const geom = new THREE.BufferGeometry();
          geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
          geom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
          const mat = new THREE.LineBasicMaterial({
            vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false,
          });
          const obj = new THREE.Line(geom, mat);
          return <primitive key={`trail-${d.mac}`} object={obj} />;
        })}

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
