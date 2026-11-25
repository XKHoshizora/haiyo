import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";
import { blockedEitherWay } from "./relations.ts";

// Whether one party may reach an Agent: the read-only leaf of Agent social (plan D2), in the pattern of `relations.ts`, so that
// `conversations/store.ts` can ask it without importing the mutations in `agent-contacts.ts` (which write into conversations).
//
// THE rule (design §1.2; plan A1; D3; Controller ruling 2026-11-24 (attack, I8)). P is the subject when it is a person, else the
// subject's owner; O is the Agent's owner. In order:
//   1. the Agent is deleted (or is no Agent) -> gone; disabled, or (social and the switch off), with P not O -> gone;
//   2. P is O -> ok;
//   3. a block either way between P and O, P and the Agent, the subject and the Agent, or the subject and O -> blocked;
//   4. a bar between P and O (either one's: any row of `access_bars` either way) -> barred, unless the subject's own row on the Agent is
//      live, approved and newer than the latest bar;
//   5. the subject's own row: live -> ok; in a social conversation, ended narrowed, removed or barred -> barred;
//   6. otherwise group -> ok, social -> no_access. In a GROUP only what stands now refuses (steps 1, 3 and 4): access there comes from
//      membership, so a row that ended (by a narrowing, a removal, or a stop since lifted) refuses nobody, and a co-member is answered
//      again the moment a stop is lifted, without adding again (Controller ruling, fix round 2, N2); adding again is for the social
//      conversation only. An Agent subject is judged on its own row only: a person's row never grants
//      their Agent.
// The switch off refuses only social (D3): a group runs as it always did unless the Agent is deleted or disabled.

export type Reach = "ok" | "gone" | "blocked" | "barred" | "no_access";
export type ReachWhere = "group" | "social";

interface ReachSqlOptions {
  /** SQL expressions: the principal asking (a person, or an Agent), and the Agent asked. */
  subject: string;
  agent: string;
  where: ReachWhere;
  /** A SQL boolean: the site's Agent social switch. */
  socialOn: string;
}

/**
 * SQL (`access_bars <alias> where …`, to follow `from`): the bars that stand between persons `p` and `o` (SQL expressions): a row
 * in either direction. A `block` row stands only while its block does (a row left behind by an unblock an older process served
 * bars nobody: the table heals on read, A-3 review m4); a `stop` row stands until its setter lifts it. The one definition: `reachSql`
 * and the add flow both read bars through it.
 */
export const standingBarsSql = (p: string, o: string, alias: string): string =>
  `access_bars ${alias} where ((${alias}.setter_id = ${p} and ${alias}.other_id = ${o}) or (${alias}.setter_id = ${o} and ${alias}.other_id = ${p}))
     and (${alias}.kind = 'stop' or exists (select 1 from blocks ${alias}l where ${alias}l.blocker_id = ${alias}.setter_id and ${alias}l.blocked_id = ${alias}.other_id))`;

/**
 * SQL text for an expression evaluating to one of `Reach`'s values; `subject` and `agent` are SQL expressions (a parameter
 * with its cast, a column), `socialOn` a SQL boolean. THE statement of the rule: `reach` runs this one, and every query that asks
 * it of many rows at once splices it in (`refusedSql`). Its inner aliases all start `rch`, so that an expression of the caller's
 * (`s.id`) is never shadowed.
 */
export function reachSql(o: ReachSqlOptions): string {
  const S = o.subject;
  const A = o.agent;
  const O = `(select rcho.owner_id from principals rcho where rcho.id = ${A})`;
  // The person behind the subject: an Agent's owner, or the subject itself.
  const P = `coalesce((select rchs.owner_id from principals rchs where rchs.id = ${S}), ${S})`;
  const own = (cond: string): string => `exists (select 1 from agent_contacts rchc where rchc.agent_id = ${A} and rchc.subject_id = ${S} and ${cond})`;
  // Barred while any bar stands between P and O, either way, unless the subject's own row is live, approved and newer than the
  // latest of them (an approval passes the bars, and only that row).
  const lastBar = `(select max(rchb.since) from ${standingBarsSql(P, O, "rchb")})`;
  const bar = `(${lastBar} is not null and not exists (select 1 from agent_contacts rchc
                                           where rchc.agent_id = ${A} and rchc.subject_id = ${S} and rchc.state = 'live' and rchc.basis = 'approved' and rchc.since > ${lastBar}))`;
  const unavailable = o.where === "social" ? `rcha.disabled_at is not null or not (${o.socialOn})` : `rcha.disabled_at is not null`;
  return `(case
    when coalesce((select rcha.deleted_at is not null from agents rcha where rcha.principal_id = ${A}), true) then 'gone'
    when ${P} is distinct from ${O} and coalesce((select ${unavailable} from agents rcha where rcha.principal_id = ${A}), true) then 'gone'
    when ${P} = ${O} then 'ok'
    when ${blockedEitherWay(P, `${O}, ${A}`)} or ${blockedEitherWay(S, `${A}, ${O}`)} then 'blocked'
    when ${bar} then 'barred'
    when ${own("rchc.state = 'live'")} then 'ok'
    ${o.where === "group" ? "" : `when ${own("rchc.state = 'ended' and rchc.end_reason in ('narrowed', 'removed', 'barred')")} then 'barred'`}
    else '${o.where === "group" ? "ok" : "no_access"}' end)`;
}

/** SQL boolean: the subject is refused (`reachSql` is anything but `ok`). */
export const refusedSql = (o: Parameters<typeof reachSql>[0]): string => `((${reachSql(o)}) <> 'ok')`;

/** Whether `subjectId` may reach `agentId` in a group or in a social conversation: one query, the one `reachSql` states. */
export async function reach(q: Queryable, subjectId: string, agentId: string, where: ReachWhere, config: Pick<Config, "social">): Promise<Reach> {
  const { rows } = await q.query<{ r: Reach }>(
    `select ${reachSql({ subject: "$1::uuid", agent: "$2::uuid", where, socialOn: config.social.enabled ? "true" : "false" })} as r`,
    [subjectId, agentId],
  );
  return rows[0]!.r;
}

/**
 * SQL boolean: the Agent `agent` may be found by `viewer` (a lookup, an avatar): it is not deleted or disabled, it takes contacts
 * (`contact_policy` is not `none`), no block lies either way between the viewer and its owner or between the viewer and the Agent,
 * the switch is on, and the viewer is not its owner. Never a word of why not: every caller answers a "no" as it answers an
 * unknown handle.
 */
export function discoverableSql(o: { agent: string; viewer: string; socialOn: string }): string {
  return `(${o.socialOn} and exists (select 1 from agents rchd join principals rchp on rchp.id = rchd.principal_id
            where rchd.principal_id = ${o.agent} and rchd.deleted_at is null and rchd.disabled_at is null and rchd.contact_policy <> 'none'
              and rchp.owner_id <> ${o.viewer}
              and not ${blockedEitherWay(o.viewer, "rchp.owner_id, rchp.id")}))`;
}

/** Whether one Agent may be found by one viewer: what `discoverableSql` says of them. */
export async function discoverable(q: Queryable, agentId: string, viewerId: string, config: Pick<Config, "social">): Promise<boolean> {
  const { rows } = await q.query<{ d: boolean }>(
    `select ${discoverableSql({ agent: "$1::uuid", viewer: "$2::uuid", socialOn: config.social.enabled ? "true" : "false" })} as d`,
    [agentId, viewerId],
  );
  return rows[0]!.d;
}
