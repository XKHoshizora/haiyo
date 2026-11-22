import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { agentLimit, countLiveAgents } from "../agents/store.ts";
import { perPrincipalLimit } from "../limits.ts";
import { pickSources } from "../metering/admit.ts";
import { requirePrincipal } from "../session.ts";
import { formatPoints, freeUsedToday, memoryUsedToday, nextSiteMidnight, siteDayStart } from "./store.ts";

/** How many site-days `recent` covers, today included. */
const RECENT_DAYS = 7;

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
      /** Present only when its replies searched the web (lane websearch): how many searches its `points` include. */
      webSearches: z.number().optional(),
    }),
  ),
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
      const { account, agentCount, used, memoryUsed, recent } = await db.tx(async (t) => {
        await t.query("set transaction isolation level repeatable read, read only");
        const account = await t.query<{ tier: string; balance_micro: string }>("select tier, balance_micro::text from accounts where principal_id = $1", [me.id]);
        const agentCount = await countLiveAgents(t, me.id);
        const used = await freeUsedToday(t, me.id, now, config.siteTimezone);
        const memoryUsed = await memoryUsedToday(t, me.id, now, config.siteTimezone);
        const recent = await t.query<{ agent_id: string | null; purpose: "reply" | "draft" | "memory"; model: string; source: "site" | "provider"; points: string; charged: string; replies: number; web: number }>(
          // What the person was charged (the allowance and the balance), not the true cost: what was forgiven is not
          // theirs to see as spent. A memory call's `memory_micro` is the site's, shown as such (`paidBy`).
          `select agent_id, purpose, model, source, sum(free_micro + balance_micro + memory_micro)::text as points,
                  sum(free_micro + balance_micro)::text as charged,
                  (count(*) filter (where purpose = 'reply'))::int as replies, sum(web_searches)::int as web
             from usage_records
            -- A run settled without reaching a model has no model to list (and cost nothing).
            where owner_id = $1 and created_at >= $2 and source is not null
            group by agent_id, purpose, model, source
            order by sum(free_micro + balance_micro + memory_micro) desc, model, source, agent_id, purpose`,
          [me.id, siteDayStart(now, config.siteTimezone, RECENT_DAYS - 1)],
        );
        return { account, agentCount, used, memoryUsed, recent };
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
        // Admission's own rule (src/metering/admit.ts): a reply is refused only when nothing is left of either source;
        // what running calls hold makes it wait, not fail. Read without the lock.
        canStartFreeReply: (await pickSources(db, { freeTier: true, freeLeft: config.freeDailyMicro - used, balance: balanceMicro, balanceHeld: 0n })).anything !== null,
        recent: recent.rows.map((r) => ({
          agentId: r.agent_id,
          purpose: r.purpose,
          model: r.model,
          source: r.source,
          points: formatPoints(BigInt(r.points)),
          replies: r.replies,
          // The site pays for a memory row only when nothing of it was charged to the owner (rows from before the allowance were).
          ...(r.purpose === "memory" && r.source === "site" && BigInt(r.charged) === 0n ? { paidBy: "site" as const } : {}),
          ...(r.web > 0 ? { webSearches: r.web } : {}),
        })),
      };
    },
  );
}
