import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

import { uploadPhotos } from "../uploadPhotos";

describe("uploadPhotos", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string) => {
      if (url.endsWith("/presign")) {
        return [
          {
            photoId: "photo-1",
            presignedPutUrl: "https://s3.example.com/1",
            s3Key: "k1",
            thumbnailPutUrl: "https://s3.example.com/1-small",
          },
          {
            photoId: "photo-2",
            presignedPutUrl: "https://s3.example.com/2",
            s3Key: "k2",
            thumbnailPutUrl: "https://s3.example.com/2-small",
          },
        ];
      }
      return undefined;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends each photo's dimensions and capture time with the presign request", async () => {
    await uploadPhotos(
      "splat-1",
      [
        {
          file: new File(["a"], "a.jpg", { type: "image/jpeg" }),
          width: 3024,
          height: 4032,
          thumbnail: new Blob(["a"]),
          takenAt: Date.UTC(2026, 0, 1),
        },
        {
          file: new File(["b"], "b.png", { type: "image/png" }),
          width: 1920,
          height: 1080,
          thumbnail: new Blob(["b"]),
          takenAt: Date.UTC(2026, 0, 2),
        },
      ],
      "token",
    );

    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/presign", "POST", "token", [
      { filename: "a.jpg", contentType: "image/jpeg", width: 3024, height: 4032, takenAt: "2026-01-01T00:00:00.000Z" },
      { filename: "b.png", contentType: "image/png", width: 1920, height: 1080, takenAt: "2026-01-02T00:00:00.000Z" },
    ]);
  });

  it("uploads each photo and its thumbnail before marking the photo uploaded", async () => {
    const small = new Blob(["a-small"]);
    await uploadPhotos(
      "splat-1",
      [
        {
          file: new File(["a"], "a.jpg", { type: "image/jpeg" }),
          width: 3024,
          height: 4032,
          thumbnail: small,
          takenAt: 0,
        },
      ],
      "token",
    );

    const puts = vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.body]);
    expect(puts).toContainEqual(["https://s3.example.com/1-small", small]);
    expect(puts.map(([url]) => url)).toContain("https://s3.example.com/1");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/photo-1/complete", "POST", "token");
  });

  it("fails a photo whose thumbnail upload fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("-small") ? new Response(null, { status: 403, statusText: "Forbidden" }) : new Response(null),
      ),
    );

    await expect(
      uploadPhotos(
        "splat-1",
        [
          {
            file: new File(["a"], "a.jpg", { type: "image/jpeg" }),
            width: 1,
            height: 1,
            thumbnail: new Blob(["a"]),
            takenAt: Date.UTC(2026, 0, 1),
          },
        ],
        "token",
      ),
    ).rejects.toThrow("1 of 1 photo upload failed");
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/photo-1/complete", "POST", "token");
  });
});
