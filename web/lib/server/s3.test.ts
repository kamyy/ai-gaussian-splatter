import { describe, expect, it } from "vitest";

import { photoS3Key, presignPhotoUpload, presignSplatDownload } from "./s3";

// No AWS stubbing here: getSignedUrl signs locally and issues no request, so
// these run offline against fake credentials.

describe("photoS3Key", () => {
  it("formats the key as splats/<splatId>/photos/<photoId><ext>", () => {
    expect(photoS3Key("splat-1", "photo-1", ".jpg")).toBe("splats/splat-1/photos/photo-1.jpg");
  });
});

describe("presignPhotoUpload", () => {
  it("returns the key and a signed URL containing bucket and key", async () => {
    const { key, url } = await presignPhotoUpload("splat-1", "photo-1", ".jpg", "image/jpeg");

    expect(key).toBe("splats/splat-1/photos/photo-1.jpg");
    expect(url).toContain(process.env.UPLOADS_BUCKET);
    expect(url).toContain("splats/splat-1/photos/photo-1.jpg");
    expect(url).toContain("X-Amz-Signature=");
  });
});

describe("presignSplatDownload", () => {
  it("returns a signed URL containing bucket and key", async () => {
    const url = await presignSplatDownload("splats/splat-1/result.ply");

    expect(url).toContain(process.env.SPLATS_BUCKET);
    expect(url).toContain("splats/splat-1/result.ply");
    expect(url).toContain("X-Amz-Signature=");
  });
});
