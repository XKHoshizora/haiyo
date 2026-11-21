import { afterEach, describe, expect, it } from "vitest";
import { abandonedAfterMs, sweepPendingBlobs } from "../src/attachments/pending.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { PNG, mustCreateAgent } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { holdThen, someoneWaits } from "./helpers/locks.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

const { blobs, probe, files: blobFiles } = useProbeBlobs("af-group-avatar-");
const { app, db } = useApp({ blobs });
afterEach(closeAllSockets);

const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const HTML = Buffer.from("<html><script>alert(1)</script></html>");
const FORBIDDEN = { error: "forbidden" };
const NOT_FOUND = { error: "not_found" };

const put = (who: Actor | null, conv: string, body: Buffer, contentType = "image/png") =>
  app.inject({
    method: "PUT",
    url: `/api/conversations/${conv}/avatar`,
    headers: { ...(who ? { cookie: who.cookie } : {}), "content-type": contentType },
    payload: body,
  });
const get = (who: Actor | null, conv: string) =>
  app.inject({ method: "GET", url: `/api/conversations/${conv}/avatar`, headers: who ? { cookie: who.cookie } : {} });
const remove = (who: Actor, conv: string) => api(app, who, "DELETE", `/api/conversations/${conv}/avatar`);
const row = async (conv: string) =>
  (await db.query<{ avatar_key: string | null; avatar_version: number }>("select avatar_key, avatar_version from conversations where id = $1", [conv])).rows[0]!;
const held = async () => (await db.query<{ key: string }>("select key from pending_blobs")).rows.map((r) => r.key);
const entry = async (who: Actor, conv: string) => (await api(app, who, "GET", `/api/conversations/${conv}`)).json;

async function team() {
  const a = await signUp(app, "alice");
  const b = await signUp(app, "bobby");
  const c = await signUp(app, "carol");
  const d = await signUp(app, "dave");
  const g = await group(app, a, "team", [b, c]);
  return { a, b, c, d, g };
}

describe("who may change a group's avatar", () => {
  it("the creator sets it; the members read it, with the version in their view of the group", async () => {
    const { a, b, g } = await team();
    expect(await entry(b, g)).not.toHaveProperty("avatarVersion");
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const stored = await row(g);
    expect(stored.avatar_key).toMatch(/^avatar-/);
    expect(stored.avatar_version).toBe(1);
    for (const who of [a, b]) {
      expect(await entry(who, g)).toMatchObject({ avatarVersion: 1 });
      const got = await get(who, g);
      expect(got.statusCode).toBe(200);
      expect(got.headers["content-type"]).toBe("image/png");
      expect(got.headers["cache-control"]).toMatch(/private/);
      expect(got.headers["x-content-type-options"]).toBe("nosniff");
      expect(got.rawPayload.equals(PNG)).toBe(true);
    }
    expect((await put(a, g, JPEG, "image/jpeg")).statusCode).toBe(200);
    expect((await row(g)).avatar_version).toBe(2);
    expect((await get(b, g)).headers["content-type"]).toBe("image/jpeg");
  });

  it("a member who is not the creator gets the refusal of any creator-only action, and nothing changes", async () => {
    const { a, b, g } = await team();
    expect((await put(b, g, PNG)).statusCode).toBe(403);
    expect(JSON.parse((await put(b, g, PNG)).body)).toEqual(FORBIDDEN);
    expect(await row(g)).toEqual({ avatar_key: null, avatar_version: 0 });
    expect(blobFiles()).toEqual([]);
    expect(await held()).toEqual([]);
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const before = await row(g);
    expect(await remove(b, g)).toEqual({ status: 403, json: FORBIDDEN });
    expect(await row(g)).toEqual(before);
    expect(blobFiles()).toEqual([before.avatar_key]);
  });

  it("a non-member can neither change it nor tell whether the group has one (the answers of a group that is not there)", async () => {
    const { a, d, g } = await team();
    const none = "00000000-0000-4000-8000-000000000000";
    const before = await get(d, g);
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const after = await get(d, g);
    for (const res of [before, after, await get(d, none)]) {
      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toEqual(NOT_FOUND);
    }
    expect(before.body).toBe(after.body);
    expect(JSON.parse((await put(d, g, PNG)).body)).toEqual(NOT_FOUND);
    expect((await put(d, g, PNG)).statusCode).toBe(404);
    expect(await remove(d, g)).toEqual({ status: 404, json: NOT_FOUND });
    expect(await remove(d, none)).toEqual({ status: 404, json: NOT_FOUND });
    // Not even a HEAD, nor a request without a session.
    expect((await app.inject({ method: "HEAD", url: `/api/conversations/${g}/avatar`, headers: { cookie: d.cookie } })).statusCode).toBe(404);
    expect((await get(null, g)).statusCode).toBe(401);
    expect((await put(null, g, PNG)).statusCode).toBe(401);
  });

  it("one who left or was removed reads it no more; a member of a group without one gets 404 too", async () => {
    const { a, b, c, g } = await team();
    expect((await get(b, g)).statusCode).toBe(404);
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    expect((await api(app, a, "DELETE", `/api/conversations/${g}/members/${c.id}`)).status).toBe(200);
    expect((await get(c, g)).statusCode).toBe(404);
    expect((await get(b, g)).statusCode).toBe(200);
    expect((await api(app, b, "DELETE", `/api/conversations/${g}/members/${b.id}`)).status).toBe(200);
    expect((await get(b, g)).statusCode).toBe(404);
  });

  it("a direct chat, an Agent's conversation and a closed group have none: 404 for every verb", async () => {
    const { a, g } = await team();
    const agent = await mustCreateAgent(app, a);
    const entries = (await api<{ conversations: { id: string; type: string }[] }>(app, a, "GET", "/api/sync")).json.conversations;
    const direct = entries.find((c) => c.type === "direct")!.id;
    const agentChat = entries.find((c) => c.type === "agent")!.id;
    expect(agent.id).toBeTruthy();
    for (const conv of [direct, agentChat]) {
      expect((await put(a, conv, PNG)).statusCode, conv).toBe(404);
      expect((await get(a, conv)).statusCode, conv).toBe(404);
      expect(await remove(a, conv)).toMatchObject({ status: 404 });
    }
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    await db.query("update conversations set closed_at = now() where id = $1", [g]);
    expect((await put(a, g, PNG)).statusCode).toBe(404);
    expect(await remove(a, g)).toMatchObject({ status: 404 });
    expect((await get(a, g)).statusCode).toBe(404); // a closed group is read by nobody
  });

  it("a group that closes (its last person leaves) drops its avatar: the blob is deleted and nothing stays held", async () => {
    const { a, b, c, g } = await team();
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    expect(blobFiles().length).toBe(1);
    for (const who of [a, b, c]) expect((await api(app, who, "DELETE", `/api/conversations/${g}/members/${who.id}`)).status).toBe(200);
    expect(await row(g)).toEqual({ avatar_key: null, avatar_version: 2 });
    expect(blobFiles()).toEqual([]);
    expect(await held()).toEqual([]);
  });

  it("a group that closes with a delete that fails holds the old blob for the sweep", async () => {
    const { a, b, c, g } = await team();
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const key = (await row(g)).avatar_key!;
    probe.failNextDeletes = 1;
    for (const who of [a, b, c]) expect((await api(app, who, "DELETE", `/api/conversations/${g}/members/${who.id}`)).status).toBe(200);
    expect(await held()).toEqual([key]);
  });

  it("when the creator leaves, the new creator may change it and the old one may not", async () => {
    const { a, b, c, g } = await team();
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    expect((await api(app, a, "DELETE", `/api/conversations/${g}/members/${a.id}`)).status).toBe(200);
    const next = (await db.query<{ creator_id: string }>("select creator_id from conversations where id = $1", [g])).rows[0]!.creator_id;
    const [heir, other] = next === b.id ? [b, c] : [c, b];
    expect((await put(other, g, PNG)).statusCode).toBe(403);
    expect((await put(heir, g, JPEG, "image/jpeg")).statusCode).toBe(200);
    expect((await put(a, g, PNG)).statusCode).toBe(404);
  });
});

describe("who is asking is checked before a blob is written", () => {
  it("a member who is not the creator, a non-member and an unknown id write no blob; the answers do not depend on the bytes", async () => {
    const { a, b, d, g } = await team();
    const none = "00000000-0000-4000-8000-000000000000";
    probe.puts.length = 0;
    expect((await put(b, g, PNG)).statusCode).toBe(403);
    expect((await put(d, g, PNG)).statusCode).toBe(404);
    expect((await put(d, none, PNG)).statusCode).toBe(404);
    // Bad bytes from a non-member are the answer of a non-member, not 400.
    expect((await put(d, g, HTML)).statusCode).toBe(404);
    expect((await put(b, g, HTML)).statusCode).toBe(403);
    expect(probe.puts).toEqual([]);
    expect(blobFiles()).toEqual([]);
    expect((await put(a, g, HTML)).statusCode).toBe(400);
  });

  it("the sweep's question about a key is answered by an index on the group's avatar key", async () => {
    const { rows } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where indexname = 'conversations_avatar_key_idx'");
    expect(rows[0]?.indexdef).toContain("avatar_key");
  });
});

describe("what is accepted", () => {
  it("decides by the bytes: HTML named image/png, SVG, GIF and an empty body are 400 and leave things as they were; another content type is 415", async () => {
    const { a, g } = await team();
    expect((await put(a, g, HTML)).statusCode).toBe(400);
    expect(JSON.parse((await put(a, g, HTML)).body)).toEqual({ error: "invalid_request" });
    expect((await put(a, g, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml")).statusCode).toBe(400);
    expect((await put(a, g, Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;"), "image/gif")).statusCode).toBe(400);
    expect((await put(a, g, Buffer.alloc(0))).statusCode).toBe(400);
    expect((await put(a, g, PNG, "text/html")).statusCode).toBe(415);
    expect(await row(g)).toEqual({ avatar_key: null, avatar_version: 0 });
    expect(blobFiles()).toEqual([]);
    expect(await held()).toEqual([]);
  });

  it("caps uploads at 2 MB (too_large); exactly 2 MB is fine", async () => {
    const { a, g } = await team();
    const res = await put(a, g, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]));
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: "too_large" });
    expect(await row(g)).toEqual({ avatar_key: null, avatar_version: 0 });
    expect((await put(a, g, Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024 - PNG.length)]))).statusCode).toBe(200);
  });
});

describe("the blobs of a group's avatar", () => {
  it("nothing stays held; a replaced one is deleted; one whose delete failed is held until the sweep, which never takes the current one", async () => {
    const { a, g } = await team();
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const first = (await row(g)).avatar_key!;
    expect(await held()).toEqual([]);
    expect(blobFiles()).toEqual([first]);

    expect((await put(a, g, JPEG, "image/jpeg")).statusCode).toBe(200);
    const second = (await row(g)).avatar_key!;
    expect(blobFiles()).toEqual([second]);
    expect(await held()).toEqual([]);

    probe.failNextDeletes = 1;
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const third = (await row(g)).avatar_key!;
    expect(await held()).toEqual([second]);
    expect(blobFiles().sort()).toEqual([second, third].sort());

    // Even the current avatar's key, wrongly held, survives the sweep (it is referenced).
    await db.query("insert into pending_blobs (key) values ($1)", [third]);
    await db.query("update pending_blobs set created_at = now() - interval '1 day'");
    const sweep = () => sweepPendingBlobs({ db, blobs }, abandonedAfterMs(app.deps.config), { error: () => {} });
    expect(await sweep()).toBe(1);
    expect(blobFiles()).toEqual([third]);
    expect(await held()).toEqual([]);
    expect((await get(a, g)).statusCode).toBe(200);
  });

  it("removing releases the blob, bumps the version, and the group looks as it did before; removing again changes nothing", async () => {
    const { a, b, g } = await team();
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const key = (await row(g)).avatar_key!;
    expect(await remove(a, g)).toEqual({ status: 200, json: { ok: true } });
    expect(await row(g)).toEqual({ avatar_key: null, avatar_version: 2 });
    expect(blobFiles()).toEqual([]);
    expect(await held()).toEqual([]);
    expect((await get(b, g)).statusCode).toBe(404);
    expect(await entry(b, g)).not.toHaveProperty("avatarVersion");
    expect(key).toMatch(/^avatar-/);

    expect(await remove(a, g)).toEqual({ status: 200, json: { ok: true } });
    expect(await row(g)).toEqual({ avatar_key: null, avatar_version: 2 });

    // A delete that fails leaves the old blob held for the sweep, the row already clear.
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const again = (await row(g)).avatar_key!;
    probe.failNextDeletes = 1;
    expect((await remove(a, g)).status).toBe(200);
    expect((await row(g)).avatar_key).toBeNull();
    expect(await held()).toEqual([again]);
  });

  it("an upload refused for who asked leaves no blob behind (the new one is discarded)", async () => {
    const { a, b, g } = await team();
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    const key = (await row(g)).avatar_key!;
    await api(app, a, "DELETE", `/api/conversations/${g}/members/${a.id}`); // b is the creator now
    expect((await put(a, g, JPEG, "image/jpeg")).statusCode).toBe(404);
    expect(blobFiles()).toEqual([key]);
    expect(await held()).toEqual([]);
    expect(await get(b, g)).toMatchObject({ statusCode: 200 });
  });
});

describe("what the members are told", () => {
  it("every current member's sockets get a conversation push for a set, a replacement and a removal", async () => {
    const { a, b, g } = await team();
    const sa = await connect(app, a);
    const sb = await connect(app, b);
    const pushed = (e: { type: string; id?: string }) => e.type === "conversation" && e.id === g;

    expect((await put(a, g, PNG)).statusCode).toBe(200);
    await sa.next(pushed);
    await sb.next(pushed);
    const bAt = sb.events.length;
    expect((await put(a, g, JPEG, "image/jpeg")).statusCode).toBe(200);
    await sb.next(pushed, { from: bAt });
    const bAt2 = sb.events.length;
    expect((await remove(a, g)).status).toBe(200);
    await sb.next(pushed, { from: bAt2 });

    // No notice is written in the group for it.
    const notices = await db.query("select count(*)::int as n from messages where conversation_id = $1 and kind = 'system'", [g]);
    expect(notices.rows[0].n).toBe(1); // only group_created
  });

  it("an outsider's socket stays silent while the avatar changes", async () => {
    const { a, d, g } = await team();
    const sd = await connect(app, d);
    expect((await put(a, g, PNG)).statusCode).toBe(200);
    expect((await remove(a, g)).status).toBe(200);
    // A sentinel the outsider does hear, sent after: whatever else they were told would have come before it.
    expect((await api(app, a, "POST", "/api/friend-requests", { handle: d.handle })).status).toBe(201);
    await sd.next((e) => e.type === "social");
    expect(sd.events.filter((e) => e.id === g || e.conversationId === g)).toEqual([]);
  });
});

describe("lock order", () => {
  it("takes the group's row first: a send holding the group and then asking for an Agent's row waits for nothing the upload holds; both commit", async () => {
    const { a, g } = await team();
    const ghost = (await db.query<{ id: string }>("select id from principals where handle = 'alice'")).rows[0]!.id;
    const send = holdThen(
      db,
      ["select 1 from conversations where id = $1 for update", [g]],
      ["select 1 from principals where id = $1 for update", [ghost]],
    );
    await send.locked;
    const upload = put(a, g, PNG);
    await someoneWaits(db, ["%conversations%for update%"]);
    send.release();
    await send.done;
    expect((await upload).statusCode).toBe(200);
  });
});
