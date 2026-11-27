import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { settled } from "../src/memory/stats.ts";
import { exactTs } from "../src/memory/write.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * Ring 1b, option A (`.superpowers/sdd/2026-11-22-polish/ring1b-design.md` §1, §7, §8): a social reply is shown what a group reply is
 * shown of its Agent's memory, minus hearsay and minus the origin-group exception — the owner's notes (with shared notes) and its own
 * that are not in the vault; nothing with its memory off. No post-time note check. What it was shown is recorded on its run.
 */
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, memory: true, tools: true, config: SOCIAL_ON });
afterEach(async () => {
  await closeAllSockets();
  await app.deps.memory?.idle();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
let txn = 0;
let n = 0;
const tag = () => `b${++n}${Math.random().toString(36).slice(2, 6)}`;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `r1b${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

async function world(over: { memory?: boolean; sharedNotes?: boolean } = {}) {
  const t = tag();
  const [owner, v] = [await signUp(app, `${t}o`), await signUp(app, `${t}v`)];
  const agent = (await mustCreateAgent(app, owner, { handle: `${t}y`, name: `小记${t}`, model: FAST, persona: "简短地回答。" })) as { id: string; conversationId: string };
  await db.query("update agents set memory = $2, shared_notes = $3 where principal_id = $1", [agent.id, over.memory ?? true, over.sharedNotes ?? true]);
  const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
  return { owner, v, agent, conv: seeded.conversationId };
}
type World = Awaited<ReturnType<typeof world>>;

/** A note written straight into a room, with its exact version (`exactTs`) as a run records it. */
async function note(w: World, kind: "owner" | "self", text: string, vault: boolean, origin: string | null = null): Promise<{ kind: "owner" | "self"; id: string; version: string }> {
  const sql =
    kind === "owner"
      ? `insert into owner_notes (owner_id, text, vault, origin_conversation_id) values ($1, $2, $3, $4) returning id, ${exactTs("updated_at")} as version`
      : `insert into agent_notes (agent_id, text, vault, origin_conversation_id) values ($1, $2, $3, $4) returning id, ${exactTs("updated_at")} as version`;
  const { rows } = await db.query<{ id: string; version: string }>(sql, [kind === "owner" ? w.owner.id : w.agent.id, text, vault, origin]);
  return { kind, id: rows[0]!.id, version: rows[0]!.version };
}
const runOf = async (w: World) =>
  (await db.query<{ id: string; status: string; error: string | null; interrupted: string | null; shown_notes: unknown; withheld_notes: unknown }>(
    "select id, status, error, interrupted, shown_notes, withheld_notes from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at desc, id desc limit 1",
    [w.agent.id, w.conv],
  )).rows[0]!;
const postedTexts = async (w: World) =>
  (await db.query<{ text: string }>("select body ->> 'text' as text from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [w.conv, w.agent.id])).rows.map((r) => r.text);

describe("T1: what a social reply is shown of its Agent's memory", () => {
  it("the notes outside the vault, the owner's and its own, as in a group; never the vault, never hearsay, never the origin-group exception", async () => {
    const w = await world();
    const ownerOpen = await note(w, "owner", "OWNER-OPEN-1b 主人爱吃辣", false);
    await note(w, "owner", "OWNER-VAULT-1b 主人的存款", true);
    // A vault note that began in this very conversation: a group would be shown it (its origin exception); a social reply never is.
    await note(w, "owner", "OWNER-ORIGIN-1b 主人在这里说过的私事", true, w.conv);
    const selfOpen = await note(w, "self", "SELF-OPEN-1b 我记下的", false);
    await note(w, "self", "SELF-VAULT-1b 我私下记的", true);
    await note(w, "self", "SELF-ORIGIN-1b 我在这里记的私事", true, w.conv);
    await db.query(
      "insert into agent_hearsay (agent_id, conversation_id, speaker_id, speaker_name, text, said_at) values ($1, $2, $3, 'v', 'HEARSAY-HERE-1b 听来的', now()), ($1, $4, $3, 'v', 'HEARSAY-OWN-1b 别处听来的', now())",
      [w.agent.id, w.conv, w.v.id, w.agent.conversationId],
    );
    const from = gateway.calls.length;
    await say(w.v, w.conv, "你知道主人爱吃什么吗");
    gateway.reply("他爱吃辣。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const calls = gateway.calls.slice(from);
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls);
    expect(calls[0]!.system).toContain("以下是你记下的笔记");
    expect(sent).toContain("OWNER-OPEN-1b");
    expect(sent).toContain("SELF-OPEN-1b");
    for (const never of ["OWNER-VAULT-1b", "OWNER-ORIGIN-1b", "SELF-VAULT-1b", "SELF-ORIGIN-1b", "HEARSAY-HERE-1b", "HEARSAY-OWN-1b"]) expect([never, sent.includes(never)]).toEqual([never, false]);
    // Posted, and what it was shown is on its run: the owner's first, then its own, each at the version it was read at; nothing withheld.
    expect(await postedTexts(w)).toEqual(["他爱吃辣。"]);
    expect(await runOf(w)).toMatchObject({ status: "done", error: null, interrupted: null, shown_notes: [ownerOpen, selfOpen], withheld_notes: null });
  });

  it("its memory off: nothing at all, and nothing recorded", async () => {
    const w = await world({ memory: false });
    await note(w, "owner", "OWNER-OPEN-1b 主人爱吃辣", false);
    await note(w, "self", "SELF-OPEN-1b 我记下的", false);
    const from = gateway.calls.length;
    await say(w.v, w.conv, "你好");
    gateway.reply("你好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const calls = gateway.calls.slice(from);
    expect(JSON.stringify(calls)).not.toContain("-1b");
    expect(calls[0]!.system).not.toContain("以下是你记下的笔记");
    expect(await runOf(w)).toMatchObject({ status: "done", shown_notes: null });
  });

  it("its memory on and the shared notes off: its own open notes only", async () => {
    const w = await world({ sharedNotes: false });
    await note(w, "owner", "OWNER-OPEN-1b 主人爱吃辣", false);
    const selfOpen = await note(w, "self", "SELF-OPEN-1b 我记下的", false);
    await note(w, "self", "SELF-VAULT-1b 我私下记的", true);
    const from = gateway.calls.length;
    await say(w.v, w.conv, "你好");
    gateway.reply("你好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const sent = JSON.stringify(gateway.calls.slice(from));
    expect(sent).toContain("SELF-OPEN-1b");
    expect(sent).not.toContain("OWNER-OPEN-1b");
    expect(sent).not.toContain("SELF-VAULT-1b");
    expect(await runOf(w)).toMatchObject({ status: "done", shown_notes: [selfOpen] });
  });

  it("no post-time note check: a note it was shown is vaulted while the reply is written, and the reply is still posted; the next reply is not shown it", async () => {
    const w = await world();
    const open = await note(w, "owner", "OWNER-OPEN-1b 主人爱吃辣", false);
    await say(w.v, w.conv, "你知道主人爱吃什么吗");
    const hold = gateway.hang();
    const running = app.agentWorker.runOnce();
    expect((await hold.reached).system).toContain("OWNER-OPEN-1b");
    await db.query("update owner_notes set vault = true, vault_by = 'owner', updated_at = clock_timestamp() where id = $1", [open.id]);
    hold.release("他爱吃辣。");
    expect(await running).toBe(true);
    expect(await postedTexts(w)).toEqual(["他爱吃辣。"]);
    expect(await runOf(w)).toMatchObject({ status: "done", error: null, interrupted: null, shown_notes: [open] });
    const from = gateway.calls.length;
    await say(w.v, w.conv, "再说一次");
    gateway.reply("不方便说。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(JSON.stringify(gateway.calls.slice(from))).not.toContain("OWNER-OPEN-1b");
    expect(await runOf(w)).toMatchObject({ status: "done", shown_notes: null });
  });
});

/** The keys no response to anyone but an Agent's owner may carry (agents-co-members.test.ts: the one list). */
const HIDDEN_KEYS: string[] = (() => {
  const text = readFileSync(new URL("./agents-co-members.test.ts", import.meta.url), "utf8");
  const body = /const HIDDEN_KEYS = \[([\s\S]*?)\n\];/.exec(text)?.[1] ?? "";
  return [...body.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]!);
})();
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}
/** A memory counter's total so far (`memory_stats`), once what was counted is written. */
const counted = async (name: string): Promise<number> => {
  await settled();
  return (await db.query<{ n: number }>("select coalesce(sum(n), 0)::int as n from memory_stats where name = $1", [name])).rows[0]!.n;
};

/** A visitor's question answered by a reply that was shown an owner's note and one of the Agent's own; the reply's seq. */
async function answered(w: World): Promise<{ seq: number; owner: Awaited<ReturnType<typeof note>>; self: Awaited<ReturnType<typeof note>> }> {
  const owner = await note(w, "owner", "OWNER-OPEN-1b 主人爱吃辣", false);
  const self = await note(w, "self", "SELF-OPEN-1b 我记下的", false);
  await note(w, "owner", "OWNER-VAULT-1b 主人的存款", true);
  await say(w.v, w.conv, "needle-1b 你知道主人爱吃什么吗");
  gateway.reply("needle-1b 他喜欢吃饭。");
  expect(await app.agentWorker.runOnce()).toBe(true);
  const seq = (await db.query<{ seq: number }>("select seq::int from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq desc limit 1", [w.conv, w.agent.id])).rows[0]!.seq;
  return { seq, owner, self };
}
const replyAs = async (who: Actor, w: World, seq: number) => (await api(app, who, "GET", `/api/conversations/${w.conv}/messages/${seq}`)).json.message;
const vaultFromReply = (who: Actor, w: World, n: { kind: "owner" | "self"; id: string }, from: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  api(app, who, "PATCH", n.kind === "owner" ? `/api/memory/notes/${n.id}` : `/api/agents/${w.agent.id}/memory/notes/${n.id}`, { vault: true, from, ...extra });

describe("T2: what the owner, and only the owner, is shown of what a reply could refer to", () => {
  it("the owner reads `shownNotes` on the reply (text read at the version shown); the visitor never gets the key or a note's text, on any read or frame", async () => {
    const w = await world();
    const ownerSocket = await connect(app, w.owner);
    const visitorSocket = await connect(app, w.v);
    const { seq, owner, self } = await answered(w);
    expect((await replyAs(w.owner, w, seq)).shownNotes).toEqual([
      { kind: "owner", id: owner.id, text: "OWNER-OPEN-1b 主人爱吃辣" },
      { kind: "self", id: self.id, text: "SELF-OPEN-1b 我记下的" },
    ]);
    // The owner's live frame of the reply carries it too.
    const at = await ownerSocket.waitFor((e) => e.type === "message" && e.message?.conversationId === w.conv && e.message?.seq === seq);
    expect(ownerSocket.events[at]!.message.shownNotes).toHaveLength(2);
    const bodies: Array<[string, unknown]> = [];
    const read = async (label: string, method: "GET" | "POST", url: string, body?: unknown) => {
      const res = await api(app, w.v, method, url, body);
      expect([label, res.status]).toEqual([label, 200]);
      bodies.push([label, res.json]);
    };
    await read("sync", "GET", "/api/sync");
    await read("one conversation", "GET", `/api/conversations/${w.conv}`);
    await read("members", "GET", `/api/conversations/${w.conv}/members`);
    await read("history", "GET", `/api/conversations/${w.conv}/messages`);
    await read("history page", "GET", `/api/conversations/${w.conv}/messages?limit=1`);
    await read("the reply", "GET", `/api/conversations/${w.conv}/messages/${seq}`);
    await read("search", "GET", `/api/conversations/${w.conv}/search?q=needle-1b`);
    await read("global search", "GET", `/api/search?q=needle-1b`);
    await read("catch-up", "POST", "/api/sync/catchup", { positions: { [w.conv]: 0 } });
    expect(HIDDEN_KEYS).toContain("shownNotes");
    for (const [label, body] of bodies) expect([label, HIDDEN_KEYS.filter((k) => keysOf(body).has(k))]).toEqual([label, []]);
    // (A socket's frames are not the routes' responses — a run's frame names its Agent — so they are held to the notes alone.)
    bodies.push(["frames", visitorSocket.events]);
    for (const [label, body] of bodies) {
      const text = JSON.stringify(body);
      expect([label, keysOf(body).has("shownNotes"), text.includes("-1b 主人"), text.includes("SELF-OPEN-1b")]).toEqual([label, false, false, false]);
    }
    // Positive controls: the reads did show the reply.
    for (const label of ["history", "search", "catch-up", "frames"]) expect([label, JSON.stringify(bodies.find(([l]) => l === label)![1]).includes("他喜欢吃饭")]).toEqual([label, true]);
  });

  it("a co-observer who is not the sender's owner (the other side's owner of an Agent-to-Agent conversation) is sent none of it", async () => {
    const w = await world();
    const { seq } = await answered(w);
    const other = await signUp(app, `${tag()}c`);
    await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) values ($1, $2, 'observer', 0)", [w.conv, other.id]);
    const theirs = await replyAs(other, w, seq);
    expect(theirs.text).toBe("needle-1b 他喜欢吃饭。");
    expect(theirs).not.toHaveProperty("shownNotes");
    expect(JSON.stringify((await api(app, other, "GET", `/api/conversations/${w.conv}/messages`)).json)).not.toContain("OPEN-1b");
  });

  it("a note edited, deleted or vaulted since is a text-free entry; a note only mentioned again (its version unchanged) keeps its text; a reply shown nothing has no key", async () => {
    const w = await world();
    const { seq, owner, self } = await answered(w);
    await db.query("update owner_notes set strength = strength + 1, seen_at = clock_timestamp() where id = $1", [owner.id]);
    expect((await replyAs(w.owner, w, seq)).shownNotes.map((s: { text: string | null }) => s.text)).toEqual(["OWNER-OPEN-1b 主人爱吃辣", "SELF-OPEN-1b 我记下的"]);
    expect((await api(app, w.owner, "PATCH", `/api/memory/notes/${owner.id}`, { text: "OWNER-OPEN-1b 主人现在不吃辣了" })).status).toBe(200);
    expect((await api(app, w.owner, "DELETE", `/api/agents/${w.agent.id}/memory/notes/${self.id}`)).status).toBe(200);
    expect((await replyAs(w.owner, w, seq)).shownNotes).toEqual([
      { kind: "owner", id: owner.id, text: null },
      { kind: "self", id: self.id, text: null },
    ]);
    // A reply that was shown no note carries no `shownNotes`.
    await db.query("update agents set memory = false where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "还在吗");
    gateway.reply("在。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const last = (await api(app, w.owner, "GET", `/api/conversations/${w.conv}/messages`)).json.messages.at(-1);
    expect(last.text).toBe("在。");
    expect(last).not.toHaveProperty("shownNotes");
  });
});

describe("T2: 以后别说, the button's own request", () => {
  it("vaults the note as the owner's lock, once, counted apart from the memory page's; asked again, or for a note changed since, 409 note_changed and nothing more", async () => {
    const w = await world();
    const { seq, owner, self } = await answered(w);
    const locked = await counted("owner_locked");
    const before = await counted("social_note_vaulted_from_reply");
    const done = await vaultFromReply(w.owner, w, owner, { conversationId: w.conv, seq });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ id: owner.id, vault: true });
    expect((await db.query("select vault, vault_by, unsure from owner_notes where id = $1", [owner.id])).rows[0]).toEqual({ vault: true, vault_by: "owner", unsure: false });
    expect(await counted("social_note_vaulted_from_reply")).toBe(before + 1);
    expect(await counted("owner_locked")).toBe(locked);
    // Read again, the row is the text-free marker (vaulting moved its version on).
    expect((await replyAs(w.owner, w, seq)).shownNotes[0]).toEqual({ kind: "owner", id: owner.id, text: null });
    // Asked again: the note is not as that reply was shown it.
    expect(await vaultFromReply(w.owner, w, owner, { conversationId: w.conv, seq })).toMatchObject({ status: 409, json: { error: "note_changed" } });
    // The Agent's own note, rewritten since (as a dream's rewrite leaves it: outside the vault, a new version): refused, and left as it is.
    await db.query("update agent_notes set text = 'SELF-OPEN-1b 改过了', updated_at = clock_timestamp() where id = $1", [self.id]);
    expect(await vaultFromReply(w.owner, w, self, { conversationId: w.conv, seq })).toMatchObject({ status: 409, json: { error: "note_changed" } });
    expect((await db.query("select vault from agent_notes where id = $1", [self.id])).rows[0]).toEqual({ vault: false });
    expect(await counted("social_note_vaulted_from_reply")).toBe(before + 1);
  });

  it("the Agent's own note through the Agent's route; a note gone since is 409 too", async () => {
    const w = await world();
    const { seq, owner, self } = await answered(w);
    expect((await vaultFromReply(w.owner, w, self, { conversationId: w.conv, seq })).status).toBe(200);
    expect((await db.query("select vault, vault_by from agent_notes where id = $1", [self.id])).rows[0]).toEqual({ vault: true, vault_by: "owner" });
    expect((await api(app, w.owner, "DELETE", `/api/memory/notes/${owner.id}`)).status).toBe(200);
    expect(await vaultFromReply(w.owner, w, owner, { conversationId: w.conv, seq })).toMatchObject({ status: 409, json: { error: "note_changed" } });
  });

  it("bound to the message: one whose reply was not shown this note, one that is not a social reply, someone else's — 404, nothing changed; only `vault: true` and nothing else goes with `from`", async () => {
    const w = await world();
    const { seq, owner, self } = await answered(w);
    const other = await note(w, "owner", "OWNER-OTHER-1b 别的一条", false);
    const visitorSeq = seq - 1;
    for (const [label, who, n, from] of [
      ["a note that reply was not shown", w.owner, other, { conversationId: w.conv, seq }],
      ["the visitor's message", w.owner, owner, { conversationId: w.conv, seq: visitorSeq }],
      ["a message that is not there", w.owner, owner, { conversationId: w.conv, seq: seq + 50 }],
      ["the owner's own conversation", w.owner, owner, { conversationId: w.agent.conversationId, seq: 1 }],
      ["the visitor asking for the owner's note", w.v, owner, { conversationId: w.conv, seq }],
    ] as const) {
      expect([label, (await vaultFromReply(who, w, n, from)).status]).toEqual([label, 404]);
    }
    for (const [label, body] of [
      ["vault false", { vault: false, from: { conversationId: w.conv, seq } }],
      ["a text with it", { vault: true, text: "x", from: { conversationId: w.conv, seq } }],
      ["a malformed from", { vault: true, from: { conversationId: "nope", seq } }],
    ] as const) {
      expect([label, (await api(app, w.owner, "PATCH", `/api/memory/notes/${owner.id}`, body)).status]).toEqual([label, 400]);
    }
    expect((await db.query("select count(*)::int as n from owner_notes where owner_id = $1 and vault", [w.owner.id])).rows[0]!.n).toBe(1);
    expect((await db.query("select vault from agent_notes where id = $1", [self.id])).rows[0]).toEqual({ vault: false });
  });
});

describe("T2: the counters (no id, no text)", () => {
  it("a posted social reply that was shown notes counts once, and the notes it was shown; one shown none counts nothing", async () => {
    const [replies, shown] = [await counted("social_replies_with_notes"), await counted("social_notes_shown")];
    const w = await world();
    await answered(w);
    expect([await counted("social_replies_with_notes"), await counted("social_notes_shown")]).toEqual([replies + 1, shown + 2]);
    const bare = await world({ memory: false });
    await say(bare.v, bare.conv, "你好");
    gateway.reply("你好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect([await counted("social_replies_with_notes"), await counted("social_notes_shown")]).toEqual([replies + 1, shown + 2]);
    const rows = await db.query<{ name: string }>("select name from memory_stats where name like 'social_%'");
    for (const r of rows.rows) expect(r.name).toMatch(/^social_[a-z_]+$/);
  });
});

describe("T1: what is said in a social conversation stays there (the isolation canaries of the ring 1 plan, Test 5)", () => {
  it("the owner's next own reply and the review of their own conversation hold nothing of it; no whisper, summary, flag, change, note or hearsay does", async () => {
    const w = await world();
    await note(w, "owner", "OWNER-OPEN-1b 主人爱吃辣", false);
    await say(w.v, w.conv, "SOCIAL-CANARY-1b 你知道主人爱吃什么吗");
    gateway.reply("SOCIAL-REPLY-CANARY-1b 他爱吃辣。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    await app.deps.memory!.idle();
    // The owner's own conversation: a reply, then a new topic, which reviews what was said there at once.
    const from = gateway.calls.length;
    await say(w.owner, w.agent.conversationId, "OWN-LINE-1b 今天天气不错");
    gateway.reply("是的。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    gateway.reply(JSON.stringify({ ops: [] }));
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.agent.conversationId}/topic`)).status).toBe(201);
    await app.deps.memory!.idle();
    const calls = gateway.calls.slice(from);
    expect(calls.length).toBe(2);
    expect(calls.some((c) => c.system.includes("记忆整理员"))).toBe(true);
    // (Positive control: the owner's own words reached both.)
    expect(calls.every((c) => JSON.stringify(c).includes("OWN-LINE-1b"))).toBe(true);
    expect(JSON.stringify(calls)).not.toContain("CANARY-1b");
    for (const table of ["whispers", "conversation_summaries", "memory_flags", "memory_changes", "memory_catchups", "agent_hearsay", "owner_notes", "agent_notes"]) {
      const found = await db.query(`select 1 from ${table} x where x::text like '%CANARY-1b%' limit 1`);
      expect([table, found.rowCount]).toEqual([table, 0]);
    }
  });
});
