"use client";

import { Center, Loader, Text } from "@mantine/core";
import { DropInViewer } from "@mkkellogg/gaussian-splats-3d";
import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useState } from "react";

interface SplatViewerProps {
  splatUrl: string;
}

/**
 * DropInViewer extends THREE.Group and drives its own per-frame update via
 * Three.js's native onBeforeRender hook (see gaussian-splats-3d's source:
 * `callbackMesh.onBeforeRender = DropInViewer.onBeforeRender...`) rather
 * than self-driven requestAnimationFrame — so simply adding it to R3F's
 * scene via <primitive> is enough; R3F's own render loop drives it with no
 * manual useFrame ticking needed.
 */
function SplatScene({ splatUrl, onError }: { splatUrl: string; onError: (message: string) => void }) {
  const [viewer, setViewer] = useState<DropInViewer | null>(null);

  useEffect(() => {
    let disposed = false;
    const dropInViewer = new DropInViewer({ gpuAcceleratedSort: true });
    dropInViewer
      .addSplatScenes([{ path: splatUrl }])
      .then(() => {
        if (!disposed) setViewer(dropInViewer);
      })
      .catch((err: unknown) => onError(err instanceof Error ? err.message : "Failed to load splat"));

    return () => {
      disposed = true;
      dropInViewer.dispose();
    };
  }, [splatUrl, onError]);

  if (!viewer) return null;
  return <primitive object={viewer} />;
}

export function SplatViewer({ splatUrl }: SplatViewerProps) {
  const [error, setError] = useState<string | null>(null);

  return (
    <div style={{ width: "100%", height: "70vh", position: "relative" }}>
      <Canvas camera={{ position: [-1, -4, 6], up: [0, -1, -0.6] }}>
        <SplatScene splatUrl={splatUrl} onError={setError} />
        <OrbitControls makeDefault />
      </Canvas>
      {error && (
        <Center style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <Text c="red">{error}</Text>
        </Center>
      )}
    </div>
  );
}

export function SplatViewerLoading() {
  return (
    <Center style={{ width: "100%", height: "70vh" }}>
      <Loader />
    </Center>
  );
}

export function SplatViewerError({ message }: { message: string }) {
  return (
    <Center style={{ width: "100%", height: "70vh" }}>
      <Text c="red">{message}</Text>
    </Center>
  );
}
