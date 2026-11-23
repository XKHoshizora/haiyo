import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoadedNotes, NotesPlace } from "../src/memory/passage.ts";
import { othersRoomAdvisory } from "../src/metering/others.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { FREE_MODEL, OTHERS_ENV, PAID_MODEL, POINT, setOwnerNumbers } from "./helpers/others.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B7c: the notes a social run is shown, and the advisory room. Ring 1a shows a visitor NO owner notes at all (a canary in the
 * owner's notes, open and vault, never appears in any request built for a social run, nor in what is posted); `loadNotes`'s social
 * answer is wired through `fitNotes`, and the refs of the notes it kept are written to the run with the admission (`shown_notes`,
 * `withheld_notes`; null when empty); an others' reply is offered tools only when the advisory room covers the hold with them.
 */
const loadNotesOverride = vi.hoisted(() => ({ current: null as null | ((where: NotesPlace) => LoadedNotes | null) }));
vi.mock("../src/memory/passage.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/memory/passage.ts")>();
  const wrapped = (async (q: never, agent: never, where: NotesPlace, config: never) => loadNotesOverride.current?.(where) ?? real.loadNotes(q, agent, where as never, config)) as typeof real.loadNotes;
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

describe("ring 1a shows a visitor no owner notes at all", () => {
  it("a canary in the owner's notes (open and vault, the owner's and the Agent's own, hearsay) is in no request built for a social run, nor in what is posted", async () => {
    const w = await world("canary");
    await db.query("insert into owner_notes (owner_id, text, vault) values ($1, $2, false), ($1, $3, true)", [w.owner.id, "OWNER-OPEN-CANARY 主人爱吃辣", "OWNER-VAULT-CANARY 主人的存款"]);
    await db.query("insert into agent_notes (agent_id, text, vault) values ($1, $2, false), ($1, $3, true)", [w.agent.id, "SELF-OPEN-CANARY 我记下的", "SELF-VAULT-CANARY 我私下记的"]);
    await db.query("update agents set memory = true, shared_notes = true where principal_id = $1", [w.agent.id]);
    await say(w.v, w.conv, "你知道主人爱吃什么吗");
    gateway.reply("不方便说。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const calls = gateway.calls.slice(-1);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain("CANARY");
    expect(calls[0]!.system).not.toContain("以下是你记下的笔记");
    const posted = await db.query<{ body: unknown }>("select body from messages where conversation_id = $1 and sender_id = $2", [w.conv, w.agent.id]);
    expect(JSON.stringify(posted.rows)).not.toContain("CANARY");
    const run = await runOf(w);
    expect(run).toMatchObject({ status: "done", shown_notes: null, withheld_notes: null });
  });
});

describe("loadNotes wired into the social run", () => {
  it("a fake answer with two shown notes and one withheld: the kept notes' refs are the run's shown_notes, written with the admission and not before", async () => {
    const at = new Date("2026-03-01T04:00:00Z");
    const refs = [
      { kind: "owner" as const, id: "11111111-1111-4111-8111-111111111111", version: "v1" },
      { kind: "self" as const, id: "22222222-2222-4222-8222-222222222222", version: "v2" },
    ];
    const withheld = { kind: "owner" as const, id: "33333333-3333-4333-8333-333333333333", version: "v3" };
    loadNotesOverride.current = (where) =>
      where.place === "social"
        ? {
            notes: { owner: [{ text: "SHOWN-OWNER 可以说的一条", updatedAt: at, ref: refs[0]! }], self: [{ text: "SHOWN-SELF 另一条", updatedAt: at, ref: refs[1]! }], hearsay: [] },
            shown: refs,
            withheld: [withheld],
          }
        : null;
    // A reply its owner's number cannot hold (the paid tier's one call is 17 points; the number is one) is refused at admission: nothing is written.
    const refused = await world("fake_refused", PAID_MODEL);
    await setOwnerNumbers(db, refused.owner.id, { pointsMicro: 1n * POINT });
    await say(refused.v, refused.conv, "你好");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await runOf(refused)).status).not.toBe("done");
    expect(await runOf(refused)).toMatchObject({ shown_notes: null, withheld_notes: null });
    // Admitted, they are written with the admission.
    const w = await world("fake");
    await say(w.v, w.conv, "你好呀");
    gateway.reply("好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    // (Step 0's `shownNotesPass` answers true only for no note shown: a shown note with no verdict stops the post, `notes_changed`, which is
    // what the post-time check is for. Lane A's real one answers by the verdicts.)
    expect(await runOf(w)).toMatchObject({ status: "cancelled", error: "notes_changed", shown_notes: refs, withheld_notes: [withheld] });
    // The kept notes are in the request as the social passage shows them.
    expect(gateway.calls.at(-1)!.system).toContain("SHOWN-OWNER");
    expect(gateway.calls.at(-1)!.system).toContain("现在是在你和对方的对话里");
  });
});

describe("the advisory room", () => {
  it("is the least room left under the numbers (the owner's, and the Agent's own where lower), holds counted", async () => {
    const w = await world("room");
    await setOwnerNumbers(db, w.owner.id, { pointsMicro: 10n * POINT });
    expect(await othersRoomAdvisory(db, app.deps.config, w.owner.id, w.agent.id, "others", new Date())).toBe(10n * POINT);
    await db.query("update agents set others_budget_micro = $2 where principal_id = $1", [w.agent.id, (4n * POINT).toString()]);
    expect(await othersRoomAdvisory(db, app.deps.config, w.owner.id, w.agent.id, "others", new Date())).toBe(4n * POINT);
    await setOwnerNumbers(db, w.owner.id, { pointsMicro: 1n * POINT });
    expect(await othersRoomAdvisory(db, app.deps.config, w.owner.id, w.agent.id, "others", new Date())).toBe(1n * POINT);
  });

  it("an others' reply whose room covers the with-tools hold is offered tools; with room for one call only it is offered none and makes one call", async () => {
    const roomy = await world("roomy");
    await setOwnerNumbers(db, roomy.owner.id, { pointsMicro: 70n * POINT });
    await say(roomy.v, roomy.conv, "你好");
    gateway.reply("好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect(gateway.calls.at(-1)!.tools?.length ?? 0).toBeGreaterThan(0);
    // One point: more than a plain call's hold (a few tenths) and less than the hold with tools (about three).
    const tight = await world("tight");
    await setOwnerNumbers(db, tight.owner.id, { pointsMicro: 1n * POINT });
    await say(tight.v, tight.conv, "你好");
    gateway.reply("好。");
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect(call.tools ?? []).toEqual([]);
    expect(call.system).toContain("你没有任何工具");
    expect(await runOf(tight)).toMatchObject({ status: "done" });
  });
});
