import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetchMock } = vi.hoisted(() => ({ apiFetchMock: vi.fn() }));
vi.mock("@/lib/apiFetch", () => ({ apiFetch: apiFetchMock }));

import { fileKey, type PickedPhoto } from "../measurePhoto";
import { type UploadProgress, uploadPhotos } from "../uploadPhotos";

async function getToken() {
  return "token";
}

function progress(reservedIds: ReadonlyMap<string, string> = new Map()): UploadProgress {
  return { reservedIds, onReserved: vi.fn(), onReservationLost: vi.fn(), onUploaded: vi.fn() };
}

function picked(name: string, overrides: Partial<PickedPhoto> = {}): PickedPhoto {
  return {
    file: new File([name], name, { type: "image/jpeg" }),
    width: 1,
    height: 1,
    thumbnail: new Blob([name]),
    takenAt: 0,
    sharpness: 0,
    ...overrides,
  };
}

describe("uploadPhotos", () => {
  beforeEach(() => {
    apiFetchMock.mockReset();
    apiFetchMock.mockImplementation(async (url: string, _method: string, _token: string, body: unknown) => {
      if (url.endsWith("/photos/reserve")) {
        return (body as unknown[]).map((_, index) => ({ photoId: `photo-${index + 1}` }));
      }

      const presign = url.match(/\/photos\/photo-(\d+)\/presign$/);
      if (presign) {
        return {
          photoPutUrl: `https://s3.example.com/${presign[1]}`,
          thumbnailPutUrl: `https://s3.example.com/${presign[1]}-small`,
        };
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

  it("reserves each photo with its size, dimensions and capture time", async () => {
    await uploadPhotos(
      "splat-1",
      [
        picked("a.jpg", { width: 3024, height: 4032, takenAt: Date.UTC(2026, 0, 1) }),
        picked("b.png", {
          file: new File(["bbb"], "b.png", { type: "image/png" }),
          width: 1920,
          height: 1080,
          takenAt: Date.UTC(2026, 0, 2),
        }),
      ],
      getToken,
      progress(),
    );

    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/reserve", "POST", "token", [
      {
        filename: "a.jpg",
        contentType: "image/jpeg",
        size: 5,
        width: 3024,
        height: 4032,
        takenAt: "2026-01-01T00:00:00.000Z",
      },
      {
        filename: "b.png",
        contentType: "image/png",
        size: 3,
        width: 1920,
        height: 1080,
        takenAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
  });

  it("asks for each photo's links with its thumbnail's size", async () => {
    await uploadPhotos("splat-1", [picked("a.jpg", { thumbnail: new Blob(["small"]) })], getToken, progress());

    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/photo-1/presign", "POST", "token", {
      thumbnailSize: 5,
    });
  });

  it("uploads each photo and its thumbnail before marking the photo uploaded", async () => {
    const small = new Blob(["a-small"]);
    await uploadPhotos("splat-1", [picked("a.jpg", { thumbnail: small })], getToken, progress());

    const puts = vi.mocked(fetch).mock.calls.map(([url, init]) => [url, init?.body]);
    expect(puts).toContainEqual(["https://s3.example.com/1-small", small]);
    expect(puts.map(([url]) => url)).toContain("https://s3.example.com/1");
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/photo-1/complete", "POST", "token");
  });

  it("asks for a token again before each request, since the uploads can outlast one", async () => {
    const tokens = ["first", "second", "third"];
    const nextToken = vi.fn(async () => tokens.shift() ?? null);

    await uploadPhotos("splat-1", [picked("a.jpg")], nextToken, progress());

    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/v1/splats/splat-1/photos/reserve",
      "POST",
      "first",
      expect.any(Array),
    );
    expect(apiFetchMock).toHaveBeenCalledWith(
      "/api/v1/splats/splat-1/photos/photo-1/presign",
      "POST",
      "second",
      expect.any(Object),
    );
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/photo-1/complete", "POST", "third");
  });

  it("signs a photo's links only once a slot frees up for its upload", async () => {
    const pending: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>(resolve => {
            pending.push(() => resolve(new Response(null)));
          }),
      ),
    );
    const presignCalls = () => apiFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/presign")).length;

    const upload = uploadPhotos(
      "splat-1",
      ["a", "b", "c", "d"].map(name => picked(`${name}.jpg`)),
      getToken,
      progress(),
    );

    await vi.waitFor(() => expect(pending).toHaveLength(6));
    expect(presignCalls()).toBe(3);

    // Finishing the first photo's two PUTs frees its slot for the fourth.
    for (const release of pending.splice(0, 2)) {
      release();
    }
    await vi.waitFor(() => expect(presignCalls()).toBe(4));

    vi.mocked(fetch).mockImplementation(async () => new Response(null));
    for (const release of pending.splice(0)) {
      release();
    }
    await upload;
  });

  it("reports each photo once the server has it, and not a photo whose upload failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("https://s3.example.com/2") ? new Response(null, { status: 500 }) : new Response(null),
      ),
    );
    const a = picked("a.jpg");
    const b = picked("b.jpg");
    const batch = progress();

    await expect(uploadPhotos("splat-1", [a, b], getToken, batch)).rejects.toThrow("1 of 2 photo uploads failed");
    expect(vi.mocked(batch.onUploaded).mock.calls).toEqual([[a]]);
  });

  it("stops with the sign-in error, not a failed photo, when the session ends partway through", async () => {
    const tokens = ["reserve", "presign"];
    const signedOutAfterTwo = vi.fn(async () => tokens.shift() ?? null);
    const batch = progress();

    await expect(uploadPhotos("splat-1", [picked("a.jpg")], signedOutAfterTwo, batch)).rejects.toThrow("Not signed in");
    expect(batch.onUploaded).not.toHaveBeenCalled();
  });

  it("starts no more photos after a lost session, and rejects only once the ones in flight finish", async () => {
    // Null once, as Clerk's getToken can be for a moment. The other lanes still get tokens afterwards.
    let calls = 0;
    const sessionToken = vi.fn(async () => {
      calls += 1;
      return calls === 5 ? null : "token";
    });
    const pending: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>(resolve => {
            pending.push(() => resolve(new Response(null)));
          }),
      ),
    );
    const batch = progress();
    let settled = false;

    const upload = uploadPhotos(
      "splat-1",
      ["a", "b", "c", "d"].map(name => picked(`${name}.jpg`)),
      sessionToken,
      batch,
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(pending).toHaveLength(6));

    for (const release of pending.splice(0)) {
      release();
    }

    await expect(upload).rejects.toThrow("Not signed in");
    expect(settled).toBe(true);
    const presigned = apiFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/presign"));
    expect(presigned).toHaveLength(3);
    expect(batch.onUploaded).toHaveBeenCalledTimes(2);
  });

  it("reuses a retry's reservations and reserves only the photos without one", async () => {
    const a = picked("a.jpg");
    const b = picked("b.jpg");
    const batch = progress(new Map([[fileKey(a.file), "photo-9"]]));

    await uploadPhotos("splat-1", [a, b], getToken, batch);

    const reserveBodies = apiFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/reserve")).map(c => c[3]);
    expect(reserveBodies).toEqual([[expect.objectContaining({ filename: "b.jpg" })]]);
    expect(apiFetchMock).toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/photo-9/complete", "POST", "token");
    expect(batch.onReserved).toHaveBeenCalledWith(b, "photo-1");
  });

  it("drops a reused reservation the API won't sign, so the next retry reserves it again", async () => {
    apiFetchMock.mockRejectedValueOnce(new Error("This photo's upload reservation has expired"));
    const a = picked("a.jpg");
    const batch = progress(new Map([[fileKey(a.file), "photo-9"]]));

    await expect(uploadPhotos("splat-1", [a], getToken, batch)).rejects.toThrow("1 of 1 photo upload failed");
    expect(batch.onReservationLost).toHaveBeenCalledWith(a);
  });

  it("sends nothing when there are no photos left to upload", async () => {
    await uploadPhotos("splat-1", [], getToken, progress());
    expect(apiFetchMock).not.toHaveBeenCalled();
  });

  it("fails a photo whose thumbnail upload fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("-small") ? new Response(null, { status: 403, statusText: "Forbidden" }) : new Response(null),
      ),
    );

    await expect(uploadPhotos("splat-1", [picked("a.jpg")], getToken, progress())).rejects.toThrow(
      "1 of 1 photo upload failed",
    );
    expect(apiFetchMock).not.toHaveBeenCalledWith("/api/v1/splats/splat-1/photos/photo-1/complete", "POST", "token");
  });
});
