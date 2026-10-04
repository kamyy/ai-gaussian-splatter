import { readFileSync } from "node:fs";
import { PassThrough, Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { cropPly, cropSpz } from "@/lib/server/cropSplat";
import { HttpError } from "@/lib/server/httpError";
import type { CropBox } from "@/lib/types";

const FRACTIONAL_BITS = 12;
const SH_DEGREE = 1;
const UNIT_BOX: CropBox = { center: [0, 0, 0], size: [2, 2, 2], quaternion: [0, 0, 0, 1] };

// Each Gaussian i gets the byte value i in every attribute but its position, so a kept Gaussian's attributes are easy
// to recognize in the output.
function spzFile(positions: [number, number, number][], { version = 3 } = {}): Buffer {
  const n = positions.length;
  const header = Buffer.alloc(16);
  header.writeUInt32LE(0x5053474e, 0);
  header.writeUInt32LE(version, 4);
  header.writeUInt32LE(n, 8);
  header.writeUInt8(SH_DEGREE, 12);
  header.writeUInt8(FRACTIONAL_BITS, 13);

  const packed = Buffer.alloc(n * 9);
  positions.forEach((position, i) => {
    position.forEach((value, axis) => {
      packed.writeIntLE(Math.round(value * 2 ** FRACTIONAL_BITS), i * 9 + axis * 3, 3);
    });
  });

  const section = (bytesEach: number) => Buffer.concat(positions.map((_p, i) => Buffer.alloc(bytesEach, i)));
  const rotationBytes = version === 3 ? 4 : 3;

  return gzipSync(
    Buffer.concat([header, packed, section(1), section(3), section(3), section(rotationBytes), section(9)]),
  );
}

function plyFile(rows: number[][], { format = "binary_little_endian" } = {}): Buffer {
  const header = [
    "ply",
    `format ${format} 1.0`,
    `element vertex ${rows.length}`,
    "property float x",
    "property float y",
    "property float z",
    "property float opacity",
    "end_header",
    "",
  ].join("\n");
  const body = Buffer.alloc(rows.length * 16);
  rows.forEach((row, i) => {
    row.forEach((value, j) => {
      body.writeFloatLE(value, i * 16 + j * 4);
    });
  });

  return Buffer.concat([Buffer.from(header), body]);
}

// Split into small chunks, so a header or record straddling two chunks is exercised.
function chunked(file: Buffer): Readable {
  const chunks: Buffer[] = [];
  for (let i = 0; i < file.length; i += 7) {
    chunks.push(file.subarray(i, i + 7));
  }

  return Readable.from(chunks);
}

async function collect(run: (output: PassThrough) => Promise<unknown>): Promise<Buffer> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  await run(output);

  return Buffer.concat(chunks);
}

describe("cropSpz", () => {
  it("keeps every attribute of the Gaussians inside the box, and only theirs", async () => {
    const positions: [number, number, number][] = [
      [0, 0, 0],
      [5, 0, 0],
      [0.5, -0.5, 0.5],
    ];
    let mask: Uint8Array = new Uint8Array(0);
    const out = gunzipSync(
      await collect(async output => {
        mask = await cropSpz(chunked(spzFile(positions)), output, UNIT_BOX);
      }),
    );

    expect([...mask]).toEqual([1, 0, 1]);
    expect(out.readUInt32LE(8)).toBe(2);
    expect(out.length).toBe(16 + 2 * (9 + 1 + 3 + 3 + 4 + 9));
    expect(out.readIntLE(16 + 9 + 3, 3) / 2 ** FRACTIONAL_BITS).toBeCloseTo(-0.5);
    // Every byte after the positions belongs to Gaussian 0 or Gaussian 2, never to Gaussian 1.
    expect([...out.subarray(16 + 18)].every(byte => byte === 0 || byte === 2)).toBe(true);
  });

  it("reads a version 2 file, whose rotations are 3 bytes", async () => {
    const out = gunzipSync(
      await collect(output =>
        cropSpz(
          chunked(
            spzFile(
              [
                [0, 0, 0],
                [9, 9, 9],
              ],
              { version: 2 },
            ),
          ),
          output,
          UNIT_BOX,
        ),
      ),
    );

    expect(out.length).toBe(16 + (9 + 1 + 3 + 3 + 3 + 9));
  });

  it("refuses a box that holds none of the splat with a 422", async () => {
    const error = await cropSpz(chunked(spzFile([[5, 5, 5]])), new PassThrough(), UNIT_BOX).catch(err => err);

    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(422);
  });

  it("crops a .spz the worker wrote, keeping the Gaussians inside the box", async () => {
    const file = readFileSync(new URL("../../../../worker/tests/fixtures/crop/result.spz", import.meta.url));
    let mask: Uint8Array = new Uint8Array(0);
    const out = gunzipSync(
      await collect(async output => {
        mask = await cropSpz(Readable.from([file]), output, UNIT_BOX);
      }),
    );

    expect([...mask]).toEqual([1, 0, 1]);
    expect(out.readUInt32LE(8)).toBe(2);
    const bits = out.readUInt8(13);
    const keptX = [0, 1].map(index => out.readIntLE(16 + index * 9, 3) / 2 ** bits);
    expect(keptX[0]).toBeCloseTo(0);
    expect(keptX[1]).toBeCloseTo(0.5);
  });

  it("stops when its signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      cropSpz(chunked(spzFile([[0, 0, 0]])), new PassThrough(), UNIT_BOX, controller.signal),
    ).rejects.toThrow("aborted");
  });

  it("refuses a file that isn't an .spz", async () => {
    await expect(cropSpz(Readable.from([gzipSync(Buffer.alloc(64))]), new PassThrough(), UNIT_BOX)).rejects.toThrow(
      "isn't one this cropper reads",
    );
  });
});

describe("cropPly", () => {
  it("keeps the rows the mask keeps and rewrites the vertex count", async () => {
    const rows = [
      [0, 0, 0, 1],
      [5, 0, 0, 2],
      [0.5, 0.5, 0.5, 3],
    ];
    const out = await collect(output => cropPly(chunked(plyFile(rows)), output, new Uint8Array([1, 0, 1])));

    const headerEnd = out.indexOf("end_header\n") + "end_header\n".length;
    expect(out.subarray(0, headerEnd).toString()).toContain("element vertex 2\n");
    const body = out.subarray(headerEnd);
    expect(body.length).toBe(2 * 16);
    expect([body.readFloatLE(12), body.readFloatLE(28)]).toEqual([1, 3]);
  });

  it("crops a .ply the worker wrote, in the same order as its .spz", async () => {
    const spz = readFileSync(new URL("../../../../worker/tests/fixtures/crop/result.spz", import.meta.url));
    const ply = readFileSync(new URL("../../../../worker/tests/fixtures/crop/result.ply", import.meta.url));
    let mask: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
    await collect(async output => {
      mask = await cropSpz(Readable.from([spz]), output, UNIT_BOX);
    });

    const out = await collect(output => cropPly(Readable.from([ply]), output, mask));
    const headerEnd = out.indexOf("end_header\n") + "end_header\n".length;
    const header = out.subarray(0, headerEnd).toString();
    expect(header).toContain("element vertex 2\n");
    const stride = header.split("\n").filter(line => line.startsWith("property ")).length * 4;
    const body = out.subarray(headerEnd);
    expect([body.readFloatLE(0), body.readFloatLE(stride)]).toEqual([0, 0.5]);
  });

  it("refuses a .ply whose Gaussians don't match the mask", async () => {
    await expect(cropPly(chunked(plyFile([[0, 0, 0, 1]])), new PassThrough(), new Uint8Array([1, 1]))).rejects.toThrow(
      "don't hold the same Gaussians",
    );
  });

  it("refuses an ASCII .ply", async () => {
    await expect(
      cropPly(chunked(plyFile([[0, 0, 0, 1]], { format: "ascii" })), new PassThrough(), new Uint8Array([1])),
    ).rejects.toThrow("binary little-endian");
  });
});
