import { describe, expect, it } from "vitest";

import { cameraOfTriangle } from "./CameraFrustums";

// Each camera is six triangles in the pick mesh.
describe("cameraOfTriangle", () => {
  it("maps triangles straight to cameras when none is selected", () => {
    expect(cameraOfTriangle(0, null)).toBe(0);
    expect(cameraOfTriangle(5, null)).toBe(0);
    expect(cameraOfTriangle(6, null)).toBe(1);
    expect(cameraOfTriangle(17, null)).toBe(2);
  });

  it("skips over the selected camera, which the pick mesh leaves out", () => {
    // Camera 1 is selected, so the mesh holds cameras 0, 2, 3, ...
    expect(cameraOfTriangle(5, 1)).toBe(0);
    expect(cameraOfTriangle(6, 1)).toBe(2);
    expect(cameraOfTriangle(12, 1)).toBe(3);
  });

  it("maps the first camera's triangles past a selected first camera", () => {
    expect(cameraOfTriangle(0, 0)).toBe(1);
  });
});
