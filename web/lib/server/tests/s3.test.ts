import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, describe, expect, it } from "vitest";

import {
  deleteSplatObjects,
  photoS3Key,
  presignPhotoDownload,
  presignPhotoUpload,
  presignSplatDownload,
  readSplatCameras,
} from "../s3";

// The presign tests need no AWS stubbing: getSignedUrl signs locally and issues no request, so they run offline
// against fake credentials. The rest stub the client.
const s3Mock = mockClient(S3Client);

afterEach(() => {
  s3Mock.reset();
});

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

describe("presignPhotoDownload", () => {
  it("returns a signed URL against UPLOADS_BUCKET, not SPLATS_BUCKET", async () => {
    const url = await presignPhotoDownload("splats/splat-1/photos/photo-1.jpg");

    expect(url).toContain(process.env.UPLOADS_BUCKET);
    expect(url).toContain("splats/splat-1/photos/photo-1.jpg");
    expect(url).toContain("X-Amz-Signature=");
  });
});

describe("readSplatCameras", () => {
  it("maps each worker camera's photo filename back to its photo id", async () => {
    const body = JSON.stringify({
      cameras: [
        {
          name: "photo-1.jpg",
          center: [1, 2, 3],
          rotation: [
            [1, 0, 0],
            [0, 1, 0],
            [0, 0, 1],
          ],
        },
      ],
    });
    s3Mock
      .on(GetObjectCommand, { Key: "splats/splat-1/cameras.json" })
      .resolves({ Body: { transformToString: async () => body } as never });

    expect(await readSplatCameras("splat-1")).toEqual([
      {
        photoId: "photo-1",
        center: [1, 2, 3],
        rotation: [
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      },
    ]);
  });

  it("returns null for a job reconstructed before the worker wrote cameras", async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error("missing"), { name: "NoSuchKey" }));

    expect(await readSplatCameras("splat-1")).toBeNull();
  });
});

describe("deleteSplatObjects", () => {
  it("deletes every page of the splat's prefix from both buckets", async () => {
    s3Mock
      .on(ListObjectsV2Command, { Bucket: process.env.UPLOADS_BUCKET })
      .resolvesOnce({ Contents: [{ Key: "splats/splat-1/photos/a.jpg" }], NextContinuationToken: "next" })
      .resolvesOnce({ Contents: [{ Key: "splats/splat-1/photos/b.jpg" }] });
    s3Mock
      .on(ListObjectsV2Command, { Bucket: process.env.SPLATS_BUCKET })
      .resolves({ Contents: [{ Key: "splats/splat-1/result.ply" }] });

    await deleteSplatObjects("splat-1");

    const listed = s3Mock.commandCalls(ListObjectsV2Command).map(call => call.args[0].input.Prefix);
    expect(new Set(listed)).toEqual(new Set(["splats/splat-1/"]));
    const deleted = s3Mock
      .commandCalls(DeleteObjectsCommand)
      .flatMap(call => call.args[0].input.Delete?.Objects?.map(object => object.Key));
    expect(deleted).toEqual([
      "splats/splat-1/photos/a.jpg",
      "splats/splat-1/photos/b.jpg",
      "splats/splat-1/result.ply",
    ]);
  });

  it("sends no delete for an empty prefix", async () => {
    s3Mock.on(ListObjectsV2Command).resolves({});

    await deleteSplatObjects("splat-1");

    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });
});
