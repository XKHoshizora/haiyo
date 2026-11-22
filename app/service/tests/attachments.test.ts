import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newBlobKey } from "../src/attachments/blob.ts";
import { abandonedAfterMs, holdBlob, sweepPendingBlobs } from "../src/attachments/pending.ts";
import { contentDisposition, sanitizeFileName } from "../src/attachments/routes.ts";
import { MAX_CONCURRENT_UPLOADS } from "../src/attachments/slots.ts";
import { sweepOrphans } from "../src/attachments/store.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";
import { BOUNDARY, CLOSING, MULTIPART, multipart, destroyOpenRequests, openRequest, partHead, type Part } from "./helpers/multipart.ts";
import { closeAllSockets, connect, listen, type Push } from "./helpers/ws.ts";

// A blob store on a temp dir that records how it is used (tests/helpers/blobs.ts).
const { dir: blobDir, blobs, probe, files: blobFiles, putStarted } = useProbeBlobs("af-att-");

// A small per-file limit for the tests (the configured one is 1 GiB by default): the size rules are the same.
const LIMIT = 4 * 1024 * 1024;
const { app, db } = useApp({ blobs, config: { attachmentMaxBytes: LIMIT } });
afterEach(async () => {
  destroyOpenRequests();
  await closeAllSockets();
});

// --- fixtures and helpers ---------------------------------------------------------------------

const MB = 1024 * 1024;
const NOT_FOUND_BODY = '{"error":"not_found"}';
const INVALID = { error: "invalid_request" };
const RANDOM_ID = "00000000-0000-4000-8000-000000000000";

const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from("00000001000000010806000000", "hex"),
  Buffer.from("1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex"),
]);
const HTML = Buffer.from("<!doctype html><html><body><script>alert(document.cookie)</script></body></html>");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="5"/></svg>');
const SVG_WITH_PROLOG = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><circle r="5"/></svg>',
);
/** Bytes no sniffer recognises. */
const opaque = (n: number) => Buffer.concat([Buffer.from("plain bytes\n"), randomBytes(n)]);

async function people<const N extends string[]>(...names: N): Promise<{ [K in keyof N]: Actor }> {
  const out: Actor[] = [];
  for (const n of names) out.push(await signUp(app, n));
  return out as { [K in keyof N]: Actor };
}
const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);

async function uploadParts(who: Actor | null, conv: string, parts: Part[], contentType = MULTIPART) {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { ...(who ? { cookie: who.cookie } : {}), "content-type": contentType },
    payload: multipart(parts),
  });
  return { status: res.statusCode, body: res.body, json: res.body ? JSON.parse(res.body) : null };
}
const upload = (who: Actor | null, conv: string, data: Buffer, filename = "notes.bin", type = "application/octet-stream") =>
  uploadParts(who, conv, [{ name: "file", filename, type, data }]);
const download = (who: Actor | null, id: string) =>
  app.inject({ method: "GET", url: `/api/attachments/${id}`, headers: who ? { cookie: who.cookie } : {} });

let txn = 0;
const post = (who: Actor, conv: string, body: unknown) => api(app, who, "POST", `/api/conversations/${conv}/messages`, body);
const sendFile = (who: Actor, conv: string, attachmentId: string, extra: object = {}) =>
  post(who, conv, { attachmentId, clientTxn: `f${++txn}`, ...extra });
const say = (who: Actor, conv: string, text: string) => post(who, conv, { text, clientTxn: `t${++txn}` });
const add = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: target.id });
const remove = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "DELETE", `/api/conversations/${conv}/members/${target.id}`);
const isMessage = (conv: string, seq?: number) => (e: Push) =>
  e.type === "message" && e.message.conversationId === conv && (seq === undefined || e.message.seq === seq);
const backdate = (id: string, minutes: number) =>
  db.query("update attachments set created_at = now() - make_interval(mins => $2) where id = $1", [id, minutes]);
/** Keys of blobs held as possibly unreferenced (`pending_blobs`). */
const held = async () => (await db.query<{ key: string }>("select key from pending_blobs order by key")).rows.map((r) => r.key);
const backdateHeld = (key: string, ms: number) =>
  db.query("update pending_blobs set created_at = now() - $2::double precision * interval '1 millisecond' where key = $1", [key, ms]);
const sweepHeld = (log?: { error: (details: { err: unknown; key: string }, msg: string) => void }) =>
  sweepPendingBlobs({ db, blobs }, abandonedAfterMs(app.deps.config), log);

// --- tests ------------------------------------------------------------------------------------

describe("download under its own name", () => {
  it("GET and HEAD /api/attachments/:id/:name serve the same bytes and headers; the name in the path decides nothing", async () => {
    const [a, b, eve] = await people("alice", "bob", "eve");
    const { conversationId: dm } = await befriend(app, a, b);
    const up = await upload(a, dm, PNG, "海边 final.png", "image/png");
    await sendFile(a, dm, up.json.id);
    const plain = await download(b, up.json.id);
    const named = await app.inject({ method: "GET", url: `/api/attachments/${up.json.id}/${encodeURIComponent("别的名字.png")}`, headers: { cookie: b.cookie } });
    expect(named.statusCode).toBe(200);
    expect(Buffer.compare(named.rawPayload, PNG)).toBe(0);
    expect(named.headers["content-disposition"]).toBe(plain.headers["content-disposition"]);
    expect(named.headers["content-disposition"]).toContain("filename*=UTF-8''%E6%B5%B7%E8%BE%B9%20final.png");
    const head = await app.inject({ method: "HEAD", url: `/api/attachments/${up.json.id}/x.png`, headers: { cookie: b.cookie } });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-length"]).toBe(String(PNG.length));
    // Who may fetch it is unchanged: a stranger and a signed-out caller get the same 404 / 401 as on the plain route.
    const stranger = await app.inject({ method: "GET", url: `/api/attachments/${up.json.id}/x.png`, headers: { cookie: eve.cookie } });
    expect(stranger.statusCode).toBe((await download(eve, up.json.id)).statusCode);
    const anon = await app.inject({ method: "GET", url: `/api/attachments/${up.json.id}/x.png` });
    expect(anon.statusCode).toBe((await download(null, up.json.id)).statusCode);
  });
});

describe("upload, send, download", () => {
  it("member uploads, sends, another member downloads identical bytes", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const data = opaque(300_000);

    const up = await upload(a, dm, data, "notes.bin");
    expect(up.status).toBe(201);
    expect(up.json).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/), name: "notes.bin", size: data.length, inline: false });
    const id: string = up.json.id;

    const sent = await sendFile(a, dm, id, { text: "  see attached  " });
    expect(sent.status).toBe(201);
    expect(sent.json.message).toEqual({
      conversationId: dm,
      seq: 1,
      senderId: a.id,
      kind: "file",
      text: "see attached",
      attachment: { id, name: "notes.bin", size: data.length, inline: false },
      createdAt: expect.any(String),
    });
    const history = await api(app, b, "GET", `/api/conversations/${dm}/messages`);
    expect(history.json.messages).toEqual([sent.json.message]);

    for (const who of [b, a]) {
      const got = await download(who, id);
      expect(got.statusCode).toBe(200);
      expect(Buffer.compare(got.rawPayload, data)).toBe(0);
    }
    expect(probe.puts).toEqual([expect.objectContaining({ streamed: true, bytes: data.length })]);
    const row = await db.query("select message_id, uploader_id, conversation_id, size from attachments where id = $1", [id]);
    expect(row.rows).toEqual([{ message_id: "1", uploader_id: a.id, conversation_id: dm, size: String(data.length) }]);
  });

  it("download response headers are exactly the server's decision", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const data = opaque(1000);
    const id = (await upload(a, dm, data, "notes.bin", "image/png")).json.id;
    await sendFile(a, dm, id);

    const got = await download(b, id);
    expect(got.statusCode).toBe(200);
    expect(got.headers).toMatchObject({
      "content-type": "application/octet-stream",
      "content-length": String(data.length),
      "content-disposition": `attachment; filename="notes.bin"; filename*=UTF-8''notes.bin`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "sandbox; default-src 'none'",
      "cache-control": "private, no-store",
    });
  });

  it("HEAD answers with a download's status and headers without opening the blob; refusals are the same 404", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: dm } = await befriend(app, a, b);
    const data = opaque(1000);
    const id = (await upload(a, dm, data, "notes.bin")).json.id;
    const unsent = (await upload(a, dm, opaque(10), "unsent.bin")).json.id;
    await sendFile(a, dm, id);
    const head = (who: Actor | null, attachmentId: string) =>
      app.inject({ method: "HEAD", url: `/api/attachments/${attachmentId}`, headers: who ? { cookie: who.cookie } : {} });

    probe.gets = [];
    const res = await head(b, id);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe("");
    const { date: _d, ...headers } = res.headers;
    const { date: _g, connection: _c, ...getHeaders } = (await download(b, id)).headers;
    expect({ ...headers, connection: undefined }).toEqual({ ...getHeaders, connection: undefined });
    expect(headers["content-length"]).toBe(String(data.length));
    expect(probe.gets).toHaveLength(1); // the GET's only

    probe.gets = [];
    for (const [who, attachmentId] of [[c, id], [b, unsent], [a, unsent], [b, RANDOM_ID]] as const) {
      expect((await head(who, attachmentId)).statusCode).toBe(404);
    }
    expect((await head(null, id)).statusCode).toBe(401);
    expect(probe.gets).toEqual([]);
  });

  it("an HTML file is served as application/octet-stream with attachment disposition; a PNG is inline; an SVG never is", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const cases = [
      { data: HTML, name: "page.html", declared: "text/html", type: "application/octet-stream", inline: false },
      { data: HTML, name: "fake.png", declared: "image/png", type: "application/octet-stream", inline: false },
      { data: SVG, name: "logo.svg", declared: "image/svg+xml", type: "application/octet-stream", inline: false },
      { data: SVG_WITH_PROLOG, name: "prolog.svg", declared: "image/svg+xml", type: "application/octet-stream", inline: false },
      { data: PNG, name: "photo.png", declared: "text/html", type: "image/png", inline: true },
    ];
    for (const c of cases) {
      const up = await upload(a, dm, c.data, c.name, c.declared);
      expect([c.name, up.status, up.json.inline]).toEqual([c.name, 201, c.inline]);
      await sendFile(a, dm, up.json.id);
      const got = await download(b, up.json.id);
      expect([c.name, got.headers["content-type"]]).toEqual([c.name, c.type]);
      const disposition = c.inline ? "inline" : "attachment";
      expect(got.headers["content-disposition"]).toBe(`${disposition}; filename="${c.name}"; filename*=UTF-8''${c.name}`);
      expect(got.headers["x-content-type-options"]).toBe("nosniff");
      expect(got.headers["content-security-policy"]).toBe("sandbox; default-src 'none'");
      expect(Buffer.compare(got.rawPayload, c.data)).toBe(0);
    }
  });

  it("a Chinese file name survives the round trip in Content-Disposition", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const name = "季度报告（终稿）v2 ✓.pdf";
    const up = await upload(a, dm, opaque(10), name);
    expect(up.json.name).toBe(name);
    const sent = await sendFile(a, dm, up.json.id);
    expect(sent.json.message.attachment.name).toBe(name);

    const header = String((await download(b, up.json.id)).headers["content-disposition"]);
    expect(header).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9!#$&+\-.^_`|~%]+$/);
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(header)![1]!)).toBe(name);
  });

  it("file names are sanitised: path, control, bidi and format characters go; quotes cannot break the header", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    // Raw UTF-8, as a browser sends it; busboy decodes it.
    const up = await upload(a, dm, opaque(10), "../secret/in\u0007vo\u0001ice\u202Egnp.exe\u200B.txt");
    expect(up.json.name).toBe("invoicegnp.exe.txt");

    // The RFC 2231 form lets a client put anything in the name: quotes, semicolons, separators, bidi overrides.
    const tricky = await app.inject({
      method: "POST",
      url: `/api/conversations/${dm}/attachments`,
      headers: { cookie: a.cookie, "content-type": MULTIPART },
      payload: Buffer.concat([
        Buffer.from(
          `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename*=UTF-8''..%2Fa%22b%3B%20c%E2%80%AE.txt\r\n\r\n`,
        ),
        opaque(10),
        Buffer.from(CLOSING),
      ]),
    });
    expect(tricky.statusCode).toBe(201);
    const { id, name } = JSON.parse(tricky.body) as { id: string; name: string };
    expect(name).toBe('a"b; c.txt');
    await sendFile(a, dm, id);
    const header = String((await download(b, id)).headers["content-disposition"]);
    expect(header).toBe(`attachment; filename="a_b; c.txt"; filename*=UTF-8''a%22b%3B%20c.txt`);
  });

  it("sanitizeFileName: NFC, last path segment, no control/format/bidi characters, 120 characters, 'file' when empty", () => {
    expect(sanitizeFileName("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\a b.txt")).toBe("a b.txt");
    expect(sanitizeFileName("in\u0000vo\u0007ice\u202Etxt.exe")).toBe("invoicetxt.exe");
    expect(sanitizeFileName("zero\u200Bwidth\uFEFF\u2066x\u2069.txt")).toBe("zerowidthx.txt");
    expect(sanitizeFileName("line\r\nbreak\u2028.txt")).toBe("linebreak.txt");
    expect(sanitizeFileName("lone\ud800.txt")).toBe("lone.txt");
    expect(sanitizeFileName("cafe\u0301.txt")).toBe("caf\u00e9.txt");
    expect(sanitizeFileName("e\u200B\u0301.txt")).toBe("\u00e9.txt"); // NFC after stripping
    expect(sanitizeFileName("  spaced  .txt  ")).toBe("spaced  .txt");
    expect(sanitizeFileName("报告.pdf")).toBe("报告.pdf");
    expect(sanitizeFileName("x".repeat(200))).toBe("x".repeat(120));
    expect(sanitizeFileName("😀".repeat(130))).toBe("😀".repeat(120)); // characters, not UTF-16 units
    for (const empty of [undefined, "", "   ", "\u202E\u200B", ".", "..", "/", "a/", "dir\\"]) {
      expect([empty, sanitizeFileName(empty)]).toEqual([empty, "file"]);
    }
  });

  it("contentDisposition: ASCII fallback plus RFC 5987 UTF-8 name; no way to inject a header", () => {
    const name = 'a"b\\c;d%e\r\nf 报告(1)*\'.pdf';
    const header = contentDisposition(name, false);
    expect(header).toBe(
      "attachment; filename=\"a_b_c;d_e__f __(1)*'.pdf\"; filename*=UTF-8''a%22b%5Cc%3Bd%25e%0D%0Af%20%E6%8A%A5%E5%91%8A%281%29%2A%27.pdf",
    );
    expect(header).not.toMatch(/[\r\n]/);
    expect(decodeURIComponent(/filename\*=UTF-8''(.+)$/.exec(header)![1]!)).toBe(name);
    expect(contentDisposition("pic.png", true)).toBe(`inline; filename="pic.png"; filename*=UTF-8''pic.png`);
  });

  it("contentDisposition: a name with nothing ASCII to keep gets a meaningful fallback (file, with the real extension), filename* as it was", () => {
    expect(contentDisposition("体检报告.png", true)).toBe(`inline; filename="file.png"; filename*=UTF-8''%E4%BD%93%E6%A3%80%E6%8A%A5%E5%91%8A.png`);
    expect(contentDisposition("报告 (1).PDF", false)).toContain('filename="__ (1).PDF"'); // (a digit is something to keep)
    expect(contentDisposition("报告.PDF", false)).toContain('filename="file.PDF"');
    expect(contentDisposition("海边", false)).toContain('filename="file"');
    // A name that has letters or digits keeps them (the unsafe characters are still replaced).
    expect(contentDisposition("报告final.pdf", false)).toContain('filename="__final.pdf"');
    expect(contentDisposition("2026年.xlsx", false)).toContain('filename="2026_.xlsx"');
    // A non-ASCII extension is no extension for the fallback.
    expect(contentDisposition("笔记.文档", false)).toContain('filename="file"');
  });
});

describe("who can download", () => {
  it("outsider, late joiner (for a pre-join attachment), removed member and signed-out caller all get 404/401; the late joiner can fetch a post-join attachment", async () => {
    const [a, b, c, d, o] = await people("alice", "bob", "carol", "dave", "oscar");
    const g = await group(app, a, "team", [b, c]);
    const pre = (await upload(a, g, opaque(100), "pre.bin")).json.id;
    expect((await sendFile(a, g, pre)).status).toBe(201);
    await befriend(app, a, d);
    expect((await add(a, g, d)).status).toBe(201);
    const postJoin = (await upload(b, g, opaque(100), "post.bin")).json.id;
    expect((await sendFile(b, g, postJoin)).status).toBe(201);
    expect((await remove(a, g, c)).status).toBe(200);

    expect((await download(b, pre)).statusCode).toBe(200);
    for (const [who, id] of [
      [o, pre],
      [o, postJoin],
      [d, pre],
      [c, pre],
      [c, postJoin],
    ] as const) {
      const res = await download(who, id);
      expect([who.handle, res.statusCode, res.body]).toEqual([who.handle, 404, NOT_FOUND_BODY]);
    }
    expect((await download(null, pre)).statusCode).toBe(401);
    expect(JSON.parse((await download(null, pre)).body)).toEqual({ error: "unauthenticated" });
    const late = await download(d, postJoin);
    expect(late.statusCode).toBe(200);
    expect(late.rawPayload.length).toBe(112);
  });

  it("every refusal is the same 404, byte for byte: unknown id, other conversation, unsent (even for the uploader), late joiner, removed member, non-member", async () => {
    const [a, b, c, d, o] = await people("alice", "bob", "carol", "dave", "oscar");
    const { conversationId: ab } = await befriend(app, a, b);
    const g = await group(app, a, "team", [b, c]);
    const sentPre = (await upload(a, g, opaque(10))).json.id;
    await sendFile(a, g, sentPre);
    const unsent = (await upload(a, g, opaque(10))).json.id;
    const elsewhere = (await upload(a, ab, opaque(10))).json.id;
    await sendFile(a, ab, elsewhere);
    await befriend(app, a, d);
    await add(a, g, d);
    await remove(a, g, c);

    const reference = await download(a, RANDOM_ID);
    expect(reference.statusCode).toBe(404);
    expect(reference.body).toBe(NOT_FOUND_BODY);
    const cases: Array<[string, Actor, string]> = [
      ["unknown id", o, RANDOM_ID],
      ["unsent, uploader", a, unsent],
      ["unsent, member", b, unsent],
      ["unsent, upper-cased", a, unsent.toUpperCase()],
      ["late joiner, pre-join", d, sentPre],
      ["removed member", c, sentPre],
      ["non-member", o, sentPre],
      ["other conversation", d, elsewhere],
      ["other conversation, upper-cased", c, elsewhere.toUpperCase()],
    ];
    for (const [label, who, id] of cases) {
      const res = await download(who, id);
      expect([label, res.statusCode, res.body]).toEqual([label, 404, NOT_FOUND_BODY]);
      expect([label, res.headers["content-type"], res.headers["content-length"]]).toEqual([
        label,
        reference.headers["content-type"],
        reference.headers["content-length"],
      ]);
    }
    // Positive controls.
    expect((await download(b, sentPre)).statusCode).toBe(200);
    expect((await download(b, elsewhere.toUpperCase())).statusCode).toBe(200);
    expect((await download(a, "not-a-uuid")).statusCode).toBe(400);
  });

  it("uploaded but never sent → nobody can fetch it, including the uploader; sweep deletes row and blob", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const orphan = (await upload(a, dm, opaque(50))).json.id;
    const fresh = (await upload(a, dm, opaque(50))).json.id;
    const sent = (await upload(a, dm, opaque(50))).json.id;
    await sendFile(a, dm, sent);
    expect(blobFiles()).toHaveLength(3);

    for (const who of [a, b]) expect((await download(who, orphan)).body).toBe(NOT_FOUND_BODY);

    expect(await sweepOrphans({ db, blobs }, 60)).toBe(0); // nothing is old enough yet
    await backdate(orphan, 61);
    await backdate(sent, 120);
    expect(await sweepOrphans({ db, blobs }, 60)).toBe(1);
    expect((await db.query("select id from attachments order by created_at")).rows.map((r) => r.id).sort()).toEqual(
      [fresh, sent].sort(),
    );
    expect(blobFiles()).toHaveLength(2);
    expect((await download(b, sent)).statusCode).toBe(200);
    expect(await sweepOrphans({ db, blobs }, 60)).toBe(0);
  });

  it("sweep keeps a row whose blob could not be deleted and retries it next time", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const [x, y] = [(await upload(a, dm, opaque(5))).json.id, (await upload(a, dm, opaque(5))).json.id];
    await backdate(x, 90);
    await backdate(y, 90);
    const key = (await db.query("select blob_key from attachments where id = $1", [x])).rows[0].blob_key;
    probe.failDelete.add(key);

    const errors: unknown[] = [];
    const log = { error: (details: unknown) => void errors.push(details) };
    expect(await sweepOrphans({ db, blobs }, 60, log)).toBe(1);
    expect(errors).toEqual([expect.objectContaining({ attachmentId: x })]);
    expect((await db.query("select id from attachments")).rows).toEqual([{ id: x }]);
    expect(blobFiles()).toEqual([key]);

    probe.failDelete.clear();
    expect(await sweepOrphans({ db, blobs }, 60, log)).toBe(1);
    expect(await count("select count(*) n from attachments")).toBe(0);
    expect(blobFiles()).toEqual([]);
  });

  it("the attachments:sweep CLI removes unsent uploads older than --older-than minutes (default 60) and abandoned blobs", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const [old, recent] = [(await upload(a, dm, opaque(5))).json.id, (await upload(a, dm, opaque(5))).json.id];
    await backdate(old, 61);
    await backdate(recent, 30);
    // Blobs no row came to reference: one past the upload deadline (60 min + 1 min grace), one not yet.
    const [lost, inFlight] = [newBlobKey("att"), newBlobKey("att")];
    for (const key of [lost, inFlight]) {
      await holdBlob(db, key);
      await blobs.put(key, Buffer.from("orphan"));
    }
    await backdateHeld(lost, 62 * 60_000);
    await backdateHeld(inFlight, 50 * 60_000);

    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const env = {
      ...process.env,
      DATABASE_URL: testDatabaseUrl(),
      BLOB_DIR: blobDir,
      APP_ORIGIN: "http://localhost:5173",
      AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
      PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
      S3_ENDPOINT: "",
      S3_REGION: "",
      S3_BUCKET: "",
      S3_ACCESS_KEY_ID: "",
      S3_SECRET_ACCESS_KEY: "",
    };
    const run = (...args: string[]) => promisify(execFile)(process.execPath, [tsx, "src/cli.ts", "attachments:sweep", ...args], { cwd, env });

    expect((await run()).stdout).toContain("swept 1 unsent attachment(s) older than 60 minutes and 1 abandoned blob(s)");
    expect((await db.query("select id from attachments")).rows).toEqual([{ id: recent }]);
    expect(await held()).toEqual([inFlight]);
    expect(blobFiles()).toHaveLength(2);
    expect((await run("--older-than", "20")).stdout).toContain("swept 1 unsent attachment(s) older than 20 minutes and 0 abandoned blob(s)");
    expect(await count("select count(*) n from attachments")).toBe(0);
    expect(blobFiles()).toEqual([inFlight]);
  }, 30_000);
});

describe("blobs nothing references (pending_blobs)", () => {
  it("a successful upload leaves nothing held; a refused upload whose blob delete failed stays held until the sweep removes it", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const ok = await upload(a, dm, opaque(10));
    expect(ok.status).toBe(201);
    await sendFile(a, dm, ok.json.id);
    expect(await held()).toEqual([]);

    // Refused after its bytes were stored (an extra part), and the store fails the delete once.
    probe.failNextDeletes = 1;
    const errors: unknown[] = [];
    const refused = await uploadParts(a, dm, [
      { name: "file", filename: "x.bin", type: "application/octet-stream", data: opaque(10) },
      { name: "extra", data: "x" },
    ]);
    expect(refused.status).toBe(400);
    const key = probe.puts.at(-1)!.key;
    expect(await held()).toEqual([key]);
    expect(blobFiles()).toContain(key);

    expect(await sweepHeld()).toBe(0); // still within the upload deadline
    expect(blobFiles()).toContain(key);
    await backdateHeld(key, abandonedAfterMs(app.deps.config) + 1000);
    probe.failDelete.add(key);
    expect(await sweepHeld({ error: (d) => void errors.push(d) })).toBe(0); // fails again: stays held
    expect(errors).toEqual([expect.objectContaining({ key })]);
    expect(await held()).toEqual([key]);
    probe.failDelete.clear();
    expect(await sweepHeld()).toBe(1);
    expect(await held()).toEqual([]);
    expect(blobFiles()).not.toContain(key);
    expect((await download(b, ok.json.id)).statusCode).toBe(200);
  });

  it("a crash between writing a blob and its row, or in the middle of writing it, is cleaned up by the sweep", async () => {
    // What the route does before the row, then nothing (the process died).
    const [whole, partial] = [newBlobKey("att"), newBlobKey("att")];
    await holdBlob(db, whole);
    await blobs.put(whole, opaque(100));
    await holdBlob(db, partial);
    writeFileSync(path.join(blobDir, `${partial}.part`), "half a file"); // a write cut short
    expect(blobFiles().sort()).toEqual([whole, `${partial}.part`].sort());

    expect(await sweepHeld()).toBe(0);
    for (const key of [whole, partial]) await backdateHeld(key, abandonedAfterMs(app.deps.config) + 1000);
    expect(await sweepHeld()).toBe(2);
    expect(blobFiles()).toEqual([]);
    expect(await held()).toEqual([]);
  });

  it("the sweep never deletes the blob of an inserted attachment or of an upload still within its deadline", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);

    // An upload in progress: held, partly on disk.
    const started = putStarted();
    const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
    await open.write(partHead({ name: "file", filename: "slow.bin", type: "application/octet-stream" }));
    await open.fill(256 * 1024);
    await started;
    await vi.waitFor(() => expect(blobFiles()).toHaveLength(1));
    expect(await held()).toHaveLength(1);
    expect(await sweepHeld()).toBe(0);
    expect(blobFiles()).toHaveLength(1);
    await open.write(CLOSING);
    await open.end();
    const res = await open.response;
    expect(res.status).toBe(201);
    const id = JSON.parse(res.body).id as string;
    expect(await held()).toEqual([]); // released in the insert's transaction

    // Even a stray record for a referenced blob (a bug) never costs the blob.
    const key = (await db.query("select blob_key from attachments where id = $1", [id])).rows[0].blob_key as string;
    await holdBlob(db, key);
    await backdateHeld(key, abandonedAfterMs(app.deps.config) + 1000);
    const errors: unknown[] = [];
    expect(await sweepHeld({ error: (d) => void errors.push(d) })).toBe(0);
    expect(errors).toEqual([expect.objectContaining({ key })]);
    expect(await held()).toEqual([]);
    expect(blobFiles()).toEqual([key]);
    await sendFile(a, dm, id);
    expect((await download(b, id)).statusCode).toBe(200);
  });
});

describe("sending a file", () => {
  it("attachment id from another conversation or another uploader cannot be sent; nor one already sent, nor an unknown one", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: ab } = await befriend(app, a, b);
    const g = await group(app, a, "team", [b, c]);
    const inAb = (await upload(a, ab, opaque(10))).json.id;
    const byB = (await upload(b, g, opaque(10))).json.id;

    for (const [who, conv, id] of [
      [a, g, inAb], // another conversation
      [a, g, byB], // another uploader
      [c, g, byB],
      [a, ab, RANDOM_ID],
    ] as const) {
      expect(await sendFile(who, conv, id)).toMatchObject({ status: 400, json: INVALID });
    }
    expect(await count("select count(*) n from messages where kind = 'file'")).toBe(0);

    expect((await sendFile(a, ab, inAb)).status).toBe(201);
    expect(await sendFile(a, ab, inAb)).toMatchObject({ status: 400, json: INVALID }); // already sent
    expect(await sendFile(b, g, inAb)).toMatchObject({ status: 400, json: INVALID });
    expect(await count("select count(*) n from messages where kind = 'file'")).toBe(1);
  });

  it("two concurrent sends of the same attachment produce exactly one message", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    for (let round = 0; round < 5; round++) {
      const id = (await upload(a, dm, opaque(10))).json.id;
      const results = await Promise.all([sendFile(a, dm, id), sendFile(a, dm, id), sendFile(a, dm, id)]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400]);
      expect(await count("select count(*) n from messages where body->'attachment'->>'id' = $1", [id])).toBe(1);
      const winner = results.find((r) => r.status === 201)!.json.message.seq;
      expect(
        await count(
          "select m.seq n from attachments a join messages m on m.id = a.message_id where a.id = $1",
          [id],
        ),
      ).toBe(winner);
    }
  });

  it("a repeated clientTxn returns the stored file message and does not trip over the linked attachment", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const id = (await upload(a, dm, opaque(10))).json.id;
    const first = await post(a, dm, { attachmentId: id, clientTxn: "file-once" });
    expect(first.status).toBe(201);
    const again = await post(a, dm, { attachmentId: id, clientTxn: "file-once" });
    expect(again).toEqual({ status: 200, json: { duplicate: true, message: first.json.message } });
    // Still a duplicate after the pair can no longer send.
    await api(app, a, "DELETE", `/api/friends/${b.id}`);
    expect(await post(a, dm, { attachmentId: id, clientTxn: "file-once" })).toMatchObject({ status: 200, json: { duplicate: true } });
    expect(await count("select count(*) n from messages where kind = 'file'")).toBe(1);
  });

  it("the caption is optional (0–8000 characters after trimming); text alone still needs at least one", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await upload(a, dm, opaque(10), `f${i}.bin`)).json.id);
    const [id0, id1, id2, id3] = ids as [string, string, string, string];

    expect((await sendFile(a, dm, id0)).json.message).toMatchObject({ kind: "file", text: "", attachment: { id: id0 } });
    expect((await sendFile(a, dm, id1, { text: "   " })).json.message).toMatchObject({ kind: "file", text: "" });
    expect((await sendFile(a, dm, id2, { text: "x".repeat(8000) })).status).toBe(201);
    expect(await sendFile(a, dm, id3, { text: "x".repeat(8001) })).toMatchObject({ status: 400, json: INVALID });
    expect(await post(a, dm, { text: "   ", clientTxn: "empty" })).toMatchObject({ status: 400, json: INVALID });
    expect(await post(a, dm, { clientTxn: "nothing" })).toMatchObject({ status: 400, json: INVALID });
    // Search (next task) finds files by name through the message body.
    expect(await count("select count(*) n from messages where body->'attachment'->>'name' = 'f2.bin'")).toBe(1);
  });

  it("upper-case ids behave identically", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const up = await upload(a, dm.toUpperCase(), PNG, "pic.png");
    expect(up.status).toBe(201);
    const sent = await sendFile(a, dm.toUpperCase(), up.json.id.toUpperCase());
    expect(sent.status).toBe(201);
    expect(sent.json.message.attachment.id).toBe(up.json.id);
    const got = await download(b, up.json.id.toUpperCase());
    expect(got.statusCode).toBe(200);
    expect(got.headers["content-type"]).toBe("image/png");
  });
});

describe("upload refusals", () => {
  it("extra parts or fields, no file part, a misnamed part or a non-multipart body → 400, nothing stored", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const file: Part = { name: "file", filename: "a.bin", type: "application/octet-stream", data: opaque(10) };
    const bad: Array<[string, Part[]]> = [
      ["file + field", [file, { name: "caption", data: "hi" }]],
      ["field + file", [{ name: "caption", data: "hi" }, file]],
      ["two files", [file, { ...file, filename: "b.bin" }]],
      ["field only", [{ name: "file", data: "not a file" }]],
      ["no parts", []],
      ["misnamed", [{ ...file, name: "upload" }]],
    ];
    for (const [label, parts] of bad) {
      const res = await uploadParts(a, dm, parts);
      expect([label, res.status, res.json]).toEqual([label, 400, INVALID]);
    }
    const raw = (payload: string | Buffer, contentType: string) =>
      app.inject({
        method: "POST",
        url: `/api/conversations/${dm}/attachments`,
        headers: { cookie: a.cookie, "content-type": contentType },
        payload,
      });
    for (const [label, res] of [
      ["json", await raw(JSON.stringify({ file: "x" }), "application/json")],
      ["text", await raw("hello", "text/plain")],
      ["no boundary", await raw(multipart([file]), "multipart/form-data")],
      ["truncated", await raw(multipart([file]).subarray(0, 120), MULTIPART)],
    ] as const) {
      expect([label, res.statusCode, JSON.parse(res.body)]).toEqual([label, 400, INVALID]);
    }
    expect(await count("select count(*) n from attachments")).toBe(0);
    expect(blobFiles()).toEqual([]);
  });

  it("refuses non-members, unknown conversations, chats that cannot send and signed-out callers before reading the body", async () => {
    const [a, b, c, o] = await people("alice", "bob", "carol", "oscar");
    const { conversationId: ab } = await befriend(app, a, b);
    const { conversationId: ac } = await befriend(app, a, c);
    await api(app, a, "DELETE", `/api/friends/${b.id}`);
    await api(app, c, "PUT", `/api/blocks/${a.id}`);
    const data = opaque(1000);

    const sendRefusal = async (who: Actor, conv: string) => (await say(who, conv, "x")).json;
    for (const [who, conv] of [
      [o, ab],
      [o, RANDOM_ID],
      [a, RANDOM_ID],
    ] as const) {
      const res = await upload(who, conv, data);
      expect([res.status, res.body]).toEqual([404, NOT_FOUND_BODY]);
      expect(res.json).toEqual(await sendRefusal(who, conv)); // exactly what a send answers
    }
    expect(await upload(a, ab, data)).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "not_friends" } });
    expect((await upload(a, ab, data)).json).toEqual(await sendRefusal(a, ab));
    expect(await upload(a, ac, data)).toMatchObject({ status: 403, json: { error: "cannot_send", reason: "blocked" } });
    expect((await upload(null, ab, data)).status).toBe(401);
    expect(probe.puts).toEqual([]); // no body was ever streamed to storage
    expect(await count("select count(*) n from attachments")).toBe(0);

    // Over a real connection: the refusal arrives while most of a large body is still unsent.
    const open = await openRequest(app, { path: `/api/conversations/${ab}/attachments`, cookie: o.cookie });
    await open.write(partHead({ name: "file", filename: "big.bin", type: "application/octet-stream" }));
    await open.fill(256 * 1024);
    expect(await open.response).toEqual({ status: 404, body: NOT_FOUND_BODY });
    open.destroy();
    expect(probe.puts).toEqual([]);
  });

  it("upload that completes after the uploader was unfriended (direct) or removed (group) is refused and leaves no blob", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: dm } = await befriend(app, a, b);

    const race = async (conv: string, change: () => Promise<{ status: number }>) => {
      const started = putStarted();
      const open = await openRequest(app, { path: `/api/conversations/${conv}/attachments`, cookie: a.cookie });
      await open.write(partHead({ name: "file", filename: "late.bin", type: "application/octet-stream" }));
      await open.write(opaque(64 * 1024));
      await started; // the pre-check passed and the server is storing the bytes
      expect((await change()).status).toBe(200);
      await open.write(randomBytes(64 * 1024));
      await open.write(CLOSING);
      await open.end();
      return open.response;
    };

    expect(await race(dm, () => api(app, a, "DELETE", `/api/friends/${b.id}`))).toEqual({
      status: 403,
      body: JSON.stringify({ error: "cannot_send", reason: "not_friends" }),
    });
    expect(blobFiles()).toEqual([]);

    const g = await group(app, c, "team", [a, b]);
    expect(await race(g, () => remove(c, g, a))).toEqual({ status: 404, body: NOT_FOUND_BODY });
    expect(blobFiles()).toEqual([]);

    // Both uploads were stored in full before the final check refused them.
    const stored = 12 + 2 * 64 * 1024;
    expect(probe.puts.map((p) => p.bytes)).toEqual([stored, stored]);
    expect(await count("select count(*) n from attachments")).toBe(0);
    expect(await held()).toEqual([]);
  });

  it(`at most ${MAX_CONCURRENT_UPLOADS} uploads per principal at once: one more is 429; another principal is unaffected`, async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const running = [];
    for (let i = 0; i < MAX_CONCURRENT_UPLOADS; i++) {
      const started = putStarted();
      const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
      await open.write(partHead({ name: "file", filename: `slow${i}.bin`, type: "application/octet-stream" }));
      await open.fill(64 * 1024);
      await started;
      running.push(open);
    }
    expect(await upload(a, dm, opaque(10))).toMatchObject({ status: 429, json: { error: "rate_limited" } });
    expect((await upload(b, dm, opaque(10))).status).toBe(201);

    for (const open of running) {
      await open.write(CLOSING);
      await open.end();
    }
    expect((await Promise.all(running.map((o) => o.response))).map((r) => r.status)).toEqual([201, 201, 201]);
    expect((await upload(a, dm, opaque(10))).status).toBe(201); // the slots were given back
    expect(await held()).toEqual([]);
  });

  /** Opens a raw connection and sends an upload's request head, its part head and a few bytes of file. */
  async function rawUploadStart(who: Actor, conv: string): Promise<net.Socket> {
    const { port } = await listen(app);
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    const head = [
      `POST /api/conversations/${conv}/attachments HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      `Cookie: ${who.cookie}`,
      `Content-Type: ${MULTIPART}`,
      "Content-Length: 1048576",
    ].join("\r\n");
    await new Promise<void>((resolve) =>
      socket.write(`${head}\r\n\r\n${partHead({ name: "file", filename: "gone.bin", type: "application/octet-stream" })}abc`, () =>
        resolve(),
      ),
    );
    return socket;
  }

  it("a client that disconnects during the pre-check gives its slot back at once; three times, then a fourth upload succeeds", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    for (let round = 1; round <= 3; round++) {
      // Hold the server inside the pre-check: recording the blob key waits for this lock.
      const blocker = await db.pool.connect();
      try {
        await blocker.query("begin");
        await blocker.query("lock table pending_blobs in exclusive mode");
        const socket = await rawUploadStart(a, dm);
        await vi.waitFor(() => expect(app.deps.uploads.inProgress(a.id)).toBe(1)); // slot taken, handler waiting
        socket.destroy();
        // The slot comes back as soon as the connection closes, while the handler is still waiting.
        await vi.waitFor(() => expect(app.deps.uploads.inProgress(a.id)).toBe(0));
        await blocker.query("commit");
      } finally {
        blocker.release();
      }
      // The handler then finds its client gone instead of waiting for a body forever, and lets go of the key.
      await vi.waitFor(async () => expect(await held()).toEqual([]));
      expect([round, app.deps.uploads.inProgress()]).toEqual([round, 0]);
    }
    expect(blobFiles()).toEqual([]);
    expect(await upload(a, dm, opaque(10))).toMatchObject({ status: 201 });
    expect(app.deps.uploads.inProgress()).toBe(0);
  });

  it("dropping the connection right after the request head, three times, leaves no slot taken", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    for (let i = 0; i < 3; i++) (await rawUploadStart(a, dm)).destroy();
    await vi.waitFor(async () => {
      expect(app.deps.uploads.inProgress()).toBe(0);
      expect(await held()).toEqual([]);
    });
    expect(await upload(a, dm, opaque(10))).toMatchObject({ status: 201 });
    expect(app.deps.uploads.inProgress()).toBe(0);
    expect(await count("select count(*) n from attachments")).toBe(1);
  });

  it("a client that disconnects in the middle of an upload leaves no blob and no row", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const started = putStarted();
    const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
    await open.write(partHead({ name: "file", filename: "cut.bin", type: "application/octet-stream" }));
    await open.fill(512 * 1024);
    await started;
    await vi.waitFor(() => expect(blobFiles()).toHaveLength(1)); // the partial file is on disk
    open.destroy();
    await vi.waitFor(async () => {
      expect(blobFiles()).toEqual([]);
      expect(await held()).toEqual([]);
    }, { timeout: 5000 });
    expect(probe.puts).toHaveLength(1);
    expect(await count("select count(*) n from attachments")).toBe(0);
  });

  it("one byte over the limit is refused without buffering it in memory", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const total = LIMIT + 1 + MB; // well past the limit; the end of the body is never needed
    const withheld = 512 * 1024;

    const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
    await open.write(partHead({ name: "file", filename: "huge.bin", type: "application/octet-stream" }));
    await open.fill(total - withheld);
    // The answer comes while the last 512 KB are still held back: the server never needs (or holds) the whole body.
    expect(await open.response).toEqual({ status: 413, body: '{"error":"too_large"}' });
    await open.fill(withheld);
    await open.write(CLOSING);
    await open.end();

    expect(probe.puts).toHaveLength(1);
    const [put] = probe.puts;
    expect(put!.streamed).toBe(true);
    expect(put!.chunks).toBeGreaterThan(3);
    expect(put!.largestChunk).toBeLessThanOrEqual(MB);
    expect(put!.bytes).toBeLessThanOrEqual(LIMIT);
    expect(put!.bytes).toBeGreaterThan(LIMIT - MB);
    expect(blobFiles()).toEqual([]);
    expect(await count("select count(*) n from attachments")).toBe(0);
    expect(await held()).toEqual([]);
  }, 30_000);

  it("exactly the limit is accepted, and the same file one byte over is refused with 413 too_large", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const open = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
    await open.write(partHead({ name: "file", filename: "max.bin", type: "application/octet-stream" }));
    await open.fill(LIMIT);
    await open.write(CLOSING);
    await open.end();
    const res = await open.response;
    expect(res.status).toBe(201);
    expect(JSON.parse(res.body)).toMatchObject({ name: "max.bin", size: LIMIT, inline: false });
    expect(blobFiles()).toHaveLength(1);

    const over = await openRequest(app, { path: `/api/conversations/${dm}/attachments`, cookie: a.cookie });
    await over.write(partHead({ name: "file", filename: "over.bin", type: "application/octet-stream" }));
    await over.fill(LIMIT + 1);
    await over.write(CLOSING);
    await over.end();
    expect(await over.response).toEqual({ status: 413, body: '{"error":"too_large"}' });
    expect(blobFiles()).toHaveLength(1); // only the accepted one is kept
  }, 30_000);
});

describe("realtime", () => {
  it("file messages reach members' sockets with the attachment; a late joiner never receives a pre-join file", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    await befriend(app, a, d);
    const g = await group(app, a, "team", [b, c]);
    const sb = await connect(app, b);
    const sd = await connect(app, d);

    const pre = (await upload(a, g, opaque(20), "pre.bin")).json;
    const preMsg = (await sendFile(a, g, pre.id, { text: "before dave" })).json.message;
    const forB = await sb.next(isMessage(g, preMsg.seq));
    expect(forB.message).toEqual(preMsg);
    expect(forB.message.attachment).toEqual({ id: pre.id, name: "pre.bin", size: 32, inline: false });

    expect((await add(a, g, d)).status).toBe(201);
    const postUp = (await upload(c, g, PNG, "after.png")).json;
    const postMsg = (await sendFile(c, g, postUp.id)).json.message;
    const forD = await sd.next(isMessage(g, postMsg.seq));
    expect(forD.message.attachment).toEqual({ id: postUp.id, name: "after.png", size: PNG.length, inline: true });
    expect((await sb.next(isMessage(g, postMsg.seq))).message.attachment.id).toBe(postUp.id);

    // Nothing of the pre-join file reaches the late joiner: not pushed, not in sync, not downloadable.
    const seen = JSON.stringify(sd.events);
    expect(seen).not.toContain(pre.id);
    expect(seen).not.toContain("pre.bin");
    expect(JSON.stringify((await api(app, d, "GET", "/api/sync")).json)).not.toContain(pre.id);
    expect((await download(d, pre.id)).body).toBe(NOT_FOUND_BODY);
    expect((await download(d, postUp.id)).statusCode).toBe(200);
  });
});
