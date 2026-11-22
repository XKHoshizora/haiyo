import { Readable } from "node:stream";
import { S3Client } from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { createBlobStore, fsBlobStore, s3BlobStore } from "../src/attachments/blob.ts";
import { loadConfig } from "../src/config.ts";
import { sniff } from "../src/attachments/sniff.ts";

// A real S3Client whose requests are intercepted before serialisation, so nothing leaves the process.
// This checks key handling and config wiring only. It is NOT a test against a real bucket.
function fakeClient(answer?: (name: string, input: any) => Record<string, unknown>) {
  const commands: { name: string; input: any }[] = [];
  const client = new S3Client({
    region: "r",
    endpoint: "http://s3.test",
    credentials: { accessKeyId: "k", secretAccessKey: "s" },
  });
  client.middlewareStack.add(
    (_next, context) => async (args) => {
      const name = String(context.commandName);
      commands.push({ name, input: args.input });
      if (answer) return { output: answer(name, args.input) } as any;
      return { output: name === "GetObjectCommand" ? { Body: Readable.from([Buffer.from("hi")]) } : {} } as any;
    },
    { step: "initialize", name: "captureOnly" },
  );
  return { client, commands };
}

const cfg = { endpoint: "http://s3.test", region: "r", bucket: "bkt", accessKeyId: "k", secretAccessKey: "s" };

describe("s3BlobStore (fake client)", () => {
  it("uses the configured bucket and the server-generated key, and counts bytes", async () => {
    const { client, commands } = fakeClient();
    const store = s3BlobStore(cfg, client);
    expect(await store.put("avatar-abc", Buffer.from("12345"))).toEqual({ size: 5 });
    await store.get("avatar-abc");
    await store.delete("avatar-abc");
    expect(commands.map((c) => [c.name, c.input.Bucket, c.input.Key])).toEqual([
      ["PutObjectCommand", "bkt", "avatar-abc"],
      ["GetObjectCommand", "bkt", "avatar-abc"],
      ["DeleteObjectCommand", "bkt", "avatar-abc"],
    ]);
  });

  it("rejects keys with path segments before talking to S3", async () => {
    const { client, commands } = fakeClient();
    const store = s3BlobStore(cfg, client);
    await expect(store.get("../x")).rejects.toThrow("invalid blob key");
    await expect(store.delete("a/b")).rejects.toThrow("invalid blob key");
    expect(commands).toHaveLength(0);
  });
});

/** The bytes of a stored object: byte n is n mod 251. */
const OBJECT = Buffer.from(Array.from({ length: 100 }, (_, n) => n % 251));
const read = async (stream: Readable) => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

describe("s3BlobStore ranged reads (fake client)", () => {
  /** What S3 answers a ranged GET with: a 206 body of just the slice (ContentRange and ContentLength say which). */
  const honest = (name: string, input: any) => {
    if (name !== "GetObjectCommand") return {};
    const m = /^bytes=(\d+)-(\d+)$/.exec(input.Range ?? "");
    if (!m) return { Body: Readable.from([OBJECT]), ContentLength: OBJECT.length };
    const [start, end] = [Number(m[1]), Number(m[2])];
    return { Body: Readable.from([OBJECT.subarray(start, end + 1)]), ContentLength: end - start + 1, ContentRange: `bytes ${start}-${end}/${OBJECT.length}` };
  };

  it("sends Range: bytes=start-end for a range, and no Range for a plain read; the 206 body is the slice, streamed", async () => {
    const { client, commands } = fakeClient(honest);
    const store = s3BlobStore(cfg, client);
    const slice = await store.get("att-x", { start: 10, end: 99 });
    expect(commands.at(-1)!.input.Range).toBe("bytes=10-99");
    expect(Buffer.compare(await read(slice), OBJECT.subarray(10, 100))).toBe(0);
    await store.get("att-x", { start: 0, end: 0 });
    expect(commands.at(-1)!.input.Range).toBe("bytes=0-0");
    const whole = await store.get("att-x");
    expect(commands.at(-1)!.input.Range).toBeUndefined();
    expect(Buffer.compare(await read(whole), OBJECT)).toBe(0);
  });

  it("the route's open-ended and suffix ranges arrive as the byte range they mean (the route resolves them against the size first)", async () => {
    const { client, commands } = fakeClient(honest);
    const store = s3BlobStore(cfg, client);
    await store.get("att-x", { start: 90, end: 99 }); // bytes=90-  of 100
    await store.get("att-x", { start: 50, end: 99 }); // bytes=-50  of 100
    expect(commands.map((c) => c.input.Range)).toEqual(["bytes=90-99", "bytes=50-99"]);
  });

  it("an S3-compatible service that answers a ranged GET with the WHOLE object (200, no ContentRange) never leaks the wrong bytes: only the slice is passed on", async () => {
    const { client } = fakeClient((name) => (name === "GetObjectCommand" ? { Body: Readable.from([OBJECT.subarray(0, 40), OBJECT.subarray(40)]), ContentLength: OBJECT.length } : {}));
    const store = s3BlobStore(cfg, client);
    const slice = await store.get("att-x", { start: 10, end: 59 });
    const bytes = await read(slice);
    expect(bytes.length).toBe(50);
    expect(Buffer.compare(bytes, OBJECT.subarray(10, 60))).toBe(0);
  });

  it("an answer whose Content-Range or length is not the slice asked for is refused, not served under a length it does not have", async () => {
    const wrong = fakeClient((name) => (name === "GetObjectCommand" ? { Body: Readable.from([OBJECT.subarray(0, 30)]), ContentLength: 30, ContentRange: `bytes 0-29/${OBJECT.length}` } : {}));
    await expect(s3BlobStore(cfg, wrong.client).get("att-x", { start: 10, end: 59 })).rejects.toThrow(/range/i);
  });

  it("a complete slice ends the stream by itself (both sides): it closes without anyone destroying it, the upstream gone", async () => {
    const upstream = Readable.from([OBJECT.subarray(0, 40), OBJECT.subarray(40)]);
    const { client } = fakeClient((name) => (name === "GetObjectCommand" ? { Body: upstream, ContentLength: OBJECT.length } : {}));
    const out = await s3BlobStore(cfg, client).get("att-x", { start: 10, end: 59 });
    const closed = new Promise<void>((resolve) => out.once("close", () => resolve()));
    expect((await read(out)).length).toBe(50);
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("the slice never closed")), 1000))]);
    expect(upstream.destroyed).toBe(true);
  });

  it("a whole-object answer SHORTER than the slice asked for is an error, not a short stream under a declared length", async () => {
    const { client } = fakeClient((name) => (name === "GetObjectCommand" ? { Body: Readable.from([OBJECT.subarray(0, 40)]), ContentLength: 40 } : {}));
    const out = await s3BlobStore(cfg, client).get("att-x", { start: 10, end: 59 });
    await expect(read(out)).rejects.toThrow(/fewer bytes|shorter/i);
  });

  it("the consumer going away mid-stream (the client aborted) destroys the upstream body, whole object or slice", async () => {
    for (const whole of [false, true]) {
      const upstream = new Readable({ read() {} });
      upstream.push(OBJECT.subarray(0, 20));
      const { client } = fakeClient((name) => (name === "GetObjectCommand" ? { Body: upstream, ...(whole ? { ContentLength: 100 } : { ContentLength: 50, ContentRange: "bytes 10-59/100" }) } : {}));
      const out = await s3BlobStore(cfg, client).get("att-x", { start: 10, end: 59 });
      await new Promise((resolve) => out.once("data", resolve));
      out.destroy();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect([whole, upstream.destroyed]).toEqual([whole, true]);
    }
  });

  it("an S3 error in the middle of the stream ends the consumer's stream with that error — and nothing is left unhandled", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);
    try {
      for (const whole of [false, true]) {
        const upstream = new Readable({ read() {} });
        upstream.push(OBJECT.subarray(0, 20));
        const { client } = fakeClient((name) => (name === "GetObjectCommand" ? { Body: upstream, ...(whole ? { ContentLength: 100 } : { ContentLength: 50, ContentRange: "bytes 10-59/100" }) } : {}));
        const out = await s3BlobStore(cfg, client).get("att-x", { start: 10, end: 59 });
        const ended = new Promise<unknown>((resolve) => out.once("error", resolve));
        out.resume();
        upstream.destroy(new Error("connection reset"));
        expect(String(await ended)).toContain("connection reset");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});

describe("blob store selection", () => {
  const base = { DATABASE_URL: "postgres://x", APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "x".repeat(32), PROVIDER_KEY_SECRET: "p".repeat(32) };
  it("uses the filesystem unless S3 is configured", () => {
    expect(typeof createBlobStore(loadConfig({ ...base, BLOB_DIR: "./tmp-blobs" })).put).toBe("function");
    expect(loadConfig({ ...base }).s3).toBeUndefined();
    const withS3 = loadConfig({
      ...base,
      S3_ENDPOINT: "http://s3.test",
      S3_REGION: "r",
      S3_BUCKET: "b",
      S3_ACCESS_KEY_ID: "k",
      S3_SECRET_ACCESS_KEY: "s",
    });
    expect(withS3.s3?.bucket).toBe("b");
    expect(fsBlobStore).toBeTypeOf("function");
  });
});

describe("sniff", () => {
  it("trusts bytes only", async () => {
    expect(await sniff(Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"))).toEqual({ mime: "image/png", inline: true });
    expect(await sniff(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;"))).toEqual({ mime: "image/gif", inline: true });
    expect(await sniff(Buffer.from("<html><script>"))).toEqual({ mime: "application/octet-stream", inline: false });
    expect(await sniff(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toEqual({
      mime: "application/octet-stream",
      inline: false,
    });
    expect(await sniff(Buffer.alloc(0))).toEqual({ mime: "application/octet-stream", inline: false });
  });
});
