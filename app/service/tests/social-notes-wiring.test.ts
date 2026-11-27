import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotesPlace } from "../src/memory/passage.ts";
import type { PromptNotes } from "../src/agents/runtime/prompt.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { FREE_MODEL, OTHERS_ENV, PAID_MODEL, POINT, setOwnerLimit } from "./helpers/others.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B7c: the notes a social run is shown, and the advisory room. Ring 1b shows a visitor's reply the notes outside the vault (a
 * canary in the vault, or in hearsay, never appears in any request built for a social run; nothing of the notes is in what is posted
 * by a reply that does not say it); `loadNotes`'s social answer is wired through `fitNotes`, and the refs of the notes it kept are
 * written to the run with the admission (`shown_notes`; null when empty); an others' reply is offered tools as the owner's own is.
 */
const loadNotesOverride = vi.hoisted(() => ({ current: null as null | ((where: NotesPlace) => PromptNotes | null) }));
vi.mock("../src/memory/passage.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/memory/passage.ts")>();
  const wrapped = (async (q: never, agent: never, where: NotesPlace) => loadNotesOverride.current?.(where) ?? real.loadNotes(q, agent, where)) as typeof real.loadNotes;
  return { ...real, loadNotes: wrapped };
});

const gateway = scriptedGateway();
const { app, db } = useApp({ env: OTHERS_ENV, models: gateway, agentWorker: false, tools: true, config: SOCIAL_ON });
afterEach(async () => {
  loadNotesOverride.current = null;
  vi.restoreAllMocks();
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `snw${++txn}` });
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};
async function world(tag: string, model: typeof FREE_MODEL | typeof PAID_MODEL = FREE_MODEL) {
  const [owner, v] = [await signUp(app, `nw_o_${tag}`), await signUp(app, `nw_v_${tag}`)];
  const agent = (await mustCreateAgent(app, owner, { handle: `nw_bot_${tag}`, name: "nw", model, persona: "简短地回答。" })) as { id: string; conversationId: string };
  const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
  return { owner, v, agent, conv: seeded.conversationId };
}
type World = Awaited<ReturnType<typeof world>>;
const runOf = async (w: World) =>
  (await db.query<{ id: string; status: string; error: string | null; shown_notes: unknown; withheld_notes: unknown }>(
    "select id, status, error, shown_notes, withheld_notes from agent_runs where agent_id = $1 and conversation_id = $2 and purpose = 'reply' order by created_at desc, id desc limit 1",
    [w.agent.id, w.conv],
  )).rows[0]!;

describe("ring 1b shows a visitor's reply the notes outside the vault, and nothing else", () => {
  it("the open notes (the owner's and the Agent's own) are in the request, the vault and hearsay never; nothing of them is in what is posted; the run records the open ones", async () => {
    const w = await world("canary");
    await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false), ($1, $3, true)", [w.owner.id, "OWNER-OPEN-CANARY 主人爱吃辣", "OWNER-VAULT-CANARY 主人的存款"]);
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false), ($1, $3, true)", [w.agent.id, "SELF-OPEN-CANARY 我记下的", "SELF-VAULT-CANARY 我私下记的"]);
    await db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_id, speaker_name, text, said_at) values ($1, $2, $3, $4, $5, now())", [w.agent.id, w.conv, w.v.id, "nw", "HEARSAY-CANARY 听来的话"]);
    await db.query("update agents set memory = true, shared_notes = true where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "你知道主人爱吃什么吗");
    gateway.reply("不方便说。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const calls = gateway.calls.slice(-1);
    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls);
    expect(sent).toContain("OWNER-OPEN-CANARY");
    expect(sent).toContain("SELF-OPEN-CANARY");
    for (const never of ["OWNER-VAULT-CANARY", "SELF-VAULT-CANARY", "HEARSAY-CANARY"]) expect([never, sent.includes(never)]).toEqual([never, false]);
    const posted = await db.query<{ body: unknown }>("select body from messages where conversation_id = $1 and sender_id = $2", [w.conv, w.agent.id]);
    expect(JSON.stringify(posted.rows)).not.toContain("CANARY");
    const run = await runOf(w);
    expect(run).toMatchObject({ status: "done", withheld_notes: null });
    expect((run.shown_notes as Array<{ kind: string }>).map((r) => r.kind)).toEqual(["owner", "self"]);
  });
});

describe("a social run with a tool round", () => {
  it("m4: no request of a social run that calls a tool (the steps and the finishing request) holds a vault note or hearsay, and nothing of the notes is posted", async () => {
    const w = await world("canarytool");
    await setOwnerLimit(db, w.owner.id, 70n * POINT);
    await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false), ($1, $3, true)", [w.owner.id, "OWNER-OPEN-CANARY 主人爱吃辣", "OWNER-VAULT-CANARY 主人的存款"]);
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false), ($1, $3, true)", [w.agent.id, "SELF-OPEN-CANARY 我记下的", "SELF-VAULT-CANARY 我私下记的"]);
    await db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_id, speaker_name, text, said_at) values ($1, $2, $3, $4, $5, now())", [w.agent.id, w.conv, w.v.id, "nw", "HEARSAY-CANARY 听来的话"]);
    await db.query("update agents set memory = true, shared_notes = true where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "帮我找找之前说过什么");
    const before = gateway.calls.length;
    gateway.callTools([{ name: "search_messages", input: { query: "主人" } }], { text: "我查一下。" }).reply("没有。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const mine = gateway.calls.slice(before);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    for (const never of ["OWNER-VAULT-CANARY", "SELF-VAULT-CANARY", "HEARSAY-CANARY"]) expect([never, JSON.stringify(mine).includes(never)]).toEqual([never, false]);
    const posted = await db.query<{ body: unknown }>("select body from messages where conversation_id = $1 and sender_id = $2 and kind = 'text'", [w.conv, w.agent.id]);
    expect(posted.rows).toHaveLength(1);
    expect(JSON.stringify(posted.rows)).not.toContain("CANARY");
  });
});

describe("loadNotes wired into the social run", () => {
  it("a fake answer with two notes: the kept notes' refs are the run's shown_notes, written with the admission and not before; withheld_notes is never written", async () => {
    const at = new Date("2026-03-01T04:00:00Z");
    const refs = [
      { kind: "owner" as const, id: "11111111-1111-4111-8111-111111111111", version: "v1" },
      { kind: "self" as const, id: "22222222-2222-4222-8222-222222222222", version: "v2" },
    ];
    loadNotesOverride.current = (where) =>
      where.place === "social"
        ? { owner: [{ text: "SHOWN-OWNER 可以说的一条", updatedAt: at, ref: refs[0]! }], self: [{ text: "SHOWN-SELF 另一条", updatedAt: at, ref: refs[1]! }], hearsay: [] }
        : null;
    // A reply whose owner's number is reached by the time it is admitted (others' use today at it, one point) is refused there: nothing is written.
    const refused = await world("fake_refused", PAID_MODEL);
    await setOwnerLimit(db, refused.owner.id, 1n * POINT);
    await say(refused.v, refused.conv, "你好");
    await paidReply(db, { agentId: refused.agent.id, ownerId: refused.owner.id, conversationId: refused.agent.conversationId, lane: "others", micro: POINT });
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runOf(refused)).status).not.toBe("done");
    expect(await runOf(refused)).toMatchObject({ shown_notes: null, withheld_notes: null });
    // Admitted, they are written with the admission.
    const w = await world("fake");
    await say(w.v, w.conv, "你好呀");
    gateway.reply("好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    // (Ring 1b: there is no post-time note check, so the reply is posted whatever it was shown.)
    expect(await runOf(w)).toMatchObject({ status: "done", error: null, shown_notes: refs, withheld_notes: null });
    // The kept notes are in the request as the social passage shows them.
    expect(gateway.calls.at(-1)!.system).toContain("SHOWN-OWNER");
    expect(gateway.calls.at(-1)!.system).toContain("现在是在你和对方的对话里");
  });
});

describe("the tools of a social reply", () => {
  it("are offered as the owner's own reply's are, whatever the owner's one number leaves: nothing is reserved against it", async () => {
    for (const points of [70n, 1n]) {
      const w = await world(`tools${points}`);
      await setOwnerLimit(db, w.owner.id, points * POINT);
      await say(w.v, w.conv, "你好");
      gateway.reply("好。");
      expect(await app.agentWorker.runOnce()).toBe(true);
      expect([points, (gateway.calls.at(-1)!.tools?.length ?? 0) > 0]).toEqual([points, true]);
      expect(await runOf(w)).toMatchObject({ status: "done" });
    }
  });
});
