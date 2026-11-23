import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listOwnedAgents } from "../agents/store.ts";
import type { Queryable } from "../db.ts";
import { perPrincipalLimit } from "../limits.ts";
import { othersByPerson, othersNumbers, othersUsedByAgents, othersUsedToday, perDayEstimate } from "../metering/others.ts";
import { requirePrincipal } from "../session.ts";
import { ensureAccount, formatPoints, MICRO_PER_POINT, pointsBetween } from "./store.ts";

// Lane B's route plugin (plan "Step 0 interfaces", Routes; README "Agent social", Numbers): what others' use of an owner's Agents has cost
// today against the owner's two numbers (answers and points, one value each per owner whatever the number of Agents), and the owner's
// say over them. Unlike lane A's, these are live whatever `SOCIAL.enabled` says (step L).

/** The owner's points number as a request gives it: a decimal string of points, 1 to 100 000 (as an Agent's `chainBudget`). */
const pointsNumber = pointsBetween(MICRO_PER_POINT, 100_000n * MICRO_PER_POINT);

const person = z.object({ id: z.string(), handle: z.string(), displayName: z.string(), avatarVersion: z.number() });
const useResponse = z.object({
  limits: z.object({ answers: z.number(), points: z.string() }),
  used: z.object({ answers: z.number(), points: z.string() }),
  reached: z.boolean(),
  byPerson: z.array(z.object({ person, answers: z.number(), points: z.string() })),
  stopped: z.array(z.object({ person, since: z.string() })),
  agents: z.array(z.object({ agentId: z.string(), answers: z.number(), points: z.string(), perDay: z.number() })),
  notice: z.boolean(),
});

/**
 * The people `ownerId` has stopped contact with (停止往来) and has not since lifted, newest first: the bars they set with reason `stopped`
 * that no block made (those are lifted by unblocking). Lane A's table `access_bars` (075) is read only where it exists, so this branch's
 * route never names a table it lacks; `SOCIAL.enabled` is what makes the caller ask (it is never on before 075).
 */
export async function stoppedOf(q: Queryable, ownerId: string): Promise<Array<{ person: { id: string; handle: string; displayName: string; avatarVersion: number }; since: string }>> {
  const there = await q.query<{ here: boolean }>("select to_regclass('public.access_bars') is not null as here");
  if (!there.rows[0]!.here) return [];
  const { rows } = await q.query<{ id: string; handle: string; name: string; avatar_version: number; since: Date }>(
    `select p.id, p.handle::text as handle, p.display_name as name, p.avatar_version, b.since
       from access_bars b join principals p on p.id = case when b.lo_id = $1 then b.hi_id else b.lo_id end
      where b.set_by = $1 and (b.lo_id = $1 or b.hi_id = $1) and b.reason = 'stopped' and not b.by_block
      order by b.since desc, p.id`,
    [ownerId],
  );
  return rows.map((r) => ({ person: { id: r.id, handle: r.handle, displayName: r.name, avatarVersion: r.avatar_version }, since: r.since.toISOString() }));
}

export function registerOthersRoutes(app: FastifyInstance): void {
  const { db, config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const empty = z.object({});
  // A read of several tables per call.
  const readLimit = perPrincipalLimit(app, 60);
  const writeLimit = perPrincipalLimit(app, 30);

  api.get("/api/me/others-use", { schema: { params: empty, querystring: z.strictObject({}), response: { 200: useResponse } } }, async (req) => {
    const me = await requirePrincipal(req);
    await readLimit(req, me.id);
    const now = new Date();
    // One snapshot: the numbers and the day read together.
    return db.tx(async (t) => {
      const agents = (await listOwnedAgents(t, me.id)).filter((a) => !a.deleted);
      const ids = agents.map((a) => a.id);
      const notice = await t.query<{ notice: boolean }>(
        `select coalesce((select others_notice_seen_at is null from accounts where principal_id = $1), true) and $2::boolean as notice`,
        [me.id, agents.length > 0],
      );
      // One connection, one query at a time.
      const owner = await ownerNumbersOf(t, config, me.id);
      const used = await othersUsedToday(t, config, me.id, now);
      const perAgent = await othersUsedByAgents(t, config, me.id, ids, now);
      const byPerson = await othersByPerson(t, config, me.id, now);
      const usedPoints = used.settledMicro + used.heldMicro;
      const perDay: number[] = [];
      for (const a of agents) perDay.push(perDayEstimate(config, a.model, await othersNumbers(t, config, me.id, a.id)));
      return {
        limits: { answers: owner.answers, points: formatPoints(owner.pointsMicro) },
        used: { answers: used.answers, points: formatPoints(usedPoints) },
        reached: used.answers >= owner.answers || usedPoints >= owner.pointsMicro,
        byPerson: byPerson.map((r) => ({ person: r.person, answers: r.answers, points: formatPoints(r.pointsMicro) })),
        // Read only while the site has Agent social on (never before lane A's 075), and then only where the table is.
        stopped: config.social.enabled ? await stoppedOf(t, me.id) : [],
        agents: agents.map((a, i) => {
          const u = perAgent.get(a.id) ?? { answers: 0, pointsMicro: 0n };
          return { agentId: a.id, answers: u.answers, points: formatPoints(u.pointsMicro), perDay: perDay[i]! };
        }),
        notice: notice.rows[0]!.notice,
      };
    });
  });

  api.put(
    "/api/me/others-limits",
    {
      schema: {
        params: empty,
        querystring: z.strictObject({}),
        body: z.strictObject({ answers: z.number().int().min(1).max(1000), points: pointsNumber }),
        response: { 200: z.object({ answers: z.number(), points: z.string() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const { answers, points } = req.body;
      await db.tx(async (t) => {
        await ensureAccount(t, me.id);
        await t.query("update accounts set others_answers = $2, others_points_micro = $3 where principal_id = $1", [me.id, answers, points.toString()]);
      });
      return { answers, points: formatPoints(points) };
    },
  );

  api.post(
    "/api/me/others-limits/seen",
    { schema: { params: empty, querystring: z.strictObject({}), body: empty.nullish(), response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      await db.tx(async (t) => {
        await ensureAccount(t, me.id);
        await t.query("update accounts set others_notice_seen_at = coalesce(others_notice_seen_at, now()) where principal_id = $1", [me.id]);
      });
      return { ok: true as const };
    },
  );
}

/** An owner's two numbers when they have no Agent to read them through: the account's own, else the config's. */
async function ownerNumbersOf(q: Queryable, config: Parameters<typeof othersNumbers>[1], ownerId: string): Promise<{ answers: number; pointsMicro: bigint }> {
  const { rows } = await q.query<{ answers: number | null; points: string | null }>("select others_answers as answers, others_points_micro::text as points from accounts where principal_id = $1", [ownerId]);
  const r = rows[0];
  return {
    answers: r?.answers ?? config.others.answersPerDay,
    pointsMicro: r?.points == null ? BigInt(config.others.pointsPerDay) * MICRO_PER_POINT : BigInt(r.points),
  };
}
