import type { Config } from "../config.ts";
import type { Queryable } from "../db.ts";
import { discoverableSql } from "../social/reach.ts";
import {
  AGENT_CARD_COLUMNS,
  AGENT_HANDLE_PATTERN,
  agentCardOf,
  findAgentByHandle,
  findByHandle,
  handleOf,
  HANDLE_PATTERN,
  type AgentCard,
  type AgentCardRow,
  type PublicPrincipal,
} from "./store.ts";

// Finding someone's Agent (find-agent design; rulings R1–R3, D1, D4–D8; fix round 1). Who can be listed to a person has two sources
// and no third: their circle — friends, friends' Agents, Agents in a group with them now, Agents they added — matched by any fragment
// of a name; and one exact person handle — that person, and their Agents. Every Agent passes `discoverableSql` for the caller, inside
// the query that finds it, before anything is ordered, counted or cut: a hidden Agent is answered exactly as one that does not exist.
// Every Agent is answered as the lookup's card (`AgentCard`, field included: fix round 1, F4).

/** Why an Agent is in the caller's circle, the first that holds: its owner is their friend, it is in a group with them, they added it. */
export type CircleVia = "friend" | "group" | "contact";
/** One of the circle: a friend (a person's public profile), or an Agent's card and why it is there. */
export type CircleEntry = PublicPrincipal | (AgentCard & { via: CircleVia });
/** The explicit step: a person and their Agents, an Agent by its full handle, or nobody. */
export type ExactMatch = { person: PublicPrincipal; agents: AgentCard[] } | { agent: AgentCard } | null;

/** The most the circle lists. */
export const CIRCLE_MAX = 20;

const VIA: Record<number, CircleVia> = { 1: "friend", 2: "group", 3: "contact" };

const socialOn = (config: Pick<Config, "social">): string => (config.social.enabled ? "true" : "false");

/** SQL: what a card's columns (`AGENT_CARD_COLUMNS`) are read from, Agent `ag` first. */
const CARD_FROM = "principals ag join principals o on o.id = ag.owner_id join agents a on a.principal_id = ag.id";

/**
 * Agent `agentId`'s card when it is discoverable to `viewerId` (D1: a tap on a group's member, a share link); null for every other
 * id alike — no such principal, a person, a hidden Agent, the viewer's own, and null itself (what the route passes for a string that
 * is no id: the same one statement as a missing id, F5).
 */
export async function findAgentCard(q: Queryable, agentId: string | null, viewerId: string, config: Pick<Config, "social">): Promise<AgentCard | null> {
  const { rows } = await q.query<AgentCardRow>(
    `select ${AGENT_CARD_COLUMNS} from ${CARD_FROM}
      where ag.id = $1::uuid and ag.kind = 'agent' and ${discoverableSql({ agent: "ag.id", viewer: "$2::uuid", socialOn: socialOn(config) })}`,
    [agentId, viewerId],
  );
  return rows[0] ? agentCardOf(rows[0]) : null;
}

/**
 * The most Agents one person's list holds (D7): what the largest tier lets an account own (`AGENT_TIERS`), so every Agent of a
 * person is listed (no pages) unless the configuration was lowered under what they already own. Deliberately not the owner's own
 * tier (fix round 1, F3, rejected): an owner moved to a smaller tier keeps the Agents they have, and a cut at the new number would
 * hide some of them, silently — the one thing D7 rules out.
 */
export const personAgentsMax = (config: Pick<Config, "agentTiers">): number => Math.max(1, ...Object.values(config.agentTiers));

/** Person `ownerId`'s Agents that are discoverable to `viewerId`, by name: filtered in the statement, before its order and its limit. */
async function personAgents(q: Queryable, ownerId: string, viewerId: string, config: Pick<Config, "social" | "agentTiers">): Promise<AgentCard[]> {
  const { rows } = await q.query<AgentCardRow>(
    `select ${AGENT_CARD_COLUMNS} from ${CARD_FROM}
      where ag.owner_id = $1 and ag.kind = 'agent' and ${discoverableSql({ agent: "ag.id", viewer: "$2::uuid", socialOn: socialOn(config) })}
      order by ag.display_name, ag.id
      limit $3`,
    [ownerId, viewerId, personAgentsMax(config)],
  );
  return rows.map(agentCardOf);
}

/**
 * The explicit step (D6), `term` as the route leaves it (trimmed, a leading `@` dropped), case ignored: a person's handle is that
 * person (as `GET /api/principals/lookup` answers them, also one who blocks or is blocked: then no Agent) and all their Agents
 * discoverable to the viewer (R2, D7); an Agent's full handle is the lookup's own answer (`findAgentByHandle`); anything else — no
 * such handle, one given up, no handle's shape — is null. `q` is the caller's snapshot (F1): the person and their Agents are read in it.
 */
export async function exactMatch(q: Queryable, viewerId: string, term: string, config: Pick<Config, "social" | "agentTiers">): Promise<ExactMatch> {
  const handle = term.toLowerCase();
  if (HANDLE_PATTERN.test(handle)) {
    const person = await findByHandle(q, handle);
    return person ? { person, agents: await personAgents(q, person.id, viewerId, config) } : null;
  }
  if (!AGENT_HANDLE_PATTERN.test(handle)) return null;
  const agent = await findAgentByHandle(q, handle, viewerId, config);
  return agent ? { agent } : null;
}

/**
 * The caller's circle (D4, D8) whose name holds `term` (a non-empty fragment, case ignored, every character itself: no wildcard):
 * a person by display name or handle; an Agent by its name, its full handle (its name part and its owner's handle in it) or its
 * owner's display name. Its sources, exactly: their current friends — people only: a friendship row is the schema's to hold
 * between any two principals, and one that names an Agent makes no friend of it (F2) —; the Agents of those friends; the Agents
 * that are current members of a GROUP the caller is a current member of (no social conversation, no past member); the Agents with
 * a row whose subject is the caller. One statement: the relationship rows first (each through its index), their ids deduplicated
 * (each keeps its first source), then each one's name matched and each Agent's discoverability asked (in whichever order the
 * planner picks), and only then the order — people, friends' Agents, group Agents, contacts, each by name — and the cut at
 * `CIRCLE_MAX`. Its work is bounded by the caller's own relationships, not by the site (D8: 500 friends with 5 Agents each and 50
 * groups, about 30 ms).
 */
export async function circleOf(q: Queryable, viewerId: string, term: string, config: Pick<Config, "social">): Promise<CircleEntry[]> {
  const { rows } = await q.query<Omit<AgentCardRow, "owner_id" | "owner_name" | "intro" | "field"> & {
    rank: number;
    owner_id: string | null;
    owner_name: string | null;
    intro: string | null;
    field: string | null;
  }>(
    `with friends as (
       select fp.id from (
         select f.b_id as id from friendships f where f.a_id = $1
         union all
         select f.a_id from friendships f where f.b_id = $1
       ) fs join principals fp on fp.id = fs.id and fp.kind = 'human'
     ),
     candidates as (
       select src.id, min(src.rank) as rank from (
         select fr.id, 0 as rank from friends fr
         union all
         select ag.id, 1 from friends fr join principals ag on ag.owner_id = fr.id and ag.kind = 'agent'
         union all
         select them.principal_id, 2
           from memberships mine
           join conversations c on c.id = mine.conversation_id and c.type = 'group'
           join memberships them on them.conversation_id = mine.conversation_id and them.left_seq is null
           join principals ag on ag.id = them.principal_id and ag.kind = 'agent'
          where mine.principal_id = $1 and mine.left_seq is null
         union all
         select ac.agent_id, 3 from agent_contacts ac where ac.person_id = $1 and ac.subject_id = $1
       ) src
       group by src.id
     ),
     named as (
       select c.id, c.rank, ${handleOf("p")} as handle, p.display_name, p.avatar_version, p.owner_id, o.display_name as owner_name, a.intro, a.field
         from candidates c
         join principals p on p.id = c.id
         left join principals o on o.id = p.owner_id
         left join agents a on a.principal_id = p.id
     )
     select n.* from named n
      where (strpos(lower(n.display_name), lower($2::text)) > 0 or strpos(lower(n.handle), lower($2::text)) > 0
             or strpos(lower(coalesce(n.owner_name, '')), lower($2::text)) > 0)
        and (n.rank = 0 or ${discoverableSql({ agent: "n.id", viewer: "$1::uuid", socialOn: socialOn(config) })})
      order by n.rank, n.display_name, n.id
      limit ${CIRCLE_MAX}`,
    [viewerId, term],
  );
  return rows.map((r): CircleEntry => {
    if (r.rank === 0) return { id: r.id, handle: r.handle, displayName: r.display_name, avatarVersion: r.avatar_version };
    return { ...agentCardOf({ ...r, owner_id: r.owner_id!, owner_name: r.owner_name!, intro: r.intro!, field: r.field! }), via: VIA[r.rank]! };
  });
}
