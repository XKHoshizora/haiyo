import { afterEach, describe, expect, it } from "vitest";
import { followUp, RUN_COLUMNS, toWireRun, type RunRow, type RunStatus } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * Lane B, B5a: `placeOf` at every run site and in the hub. A social conversation (`agent_social`) is a place of its own: the run of an
 * Agent there is told to its owner as a run and to every other current member (the visitor) as a state, never as the run; the visitor
 * reads `GET …/runs`; the owner stops and dismisses by the group path (as an observer, a current member); retry is 404; a follow-up keeps
 * its caller (the visitor) in lane `others`.
 */
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, config: SOCIAL_ON });
afterEach(async () => {
  await closeAllSockets();
});

const FAST = { source: "site", id: "fast" } as const;
const ERROR_TEXT = "provider_unavailable";

async function world() {
  const [owner, v, stranger] = [await signUp(app, "spowner"), await signUp(app, "spvisitor"), await signUp(app, "spstranger")];
  const agent = (await mustCreateAgent(app, owner, { handle: "spbot", name: "spbot", model: FAST, persona: "简短地回答。" })) as { id: string; handle: string; conversationId: string };
  const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
  return { owner, v, stranger, agent, conv: seeded.conversationId };
}

interface Seed {
  status: RunStatus;
  error?: string;
  pending?: number;
  caller?: string | null;
  lane?: "own" | "others";
  dismissed?: boolean;
}
async function seedRun(w: Awaited<ReturnType<typeof world>>, s: Seed): Promise<RunRow> {
  const seq = Number((await db.query<{ seq: string }>("select seq from conversations where id = $1", [w.conv])).rows[0]!.seq);
  const { rows } = await db.query<RunRow>(
    `insert into agent_runs as r (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, pending_seq, dismissed_at, triggered_by, caller_id, lane, started_at, finished_at, call_seqs)
     values ('reply', $1, $2, $3, $4, $5, $6, $7, case when $8 then now() end, 'human', $9, $10, case when $4 <> 'queued' then now() end,
             case when $4 not in ('queued', 'running') then now() end, array[$6::bigint])
     returning ${RUN_COLUMNS}`,
    [w.conv, w.agent.id, w.owner.id, s.status, s.error ?? null, seq, s.pending ?? null, s.dismissed === true, s.caller === undefined ? w.v.id : s.caller, s.lane ?? "others"],
  );
  return rows[0]!;
}
const announce = (w: Awaited<ReturnType<typeof world>>, row: RunRow) => app.agentPort.announce({ ownerId: w.owner.id, conversationId: w.conv, run: toWireRun(row) });
const runPushes = (events: Push[], conv: string) => events.filter((e) => e.type === "run" && e.conversationId === conv);
const rowOf = async (id: string) => (await db.query<RunRow>(`select ${RUN_COLUMNS} from agent_runs r where r.id = $1`, [id])).rows[0]!;

/** Every key of a value, at any depth. */
function keysDeep(v: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(v)) for (const x of v) keysDeep(x, out);
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) (out.add(k), keysDeep(x, out));
  return out;
}

describe("the hub: a social run is told like a group's", () => {
  it("the owner's socket gets the run, the visitor's a state with no run, no id and no error at any depth; a stranger nothing", async () => {
    const w = await world();
    const [owner, visitor, stranger] = [await connect(app, w.owner), await connect(app, w.v), await connect(app, w.stranger)];
    const failed = await seedRun(w, { status: "failed", error: ERROR_TEXT });
    announce(w, failed);
    await owner.waitFor((e) => e.type === "run" && e.conversationId === w.conv);
    await visitor.waitFor((e) => e.type === "run" && e.conversationId === w.conv);
    const mine = runPushes(owner.events, w.conv);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ type: "run", conversationId: w.conv, agentId: w.agent.id, run: { id: failed.id, status: "failed" } });
    const theirs = runPushes(visitor.events, w.conv);
    expect(theirs).toEqual([{ type: "run", conversationId: w.conv, agentId: w.agent.id, state: "unavailable" }]);
    expect(JSON.stringify(theirs)).not.toContain(failed.id);
    expect(JSON.stringify(theirs)).not.toContain(ERROR_TEXT);
    const keys = keysDeep(theirs);
    for (const hidden of ["run", "id", "error", "retryable", "resetsAt"]) expect(keys.has(hidden)).toBe(false);
    expect(runPushes(stranger.events, w.conv)).toEqual([]);
  });

  it("a queued run: the visitor is told replying", async () => {
    const w = await world();
    const visitor = await connect(app, w.v);
    announce(w, await seedRun(w, { status: "queued" }));
    expect((await visitor.next((e) => e.type === "run" && e.conversationId === w.conv)).state).toBe("replying");
  });
});

describe("GET …/runs answers the visitor; retry is 404; the owner stops and dismisses", () => {
  it("the visitor reads the state, the owner the run, a stranger and a bystander 404", async () => {
    const w = await world();
    const run = await seedRun(w, { status: "running" });
    const asVisitor = await api(app, w.v, "GET", `/api/conversations/${w.conv}/runs`);
    expect(asVisitor.status).toBe(200);
    expect(asVisitor.json).toEqual({ runs: [{ agentId: w.agent.id, state: "replying" }] });
    const asOwner = await api(app, w.owner, "GET", `/api/conversations/${w.conv}/runs`);
    expect(asOwner.json.runs).toHaveLength(1);
    expect(asOwner.json.runs[0]).toMatchObject({ agentId: w.agent.id, state: "replying", run: { id: run.id } });
    expect((await api(app, w.stranger, "GET", `/api/conversations/${w.conv}/runs`)).status).toBe(404);
  });

  it("retry is 404, whoever asks and whatever the latest run is", async () => {
    const w = await world();
    await seedRun(w, { status: "failed", error: ERROR_TEXT });
    for (const who of [w.owner, w.v, w.stranger]) {
      expect((await api(app, who, "POST", `/api/conversations/${w.conv}/runs/retry`, { agentId: w.agent.id })).status).toBe(404);
    }
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.conv}/runs/retry`)).status).toBe(404);
  });

  it("the owner stops a queued run; the visitor cannot; a running one is flagged", async () => {
    const w = await world();
    const queued = await seedRun(w, { status: "queued" });
    expect((await api(app, w.v, "POST", `/api/conversations/${w.conv}/runs/${queued.id}/stop`)).status).toBe(404);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.conv}/runs/${queued.id}/stop`)).status).toBe(200);
    expect((await rowOf(queued.id)).status).toBe("stopped");
    const running = await seedRun(w, { status: "running" });
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.conv}/runs/${running.id}/stop`)).status).toBe(200);
    expect((await db.query<{ stop_asked: boolean }>("select stop_asked from agent_runs where id = $1", [running.id])).rows[0]!.stop_asked).toBe(true);
  });

  it("the owner dismisses a failed run by naming the Agent; the visitor's line goes; the visitor cannot dismiss", async () => {
    const w = await world();
    const failed = await seedRun(w, { status: "failed", error: ERROR_TEXT });
    expect((await api(app, w.v, "GET", `/api/conversations/${w.conv}/runs`)).json.runs).toEqual([{ agentId: w.agent.id, state: "unavailable" }]);
    expect((await api(app, w.v, "POST", `/api/conversations/${w.conv}/runs/dismiss`, { agentId: w.agent.id })).status).toBe(404);
    expect((await api(app, w.owner, "POST", `/api/conversations/${w.conv}/runs/dismiss`, { agentId: w.agent.id })).status).toBe(200);
    expect((await rowOf(failed.id)).dismissed_at).not.toBeNull();
    expect((await api(app, w.v, "GET", `/api/conversations/${w.conv}/runs`)).json.runs).toEqual([]);
  });
});

describe("a follow-up keeps its caller", () => {
  it("a message the visitor noted during the run is queued with caller V and lane others", async () => {
    const w = await world();
    const sent = await api(app, w.v, "POST", `/api/conversations/${w.conv}/messages`, { text: "再问一句", clientTxn: "spf1" });
    expect(sent.status).toBe(201);
    const seq = sent.json.message.seq as number;
    // The send queued a run of its own (B6); what the test needs is the state after that run was folded into: none active.
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where status = 'queued'");
    // The ended run covered the opening notice (seq 1), noted the visitor's message (`pending_seq`), and recorded no call of it.
    const ended = await seedRun(w, { status: "done" as RunStatus, pending: seq, caller: w.v.id });
    await db.query("update agent_runs set covers_seq = 1, call_seqs = '{}' where id = $1", [ended.id]);
    const followed = await db.tx(async (t) => {
      const agent = await lockAgent(t, w.agent.id, w.conv);
      return followUp(t, agent, w.conv, 1, seq, [], app.deps.config);
    });
    expect(followed.run).not.toBeNull();
    const queued = await rowOf(followed.run!.run.id);
    expect(queued).toMatchObject({ status: "queued" });
    const { rows } = await db.query<{ caller_id: string; lane: string; triggered_by: string; asker_ids: string[] }>(
      "select caller_id, lane, triggered_by, asker_ids from agent_runs where id = $1",
      [queued.id],
    );
    expect(rows[0]).toMatchObject({ caller_id: w.v.id, lane: "others", triggered_by: "human" });
    expect(rows[0]!.asker_ids).toEqual([w.v.id]);
  });

  it("nothing is queued when the visitor no longer has access", async () => {
    const w = await world();
    const sent = await api(app, w.v, "POST", `/api/conversations/${w.conv}/messages`, { text: "再问一句", clientTxn: "spf2" });
    const seq = sent.json.message.seq as number;
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where status = 'queued'");
    const ended = await seedRun(w, { status: "done" as RunStatus, pending: seq, caller: w.v.id });
    await db.query("update agent_runs set covers_seq = 1 where id = $1", [ended.id]);
    await db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = 'removed' where agent_id = $1 and subject_id = $2`, [w.agent.id, w.v.id]);
    const followed = await db.tx(async (t) => followUp(t, await lockAgent(t, w.agent.id, w.conv), w.conv, 1, seq, [], app.deps.config));
    expect(followed.run).toBeNull();
  });
});
