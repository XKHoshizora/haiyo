import { describe, expect, it } from "vitest";
import { siteToday } from "../src/agents/runs.ts";
import { buildApp } from "../src/app.ts";
import { api, signUp } from "./helpers/actors.ts";
import { createAgent, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { paidReply } from "./helpers/metering.ts";

/**
 * The owner's settings for proactive replies (README "Agents"): `proactive`, `proactiveLevel`, `proactiveBudget`, and
 * `othersUsedToday` in the owner's view. Turning it on needs the judgement model (`JUDGE`); nothing else does.
 */

const { app, db } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1000" }, agentWorker: false });

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 4000,
  dailyLimit: 20000,
};

/** An app on the same database whose configuration names the judgement model. */
const withJudge = () =>
  buildApp({ config: { ...app.deps.config, judge: JUDGE }, db }, { agentWorker: false, answerFloor: NO_ANSWER_FLOOR, staleRunSweep: false });

const KEYS = ["proactive", "proactiveLevel", "proactiveBudget"];

describe("proactive settings", () => {
  it("a new Agent has them off, at level normal, with 70 points a day (074)", async () => {
    const owner = await signUp(app, "pro_defaults");
    const agent = await mustCreateAgent(app, owner);
    expect(agent).toMatchObject({ proactive: false, proactiveLevel: "normal", proactiveBudget: "70" });
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json).toMatchObject({ proactive: false, proactiveLevel: "normal", proactiveBudget: "70" });
    const list = (await api(app, owner, "GET", "/api/agents")).json as { agents: Record<string, unknown>[] };
    expect(list.agents[0]).toMatchObject({ proactive: false, proactiveLevel: "normal", proactiveBudget: "70" });
  });

  it("validates each field on create and PATCH; there is no unlimited budget", async () => {
    const owner = await signUp(app, "pro_validate");
    const agent = await mustCreateAgent(app, owner);
    const bad: Record<string, unknown>[] = [
      { proactiveLevel: "most" },
      { proactiveLevel: null },
      { proactive: "yes" },
      { proactive: null },
      { proactiveBudget: "0" },
      { proactiveBudget: "0.5" },
      { proactiveBudget: "100001" },
      { proactiveBudget: "abc" },
      { proactiveBudget: null },
      { proactiveBudget: 20 },
    ];
    for (const body of bad) {
      expect([body, (await api(app, owner, "PATCH", `/api/agents/${agent.id}`, body)).status]).toEqual([body, 400]);
      expect([body, (await createAgent(app, owner, body)).status]).toEqual([body, 400]);
    }
    const ok = await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { proactiveLevel: "more", proactiveBudget: "1" });
    expect(ok).toMatchObject({ status: 200, json: { proactiveLevel: "more", proactiveBudget: "1" } });
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { proactiveLevel: "less", proactiveBudget: "100000" })).json).toMatchObject({
      proactiveLevel: "less",
      proactiveBudget: "100000",
    });
    expect((await createAgent(app, owner, { proactiveLevel: "more", proactiveBudget: "12.5" })).json).toMatchObject({ proactiveLevel: "more", proactiveBudget: "12.5" });
  });

  it("proactive: true without the judgement model is 409 proactive_unavailable, on create and PATCH, and changes nothing", async () => {
    expect(app.deps.config.judge).toBeNull();
    const owner = await signUp(app, "pro_unconf");
    const agent = await mustCreateAgent(app, owner);
    expect(await createAgent(app, owner, { proactive: true })).toMatchObject({ status: 409, json: { error: "proactive_unavailable" } });
    expect(((await api(app, owner, "GET", "/api/agents")).json as { agents: unknown[] }).agents).toHaveLength(1);
    const res = await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { name: "Renamed", proactive: true, proactiveLevel: "more" });
    expect(res).toMatchObject({ status: 409, json: { error: "proactive_unavailable" } });
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json).toMatchObject({ name: agent.name, proactive: false, proactiveLevel: "normal" });
  });

  it("without the judgement model, turning it on for someone else's Agent is the 404 of any Agent not yours, and for a deleted one agent_deleted", async () => {
    expect(app.deps.config.judge).toBeNull();
    const owner = await signUp(app, "pro_order");
    const stranger = await signUp(app, "pro_stranger");
    const agent = await mustCreateAgent(app, owner);
    expect(await api(app, stranger, "PATCH", `/api/agents/${agent.id}`, { proactive: true })).toMatchObject({ status: 404, json: { error: "not_found" } });
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect(await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { proactive: true })).toMatchObject({ status: 409, json: { error: "agent_deleted" } });
  });

  it("proactive: false is always accepted; level and budget may be set at any time", async () => {
    const owner = await signUp(app, "pro_off");
    const made = await createAgent(app, owner, { proactive: false, proactiveLevel: "less" });
    expect(made).toMatchObject({ status: 201, json: { proactive: false, proactiveLevel: "less" } });
    const id = (made.json as { id: string }).id;
    expect(await api(app, owner, "PATCH", `/api/agents/${id}`, { proactive: false, proactiveBudget: "5" })).toMatchObject({
      status: 200,
      json: { proactive: false, proactiveBudget: "5" },
    });
  });

  it("with the judgement model configured, proactive: true is stored, on create and PATCH, and can be turned off", async () => {
    const on = await withJudge();
    try {
      const owner = await signUp(on, "pro_conf");
      const made = await createAgent(on, owner, { proactive: true });
      expect(made).toMatchObject({ status: 201, json: { proactive: true } });
      const id = (made.json as { id: string }).id;
      expect((await db.query("select proactive from agents where principal_id = $1", [id])).rows).toEqual([{ proactive: true }]);
      const other = await mustCreateAgent(on, owner);
      expect(await api(on, owner, "PATCH", `/api/agents/${other.id}`, { proactive: true })).toMatchObject({ status: 200, json: { proactive: true } });
      expect(await api(on, owner, "PATCH", `/api/agents/${other.id}`, { proactive: false })).toMatchObject({ status: 200, json: { proactive: false } });
    } finally {
      await on.close();
    }
  });

  it("an Agent that is proactive stays so when the configuration goes away, and its other edits still work", async () => {
    const owner = await signUp(app, "pro_gone");
    const agent = await mustCreateAgent(app, owner);
    await db.query("update agents set proactive = true where principal_id = $1", [agent.id]);
    const res = await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { name: "Still here" });
    expect(res).toMatchObject({ status: 200, json: { name: "Still here", proactive: true } });
    expect(await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { proactive: true })).toMatchObject({ status: 409 });
    expect(await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { proactive: false })).toMatchObject({ status: 200, json: { proactive: false } });
  });

  it("the owner's view has the three keys", async () => {
    const owner = await signUp(app, "pro_view");
    const agent = await mustCreateAgent(app, owner);
    expect(Object.keys((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json as object)).toEqual(expect.arrayContaining(KEYS));
  });

  it("othersUsedToday.points counts the settled charges of lane others since the site day began, and what its running replies hold (its own points number scopes that lane): a proactive reply's, the owner's own and yesterday's are not in it", async () => {
    const owner = await signUp(app, "pro_spent");
    const agent = await mustCreateAgent(app, owner);
    const yesterday = new Date(siteToday(app.deps.config).getTime() - 3_600_000);
    const paid = (lane: "own" | "others" | "proactive", micro: number, at: Date | null) =>
      paidReply(db, { agentId: agent.id, ownerId: owner.id, conversationId: agent.conversationId, lane, micro, at });
    await paid("proactive", 3_000_000, null);
    await paid("proactive", 500_000, null);
    await paid("others", 7_000_000, null);
    await paid("own", 11_000_000, null);
    await paid("proactive", 40_000_000, yesterday);
    const view = (await api(app, owner, "GET", `/api/agents/${agent.id}`)).json as { othersUsedToday: { points: string } };
    expect(view.othersUsedToday.points).toBe("7");
    const list = (await api(app, owner, "GET", "/api/agents")).json as { agents: Array<{ othersUsedToday: { points: string } }> };
    expect(list.agents[0]!.othersUsedToday.points).toBe("7");
    // A reply still being written holds points, and a proactive reply's hold is the proactive budget's, not the others' number's.
    await db.query(
      `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at, source, model, charge_to, hold_micro, lane)
       values ('reply', $1, $2, $3, 'running', 0, now(), 'site', 'fast', 'balance', 9000000, 'proactive')`,
      [agent.conversationId, agent.id, owner.id],
    );
    expect(((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json as { othersUsedToday: { points: string } }).othersUsedToday.points).toBe("7");
  });
});

describe("GET /api/models: proactiveAvailable", () => {
  it("is false without the judgement model and true with it", async () => {
    const owner = await signUp(app, "pro_models");
    expect((await api(app, owner, "GET", "/api/models")).json).toMatchObject({ proactiveAvailable: false });
    const on = await withJudge();
    try {
      const me = await signUp(on, "pro_models_on");
      expect((await api(on, me, "GET", "/api/models")).json).toMatchObject({ proactiveAvailable: true });
    } finally {
      await on.close();
    }
  });
});
