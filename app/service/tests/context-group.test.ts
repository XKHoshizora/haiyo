import { describe, expect, it } from "vitest";
import { GROUP_CONTEXT_MESSAGES, loadContext, type LoadedContext } from "../src/agents/context.ts";
import { contextBudget } from "../src/agents/runtime/context.ts";
import type { SystemText } from "../src/agents/runtime/prompt.ts";
import { insertMessage } from "../src/messages/model.ts";
import { estimateTokens } from "../src/metering/tokens.ts";
import { api, group, signUp } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * A group's window (Task 10; README "What the model is shown", "The rolling summary"): the newest messages that fit
 * min(the model's context budget, `AGENT_GROUP_CONTEXT_TOKENS`), at most `GROUP_CONTEXT_MESSAGES`, whichever bites first —
 * and what it leaves out (`leftOut`) exact at each: the place just before the oldest one shown (`to`) and how many visible
 * messages lie before it (`messages`).
 * `loadContext` is called straight, as `begin` calls it, with a system text of a known size.
 */

const model = (id: string, contextTokens: number) => ({
  id,
  label: id,
  tier: "free",
  protocol: "openai_chat",
  baseUrl: "https://api.example.test/v1",
  apiKeyEnv: "GROUP_CONTEXT_TEST_KEY",
  model: `${id}-1`,
  inputMicroPerToken: 1,
  outputMicroPerToken: 1,
  maxOutputTokens: 1000,
  contextTokens,
  vision: false,
  pdf: false,
  reasoning: [],
});
const ENV = { GROUP_CONTEXT_TEST_KEY: "not-a-real-key", SITE_MODELS: JSON.stringify([model("wide", 200_000)]) };
const { app, db } = useApp({ env: ENV, agentWorker: false });

const SYSTEM: SystemText = { text: "系统", rest: "系统", passage: "" };
const resolvedOf = (contextTokens: number) => ({ contextTokens, vision: false, call: { maxOutputTokens: 1000 } }) as Parameters<typeof loadContext>[2];

/** A group of three people with an Agent in it, and `texts` said there after the Agent joined (by the two members in turn). */
async function world(name: string, texts: readonly string[]) {
  const [v, m, n] = [await signUp(app, `${name}v`), await signUp(app, `${name}m`), await signUp(app, `${name}n`)];
  const g = await group(app, v, `${name} 群`, [m, n]);
  const agent = await mustCreateAgent(app, v, { handle: `${name}_bot`, model: { source: "site", id: "wide" }, persona: "简短。", memory: false });
  expect((await api(app, v, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
  const seqs: number[] = [];
  for (const [i, text] of texts.entries()) seqs.push((await db.tx((t) => insertMessage(t, g, [m.id, n.id][i % 2]!, "text", { text }, null))).seq);
  return { v, g, agentId: agent.id as string, seqs };
}

async function load(w: Awaited<ReturnType<typeof world>>, contextTokens: number): Promise<LoadedContext> {
  const covers = w.seqs.at(-1)!;
  return loadContext(
    db,
    {
      agentId: w.agentId,
      ownerId: w.v.id,
      conversationId: w.g,
      coversSeq: covers,
      group: { maxTokens: app.deps.config.agentGroupContextTokens, maxMessages: GROUP_CONTEXT_MESSAGES, after: 0, calls: [covers] },
      planRatio: 1,
      summary: { stored: null, shown: null },
    },
    resolvedOf(contextTokens),
    () => SYSTEM,
  );
}

/** How many of `entries`, newest first, fit `budget` by name (all are someone else's, none has an attachment). */
function fitting(loaded: LoadedContext): number {
  let left = loaded.budget;
  let n = 0;
  for (const e of [...loaded.entries].reverse()) {
    const cost = estimateTokens(e.text);
    if (cost > left) break;
    left -= cost;
    n++;
  }
  return n;
}

describe("a group's window", () => {
  it(`the message count bites first: the newest ${GROUP_CONTEXT_MESSAGES}, and leftOut is exactly the rest`, async () => {
    const w = await world("ca", Array.from({ length: 120 }, (_, i) => `短${i}`));
    const loaded = await load(w, 200_000);
    expect(loaded.budget).toBe(app.deps.config.agentGroupContextTokens);
    expect(loaded.entries).toHaveLength(GROUP_CONTEXT_MESSAGES);
    expect(fitting(loaded)).toBe(GROUP_CONTEXT_MESSAGES);
    expect(loaded.leftOut).toEqual({ to: w.seqs[39], messages: 40 });
  });

  it("AGENT_GROUP_CONTEXT_TOKENS bites first: the newest that fit 12 000, and leftOut is exactly the rest", async () => {
    // About 300 weight each: fewer than 80 fit in 12 000.
    const w = await world("cb", Array.from({ length: 120 }, (_, i) => `第${i}条：` + "很长的话".repeat(75)));
    const loaded = await load(w, 200_000);
    expect(loaded.budget).toBe(app.deps.config.agentGroupContextTokens);
    const kept = fitting(loaded);
    expect(kept).toBeGreaterThan(10);
    expect(kept).toBeLessThan(GROUP_CONTEXT_MESSAGES);
    const firstShown = w.seqs.length - kept;
    expect(loaded.leftOut).toEqual({ to: w.seqs[firstShown - 1], messages: firstShown });
  });

  it("the model's context bites first: the newest that fit its budget, and leftOut is exactly the rest", async () => {
    const w = await world("cc", Array.from({ length: 120 }, (_, i) => `第${i}条：` + "话".repeat(40)));
    const loaded = await load(w, 4000);
    const budget = contextBudget(4000, 1000, SYSTEM);
    expect(budget).toBeLessThan(app.deps.config.agentGroupContextTokens);
    expect(loaded.budget).toBe(budget);
    const kept = fitting(loaded);
    expect(kept).toBeLessThan(GROUP_CONTEXT_MESSAGES);
    const firstShown = w.seqs.length - kept;
    expect(loaded.leftOut).toEqual({ to: w.seqs[firstShown - 1], messages: firstShown });
  });

  it("nothing left out: no leftOut", async () => {
    const w = await world("cd", Array.from({ length: 30 }, (_, i) => `短${i}`));
    const loaded = await load(w, 200_000);
    expect(loaded.entries).toHaveLength(30);
    expect(loaded.leftOut).toBeNull();
  });
});
