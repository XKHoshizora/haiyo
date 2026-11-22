import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { agentLimit, countLiveAgents } from "../agents/store.ts";
import { perPrincipalLimit } from "../limits.ts";
import { classOfCall } from "../metering/admit.ts";
import { requirePrincipal } from "../session.ts";
import { formatPoints, freeUsedToday, memoryUsedToday, nextSiteMidnight, siteDayStart } from "./store.ts";

/** How many site-days `recent` covers, today included. */
const RECENT_DAYS = 7;

/**
 * What a usage record's web searches were charged (lane websearch2): the record's `web_micro` is the searches' charge —
 * their price (an old code's record, `money_rule` 0) or their actual (`web_charge_micro`, the pool's) — and it is always
 * covered by what the run held for them (settle.ts: a search is held whole, never over), so it is that charge up to what
 * the record charged at all: less only when the whole record was forgiven (our own failure), or, by the old rule, ran
 * past the day's free allowance.
 */
const WEB_CHARGED = "least(web_micro, free_micro + balance_micro)";

const usageResponse = z.object({
  tier: z.string(),
  agentLimit: z.number(),
  agentCount: z.number(),
  balance: z.string(),
  free: z.object({ allowance: z.string(), used: z.string(), resetsAt: z.string() }),
  canStartFreeReply: z.boolean(),
  /** The allowance the site pays for memory calls (`MEMORY.freeDailyPoints`), apart from `free`: what the day has used of it. */
  memory: z.object({ allowance: z.string(), used: z.string(), resetsAt: z.string() }),
  recent: z.array(
    z.object({
      agentId: z.string().nullable(),
      purpose: z.enum(["reply", "draft", "memory"]),
      model: z.string(),
      source: z.enum(["site", "provider"]),
      points: z.string(),
      replies: z.number(),
      /** Present only for a memory call on a site model, and then `site`: the site's own allowance paid it, not the owner's points. */
      paidBy: z.literal("site").optional(),
    }),
  ),
  /**
   * Present only when replies searched the web (lane websearch2): per Agent, the searches of the same days and what they
   * were charged — its own line, never in a model's `points`, for site and provider models alike.
   */
  recentWeb: z.array(z.object({ agentId: z.string().nullable(), searches: z.number(), points: z.string() })).optional(),
  /**
   * Present only when something of the same days took the balance down beyond what was reserved for it (wallet v3, review
   * M7), so a minus on the balance can be explained — also one a free-tier reply's charge landed on: what paid replies
   * used past what was reserved for them, each its own debt (`usage_records.debt_micro`), and what the operator took
   * back (`adjust` entries). A deploy's overlap, the third cause, leaves no mark of its own.
   */
  recentDebt: z.object({ overruns: z.string(), adjustments: z.string() }).optional(),
});

/** Read-only: nothing under /api/usage changes a balance; credits are granted only by the operator's CLI. */
export function registerAccountRoutes(app: FastifyInstance): void {
  const { db, config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  // A read of several tables per call: 60 a minute each.
  const readLimit = perPrincipalLimit(app, 60);

  api.get(
    "/api/usage",
    {
      schema: {
        params: z.object({}),
        // Strict on purpose: no parameter may name another owner.
        querystring: z.strictObject({}),
        response: { 200: usageResponse },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      const now = new Date();
      // One connection, one read-only snapshot (taken at its first read): a settlement committing meanwhile is seen
      // whole or not at all — never a usage record without its charge.
      const { account, agentCount, used, memoryUsed, recent, web, debt } = await db.tx(async (t) => {
        await t.query("set transaction isolation level repeatable read, read only");
        const account = await t.query<{ tier: string; balance_micro: string }>("select tier, balance_micro::text from accounts where principal_id = $1", [me.id]);
        const agentCount = await countLiveAgents(t, me.id);
        const used = await freeUsedToday(t, me.id, now, config.siteTimezone);
        const memoryUsed = await memoryUsedToday(t, me.id, now, config.siteTimezone);
        const since = siteDayStart(now, config.siteTimezone, RECENT_DAYS - 1);
        const recent = await t.query<{ agent_id: string | null; purpose: "reply" | "draft" | "memory"; model: string; source: "site" | "provider"; points: string; charged: string; replies: number }>(
          // What the person was charged (the allowance and the balance), not the true cost: what was forgiven is not
          // theirs to see as spent. A memory call's `memory_micro` is the site's, shown as such (`paidBy`). Less what
          // its web searches were charged (`WEB_CHARGED`): those are a line of their own (`recentWeb`).
          `select agent_id, purpose, model, source, sum(free_micro + balance_micro + memory_micro - ${WEB_CHARGED})::text as points,
                  sum(free_micro + balance_micro - ${WEB_CHARGED})::text as charged,
                  (count(*) filter (where purpose = 'reply'))::int as replies
             from usage_records
            -- A run settled without reaching a model has no model to list (and cost nothing).
            where owner_id = $1 and created_at >= $2 and source is not null
            group by agent_id, purpose, model, source
            order by sum(free_micro + balance_micro + memory_micro - ${WEB_CHARGED}) desc, model, source, agent_id, purpose`,
          [me.id, since],
        );
        const web = await t.query<{ agent_id: string | null; searches: number; points: string }>(
          `select agent_id, sum(web_searches)::int as searches, sum(${WEB_CHARGED})::text as points
             from usage_records
            where owner_id = $1 and created_at >= $2 and web_searches > 0
            group by agent_id
            order by sum(${WEB_CHARGED}) desc, agent_id`,
          [me.id, since],
        );
        const debt = await t.query<{ overruns: string; adjustments: string }>(
          `select (select coalesce(sum(debt_micro), 0) from usage_records where owner_id = $1 and created_at >= $2)::text as overruns,
                  (select coalesce(-sum(delta_micro), 0) from balance_ledger where owner_id = $1 and created_at >= $2 and reason = 'adjust' and delta_micro < 0)::text as adjustments`,
          [me.id, since],
        );
        return { account, agentCount, used, memoryUsed, recent, web, debt: debt.rows[0]! };
      });
      // An account with no row yet is a free-tier account with nothing in it; reading never creates one.
      const tier = account.rows[0]?.tier ?? "free";
      const balanceMicro = BigInt(account.rows[0]?.balance_micro ?? "0");
      return {
        tier,
        // Creation's own rule (a tier the configuration no longer names gets the free limit).
        agentLimit: agentLimit(config, tier),
        agentCount,
        balance: formatPoints(balanceMicro),
        free: {
          allowance: formatPoints(config.freeDailyMicro),
          used: formatPoints(used),
          resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString(),
        },
        memory: {
          allowance: formatPoints(BigInt(config.memory.freeDailyPoints) * 1_000_000n),
          used: formatPoints(memoryUsed),
          resetsAt: nextSiteMidnight(now, config.siteTimezone).toISOString(),
        },
        // Admission's own class rule (src/metering/admit.ts `classSql`): a reply is refused only when nothing is left of
        // either pot; what running calls hold makes it wait, not fail. Read without the lock.
        canStartFreeReply: (await classOfCall(db, { freeTier: true, freeLeft: config.freeDailyMicro - used, balance: balanceMicro })) !== null,
        recent: recent.rows.map((r) => ({
          agentId: r.agent_id,
          purpose: r.purpose,
          model: r.model,
          source: r.source,
          points: formatPoints(BigInt(r.points)),
          replies: r.replies,
          // The site pays for a memory row only when nothing of it was charged to the owner (rows from before the allowance were).
          ...(r.purpose === "memory" && r.source === "site" && BigInt(r.charged) === 0n ? { paidBy: "site" as const } : {}),
        })),
        ...(web.rows.length > 0 ? { recentWeb: web.rows.map((w) => ({ agentId: w.agent_id, searches: w.searches, points: formatPoints(BigInt(w.points)) })) } : {}),
        ...(BigInt(debt.overruns) > 0n || BigInt(debt.adjustments) > 0n
          ? { recentDebt: { overruns: formatPoints(BigInt(debt.overruns)), adjustments: formatPoints(BigInt(debt.adjustments)) } }
          : {}),
      };
    },
  );
}
