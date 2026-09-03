// @mkkellogg/gaussian-splats-3d ships no type declarations. This covers only
// the DropInViewer surface actually used by web/components/viewer/SplatViewer.tsx
// (README: "DropInViewer class encapsulates Viewer and can be added to a
// Three.js scene like any other renderable").
declare module "@mkkellogg/gaussian-splats-3d" {
  import type { Box3, Group } from "three";

  // Values matter, not just names: SceneFormat.Ply === 2 at runtime, and addSplatScenes forwards this straight into
  // its own equality checks against that object. The library infers format from the path's file extension when this
  // is omitted, which fails for a presigned S3 URL — the query string after `.ply` means the path never actually
  // ends with it.
  export const SceneFormat: {
    Splat: number;
    KSplat: number;
    Ply: number;
    Spz: number;
  };

  export interface SplatSceneOptions {
    path: string;
    format?: number;
    splatAlphaRemovalThreshold?: number;
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  }

  export interface DropInViewerOptions {
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
  }

  export class SplatMesh extends Group {
    // Splat positions in a COLMAP reconstruction's own arbitrary scale and origin, so this is how the viewer frames
    // its camera on load instead of assuming a fixed position works for every capture.
    computeBoundingBox(applySceneTransforms?: boolean, sceneIndex?: number): Box3;
    getSplatCount(includeSinceLastBuild?: boolean): number;
  }

  export class DropInViewer extends Group {
    splatMesh: SplatMesh | null;
    constructor(options?: DropInViewerOptions);
    addSplatScenes(scenes: SplatSceneOptions[]): Promise<void>;
    dispose(): Promise<void>;
  }
}
