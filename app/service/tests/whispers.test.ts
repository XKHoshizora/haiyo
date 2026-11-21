import { afterEach, describe, expect, it, vi } from "vitest";
import { leaveGroupsOfDeleted } from "../src/agents/group-leave.ts";
import { lockAgent, setAgentState } from "../src/agents/store.ts";
import { buildApp } from "../src/app.ts";
import { ANSWER_HOOKS } from "../src/whispers/routes.ts";
import {
  createWhisper,
  expireOfAgent,
  expireWhispers,
  removeOldWhispers,
  resolveWhisper,
  WHISPER_DETAIL_MAX,
  WHISPER_KEEP_DAYS,
  WHISPER_OPEN_DAYS,
  WHISPER_SWEEP_BATCH,
  WHISPER_TEXT_MAX,
  whisperBody,
  type Whisper,
  type WhisperBody,
} from "../src/whispers/store.ts";
import { toWireWhisper } from "../src/whispers/wire.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * Whispers (悄悄话, design rules 16 and 19): a small note in a conversation that only the owner of one of its Agents ever
 * sees, with the buttons it offers. Never a message (no seq); the owner is pushed it, finds it in their sync, catch-up and
 * the list route; answers it once; it expires after 7 days (the periodic sweep; a `found_elsewhere` one after a day, in
 * whisper-elsewhere.test.ts with the rest of that kind), when its owner or its Agent leaves, and
 * when its Agent is deleted. What nobody else may learn of it is in whispers-privacy.test.ts.
 */

const gateway = scriptedGateway();
/** Every line the app logs (a refused body may be warned about, never shown). */
const logLines: string[] = [];
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, logStream: { write: (line) => void logLines.push(line) } });
afterEach(closeAllSockets);

const FAST = { source: "site", id: "fast" } as const;
const DAY = 86_400_000;
const BODY: WhisperBody = { text: "在别处找到了：周五下午有空", actions: ["tell", "dismiss"] };

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `wh${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
const lastSeqOf = async (conv: string) => Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [conv])).rows[0]!.seq);
const statusOf = async (id: string) => (await db.query<{ status: string }>("select status from whispers where id = $1", [id])).rows[0]?.status ?? null;

/** olive's Agent in olive's group with mia and ned; olive also has the Agent's own conversation. */
async function world() {
  const [owner, mia, ned] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned")];
  const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
  const g = await group(app, owner, "team", [mia, ned]);
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  await say(mia, g, "大家好");
  // What a found_elsewhere whisper of hers points at (`found`): her own note to her Agent.
  const note = await say(owner, agent.conversationId, "记一下：周五有空");
  await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [agent.id]);
  return { owner, mia, ned, agent: agent as { id: string; conversationId: string }, g, note };
}
/** A found_elsewhere whisper's body whose one hit is a real reference (her note): it reads open. */
const found = (w: { agent: { conversationId: string }; note: number }): WhisperBody => ({ ...BODY, detail: { hits: [{ conversationId: w.agent.conversationId, seq: w.note, at: 0 }] } });
type World = Awaited<ReturnType<typeof world>>;

/** A whisper of olive's about her Agent in `conv` (the group by default), pushed to her as a later task will. */
async function whisper(w: World, over: Partial<{ conversationId: string; body: WhisperBody; kind: Whisper["kind"]; agentId: string }> = {}): Promise<Whisper> {
  const made = await db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "memory", body: BODY, ...over }));
  if (!made) throw new Error("whisper refused");
  app.realtime.pushWhisper(made);
  return made;
}
/** Moves a whisper `days` days into the past. */
const age = (id: string, days: number) => db.query("update whispers set created_at = now() - $2::int * interval '1 day' where id = $1", [id, days]);

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
/** Whether, before `work` settles (within `ms`), some statement of this database waits for a lock another transaction holds. */
async function waitsForALock(work: Promise<unknown>, ms = 3000): Promise<boolean> {
  let settled = false;
  work.then(
    () => (settled = true),
    () => (settled = true),
  );
  const end = Date.now() + ms;
  while (!settled && Date.now() < end) {
    const { rows } = await db.query<{ n: string }>("select count(*) n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
    if (Number(rows[0]!.n) > 0) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}
type T = Parameters<Parameters<typeof db.tx>[0]>[0];
/** A transaction that holds `fn`'s locks until `release` is called (`held` resolves once `fn` is done), then runs `then` and commits. */
function holding(fn: (t: T) => Promise<unknown>, then?: (t: T) => Promise<unknown>) {
  const held = deferred();
  const release = deferred();
  const done = db.tx(async (t) => {
    await fn(t);
    held.resolve();
    await release.promise;
    await then?.(t);
  });
  return { held: held.promise, release: () => release.resolve(), done };
}
/** What a later kind's accept hook will do first (it queues the Agent's reply: `lockAgent`, the Agent's row for update). */
const LOCKS_THE_AGENT = { accepted: async (t: T, x: Whisper) => void (await t.query("select 1 from agents where principal_id = $1 for update", [x.agentId])) };

describe("createWhisper", () => {
  it("stores it after the conversation's last message without taking a seq: no message, lastSeq unchanged", async () => {
    const w = await world();
    const before = await lastSeqOf(w.g);
    const messages = Number((await db.query("select count(*) n from messages")).rows[0].n);
    const made = await whisper(w);
    expect(made).toMatchObject({ conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, afterSeq: before, kind: "memory", status: "open", resolvedAt: null, body: BODY });
    expect(await lastSeqOf(w.g)).toBe(before);
    expect(Number((await db.query("select count(*) n from messages")).rows[0].n)).toBe(messages);
    // The next message takes the next seq, as if nothing had happened.
    expect(await say(w.mia, w.g, "还在吗")).toBe(before + 1);
  });

  it("refuses (null) an owner who is not a current member, an Agent that is not theirs or not in the conversation, a deleted Agent", async () => {
    const w = await world();
    const stranger = await signUp(app, "sam");
    const theirs = await mustCreateAgent(app, stranger, { model: FAST });
    const outside = await mustCreateAgent(app, w.owner, { model: FAST });
    const make = (ownerId: string, agentId: string, conversationId = w.g) => db.tx((t) => createWhisper(t, { conversationId, ownerId, agentId, kind: "tools_off", body: BODY }));
    expect(await make(stranger.id, theirs.id)).toBeNull();
    // mia is a member, but the Agent is not hers.
    expect(await make(w.mia.id, w.agent.id)).toBeNull();
    // olive's other Agent is not in the group.
    expect(await make(w.owner.id, outside.id)).toBeNull();
    // A conversation that is not one.
    expect(await make(w.owner.id, w.agent.id, "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d")).toBeNull();
    // olive left the group (taking her Agent with her).
    const other = await group(app, w.owner, "other", [w.mia, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${other}/members`, { principalId: w.agent.id })).status).toBe(201);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${other}/members/${w.owner.id}`)).status).toBe(200);
    expect(await make(w.owner.id, w.agent.id, other)).toBeNull();
    // A deleted Agent.
    expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}`)).status).toBe(200);
    expect(await make(w.owner.id, w.agent.id, w.agent.conversationId)).toBeNull();
    expect(Number((await db.query("select count(*) n from whispers")).rows[0].n)).toBe(0);
  });

  it("works in the Agent's own conversation too", async () => {
    const w = await world();
    const made = await whisper(w, { conversationId: w.agent.conversationId, kind: "tools_off", body: { text: "这个模型用不了工具", actions: ["dismiss"] } });
    expect(made.afterSeq).toBe(await lastSeqOf(w.agent.conversationId));
  });

  it("cleans the text as notices are (one line, no invisible characters), and throws on a body that is empty or offers other buttons", async () => {
    const w = await world();
    const made = await whisper(w, { body: { text: "  第一行\n第二行​  ", actions: ["dismiss"], detail: { seq: 3 } } });
    expect(made.body).toEqual({ text: "第一行 第二行", actions: ["dismiss"], detail: { seq: 3 } });
    expect(WHISPER_TEXT_MAX).toBe(2000);
    for (const body of [
      { text: " \n​ ", actions: ["dismiss"] },
      { text: "好", actions: ["tell", "tell"] },
      { text: "好", actions: ["reply"] },
      { text: 3, actions: [] },
    ]) {
      await expect(db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "memory", body: body as WhisperBody }))).rejects.toThrow(/whisper body/);
    }
    // Exactly the limit is taken (one more is refused: below).
    await whisper(w, { body: { text: "字".repeat(WHISPER_TEXT_MAX), actions: [] } });
  });
});

describe("a body that could not be stored or would weigh on every sync", () => {
  const SECRET = "SECRET-dz7 只给主人";
  const make = (t: Parameters<Parameters<typeof db.tx>[0]>[0], w: World, body: unknown) =>
    createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "memory", body: body as WhisperBody }, app.log);
  const nested = (n: number): unknown => (n === 0 ? SECRET : { d: nested(n - 1) });
  const cycle: Record<string, unknown> = { text: SECRET };
  cycle.self = cycle;
  /** `{"a":"…"}` of exactly `bytes` bytes of JSON text. */
  const detailOf = (bytes: number) => ({ a: SECRET + "x".repeat(bytes - 8 - Buffer.byteLength(SECRET)) });
  const REFUSED: Array<[string, unknown]> = [
    ["a detail over 8192 bytes of JSON", { text: "好", actions: ["dismiss"], detail: detailOf(WHISPER_DETAIL_MAX + 1) }],
    ["a detail over 8192 bytes counted in utf-8", { text: "好", actions: ["dismiss"], detail: [SECRET, "字".repeat(2731)] }],
    ["U+0000 in a detail string", { text: "好", actions: ["dismiss"], detail: { hits: [{ text: `${SECRET}\u0000` }] } }],
    ["a lone high surrogate in a detail string", { text: "好", actions: ["dismiss"], detail: [`${SECRET}\ud800`] }],
    ["a lone low surrogate in a detail key", { text: "好", actions: ["dismiss"], detail: { [`\udc00${SECRET}`]: 1 } }],
    ["U+0000 in the text", { text: `${SECRET}\u0000`, actions: ["dismiss"] }],
    ["a lone surrogate in the text", { text: `${SECRET}\udfff`, actions: ["dismiss"] }],
    ["a detail deeper than 6", { text: "好", actions: ["dismiss"], detail: nested(6) }],
    ["a detail of more than 200 values", { text: "好", actions: ["dismiss"], detail: Array.from({ length: 200 }, () => SECRET) }],
    ["a detail that is not JSON (a cycle)", { text: "好", actions: ["dismiss"], detail: cycle }],
    ["a text over 2000 weight", { text: SECRET + "字".repeat(WHISPER_TEXT_MAX), actions: ["dismiss"] }],
  ];

  it("is refused: createWhisper answers null in the caller's transaction, which stays usable; nothing is stored, nothing thrown", async () => {
    expect(WHISPER_DETAIL_MAX).toBe(8192);
    const w = await world();
    for (const [what, body] of REFUSED) {
      expect([what, whisperBody(body)]).toEqual([what, null]);
      const after = await db.tx(async (t) => {
        expect([what, await make(t, w, body)]).toEqual([what, null]);
        // The caller's transaction goes on: nothing it was doing was aborted.
        return make(t, w, BODY);
      });
      expect([what, after?.status]).toEqual([what, "open"]);
    }
    const rows = (await db.query("select body from whispers")).rows;
    expect(rows).toHaveLength(REFUSED.length);
    expect(JSON.stringify(rows)).not.toContain("SECRET-dz7");
  });

  it("the limits are taken exactly: 8192 bytes, depth 6, 200 values", async () => {
    const w = await world();
    for (const detail of [detailOf(WHISPER_DETAIL_MAX), nested(5), Array.from({ length: 199 }, () => "x")]) {
      const made = await db.tx((t) => make(t, w, { text: "好", actions: ["dismiss"], detail }));
      expect(made?.body.detail).toEqual(detail);
    }
  });

  it("a refusal is logged as one warning naming the kind, never with anything of the body", async () => {
    const w = await world();
    const from = logLines.length;
    for (const [, body] of REFUSED) await db.tx((t) => make(t, w, body));
    const lines = logLines.slice(from);
    const warned = lines.map((l) => JSON.parse(l) as { level: number; kind?: string; msg: string }).filter((l) => l.level === 40 && /whisper/.test(l.msg));
    expect(warned).toHaveLength(REFUSED.length);
    for (const l of warned) expect(l.kind).toBe("memory");
    for (const line of lines) {
      expect(line).not.toContain("SECRET-dz7");
      expect(line).not.toContain("只给主人");
    }
  });
});

describe("the owner learns of it", () => {
  it("as a `whisper` push to their sockets", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const made = await whisper(w);
    const push = await socket.next((e) => e.type === "whisper");
    expect(push).toEqual({
      type: "whisper",
      whisper: { id: made.id, conversationId: w.g, agentId: w.agent.id, afterSeq: made.afterSeq, kind: "memory", text: BODY.text, actions: ["tell", "dismiss"], status: "open", createdAt: made.createdAt.toISOString(), revision: 0 },
    });
  });

  it("what is read for its push delays nothing the other members are sent: it goes on its owner's own queue, not the conversation's", async () => {
    const w = await world();
    const [ownerSocket, nedSocket] = [await connect(app, w.owner), await connect(app, w.ned)];
    // The push's read of the whisper (at delivery, in its snapshot's transaction) held until released.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const real = app.deps.db.tx;
    app.deps.db.tx = ((fn: (t: any) => Promise<unknown>) =>
      real.call(app.deps.db, (t: any) =>
        fn(
          new Proxy(t, {
            get: (o, p) =>
              p === "query"
                ? async (text: unknown, params?: unknown) => {
                    if (typeof text === "string" && /from whispers where owner_id = \$1 and id = any/.test(text)) await held;
                    return o.query(text, params);
                  }
                : Reflect.get(o, p),
          }),
        ),
      )) as typeof real;
    try {
      const made = await whisper(w);
      const seq = await say(w.mia, w.g, "照常说话");
      // ned's frame of the message comes while the whisper's read is still held.
      await nedSocket.waitFor((e) => e.type === "message" && e.message.conversationId === w.g && e.message.seq === seq, { timeoutMs: 3000 });
      expect(ownerSocket.events.some((e) => e.type === "whisper")).toBe(false);
      release();
      await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === made.id);
    } finally {
      app.deps.db.tx = real;
      release();
    }
  });

  it("in /api/sync (its open ones, and the answered ones of the messages it holds) and `whispers: n` on that conversation only, absent at 0", async () => {
    const w = await world();
    let sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.whispers).toBeUndefined();
    expect(sync.conversations.every((c: any) => !("whispers" in c))).toBe(true);
    const a = await whisper(w);
    const b = await whisper(w, { body: { text: "还有一件", actions: ["dismiss"] } });
    sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.whispers.map((x: any) => x.id)).toEqual([a.id, b.id]);
    expect(sync.conversations.find((c: any) => c.id === w.g).whispers).toBe(2);
    expect(sync.conversations.find((c: any) => c.id === w.agent.conversationId).whispers).toBeUndefined();
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(2);
    // Answered: no longer counted, still shown with the messages it follows.
    expect((await api(app, w.owner, "POST", `/api/whispers/${a.id}/accept`)).status).toBe(200);
    sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.conversations.find((c: any) => c.id === w.g).whispers).toBe(1);
    expect(sync.whispers.map((x: any) => [x.id, x.status])).toEqual([
      [a.id, "accepted"],
      [b.id, "open"],
    ]);
    expect((await api(app, w.owner, "POST", `/api/whispers/${b.id}/decline`)).status).toBe(200);
    expect("whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json).toBe(false);
  });

  it("the count on the conversation entry keeps to the owner's current stay, as the lists do: an open whisper of an earlier stay is not counted (N-1)", async () => {
    const w = await world();
    await whisper(w);
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(1);
    // As if olive had left and come back with it still open (no path leaves one open today: the count must not depend on that).
    await say(w.mia, w.g, "后来的话");
    await db.query("update memberships set joined_seq = (select seq from conversations where id = $1) where conversation_id = $1 and principal_id = $2", [w.g, w.owner.id]);
    expect("whispers" in (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json).toBe(false);
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}/whispers`)).json.whispers).toEqual([]);
  });

  it("in /api/sync an answered whisper of a message older than the 30 it returns is left to the list route; an open one always comes", async () => {
    const w = await world();
    const old = await whisper(w);
    const oldOpen = await whisper(w, { body: { text: "还开着", actions: ["dismiss"] } });
    expect((await api(app, w.owner, "POST", `/api/whispers/${old.id}/decline`)).status).toBe(200);
    for (let i = 0; i < 31; i++) await say(w.mia, w.g, `消息 ${i}`);
    const sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.whispers.map((x: any) => x.id)).toEqual([oldOpen.id]);
    const listed = (await api(app, w.owner, "GET", `/api/conversations/${w.g}/whispers`)).json;
    expect(listed.whispers.map((x: any) => x.id)).toEqual([oldOpen.id, old.id]);
  });

  it("in catch-up: the open ones and those after the position of the conversations caught up", async () => {
    const w = await world();
    const position = await lastSeqOf(w.g);
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position } })).json).toEqual({ messages: [], gone: [], more: false });
    const made = await whisper(w);
    const caught = (await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position } })).json;
    expect(caught).toEqual({ messages: [], gone: [], more: false, whispers: [toWireWhisper(made)].map((x) => JSON.parse(JSON.stringify(x))) });
    // Answered, it still comes with a position before it, not with one after it.
    expect((await api(app, w.owner, "POST", `/api/whispers/${made.id}/accept`)).status).toBe(200);
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position } })).json.whispers.map((x: any) => x.status)).toEqual(["accepted"]);
    await say(w.mia, w.g, "后来");
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: position + 1 } })).json).toEqual({ messages: [], gone: [], more: false });
  });

  it("from the list route, newest first, a page at a time (`before` an afterSeq)", async () => {
    const w = await world();
    const made: Whisper[] = [];
    for (let i = 0; i < 5; i++) {
      made.push(await whisper(w, { body: { text: `第 ${i} 条`, actions: ["dismiss"] } }));
      await say(w.mia, w.g, `然后 ${i}`);
    }
    // Two at the same place.
    const twin = await whisper(w, { body: { text: "同一处", actions: ["dismiss"] } });
    const twin2 = await whisper(w, { body: { text: "同一处 2", actions: ["dismiss"] } });
    const url = `/api/conversations/${w.g}/whispers`;
    const all = (await api(app, w.owner, "GET", url)).json;
    expect(all.whispers.map((x: any) => x.id)).toEqual([twin2.id, twin.id, ...[...made].reverse().map((x) => x.id)]);
    expect(all.nextBefore).toBeNull();
    const first = (await api(app, w.owner, "GET", `${url}?limit=3`)).json;
    expect(first.whispers.map((x: any) => x.id)).toEqual([twin2.id, twin.id, made[4]!.id]);
    expect(first.nextBefore).toBe(made[4]!.afterSeq);
    const second = (await api(app, w.owner, "GET", `${url}?limit=3&before=${first.nextBefore}`)).json;
    expect(second.whispers.map((x: any) => x.id)).toEqual([made[3]!.id, made[2]!.id, made[1]!.id]);
    const third = (await api(app, w.owner, "GET", `${url}?limit=3&before=${second.nextBefore}`)).json;
    expect([third.whispers.map((x: any) => x.id), third.nextBefore]).toEqual([[made[0]!.id], null]);
    // A page never splits the whispers of one place: the next page starts below it.
    const split = (await api(app, w.owner, "GET", `${url}?limit=1`)).json;
    expect([split.whispers.map((x: any) => x.id), split.nextBefore]).toEqual([[twin2.id, twin.id], twin.afterSeq]);
    expect((await api(app, w.owner, "GET", `${url}?before=${made[2]!.afterSeq + 1}`)).json.whispers.map((x: any) => x.id)).toEqual([made[2]!.id, made[1]!.id, made[0]!.id]);
    for (const bad of ["before=0", "before=x", "before=-1", "limit=0", "limit=101"]) expect([bad, (await api(app, w.owner, "GET", `${url}?${bad}`)).status]).toEqual([bad, 400]);
  });

  it("the list route: the owner of an Agent in the conversation, or of a whisper there, gets theirs (none: []); anyone else 404", async () => {
    const w = await world();
    const url = (conv: string) => `/api/conversations/${conv}/whispers`;
    expect((await api(app, w.owner, "GET", url(w.g))).json).toEqual({ whispers: [], nextBefore: null });
    expect((await api(app, w.owner, "GET", url(w.agent.conversationId))).json).toEqual({ whispers: [], nextBefore: null });
    expect(await api(app, w.mia, "GET", url(w.g))).toEqual({ status: 404, json: { error: "not_found" } });
    const made = await whisper(w);
    // Its Agent taken out of the group: the whisper expired, still hers to see.
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.agent.id}`)).status).toBe(200);
    expect((await api(app, w.owner, "GET", url(w.g))).json.whispers.map((x: any) => [x.id, x.status])).toEqual([[made.id, "expired"]]);
  });

  /** `n` answered whispers of olive's at `afterSeq`, each a second newer than the last, straight in the table. */
  const answeredMany = (w: World, n: number, afterSeq: number) =>
    db.query(
      `insert into whispers (conversation_id, owner_id, agent_id, after_seq, kind, body, status, created_at, resolved_at)
       select $1, $2, $3, $4, 'memory', '{"text": "答过了", "actions": ["dismiss"]}', 'declined', now() + g * interval '1 second', now()
         from generate_series(1, $5::int) g`,
      [w.g, w.owner.id, w.agent.id, afterSeq, n],
    );

  it("sync and catch-up keep the open ones first within their 500, then the newest answered ones", async () => {
    const w = await world();
    const open = await whisper(w);
    // 500 answered ones, all newer than the open one, in the same window.
    await answeredMany(w, 500, open.afterSeq);
    const sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(sync.whispers).toHaveLength(500);
    expect(sync.whispers.filter((x: any) => x.status === "open").map((x: any) => x.id)).toEqual([open.id]);
    const caught = (await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [w.g]: 0 } })).json;
    expect(caught.whispers).toHaveLength(500);
    expect(caught.whispers.filter((x: any) => x.status === "open").map((x: any) => x.id)).toEqual([open.id]);
  });

  it("only the whispers of the owner's current stay: after leaving (or removal) and coming back, the earlier ones are not sent", async () => {
    const w = await world();
    // mia's group: olive and her Agent in it; olive removed, then let in again (and her Agent with her).
    const hers = await group(app, w.mia, "hers", [w.owner, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${hers}/members`, { principalId: w.agent.id })).status).toBe(201);
    const earlier = await whisper(w, { conversationId: hers });
    const answered = await whisper(w, { conversationId: hers });
    expect((await api(app, w.owner, "POST", `/api/whispers/${answered.id}/accept`)).status).toBe(200);
    expect((await api(app, w.mia, "DELETE", `/api/conversations/${hers}/members/${w.owner.id}`)).status).toBe(200);
    expect((await api(app, w.mia, "POST", `/api/conversations/${hers}/members`, { principalId: w.owner.id })).status).toBe(201);
    const url = `/api/conversations/${hers}/whispers`;
    // Back without her Agent: nothing of the earlier stay makes the list hers.
    expect(await api(app, w.owner, "GET", url)).toEqual({ status: 404, json: { error: "not_found" } });
    expect((await api(app, w.owner, "POST", `/api/conversations/${hers}/members`, { principalId: w.agent.id })).status).toBe(201);
    const sync = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect((sync.whispers ?? []).filter((x: any) => x.conversationId === hers)).toEqual([]);
    expect(sync.conversations.find((c: any) => c.id === hers).whispers).toBeUndefined();
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [hers]: 0 } })).json.whispers).toBeUndefined();
    expect((await api(app, w.owner, "GET", url)).json).toEqual({ whispers: [], nextBefore: null });
    expect((await api(app, w.owner, "GET", `${url}?before=${earlier.afterSeq + 1}`)).json).toEqual({ whispers: [], nextBefore: null });
    // One of this stay is.
    const now = await whisper(w, { conversationId: hers });
    expect((await api(app, w.owner, "GET", "/api/sync")).json.whispers.filter((x: any) => x.conversationId === hers).map((x: any) => x.id)).toEqual([now.id]);
    expect((await api(app, w.owner, "POST", "/api/sync/catchup", { positions: { [hers]: 0 } })).json.whispers.map((x: any) => x.id)).toEqual([now.id]);
    expect((await api(app, w.owner, "GET", url)).json.whispers.map((x: any) => x.id)).toEqual([now.id]);
  });

  it("the list route's page adds at most 100 more of the last place's whispers", async () => {
    const w = await world();
    const first = await whisper(w);
    await answeredMany(w, 150, first.afterSeq);
    const page = (await api(app, w.owner, "GET", `/api/conversations/${w.g}/whispers?limit=1`)).json;
    expect(page.whispers).toHaveLength(100);
    expect(page.nextBefore).toBeNull();
  });
});

describe("answering", () => {
  it("accept and decline once: the whisper as it is now, pushed to the owner's sockets; again, or the other answer, 409 stale_whisper", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const a = await whisper(w);
    const b = await whisper(w);
    await socket.waitFor((e) => e.type === "whisper" && e.whisper.id === b.id);
    const accepted = await api(app, w.owner, "POST", `/api/whispers/${a.id}/accept`);
    // Answered: its status, and a higher revision (of two copies, the later: its owner's clients keep it).
    expect(accepted).toEqual({ status: 200, json: { ...JSON.parse(JSON.stringify(toWireWhisper(a))), status: "accepted", revision: 1 } });
    expect(await socket.next((e) => e.type === "whisper" && e.whisper.status === "accepted")).toEqual({ type: "whisper", whisper: accepted.json });
    expect(await api(app, w.owner, "POST", `/api/whispers/${a.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect(await api(app, w.owner, "POST", `/api/whispers/${a.id}/decline`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    const declined = await api(app, w.owner, "POST", `/api/whispers/${b.id}/decline`, {});
    expect(declined.json.status).toBe("declined");
    expect(await api(app, w.owner, "POST", `/api/whispers/${b.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    const rows = (await db.query("select status, resolved_at is not null as resolved from whispers order by created_at")).rows;
    expect(rows).toEqual([
      { status: "accepted", resolved: true },
      { status: "declined", resolved: true },
    ]);
  });

  it("M-13: an answer once stored stands — a push after it that fails is logged as a code, nothing of the whisper, and the answer is 200", async () => {
    const w = await world();
    const made = await whisper(w, { kind: "found_elsewhere", body: found(w) });
    const from = logLines.length;
    const failing = vi.spyOn(app.realtime, "pushWhisper").mockImplementation(() => {
      throw Object.assign(new Error(`push failed: ${BODY.text}`), { code: "XX000" });
    });
    const declined = await api(app, w.owner, "POST", `/api/whispers/${made.id}/decline`).finally(() => failing.mockRestore());
    expect([declined.status, declined.json.status]).toEqual([200, "declined"]);
    expect(await statusOf(made.id)).toBe("declined");
    const lines = logLines.slice(from);
    expect(lines.filter((l) => l.includes('"code":"XX000"'))).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(BODY.text);
    expect(lines.join("\n")).not.toContain("周五");
  });

  it("an answer's own copy is read in its own transaction: a database that fails once the answer has committed cannot turn a stored answer into a 500", async () => {
    const w = await world();
    for (const verb of ["decline", "accept"] as const) {
      const made = await whisper(w, { kind: "found_elsewhere", body: found(w) });
      const real = app.deps.db.tx.bind(app.deps.db);
      let committed = false;
      const failing = vi.spyOn(app.deps.db, "tx").mockImplementation((async (fn: Parameters<typeof real>[0]) => {
        if (committed) throw Object.assign(new Error("the database went away"), { code: "57P01" });
        const done = await real(fn);
        committed = true;
        return done;
      }) as typeof real);
      const answered = await api(app, w.owner, "POST", `/api/whispers/${made.id}/${verb}`).finally(() => failing.mockRestore());
      expect([verb, answered.status, answered.json.status]).toEqual([verb, 200, verb === "decline" ? "declined" : "telling"]);
      expect([verb, committed]).toEqual([verb, true]);
    }
  });

  it("M-13: an accept whose push fails still does what follows it (its hook's step after commit: the told reply's announcement)", async () => {
    const w = await world();
    const made = await whisper(w, { kind: "found_elsewhere", body: found(w) });
    const realHook = ANSWER_HOOKS.found_elsewhere;
    let followed = 0;
    ANSWER_HOOKS.found_elsewhere = { accepted: async () => () => void followed++ };
    const failing = vi.spyOn(app.realtime, "pushWhisper").mockImplementation(() => {
      throw Object.assign(new Error("push failed"), { code: "XX000" });
    });
    try {
      expect((await api(app, w.owner, "POST", `/api/whispers/${made.id}/accept`)).status).toBe(200);
    } finally {
      failing.mockRestore();
      ANSWER_HOOKS.found_elsewhere = realHook;
    }
    expect(followed).toBe(1);
  });

  it("only with a button it offers: accept needs `tell`, decline `dismiss`", async () => {
    const w = await world();
    const onlyDismiss = await whisper(w, { body: { text: "知道了", actions: ["dismiss"] } });
    const none = await whisper(w, { body: { text: "只是告诉你", actions: [] } });
    expect(await api(app, w.owner, "POST", `/api/whispers/${onlyDismiss.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect(await api(app, w.owner, "POST", `/api/whispers/${none.id}/decline`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect((await api(app, w.owner, "POST", `/api/whispers/${onlyDismiss.id}/decline`)).json.status).toBe("declined");
  });

  it("resolveWhisper: gone for anyone else's or no whisper, stale for one that is not open, the row once it is answered", async () => {
    const w = await world();
    const made = await whisper(w);
    expect(await db.tx((t) => resolveWhisper(t, w.mia.id, made.id, "accepted"))).toBe("gone");
    expect(await db.tx((t) => resolveWhisper(t, w.owner.id, "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d", "accepted"))).toBe("gone");
    const done = await db.tx((t) => resolveWhisper(t, w.owner.id, made.id, "declined"));
    expect(done).toMatchObject({ id: made.id, status: "declined" });
    expect((done as Whisper).resolvedAt).toBeInstanceOf(Date);
    expect(await db.tx((t) => resolveWhisper(t, w.owner.id, made.id, "declined"))).toBe("stale");
  });

  it("someone else's whisper, an id that is none, or a malformed one: 404 (400 for the malformed)", async () => {
    const w = await world();
    const made = await whisper(w);
    for (const verb of ["accept", "decline"]) {
      expect(await api(app, w.mia, "POST", `/api/whispers/${made.id}/${verb}`)).toEqual({ status: 404, json: { error: "not_found" } });
      expect(await api(app, w.owner, "POST", `/api/whispers/6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d/${verb}`)).toEqual({ status: 404, json: { error: "not_found" } });
      expect((await api(app, w.owner, "POST", `/api/whispers/nope/${verb}`)).status).toBe(400);
      expect((await api(app, null, "POST", `/api/whispers/${made.id}/${verb}`)).status).toBe(401);
    }
    expect(await statusOf(made.id)).toBe("open");
  });
});

describe("against the Agent's delete and its leaving (lock order: conversation → Agent → whisper rows, last)", () => {
  it("a whisper made while its Agent is being deleted waits for the delete's lock on the Agent, then is refused: never an open whisper of a deleted Agent", async () => {
    const w = await world();
    // The delete's own transaction as DELETE /api/agents/:id runs it, held open once it has expired the Agent's whispers.
    const del = holding(async (t) => {
      await setAgentState(t, await lockAgent(t, w.agent.id), { deleted: true });
      await expireOfAgent(t, w.agent.id);
    });
    await del.held;
    const made = db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: w.owner.id, agentId: w.agent.id, kind: "memory", body: BODY }));
    const waited = await waitsForALock(made);
    del.release();
    await del.done;
    expect([waited, await made]).toEqual([true, null]);
    expect((await db.query("select count(*)::int n from whispers where agent_id = $1 and status = 'open'", [w.agent.id])).rows[0].n).toBe(0);
  });

  it("a deleted Agent leaving a group expires what is still open of it there, pushed to its owner", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const made = await whisper(w);
    await socket.waitFor((e) => e.type === "whisper" && e.whisper.id === made.id);
    // Deleted without its delete's own expiry (what a whisper made before the lock above existed could have left open).
    await db.query("update agents set deleted_at = now() where principal_id = $1", [w.agent.id]);
    expect(await leaveGroupsOfDeleted({ db, conversations: app.deps.conversations, log: app.log, realtime: app.realtime }, w.agent.id)).toBe(1);
    expect(await statusOf(made.id)).toBe("expired");
    expect((await socket.next((e) => e.type === "whisper" && e.whisper.status === "expired")).whisper.id).toBe(made.id);
  });

  for (const [what, cut] of [
    ["its Agent is deleted", (w: World) => db.query("update agents set deleted_at = now() where principal_id = $1", [w.agent.id])],
    ["its owner is no longer a member", (w: World) => db.query("update memberships set left_seq = joined_seq where conversation_id = $1 and principal_id = $2 and left_seq is null", [w.g, w.owner.id])],
    ["its Agent is no longer a member", (w: World) => db.query("update memberships set left_seq = joined_seq where conversation_id = $1 and principal_id = $2 and left_seq is null", [w.g, w.agent.id])],
  ] as const) {
    it(`an answer finds an open whisper gone (404, nothing changes) once ${what}, whatever was expired`, async () => {
      const w = await world();
      const made = await whisper(w);
      await cut(w);
      for (const verb of ["accept", "decline"]) expect(await api(app, w.owner, "POST", `/api/whispers/${made.id}/${verb}`)).toEqual({ status: 404, json: { error: "not_found" } });
      expect(await db.tx((t) => resolveWhisper(t, w.owner.id, made.id, "accepted"))).toBe("gone");
      expect(await statusOf(made.id)).toBe("open");
    });
  }

  it("an answer waits for a delete's lock on the Agent's row before it takes the whisper's: with a hook that locks the Agent, no deadlock", async () => {
    const w = await world();
    const made = await whisper(w, { kind: "found_elsewhere", body: found(w) });
    const realHook = ANSWER_HOOKS.found_elsewhere;
    ANSWER_HOOKS.found_elsewhere = LOCKS_THE_AGENT;
    try {
      // The delete: the Agent's conversation and row, then (once the accept waits) its whispers — whisper rows last — and commit.
      const del = holding(
        async (t) => setAgentState(t, await lockAgent(t, w.agent.id), { deleted: true }),
        (t) => expireOfAgent(t, w.agent.id),
      );
      await del.held;
      const accepting = api(app, w.owner, "POST", `/api/whispers/${made.id}/accept`);
      expect(await waitsForALock(accepting)).toBe(true);
      del.release();
      await del.done;
      expect(await accepting).toEqual({ status: 404, json: { error: "not_found" } });
      expect(await statusOf(made.id)).toBe("expired");
    } finally {
      ANSWER_HOOKS.found_elsewhere = realHook;
    }
  });

  it("an accept and the Agent's delete at the same moment, 20 times: never an error, and one outcome each time", async () => {
    const w = await world();
    const realHook = ANSWER_HOOKS.found_elsewhere;
    let hooked = 0;
    ANSWER_HOOKS.found_elsewhere = { accepted: async (t, x) => void (hooked++, await LOCKS_THE_AGENT.accepted(t, x)) };
    try {
      for (let i = 0; i < 20; i++) {
        const agent = await mustCreateAgent(app, w.owner, { model: FAST });
        expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/members`, { principalId: agent.id })).status).toBe(201);
        const made = await whisper(w, { agentId: agent.id, kind: "found_elsewhere", body: found(w) });
        const before = hooked;
        const [accepted, deleted] = await Promise.all([api(app, w.owner, "POST", `/api/whispers/${made.id}/accept`), api(app, w.owner, "DELETE", `/api/agents/${agent.id}`)]);
        expect([i, deleted.status]).toEqual([i, 200]);
        // Answered first (its hook ran, nothing stored), then expired by the delete; or found gone (404) after it.
        if (accepted.status === 200) expect([i, accepted.json.status, hooked - before]).toEqual([i, "open", 1]);
        else expect([i, accepted.status, hooked - before]).toEqual([i, 404, 0]);
        expect([i, await statusOf(made.id)]).toEqual([i, "expired"]);
      }
    } finally {
      ANSWER_HOOKS.found_elsewhere = realHook;
    }
  }, 60_000);

  it("two accepts of one Agent's whispers in two groups at the same moment, 20 times, with a hook that locks the Agent for update: both answered, never a deadlock", async () => {
    const w = await world();
    const g2 = await group(app, w.owner, "two", [w.mia, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${g2}/members`, { principalId: w.agent.id })).status).toBe(201);
    // Each accept's hook waits (a little) for the other's to get there too before it locks the Agent's row: if both answers
    // could hold the row at once (for share), both would then wait for the other's lock to go.
    let meet: { arrived: number; both: Promise<void>; release: () => void };
    const round = () => {
      const both = deferred();
      meet = { arrived: 0, both: both.promise, release: () => both.resolve() };
    };
    const realHook = ANSWER_HOOKS.found_elsewhere;
    ANSWER_HOOKS.found_elsewhere = {
      accepted: async (t, x) => {
        if (++meet.arrived === 2) meet.release();
        await Promise.race([meet.both, new Promise((r) => setTimeout(r, 300))]);
        await t.query("select 1 from agents where principal_id = $1 for update", [x.agentId]);
      },
    };
    try {
      for (let i = 0; i < 20; i++) {
        round();
        const [a, b] = [await whisper(w, { kind: "found_elsewhere", body: found(w) }), await whisper(w, { conversationId: g2, kind: "found_elsewhere", body: found(w) })];
        const answers = await Promise.all([a, b].map((x) => api(app, w.owner, "POST", `/api/whispers/${x.id}/accept`)));
        expect([i, answers.map((r) => r.status), meet!.arrived]).toEqual([i, [200, 200], 2]);
        // Both answered: nothing stored (the hook's told reply would be what makes them telling).
        expect([i, await statusOf(a.id), await statusOf(b.id)]).toEqual([i, "open", "open"]);
      }
    } finally {
      ANSWER_HOOKS.found_elsewhere = realHook;
    }
  }, 60_000);
});

describe("expiry", () => {
  it("an open whisper older than 7 days is set expired by the sweep (the clock is its argument); answered ones and younger ones stay", async () => {
    expect(WHISPER_OPEN_DAYS).toBe(7);
    const w = await world();
    const old = await whisper(w);
    const young = await whisper(w);
    const answered = await whisper(w);
    expect((await api(app, w.owner, "POST", `/api/whispers/${answered.id}/decline`)).status).toBe(200);
    await age(old.id, 8);
    await age(answered.id, 8);
    await age(young.id, 6);
    const expired = await expireWhispers(db);
    expect(expired.map((x) => [x.id, x.status])).toEqual([[old.id, "expired"]]);
    expect([await statusOf(old.id), await statusOf(young.id), await statusOf(answered.id)]).toEqual(["expired", "open", "declined"]);
    expect(await api(app, w.owner, "POST", `/api/whispers/${old.id}/accept`)).toEqual({ status: 409, json: { error: "stale_whisper" } });
    expect((await expireWhispers(db, new Date(Date.now() + 2 * DAY))).map((x) => x.id)).toEqual([young.id]);
  });

  it("is bounded: at most `batches` batches of `batch` rows a run (500 and 20 by default), the rest on the next run", async () => {
    expect(WHISPER_SWEEP_BATCH).toBe(500);
    const w = await world();
    for (let i = 0; i < 5; i++) await age((await whisper(w)).id, 10);
    expect((await expireWhispers(db, new Date(), { batch: 2, batches: 2 })).length).toBe(4);
    expect((await expireWhispers(db, new Date(), { batch: 2, batches: 2 })).length).toBe(1);
  });

  it("takes them in a fixed order (by id), and skips one another transaction holds instead of waiting for it", async () => {
    const w = await world();
    const made: Whisper[] = [];
    for (let i = 0; i < 4; i++) made.push(await whisper(w));
    // The oldest is not the first by id: the order is the id's, not the age's.
    const byId = [...made].sort((a, b) => (a.id < b.id ? -1 : 1));
    for (const [i, x] of byId.entries()) await age(x.id, 20 - i);
    await age(byId[0]!.id, 8);
    expect((await expireWhispers(db, new Date(), { batch: 1, batches: 1 })).map((x) => x.id)).toEqual([byId[0]!.id]);
    // byId[1] is held (an answer in flight, say): the sweep does not wait for it.
    const held = holding((t) => t.query("select 1 from whispers where id = $1 for update", [byId[1]!.id]));
    await held.held;
    try {
      const sweeping = expireWhispers(db);
      expect(await waitsForALock(sweeping, 1500)).toBe(false);
      expect((await sweeping).map((x) => x.id).sort()).toEqual([byId[2]!.id, byId[3]!.id].sort());
    } finally {
      held.release();
      await held.done;
    }
    expect((await expireWhispers(db)).map((x) => x.id)).toEqual([byId[1]!.id]);
  });

  it("an answered or expired whisper made 30 days ago is deleted (bounded, skipping a row in use); open ones and younger ones stay", async () => {
    expect(WHISPER_KEEP_DAYS).toBe(30);
    const w = await world();
    const [accepted, declined, expired, young, open] = [await whisper(w), await whisper(w), await whisper(w), await whisper(w), await whisper(w)];
    expect((await api(app, w.owner, "POST", `/api/whispers/${accepted.id}/accept`)).status).toBe(200);
    expect((await api(app, w.owner, "POST", `/api/whispers/${declined.id}/decline`)).status).toBe(200);
    expect((await api(app, w.owner, "POST", `/api/whispers/${young.id}/decline`)).status).toBe(200);
    await db.query("update whispers set status = 'expired', resolved_at = now() where id = $1", [expired.id]);
    for (const x of [accepted, declined, expired, open]) await age(x.id, 31);
    await age(young.id, 29);
    expect(await removeOldWhispers(db)).toBe(3);
    expect((await db.query("select id from whispers order by id")).rows.map((r) => r.id)).toEqual([young.id, open.id].sort());
    // A later clock reaches the younger one.
    expect(await removeOldWhispers(db, new Date(Date.now() + 2 * DAY))).toBe(1);
    // Bounded, as the expiry is; a row another transaction holds is skipped, not waited for.
    for (let i = 0; i < 5; i++) {
      const x = await whisper(w);
      await db.query("update whispers set status = 'declined', resolved_at = now(), created_at = now() - interval '40 days' where id = $1", [x.id]);
    }
    const one = (await db.query("select id from whispers where status = 'declined' order by id limit 1")).rows[0].id;
    const held = holding((t) => t.query("select 1 from whispers where id = $1 for update", [one]));
    await held.held;
    try {
      const removing = removeOldWhispers(db, new Date(), { batch: 2, batches: 1 });
      expect(await waitsForALock(removing, 1500)).toBe(false);
      expect(await removing).toBe(2);
      expect(await removeOldWhispers(db, new Date(), { batch: 2, batches: 5 })).toBe(2);
    } finally {
      held.release();
      await held.done;
    }
    expect(await removeOldWhispers(db)).toBe(1);
    expect((await db.query("select status from whispers")).rows).toEqual([{ status: "open" }]);
  });

  it("runs with the periodic sweep of memory changes (its timer, no new one) and pushes the owner the expired whisper; it deletes the 30-day-old answered ones", async () => {
    const w = await world();
    const old = await whisper(w);
    await age(old.id, 8);
    const done = await whisper(w);
    expect((await api(app, w.owner, "POST", `/api/whispers/${done.id}/decline`)).status).toBe(200);
    await age(done.id, 31);
    // Its first run comes 1.5 s after the start: time enough to open the owner's socket on it.
    const sweeping = await buildApp(
      { config: { ...app.deps.config, sweepIntervalMinutes: 0, memory: { ...app.deps.config.memory, changesSweepMs: 3_600_000 } }, db, blobs: app.deps.blobs, models: gateway },
      { sweepInitialDelayMs: 1500, agentWorker: false, staleRunSweep: false },
    );
    try {
      await sweeping.ready();
      const socket = await connect(sweeping, w.owner);
      const push = await socket.next((e) => e.type === "whisper", { timeoutMs: 5000 });
      expect(push.whisper).toMatchObject({ id: old.id, status: "expired" });
      expect(await statusOf(old.id)).toBe("expired");
      expect(await statusOf(done.id)).toBeNull();
      socket.close();
      await socket.closed;
    } finally {
      await sweeping.close();
    }
  });

  it("the owner leaving the group expires their whispers there (their Agent leaves with them); others' stay", async () => {
    const w = await world();
    const ned = w.ned;
    const nedsAgent = await mustCreateAgent(app, ned, { model: FAST });
    expect((await api(app, ned, "POST", `/api/conversations/${w.g}/members`, { principalId: nedsAgent.id })).status).toBe(201);
    const mine = await whisper(w);
    const elsewhere = await whisper(w, { conversationId: w.agent.conversationId });
    const neds = await db.tx((t) => createWhisper(t, { conversationId: w.g, ownerId: ned.id, agentId: nedsAgent.id, kind: "memory", body: BODY }));
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.owner.id}`)).status).toBe(200);
    expect([await statusOf(mine.id), await statusOf(elsewhere.id), await statusOf(neds!.id)]).toEqual(["expired", "open", "open"]);
    expect((await db.query("select resolved_at is not null as done from whispers where id = $1", [mine.id])).rows[0]).toEqual({ done: true });
  });

  it("being removed expires them too; so does the Agent alone being taken out, pushed to the owner who stays", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const made = await whisper(w);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.agent.id}`)).status).toBe(200);
    expect(await statusOf(made.id)).toBe("expired");
    expect((await socket.next((e) => e.type === "whisper" && e.whisper.status === "expired")).whisper.id).toBe(made.id);
    // Removed by the creator: mia's group, olive and her Agent in it.
    const hers = await group(app, w.mia, "hers", [w.owner, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${hers}/members`, { principalId: w.agent.id })).status).toBe(201);
    const there = await whisper(w, { conversationId: hers });
    expect((await api(app, w.mia, "DELETE", `/api/conversations/${hers}/members/${w.owner.id}`)).status).toBe(200);
    expect(await statusOf(there.id)).toBe("expired");
  });

  it("deleting the Agent expires its open whispers everywhere (pushed to its owner); its rows go with it when the Agent row goes", async () => {
    const w = await world();
    const socket = await connect(app, w.owner);
    const inGroup = await whisper(w);
    const own = await whisper(w, { conversationId: w.agent.conversationId });
    expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}`)).status).toBe(200);
    expect([await statusOf(inGroup.id), await statusOf(own.id)]).toEqual(["expired", "expired"]);
    await socket.waitFor((e) => e.type === "whisper" && e.whisper.id === own.id && e.whisper.status === "expired");
    const fk = await db.query<{ confdeltype: string; target: string }>(
      `select c.confdeltype, t.relname as target from pg_constraint c join pg_class t on t.oid = c.confrelid
        where c.conrelid = 'whispers'::regclass and c.contype = 'f' order by t.relname`,
    );
    expect(fk.rows).toEqual([
      { confdeltype: "c", target: "agents" },
      { confdeltype: "c", target: "conversations" },
      { confdeltype: "c", target: "principals" },
    ]);
  });

  it("has the indexes the reads and the sweep use", async () => {
    const { rows } = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'whispers'");
    expect(rows.some((r) => /\(owner_id, conversation_id, after_seq\)/.test(r.indexdef))).toBe(true);
    expect(rows.some((r) => /\(status, created_at\)/.test(r.indexdef))).toBe(true);
    // The open ones of an owner in a conversation (their count on every sync, the open half of sync): a partial index.
    expect(rows.some((r) => /\(owner_id, conversation_id\) WHERE \(status = 'open'::text\)/.test(r.indexdef))).toBe(true);
    // A whisper's told replies (its state is read from them: telling, told): migration 058.
    const runs = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'agent_runs'");
    expect(runs.rows.some((r) => /\(whisper_id\) WHERE \(whisper_id IS NOT NULL\)/.test(r.indexdef))).toBe(true);
  });
});
