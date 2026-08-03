import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";

import { objectExists, photoS3Key, presignPhotoUpload, presignSplatDownload } from "./s3";

// The presign tests need no AWS stubbing: getSignedUrl signs locally and issues
// no request. Only objectExists calls out, so only it gets a mocked client.
const s3Mock = mockClient(S3Client);

afterEach(() => {
  s3Mock.reset();
});

describe("photoS3Key", () => {
  it("formats the key as objects/<objectId>/photos/<photoId><ext>", () => {
    expect(photoS3Key("obj-1", "photo-1", ".jpg")).toBe("objects/obj-1/photos/photo-1.jpg");
  });
});

describe("presignPhotoUpload", () => {
  it("returns the key and a signed URL containing bucket and key", async () => {
    const { key, url } = await presignPhotoUpload("obj-1", "photo-1", ".jpg", "image/jpeg");

    expect(key).toBe("objects/obj-1/photos/photo-1.jpg");
    expect(url).toContain(process.env.UPLOADS_BUCKET);
    expect(url).toContain("objects/obj-1/photos/photo-1.jpg");
    expect(url).toContain("X-Amz-Signature=");
  });
});

describe("presignSplatDownload", () => {
  it("returns a signed URL containing bucket and key", async () => {
    const url = await presignSplatDownload("objects/obj-1/result.ply");

    expect(url).toContain(process.env.SPLATS_BUCKET);
    expect(url).toContain("objects/obj-1/result.ply");
    expect(url).toContain("X-Amz-Signature=");
  });
});

describe("objectExists", () => {
  it("is true when HeadObject succeeds", async () => {
    s3Mock.on(HeadObjectCommand).resolves({});
    await expect(objectExists("test-uploads", "objects/obj-1/photos/a.jpg")).resolves.toBe(true);
  });

  it("is false when the key is missing", async () => {
    const notFound = Object.assign(new Error("Not Found"), {
      name: "NotFound",
      $metadata: { httpStatusCode: 404 },
    });
    s3Mock.on(HeadObjectCommand).rejects(notFound);
    await expect(objectExists("test-uploads", "objects/obj-1/photos/missing.jpg")).resolves.toBe(false);
  });

  it("rethrows errors that are not a missing key", async () => {
    const denied = Object.assign(new Error("Access Denied"), {
      name: "AccessDenied",
      $metadata: { httpStatusCode: 403 },
    });
    s3Mock.on(HeadObjectCommand).rejects(denied);
    await expect(objectExists("test-uploads", "objects/obj-1/photos/a.jpg")).rejects.toThrow("Access Denied");
  });
});
