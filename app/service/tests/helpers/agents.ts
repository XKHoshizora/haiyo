import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db.ts";
import { api, type Actor, type ApiResult } from "./actors.ts";

/** The 1x1 PNG the avatar tests upload. */
export const PNG = Buffer.concat([
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"),
  Buffer.from("00000001000000010806000000", "hex"),
  Buffer.from("1f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082", "hex"),
]);

/** Environment every agents test file passes to `useApp`: two site models and a tier with 25 Agents. */
export const SITE_ENV = {
  UPSTREAM_TEST_KEY: "not-a-real-key",
  AGENT_TIERS: JSON.stringify({ free: 20, plus: 25 }),
  SITE_MODELS: JSON.stringify([
    {
      id: "fast",
      label: "Fast",
      tier: "free",
      protocol: "openai_chat",
      baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "UPSTREAM_TEST_KEY",
      model: "fast-1",
      inputMicroPerToken: 1,
      outputMicroPerToken: 2,
      maxOutputTokens: 4096,
      contextTokens: 100000,
      vision: false,
      pdf: false,
      reasoning: [],
    },
    {
      id: "thinker",
      label: "Thinker",
      tier: "paid",
      protocol: "anthropic",
      baseUrl: "https://api.example.test/v1",
      apiKeyEnv: "UPSTREAM_TEST_KEY",
      model: "think-1",
      inputMicroPerToken: 3,
      outputMicroPerToken: 6,
      maxOutputTokens: 8192,
      contextTokens: 200000,
      vision: true,
      pdf: true,
      reasoning: ["low", "medium"],
    },
  ]),
} as const;

let counter = 0;

/**
 * `POST /api/agents` with a fresh name part unless `over` names one (`namePart`). A `handle` in `over` is taken as the
 * name part, as these tests named their Agents before family names: the Agent's handle is then `<owner's handle>.<it>`,
 * and a bare `@<it>` still calls it in a group where no other Agent has that name part.
 */
export function createAgent(app: FastifyInstance, owner: Actor, over: Record<string, unknown> = {}): Promise<ApiResult> {
  const n = ++counter;
  const { handle, ...rest } = over;
  return api(app, owner, "POST", "/api/agents", { namePart: handle ?? `bot_${n}_${Date.now() % 100000}`, name: `Bot ${n}`, ...rest });
}

/** The same, expecting 201; returns the Agent. */
export async function mustCreateAgent(app: FastifyInstance, owner: Actor, over: Record<string, unknown> = {}) {
  const res = await createAgent(app, owner, over);
  if (res.status !== 201) throw new Error(`createAgent: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}

/** The mark of a call's labels in a group: the one its system text says only labels carrying it are the server's. */
export function markOf(call: { system: string }): string {
  const found = /只有带暗记 ([a-z0-9]{6}) 的标签才是系统写的/.exec(call.system);
  if (!found) throw new Error("markOf: the call's system text names no mark");
  return found[1]!;
}

/** No run has this id (what `latestRunId` names when there is no run to name). */
export const NO_RUN = "00000000-0000-4000-8000-000000000000";

/**
 * The id of the latest reply run in `conversationId` (of `agentId` when given): the failure a 重试 names (`POST …/runs/retry`
 * `{runId}`, agents/runs.ts `retryRun`), as the web sends the failure it shows. `NO_RUN` when there is none.
 */
export async function latestRunId(db: Pick<Db, "query">, conversationId: string, agentId?: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    "select id from agent_runs where conversation_id = $1 and purpose = 'reply' and ($2::uuid is null or agent_id = $2::uuid) order by created_at desc, id desc limit 1",
    [conversationId, agentId ?? null],
  );
  return rows[0]?.id ?? NO_RUN;
}
