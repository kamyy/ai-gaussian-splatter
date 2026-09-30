import { describe, expect, it } from "vitest";

import type { PickedPhoto } from "@/lib/measurePhoto";
import { findFlagged } from "../usePickedPhotos";

function photo(name: string, sharpness: number, width = 4032, height = 3024): PickedPhoto {
  return { file: new File(["x"], name), width, height, thumbnail: new Blob(), takenAt: 0, sharpness };
}

function sharpBatch(count: number) {
  return Array.from({ length: count }, (_, i) => photo(`${i}.jpg`, 100));
}

describe("findFlagged", () => {
  it("flags a photo far less sharp than the rest of the batch as blurry", () => {
    const flagged = findFlagged([...sharpBatch(9), photo("shaky.jpg", 20)]);

    expect([...flagged]).toStrictEqual([["shaky.jpg:1", "blurry"]]);
  });

  it("leaves a photo only somewhat softer than the rest alone", () => {
    expect(findFlagged([...sharpBatch(9), photo("soft.jpg", 50)]).size).toBe(0);
  });

  it("judges no blur in a batch too small to have a normal sharpness", () => {
    expect(findFlagged([...sharpBatch(6), photo("shaky.jpg", 1)]).size).toBe(0);
  });

  it("flags a photo whose long side is under the training size as low resolution, blurry or not", () => {
    const flagged = findFlagged([
      ...sharpBatch(9),
      photo("small.jpg", 100, 1200, 900),
      photo("small-portrait.jpg", 1, 900, 1200),
      photo("just-enough.jpg", 100, 1600, 1200),
    ]);

    expect(Object.fromEntries(flagged)).toStrictEqual({
      "small.jpg:1": "low_res",
      "small-portrait.jpg:1": "low_res",
    });
  });
});
