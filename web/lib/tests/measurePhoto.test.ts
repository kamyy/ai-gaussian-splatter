import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MEASURE_CONCURRENCY, measurePhoto, measurePhotos } from "../measurePhoto";

const { exifParseMock } = vi.hoisted(() => ({ exifParseMock: vi.fn() }));
vi.mock("exifr", () => ({ default: { parse: exifParseMock } }));

// jsdom has no OffscreenCanvas. This stand-in records the size each thumbnail was drawn at.
const canvasSizes: [number, number][] = [];
class FakeOffscreenCanvas {
  constructor(width: number, height: number) {
    canvasSizes.push([width, height]);
  }

  getContext() {
    return { drawImage: () => {}, imageSmoothingQuality: "low" };
  }

  async convertToBlob(options: { type: string }) {
    return new Blob(["thumbnail"], { type: options.type });
  }
}

describe("measurePhoto", () => {
  beforeEach(() => {
    exifParseMock.mockReset();
    exifParseMock.mockResolvedValue(undefined);
    canvasSizes.length = 0;
    vi.stubGlobal("OffscreenCanvas", FakeOffscreenCanvas);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the decoded size and a JPEG thumbnail, and releases the bitmap", async () => {
    const close = vi.fn();
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 3024, height: 4032, close })),
    );
    const file = new File(["a"], "a.jpg", { type: "image/jpeg" });

    const photo = await measurePhoto(file);
    expect(photo).toMatchObject({ file, width: 3024, height: 4032 });
    expect(photo?.thumbnail.type).toBe("image/jpeg");
    expect(close).toHaveBeenCalledOnce();
  });

  it("scales the thumbnail's long side to 640 and never scales a small photo up", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (file: File) =>
        file.name === "big.jpg"
          ? { width: 4032, height: 3024, close: () => {} }
          : { width: 300, height: 200, close: () => {} },
      ),
    );

    await measurePhoto(new File(["a"], "big.jpg"));
    await measurePhoto(new File(["b"], "small.jpg"));
    expect(canvasSizes).toEqual([
      [640, 480],
      [300, 200],
    ]);
  });

  it("takes the capture time from EXIF, falling back to the file's modified time", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => ({ width: 10, height: 10, close: () => {} })),
    );
    const taken = new Date(2025, 5, 1, 12, 30);
    exifParseMock.mockImplementation(async (file: File) =>
      file.name === "camera.jpg" ? { DateTimeOriginal: taken } : undefined,
    );

    const fromCamera = await measurePhoto(new File(["a"], "camera.jpg", { lastModified: 1 }));
    const noExif = await measurePhoto(new File(["b"], "screenshot.png", { lastModified: 1_700_000_000_000 }));
    exifParseMock.mockRejectedValueOnce(new Error("Unknown file format"));
    const unreadableExif = await measurePhoto(new File(["c"], "odd.jpg", { lastModified: 42 }));

    expect(fromCamera?.takenAt).toBe(taken.getTime());
    expect(noExif?.takenAt).toBe(1_700_000_000_000);
    expect(unreadableExif?.takenAt).toBe(42);
  });

  it("returns null for a photo the browser can't decode", async () => {
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async () => {
        throw new DOMException("The source image could not be decoded.", "InvalidStateError");
      }),
    );

    expect(await measurePhoto(new File(["b"], "b.heic", { type: "image/heic" }))).toBeNull();
  });

  it("measures many photos a few at a time, keeping their order", async () => {
    let inFlight = 0;
    let peak = 0;
    vi.stubGlobal(
      "createImageBitmap",
      vi.fn(async (file: File) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 1));
        inFlight -= 1;
        if (file.name === "3.heic") {
          throw new DOMException("The source image could not be decoded.", "InvalidStateError");
        }

        return { width: 100 + file.size, height: 100, close: () => {} };
      }),
    );
    const files = Array.from({ length: 10 }, (_, i) => new File(["x".repeat(i)], i === 3 ? "3.heic" : `${i}.jpg`));

    const measured = await measurePhotos(files);

    expect(peak).toBe(MEASURE_CONCURRENCY);
    expect(measured.map(photo => photo?.width ?? null)).toEqual([100, 101, 102, null, 104, 105, 106, 107, 108, 109]);
  });
});
