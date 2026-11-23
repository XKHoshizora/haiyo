import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";
import { blockedEitherWay } from "./relations.ts";

// Whether one party may reach an Agent: the read-only leaf of Agent social (plan D2), in the pattern of `relations.ts`, so that
// `conversations/store.ts` can ask it without importing the mutations in `agent-contacts.ts` (which write into conversations).
//
// STEP 0 keeps today's rule only. Lane A (A1) replaces the bodies with the full order and keeps every signature:
//   group  - `blocked` when a block lies, either way, between the Agent's owner and the person behind the subject; else `ok`.
//   social - `ok` for the Agent's owner and for a subject with a `live` row in `agent_contacts`; else `no_access`.
// `gone`, `barred` and the switch (`config.social.enabled`) are lane A's.

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
 * SQL text for an expression evaluating to one of `Reach`'s values; `subject` and `agent` are SQL expressions (a parameter
 * with its cast, a column), `socialOn` a SQL boolean. THE statement of the rule: `reach` runs this one, and every query that asks
 * it of many rows at once splices it in (`refusedSql`).
 */
export function reachSql(o: ReachSqlOptions): string {
  const ownerOfAgent = `(select ag.owner_id from principals ag where ag.id = ${o.agent})`;
  if (o.where === "group") {
    // The person behind the subject: an Agent's owner, or the subject itself.
    const person = `coalesce((select s.owner_id from principals s where s.id = ${o.subject}), ${o.subject})`;
    return `(case when ${blockedEitherWay(person, ownerOfAgent)} then 'blocked' else 'ok' end)`;
  }
  return `(case when ${ownerOfAgent} = ${o.subject} then 'ok'
                when exists (select 1 from agent_contacts ac where ac.agent_id = ${o.agent} and ac.subject_id = ${o.subject} and ac.state = 'live') then 'ok'
                else 'no_access' end)`;
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

/** SQL boolean: the Agent `agent` may be found by `viewer` (a lookup, an avatar). Step 0: never; lane A's A2 and A1 give the rule. */
export function discoverableSql(_o: { agent: string; viewer: string; socialOn: string }): string {
  return "(false)";
}

/** Whether one Agent may be found by one viewer: what `discoverableSql` says of them. Step 0: never, and no query to make. */
export async function discoverable(_q: Queryable, _agentId: string, _viewerId: string, _config: Pick<Config, "social">): Promise<boolean> {
  return false;
}
