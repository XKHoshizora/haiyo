import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createWhisper, expireWhispers, type Whisper } from "../src/whispers/store.ts";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type TestSocket } from "./helpers/ws.ts";

/**
 * Nothing about a whisper reaches anyone but its owner (design rules 16 and 19; review focus 5): a fellow member's socket and
 * every read route they have, polled before, during and after a whisper's whole life (created, answered, expired), answer
 * byte for byte the same — no frame, no key, no count, no change of `lastSeq`, unread, catch-up or search —; the three
 * whisper routes answer them and a stranger exactly as an id that is none; and the Agent's model is never shown it.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";
const CANARY = "WHISPER-zq9 只给主人看的悄悄话";
/** Keys only a whisper's owner ever receives (also in agents-co-members.test.ts and proactive-decide.test.ts). */
const WHISPER_KEYS = ["whisper", "whispers", "afterSeq", "lastTellFailed", "openUntil", "retryableUntil"];

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `wp${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

/** olive and her Agent in her group with mia (no Agent) and ned (who has one there too); sam is in no conversation with them. */
async function world() {
  const [owner, mia, ned, sam] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned"), await signUp(app, "sam")];
  const agent = await mustCreateAgent(app, owner, { handle: "olive_bot", name: "Olive Bot", model: FAST, persona: "简短地回答。" });
  const nedsAgent = await mustCreateAgent(app, ned, { model: FAST });
  const g = await group(app, owner, "team", [mia, ned]);
  expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  expect((await api(app, ned, "POST", `/api/conversations/${g}/members`, { principalId: nedsAgent.id })).status).toBe(201);
  await say(mia, g, "大家好");
  await say(owner, g, "你好");
  // What its found_elsewhere whispers point at: a message of the owner's own, in her Agent's conversation.
  const note = await say(owner, agent.conversationId, "记一下：周五带伞");
  await db.query("update agent_runs set status = 'cancelled', finished_at = now() where agent_id = $1 and status = 'queued'", [agent.id]);
  return { owner, mia, ned, sam, agent: agent as { id: string; conversationId: string; handle: string }, g, note };
}
type World = Awaited<ReturnType<typeof world>>;

/**
 * A whisper of the owner's in `conversationId` (the group by default), pushed to her: a `found_elsewhere` one whose hit is a
 * real reference (her own note), so it reads open; or (`kind` memory) one of the kinds whose 告诉他们 answers it `accepted`.
 */
async function whisper(w: World, conversationId = w.g, kind: "found_elsewhere" | "memory" = "found_elsewhere"): Promise<Whisper> {
  const detail = kind === "found_elsewhere" ? { hits: [{ conversationId: w.agent.conversationId, seq: w.note, at: 0 }] } : { seq: 1 };
  const made = await db.tx((t) => createWhisper(t, { conversationId, ownerId: w.owner.id, agentId: w.agent.id, kind, body: { text: CANARY, actions: ["tell", "dismiss"], detail } }));
  if (!made) throw new Error("whisper refused");
  app.realtime.pushWhisper(made);
  return made;
}

/** Everything `who` can read about the group (and the whisper id `id`, when there is one), by label. */
async function reads(w: World, who: Actor, id: string): Promise<Array<[string, number, unknown]>> {
  const seq = Number((await db.query("select seq from conversations where id = $1", [w.g])).rows[0].seq);
  const out: Array<[string, number, unknown]> = [];
  const read = async (label: string, method: "GET" | "POST", url: string, body?: unknown) => {
    const res = await api(app, who, method, url, body);
    out.push([label, res.status, res.json]);
  };
  await read("sync", "GET", "/api/sync");
  await read("one conversation", "GET", `/api/conversations/${w.g}`);
  await read("members", "GET", `/api/conversations/${w.g}/members`);
  await read("history", "GET", `/api/conversations/${w.g}/messages`);
  await read("history page", "GET", `/api/conversations/${w.g}/messages?limit=1&before=${seq + 1}`);
  await read("the last message", "GET", `/api/conversations/${w.g}/messages/${seq}`);
  await read("search", "GET", `/api/conversations/${w.g}/search?q=${encodeURIComponent("WHISPER-zq9")}`);
  await read("search 2", "GET", `/api/conversations/${w.g}/search?q=${encodeURIComponent("悄悄话")}`);
  await read("global search", "GET", `/api/search?q=${encodeURIComponent("WHISPER-zq9")}`);
  await read("catch-up", "POST", "/api/sync/catchup", { positions: { [w.g]: 0 } });
  await read("catch-up at the end", "POST", "/api/sync/catchup", { positions: { [w.g]: seq } });
  await read("group replies", "GET", `/api/conversations/${w.g}/runs`);
  await read("whispers", "GET", `/api/conversations/${w.g}/whispers`);
  await read("whispers page", "GET", `/api/conversations/${w.g}/whispers?before=${seq + 1}&limit=5`);
  await read("accept", "POST", `/api/whispers/${id}/accept`);
  await read("decline", "POST", `/api/whispers/${id}/decline`);
  return out;
}

/** Nothing of a whisper in `bodies`: no key of one, its text or its id. */
function nothingOf(bodies: Array<[string, unknown]>, ids: string[]): void {
  expect(bodies.length).toBeGreaterThan(0);
  for (const [label, body] of bodies) {
    const keys = keysOf(body);
    expect([label, WHISPER_KEYS.filter((k) => keys.has(k))]).toEqual([label, []]);
    const text = JSON.stringify(body);
    for (const value of ["WHISPER-zq9", ...ids]) expect([label, value, text.includes(value)]).toEqual([label, value, false]);
  }
}

describe("a whisper's whole life, as everyone but its owner sees it", () => {
  it("a fellow member, the owner of another Agent there and a stranger: every read route the same before, during and after; no frame; the owner meanwhile gets everything", async () => {
    const w = await world();
    const [miaSocket, nedSocket, samSocket, ownerSocket] = [await connect(app, w.mia), await connect(app, w.ned), await connect(app, w.sam), await connect(app, w.owner)];
    const others: Array<[string, Actor, TestSocket]> = [
      ["mia", w.mia, miaSocket],
      ["ned", w.ned, nedSocket],
      ["sam", w.sam, samSocket],
    ];
    const ownerBefore = (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json;
    // What they read before any whisper exists — the ids they ask for are a random one's.
    const before = new Map<string, Array<[string, number, unknown]>>();
    for (const [name, who] of others) before.set(name, await reads(w, who, RANDOM));
    // Their whisper routes answer as for an id that is none (ned, who has an Agent there, reads an empty list of his own).
    for (const [name] of others) {
      for (const [label, status, body] of before.get(name)!) {
        if (label.startsWith("whispers") && name === "ned") expect([name, label, status, body]).toEqual([name, label, 200, { whispers: [], nextBefore: null }]);
        else if (label.startsWith("whispers") || label === "accept" || label === "decline") expect([name, label, status, body]).toEqual([name, label, 404, { error: "not_found" }]);
      }
    }

    const ids: string[] = [];
    const phase = async (what: string, id: string) => {
      for (const [name, who] of others) {
        const now = await reads(w, who, id);
        // The same answers, byte for byte, as before the whisper existed: its id is answered as a random one's.
        expect([what, name, now]).toEqual([what, name, before.get(name)]);
      }
      const owner = (await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json;
      expect([what, owner.lastSeq, owner.unread, owner.readSeq]).toEqual([what, ownerBefore.lastSeq, ownerBefore.unread, ownerBefore.readSeq]);
    };

    // Created (a found_elsewhere one, its hit read for the owner): the owner is pushed it.
    const a = await whisper(w);
    ids.push(a.id);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === a.id && e.whisper.status === "open");
    expect((await api(app, w.owner, "GET", `/api/conversations/${w.g}`)).json.whispers).toBe(1);
    await phase("open", a.id);
    // Answered 不用.
    expect((await api(app, w.owner, "POST", `/api/whispers/${a.id}/decline`)).status).toBe(200);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === a.id && e.whisper.status === "declined");
    await phase("declined", a.id);
    // With no hit left to read (its reference points at nothing): it reads expired, and is pushed so.
    const b = await whisper(w);
    ids.push(b.id);
    await db.query("update whispers set body = jsonb_set(body, '{detail,hits}', $2::jsonb) where id = $1", [b.id, JSON.stringify([{ conversationId: w.agent.conversationId, seq: 999_999, at: 0 }])]);
    app.realtime.pushWhisper(b);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === b.id && e.whisper.status === "expired");
    await phase("no hit left", b.id);
    // One of the kinds 告诉他们 answers `accepted`.
    const m = await whisper(w, w.g, "memory");
    ids.push(m.id);
    expect((await api(app, w.owner, "POST", `/api/whispers/${m.id}/accept`)).status).toBe(200);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === m.id && e.whisper.status === "accepted");
    await phase("accepted", m.id);
    // Expired by the sweep, pushed to the owner as the app does.
    const c = await whisper(w);
    ids.push(c.id);
    await db.query("update whispers set created_at = now() - interval '8 days' where id = $1", [c.id]);
    for (const x of await expireWhispers(db)) app.realtime.pushWhisper(x);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === c.id && e.whisper.status === "expired");
    await phase("expired", c.id);
    // One open in the Agent's own conversation too.
    const d = await whisper(w, w.agent.conversationId);
    ids.push(d.id);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === d.id);
    await phase("another open", d.id);

    // The owner's pushes went through the group's queue after everything the others could have been sent: none was.
    for (const [name, , socket] of others) expect([name, socket.events]).toEqual([name, []]);
    // Positive control: the owner's own reads carry them.
    const mine = (await api(app, w.owner, "GET", "/api/sync")).json;
    expect(mine.whispers.map((x: any) => x.id).sort()).toEqual([...ids].sort());
    expect(mine.whispers.find((x: any) => x.id === d.id).text).toBe(CANARY);

    // Search finds it for nobody, the owner included; unread counts nothing of it.
    for (const who of [w.owner, w.mia]) {
      expect((await api(app, who, "GET", `/api/search?q=${encodeURIComponent("WHISPER-zq9")}`)).json.messages).toEqual([]);
      expect((await api(app, who, "GET", `/api/conversations/${w.g}/search?q=${encodeURIComponent("悄悄话")}`)).json.messages).toEqual([]);
    }
  });

  it("its Agent taken out of the group: the others see the leaving, and nothing of the whisper it expires", async () => {
    const w = await world();
    const miaSocket = await connect(app, w.mia);
    const ownerSocket = await connect(app, w.owner);
    const a = await whisper(w);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === a.id);
    expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.agent.id}`)).status).toBe(200);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.status === "expired");
    await miaSocket.waitFor((e) => e.type === "message" && e.message.system?.event === "member_removed");
    const bodies: Array<[string, unknown]> = miaSocket.events.map((e, i) => [`frame ${i}`, e]);
    for (const [label, , body] of await reads(w, w.mia, a.id)) bodies.push([label, body]);
    nothingOf(bodies, [a.id]);
  });

  it("someone who joins after a whisper was made sees nothing of it, nor of one made after they came", async () => {
    const w = await world();
    const ownerSocket = await connect(app, w.owner);
    const a = await whisper(w);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === a.id);
    const lee = await signUp(app, "lee");
    await befriend(app, w.owner, lee);
    // Lee's socket is open before the join, and the join's own frame to it is waited for: what comes after is all that is
    // read (a socket opened after the join could get that frame or not, by timing).
    const leeSocket = await connect(app, lee);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.g}/members`, { principalId: lee.id })).status).toBe(201);
    await leeSocket.waitFor((e) => e.type === "conversation" && e.id === w.g);
    const joined = leeSocket.events.length;
    // And a socket of lee's opened after the join (a reconnect): both shapes.
    const laterSocket = await connect(app, lee);
    const first = await reads(w, lee, a.id);
    const b = await whisper(w);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === b.id);
    expect((await api(app, w.owner, "POST", `/api/whispers/${b.id}/decline`)).status).toBe(200);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === b.id && e.whisper.status === "declined");
    // Byte for byte what they read before the second one (its id answered as the first's was: as an id that is none).
    expect(await reads(w, lee, b.id)).toEqual(first);
    // Settled on a message frame both sockets get after everything above (each socket's pushes keep their order).
    const last = await say(w.mia, w.g, "收尾");
    for (const s of [leeSocket, laterSocket]) await s.waitFor((e) => e.type === "message" && e.message.seq === last);
    const settledOn = (e: { type: string; message?: { seq: number } }) => e.type === "message" && e.message?.seq === last;
    expect(leeSocket.events.slice(joined).filter((e) => !settledOn(e as never))).toEqual([]);
    expect(laterSocket.events.filter((e) => !settledOn(e as never))).toEqual([]);
    for (const s of [leeSocket, laterSocket]) expect(s.events.some((e) => e.type === "whisper")).toBe(false);
    nothingOf(
      [...leeSocket.events, ...laterSocket.events].map((e, i): [string, unknown] => [`frame ${i}`, e]),
      [a.id, b.id],
    );
    nothingOf(
      first.map(([label, , body]) => [label, body]),
      [a.id, b.id],
    );
    for (const [label, status, body] of first) {
      if (label.startsWith("whispers") || label === "accept" || label === "decline") expect([label, status, body]).toEqual([label, 404, { error: "not_found" }]);
    }
  });

  /**
   * `run` ends the open whisper `made` (its owner's socket gets it expired) while the fellow members' `sockets` are open: they get what
   * `seen` waits for (the leaving), and nothing of the whisper — no frame of it, no key, its text or its id.
   */
  async function endsUnseen(
    sockets: TestSocket[],
    ownerSocket: TestSocket,
    made: Whisper,
    run: () => Promise<void>,
    seen: (e: any) => boolean,
    settle: { who: Actor; conversationId: string },
  ) {
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === made.id);
    await run();
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.id === made.id && e.whisper.status === "expired");
    for (const socket of sockets) await socket.waitFor(seen);
    // A frame known to come after everything the run pushed (each socket's pushes keep their order): a message, sent now,
    // then read — so a whisper frame sent to them after their leaving frame would be there too.
    const last = await say(settle.who, settle.conversationId, "收尾");
    for (const socket of sockets) await socket.waitFor((e) => e.type === "message" && e.message.conversationId === settle.conversationId && e.message.seq === last);
    const frames: Array<[string, unknown]> = sockets.flatMap((s, i) => s.events.map((e, j): [string, unknown] => [`socket ${i} frame ${j}`, e]));
    nothingOf(frames, [made.id]);
    for (const [label, frame] of frames) expect([label, (frame as { type: string }).type]).not.toEqual([label, "whisper"]);
  }

  it("the owner leaving with a whisper open: the others see the leaving, and nothing of the whisper it expires", async () => {
    const w = await world();
    const [miaSocket, nedSocket, ownerSocket] = [await connect(app, w.mia), await connect(app, w.ned), await connect(app, w.owner)];
    const made = await whisper(w);
    await endsUnseen(
      [miaSocket, nedSocket],
      ownerSocket,
      made,
      async () => expect((await api(app, w.owner, "DELETE", `/api/conversations/${w.g}/members/${w.owner.id}`)).status).toBe(200),
      (e) => e.type === "message" && e.message.system?.event === "member_left" && e.message.system?.principalId === w.owner.id,
      { who: w.mia, conversationId: w.g },
    );
  });

  it("the owner removed with a whisper open: the others see the removal, and nothing of the whisper it expires", async () => {
    const w = await world();
    const hers = await group(app, w.mia, "hers", [w.owner, w.ned]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${hers}/members`, { principalId: w.agent.id })).status).toBe(201);
    const [miaSocket, nedSocket, ownerSocket] = [await connect(app, w.mia), await connect(app, w.ned), await connect(app, w.owner)];
    const made = await whisper(w, hers);
    await endsUnseen(
      [miaSocket, nedSocket],
      ownerSocket,
      made,
      async () => expect((await api(app, w.mia, "DELETE", `/api/conversations/${hers}/members/${w.owner.id}`)).status).toBe(200),
      (e) => e.type === "message" && e.message.system?.event === "member_removed",
      { who: w.mia, conversationId: hers },
    );
  });

  it("the Agent deleted with a whisper open: the others see it leave, and nothing of the whisper the delete expires", async () => {
    const w = await world();
    const [miaSocket, nedSocket, ownerSocket] = [await connect(app, w.mia), await connect(app, w.ned), await connect(app, w.owner)];
    const made = await whisper(w);
    await endsUnseen(
      [miaSocket, nedSocket],
      ownerSocket,
      made,
      async () => expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}`)).status).toBe(200),
      (e) => e.type === "message" && e.message.system?.event === "member_left" && e.message.system?.principalId === w.agent.id,
      { who: w.mia, conversationId: w.g },
    );
  });

  it("the Agent's model is never shown a whisper: not in a group, not in its own conversation", async () => {
    const w = await world();
    await whisper(w);
    await whisper(w, w.agent.conversationId);
    gateway.reply("好的");
    await say(w.owner, w.g, `@${w.agent.handle} 在吗`);
    expect(await app.agentWorker.runOnce()).toBe(true);
    gateway.reply("在的");
    await say(w.owner, w.agent.conversationId, "你好");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls).toHaveLength(2);
    for (const call of gateway.calls) {
      const shown = JSON.stringify({ system: call.system, messages: call.messages });
      expect(shown).toContain(call === gateway.calls[0] ? "在吗" : "你好");
      expect(shown).not.toContain("WHISPER-zq9");
    }
  });
});

describe("who reads the whispers table (a static check)", () => {
  /**
   * Every statement in `source` that names the `whispers` table: read, written or joined. Model context, memory, search, the judge —
   * anything that could put a whisper in front of someone else — must go through src/whispers/ (owner_id = the reader) to reach one.
   */
  const TABLE = String.raw`(?:"?[a-z_][\w]*"?\.)?"?whispers"?(?![\w-])`;
  const NAMING = new RegExp(
    [
      String.raw`\b(?:from|join|into|update|table|references|using)\s+(?:only\s+)?${TABLE}`,
      // A comma join: `from a, whispers w where …` (an alias, then what SQL says next).
      String.raw`,\s*${TABLE}(?:\s+(?:as\s+)?\w+)?\s+(?:where|join|left|right|inner|full|cross|on|order|group|limit)\b`,
      String.raw`\b(?:copy|truncate)\s+(?:table\s+)?${TABLE}`,
    ].join("|"),
    "gi",
  );
  const tableRefs = (source: string): string[] => [...source.matchAll(NAMING)].map((m) => m[0]);

  it("the check finds every way of naming the table, and not the word in prose or other names", () => {
    for (const sql of [
      "select 1 from whispers w",
      "SELECT * FROM  whispers",
      "left join whispers on",
      'insert into "whispers" (id)',
      "update whispers set",
      "delete from whispers where",
      "alter table whispers add",
      "select 1 from conversations c, whispers w where w.id = c.id",
      "delete from agents a using whispers w where",
      "select * from public.whispers",
      'select * from "public"."whispers"',
      "truncate whispers",
      "truncate table whispers",
      "copy whispers to stdout",
    ]) {
      expect([sql, tableRefs(sql).length]).toEqual([sql, 1]);
    }
    for (const prose of [
      "// whispers from the owner",
      'import { whispersFrom } from "../whispers/store.ts"',
      "the whispers of whoever left",
      "from whispers_backup",
      "whispersFrom(t, me, from)",
      "pushWhispers(app.realtime, whispers);",
      "const { whispers, nextBefore } = page;",
      "[...messages, whispers]",
      "copy whispers_old",
    ]) {
      expect([prose, tableRefs(prose)]).toEqual([prose, []]);
    }
  });

  it("only src/whispers/ and the conversation list's count in src/sync/read.ts name it", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const filesUnder = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(path.join(dir, e.name)) : /\.[cm]?[jt]s$/.test(e.name) ? [path.join(dir, e.name)] : []));
    const naming = filesUnder(src)
      .filter((f) => tableRefs(readFileSync(f, "utf8")).length > 0)
      .map((f) => path.relative(src, f).replaceAll("\\", "/"))
      .sort();
    expect(naming.filter((f) => !f.startsWith("whispers/"))).toEqual(["sync/read.ts"]);
    expect(naming).toContain("whispers/store.ts");
  });
});
