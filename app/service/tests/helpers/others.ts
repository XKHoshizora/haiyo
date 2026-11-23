import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db.ts";
import type { Actor } from "./actors.ts";
import { api } from "./actors.ts";
import { meteredAgent, type MeteredAgent } from "./metering.ts";
import { providerBody } from "./providers.ts";

/**
 * Lane B's money fixtures (plan B1 to B3): the design's two site models, at 140 / 280 micro-points a token on the free tier and
 * 3 000 / 15 000 on the paid, an output limit of 800 tokens (so a held reply costs what the plan's figures say), and a free
 * allowance of 3 points a day in Shanghai.
 */
const model = (id: string, tier: "free" | "paid", input: number, output: number, extra: Record<string, unknown> = {}) => ({
  id,
  label: id,
  tier,
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "OTHERS_UPSTREAM_KEY",
  model: `upstream-${id}`,
  inputMicroPerToken: input,
  outputMicroPerToken: output,
  maxOutputTokens: 800,
  contextTokens: 100_000,
  vision: false,
  pdf: false,
  reasoning: [],
  ...extra,
});
export const OTHERS_ENV = {
  OTHERS_UPSTREAM_KEY: "not-a-real-key",
  FREE_DAILY_POINTS: "3",
  SITE_TIMEZONE: "Asia/Shanghai",
  SITE_MODELS: JSON.stringify([
    model("oth_free", "free", 140, 280),
    model("oth_paid", "paid", 3000, 15000),
    // A model that thinks and writes more than an others' reply may: `OTHERS.outputTokens` and reasoning `none` bound its calls to others.
    model("oth_big", "free", 140, 280, { maxOutputTokens: 4096, reasoning: ["low", "medium"] }),
  ]),
} as const;

export const FREE_MODEL = { source: "site", id: "oth_free" } as const;
export const PAID_MODEL = { source: "site", id: "oth_paid" } as const;
export const BIG_MODEL = { source: "site", id: "oth_big" } as const;
export const POINT = 1_000_000n;
/** Noon in Shanghai: every admission and settlement of a test is at this instant, so one site day holds all of them. */
export const NOON = new Date("2026-03-01T04:00:00Z");
/** The input a reply offered tools is held at (call 1), its room for the last call (B2b), and the one-call hold (the same reply without tools). */
export const HELD_WITH_TOOLS = 20_900;
export const HELD_PLAIN = 16_500;
/** The last call of an others' reply: its growth at the defaults (3 000 result weight, 800 output tokens, 3 notes of 203 bytes), and a context that never caps it. */
export const ROOM = { growthTokens: 14_909, roomCapTokens: 1_000_000 };

export type LaneName = "own" | "others" | "proactive";

/** `n` Agents of `owner` on `model`, so each can have its own running reply (one active run an Agent). */
export async function agentsOf(app: FastifyInstance, db: Db, owner: Actor, n: number, m: typeof FREE_MODEL | typeof PAID_MODEL = FREE_MODEL): Promise<MeteredAgent[]> {
  const agents: MeteredAgent[] = [];
  for (let i = 0; i < n; i++) agents.push(await meteredAgent(app, db, owner, m));
  return agents;
}

/** An Agent of `owner` on a provider's model (it costs nothing). */
export async function providerAgent(app: FastifyInstance, db: Db, owner: Actor): Promise<MeteredAgent> {
  const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "mine" }] }))).json;
  return meteredAgent(app, db, owner, { source: "provider", providerId: provider.id as string, model: "mine" });
}

/** The columns a seeded run may be given. */
export interface SeedRun {
  ownerId: string;
  agent: Pick<MeteredAgent, "agentId" | "conversationId">;
  lane: LaneName;
  /** Default `running` and unadmitted (`admitRun` takes it from there). */
  status?: "queued" | "running" | "done";
  /** A run already admitted at `admittedAt` holding `hold` on the owner's balance (class `free`: the allowance first). */
  hold?: bigint;
  admittedAt?: Date | null;
  retryOf?: string | null;
}

/** Inserts a reply run of the given lane; one that holds is admitted as the pool reads it (`money_rule` 1, `charge_to` `free`). */
export async function seedRun(db: Db, r: SeedRun): Promise<string> {
  const status = r.status ?? "running";
  const holds = r.hold !== undefined && r.hold > 0n;
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, started_at, lane, retry_of, admitted_at,
                             source, model, charge_to, hold_micro, money_rule, finished_at)
     values ('reply', $1, $2, $3, $4, case when $4 = 'queued' then null else now() end, $5, $6, $7,
             $8, $9, $10, $11, $12, case when $4 = 'done' then now() else null end)
     returning id`,
    [
      r.agent.conversationId,
      r.agent.agentId,
      r.ownerId,
      status,
      r.lane,
      r.retryOf ?? null,
      r.admittedAt ?? null,
      holds ? "site" : null,
      holds ? "oth_free" : null,
      holds ? "free" : null,
      (r.hold ?? 0n).toString(),
      holds ? 1 : 0,
    ],
  );
  return rows[0]!.id;
}

/** Sets the owner's own numbers (an account's `others_answers`, `others_points_micro`); a missing account row is made. */
export async function setOwnerNumbers(db: Db, ownerId: string, n: { answers?: number | null; pointsMicro?: bigint | null }): Promise<void> {
  await db.query("insert into accounts (principal_id) values ($1) on conflict do nothing", [ownerId]);
  await db.query("update accounts set others_answers = $2, others_points_micro = $3 where principal_id = $1", [
    ownerId,
    n.answers ?? null,
    n.pointsMicro === undefined || n.pointsMicro === null ? null : n.pointsMicro.toString(),
  ]);
}

/** What the site day of `now` has charged others' replies of `ownerId` plus what their running ones hold: the sum no number may be passed by. */
export async function committedMicro(db: Db, ownerId: string): Promise<bigint> {
  const { rows } = await db.query<{ settled: string; held: string }>(
    `select (select coalesce(sum(u.free_micro + u.balance_micro), 0) from usage_records u join agent_runs r on r.id = u.run_id
              where u.owner_id = $1 and r.lane <> 'own' and r.purpose = 'reply')::text as settled,
            (select coalesce(sum(hold_micro), 0) from agent_runs where owner_id = $1 and status = 'running' and lane <> 'own' and purpose = 'reply')::text as held`,
    [ownerId],
  );
  return BigInt(rows[0]!.settled) + BigInt(rows[0]!.held);
}

/** A small seeded generator (mulberry32): the same orders every run. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
