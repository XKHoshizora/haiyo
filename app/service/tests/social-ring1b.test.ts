import { afterEach, describe, expect, it } from "vitest";
import { exactTs } from "../src/memory/write.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

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
