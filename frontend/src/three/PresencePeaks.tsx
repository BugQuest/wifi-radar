import { Html } from "@react-three/drei";
import * as THREE from "three";
import { useStore } from "../store";

/**
 * Renders one labelled disc per detected body — the local maxima of the
 * heatmap as computed by the backend's `_find_peaks`.  Replaces the single
 * aggregate PresenceBlob when the backend reports `presences[]` with one or
 * more entries; otherwise the caller falls back to PresenceBlob.
 *
 * Stateless: each peak is recomputed every frame, so the marker positions
 * snap rather than glide.  Smooth tracking is the next step (persistent IDs
 * = "sessions" feature).
 */
const COLORS = ["#22d3ee", "#a78bfa", "#fb923c", "#34d399", "#f472b6", "#facc15"];

interface Peak {
  x: number;
  z: number;
  intensity: number;
  confidence: number;
}

interface Props {
  /** If provided, peaks are read from this list (e.g. a replay snapshot).
   *  Otherwise we pull from the live presence in the store. */
  override?: Peak[];
}

export function PresencePeaks({ override }: Props = {}) {
  const livePeaks = useStore((s) => s.presence?.presences);
  const peaks = override ?? livePeaks ?? [];

  if (peaks.length === 0) return null;

  // Stable sort by intensity so the strongest peak always gets the first colour.
  const sorted = [...peaks].sort((a, b) => b.intensity - a.intensity);

  return (
    <group>
      {sorted.map((p, idx) => {
        const colour = COLORS[idx % COLORS.length];
        const size = 0.3 + Math.min(1.2, p.confidence) * 0.7;
        return (
          <group key={`${p.x.toFixed(2)}-${p.z.toFixed(2)}-${idx}`} position={[p.x, 0.05, p.z]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} scale={[size, size, size]}>
              <circleGeometry args={[0.35, 32]} />
              <meshBasicMaterial
                color={colour}
                transparent
                opacity={0.4 + 0.4 * p.confidence}
                depthWrite={false}
              />
            </mesh>
            <mesh rotation={[-Math.PI / 2, 0, 0]} scale={[size * 1.6, size * 1.6, size * 1.6]}>
              <ringGeometry args={[0.4, 0.45, 32]} />
              <meshBasicMaterial
                color={colour}
                transparent
                opacity={0.25 + 0.35 * p.confidence}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
            <Html position={[0, 0.4, 0]} center distanceFactor={12} style={{ pointerEvents: "none" }}>
              <div className="px-2 py-0.5 bg-radar-bg/90 border rounded text-[10px] font-mono whitespace-nowrap"
                   style={{ borderColor: colour }}>
                <span style={{ color: colour }}>#{idx + 1}</span>
                <span className="text-zinc-400 ml-2">
                  ({p.x.toFixed(1)}, {p.z.toFixed(1)})m · conf={(p.confidence * 100).toFixed(0)}%
                </span>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}
