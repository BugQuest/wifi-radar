import { useRef, useState } from "react";
import { useThree, type ThreeEvent } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { SensorNode } from "./SensorNode";
import { useStore } from "../store";

const PRO = window.location.protocol === "https:" ? "https:" : "http:";
const API = `${PRO}//${window.location.host}/api`;

interface Props {
  id: string;
  position: [number, number, number];
  alive: boolean;
  connected: boolean;
  ssid?: string;
  rssiToAp: number;
  rate: number;
}

// Wrapper around SensorNode that adds drag-on-floor capability when the global
// `calibrationMode` is on. Persists the new position to the backend on release.
export function SensorDraggable(props: Props) {
  const calibrationMode = useStore((s) => s.calibrationMode);
  const updatePosition = useStore((s) => s.updateSensorPosition);
  const { camera, gl } = useThree();
  const dragging = useRef(false);
  const [hover, setHover] = useState(false);
  // Reused buffers to avoid allocs per pointermove
  const ndc = useRef(new THREE.Vector2());
  const ray = useRef(new THREE.Raycaster());
  const plane = useRef(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0));
  const hit = useRef(new THREE.Vector3());

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    if (!calibrationMode) return;
    e.stopPropagation();
    dragging.current = true;
    gl.domElement.style.cursor = "grabbing";
    (e.target as Element)?.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    e.stopPropagation();
    const rect = gl.domElement.getBoundingClientRect();
    ndc.current.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    ray.current.setFromCamera(ndc.current, camera);
    if (ray.current.ray.intersectPlane(plane.current, hit.current)) {
      const x = Math.round(hit.current.x * 100) / 100;
      const z = Math.round(hit.current.z * 100) / 100;
      updatePosition(props.id, x, z);
    }
  };

  const onPointerUp = (_e: ThreeEvent<PointerEvent>) => {
    if (!dragging.current) return;
    dragging.current = false;
    gl.domElement.style.cursor = hover ? "grab" : "";
    // Persist
    fetch(`${API}/sensors/${encodeURIComponent(props.id)}/position`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: props.position[0], z: props.position[2] }),
    }).catch(() => {});
  };

  const onPointerOver = (e: ThreeEvent<PointerEvent>) => {
    if (!calibrationMode) return;
    e.stopPropagation();
    setHover(true);
    gl.domElement.style.cursor = "grab";
  };
  const onPointerOut = () => {
    if (!calibrationMode) return;
    setHover(false);
    if (!dragging.current) gl.domElement.style.cursor = "";
  };

  return (
    <group
      position={props.position}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerOver={onPointerOver}
      onPointerOut={onPointerOut}
    >
      <SensorNode {...props} position={[0, 0, 0]} />
      {calibrationMode && (
        <>
          {/* Larger invisible hit area to make dragging easy */}
          <mesh visible={false}>
            <cylinderGeometry args={[1.2, 1.2, 0.3, 16]} />
            <meshBasicMaterial transparent opacity={0} />
          </mesh>
          {/* Calibration ring on the floor */}
          <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
            <ringGeometry args={[0.55, 0.7, 32]} />
            <meshBasicMaterial color={hover ? "#f59e0b" : "#facc15"} transparent opacity={hover ? 0.6 : 0.35} side={THREE.DoubleSide} depthWrite={false} />
          </mesh>
          <Html position={[0, -0.3, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }}>
            <div className="px-1.5 py-0.5 text-[10px] font-mono whitespace-nowrap bg-radar-bg/90 border border-radar-warn/60 rounded text-radar-warn">
              drag to set
            </div>
          </Html>
        </>
      )}
    </group>
  );
}
