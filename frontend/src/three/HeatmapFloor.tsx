import { useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useStore } from "../store";

// 4-stop colormap: transparent → cyan → yellow → orange → red (mimics inferno-ish)
function colormap(v: number): [number, number, number, number] {
  // v ∈ [0, 1]
  if (v <= 0) return [0, 0, 0, 0];
  const a = Math.min(0.85, v * 1.8); // alpha grows quickly
  // RGB stops:
  //  0.0 → (0.13, 0.83, 0.93)  cyan
  //  0.5 → (0.99, 0.80, 0.18)  yellow
  //  1.0 → (0.94, 0.36, 0.10)  orange-red
  let r: number, g: number, b: number;
  if (v < 0.5) {
    const t = v / 0.5;
    r = 0.13 + (0.99 - 0.13) * t;
    g = 0.83 + (0.80 - 0.83) * t;
    b = 0.93 + (0.18 - 0.93) * t;
  } else {
    const t = (v - 0.5) / 0.5;
    r = 0.99 + (0.94 - 0.99) * t;
    g = 0.80 + (0.36 - 0.80) * t;
    b = 0.18 + (0.10 - 0.18) * t;
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255), Math.round(a * 255)];
}

interface HeatmapGrid {
  size: number;
  extent_m?: number;
  values: number[] | ArrayLike<number>;
}

interface Props {
  /**
   * Optional override grid (used by the replay mode to render a historical
   * heatmap from a snapshot).  When omitted, the component pulls the live
   * grid from the presence store as before.
   */
  override?: HeatmapGrid | null;
}

export function HeatmapFloor({ override }: Props = {}) {
  const liveHeatmap = useStore((s) => s.presence?.heatmap);
  const heatmap = override ?? liveHeatmap;
  const texRef = useRef<THREE.DataTexture | null>(null);

  // Allocate texture once, update its data in place when heatmap arrives.
  const size = heatmap?.size ?? 40;
  // Default extent matches the backend's HEATMAP_EXTENT_M.  Historical
  // snapshots don't currently carry this — we assume the same world size.
  const extent = heatmap?.extent_m ?? 10;

  const texture = useMemo(() => {
    const data = new Uint8Array(size * size * 4);
    const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    texRef.current = tex;
    return tex;
  }, [size]);

  useEffect(() => {
    if (!heatmap || !texRef.current) return;
    const data = texRef.current.image.data as Uint8Array;
    const vals = heatmap.values;
    for (let i = 0; i < size * size; i++) {
      const v = (vals[i] ?? 0) / 127;
      const [r, g, b, a] = colormap(v);
      const off = i * 4;
      data[off] = r;
      data[off + 1] = g;
      data[off + 2] = b;
      data[off + 3] = a;
    }
    texRef.current.needsUpdate = true;
  }, [heatmap, size]);

  if (!heatmap) return null;

  // The grid (i, j) maps to world (x = (i+0.5)/size * 2*extent - extent, z = ...).
  // PlaneGeometry default orientation: XY plane. Rotate -π/2 around X to lie on XZ.
  // Texture u maps to plane's X local (=> world X), v maps to plane's Y local (=> world -Z after rotation).
  // We flip the V to get a non-mirrored mapping.
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
      <planeGeometry args={[2 * extent, 2 * extent, 1, 1]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  );
}
