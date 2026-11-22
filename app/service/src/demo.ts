// The account App Review signs in with (`demo:seed`, README "Commands", Demo account): made the first time, put back the
// next times. Everything it makes is listed in `demo_principals` (migration 071): the command never touches a principal that
// is not there, and stops when the e-mail or a handle it needs belongs to anyone else.
import { MICRO_PER_POINT } from "./accounts/store.ts";
import { lockAccountEmail } from "./auth/accounts.ts";
import { runInTransaction, type Auth } from "./auth/auth.ts";
import type { Config } from "./config.ts";
import { addMember, createGroup } from "./conversations/groups.ts";
import { currentMemberIds, ensureDirect } from "./conversations/store.ts";
import type { Db, Tx } from "./db.ts";
import { createAgent } from "./agents/conversation.ts";
import { listOwnedAgents, lockAgent, setAgentState, type AgentModel } from "./agents/store.ts";
import { recordAcceptance } from "./legal.ts";
import { sendMessage } from "./messages/send.ts";
import { HANDLE_PATTERN } from "./principals/store.ts";
import { orderedPair } from "./social/pair.ts";

/** The reviewer's account unless the operator names others (`--handle`, `--name`). */
export const DEMO_DEFAULTS = { handle: "app_review", name: "Reviewer" } as const;

/** The two people the reviewer is seated with. They have no password: nobody can sign in as them. */
const MEMBERS = [
  { handle: "demo_mika", name: "Mika", email: "demo-mika@demo.invalid" },
  { handle: "demo_ren", name: "Ren", email: "demo-ren@demo.invalid" },
] as const;

const GROUP_TITLE = "Weekend plans";

/** The reviewer's Agent: a persona its owner wrote, a site model. It says nothing until someone talks to it (principle P2). */
const AGENT = {
  namePart: "mochi",
  name: "Mochi",
  intro: "Helps the group plan outings",
  persona:
    "You are Mochi, a cheerful helper in a small group of friends. You help them plan outings and suggest ideas. " +
    "Keep replies short and friendly.",
};

/** What the two people said in the group before the reviewer came: harmless, made up, by people (never as the Agent). */
const SEEDED: ReadonlyArray<{ by: 0 | 1; text: string }> = [
  { by: 0, text: "Welcome to the group! Mika and Ren here." },
  { by: 1, text: "We use this group to plan weekend outings together." },
  { by: 0, text: "How about a picnic in the park on Saturday? I can bring sandwiches." },
  { by: 1, text: "Sounds good. I'll bring fruit and a blanket." },
  { by: 0, text: "If you want ideas, ask Mochi, our Agent: mention it with @ in a message." },
];

/** Why the command stopped without changing anything (printed to the operator, with no secret in it). */
export class DemoRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoRefused";
  }
}

export interface DemoInput {
  email: string;
  /** From the operator (DEMO_PASSWORD or a prompt); never printed, never stored but hashed. */
  password: string;
  handle?: string;
  name?: string;
}

export interface DemoResult {
  /** False when the account was there already and was put back. */
  created: boolean;
  email: string;
  handle: string;
  agentHandle: string;
  /** The model the Agent replies with, or null when the site has none (it then cannot reply). */
  model: string | null;
  groupTitle: string;
}

/** A free site model if there is one, else the first; null when the site has none. */
function demoModel(config: Pick<Config, "siteModels">): AgentModel {
  const chosen = config.siteModels.find((m) => m.tier === "free") ?? config.siteModels[0];
  return chosen ? { source: "site", id: chosen.id } : null;
}

/** The principal of `handle` (a person) and whether it is the command's own, with that role. */
async function personByHandle(t: Tx, handle: string): Promise<{ id: string; role: string | null } | null> {
  const { rows } = await t.query<{ id: string; role: string | null }>(
    `select p.id, d.role from principals p left join demo_principals d on d.principal_id = p.id
      where p.kind = 'human' and p.handle = $1`,
    [handle],
  );
  return rows[0] ?? null;
}

async function reservedByOther(t: Tx, handle: string, principalId: string | null): Promise<boolean> {
  const { rows } = await t.query<{ principal_id: string }>("select principal_id from reserved_handles where handle = $1", [handle]);
  return rows.some((r) => r.principal_id !== principalId);
}

/**
 * Makes the demo account, or puts it back: one transaction (Better Auth's writes join it), so a refusal or a failure leaves
 * nothing behind. Put back means: the password the operator gave, the e-mail verified, every session of it ended, the
 * documents in force accepted with the 18+ declaration, its Agent there and not paused, friends with the two people, and a
 * group of the four with what the two people said. What a reviewer added (messages, other groups, other Agents) stays.
 */
export async function seedDemo(db: Db, config: Config, auth: Auth, input: DemoInput): Promise<DemoResult> {
  const email = input.email.trim().toLowerCase();
  const handle = input.handle ?? DEMO_DEFAULTS.handle;
  const name = input.name ?? DEMO_DEFAULTS.name;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new DemoRefused("--email must be an e-mail address");
  if (!HANDLE_PATTERN.test(handle)) throw new DemoRefused("--handle must be 3 to 24 lower-case letters, digits or _");
  if (!name.trim() || [...name].length > 40) throw new DemoRefused("--name must be 1 to 40 characters");
  if (input.password.length < 10 || input.password.length > 128) throw new DemoRefused("the password must be 10 to 128 characters");
  const ctx = await auth.$context;

  return db.tx(async (t) => {
    await lockAccountEmail(t, email);
    // The reviewer: by e-mail and by handle, the same principal of ours, or nobody.
    const byEmail = await t.query<{ userId: string; principalId: string | null; role: string | null }>(
      `select u.id as "userId", p.id as "principalId", d.role
         from "user" u left join principals p on p.auth_user_id = u.id left join demo_principals d on d.principal_id = p.id
        where u.email = $1`,
      [email],
    );
    const known = byEmail.rows[0] ?? null;
    if (known && (known.principalId === null || known.role !== "reviewer")) {
      throw new DemoRefused(`${email} belongs to an account that is not the demo account; nothing was changed`);
    }
    const holder = await personByHandle(t, handle);
    if (holder && holder.id !== known?.principalId) throw new DemoRefused(`the handle ${handle} belongs to someone else; nothing was changed`);
    if (await reservedByOther(t, handle, known?.principalId ?? null)) throw new DemoRefused(`the handle ${handle} was given up by someone; choose another`);

    const hash = await ctx.password.hash(input.password);
    let reviewerId: string;
    if (known) {
      reviewerId = known.principalId!;
      await runInTransaction(t, () => ctx.internalAdapter.updatePassword(known.userId, hash));
      await t.query(`update "user" set "emailVerified" = true where id = $1`, [known.userId]);
      // Whoever signed in with it before (an earlier review) is signed out.
      await t.query(`delete from "session" where "userId" = $1`, [known.userId]);
      await t.query("update principals set display_name = $2 where id = $1", [reviewerId, name]);
    } else {
      const user = await runInTransaction(t, () => ctx.internalAdapter.createUser({ email, name, emailVerified: true }, { method: "admin" }));
      await runInTransaction(t, () => ctx.internalAdapter.linkAccount({ userId: user.id, providerId: "credential", accountId: user.id, password: hash }));
      const { rows } = await t.query<{ id: string }>(
        "insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1, $2, $3) returning id",
        [handle, name, user.id],
      );
      reviewerId = rows[0]!.id;
      await t.query("insert into demo_principals (principal_id, role) values ($1, 'reviewer')", [reviewerId]);
    }
    await recordAcceptance(t, reviewerId);

    // The two people: ours, or made now (a user without a password: nobody signs in as them).
    const memberIds: string[] = [];
    for (const m of MEMBERS) {
      const found = await personByHandle(t, m.handle);
      if (found && found.role !== "member") throw new DemoRefused(`the handle ${m.handle} belongs to someone else; nothing was changed`);
      if (found) {
        memberIds.push(found.id);
        continue;
      }
      if (await reservedByOther(t, m.handle, null)) throw new DemoRefused(`the handle ${m.handle} was given up by someone; nothing was changed`);
      const user = await runInTransaction(t, () => ctx.internalAdapter.createUser({ email: m.email, name: m.name, emailVerified: true }, { method: "admin" }));
      const { rows } = await t.query<{ id: string }>(
        "insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1, $2, $3) returning id",
        [m.handle, m.name, user.id],
      );
      await t.query("insert into demo_principals (principal_id, role) values ($1, 'member')", [rows[0]!.id]);
      memberIds.push(rows[0]!.id);
    }

    // Friends with both, as an accepted request leaves them (a block or an unfriending of a review is undone).
    for (const memberId of memberIds) {
      const [lo, hi] = orderedPair(reviewerId, memberId);
      await t.query("delete from blocks where (blocker_id = $1 and blocked_id = $2) or (blocker_id = $2 and blocked_id = $1)", [reviewerId, memberId]);
      await t.query("insert into friendships (a_id, b_id) values ($1, $2) on conflict do nothing", [lo, hi]);
      await ensureDirect(t, memberId, reviewerId, reviewerId);
    }

    // Its Agent: the one it has (put back if paused), or a new one (also after a review deleted it).
    const model = demoModel(config);
    let agent = (await listOwnedAgents(t, reviewerId)).find((a) => a.namePart === AGENT.namePart && !a.deleted) ?? null;
    if (agent?.paused) await setAgentState(t, await lockAgent(t, agent.id), { paused: false });
    if (!agent) {
      const made = await createAgent(
        t,
        reviewerId,
        {
          ...AGENT,
          field: "",
          replyMode: "always",
          groupMentions: "members",
          chainBudgetMicro: 50n * MICRO_PER_POINT,
          othersBudgetMicro: 20n * MICRO_PER_POINT,
          proactive: false,
          proactiveLevel: "normal",
          proactiveBudgetMicro: 20n * MICRO_PER_POINT,
          memory: true,
          memoryAsk: false,
          sharedNotes: true,
          whisperElsewhere: true,
          ownerAppellation: null,
          reasoning: "none",
          model,
        },
        config,
        false,
      );
      agent = made.agent;
    }

    // The group: the one it made where all four still are, or a new one (also after a review left it).
    const groups = await t.query<{ id: string }>(
      "select id from conversations where type = 'group' and creator_id = $1 and title = $2 and closed_at is null order by created_at",
      [reviewerId, GROUP_TITLE],
    );
    let groupId: string | null = null;
    for (const g of groups.rows) {
      const members = new Set(await currentMemberIds(t, g.id));
      if ([reviewerId, ...memberIds].every((id) => members.has(id))) {
        groupId = g.id;
        break;
      }
    }
    if (groupId === null) groupId = (await createGroup(t, reviewerId, GROUP_TITLE, memberIds)).conversationId;
    if (!(await currentMemberIds(t, groupId)).includes(agent.id)) await addMember(t, groupId, reviewerId, agent.id);
    // What the two people said, once: a message already there under its key is not sent again.
    for (const [i, line] of SEEDED.entries()) {
      await sendMessage(t, groupId, memberIds[line.by]!, { text: line.text, clientTxn: `demo-seed-${i + 1}` });
    }

    return {
      created: known === null,
      email,
      handle,
      agentHandle: agent.handle,
      model: model === null ? null : model.source === "site" ? model.id : null,
      groupTitle: GROUP_TITLE,
    };
  });
}
