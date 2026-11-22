import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline, Transform } from "node:stream";
import { afterAll, beforeEach } from "vitest";
import { fsBlobStore, type BlobStore } from "../../src/attachments/blob.ts";

export interface PutRecord {
  key: string;
  /** Got a stream (not a Buffer). */
  streamed: boolean;
  chunks: number;
  largestChunk: number;
  bytes: number;
  /** Set when the put settles. */
  outcome?: "stored" | "failed";
}

/**
 * An fs blob store on a temp dir (emptied before each test, removed after the file) that records how it
 * is used and can be made to fail deletes. Call at the top level of a test file.
 */
export function useProbeBlobs(prefix = "af-blobs-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const probe = {
    puts: [] as PutRecord[],
    /** Keys of every blob opened for reading, in order. */
    gets: [] as string[],
    /** The byte range each read asked for (null: the whole blob), in the order of `gets`. */
    ranges: [] as Array<{ start: number; end: number } | null>,
    /** Called when the server starts writing a blob, i.e. it is reading an upload's file part. */
    onPut: undefined as ((key: string) => void) | undefined,
    /** Deletes of these keys throw. */
    failDelete: new Set<string>(),
    /** The next this-many deletes (of any key) throw. */
    failNextDeletes: 0,
    /** Awaited before every read (after it is recorded in `gets`): it may wait, or throw to make the read fail. */
    beforeGet: undefined as ((key: string) => Promise<void> | void) | undefined,
  };
  beforeEach(() => {
    for (const f of readdirSync(dir)) rmSync(path.join(dir, f), { force: true });
    probe.puts = [];
    probe.gets = [];
    probe.ranges = [];
    probe.onPut = undefined;
    probe.failDelete.clear();
    probe.failNextDeletes = 0;
    probe.beforeGet = undefined;
  });

  const disk = fsBlobStore(dir);
  const blobs: BlobStore = {
    async put(key, body) {
      const rec: PutRecord = { key, streamed: !Buffer.isBuffer(body), chunks: 0, largestChunk: 0, bytes: 0 };
      probe.puts.push(rec);
      probe.onPut?.(key);
      let source = body;
      if (!Buffer.isBuffer(body)) {
        const spy = new Transform({
          transform(chunk: Buffer, _enc, done) {
            rec.chunks++;
            rec.largestChunk = Math.max(rec.largestChunk, chunk.length);
            rec.bytes += chunk.length;
            done(null, chunk);
          },
        });
        pipeline(body, spy, () => {});
        source = spy;
      } else {
        rec.bytes = body.length;
      }
      try {
        const out = await disk.put(key, source);
        rec.outcome = "stored";
        return out;
      } catch (err) {
        rec.outcome = "failed";
        throw err;
      }
    },
    get: async (key, range) => {
      probe.gets.push(key);
      probe.ranges.push(range ?? null);
      await probe.beforeGet?.(key);
      return disk.get(key, range);
    },
    async delete(key) {
      if (probe.failNextDeletes > 0 || probe.failDelete.has(key)) {
        if (probe.failNextDeletes > 0) probe.failNextDeletes--;
        throw Object.assign(new Error("simulated blob store outage"), { code: "EIO" });
      }
      await disk.delete(key);
    },
  };

  return {
    dir,
    blobs,
    probe,
    /** File names in the store's directory (blobs and partial `.part` files). */
    files: () => readdirSync(dir),
    /** Resolves when the server next starts writing a blob. */
    putStarted: () => new Promise<void>((resolve) => (probe.onPut = () => resolve())),
  };
}
