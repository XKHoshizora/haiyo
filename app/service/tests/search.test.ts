import { describe, expect, it } from "vitest";
import { decodeSearchCursor, encodeSearchCursor, matchOn } from "../src/messages/search.ts";
import { api, befriend, group as makeGroup, signUp, type Actor } from "./helpers/actors.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

const { blobs } = useProbeBlobs("af-search-");
const { app, db } = useApp({ blobs });

const NOT_FOUND = { error: "not_found" };
const INVALID = { error: "invalid_request" };
const RANDOM_ID = "00000000-0000-4000-8000-000000000000";

let txn = 0;
const say = (who: Actor, conv: string, text: string, extra: object = {}) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `s${++txn}`, ...extra });
const add = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: target.id });
const remove = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "DELETE", `/api/conversations/${conv}/members/${target.id}`);
const leave = (who: Actor, conv: string) => remove(who, conv, who);

const enc = encodeURIComponent;
const inConv = (who: Actor, conv: string, q: string, extra = "") =>
  api(app, who, "GET", `/api/conversations/${conv}/search?q=${enc(q)}${extra}`);
const global = (who: Actor, q: string, extra = "") => api(app, who, "GET", `/api/search?q=${enc(q)}${extra}`);
const texts = (r: { json: { messages: { text: string }[] } }) => r.json.messages.map((m) => m.text);
const keys = (r: { json: { messages: { conversationId: string; seq: number }[] } }) =>
  r.json.messages.map((m) => `${m.conversationId}#${m.seq}`);

async function people<const N extends string[]>(...names: N): Promise<{ [K in keyof N]: Actor }> {
  const out: Actor[] = [];
  for (const n of names) out.push(await signUp(app, n));
  return out as { [K in keyof N]: Actor };
}

/** Adds `target` to `conv`, befriending them first when they are not yet friends of `who`. */
async function join(who: Actor, conv: string, target: Actor) {
  const social = await api<{ friends: { id: string }[] }>(app, who, "GET", "/api/social");
  if (!social.json.friends.some((f) => f.id === target.id)) await befriend(app, who, target);
  const res = await add(who, conv, target);
  if (res.status >= 300) throw new Error(`join failed ${res.status} ${JSON.stringify(res.json)}`);
}

let fillers = 0;
/** A group needs two members besides its creator: pads with a throwaway principal when given fewer. */
async function group(creator: Actor, title: string, members: Actor[]): Promise<string> {
  const all = [...members];
  while (all.length < 2) all.push(await signUp(app, `filler${++fillers}`));
  return makeGroup(app, creator, title, all);
}

async function sendFile(who: Actor, conv: string, filename: string, extra: object = {}) {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename, type: "application/octet-stream", data: Buffer.from("plain bytes " + filename) }]),
  });
  if (res.statusCode !== 201) throw new Error(`upload failed ${res.statusCode} ${res.body}`);
  return api(app, who, "POST", `/api/conversations/${conv}/messages`, {
    attachmentId: JSON.parse(res.body).id,
    clientTxn: `f${++txn}`,
    ...extra,
  });
}

describe("search matching", () => {
  it('finds a Chinese fragment such as "镰仓站" inside a longer sentence', async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "明天下午我们在镰仓站见面吧");
    await say(a, dm, "别的话题");
    const one = await inConv(b, dm, "镰仓站");
    expect(one.status).toBe(200);
    expect(texts(one)).toEqual(["明天下午我们在镰仓站见面吧"]);
    expect(texts(await global(b, "镰仓站"))).toEqual(["明天下午我们在镰仓站见面吧"]);
    expect(texts(await inConv(b, dm, "仓站见"))).toEqual(["明天下午我们在镰仓站见面吧"]); // no word segmentation
  });

  it("is case-insensitive for Latin text and correct for 1 and 2 character queries", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "Hello World");
    await say(a, dm, "xyz");
    await say(a, dm, "q");
    for (const q of ["hello", "HELLO", "wORLD", "o w"]) expect(texts(await inConv(b, dm, q))).toEqual(["Hello World"]);
    expect(texts(await inConv(b, dm, "z"))).toEqual(["xyz"]);
    expect(texts(await inConv(b, dm, "yz"))).toEqual(["xyz"]);
    expect(texts(await inConv(b, dm, "Q"))).toEqual(["q"]);
    expect(texts(await global(b, "yz"))).toEqual(["xyz"]);
    expect(texts(await global(b, "L"))).toEqual(["Hello World"]);
  });

  // Case folding beyond ASCII is whatever the database's character classification does (here UTF8 with
  // ctype C.UTF-8, see README "Search"). These pin today's behaviour, so a locale change is noticed.
  it("folds case of non-ASCII Latin letters (É/é) but does not strip accents", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "École de café");
    for (const q of ["école", "ÉCOLE", "CAFÉ", "Café"]) expect([q, texts(await inConv(b, dm, q))]).toEqual([q, ["École de café"]]);
    expect(texts(await global(b, "éCOLE"))).toEqual(["École de café"]);
    for (const q of ["ecole", "cafe"]) expect([q, texts(await inConv(b, dm, q))]).toEqual([q, []]);
  });

  it("folds case among full-width Latin letters, but full-width and ASCII letters never match each other", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "ＡＢＣ全角");
    await say(a, dm, "abc half-width");
    expect(texts(await inConv(b, dm, "ａｂｃ"))).toEqual(["ＡＢＣ全角"]);
    expect(texts(await inConv(b, dm, "ＡＢＣ"))).toEqual(["ＡＢＣ全角"]);
    expect(texts(await inConv(b, dm, "ABC"))).toEqual(["abc half-width"]);
    expect(texts(await global(b, "ｂｃ"))).toEqual(["ＡＢＣ全角"]);
  });

  it('treats "%", "_" and "\\" in q as literal characters', async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "100% sure");
    await say(a, dm, "snake_case");
    await say(a, dm, "snakeXcase");
    await say(a, dm, "C:\\temp\\x");
    await say(a, dm, "plain text");
    for (const search of [(q: string) => inConv(b, dm, q), (q: string) => global(b, q)]) {
      expect(texts(await search("%"))).toEqual(["100% sure"]);
      expect(texts(await search("_"))).toEqual(["snake_case"]);
      expect(texts(await search("e_c"))).toEqual(["snake_case"]);
      expect(texts(await search("\\"))).toEqual(["C:\\temp\\x"]);
      expect(texts(await search("p\\t"))).toEqual([]);
      expect(texts(await search("%sure"))).toEqual([]);
    }
  });

  it("finds a file message by its file name, and by its caption", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "unrelated");
    const bare = await sendFile(a, dm, "Quarterly-Report.pdf");
    const captioned = await sendFile(a, dm, "photo.bin", { text: "the quarterly numbers" });
    expect(bare.status).toBe(201);
    for (const r of [await inConv(b, dm, "quarterly"), await global(b, "QUARTERLY")]) {
      expect(r.json.messages.map((m: any) => m.seq)).toEqual([captioned.json.message.seq, bare.json.message.seq]);
      expect(r.json.messages[1]).toMatchObject({ kind: "file", text: "", attachment: { name: "Quarterly-Report.pdf" } });
    }
    expect(texts(await inConv(b, dm, "report.pdf"))).toEqual([""]);
  });

  it("never returns system notices", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(a, "zebrafish club", [b]);
    await join(a, g, c);
    await say(a, g, "ordinary zebrafish chat");
    const history = await api(app, b, "GET", `/api/conversations/${g}/messages`);
    expect(history.json.messages.some((m: any) => m.kind === "system" && /zebrafish/.test(m.text))).toBe(true);
    for (const r of [await inConv(b, g, "zebrafish"), await global(b, "zebrafish")]) {
      expect(texts(r)).toEqual(["ordinary zebrafish chat"]);
      expect(r.json.messages.every((m: any) => m.kind !== "system")).toBe(true);
    }
  });

  it("treats an upper-case conversation id like the lower-case one", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    await say(a, dm, "needle");
    const lower = await inConv(b, dm, "needle");
    const upper = await api(app, b, "GET", `/api/conversations/${dm.toUpperCase()}/search?q=needle`);
    expect(upper).toEqual(lower);
    expect(upper.json.messages).toHaveLength(1);
  });

  it("uses the trigram indexes for the searched expressions (planner check with seq scans disabled)", async () => {
    const plan = await db.tx(async (t) => {
      await t.query("set local enable_seqscan = off");
      const { rows } = await t.query<{ "QUERY PLAN": string }>(
        `explain select m.id from messages m where ${matchOn(1).replaceAll("$1", "'%abc%'")}`,
      );
      return rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(plan).toMatch(/messages_text_trgm_idx/);
    expect(plan).toMatch(/messages_attachment_name_trgm_idx/);
  });
});

describe("in-conversation search", () => {
  it("gives an outsider the same 404 as a conversation that does not exist, in every way of not being in it", async () => {
    const [a, b, c, d, e] = await people("alice", "bob", "carol", "dave", "erin");
    const g = await group(a, "club", [b, c, d]);
    await say(a, g, "needle");
    await leave(c, g);
    await remove(a, g, d);
    for (const who of [e, c, d]) {
      expect(await inConv(who, g, "needle")).toEqual({ status: 404, json: NOT_FOUND });
    }
    expect(await inConv(a, RANDOM_ID, "needle")).toEqual({ status: 404, json: NOT_FOUND });
    expect(await inConv(a, g, "needle")).toMatchObject({ status: 200 });
    expect(await api(app, null, "GET", `/api/conversations/${g}/search?q=needle`)).toMatchObject({ status: 401 });
  });

  it("a late joiner's search never returns pre-join messages, even when the term only occurs there", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(a, "club", [b]);
    await say(a, g, "secret needle before carol");
    await join(a, g, c);
    expect(await inConv(c, g, "needle")).toMatchObject({ status: 200, json: { messages: [], nextBefore: null } });
    expect(await global(c, "needle")).toMatchObject({ status: 200, json: { messages: [], nextBefore: null } });
    await say(b, g, "needle after carol");
    expect(texts(await inConv(c, g, "needle"))).toEqual(["needle after carol"]);
    expect(texts(await inConv(b, g, "needle"))).toEqual(["needle after carol", "secret needle before carol"]);
  });

  it("after being re-added a member's searches return only post-rejoin hits; while removed the conversation is 404", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(a, "club", [b, c]);
    await say(a, g, "needle one");
    await remove(a, g, b);
    await say(a, g, "needle while out");
    expect(await inConv(b, g, "needle")).toEqual({ status: 404, json: NOT_FOUND });
    expect(await global(b, "needle")).toMatchObject({ status: 200, json: { messages: [] } });
    await join(a, g, b);
    await say(a, g, "needle after rejoin");
    expect(texts(await inConv(b, g, "needle"))).toEqual(["needle after rejoin"]);
    expect(texts(await global(b, "needle"))).toEqual(["needle after rejoin"]);
  });

  it("pagination with nextBefore walks back through all hits without repeats", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    for (let i = 1; i <= 12; i++) await say(a, dm, i % 3 === 0 ? `filler ${i}` : `needle ${i}`);
    const seen: number[] = [];
    let before = "";
    for (let page = 0; page < 10; page++) {
      const r = await inConv(b, dm, "needle", `&limit=3${before}`);
      expect(r.status).toBe(200);
      expect(r.json.messages.length).toBeLessThanOrEqual(3);
      seen.push(...r.json.messages.map((m: any) => m.seq));
      if (r.json.nextBefore === null) break;
      expect(typeof r.json.nextBefore).toBe("number");
      before = `&before=${r.json.nextBefore}`;
    }
    expect(seen).toEqual([11, 10, 8, 7, 5, 4, 2, 1]);
    // An exact fit ends with null, not an empty extra page.
    const exact = await inConv(b, dm, "needle", "&limit=8");
    expect(exact.json.messages).toHaveLength(8);
    expect(exact.json.nextBefore).toBeNull();
  });

  it("validates q, before and limit with 400", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const bad = [
      "",
      "q=",
      "q=%20%20",
      "q=a%00b",
      "q=a%0Ab",
      "q=a%09b",
      "q=a%0Db",
      "q=a%7Fb",
      `q=${"x".repeat(101)}`,
      "q=a&q=b",
      "q=a&limit=0",
      "q=a&limit=51",
      "q=a&limit=1.5",
      "q=a&limit=-1",
      "q=a&limit=abc",
      "q=a&before=0",
      "q=a&before=-3",
      "q=a&before=1.5",
      "q=a&before=9007199254740993",
      "q=a&before=abc",
      "q=a&before=",
    ];
    for (const query of bad) {
      expect(await api(app, a, "GET", `/api/conversations/${dm}/search?${query}`), query).toEqual({ status: 400, json: INVALID });
    }
    expect(await api(app, a, "GET", "/api/conversations/not-a-uuid/search?q=a")).toEqual({ status: 400, json: INVALID });
    expect((await inConv(b, dm, "x".repeat(100))).status).toBe(200);
    expect((await inConv(b, dm, "  a  ")).status).toBe(200);
    expect((await inConv(b, dm, "a", "&limit=50")).status).toBe(200);
  });

  it("returns a hit that quotes an invisible message with replyTo.visible=false, and shows file quotes as files", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const g = await group(a, "club", [b]);
    await say(a, g, "pre-join secret"); // seq 2 (seq 1 is the creation notice)
    const file = await sendFile(a, g, "plan.pdf");
    await join(a, g, c);
    await say(b, g, "needle about the secret", { replyToSeq: 2 });
    await say(b, g, "needle about the file", { replyToSeq: file.json.message.seq });
    const forBob = await inConv(b, g, "needle");
    expect(forBob.json.messages.map((m: any) => m.replyTo)).toEqual([
      { seq: file.json.message.seq, visible: true, senderId: a.id, text: "", kind: "file", attachmentName: "plan.pdf" },
      { seq: 2, visible: true, senderId: a.id, text: "pre-join secret", kind: "text" },
    ]);
    const forCarol = await inConv(c, g, "needle");
    expect(forCarol.json.messages.map((m: any) => m.replyTo)).toEqual([
      { seq: file.json.message.seq, visible: false },
      { seq: 2, visible: false },
    ]);
    expect(JSON.stringify((await global(c, "needle")).json)).not.toMatch(/pre-join secret|plan\.pdf/);
  });
});

describe("global search", () => {
  it("returns hits from several of my conversations with their conversationId and seq, newest first", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const { conversationId: ab } = await befriend(app, a, b);
    const { conversationId: ac } = await befriend(app, a, c);
    const g = await group(a, "club", [b, c]);
    const m1 = await say(b, ab, "needle in ab");
    const m2 = await say(c, ac, "needle in ac");
    const m3 = await say(b, g, "needle in group");
    await say(c, ac, "no match here");
    const r = await global(a, "needle");
    expect(r.status).toBe(200);
    expect(r.json.nextBefore).toBeNull();
    expect(r.json.messages.map((m: any) => [m.conversationId, m.seq, m.text])).toEqual([
      [g, m3.json.message.seq, "needle in group"],
      [ac, m2.json.message.seq, "needle in ac"],
      [ab, m1.json.message.seq, "needle in ab"],
    ]);
    expect(r.json.messages[0]).not.toHaveProperty("id");
  });

  it("never returns a pre-join message, a message from a conversation I left or was removed from, or one from a conversation I never was in", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const early = await group(a, "early", [b, c]);
    const left = await group(a, "left", [b, c]);
    const removed = await group(a, "removed", [b, c]);
    const never = await group(a, "never", [b]);
    await say(a, early, "needle early before");
    await say(a, left, "needle left before");
    await say(a, removed, "needle removed before");
    await say(a, never, "needle never before");
    await leave(c, left);
    await remove(a, removed, c);
    await say(a, left, "needle left after");
    await say(a, removed, "needle removed after");
    await say(a, early, "needle early after");
    await join(a, never, d);
    await say(a, never, "needle never after");
    // Carol is still in `early` (both its messages predate nothing for her), and in none of the others.
    expect(texts(await global(c, "needle"))).toEqual(["needle early after", "needle early before"]);
    // Dave joined `never` late: only the post-join message.
    expect(texts(await global(d, "needle"))).toEqual(["needle never after"]);
    // Someone in none of the conversations gets an empty list, not an error.
    const [outsider] = await people("zed");
    expect(await global(outsider, "needle")).toEqual({ status: 200, json: { messages: [], nextBefore: null, principals: {} } });
    // A term that only exists where I am not: empty list.
    expect(await global(c, "needle never")).toMatchObject({ status: 200, json: { messages: [], nextBefore: null } });
  });

  it("pagination across conversations walks all hits exactly once, newest first", async () => {
    const [a, b] = await people("alice", "bob");
    const { conversationId: dm } = await befriend(app, a, b);
    const g1 = await group(a, "one", [b]);
    const g2 = await group(a, "two", [b]);
    const sent: string[] = [];
    for (let i = 0; i < 5; i++) {
      for (const c of [dm, g1, g2]) {
        const r = await say(b, c, `needle ${i}`);
        sent.push(`${c}#${r.json.message.seq}`);
      }
    }
    const walked: string[] = [];
    let before = "";
    for (let page = 0; page < 20; page++) {
      const r = await global(a, "needle", `&limit=4${before}`);
      expect(r.status).toBe(200);
      walked.push(...keys(r));
      if (r.json.nextBefore === null) break;
      expect(r.json.nextBefore).toMatch(/^[A-Za-z0-9_-]+$/);
      before = `&before=${r.json.nextBefore}`;
    }
    expect(walked).toHaveLength(15);
    expect(new Set(walked).size).toBe(15);
    expect(walked).toEqual([...sent].reverse());
  });

  it("walks hits that share one created_at in a stable order, none repeated or skipped", async () => {
    const [a, b] = await people("alice", "bob");
    const g1 = await group(a, "one", [b]);
    const g2 = await group(a, "two", [b]);
    await say(a, g1, "tie one");
    await say(a, g1, "tie two");
    await say(a, g2, "tie three");
    await say(a, g2, "tie four");
    await db.query("update messages set created_at = '2026-01-01T00:00:00.123456Z' where body->>'text' like 'tie %'");
    const all = keys(await global(b, "tie"));
    expect(all).toHaveLength(4);
    const walked: string[] = [];
    let before = "";
    for (let page = 0; page < 10; page++) {
      const r = await global(b, "tie", `&limit=1${before}`);
      walked.push(...keys(r));
      if (r.json.nextBefore === null) break;
      before = `&before=${r.json.nextBefore}`;
    }
    expect(walked).toEqual(all);
    expect(new Set(walked).size).toBe(4);
  });

  it("the cursor does not reveal how many messages exist site-wide (two users see unrelated cursors)", async () => {
    const [a, b, c, d] = await people("alice", "bob", "carol", "dave");
    const { conversationId: ab } = await befriend(app, a, b);
    const { conversationId: cd } = await befriend(app, c, d);
    for (let i = 0; i < 3; i++) await say(a, ab, `needle ${i}`);
    for (let i = 0; i < 40; i++) await say(c, cd, i < 3 ? `needle ${i}` : `noise ${i}`);
    const forB = (await global(b, "needle", "&limit=1")).json;
    const forD = (await global(d, "needle", "&limit=1")).json;
    expect(forB.nextBefore).not.toEqual(forD.nextBefore);
    const parts = Buffer.from(forB.nextBefore, "base64url").toString("utf8").split("|");
    // Only a timestamp, the caller's own conversation and that conversation's own seq.
    expect(parts).toHaveLength(3);
    expect(parts[1]).toBe(ab);
    expect(parts[2]).toBe(String(forB.messages[0].seq));
    expect(Buffer.from(forD.nextBefore, "base64url").toString("utf8")).not.toContain(ab);
    // Nor does the wire message carry a global id.
    expect(Object.keys(forB.messages[0]).sort()).toEqual(["conversationId", "createdAt", "kind", "senderId", "seq", "text"]);
  });

  it("a cursor minted for one user cannot make another user see anything they may not", async () => {
    const [a, b, c] = await people("alice", "bob", "carol");
    const shared = await group(a, "shared", [b]);
    const alone = await group(a, "alone", [c]);
    await say(a, shared, "needle shared 1");
    await say(a, alone, "needle alone 1");
    await say(a, shared, "needle shared 2");
    await say(a, alone, "needle alone 2");
    const cursor = (await global(a, "needle", "&limit=1")).json.nextBefore as string;
    expect(cursor).toBeTruthy();
    // Bob replays Alice's cursor: only his conversation's hits, older than that position.
    const asBob = await global(b, "needle", `&before=${cursor}`);
    expect(asBob.status).toBe(200);
    expect(texts(asBob).every((t) => t.startsWith("needle shared"))).toBe(true);
    // A forged cursor naming another conversation is just a position.
    const forged = encodeSearchCursor({ createdAt: "2999-01-01T00:00:00.000000Z", conversationId: alone, seq: 999 });
    expect(texts(await global(b, "needle", `&before=${forged}`))).toEqual(["needle shared 2", "needle shared 1"]);
    expect(texts(await global(c, "needle", `&before=${forged}`))).toEqual(["needle alone 2", "needle alone 1"]);
  });

  it("answers a malformed cursor, q, or limit with 400", async () => {
    const [a] = await people("alice");
    const good = encodeSearchCursor({ createdAt: "2026-01-01T00:00:00.000000Z", conversationId: RANDOM_ID, seq: 5 });
    expect((await global(a, "x", `&before=${good}`)).status).toBe(200);
    const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64url");
    const ts = "2026-01-01T00:00:00.000000Z";
    const bad = [
      "",
      "abc",
      "!!!",
      "1",
      "12345678",
      `${good}%3D`,
      good + "A",
      good.slice(0, -1),
      `${good}%20`,
      b64(`${ts}|${RANDOM_ID}`),
      b64(`${ts}|${RANDOM_ID}|5|6`),
      b64(`2026-01-01T00:00:00Z|${RANDOM_ID}|5`),
      b64(`2026-02-31T00:00:00.000000Z|${RANDOM_ID}|5`),
      b64(`0000-01-01T00:00:00.000000Z|${RANDOM_ID}|5`),
      b64(`${ts}|ABCDEF00-0000-4000-8000-000000000000|5`),
      b64(`${ts}|not-a-uuid|5`),
      b64(`${ts}|${RANDOM_ID}|0`),
      b64(`${ts}|${RANDOM_ID}|05`),
      b64(`${ts}|${RANDOM_ID}|-1`),
      b64(`${ts}|${RANDOM_ID}|9007199254740993`),
      b64(`${ts}|${RANDOM_ID}|1e3`),
      "A".repeat(201),
    ];
    for (const before of bad) {
      expect(await global(a, "x", `&before=${before}`), before).toEqual({ status: 400, json: INVALID });
    }
    for (const query of ["", "q=", "q=%20", "q=a%00", "q=a%0Ab", `q=${"y".repeat(101)}`, "q=a&limit=0", "q=a&limit=51", "q=a&limit=x", "q=a&q=b"]) {
      expect(await api(app, a, "GET", `/api/search?${query}`), query).toEqual({ status: 400, json: INVALID });
    }
    expect(await api(app, null, "GET", "/api/search?q=a")).toMatchObject({ status: 401 });
  });

  it("round-trips cursors and refuses anything it did not mint", () => {
    const c = { createdAt: "2026-11-16T10:20:30.123456Z", conversationId: RANDOM_ID, seq: 42 };
    expect(decodeSearchCursor(encodeSearchCursor(c))).toEqual(c);
    expect(decodeSearchCursor("")).toBeNull();
  });
});
