import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listOwnedAgents } from "../agents/store.ts";
import { onSnapshot, type Queryable } from "../db.ts";
import { perPrincipalLimit } from "../limits.ts";
import { agentRoom, othersByPerson, othersUsedByAgents, othersUsedToday, ownerNumbers, perDayEstimate } from "../metering/others.ts";
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
  tight: z.boolean(),
  byPerson: z.array(z.object({ person, answers: z.number(), points: z.string() })),
  stopped: z.array(z.object({ person, since: z.string() })),
  agents: z.array(z.object({ agentId: z.string(), answers: z.number(), points: z.string(), perDay: z.number(), reached: z.boolean(), tight: z.boolean() })),
  notice: z.boolean(),
});

/** One stopped person as the route answers it. */
export type StoppedPerson = { person: { id: string; handle: string; displayName: string; avatarVersion: number }; since: string };
/** What the one query below returns for a stopped person. */
export interface StoppedRow {
  id: string;
  handle: string;
  name: string;
  avatar_version: number;
  since: Date;
}

/** The route's answer for the rows the query gave: its output shape, independent of the table (pinned by a test). */
export const stoppedShape = (rows: readonly StoppedRow[]): StoppedPerson[] =>
  rows.map((r) => ({ person: { id: r.id, handle: r.handle, displayName: r.name, avatarVersion: r.avatar_version }, since: r.since.toISOString() }));

/**
 * The one query for the stopped list, written against lane A's ruled table shape (075): `access_bars(setter_id, other_id, kind in
 * ('stop', 'block'), since)`, one row per (setter, other, kind). The caller's OWN `stop` rows only, newest first: not a block's row, not
 * a row somebody else set about them. Lane I confirms it against the real 075.
 */
async function readStopped(q: Queryable, ownerId: string): Promise<StoppedRow[]> {
  const { rows } = await q.query<StoppedRow>(
    `select p.id, p.handle::text as handle, p.display_name as name, p.avatar_version, b.since
       from access_bars b join principals p on p.id = b.other_id
      where b.setter_id = $1 and b.kind = 'stop'
      order by b.since desc, p.id`,
    [ownerId],
  );
  return rows;
}

/**
 * The people `ownerId` has stopped contact with and has not since resumed, newest first (`readStopped`). The table of bars is read only
 * where it exists, so a branch without lane A's schema never names a table it lacks; `SOCIAL.enabled` is what makes the caller ask.
 */
export async function stoppedOf(q: Queryable, ownerId: string): Promise<StoppedPerson[]> {
  const there = await q.query<{ here: boolean }>("select to_regclass('public.access_bars') is not null as here");
  if (!there.rows[0]!.here) return [];
  return stoppedShape(await readStopped(q, ownerId));
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
    // One snapshot (repeatable read, read only): the numbers and the day are read together.
    return onSnapshot(db, async (t) => {
      const agents = (await listOwnedAgents(t, me.id)).filter((a) => !a.deleted);
      const ids = agents.map((a) => a.id);
      // New owners are told nothing about a change they never had: only accounts whose row (made at their first Agent, metered reply or grant,
      // not at sign-up) is older than the moment 074 ran. `run_on` is a timestamp without zone that node-pg-migrate wrote with NOW() in its
      // session's zone; it is read here in the database's own TimeZone, so a changed default misplaces only the accounts made within that
      // offset's hours around the deploy. A missing `pgmigrations` row fails closed (no notice).
      const notice = await t.query<{ notice: boolean }>(
        `select $2::boolean and coalesce((select a.others_notice_seen_at is null and a.created_at < (select m.run_on from pgmigrations m where m.name = '074_others_step_l')
                                            from accounts a where a.principal_id = $1), false) as notice`,
        [me.id, agents.length > 0],
      );
      // One connection, one query at a time.
      const owner = await ownerNumbers(t, config, me.id);
      const used = await othersUsedToday(t, config, me.id, now);
      const perAgent = await othersUsedByAgents(t, config, me.id, ids, now);
      const byPerson = await othersByPerson(t, config, me.id, now);
      const usedPoints = used.settledMicro + used.heldMicro;
      const rows = [];
      const askable: boolean[] = [];
      for (const a of agents) {
        const u = perAgent.get(a.id) ?? { answers: 0, pointsMicro: 0n };
        const perDay = perDayEstimate(config, a.model, { owner, agent: { answers: a.othersAnswers, pointsMicro: a.othersBudgetMicro } });
        const room = await agentRoom(t, config, a, now);
        askable.push(room.askable);
        rows.push({ agentId: a.id, answers: u.answers, points: formatPoints(u.pointsMicro), perDay, reached: room.reached, tight: room.tight });
      }
      // The owner's two facts, over the Agents that could answer at all (one with no model answers nobody, whatever the room: its row shows
      // reached false, tight false, perDay 0, and it is left out): `reached` when the answers are used up or every such Agent is reached;
      // `tight` when any such Agent is. With none to ask, the numbers themselves.
      const asked = rows.filter((_, i) => askable[i]);
      const answersUp = used.answers >= owner.answers;
      const reached = answersUp || (asked.length > 0 ? asked.every((r) => r.reached) : usedPoints >= owner.pointsMicro);
      const tight = reached || asked.some((r) => r.tight);
      return {
        limits: { answers: owner.answers, points: formatPoints(owner.pointsMicro) },
        used: { answers: used.answers, points: formatPoints(usedPoints) },
        reached,
        tight,
        byPerson: byPerson.map((r) => ({ person: r.person, answers: r.answers, points: formatPoints(r.pointsMicro) })),
        // Read only while the site has Agent social on (never before lane A's schema), and then only where the table is.
        stopped: config.social.enabled ? await stoppedOf(t, me.id) : [],
        agents: rows,
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
