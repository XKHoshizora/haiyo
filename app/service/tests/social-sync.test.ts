import { readFileSync } from "node:fs";
import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { canSend } from "../src/conversations/store.ts";
import { api, signUp, type Actor, type ApiResult } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON, seedSocial, seedSocialAgents } from "./helpers/social.ts";

// Plan A3b (design §2): what a social conversation shows in sync, to the visitor and to the supervising owner; what stays the
// owner's; the one statement that decides `canSend` for all of a person's social conversations.
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });
const on = { social: { enabled: true } } as const;

/** The keys no response to anyone but an Agent's owner may carry (agents-co-members.test.ts: the one list; Step 0 keeps it). */
const HIDDEN_KEYS: string[] = (() => {
  const text = readFileSync(new URL("./agents-co-members.test.ts", import.meta.url), "utf8");
  const body = /const HIDDEN_KEYS = \[([\s\S]*?)\n\];/.exec(text)?.[1] ?? "";
  return [...body.matchAll(/"([A-Za-z_]+)"/g)].map((m) => m[1]!);
})();

function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

const SECRET = { persona: "PERSONA-ss1 只给主人", reasoning: "THINK-ss1 what it thought", note: "needle-ss1" };
interface MadeAgent {
  id: string;
  conversationId: string;
}
let n = 0;
async function person(): Promise<Actor> {
  const h = `ssy_${++n}_${Math.random().toString(36).slice(2, 6)}`;
  await db.query(`insert into "user" (id, name, email, "emailVerified") values ($1::text, $1::text, $1::text || '@example.test', true)`, [`auth-${h}`]);
  const { rows } = await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, auth_user_id) values ('human', $1::citext, $1::text, 'auth-' || $1::text) returning id`, [h]);
  return { id: rows[0]!.id, handle: h } as Actor;
}
async function postAs(conv: string, senderId: string, body: Record<string, unknown>): Promise<number> {
  const { rows } = await db.query<{ seq: string }>(
    `with c as (update conversations set seq = seq + 1 where id = $1 returning seq)
     insert into messages (conversation_id, seq, sender_id, kind, body) select $1, c.seq, $2, 'text', $3::jsonb from c returning seq`,
    [conv, senderId, JSON.stringify(body)],
  );
  return Number(rows[0]!.seq);
}

describe("the shape in sync", () => {
  it("the visitor's entry has the participants and the Agents as {id, ownerId}; the owner's is an observer's; both are in the same conversation", async () => {
    const owner = await signUp(app, "sssowner");
    const v = await signUp(app, "sssvisitor");
    const agent = (await mustCreateAgent(app, owner, { handle: "sssbot" })) as MadeAgent;
    const { conversationId: conv } = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    const entry = (who: Actor) => api(app, who, "GET", "/api/sync").then((r) => r.json.conversations.find((c: { id: string }) => c.id === conv));
    const mine = await entry(v);
    expect(mine).toMatchObject({ type: "agent_social", myRole: "speaker", canSend: { ok: true }, social: { participants: [v.id, agent.id].sort(), agents: [{ id: agent.id, ownerId: owner.id }] } });
    expect(Object.keys(mine.social).sort()).toEqual(["agents", "participants"]);
    expect(Object.keys(mine.social.agents[0]).sort()).toEqual(["id", "ownerId"]);
    expect(mine.members.map((m: { id: string; role: string }) => [m.id, m.role]).sort()).toEqual([[agent.id, "speaker"], [owner.id, "observer"], [v.id, "speaker"]].sort());
    for (const k of ["peerId", "peerReadSeq", "agentId", "agent"]) expect(k in mine, k).toBe(false);
    const theirs = await entry(owner);
    expect(theirs).toMatchObject({ type: "agent_social", myRole: "observer", canSend: { ok: true }, social: mine.social });
    // The one-conversation read is the same entry.
    expect((await api(app, v, "GET", `/api/conversations/${conv}`)).json).toEqual(mine);
    expect((await api(app, owner, "GET", `/api/conversations/${conv}`)).json).toEqual(theirs);
    // canSend follows the write rule: a row that ends shuts both.
    await db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = 'removed' where agent_id = $1`, [agent.id]);
    expect((await entry(v)).canSend).toEqual({ ok: false, reason: "no_access" });
    expect((await entry(owner)).canSend).toEqual({ ok: false, reason: "no_access" });
  });

  it("an Agent-to-Agent conversation names both Agents with their owners", async () => {
    const owner = await signUp(app, "sssaowner");
    const other = await signUp(app, "sssaother");
    const a = (await mustCreateAgent(app, owner, { handle: "sssabot" })) as MadeAgent;
    const b = (await mustCreateAgent(app, other, { handle: "sssbbot" })) as MadeAgent;
    const { conversationId: conv } = await seedSocialAgents(app, { x: a.id, y: b.id });
    const mine = (await api(app, owner, "GET", "/api/sync")).json.conversations.find((c: { id: string }) => c.id === conv);
    expect(mine).toMatchObject({ myRole: "observer", canSend: { ok: true }, social: { participants: [a.id, b.id].sort() } });
    expect([...mine.social.agents].sort((x: { id: string }, y: { id: string }) => x.id.localeCompare(y.id))).toEqual([{ id: a.id, ownerId: owner.id }, { id: b.id, ownerId: other.id }].sort((x, y) => x.id.localeCompare(y.id)));
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [other.id, owner.id]);
    const blocked = (await api(app, owner, "GET", "/api/sync")).json.conversations.find((c: { id: string }) => c.id === conv);
    expect(blocked.canSend).toEqual({ ok: false, reason: "blocked" });
    await db.query(`update agents set deleted_at = now() where principal_id = $1`, [b.id]);
    const gone = (await api(app, other, "GET", "/api/sync")).json.conversations.find((c: { id: string }) => c.id === conv);
    expect(gone.canSend.ok).toBe(false);
  });
});

describe("private fields", () => {
  it("nothing owner-only reaches the visitor, on any read; the Agent's thinking reaches its owner alone", async () => {
    const owner = await signUp(app, "ssppowner");
    const v = await signUp(app, "sspvisitor");
    const agent = (await mustCreateAgent(app, owner, { handle: "sspbot", persona: SECRET.persona })) as MadeAgent;
    await api(app, owner, "POST", `/api/agents/${agent.id}/pause`);
    const { conversationId: conv } = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    expect((await api(app, v, "POST", `/api/conversations/${conv}/messages`, { text: `hello ${SECRET.note}`, clientTxn: "ss1" })).status).toBe(201);
    const replySeq = await postAs(conv, agent.id, { text: `reply ${SECRET.note}`, reasoning: SECRET.reasoning });
    // The owner reads the thinking of their Agent's reply; the visitor does not.
    expect((await api(app, owner, "GET", `/api/conversations/${conv}/messages/${replySeq}`)).json.message.reasoning).toBe(SECRET.reasoning);
    expect(HIDDEN_KEYS.length).toBeGreaterThan(40);
    const bodies: Array<[string, unknown]> = [];
    const read = async (label: string, method: "GET" | "POST", url: string, body?: unknown) => {
      const res = await api(app, v, method, url, body);
      expect([label, res.status]).toEqual([label, 200]);
      bodies.push([label, res.json]);
    };
    await read("sync", "GET", "/api/sync");
    await read("one conversation", "GET", `/api/conversations/${conv}`);
    await read("members", "GET", `/api/conversations/${conv}/members`);
    await read("history", "GET", `/api/conversations/${conv}/messages`);
    await read("history page", "GET", `/api/conversations/${conv}/messages?limit=1`);
    await read("the reply", "GET", `/api/conversations/${conv}/messages/${replySeq}`);
    await read("search", "GET", `/api/conversations/${conv}/search?q=${SECRET.note}`);
    await read("global search", "GET", `/api/search?q=${SECRET.note}`);
    await read("catch-up", "POST", "/api/sync/catchup", { positions: { [conv]: 0 } });
    for (const [label, body] of bodies) {
      const text = JSON.stringify(body);
      for (const value of [SECRET.persona, SECRET.reasoning]) expect([label, value, text.includes(value)]).toEqual([label, value, false]);
      const keys = keysOf(body);
      expect([label, HIDDEN_KEYS.filter((k) => keys.has(k))]).toEqual([label, []]);
      expect([label, text.includes('"reasoning"'), text.includes('"paused"')]).toEqual([label, false, false]);
    }
    // Positive controls: the reads did show the conversation and the reply.
    for (const label of ["history", "search", "catch-up"]) expect([label, JSON.stringify(bodies.find(([l]) => l === label)![1]).includes(SECRET.note)]).toEqual([label, true]);
    expect(JSON.stringify(bodies.find(([l]) => l === "sync")![1])).toContain(agent.id);
  });
});

describe("canSend for all of a person's social conversations", () => {
  it("an owner observing 105 social conversations gets all 105, each with its canSend, from one statement over them", async () => {
    const owner = await signUp(app, "ssmowner");
    const agents: MadeAgent[] = [];
    for (let i = 0; i < 12; i++) agents.push((await mustCreateAgent(app, owner, { handle: `ssm${i}bot` })) as MadeAgent);
    const convs: Array<{ id: string; agentId: string; visitor: string; want: unknown }> = [];
    for (let i = 0; i < 105; i++) {
      const visitor = await person();
      const agentId = agents[i % agents.length]!.id;
      const seeded = await seedSocial(app, { owner, agentId, visitor });
      let want: unknown = { ok: true };
      if (i % 3 === 1) {
        await db.query(`update agent_contacts set state = 'ended', basis = null, end_reason = 'removed' where agent_id = $1 and subject_id = $2`, [agentId, visitor.id]);
        want = { ok: false, reason: "no_access" };
      } else if (i % 3 === 2) {
        await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [owner.id, visitor.id]);
        want = { ok: false, reason: "blocked" };
      }
      convs.push({ id: seeded.conversationId, agentId, visitor: visitor.id, want });
    }
    // Count the statements that ask the access rule (every one of them carries the bars table).
    const spy = vi.spyOn(pg.Client.prototype, "query") as unknown as { mock: { calls: unknown[][] }; mockRestore(): void };
    let statements = 0;
    let res: ApiResult;
    try {
      res = await api(app, owner, "GET", "/api/sync");
      statements = spy.mock.calls.filter((c) => typeof c[0] === "string" && (c[0] as string).includes("access_bars")).length;
    } finally {
      spy.mockRestore();
    }
    const entries = new Map<string, { canSend: unknown; myRole: string; social: unknown }>(res.json.conversations.map((c: { id: string }) => [c.id, c]));
    for (const c of convs) {
      const e = entries.get(c.id)!;
      expect([c.id, e.canSend]).toEqual([c.id, c.want]);
      expect(e.myRole).toBe("observer");
      expect(e.social).toEqual({ participants: [c.visitor, c.agentId].sort(), agents: [{ id: c.agentId, ownerId: owner.id }] });
      // The write rule's own answer is the same one, asked of each conversation alone.
      expect(await canSend(db, c.id, owner.id, on)).toEqual(c.want);
    }
    expect(convs).toHaveLength(105);
    expect(statements).toBe(1);
  });
});
