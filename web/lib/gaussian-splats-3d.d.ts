// @mkkellogg/gaussian-splats-3d ships no type declarations. This covers only
// the DropInViewer surface actually used by web/components/viewer/SplatViewer.tsx
// (README: "DropInViewer class encapsulates Viewer and can be added to a
// Three.js scene like any other renderable").
declare module "@mkkellogg/gaussian-splats-3d" {
  import type { Group } from "three";

  export interface SplatSceneOptions {
    path: string;
    splatAlphaRemovalThreshold?: number;
    position?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
  }

  export interface DropInViewerOptions {
    gpuAcceleratedSort?: boolean;
    sharedMemoryForWorkers?: boolean;
  }

  export class DropInViewer extends Group {
    constructor(options?: DropInViewerOptions);
    addSplatScenes(scenes: SplatSceneOptions[]): Promise<void>;
    dispose(): Promise<void>;
  }
}
