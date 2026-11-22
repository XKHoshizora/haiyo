import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { fsBlobStore, newBlobKey } from "../src/attachments/blob.ts";
import { abandonedAfterMs, sweepPendingBlobs } from "../src/attachments/pending.ts";
import { api, signUp, TERMS } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";

// An fs store on a temp dir that can be made to fail deletes (tests/helpers/blobs.ts).
const { dir: blobDir, blobs, probe, files: blobFiles } = useProbeBlobs("af-blobs-");

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from("00000001000000010806000000", "hex"),
  Buffer.from("1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex"),
]);
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const HTML = Buffer.from("<html><script>alert(1)</script></html>");

const { app } = useApp({ blobs });
const held = async () => (await app.deps.db.query<{ key: string }>("select key from pending_blobs")).rows.map((r) => r.key);
const avatarKey = async (id: string) =>
  (await app.deps.db.query("select avatar_key from principals where id = $1", [id])).rows[0].avatar_key as string | null;

function put(cookie: string | null, body: Buffer, contentType = "image/png") {
  return app.inject({
    method: "PUT",
    url: "/api/me/avatar",
    headers: { ...(cookie ? { cookie } : {}), "content-type": contentType },
    payload: body,
  });
}

describe("lookup", () => {
  it("finds a principal by exact handle (case-insensitive) and not by prefix", async () => {
    const alice = await signUp(app, "alice");
    const bob = await signUp(app, "bobby");

    const hit = await api(app, alice, "GET", "/api/principals/lookup?handle=BOBBY");
    expect(hit.status).toBe(200);
    expect(hit.json).toEqual({ id: bob.id, handle: "bobby", displayName: "bobby", avatarVersion: 0 });

    const prefix = await api(app, alice, "GET", "/api/principals/lookup?handle=bob");
    expect(prefix.status).toBe(404);
    expect(prefix.json).toEqual({ error: "not_found" });

    const self = await api(app, alice, "GET", "/api/principals/lookup?handle=alice");
    expect(self.status).toBe(200);
    expect(self.json.id).toBe(alice.id);
  });

  it("rejects malformed handles, missing handle, and unauthenticated callers", async () => {
    const alice = await signUp(app, "alice");
    for (const q of ["handle=a", "handle=has%20space", "handle=%25", "", "handle=" + "a".repeat(25)]) {
      const r = await api(app, alice, "GET", `/api/principals/lookup?${q}`);
      expect(r.status, q).toBe(400);
      expect(r.json).toEqual({ error: "invalid_request" });
    }
    expect((await api(app, null, "GET", "/api/principals/lookup?handle=alice")).status).toBe(401);
  });

  it("offers no way to list users", async () => {
    const alice = await signUp(app, "alice");
    for (const url of ["/api/principals", "/api/principals/", "/api/users", "/api/principals/lookup/all"]) {
      expect((await api(app, alice, "GET", url)).status, url).toBe(404);
    }
  });
});

describe("display name", () => {
  it("changes only the caller's own name, trimmed", async () => {
    const alice = await signUp(app, "alice");
    const bob = await signUp(app, "bobby");
    const res = await api(app, alice, "PATCH", "/api/me", { displayName: "  Alice A.  ", id: bob.id });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ id: alice.id, handle: "alice", displayName: "Alice A.", avatarVersion: 0 });
    expect((await api(app, alice, "GET", "/api/me")).json.displayName).toBe("Alice A.");
    expect((await api(app, bob, "GET", "/api/me")).json.displayName).toBe("bobby");
  });

  it("has no route that takes a target id", async () => {
    const alice = await signUp(app, "alice");
    const bob = await signUp(app, "bobby");
    const res = await api(app, alice, "PATCH", `/api/principals/${bob.id}`, { displayName: "pwned" });
    expect(res.status).toBe(404);
    expect((await api(app, bob, "GET", "/api/me")).json.displayName).toBe("bobby");
  });

  it("validates length and control characters, and needs a session", async () => {
    const alice = await signUp(app, "alice");
    for (const displayName of ["", "   ", "x".repeat(41), "bad\u0000name", "line\nbreak", 5]) {
      const r = await api(app, alice, "PATCH", "/api/me", { displayName });
      expect(r.status, JSON.stringify(displayName)).toBe(400);
      expect(r.json).toEqual({ error: "invalid_request" });
    }
    expect((await api(app, alice, "PATCH", "/api/me", { displayName: "x".repeat(40) })).status).toBe(200);
    expect((await api(app, null, "PATCH", "/api/me", { displayName: "hi" })).status).toBe(401);
  });

  /** One rule for registration and renaming: 1–40 characters, one line, format characters removed. */
  const REFUSED = ["", "   ", "\u202e​", "x".repeat(41), "🙂".repeat(41), "bad\u0007name", "tab\tname", "line\nbreak", "para graph", "line sep", "\ud800",
    // Nothing left but joiners (or tag characters) once the rest is stripped.
    "\u200d", "\u200c\u200d", " \u200d ", "\u200b\u200d\u2060", "\u{e0067}\u{e007f}"];
  const CLEANED: Array<[string, string]> = [
    ["\u202eevil\u202c name", "evil name"],
    ["zero​width⁠joiner﻿", "zerowidthjoiner"],
    ["  ​ padded ​ ", "padded"],
    ["🙂".repeat(40), "🙂".repeat(40)],
    ["名前は四十文字まで", "名前は四十文字まで"],
    // Joiners and tag characters carry meaning and stay: emoji ZWJ sequences, flags, Persian/Indic text.
    ["\u{1F469}\u200d\u{1F4BB}", "\u{1F469}\u200d\u{1F4BB}"],
    ["\u{1F468}\u200d\u{1F469}\u200d\u{1F467}", "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}"],
    ["\u{1F3F3}\ufe0f\u200d\u{1F308}", "\u{1F3F3}\ufe0f\u200d\u{1F308}"],
    ["\u{1F3F4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}", "\u{1F3F4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"],
    ["\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645", "\u0645\u06cc\u200c\u062e\u0648\u0627\u0647\u0645"],
    ["\u0915\u094d\u200d\u0937", "\u0915\u094d\u200d\u0937"],
    // Everything else format-like still goes: bidi controls, ZWSP, word joiner, BOM, soft hyphen, ALM.
    ["a\u202ebc\u202c", "abc"],
    ["a\u202a\u202b\u202d\u2066\u2067\u2068\u2069\u200e\u200f\u061cb", "ab"],
    ["a\u200b\u2060\ufeff\u00adb\u200d", "ab\u200d"],
  ];

  it("follows the one rule on PATCH /api/me", async () => {
    const alice = await signUp(app, "alice");
    for (const displayName of REFUSED) {
      expect([displayName, await api(app, alice, "PATCH", "/api/me", { displayName })]).toEqual([displayName, { status: 400, json: { error: "invalid_request" } }]);
    }
    for (const [given, stored] of CLEANED) {
      expect([given, (await api(app, alice, "PATCH", "/api/me", { displayName: given })).json.displayName]).toEqual([given, stored]);
      expect((await api(app, alice, "GET", "/api/me")).json.displayName).toBe(stored);
    }
  });

  it("follows the same rule on registration", async () => {
    const { createInvite } = await import("../src/auth/invites.ts");
    let n = 0;
    const register = async (displayName: string) =>
      api(app, null, "POST", "/api/register", {
        inviteCode: await createInvite(app.deps.db, { ttlHours: 1 }),
        email: `reg${++n}@example.test`,
        password: "a good password",
        displayName,
        handle: `reg_${n}`,
        ...TERMS,
      });
    for (const displayName of REFUSED) {
      expect([displayName, await register(displayName)]).toEqual([displayName, { status: 400, json: { error: "invalid_request" } }]);
    }
    for (const [given, stored] of CLEANED) {
      expect((await register(given)).status).toBe(201);
      const { rows } = await app.deps.db.query("select display_name from principals where handle = $1", [`reg_${n}`]);
      expect([given, rows[0].display_name]).toEqual([given, stored]);
    }
  });
});

describe("avatars", () => {
  it("requires a session to fetch", async () => {
    const alice = await signUp(app, "alice");
    expect((await api(app, null, "GET", `/api/principals/${alice.id}/avatar`)).status).toBe(401);
  });

  it("generates an escaped initial-letter SVG when none is set", async () => {
    const alice = await signUp(app, "alice");
    const evil = await signUp(app, "evil");
    await app.deps.db.query("update principals set display_name = $2 where id = $1", [evil.id, '<&"x>']);

    const a = await app.inject({ method: "GET", url: `/api/principals/${alice.id}/avatar`, headers: { cookie: alice.cookie } });
    expect(a.statusCode).toBe(200);
    expect(a.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(a.headers["x-content-type-options"]).toBe("nosniff");
    expect(a.headers["cache-control"]).toMatch(/private/);
    expect(a.body).toContain(">A</text>");

    const e = await app.inject({ method: "GET", url: `/api/principals/${evil.id}/avatar`, headers: { cookie: alice.cookie } });
    expect(e.body).toContain(">&lt;</text>");
    expect(e.body).not.toContain("<&");
  });

  it("returns the same 404 for an unknown principal", async () => {
    const alice = await signUp(app, "alice");
    const r = await api(app, alice, "GET", "/api/principals/00000000-0000-4000-8000-000000000000/avatar");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "not_found" });
    expect((await api(app, alice, "GET", "/api/principals/not-a-uuid/avatar")).status).toBe(400);
  });

  it("stores an uploaded PNG, serves it with a sniffed type, and deletes the old blob on replace", async () => {
    const alice = await signUp(app, "alice");
    const bob = await signUp(app, "bobby");

    expect((await put(alice.cookie, PNG)).statusCode).toBe(200);
    const first = (await app.deps.db.query("select avatar_key from principals where id = $1", [alice.id])).rows[0].avatar_key;
    expect(first).toMatch(/^avatar-/);

    // Another signed-in user sees it; the declared type is irrelevant to what is served.
    const got = await app.inject({ method: "GET", url: `/api/principals/${alice.id}/avatar`, headers: { cookie: bob.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(got.rawPayload, PNG)).toBe(0);

    // Replace with a JPEG sent as octet-stream.
    expect((await put(alice.cookie, JPEG, "application/octet-stream")).statusCode).toBe(200);
    const second = (await app.deps.db.query("select avatar_key from principals where id = $1", [alice.id])).rows[0].avatar_key;
    expect(second).not.toBe(first);
    await expect(app.deps.blobs.get(first)).rejects.toMatchObject({ code: "ENOENT" });
    const again = await app.inject({ method: "GET", url: `/api/principals/${alice.id}/avatar`, headers: { cookie: bob.cookie } });
    expect(again.headers["content-type"]).toBe("image/jpeg");
  });

  it("HEAD answers like the GET without reading the stored image beyond its first bytes", async () => {
    const alice = await signUp(app, "alice");
    const bob = await signUp(app, "bobby");
    const big = Buffer.concat([PNG, Buffer.alloc(1_500_000)]);
    expect((await put(alice.cookie, big)).statusCode).toBe(200);

    const pulled: number[] = []; // bytes pulled from each blob opened
    const original = app.deps.blobs.get.bind(app.deps.blobs);
    const spy = vi.spyOn(app.deps.blobs, "get").mockImplementation(async (key) => {
      const source = await original(key);
      const at = pulled.push(0) - 1;
      return Readable.from(
        (async function* () {
          for await (const chunk of source as AsyncIterable<Buffer>) {
            pulled[at]! += chunk.length;
            yield chunk;
          }
        })(),
      );
    });
    try {
      const head = await app.inject({ method: "HEAD", url: `/api/principals/${alice.id}/avatar`, headers: { cookie: bob.cookie } });
      const get = await app.inject({ method: "GET", url: `/api/principals/${alice.id}/avatar`, headers: { cookie: bob.cookie } });
      expect(head.statusCode).toBe(200);
      expect(head.body).toBe("");
      expect(head.headers["content-type"]).toBe("image/png");
      expect(head.headers["content-type"]).toBe(get.headers["content-type"]);
      expect(head.headers["cache-control"]).toBe(get.headers["cache-control"]);
      expect(head.headers["x-content-type-options"]).toBe("nosniff");
      expect(get.rawPayload.length).toBe(big.length);
      expect(pulled[1]).toBe(big.length);
      expect(pulled).toHaveLength(2); // one blob opened per request
      expect(pulled[0]).toBeLessThan(200_000);
    } finally {
      spy.mockRestore();
    }

    // Generated avatar, unknown id, no session: the same decisions as the GET.
    const generated = await app.inject({ method: "HEAD", url: `/api/principals/${bob.id}/avatar`, headers: { cookie: alice.cookie } });
    const generatedGet = await app.inject({ method: "GET", url: `/api/principals/${bob.id}/avatar`, headers: { cookie: alice.cookie } });
    expect(generated.statusCode).toBe(200);
    expect(generated.headers["content-type"]).toMatch(/^image\/svg\+xml/);
    expect(generated.headers["content-length"]).toBe(String(generatedGet.rawPayload.length));
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await app.inject({ method: "HEAD", url: `/api/principals/${missing}/avatar`, headers: { cookie: alice.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: "HEAD", url: `/api/principals/${alice.id}/avatar` })).statusCode).toBe(401);
    expect((await app.inject({ method: "HEAD", url: "/api/principals/not-a-uuid/avatar", headers: { cookie: alice.cookie } })).statusCode).toBe(400);
  });

  it("refuses an HTML file named .png, and leaves the avatar untouched", async () => {
    const alice = await signUp(app, "alice");
    const res = await app.inject({
      method: "PUT",
      url: "/api/me/avatar?filename=evil.png",
      headers: { cookie: alice.cookie, "content-type": "image/png", "content-disposition": 'attachment; filename="evil.png"' },
      payload: HTML,
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual({ error: "invalid_request" });
    expect((await app.deps.db.query("select avatar_key from principals where id = $1", [alice.id])).rows[0].avatar_key).toBeNull();
  });

  it("refuses SVG, empty bodies, unsupported content types and unauthenticated uploads", async () => {
    const alice = await signUp(app, "alice");
    expect((await put(alice.cookie, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml")).statusCode).toBe(400);
    expect((await put(alice.cookie, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await put(alice.cookie, PNG, "text/html")).statusCode).toBe(415);
    expect((await put(null, PNG)).statusCode).toBe(401);
  });

  it("caps uploads at 2 MB, answering too_large", async () => {
    const alice = await signUp(app, "alice");
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    const res = await put(alice.cookie, big);
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "too_large" });
    const justOk = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 - PNG.length)]);
    expect((await put(alice.cookie, justOk)).statusCode).toBe(200);
  });

  it("falls back to the generated avatar if the stored blob has gone missing", async () => {
    const alice = await signUp(app, "alice");
    await put(alice.cookie, PNG);
    const key = (await app.deps.db.query("select avatar_key from principals where id = $1", [alice.id])).rows[0].avatar_key;
    await app.deps.blobs.delete(key);
    const got = await app.inject({ method: "GET", url: `/api/principals/${alice.id}/avatar`, headers: { cookie: alice.cookie } });
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toMatch(/^image\/svg\+xml/);
  });
});

describe("avatar blobs nothing references", () => {
  it("nothing stays held after uploads and replacements; a replaced avatar whose delete failed is held until the sweep removes it", async () => {
    const alice = await signUp(app, "alice");
    expect((await put(alice.cookie, PNG)).statusCode).toBe(200);
    const first = await avatarKey(alice.id);
    expect(await held()).toEqual([]);

    probe.failNextDeletes = 1; // the old avatar's delete fails
    expect((await put(alice.cookie, JPEG)).statusCode).toBe(200);
    const second = await avatarKey(alice.id);
    expect(await held()).toEqual([first]);
    expect(blobFiles().sort()).toEqual([first, second].sort());

    const sweep = () => sweepPendingBlobs({ db: app.deps.db, blobs }, abandonedAfterMs(app.deps.config));
    expect(await sweep()).toBe(0); // within the upload deadline
    await app.deps.db.query("update pending_blobs set created_at = now() - interval '1 day'");
    expect(await sweep()).toBe(1);
    expect(blobFiles()).toEqual([second]);
    expect(await held()).toEqual([]);
    const got = await app.inject({ method: "GET", url: `/api/principals/${alice.id}/avatar`, headers: { cookie: alice.cookie } });
    expect(got.headers["content-type"]).toBe("image/jpeg");

    // A refused upload (not an image) never wrote a blob; nothing is held.
    expect((await put(alice.cookie, HTML)).statusCode).toBe(400);
    expect(await held()).toEqual([]);
    expect(blobFiles()).toEqual([second]);
  });
});

describe("blob store key handling", () => {
  it("rejects keys that could escape the store directory", async () => {
    const store = fsBlobStore(blobDir);
    for (const key of ["../x", "a/b", "..", "", "a\\b", "/abs"]) {
      await expect(store.put(key, Buffer.from("x")), key).rejects.toThrow("invalid blob key");
    }
    expect(newBlobKey("att")).toMatch(/^att-[0-9a-f-]{36}$/);
  });
});
