import { describe, expect, it } from "vitest";

import { expandedBox } from "../expandedBox";

describe("expandedBox", () => {
  const area = { width: 400, height: 300 };

  it("grows a photo from its center when there is room", () => {
    expect(expandedBox({ left: 150, top: 100, width: 100, height: 80 }, area)).toEqual({
      left: -75,
      top: -60,
      width: 250,
      height: 200,
    });
  });

  it("keeps a photo at the area's edge inside the area", () => {
    expect(expandedBox({ left: 0, top: 0, width: 100, height: 80 }, area)).toMatchObject({ left: 0, top: 0 });
    expect(expandedBox({ left: 300, top: 220, width: 100, height: 80 }, area)).toMatchObject({ left: -150, top: -120 });
  });

  it("grows a wide photo only to the area's width", () => {
    expect(expandedBox({ left: 0, top: 0, width: 200, height: 50 }, area)).toEqual({
      left: 0,
      top: 0,
      width: 400,
      height: 100,
    });
  });

  it("grows a photo only to the area's height, keeping it inside the area", () => {
    expect(expandedBox({ left: 0, top: 50, width: 100, height: 80 }, { width: 400, height: 160 })).toEqual({
      left: 0,
      top: -50,
      width: 200,
      height: 160,
    });
  });

  it("leaves a photo in a one-row area at its own size", () => {
    expect(expandedBox({ left: 100, top: 0, width: 100, height: 80 }, { width: 400, height: 80 })).toEqual({
      left: 0,
      top: 0,
      width: 100,
      height: 80,
    });
  });
});
