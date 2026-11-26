import { describe, expect, it, vi } from "vitest";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * Fix round 2, R1: a transaction that locks more than one owner's account (for the owner's number, the owner's minute) takes them in
 * ascending account id — the one order every such path keeps, so two of them can never wait on each other. Read where it is decided:
 * every `lockAccount` of the transaction, in the order they are asked for.
 */
const locked = vi.hoisted(() => ({ on: false, ids: [] as string[] }));
vi.mock("../src/accounts/store.ts", async (original) => {
  const real = await original<typeof import("../src/accounts/store.ts")>();
  return {
    ...real,
    lockAccount: (t: Parameters<typeof real.lockAccount>[0], ownerId: string) => {
      if (locked.on) locked.ids.push(ownerId);
      return real.lockAccount(t, ownerId);
    },
  };
});

const { app, db } = useApp({ env: SITE_ENV, agentWorker: false });
const FAST = { source: "site", id: "fast" } as const;

let n = 0;
const tag = () => `lo${++n}x${Math.floor(Math.random() * 1e6)}`;
let txn = 0;
const say = async (who: Actor, conv: string, text: string): Promise<number> => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `lo${++txn}` });
  expect(sent.status).toBe(201);
  return sent.json.message.seq as number;
};

/** The order `ids` were first locked in, of all locks taken. */
const firstLocks = (ids: readonly string[]) => [...new Set(locked.ids.filter((id) => ids.includes(id)))];

describe("the owners' accounts in one transaction: ascending id", () => {
  it("a halt following up the held-back replies of two owners' Agents locks their accounts in id order, whatever order the replies come in", async () => {
    // Two owners whose Agents' ids are in the other order than the owners' (and their replies made in that order too): whichever of
    // them the follow-ups go by, only the rule puts the accounts in ascending order.
    for (let attempt = 0; ; attempt++) {
      const t = tag();
      const [o1, o2, member] = [await signUp(app, `${t}a`), await signUp(app, `${t}b`), await signUp(app, `${t}m`)];
      const [low, high] = o1.id < o2.id ? [o1, o2] : [o2, o1];
      const agentOfLow = await mustCreateAgent(app, low, { handle: `${t}l`, name: `${t}l`, model: FAST, persona: "简短。" });
      const agentOfHigh = await mustCreateAgent(app, high, { handle: `${t}h`, name: `${t}h`, model: FAST, persona: "简短。" });
      if (!(agentOfHigh.id < agentOfLow.id)) {
        expect(attempt).toBeLessThan(20);
        continue;
      }
      const g = await group(app, low, `${t}群`, [member, high]);
      for (const agent of [agentOfHigh, agentOfLow]) {
        await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [g, agent.id]);
      }
      // Each Agent's reply, called by another Agent (triggered `agent`), running when the member's call is noted on it, then held back
      // (queued again with what was noted): the high owner's first.
      for (const [agent, owner] of [
        [agentOfHigh, high],
        [agentOfLow, low],
      ] as const) {
        await db.query(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, started_at, triggered_by, lane)
           select 'reply', $1, $2, $3, 'running', seq, now(), 'agent', 'others' from conversations where id = $1`,
          [g, agent.id, owner.id],
        );
        await say(member, g, `@${agent.handle} 也看看`);
        await db.query("update agent_runs set status = 'queued', started_at = null where agent_id = $1 and conversation_id = $2 and status = 'running'", [agent.id, g]);
      }
      locked.ids.length = 0;
      locked.on = true;
      try {
        expect((await api(app, member, "POST", `/api/conversations/${g}/agents/halt`)).status).toBe(200);
      } finally {
        locked.on = false;
      }
      expect(firstLocks([low.id, high.id])).toEqual([low.id, high.id]);
      return;
    }
  });
});
