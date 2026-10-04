import { render } from "@testing-library/react";
import { useEffect } from "react";
import { Box3, PerspectiveCamera, Vector3 } from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CameraSelection } from "@/lib/hooks/useCameraFlight";
import { useCameraFlight } from "@/lib/hooks/useCameraFlight";
import { useSceneFraming } from "@/lib/hooks/useSceneFraming";
import type { CameraPose } from "@/lib/types";

const holder = vi.hoisted(() => ({
  frames: [] as Array<(state: unknown, delta: number) => void>,
  lookAt: [] as number[][],
}));

const camera = new PerspectiveCamera();
const position = new Vector3();
const target = new Vector3();
const controls = {
  updateCameraUp: vi.fn(),
  zoomTo: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  getPosition: (out: Vector3) => out.copy(position),
  getTarget: (out: Vector3) => out.copy(target),
  setLookAt: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
    holder.lookAt.push([x, y, z, tx, ty, tz]);
    position.set(x, y, z);
    target.set(tx, ty, tz);
  },
  distance: 1,
};

vi.mock("@react-three/fiber", () => ({
  useThree: (selector: (state: unknown) => unknown) =>
    selector({
      camera,
      controls,
      size: { width: 400, height: 300 },
      gl: { domElement: document.createElement("canvas") },
    }),
  useFrame: (callback: (state: unknown, delta: number) => void) => {
    holder.frames.push(callback);
  },
}));

const sceneUp = { current: null as Vector3 | null };

function photo(center: [number, number, number]): CameraPose {
  return {
    photoId: "p",
    center,
    rotation: [
      [1, 0, 0],
      [0, 0, 1],
      [0, -1, 0],
    ],
    width: 4,
    height: 3,
    fx: 4,
    fy: 4,
  };
}

function View({
  fromCameras,
  photoSelected,
  axisViewHoldsCamera = false,
  cameras,
  selectedCamera,
  fitBox,
}: {
  fromCameras: { target: Vector3; position: Vector3; up: Vector3 } | null;
  photoSelected: boolean;
  axisViewHoldsCamera?: boolean;
  cameras: CameraPose[];
  selectedCamera: CameraSelection | null;
  fitBox: boolean;
}) {
  const { sceneUpRef, onFirstLoad } = useSceneFraming(fromCameras, photoSelected, axisViewHoldsCamera);
  useCameraFlight(cameras, selectedCamera, sceneUpRef, fromCameras?.target ?? null);

  useEffect(() => {
    sceneUp.current = sceneUpRef.current?.clone() ?? null;
    if (fitBox) {
      onFirstLoad(new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1)));
    }
  });

  return null;
}

function runFrames(seconds: number) {
  const delta = 1 / 60;
  const steps = Math.round(seconds / delta);
  for (let i = 0; i < steps; i++) {
    for (const callback of holder.frames.slice(-2)) {
      callback(null, delta);
    }
  }
}

function controlListener(): () => void {
  const call = controls.addEventListener.mock.calls.find(([type]) => type === "control");
  if (!call) {
    throw new Error("no control listener");
  }

  return call[1] as () => void;
}

describe("opening camera", () => {
  beforeEach(() => {
    holder.frames.length = 0;
    holder.lookAt.length = 0;
    camera.up.set(0, -1, -0.6);
    camera.fov = 75;
    position.set(0, 0, 0);
    target.set(0, 0, 0);
    sceneUp.current = null;
    controls.addEventListener.mockClear();
    controls.updateCameraUp.mockClear();
  });

  it("places the opening photo immediately, and levels back to the camera's up when the framing has none", () => {
    const startingUp = camera.up.clone();
    render(
      <View
        fromCameras={null}
        photoSelected
        cameras={[photo([4, 5, 6])]}
        selectedCamera={{ index: 0, opening: true }}
        fitBox
      />,
    );

    expect(holder.lookAt.at(-1)?.slice(0, 3)).toEqual([4, 5, 6]);
    expect(sceneUp.current?.toArray()).toEqual(startingUp.toArray());
    expect(camera.up.angleTo(startingUp)).toBeGreaterThan(0.1);

    controlListener()();
    runFrames(0.4);

    expect(camera.up.angleTo(startingUp)).toBeLessThan(1e-4);
    expect(camera.fov).toBe(75);
  });

  it("keeps the framing's up, and does not move the camera to the framing position", () => {
    const framing = {
      target: new Vector3(0, 0, 0),
      position: new Vector3(0, 0, 10),
      up: new Vector3(0, 0, 1),
    };
    render(
      <View
        fromCameras={framing}
        photoSelected
        cameras={[photo([4, 5, 6])]}
        selectedCamera={{ index: 0, opening: true }}
        fitBox
      />,
    );

    expect(sceneUp.current?.toArray()).toEqual([0, 0, 1]);
    expect(holder.lookAt.some(([x, y, z]) => x === 0 && y === 0 && z === 10)).toBe(false);
    expect(holder.lookAt.at(-1)?.slice(0, 3)).toEqual([4, 5, 6]);
  });

  it("flies a later photo from the opening one", () => {
    const framing = {
      target: new Vector3(0, 0, 0),
      position: new Vector3(0, 0, 10),
      up: new Vector3(0, 1, 0),
    };
    const cameras = [photo([4, 5, 6]), photo([8, 0, 0])];
    const { rerender } = render(
      <View
        fromCameras={framing}
        photoSelected
        cameras={cameras}
        selectedCamera={{ index: 0, opening: true }}
        fitBox={false}
      />,
    );
    runFrames(1 / 60);
    holder.lookAt.length = 0;

    rerender(
      <View fromCameras={framing} photoSelected cameras={cameras} selectedCamera={{ index: 1 }} fitBox={false} />,
    );
    expect(holder.lookAt).toEqual([]);

    runFrames(0.8);

    expect(holder.lookAt.at(-1)?.slice(0, 3)).toEqual([8, 0, 0]);
  });

  it("flies the first photo a visitor picks", () => {
    const framing = {
      target: new Vector3(0, 0, 0),
      position: new Vector3(0, 0, 10),
      up: new Vector3(0, 1, 0),
    };
    render(
      <View
        fromCameras={framing}
        photoSelected
        cameras={[photo([4, 5, 6])]}
        selectedCamera={{ index: 0 }}
        fitBox={false}
      />,
    );

    expect(holder.lookAt).toEqual([]);

    runFrames(0.8);

    expect(holder.lookAt.at(-1)?.slice(0, 3)).toEqual([4, 5, 6]);
  });

  it("leaves the camera where a front, side or top view put it when the framing arrives", () => {
    const framing = {
      target: new Vector3(0, 0, 0),
      position: new Vector3(0, 0, 10),
      up: new Vector3(0, 0, 1),
    };
    const { rerender } = render(
      <View
        fromCameras={framing}
        photoSelected={false}
        axisViewHoldsCamera
        cameras={[]}
        selectedCamera={null}
        fitBox={false}
      />,
    );

    expect(sceneUp.current?.toArray()).toEqual([0, 0, 1]);
    expect(holder.lookAt).toEqual([]);

    rerender(
      <View
        fromCameras={framing}
        photoSelected={false}
        axisViewHoldsCamera={false}
        cameras={[]}
        selectedCamera={null}
        fitBox={false}
      />,
    );

    expect(holder.lookAt).toEqual([]);
  });
});
