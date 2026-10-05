/**
 * Crops a finished splat to a box, writing cropped copies of both of its files.
 *
 * The worker writes each splat twice: a lossless .ply for the Download button and a compressed .spz for the 3D viewer
 * (worker/pipeline/export.py). web/app/api/v1/splats/[splatId]/crop/route.ts calls cropSplatFiles() to stream both
 * from S3, keep only the Gaussians whose centers fall inside the box, and upload the results under new keys. The
 * originals are never modified, which is what lets an undo simply point back at them.
 *
 * Neither file is ever held in memory whole, because a large splat's .ply is bigger than the web task's memory. Each
 * file is streamed through in blocks into a temp file, and the temp file is uploaded once it is complete.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

import { insideCropBox } from "@/lib/cropBox";
import type { CropBox } from "@/lib/types";
import { HttpError } from "./httpError";
import { openSplatObject, putSplatObject } from "./s3";

const SPZ_MAGIC = 0x5053474e;
const SPZ_HEADER_BYTES = 16;
// How many higher-degree SH coefficients each color channel has, by SH degree.
const SPZ_SH_COEFFICIENTS = [0, 3, 8, 15];
// Gaussians per block. A .ply row is about 250 bytes, so a block stays a few MB.
const BLOCK_GAUSSIANS = 16_384;
const PLY_HEADER_END = "end_header\n";
const MAX_PLY_HEADER_BYTES = 64 * 1024;

/** Reads exact byte counts from a stream of chunks of any size. */
class ChunkReader {
  private readonly source: AsyncIterator<Buffer>;
  private pending: Buffer = Buffer.alloc(0);

  constructor(source: AsyncIterable<Buffer>) {
    this.source = source[Symbol.asyncIterator]();
  }

  /** The stream's next `bytes` bytes. Throws when the stream ends first. */
  async read(bytes: number): Promise<Buffer> {
    const chunks = [this.pending];
    let buffered = this.pending.length;
    while (buffered < bytes) {
      const next = await this.source.next();
      if (next.done) {
        throw new Error("The splat file ended early");
      }

      chunks.push(next.value);
      buffered += next.value.length;
    }

    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered);
    this.pending = all.subarray(bytes);

    return all.subarray(0, bytes);
  }

  /** Everything up to and including the first occurrence of marker, which must come within maxBytes. */
  async readThrough(marker: string, maxBytes: number): Promise<Buffer> {
    let buffered = this.pending;
    let end = buffered.indexOf(marker);
    while (end === -1) {
      if (buffered.length > maxBytes) {
        throw new Error("The splat file's header is too long");
      }

      const next = await this.source.next();
      if (next.done) {
        throw new Error("The splat file ended early");
      }

      buffered = Buffer.concat([buffered, next.value]);
      end = buffered.indexOf(marker);
    }

    this.pending = buffered.subarray(end + marker.length);

    return buffered.subarray(0, end + marker.length);
  }

  /** Reads the rest of the stream, so a pipeline sees its source end normally rather than cut short. */
  async drain(): Promise<void> {
    while (!(await this.source.next()).done) {
      // Discarded. Nothing follows the last section in either format.
    }
  }
}

/** Lets the event loop run health checks and other requests between blocks of a crop. */
async function pause(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

/** Yields the records of a section of count fixed-size records that mask keeps, a block at a time. */
async function* keptRecords(
  reader: ChunkReader,
  count: number,
  recordBytes: number,
  mask: Uint8Array,
  signal?: AbortSignal,
) {
  for (let start = 0; start < count; start += BLOCK_GAUSSIANS) {
    await pause(signal);
    const records = Math.min(BLOCK_GAUSSIANS, count - start);
    const block = await reader.read(records * recordBytes);
    const out = Buffer.allocUnsafe(records * recordBytes);
    let written = 0;
    for (let i = 0; i < records; i++) {
      if (mask[start + i]) {
        block.copy(out, written, i * recordBytes, (i + 1) * recordBytes);
        written += recordBytes;
      }
    }

    if (written > 0) {
      yield out.subarray(0, written);
    }
  }
}

function keptCount(mask: Uint8Array): number {
  let kept = 0;
  for (const keep of mask) {
    kept += keep;
  }

  return kept;
}

/**
 * Writes the Gaussians of a gzipped .spz (Niantic's format, as worker/pipeline/spz.py writes it) that sit inside the
 * box, and returns which of them were kept, in file order.
 *
 * An .spz stores each attribute as its own section covering every Gaussian, positions first. So the positions are
 * buffered and tested before anything is written, which is also what puts the kept count into the new header.
 *
 * The test uses the .spz's quantized positions, which sit within about 0.25 mm of the .ply's exact ones. A Gaussian
 * right on a face of the box can therefore land on either side of it.
 */
export async function cropSpz(
  input: Readable,
  output: Writable,
  box: CropBox,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  let mask = new Uint8Array(0);

  async function* crop(chunks: AsyncIterable<Buffer>) {
    const reader = new ChunkReader(chunks);
    const header = Buffer.from(await reader.read(SPZ_HEADER_BYTES));
    const version = header.readUInt32LE(4);
    const count = header.readUInt32LE(8);
    const shDegree = header.readUInt8(12);
    const fractionalBits = header.readUInt8(13);
    if (header.readUInt32LE(0) !== SPZ_MAGIC || (version !== 2 && version !== 3) || shDegree > 3) {
      throw new Error("The splat's .spz file isn't one this cropper reads");
    }

    const positions = await reader.read(count * 9);
    const scale = 1 / 2 ** fractionalBits;
    mask = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      if (i % BLOCK_GAUSSIANS === 0) {
        await pause(signal);
      }

      const x = positions.readIntLE(i * 9, 3) * scale;
      const y = positions.readIntLE(i * 9 + 3, 3) * scale;
      const z = positions.readIntLE(i * 9 + 6, 3) * scale;
      mask[i] = insideCropBox(x, y, z, box) ? 1 : 0;
    }

    const kept = keptCount(mask);
    if (kept === 0) {
      throw new HttpError(422, "The crop box doesn't contain any of the splat");
    }

    header.writeUInt32LE(kept, 8);
    yield header;
    yield* keptRecords(new ChunkReader(Readable.from([positions])), count, 9, mask, signal);

    const rotationBytes = version === 3 ? 4 : 3;
    // Opacity, color, scales, rotation, then the higher-degree SH coefficients for all three channels.
    for (const recordBytes of [1, 3, 3, rotationBytes, SPZ_SH_COEFFICIENTS[shDegree] * 3]) {
      if (recordBytes > 0) {
        yield* keptRecords(reader, count, recordBytes, mask, signal);
      }
    }

    await reader.drain();
  }

  await pipeline(input, createGunzip(), crop, createGzip(), output, { signal });

  return mask;
}

/**
 * Writes the rows of a binary .ply that mask keeps. The worker writes the .ply and the .spz from the same Gaussians in
 * the same order (worker/pipeline/export.py), so the mask cropSpz() returned applies row for row.
 */
export async function cropPly(
  input: Readable,
  output: Writable,
  mask: Uint8Array,
  signal?: AbortSignal,
): Promise<void> {
  async function* crop(chunks: AsyncIterable<Buffer>) {
    const reader = new ChunkReader(chunks);
    const lines = (await reader.readThrough(PLY_HEADER_END, MAX_PLY_HEADER_BYTES)).toString("latin1").split("\n");

    let binary = false;
    let count: number | null = null;
    let properties = 0;
    for (const line of lines) {
      const words = line.trim().split(/\s+/);
      if (words[0] === "format") {
        binary = words[1] === "binary_little_endian";
      } else if (words[0] === "element") {
        if (words[1] !== "vertex" || count !== null) {
          throw new Error("The splat's .ply file holds something besides its Gaussians");
        }

        count = Number(words[2]);
      } else if (words[0] === "property") {
        if (words[1] !== "float" && words[1] !== "float32") {
          throw new Error("The splat's .ply file has a property that isn't a float");
        }

        properties += 1;
      }
    }

    if (lines[0] !== "ply" || !binary) {
      throw new Error("The splat's .ply file isn't a binary little-endian .ply");
    }

    if (count !== mask.length) {
      throw new Error("The splat's .ply and .spz files don't hold the same Gaussians");
    }

    const header = lines.map(line => (line.startsWith("element vertex") ? `element vertex ${keptCount(mask)}` : line));
    yield Buffer.from(header.join("\n"), "latin1");
    yield* keptRecords(reader, count, properties * 4, mask, signal);
    await reader.drain();
  }

  await pipeline(input, crop, output, { signal });
}

/**
 * Crops the splat's .spz and .ply to the box and uploads the results to the given keys. Throws a 422 HttpError when
 * the box holds none of the splat, before anything is uploaded.
 */
export async function cropSplatFiles(
  source: { ply: string; spz: string },
  target: { ply: string; spz: string },
  box: CropBox,
  signal?: AbortSignal,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "splat-crop-"));
  try {
    const spzPath = path.join(dir, "result.spz");
    const plyPath = path.join(dir, "result.ply");

    const mask = await cropSpz(await openSplatObject(source.spz), createWriteStream(spzPath), box, signal);
    signal?.throwIfAborted();
    await cropPly(await openSplatObject(source.ply), createWriteStream(plyPath), mask, signal);
    signal?.throwIfAborted();

    await putSplatObject(target.spz, spzPath, "application/octet-stream");
    await putSplatObject(target.ply, plyPath, "application/octet-stream");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
