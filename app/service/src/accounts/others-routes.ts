import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { listOwnedAgents } from "../agents/store.ts";
import { onSnapshot, type Queryable } from "../db.ts";
import { perPrincipalLimit } from "../limits.ts";
import { OWN_KEY_NOMINAL_MICRO, othersByPerson, othersLimitOf, othersUseToday } from "../metering/others.ts";
import { requirePrincipal } from "../session.ts";
import { ensureAccount, formatPoints, MICRO_PER_POINT, pointsBetween } from "./store.ts";

// Lane B's route plugin (README "Agent social", One number): what others' use of an owner's Agents has used today against the owner's
// one number (one value per owner whatever the number of Agents: metering/others.ts), and the owner's say over it. Unlike lane A's,
// these are live whatever `SOCIAL.enabled` says (step L).

/** The owner's number as a request gives it: a decimal string of points, 1 to 100 000 (as an Agent's `chainBudget`). */
const pointsNumber = pointsBetween(MICRO_PER_POINT, 100_000n * MICRO_PER_POINT);

const person = z.object({ id: z.string(), handle: z.string(), displayName: z.string(), avatarVersion: z.number() });
const useResponse = z.object({
  limit: z.string(),
  used: z.string(),
  proactive: z.string(),
  ownKeyPoints: z.string(),
  reached: z.boolean(),
  byPerson: z.array(z.object({ person, points: z.string() })),
  stopped: z.array(z.object({ person, since: z.string() })),
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
 * The one query for the stopped list, over migration 075's `access_bars(setter_id, other_id, kind in ('stop', 'block'), since)`, one
 * row per (setter, other, kind). The caller's OWN `stop` rows only, newest first: not a block's row, not a row somebody else set about
 * them. (No list or page ever shows a person that someone stopped them. One answer does let them infer it, by design: adding an Agent of
 * someone who stopped them is refused with the day they may ask again, `cooldown`, plan I11.)
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

/** The people `ownerId` has stopped contact with and has not since resumed, newest first (`readStopped`); `SOCIAL.enabled` is what makes the caller ask. */
export const stoppedOf = async (q: Queryable, ownerId: string): Promise<StoppedPerson[]> => stoppedShape(await readStopped(q, ownerId));

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
    // One snapshot (repeatable read, read only): the number and the day are read together.
    return onSnapshot(db, async (t) => {
      const agents = (await listOwnedAgents(t, me.id)).filter((a) => !a.deleted);
      // New owners are told nothing about a change they never had: only accounts whose row (made at their first Agent, metered reply or grant,
      // not at sign-up) is older than the moment 074 ran. `run_on` is a timestamp without zone that node-pg-migrate wrote with NOW() in its
      // session's zone; it is read here in the database's own TimeZone, so a changed default misplaces only the accounts made within that
      // offset's hours around the deploy. A missing `pgmigrations` row fails closed (no notice).
      const notice = await t.query<{ notice: boolean }>(
        // (And only an owner who had an Agent then: an account a grant made, whose first Agent came after the change, never had what changed.)
        `select $2::boolean and coalesce((select a.others_notice_seen_at is null and a.created_at < m.run_on
                                                 and exists (select 1 from agents ag join principals ap on ap.id = ag.principal_id
                                                              where ap.owner_id = $1 and ag.deleted_at is null and ag.created_at < m.run_on)
                                            from accounts a, (select run_on from pgmigrations where name = '074_others_step_l') m where a.principal_id = $1), false) as notice`,
        [me.id, agents.length > 0],
      );
      // One connection, one query at a time. The one measure admission decides by (metering/others.ts `othersUseToday`): `reached`
      // is exactly what refuses the next reply for others.
      const limit = await othersLimitOf(t, config, me.id);
      const used = await othersUseToday(t, config, me.id, now);
      // Of it, what the Agents' proactive replies used (no caller: in the total and in no person's row).
      const proactive = await othersUseToday(t, config, me.id, now, "proactive");
      const byPerson = await othersByPerson(t, config, me.id, now);
      return {
        limit: formatPoints(limit),
        used: formatPoints(used),
        proactive: formatPoints(proactive),
        ownKeyPoints: formatPoints(OWN_KEY_NOMINAL_MICRO),
        reached: used >= limit,
        byPerson: byPerson.map((r) => ({ person: r.person, points: formatPoints(r.pointsMicro) })),
        // The caller's own stops, whatever the switch says (fix round 1, I4): a stop made while it was on keeps refusing in groups while it
        // is off, so its setter must still see it and be able to lift it. With the switch off no new stop can be made, so the list is
        // empty for everyone who never made one.
        stopped: await stoppedOf(t, me.id),
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
        body: z.strictObject({ points: pointsNumber }),
        response: { 200: z.object({ points: z.string() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const { points } = req.body;
      await db.tx(async (t) => {
        await ensureAccount(t, me.id);
        await t.query("update accounts set others_points_micro = $2 where principal_id = $1", [me.id, points.toString()]);
      });
      return { points: formatPoints(points) };
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
