import type { FastifyInstance } from "fastify";
import { expect } from "vitest";
import { createAgentPort, type DbAgentPort, type Toolbox } from "../../src/agents/port-impl.ts";
import { createAgentWorker, type AgentWorker } from "../../src/agents/runtime/worker.ts";
import type { Config } from "../../src/config.ts";
import type { Db } from "../../src/db.ts";
import type { ModelGateway, ToolSpec } from "../../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./actors.ts";
import { mustCreateAgent } from "./agents.ts";
import { grant } from "./metering.ts";
import { scriptedGateway, type ScriptedGateway } from "./models.ts";
import { FREE_MODEL, POINT } from "./others.ts";

/** An others' reply in a group, on the real port and database (plan B1 to B3). */

export const SEARCH: ToolSpec = {
  name: "search",
  description: "Search this conversation's messages.",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
};
export const READ: ToolSpec = {
  name: "read_file",
  description: "Read a file shared here.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
};

export interface RanCall {
  id: string;
  name: string;
  input: unknown;
}

/** A toolbox offering `tools`, running each call through `run` (default: an empty result at once); `ran` lists what ran. */
export function boxOf(tools: ToolSpec[] = [SEARCH], run: (call: RanCall) => unknown = () => ({ hits: [] })): Toolbox & { ran: RanCall[] } {
  const ran: RanCall[] = [];
  return {
    ran,
    offer: () => ({
      tools,
      perTool: Object.fromEntries(tools.map((t) => [t.name, 6])),
      kinds: Object.fromEntries(tools.map((t) => [t.name, t.name === "read_file" ? "file" : "search"])),
    }),
    run: async (_run, call) => {
      ran.push({ id: call.id, name: call.name, input: call.input });
      return { output: run(call), activity: call.name === "read_file" ? "file" : "search" };
    },
  };
}

let counter = 0;

/**
 * A group of an owner (balance 10 000 points), a member and a third, with the owner's Agent `chef` in it: the member's @ call
 * makes a reply in lane `others`, the owner's one in lane `own`. Its own port with `box`, and a worker run by hand.
 */
export async function othersKitchen<G extends Pick<ModelGateway, "stream"> = ScriptedGateway>(
  app: FastifyInstance,
  db: Db,
  o: {
    agent?: Record<string, unknown>;
    /** Levels as they stand in its row from before a save was held to what its model offers (set past the route, as an older save left them). */
    stored?: { reasoning?: string; othersReasoning?: string; proactiveReasoning?: string };
    box?: Toolbox; config?: Config;
    gateway?: G;
    /** Reads the group's id once it exists (for a gateway that looks at the run). */
    onGroup?: (conversationId: string) => void;
  } = {},
) {
  const tag = `${++counter}x${Math.floor(Math.random() * 1e6)}`;
  const owner = await signUp(app, `oo${tag}`);
  await grant(db, owner.id, 10_000n * POINT);
  const member = await signUp(app, `mm${tag}`);
  const third = await signUp(app, `tt${tag}`);
  const g = await group(app, owner, "饭搭子", [member, third]);
  const agent = await mustCreateAgent(app, owner, { handle: "chef", name: "chef", model: FREE_MODEL, persona: "简短地回答。", ...o.agent });
  if (o.stored) {
    await db.query("update agents set reasoning = coalesce($2, reasoning), others_reasoning = coalesce($3, others_reasoning), proactive_reasoning = coalesce($4, proactive_reasoning) where principal_id = $1", [
      agent.id,
      o.stored.reasoning ?? null,
      o.stored.othersReasoning ?? null,
      o.stored.proactiveReasoning ?? null,
    ]);
  }
  await db.query("insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1", [g, agent.id]);
  o.onGroup?.(g);
  const gateway = (o.gateway ?? scriptedGateway()) as G;
  const config = o.config ?? app.deps.config;
  const { db: pool, blobs, conversations, reads } = app.deps;
  const port: DbAgentPort = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log, ...(o.box ? { toolbox: o.box } : {}) });
  const worker: AgentWorker = createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 1, background: false, log: app.log, tools: config.tools });
  const say = async (who: Actor, text: string) => {
    const sent = await api(app, who, "POST", `/api/conversations/${g}/messages`, { text, clientTxn: `kt${++counter}` });
    expect(sent.status).toBe(201);
  };
  /** The member calls the Agent (lane `others`). */
  const ask = (text = "@chef 附近有什么好吃的？") => say(member, text);
  /** The owner calls it (lane `own`). */
  const askAsOwner = (text = "@chef 附近有什么好吃的？") => say(owner, text);
  const lastRun = async () =>
    (
      await db.query<{ id: string; status: string; error: string | null; lane: string; hold: string; held_back_by: string[] | null }>(
        "select id, status, error, lane, hold_micro::text as hold, held_back_by from agent_runs where conversation_id = $1 order by created_at desc, id desc limit 1",
        [g],
      )
    ).rows[0]!;
  /** The owner's notices that others' use of their Agents reached their number (`others_limit_reached`), in any of their Agents' own conversations. */
  const notices = async () =>
    (
      await db.query(
        "select 1 from messages m join agent_conversations ac on ac.conversation_id = m.conversation_id where ac.owner_id = $1 and m.kind = 'system' and m.body ->> 'event' = 'others_limit_reached'",
        [owner.id],
      )
    ).rowCount;
  const posted = async () =>
    (await db.query<{ text: string }>("select body ->> 'text' as text from messages where conversation_id = $1 and sender_id = $2 and kind = 'text' order by seq", [g, agent.id])).rows.map((r) => r.text);
  const charged = async (runId: string) =>
    BigInt((await db.query<{ n: string }>("select coalesce(sum(free_micro + balance_micro), 0)::text as n from usage_records where run_id = $1", [runId])).rows[0]!.n);
  return { owner, member, third, agent, g, gateway, port, worker, say, ask, askAsOwner, lastRun, notices, posted, charged };
}
