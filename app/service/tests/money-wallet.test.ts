import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createAgentPort, recoverRuns, sweepStaleRuns, type DbAgentPort } from "../src/agents/port-impl.ts";
import { NOTHING } from "../src/agents/runtime/port.ts";
import { createAgentWorker, type AgentWorker } from "../src/agents/runtime/worker.ts";
import { lockAgent } from "../src/agents/store.ts";
import { createToolbox, SEARCH_WEB } from "../src/agents/tools/index.ts";
import type { WebEngine, WebResult } from "../src/agents/tools/web/engine.ts";
import { holdSearch, SearchRefused } from "../src/agents/tools/web/hold.ts";
import { WEB_NO_MONEY } from "../src/agents/tools/web/words.ts";
import type { Config } from "../src/config.ts";
import { AppError } from "../src/errors.ts";
import { insertMessage } from "../src/messages/model.ts";
import { admitRun, classOfCall, HeldBack, raiseHold, type Admission } from "../src/metering/admit.ts";
import { settle } from "../src/metering/settle.ts";
import { partsOf, readParts, type PoolRow } from "../src/metering/wallet.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { ESTIMATE, grant, METER_ENV, meteredAgent, runningRun, type MeteredAgent } from "./helpers/metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * Wallet v3 wired in (.superpowers/sdd/2026-11-22-polish/design-wallet-v3.md; third attack V3.2, V3.6): the rows → parts
 * mapping against rows of every shape, migration 066's checks, and the pool against the database — two connections, the
 * queue's prediction, the deploy overlap with rows as the deployed code writes them, restart and the sweep, and the named
 * cases end to end through the worker. The meter models (METER_ENV: 100 and 1 000 micro-points a token, at most 1 000 out;
 * a call held at 2 points for `ESTIMATE` tokens in); the allowance 3 points a day, or 100 where a test says so.
 */

const { app, db } = useApp({ env: { ...METER_ENV, AGENT_RUNS_PER_MINUTE: "100" }, agentWorker: false });

const POINT = 1_000_000n;
const FREE = { source: "site", id: "meter_free" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;
const U = (inputTokens: number, outputTokens: number) => ({ inputTokens, outputTokens });
/** The app's configuration with an allowance of `points` a day. */
const allowance = (points: bigint): Config => ({ ...app.deps.config, freeDailyMicro: points * POINT });
/** With the web search on: Exa's estimate of $0.013 and its derived price of 13 points (design-wallet-v3.md §5). */
const withWeb = (config: Config, web: Partial<Config["tools"]["web"]> = {}): Config => ({
  ...config,
  tools: { ...config.tools, web: { ...config.tools.web, enabled: true, pointsMicroPerSearch: 13_000_000, costMicroUsdPerSearch: 13_000, ...web } },
});
const RESULTS: WebResult[] = [1, 2].map((i) => ({ url: `https://news${i}.example.com/${i}`, title: `标题${i}`, snippet: `摘要${i}` }));

const row = (o: Partial<PoolRow>): PoolRow => ({ id: "r", moneyRule: 1, chargeTo: "free", holdMicro: 0n, webMicro: 0n, overMicro: 0n, ...o });

const setUsed = (ownerId: string, micro: bigint) =>
  db.query(
    `insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, $2)
     on conflict (owner_id, day) do update set used_micro = $2`,
    [ownerId, micro.toString()],
  );
const usedToday = async (ownerId: string) =>
  BigInt((await db.query<{ u: string | null }>("select (select used_micro::text from free_usage where owner_id = $1 and day = (now() at time zone 'Asia/Shanghai')::date) as u", [ownerId])).rows[0]!.u ?? "0");
const balanceOf = async (ownerId: string) => BigInt((await db.query<{ b: string | null }>("select (select balance_micro::text from accounts where principal_id = $1) as b", [ownerId])).rows[0]!.b ?? "0");
const recordOf = async (runId: string) =>
  (
    await db.query<{ cost: string; free: string; balance: string; forgiven: string; web: string; rule: number }>(
      `select cost_micro::text as cost, free_micro::text as free, balance_micro::text as balance, forgiven_micro::text as forgiven, web_micro::text as web,
              money_rule as rule from usage_records where run_id = $1`,
      [runId],
    )
  ).rows;
const runOf = async (runId: string) =>
  (
    await db.query<{ status: string; charge_to: string | null; hold: string; over: string; web: string; charge: string; rule: number }>(
      `select status, charge_to, hold_micro::text as hold, hold_over_micro::text as over, web_micro::text as web, web_charge_micro::text as charge,
              money_rule as rule from agent_runs where id = $1`,
      [runId],
    )
  ).rows[0]!;
const NO_LOG = { warn: () => {} };
const settleWith = (runId: string, config: Config, usage: { inputTokens: number; outputTokens: number } | null, now = new Date()) =>
  db.tx((t) => settle(t, config, runId, usage, { inputChars: 0, outputChars: 0 }, "done", now, { log: NO_LOG }));
/** Settles `runId` and moves it out of `running` in one transaction, as `finish` does. */
const finishWith = (runId: string, config: Config, usage: { inputTokens: number; outputTokens: number } | null) =>
  db.tx(async (t) => {
    await settle(t, config, runId, usage, { inputChars: 0, outputChars: 0 }, "done", new Date(), { log: NO_LOG });
    await t.query("update agent_runs set status = 'done', finished_at = now() where id = $1", [runId]);
  });
const admitWith = (runId: string, owner: Actor, agent: MeteredAgent, config: Config, now = new Date()) =>
  db.tx((t) => admitRun(t, config, runId, owner.id, agent.resolved, ESTIMATE, now));

/** Each owner's one provider (made at their first provider Agent). */
const providers = new Map<string, string>();

/** A provider model's Agent of `owner`, on the owner's one provider. */
async function providerAgent(owner: Actor): Promise<MeteredAgent> {
  let providerId = providers.get(owner.id);
  if (providerId === undefined) {
    const created = await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "own-1", contextTokens: 32000 }] }));
    if (created.status !== 201) throw new Error(`providerAgent: ${created.status}`);
    providerId = created.json.id as string;
    providers.set(owner.id, providerId);
  }
  return meteredAgent(app, db, owner, { source: "provider", providerId, model: "own-1" });
}

/** A running reply of `agent`, admitted on its model by this code (rule 1). */
async function admittedReply(owner: Actor, agent: MeteredAgent, config: Config): Promise<string> {
  const runId = await runningRun(db, owner.id, agent);
  await admitWith(runId, owner, agent, config);
  return runId;
}

/** The pre-hold of a search of `runId` (of `agent`) as port-impl.ts calls it, under `lockRun`'s locks; `gate`: waited for before commit. */
const preHold = (owner: Actor, agent: MeteredAgent, runId: string, config: Config, gate?: { held: () => void; wait: Promise<void> }) =>
  db.tx(async (t) => {
    const locked = await lockAgent(t, agent.agentId, agent.conversationId);
    await t.query("select 1 from agent_runs where id = $1 for update", [runId]);
    const held = await holdSearch(t, config, { run: { id: runId, ownerId: owner.id, conversationId: agent.conversationId }, agent: locked, lane: { lane: "own", coversSeq: 0 }, reserveMicro: 0n }, new Date());
    if (gate) {
      gate.held();
      await gate.wait;
    }
    return held;
  });

/** A gate: `held` is called inside a transaction, which waits on `wait` (`release`) before it commits. */
function gated() {
  let held!: () => void;
  const heldNow = new Promise<void>((r) => (held = r));
  let release!: () => void;
  const wait = new Promise<void>((r) => (release = r));
  return { gate: { held, wait }, heldNow, release };
}

const refusedBy = (p: Promise<unknown>) =>
  p.then(
    () => "held",
    (err: unknown) => (err instanceof SearchRefused ? err.by : err instanceof HeldBack ? "held_back" : err instanceof AppError ? err.code : String(err)),
  );

describe("rows → parts (V3.2)", () => {
  it("rule 1: a site run's model part of its tier class (promised hold − web − over, its over), its searches' part AB whatever the tier; a provider run its searches only", () => {
    // A free-tier reply: 13 held, nothing over, no search.
    expect(partsOf(row({ holdMicro: 13n }))).toEqual([{ run: "r", cls: "AB", promised: 13n, over: 0n }]);
    // With two searches of 13 and a lone start's over of 11: model 2 + 11 over, searches 26.
    expect(partsOf(row({ holdMicro: 39n, webMicro: 26n, overMicro: 11n }))).toEqual([
      { run: "r", cls: "AB", promised: 2n, over: 11n },
      { run: "r", cls: "AB", promised: 26n, over: 0n },
    ]);
    // A paid-tier reply: the model on B, its search on AB (Q3: the allowance may pay our site tool's search).
    expect(partsOf(row({ chargeTo: "balance", holdMicro: 18n, webMicro: 13n, overMicro: 2n }))).toEqual([
      { run: "r", cls: "B", promised: 3n, over: 2n },
      { run: "r", cls: "AB", promised: 13n, over: 0n },
    ]);
    // A provider model's run: no model part, its searches only (its hold is theirs).
    expect(partsOf(row({ chargeTo: null, holdMicro: 26n, webMicro: 26n }))).toEqual([{ run: "r", cls: "AB", promised: 26n, over: 0n }]);
  });

  it("rule 0, as the old code writes it: the whole hold promised on its charge_to — free the allowance (A), balance the balance (B) — its searches inside it, nothing over", () => {
    expect(partsOf(row({ moneyRule: 0, holdMicro: 15n, webMicro: 13n }))).toEqual([{ run: "r", cls: "A", promised: 15n, over: 0n }]);
    expect(partsOf(row({ moneyRule: 0, chargeTo: "balance", holdMicro: 2n }))).toEqual([{ run: "r", cls: "B", promised: 2n, over: 0n }]);
    // A provider run of the old code that searched carries its searches' source (migration 065).
    expect(partsOf(row({ moneyRule: 0, chargeTo: "balance", holdMicro: 13n, webMicro: 13n }))).toEqual([{ run: "r", cls: "B", promised: 13n, over: 0n }]);
    expect(partsOf(row({ moneyRule: 0, chargeTo: null, holdMicro: 0n }))).toEqual([]);
  });

  it("nothing for a row holding nothing (not admitted, a provider run without searches, settled) or a memory call", () => {
    expect(partsOf(row({ holdMicro: 0n, webMicro: 26n, overMicro: 3n }))).toEqual([]); // settled: hold zeroed, the rest kept
    expect(partsOf(row({ chargeTo: null, holdMicro: 0n }))).toEqual([]);
    expect(partsOf(row({ chargeTo: "memory", holdMicro: 5n }))).toEqual([]);
    expect(partsOf(row({ moneyRule: 0, chargeTo: "memory", holdMicro: 5n }))).toEqual([]);
  });
});

describe("migration 066 (V3.2, V3.5)", () => {
  it("its checks: over never negative, web and over within the hold while it stands, the searches' charge within their price; a settled row's zeroed hold passes", async () => {
    const owner = await signUp(app, "walletchecks");
    const fast = await meteredAgent(app, db, owner, FREE);
    const run = await runningRun(db, owner.id, fast);
    const set = (sql: string) => db.query(`update agent_runs set ${sql} where id = $1`, [run]);
    await set("source = 'site', model = 'meter_free', charge_to = 'free', money_rule = 1, hold_micro = 39, web_micro = 26, hold_over_micro = 11, web_charge_micro = 20, web_searches = 2");
    await expect(set("hold_over_micro = -1")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_hold_parts" });
    await expect(set("hold_over_micro = 14")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_hold_parts" });
    await expect(set("web_micro = 29")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_hold_parts" });
    await expect(set("web_charge_micro = 27")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_web_charge" });
    await expect(set("web_charge_micro = -1")).rejects.toMatchObject({ code: "23514", constraint: "agent_runs_web_charge" });
    await expect(set("money_rule = 2")).rejects.toMatchObject({ code: "23514" });
    // Settled: the hold zeroed, what was held beside it kept as the record.
    await set("hold_micro = 0");
    expect(await readParts(db, owner.id)).toEqual([]);
  });

  it("readParts reads every running row of the owner through the one mapping, the run asked aside, nothing of other owners or of ended runs", async () => {
    const owner = await signUp(app, "walletread");
    const other = await signUp(app, "walletother");
    const fast = await meteredAgent(app, db, owner, FREE);
    const [a, b, c, d] = [await runningRun(db, owner.id, fast), await runningRun(db, owner.id), await runningRun(db, owner.id), await runningRun(db, other.id)];
    await db.query("update agent_runs set source = 'site', model = 'meter_free', charge_to = 'free', money_rule = 1, hold_micro = 20, web_micro = 13, web_searches = 1 where id = $1", [a]);
    await db.query("update agent_runs set source = 'site', model = 'meter_paid', charge_to = 'balance', money_rule = 0, hold_micro = 2 where id = $1", [b]);
    await db.query("update agent_runs set source = 'site', model = 'meter_paid', charge_to = 'balance', money_rule = 1, hold_micro = 5, status = 'done' where id = $1", [c]);
    await db.query("update agent_runs set source = 'site', model = 'meter_free', charge_to = 'free', money_rule = 1, hold_micro = 9 where id = $1", [d]);
    const parts = await readParts(db, owner.id);
    expect(parts).toEqual(
      expect.arrayContaining([
        { run: a, cls: "AB", promised: 7n, over: 0n },
        { run: a, cls: "AB", promised: 13n, over: 0n },
        { run: b, cls: "B", promised: 2n, over: 0n },
      ]),
    );
    expect(parts).toHaveLength(3);
    expect(await readParts(db, owner.id, a)).toEqual([{ run: b, cls: "B", promised: 2n, over: 0n }]);
  });

  it("on a populated table: the old code's rows of every shape take the defaults and pass both checks (down, rows as 450d5ff writes them, up; rolled back)", async () => {
    const owner = await signUp(app, "populated");
    const fast = await meteredAgent(app, db, owner, FREE);
    const own = await providerAgent(owner);
    const sql = readFileSync(new URL("../migrations/066_wallet_pool.sql", import.meta.url), "utf8");
    const [up, down] = sql.split("-- Down Migration");
    const client = await db.pool.connect();
    try {
      await client.query("begin");
      await client.query(down!);
      const insert = (status: string, extra: string, values: unknown[]) =>
        client.query(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at${extra === "" ? "" : `, ${extra}`})
           values ('reply', $1, $2, $3, $4, now()${values.map((_, i) => `, $${i + 5}`).join("")})`,
          [fast.conversationId, fast.agentId, owner.id, status, ...values],
        );
      // Running on the allowance with a search held, on the balance, settled with its searches kept, never admitted; a
      // provider run of the old code holding its searches' source (migration 065).
      await insert("running", "source, model, charge_to, hold_micro, web_searches, web_micro", ["site", "meter_free", "free", 2_770_350, 1, 770_350]);
      await insert("done", "source, model, charge_to, hold_micro, web_searches, web_micro", ["site", "meter_free", "balance", 0, 1, 770_350]);
      await insert("failed", "", []);
      await client.query(
        `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at, source, model, charge_to, hold_micro, web_searches, web_micro)
         values ('reply', $1, $2, $3, 'running', now(), 'provider', 'own-1', 'free', 770350, 1, 770350)`,
        [own.conversationId, own.agentId, owner.id],
      );
      await client.query(up!.replace("-- Up Migration", ""));
      const { rows } = await client.query<{ rule: number; over: string; charge: string }>(
        "select money_rule as rule, hold_over_micro::text as over, web_charge_micro::text as charge from agent_runs where owner_id = $1",
        [owner.id],
      );
      expect(rows).toHaveLength(4);
      expect(rows.every((r) => r.rule === 0 && r.over === "0" && r.charge === "0")).toBe(true);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});

describe("the queue's prediction is admission's own class rule (V3.6)", () => {
  it("for every tier and pot left: a younger reply waits behind a held-back one exactly when admission would admit it on some class; refused ones are not kept waiting", async () => {
    const port: DbAgentPort = createAgentPort({ db, config: app.deps.config, blobs: app.deps.blobs, realtime: app.realtime, conversations: app.deps.conversations, reads: app.deps.reads, log: app.log, toolbox: null });
    let i = 0;
    for (const tier of ["free", "paid"] as const) {
      for (const left of [0n, POINT]) {
        for (const balance of [-POINT, 0n, POINT]) {
          const owner = await signUp(app, `predict${i++}`);
          const [older, younger] = [await meteredAgent(app, db, owner, FREE), await meteredAgent(app, db, owner, tier === "free" ? FREE : PAID)];
          if (balance !== 0n) await grant(db, owner.id, balance);
          await setUsed(owner.id, 3n * POINT - left);
          // A running draft, and an older reply held back behind it (a free-tier reply's mark: both pots).
          const draft = await runningRun(db, owner.id);
          await db.query(
            `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, held_back_by, held_back_on, created_at)
             values ('reply', $1, $2, $3, 'queued', 0, array[$4::uuid], 'any', now() - interval '1 minute')`,
            [older.conversationId, older.agentId, owner.id, draft],
          );
          const queued = await db.query<{ id: string }>(
            "insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq) values ('reply', $1, $2, $3, 'queued', 0) returning id",
            [younger.conversationId, younger.agentId, owner.id],
          );
          const cls = await classOfCall(db, { freeTier: tier === "free", freeLeft: left, balance });
          const claimed = await port.claimNext();
          const where = `${tier} A ${left} B ${balance}`;
          // Claimed (not kept waiting) exactly when admission finds nothing to admit it on; then admission refuses it.
          expect([where, claimed?.id === queued.rows[0]!.id]).toEqual([where, cls === null]);
          if (claimed) {
            const refused = await db.tx((t) => admitRun(t, app.deps.config, claimed.id, owner.id, younger.resolved, ESTIMATE, new Date())).catch((e: unknown) => e);
            expect([where, (refused as AppError).code]).toEqual([where, "no_quota"]);
            await db.query("update agent_runs set status = 'failed' where id = $1", [claimed.id]);
          }
          await db.query("update agent_runs set status = 'failed' where owner_id = $1 and status in ('queued', 'running')", [owner.id]);
        }
      }
    }
  });
});

describe("two connections (V3.6)", () => {
  it("two pre-holds racing for the last of the allowance and the balance together: one is held, the other refused", async () => {
    const owner = await signUp(app, "lastpool");
    const [a, b] = [await providerAgent(owner), await providerAgent(owner)];
    const config = withWeb(app.deps.config, { pointsMicroPerSearch: 2_000_000 });
    // 1 point of the allowance and 2 of the balance: one search of 2 fits them together, not two.
    await setUsed(owner.id, 2n * POINT);
    await grant(db, owner.id, 2n * POINT);
    const [ra, rb] = [await admittedReply(owner, a, config), await admittedReply(owner, b, config)];
    const { gate, heldNow, release } = gated();
    const first = preHold(owner, a, ra, config, gate);
    await heldNow;
    const second = refusedBy(preHold(owner, b, rb, config));
    await new Promise((r) => setTimeout(r, 100));
    release();
    await first;
    expect(await second).toBe("no_points");
    expect([(await runOf(ra)).web, (await runOf(rb)).web]).toEqual(["2000000", "0"]);
    // Settled, the allowance first: 1 point from it, 1 from the balance.
    await finishWith(ra, config, null);
    expect((await recordOf(ra))[0]).toMatchObject({ free: "1000000", balance: "1000000", forgiven: "0" });
  });

  it("a pre-hold against another run's round: whichever takes the account first, the other sees its hold", async () => {
    for (const searchFirst of [true, false]) {
      const owner = await signUp(app, `roundvs${searchFirst ? "s" : "m"}`);
      const fast = await meteredAgent(app, db, owner, FREE);
      const own = await providerAgent(owner);
      const config = withWeb(allowance(100n));
      // 2 points of the allowance, 13 of the balance: the reply's 2 promised, 13 left — a search's 13 or a round's 5.
      await setUsed(owner.id, 98n * POINT);
      await grant(db, owner.id, 13n * POINT);
      const reply = await admittedReply(owner, fast, config);
      const provider = await admittedReply(owner, own, config);
      const raise = (gate?: ReturnType<typeof gated>["gate"]) =>
        db.tx(async (t) => {
          await t.query("select 1 from agent_runs where id = $1 for update", [reply]);
          const answer = await raiseHold(t, config, { id: reply, ownerId: owner.id, chargeTo: "free", holdMicro: 2n * POINT, webMicro: 0n }, { ok: 7n * POINT, final: 3n * POINT }, true, new Date());
          if (gate) {
            gate.held();
            await gate.wait;
          }
          return answer;
        });
      const { gate, heldNow, release } = gated();
      const first = searchFirst ? preHold(owner, own, provider, config, gate) : raise(gate);
      await heldNow;
      const second = searchFirst ? raise() : refusedBy(preHold(owner, own, provider, config));
      await new Promise((r) => setTimeout(r, 100));
      release();
      const firstAnswer = await first;
      if (searchFirst) {
        // The search took the 13: the round fits nothing more — its last, raised to its final target, 1 of it over.
        expect(await second).toBe("final");
        expect(await runOf(reply)).toMatchObject({ hold: (3n * POINT).toString(), over: POINT.toString() });
      } else {
        expect(firstAnswer).toBe("ok");
        expect(await second).toBe("no_points");
        expect(await runOf(reply)).toMatchObject({ hold: (7n * POINT).toString(), over: "0" });
      }
    }
  });

  it("a reply held back behind a provider run's search is claimed once that run has settled: never stranded", async () => {
    const owner = await signUp(app, "stranded");
    const own = await providerAgent(owner);
    const fast = await meteredAgent(app, db, owner, FREE);
    const config = withWeb(app.deps.config, { pointsMicroPerSearch: 2_500_000 });
    const provider = await admittedReply(owner, own, config);
    await preHold(owner, own, provider, config);
    const port: DbAgentPort = createAgentPort({ db, config, blobs: app.deps.blobs, realtime: app.realtime, conversations: app.deps.conversations, reads: app.deps.reads, log: app.log, toolbox: null });
    await api(app, owner, "POST", `/api/conversations/${fast.conversationId}/messages`, { text: "你好", clientTxn: "stranded1" });
    const ticket = (await port.claimNext())!;
    // The search holds 2.5 of the 3 points: the reply's 2 do not fit beside it, and it is not alone — held back behind it.
    expect(await port.begin(ticket)).toMatchObject({ status: "cancelled" });
    expect(await db.query("select status, held_back_by, held_back_on from agent_runs where id = $1", [ticket.id]).then((r) => r.rows[0])).toEqual({
      status: "queued",
      held_back_by: [provider],
      held_back_on: "any",
    });
    expect(await port.claimNext()).toBeNull();
    // The provider run settles (under the account lock: it holds on the pots) and leaves running: the reply is claimed.
    await finishWith(provider, config, null);
    expect((await port.claimNext())?.id).toBe(ticket.id);
    await db.query("update agent_runs set status = 'failed' where id = $1", [ticket.id]);
  });
});

describe("the deploy overlap, rows as the deployed code (450d5ff) writes them (V3.5, V3.6)", () => {
  it("old code admits a balance reply on the balance a new free-tier promise sits on: new code adds nothing to it, and the promise lands below zero by that row's hold at most", async () => {
    const owner = await signUp(app, "overlapb");
    const fast = await meteredAgent(app, db, owner, FREE);
    const own = await providerAgent(owner);
    const paid = await meteredAgent(app, db, owner, PAID);
    // The allowance used up, 2 points of balance: the new free-tier reply's 2 are promised on the balance.
    await setUsed(owner.id, 3n * POINT);
    await grant(db, owner.id, 2n * POINT);
    const reply = await admittedReply(owner, fast, app.deps.config);
    // Old code counts that run whole on its charge_to `free` (its readHolds, verbatim), sees nothing held on the balance,
    // and admits its own paid reply there (alone on the balance by its rule): a rule-0 row of 2.
    const oldHolds = (
      await db.query<{ free: string; balance: string }>(
        `select coalesce(sum(hold_micro) filter (where charge_to = 'free'), 0)::text as free,
                coalesce(sum(hold_micro) filter (where charge_to = 'balance'), 0)::text as balance
           from agent_runs
          where owner_id = $1 and status = 'running'`,
        [owner.id],
      )
    ).rows[0]!;
    expect(oldHolds).toEqual({ free: (2n * POINT).toString(), balance: "0" });
    const legacy = await runningRun(db, owner.id, paid);
    await db.query("update agent_runs set source = 'site', model = 'meter_paid', charge_to = 'balance', hold_micro = $2 where id = $1", [legacy, (2n * POINT).toString()]);
    // New code counts the old row capped at the balance: nothing more fits — a search is refused, nothing added.
    const provider = await admittedReply(owner, own, withWeb(app.deps.config));
    expect(await refusedBy(preHold(owner, own, provider, withWeb(app.deps.config, { pointsMicroPerSearch: 1 })))).toBe("no_points");
    // Both settle at their holds: the old row by the old rule, the new one by the pool — 2 below zero, the old row's hold.
    await finishWith(legacy, app.deps.config, U(10_000, 1000));
    await finishWith(reply, app.deps.config, U(10_000, 1000));
    expect([(await recordOf(legacy))[0]!.rule, (await recordOf(reply))[0]!.rule]).toEqual([0, 1]);
    expect((await recordOf(reply))[0]).toMatchObject({ free: "0", balance: (2n * POINT).toString(), forgiven: "0" });
    expect(await balanceOf(owner.id)).toBe(-2n * POINT);
  });

  it("new code settles the old code's rows by the old rule, to the micro-point: the allowance capped at what is left, the searches in full outside the model's clip, the balance whole, a provider run's searches on its source", async () => {
    const owner = await signUp(app, "legacyset");
    const [fast, paid, own] = [await meteredAgent(app, db, owner, FREE), await meteredAgent(app, db, owner, PAID), await providerAgent(owner)];
    await grant(db, owner.id, 10n * POINT);
    await setUsed(owner.id, 2_500_000n);
    const rule0 = async (agent: MeteredAgent, cols: { source: string; model: string; charge_to: string; hold: bigint; web: bigint }) => {
      const id = await runningRun(db, owner.id, agent);
      await db.query("update agent_runs set source = $2, model = $3, charge_to = $4, hold_micro = $5, web_searches = $6, web_micro = $7 where id = $1", [
        id, cols.source, cols.model, cols.charge_to, cols.hold.toString(), cols.web > 0n ? 1 : 0, cols.web.toString(),
      ]);
      return id;
    };
    // On the allowance (0.5 left), a search of 0.77035 held with the model's 2: model 1.5 + search = 2.27035 charged by
    // the old rule, 0.5 of it to the allowance, the rest forgiven.
    const f = await rule0(fast, { source: "site", model: "meter_free", charge_to: "free", hold: 2_770_350n, web: 770_350n });
    await finishWith(f, app.deps.config, U(5_000, 1_000));
    expect((await recordOf(f))[0]).toEqual({ cost: "2270350", free: "500000", balance: "0", forgiven: "1770350", web: "770350", rule: 0 });
    // On the balance: an upstream reporting 15 against a model hold of 2: 2 + the search, in full.
    const b = await rule0(paid, { source: "site", model: "meter_paid", charge_to: "balance", hold: 2_770_350n, web: 770_350n });
    await finishWith(b, app.deps.config, U(100_000, 5_000));
    expect((await recordOf(b))[0]).toEqual({ cost: "15770350", free: "0", balance: "2770350", forgiven: "13000000", web: "770350", rule: 0 });
    // A provider run of the old code, its search on the balance.
    const p = await rule0(own, { source: "provider", model: "own-1", charge_to: "balance", hold: 770_350n, web: 770_350n });
    await finishWith(p, app.deps.config, U(1000, 100));
    expect((await recordOf(p))[0]).toEqual({ cost: "770350", free: "0", balance: "770350", forgiven: "0", web: "770350", rule: 0 });
    expect(await balanceOf(owner.id)).toBe(10n * POINT - 2_770_350n - 770_350n);
  });

  it("old code ending a new code's run (its recovery, release or sweep: all forgiveAll) charges nothing and breaks no check of 066", async () => {
    const owner = await signUp(app, "oldforgives");
    const fast = await meteredAgent(app, db, owner, FREE);
    const config = withWeb(app.deps.config, { pointsMicroPerSearch: 500_000 });
    await grant(db, owner.id, POINT);
    const run = await admittedReply(owner, fast, config);
    await preHold(owner, fast, run, config);
    await db.query("update agent_runs set web_charge_micro = 100000 where id = $1", [run]);
    // The old code reads none of 066's columns: as it settles, the row is rule 0 to it.
    await db.query("update agent_runs set money_rule = 0 where id = $1", [run]);
    await db.tx((t) => settle(t, config, run, null, { inputChars: 0, outputChars: 0 }, "failed", new Date(), { forgiveAll: true, log: NO_LOG }));
    expect((await recordOf(run))[0]).toMatchObject({ free: "0", balance: "0" });
    expect(await runOf(run)).toMatchObject({ hold: "0", web: "500000", charge: "100000" });
    expect([await usedToday(owner.id), await balanceOf(owner.id)]).toEqual([0n, POINT]);
  });

  it("the drain: after the old container has exited, the running rows the old code admitted are what is left to settle by the old rule", async () => {
    const owner = await signUp(app, "drain");
    const agents = [await meteredAgent(app, db, owner, FREE), await meteredAgent(app, db, owner, FREE), await meteredAgent(app, db, owner, FREE), await meteredAgent(app, db, owner, FREE)];
    const [oldAdmitted, newAdmitted, notAdmitted] = [await runningRun(db, owner.id, agents[0]), await admittedReply(owner, agents[1]!, app.deps.config), await runningRun(db, owner.id, agents[2])];
    await db.query("update agent_runs set source = 'site', model = 'meter_free', charge_to = 'free', hold_micro = 2000000 where id = $1", [oldAdmitted]);
    await db.query("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq) values ('reply', $1, $2, $3, 'queued', 0)", [
      agents[3]!.conversationId,
      agents[3]!.agentId,
      owner.id,
    ]);
    const drain = await db.query<{ n: number }>("select count(*)::int as n from agent_runs where status = 'running' and source is not null and money_rule = 0");
    expect(drain.rows[0]!.n).toBe(1);
    expect([(await runOf(oldAdmitted)).rule, (await runOf(newAdmitted)).rule, (await runOf(notAdmitted)).rule]).toEqual([0, 1, 0]);
  });
});

describe("restart and the stale-run sweep, a run in each state (V3.6)", () => {
  /**
   * One owner's runs, one in each state, each of its own Agent: queued; running, not admitted; admitted by the old rule
   * (rule 0, a search held); by the pool with over; a provider run whose search the engine never answered; one whose
   * search was corrected; one whose reply was posted but not finished.
   */
  async function states(name: string): Promise<{ owner: Actor; running: string[]; queued: string; posted: string; withOver: string }> {
    const owner = await signUp(app, name);
    const config = withWeb(app.deps.config, { pointsMicroPerSearch: 500_000 });
    await grant(db, owner.id, 10n * POINT);
    const agent = () => meteredAgent(app, db, owner, FREE);
    const queuedAgent = await agent();
    const queued = (
      await db.query<{ id: string }>("insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq) values ('reply', $1, $2, $3, 'queued', 0) returning id", [
        queuedAgent.conversationId,
        queuedAgent.agentId,
        owner.id,
      ])
    ).rows[0]!.id;
    const notAdmitted = await runningRun(db, owner.id, await agent());
    const postedAgent = await agent();
    const posted = await admittedReply(owner, postedAgent, config);
    await db.tx((t) => insertMessage(t, postedAgent.conversationId, postedAgent.agentId, "text", { text: "已经答了。" }, posted));
    const unanswered = await admittedReply(owner, await providerAgent(owner), config);
    await db.query("update agent_runs set hold_micro = 500000, web_searches = 1, web_micro = 500000, web_charge_micro = 500000 where id = $1", [unanswered]);
    const corrected = await admittedReply(owner, await providerAgent(owner), config);
    await db.query("update agent_runs set hold_micro = 500000, web_searches = 1, web_micro = 500000, web_charge_micro = 270000 where id = $1", [corrected]);
    const rule0 = await runningRun(db, owner.id, await agent());
    await db.query("update agent_runs set source = 'site', model = 'meter_free', charge_to = 'free', hold_micro = 2500000, web_searches = 1, web_micro = 500000 where id = $1", [rule0]);
    // Of the pots' 3 + 10, 2 + 0.5 + 0.5 + 2.5 are promised: its 2 fit; then a last round asking 18 more is promised the
    // 5.5 left, and holds the rest over.
    const withOver = await admittedReply(owner, await agent(), config);
    expect(
      await db.tx(async (t) => {
        await t.query("select 1 from agent_runs where id = $1 for update", [withOver]);
        return raiseHold(t, config, { id: withOver, ownerId: owner.id, chargeTo: "free", holdMicro: 2n * POINT, webMicro: 0n }, { ok: 20n * POINT, final: 20n * POINT }, true, new Date());
      }),
    ).toBe("final");
    return { owner, running: [notAdmitted, rule0, withOver, unanswered, corrected, posted], queued, posted, withOver };
  }

  async function expectReleased(s: Awaited<ReturnType<typeof states>>, before: { used: bigint; balance: bigint }) {
    for (const id of s.running) {
      const r = await runOf(id);
      expect([id, r.status === "running", r.hold]).toEqual([id, false, "0"]);
      expect([id, (await recordOf(id)).length]).toEqual([id, 1]);
    }
    expect((await runOf(s.posted)).status).toBe("done");
    expect((await runOf(s.queued)).status).toBe("queued");
    expect(await readParts(db, s.owner.id)).toEqual([]);
    // Everything forgiven: the pots as they were.
    expect([await usedToday(s.owner.id), await balanceOf(s.owner.id)]).toEqual([before.used, before.balance]);
  }

  it("start-up recovery ends every running one, forgiving all, each once; a second start finds nothing; the sweep then nothing either", async () => {
    const s = await states("restartall");
    expect((await runOf(s.withOver)).over).toBe(12_500_000n.toString());
    const before = { used: await usedToday(s.owner.id), balance: await balanceOf(s.owner.id) };
    expect(await recoverRuns(db, app.deps.config, app.log)).toBe(6);
    await expectReleased(s, before);
    expect(await recoverRuns(db, app.deps.config, app.log)).toBe(0);
    await db.query("update agent_runs set started_at = now() - interval '1 day' where owner_id = $1", [s.owner.id]);
    const port = createAgentPort({ db, config: app.deps.config, blobs: app.deps.blobs, realtime: app.realtime, conversations: app.deps.conversations, reads: app.deps.reads, log: app.log, toolbox: null });
    expect(await sweepStaleRuns(port, db, app.deps.config, app.log, () => false)).toBe(0);
    await expectReleased(s, before);
  });

  it("the stale-run sweep releases the same states as recovery does, each once", async () => {
    const s = await states("sweepall");
    const before = { used: await usedToday(s.owner.id), balance: await balanceOf(s.owner.id) };
    await db.query("update agent_runs set started_at = now() - interval '1 day' where owner_id = $1 and status = 'running'", [s.owner.id]);
    const port = createAgentPort({ db, config: app.deps.config, blobs: app.deps.blobs, realtime: app.realtime, conversations: app.deps.conversations, reads: app.deps.reads, log: app.log, toolbox: null });
    expect(await sweepStaleRuns(port, db, app.deps.config, app.log, () => false)).toBe(6);
    await expectReleased(s, before);
    expect(await sweepStaleRuns(port, db, app.deps.config, app.log, () => false)).toBe(0);
    expect(await recoverRuns(db, app.deps.config, app.log)).toBe(0);
  });
});

describe("by lane, by tier, across the day (V3.6)", () => {
  it("a paid reply's over is its own debt in every lane while Q4 is open (own, others, proactive); a free-tier one's is forgiven", async () => {
    for (const lane of ["own", "others", "proactive"] as const) {
      const owner = await signUp(app, `lanedebt${lane}`);
      const paid = await meteredAgent(app, db, owner, PAID);
      await grant(db, owner.id, POINT);
      const run = await runningRun(db, owner.id, paid);
      await db.query("update agent_runs set lane = $2 where id = $1", [run, lane]);
      expect(await admitWith(run, owner, paid, app.deps.config)).toEqual({ chargeTo: "balance", holdMicro: 2n * POINT, overMicro: POINT });
      await finishWith(run, app.deps.config, U(10_000, 1000));
      expect([lane, (await recordOf(run))[0]]).toMatchObject([lane, { balance: (2n * POINT).toString(), forgiven: "0" }]);
      expect([lane, await balanceOf(owner.id)]).toEqual([lane, -POINT]);
    }
    const owner = await signUp(app, "lanedebtfree");
    const fast = await meteredAgent(app, db, owner, FREE);
    await setUsed(owner.id, 2n * POINT);
    const run = await admittedReply(owner, fast, app.deps.config);
    expect(await runOf(run)).toMatchObject({ over: POINT.toString() });
    await finishWith(run, app.deps.config, U(10_000, 1000));
    expect((await recordOf(run))[0]).toMatchObject({ free: POINT.toString(), balance: "0", forgiven: POINT.toString() });
    expect(await balanceOf(owner.id)).toBe(0n);
  });

  it("the allowance resets during a run: a round after midnight sees the new day's allowance — the reply's own promise counted on it — and the reply settles on it", async () => {
    const owner = await signUp(app, "midnightround");
    const fast = await meteredAgent(app, db, owner, FREE);
    const day1 = new Date("2026-03-01T15:50:00Z"); // 23:50 in Shanghai
    const day2 = new Date("2026-03-01T16:10:00Z"); // 00:10 the next day
    await db.query("insert into free_usage (owner_id, day, used_micro) values ($1, '2026-03-01', 500000)", [owner.id]);
    const run = await runningRun(db, owner.id, fast);
    // 2.5 left on the 1st: the 2 fit.
    expect(await admitWith(run, owner, fast, app.deps.config, day1)).toEqual({ chargeTo: "free", holdMicro: 2n * POINT });
    const round = (now: Date, ok: bigint) =>
      db.tx(async (t) => {
        await t.query("select 1 from agent_runs where id = $1 for update", [run]);
        const held = BigInt((await t.query<{ h: string }>("select hold_micro::text as h from agent_runs where id = $1", [run])).rows[0]!.h);
        return raiseHold(t, app.deps.config, { id: run, ownerId: owner.id, chargeTo: "free", holdMicro: held, webMicro: 0n }, { ok, final: ok }, true, now);
      });
    // On the 1st only 0.5 was left beside its 2; on the 2nd the new day's 3 are there, its own 2 counted on them: a raise
    // of 1 fits — "ok" — and the whole reply settles on the new day's allowance.
    expect(await round(day2, 3n * POINT)).toBe("ok");
    expect(await runOf(run)).toMatchObject({ hold: (3n * POINT).toString(), over: "0" });
    await db.tx((t) => settle(t, app.deps.config, run, U(20_000, 1000), { inputChars: 0, outputChars: 0 }, "done", day2, { log: NO_LOG }));
    expect((await recordOf(run))[0]).toMatchObject({ cost: (3n * POINT).toString(), free: (3n * POINT).toString(), forgiven: "0" });
    expect((await db.query("select day::text, used_micro::text as used from free_usage where owner_id = $1 order by day", [owner.id])).rows).toEqual([
      { day: "2026-03-01", used: "500000" },
      { day: "2026-03-02", used: "3000000" },
    ]);
  });

  it("V2-I1 against the database, settled in both orders: a paid reply promised 2, a free-tier one raised past what is left beside it — the same pots, its overrun never the paid one's debt", async () => {
    const results: unknown[] = [];
    for (const order of ["free first", "paid first"] as const) {
      const owner = await signUp(app, order === "free first" ? "v2ifree" : "v2ipaid");
      const [paid, fast] = [await meteredAgent(app, db, owner, PAID), await meteredAgent(app, db, owner, FREE)];
      await setUsed(owner.id, 3n * POINT);
      await grant(db, owner.id, 4n * POINT);
      const p = await admittedReply(owner, paid, app.deps.config);
      const f = await admittedReply(owner, fast, app.deps.config);
      const answer = await db.tx(async (t) => {
        await t.query("select 1 from agent_runs where id = $1 for update", [f]);
        return raiseHold(t, app.deps.config, { id: f, ownerId: owner.id, chargeTo: "free", holdMicro: 2n * POINT, webMicro: 0n }, { ok: 14n * POINT, final: 12n * POINT }, true, new Date());
      });
      expect(answer).toBe("final");
      expect(await runOf(f)).toMatchObject({ hold: (12n * POINT).toString(), over: (10n * POINT).toString() });
      const settleF = () => finishWith(f, app.deps.config, U(100_000, 2000)); // 12
      const settleP = () => finishWith(p, app.deps.config, U(10_000, 1000)); // 2
      if (order === "free first") {
        await settleF();
        await settleP();
      } else {
        await settleP();
        await settleF();
      }
      results.push({ balance: await balanceOf(owner.id), f: (await recordOf(f))[0], p: (await recordOf(p))[0] });
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({ balance: 0n, f: { balance: (2n * POINT).toString(), forgiven: (10n * POINT).toString() }, p: { balance: (2n * POINT).toString(), forgiven: "0" } });
  });

  it("C1b against the database: a paid reply that started alone on a small balance does not hold back a free-tier reply, nor its round, nor its search", async () => {
    const owner = await signUp(app, "c1b");
    const config = withWeb(allowance(100n));
    const [paid, fast] = [await meteredAgent(app, db, owner, PAID), await meteredAgent(app, db, owner, FREE)];
    await setUsed(owner.id, 50n * POINT);
    await grant(db, owner.id, POINT);
    const p = await runningRun(db, owner.id, paid);
    expect(await admitWith(p, owner, paid, config)).toEqual({ chargeTo: "balance", holdMicro: 2n * POINT, overMicro: POINT });
    const f = await runningRun(db, owner.id, fast);
    expect(await admitWith(f, owner, fast, config)).toEqual({ chargeTo: "free", holdMicro: 2n * POINT });
    const round = await db.tx(async (t) => {
      await t.query("select 1 from agent_runs where id = $1 for update", [f]);
      return raiseHold(t, config, { id: f, ownerId: owner.id, chargeTo: "free", holdMicro: 2n * POINT, webMicro: 0n }, { ok: 4n * POINT, final: 3n * POINT }, true, new Date());
    });
    expect(round).toBe("ok");
    // (4 + 13 within TOOLS.maxPoints' 20.)
    await preHold(owner, fast, f, config);
    expect(await runOf(f)).toMatchObject({ hold: (17n * POINT).toString(), web: (13n * POINT).toString(), over: "0" });
  });
});

describe("end to end through the worker (V3.6)", () => {
  /** A worker on the real port with the web search on (`engine` faked), the allowance `points` a day. */
  function webWorker(gateway: ScriptedGateway, engine: WebEngine, points: bigint): { worker: AgentWorker; config: Config } {
    const config = withWeb(allowance(points));
    const { blobs, conversations, reads, searches } = app.deps;
    const toolbox = createToolbox({ db, blobs, searches, config, log: app.log, webEngine: engine });
    const port = createAgentPort({ db, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, toolbox });
    return { worker: createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools }), config };
  }
  const engineSaying = (costMicroUsd?: bigint) => {
    const queries: string[] = [];
    const engine: WebEngine & { queries: string[] } = {
      name: "fake",
      queries,
      async searchWeb(query) {
        queries.push(query);
        return costMicroUsd === undefined ? { results: RESULTS } : { results: RESULTS, costMicroUsd };
      },
    };
    return engine;
  };
  /** A reply of `agent` that searches once and answers, each round reporting `usage`. */
  let txn = 0;
  async function searchingReply(owner: Actor, agent: MeteredAgent, worker: AgentWorker, gateway: ScriptedGateway) {
    const sent = await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "北京今天天气怎么样？", clientTxn: `e2e${++txn}` });
    expect(sent.status).toBe(201);
    gateway.callTools([{ name: SEARCH_WEB, input: { query: "北京 天气" } }], { usage: U(1000, 20) }).reply("晴。", { usage: U(1500, 30) });
    expect(await worker.runOnce()).toBe(true);
    const { rows } = await db.query<{ id: string }>("select id from agent_runs where agent_id = $1 and purpose = 'reply' order by created_at desc limit 1", [agent.agentId]);
    const outputs: any[] = (gateway.calls.at(-1)!.steps ?? []).flatMap((s) => s.results.map((r) => r.output));
    return { runId: rows[0]!.id, outputs };
  }
  const MODEL = U(2500, 50); // the two rounds: 0.3 points on the meter models

  it("the live case: 81 and then 95 of 100 free points used, balance 1000, a free-tier reply's search runs; charged at its actual, the allowance first", async () => {
    for (const [used, fromFree, fromBalance] of [
      [81n, 7_300_000n, 0n],
      [95n, 5_000_000n, 2_300_000n],
    ] as const) {
      const gateway = scriptedGateway();
      const engine = engineSaying(7_000n); // $0.007: 7 of the 13 points
      const { worker } = webWorker(gateway, engine, 100n);
      const owner = await signUp(app, `live${used}`);
      const fast = await meteredAgent(app, db, owner, FREE);
      await grant(db, owner.id, 1000n * POINT);
      await setUsed(owner.id, used * POINT);
      const { runId, outputs } = await searchingReply(owner, fast, worker, gateway);
      expect([used, engine.queries.length, "results" in outputs[0]]).toEqual([used, 1, true]);
      const model = BigInt(MODEL.inputTokens) * 100n + BigInt(MODEL.outputTokens) * 1000n;
      expect([used, (await recordOf(runId))[0]]).toEqual([
        used,
        { cost: (model + 7n * POINT).toString(), free: fromFree.toString(), balance: fromBalance.toString(), forgiven: "0", web: (7n * POINT).toString(), rule: 1 },
      ]);
      expect([used, await balanceOf(owner.id)]).toEqual([used, 1000n * POINT - fromBalance]);
    }
  });

  it("both pots used up after the reply started (V2-M2): it goes on — its search refused before the engine, its next round the last — what it was promised charged, the rest the site's, the balance untouched", async () => {
    const gateway = scriptedGateway();
    const engine = engineSaying();
    const { worker } = webWorker(gateway, engine, 3n);
    const owner = await signUp(app, "bothgone");
    const fast = await meteredAgent(app, db, owner, FREE);
    const { runId, outputs } = await searchingReply(owner, fast, worker, gateway);
    // Alone on the 3 points with a hold of its first call and room for its last: all 3 promised, the rest over.
    expect(outputs).toEqual([{ error: WEB_NO_MONEY }]);
    expect(engine.queries).toEqual([]);
    expect(gateway.calls[1]!.toolChoice).toBe("none");
    const rec = (await recordOf(runId))[0]!;
    expect(rec).toMatchObject({ free: rec.cost, balance: "0", forgiven: "0", web: "0", rule: 1 });
    expect(await balanceOf(owner.id)).toBe(0n);
    expect(BigInt((await runOf(runId)).over)).toBeGreaterThan(0n);
  });
});
