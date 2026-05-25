import { Grid, Text } from "@react-three/drei";

interface Props {
  rangeRadii?: number[];
  axesLength?: number;
}

// 1m grid + numbered range rings + XZ axes labels. Pure visual aid, no state.
export function Floor({ rangeRadii = [1, 3, 6, 9, 12], axesLength = 8 }: Props) {
  return (
    <group>
      <Grid
        args={[40, 40]}
        cellSize={1}
        cellThickness={0.6}
        cellColor="#1a2440"
        sectionSize={5}
        sectionThickness={1}
        sectionColor="#22d3ee"
        fadeDistance={30}
        fadeStrength={1.2}
        infiniteGrid
        position={[0, -0.001, 0]}
      />
      {/* X axis ticks */}
      {Array.from({ length: axesLength * 2 + 1 }, (_, i) => i - axesLength).map((x) => (
        x !== 0 && (
          <Text
            key={`x-${x}`}
            position={[x, 0.01, -0.2]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={0.18}
            color="#22d3ee"
            anchorX="center"
            anchorY="middle"
          >
            {x > 0 ? `+${x}` : `${x}`}
          </Text>
        )
      ))}
      {/* Z axis ticks */}
      {Array.from({ length: axesLength * 2 + 1 }, (_, i) => i - axesLength).map((z) => (
        z !== 0 && (
          <Text
            key={`z-${z}`}
            position={[-0.2, 0.01, z]}
            rotation={[-Math.PI / 2, 0, 0]}
            fontSize={0.18}
            color="#22d3ee"
            anchorX="center"
            anchorY="middle"
          >
            {z > 0 ? `+${z}` : `${z}`}
          </Text>
        )
      ))}
      {/* Range rings labels at the far side */}
      {rangeRadii.map((r) => (
        <Text
          key={`r-${r}`}
          position={[0, 0.01, -r]}
          rotation={[-Math.PI / 2, 0, 0]}
          fontSize={0.2}
          color="#22d3ee"
          anchorX="center"
          anchorY="bottom"
        >
          {r}m
        </Text>
      ))}
      {/* Origin label */}
      <Text
        position={[0.2, 0.01, 0.2]}
        rotation={[-Math.PI / 2, 0, 0]}
        fontSize={0.22}
        color="#f59e0b"
        anchorX="left"
        anchorY="top"
      >
        0,0
      </Text>
    </group>
  );
}
