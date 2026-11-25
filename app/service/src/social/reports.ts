import type { EndedRuns } from "../agents/group-leave.ts";
import type { Config } from "../config.ts";
import type { Db, Queryable, Tx } from "../db.ts";
import { agentSeenSql } from "../principals/store.ts";
import { interruptOthersRuns } from "./agent-contacts.ts";

// Reports of an Agent, and the operator's two switches on one (plan A10; design §1.3). Reports reuse `agent_reports` (075, whose
// `target_kind` check admits a message-level report later by an additive migration). Nothing here reads a message: a report holds the
// reporter's own note (at most 500 characters) and a pointer to the social conversation they share with the Agent, if any; the
// operator's commands print ids and prefixes, never that note.

export const REPORT_REASONS = ["spam", "harassment", "privacy", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportOutcome = "disabled" | "dismissed";

/**
 * A report of the Agent `agentId` by `reporterId`: the id of the new row, or null when the Agent is not one the reporter can see
 * (`agentSeenSql`, the avatar rule: it is theirs, shares a conversation with them now, they block it, or it is discoverable to them;
 * never a deleted or disabled one for a stranger) or is no Agent, which the route answers as an Agent that is not there. The row
 * keeps the social conversation the reporter shares with the Agent, when they have one.
 */
export async function reportAgent(
  q: Queryable,
  config: Pick<Config, "social">,
  reporterId: string,
  agentId: string,
  reason: ReportReason,
  note: string | null,
): Promise<string | null> {
  // One open report per reporter and Agent (fix round 1, m7): reporting again while the first waits for the operator adds no row and is
  // answered with that report (its reason and note stay the first ones). Once it is handled, a new report is a new row.
  // (Only for an Agent the reporter can see now: for any other the answer stays the one of an Agent that is not there.)
  const openReport = () =>
    q.query<{ id: string }>(
    `select r.id from agent_reports r join principals p on p.id = r.agent_id
      where r.reporter_id = $1::uuid and r.agent_id = $2::uuid and r.handled_at is null and p.kind = 'agent' and ${agentSeenSql("p", "$1::uuid", config)}
      order by r.created_at limit 1`,
    [reporterId, agentId],
    );
  const open = await openReport();
  if (open.rows[0]) return open.rows[0].id;
  const { rows } = await q.query<{ id: string }>(
    `insert into agent_reports (reporter_id, target_kind, agent_id, conversation_id, reason, note)
     select $1::uuid, 'agent', p.id,
            (select sp.conversation_id from social_pairs sp where sp.a_id = least($1::uuid, p.id) and sp.b_id = greatest($1::uuid, p.id)),
            $3::text, $4::text
       from principals p
      where p.id = $2::uuid and p.kind = 'agent' and ${agentSeenSql("p", "$1::uuid", config)}
     on conflict (reporter_id, agent_id) where handled_at is null do update set reason = agent_reports.reason
     returning id`,
    [reporterId, agentId, reason, note],
  );
  // One statement decides and answers (fix round 3, point 9): the row it inserted, or the open report it met (`agent_reports_one_open_idx`,
  // migration 076; the conflict's own row, returned by the same statement, so nothing can close it between the meeting and the answer:
  // there is no second read). No row: the Agent is not one the reporter can see.
  return rows[0]?.id ?? null;
}

/** The id of the live (not deleted) Agent with this full handle, `<owner's handle>.<name part>`, case ignored; null for anything else. */
async function liveAgentByHandle(q: Queryable, handle: string): Promise<string | null> {
  const dot = handle.indexOf(".");
  if (dot < 1 || dot === handle.length - 1) return null;
  const { rows } = await q.query<{ id: string }>(
    `select p.id from principals o join principals p on p.owner_id = o.id and p.kind = 'agent' join agents a on a.principal_id = p.id and a.deleted_at is null
      where o.kind = 'human' and o.handle = $1 and p.handle = $2`,
    [handle.slice(0, dot), handle.slice(dot + 1)],
  );
  return rows[0]?.id ?? null;
}

/**
 * The operator disables an Agent: `disabled_at` is set (to non-owners it is `gone` everywhere: `reach` step 1, the lookup, the
 * discoverability of its avatar), and in the same transaction the replies others asked of it stop (`interruptOthersRuns`). Rows are
 * untouched. Again, it only stops what has started since. Null: no live Agent has that handle.
 */
export async function disableAgent(db: Db, handle: string): Promise<{ agentId: string; ended: EndedRuns } | null> {
  return db.tx(async (t) => {
    const id = await liveAgentByHandle(t, handle);
    if (id === null) return null;
    return { agentId: id, ended: await disableAgentIn(t, id) };
  });
}

/** The one path of a disable (`agent:disable` and `reports:close --outcome disabled`): `disabled_at`, and the replies others asked of it stop. */
async function disableAgentIn(t: Tx, agentId: string): Promise<EndedRuns> {
  await t.query("update agents set disabled_at = coalesce(disabled_at, now()) where principal_id = $1", [agentId]);
  return interruptOthersRuns(t, agentId);
}

/** The operator lifts the disable: `disabled_at` is null again, nothing else changes. Null: no live Agent has that handle. */
export async function enableAgent(db: Db, handle: string): Promise<{ agentId: string } | null> {
  const id = await liveAgentByHandle(db, handle);
  if (id === null) return null;
  await db.query("update agents set disabled_at = null where principal_id = $1", [id]);
  return { agentId: id };
}

export interface ReportLine {
  id: string;
  createdAt: Date;
  agentHandle: string;
  reporterId: string;
  reason: ReportReason;
  hasNote: boolean;
  hasConversation: boolean;
  outcome: ReportOutcome | null;
  handledAt: Date | null;
}

/** The reports, oldest first (`open`: only those not handled). Nothing the reporter wrote is returned but whether they wrote a note. */
export async function listReports(q: Queryable, o: { open: boolean }): Promise<ReportLine[]> {
  const { rows } = await q.query<{
    id: string;
    created_at: Date;
    handle: string;
    reporter_id: string;
    reason: ReportReason;
    has_note: boolean;
    has_conversation: boolean;
    outcome: ReportOutcome | null;
    handled_at: Date | null;
  }>(
    `select r.id, r.created_at, o.handle::text || '.' || a.handle::text as handle, r.reporter_id, r.reason, r.note is not null as has_note,
            r.conversation_id is not null as has_conversation, r.outcome, r.handled_at
       from agent_reports r join principals a on a.id = r.agent_id join principals o on o.id = a.owner_id
      where (not $1::boolean or r.handled_at is null)
      order by r.created_at, r.id`,
    [o.open],
  );
  return rows.map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    agentHandle: r.handle,
    reporterId: r.reporter_id,
    reason: r.reason,
    hasNote: r.has_note,
    hasConversation: r.has_conversation,
    outcome: r.outcome,
    handledAt: r.handled_at,
  }));
}

/** At least this many characters of a report's id name it (`reports:list` prints that many). */
export const REPORT_PREFIX_MIN = 8;

/**
 * Closes the report whose id starts with `prefix`, once. `closed` carries the full id; the others say why not. The outcome `disabled`
 * also disables the report's Agent, in the same transaction and by the same path as `agent:disable` (A-4 review m1: an outcome that
 * only records would be a trap); `disabled` then carries what stopped (none when the Agent is deleted already: it is gone).
 */
export async function closeReport(
  db: Db,
  prefix: string,
  outcome: ReportOutcome,
): Promise<{ closed: string; disabled?: { agentId: string; ended: EndedRuns } } | { refused: "short" | "not_found" | "ambiguous" | "already" }> {
  const p = prefix.toLowerCase();
  if (!/^[0-9a-f-]+$/.test(p) || p.replace(/-/g, "").length < REPORT_PREFIX_MIN) return { refused: "short" };
  return db.tx(async (t) => {
    const { rows } = await t.query<{ id: string; handled_at: Date | null; agent_id: string }>("select id, handled_at, agent_id from agent_reports where id::text like $1 || '%' order by id for update", [p]);
    if (rows.length === 0) return { refused: "not_found" as const };
    if (rows.length > 1) return { refused: "ambiguous" as const };
    if (rows[0]!.handled_at !== null) return { refused: "already" as const };
    await t.query("update agent_reports set handled_at = now(), outcome = $2 where id = $1", [rows[0]!.id, outcome]);
    if (outcome !== "disabled") return { closed: rows[0]!.id };
    const live = await t.query("select 1 from agents where principal_id = $1 and deleted_at is null", [rows[0]!.agent_id]);
    return (live.rowCount ?? 0) === 0
      ? { closed: rows[0]!.id }
      : { closed: rows[0]!.id, disabled: { agentId: rows[0]!.agent_id, ended: await disableAgentIn(t, rows[0]!.agent_id) } };
  });
}
