import { afterEach, describe, expect, it } from "vitest";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";

/**
 * A model that used its whole output limit thinking (`thinking_exhausted`, src/models/gateway.ts): a reply ends
 * `failed` with that code, retryable, nothing posted, charged the usage the upstream reported, as a failed answer is;
 * a persona draft answers 502 with it, charged the same way. The `fast` site model costs 1 micro-point per input token
 * and 2 per output token.
 *
 * And so that a reply is never sent one level while sized for another (the allowance that keeps its thinking from
 * using up its limit): the level a reply is sent is the one its output limit, hold and context were sized for when it
 * began, even when its Agent's level changes before the call (`fast_think`: `fast` with levels).
 */

const MODELS = JSON.parse(SITE_ENV.SITE_MODELS) as Array<Record<string, unknown>>;
const ENV = { ...SITE_ENV, SITE_MODELS: JSON.stringify([...MODELS, { ...MODELS[0], id: "fast_think", label: "Fast, thinking", reasoning: ["low", "high"] }]) };

const gateway = scriptedGateway();
const store = useProbeBlobs("af-thinking-");
const { app, db } = useApp({ env: ENV, models: gateway, blobs: store.blobs, agentWorker: false });
afterEach(() => expect(gateway.pending()).toBe(0));

const FAST = { source: "site", id: "fast" } as const;
const FAST_THINK = { source: "site", id: "fast_think" } as const;
const USAGE = { inputTokens: 11, outputTokens: 19 };

const recordsOf = async (ownerId: string) =>
  (
    await db.query(
      `select purpose, outcome, estimated, input_tokens::int as input, output_tokens::int as output, cost_micro::text as cost
         from usage_records where owner_id = $1 order by id`,
      [ownerId],
    )
  ).rows;
const held = async () => (await db.query<{ h: string }>("select coalesce(sum(hold_micro), 0)::text as h from agent_runs")).rows[0]!.h;

describe("thinking_exhausted", () => {
  it("a reply: failed thinking_exhausted, retryable, nothing posted, charged the reported usage", async () => {
    const owner = await signUp(app, "thinker");
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "简短地回答。" });
    gateway.fail("thinking_exhausted", { usage: USAGE });
    expect((await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "想一想", clientTxn: "t1" })).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(true);

    const run = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/run`)).json.run;
    expect(run).toEqual({ id: run.id, status: "failed", error: "thinking_exhausted", retryable: true });
    const messages = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/messages`)).json.messages;
    expect(messages.filter((m: { senderId: string }) => m.senderId === agent.id)).toEqual([]);
    expect(await recordsOf(owner.id)).toEqual([{ purpose: "reply", outcome: "failed", estimated: false, input: 11, output: 19, cost: String(11 * 1 + 19 * 2) }]);
    expect(await held()).toBe("0");
  });

  it("a persona draft: 502 thinking_exhausted, charged the reported usage", async () => {
    const owner = await signUp(app, "drafter");
    gateway.fail("thinking_exhausted", { usage: USAGE });
    expect(await api(app, owner, "POST", "/api/agents/draft-persona", { name: "x", model: FAST })).toEqual({ status: 502, json: { error: "thinking_exhausted" } });
    expect(await recordsOf(owner.id)).toEqual([{ purpose: "draft", outcome: "failed", estimated: false, input: 11, output: 19, cost: String(11 * 1 + 19 * 2) }]);
    expect(await held()).toBe("0");
  });
});

let txn = 0;
async function sendFile(owner: Actor, conv: string, data: string): Promise<void> {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: owner.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: "note.txt", type: "text/plain", data }]),
  });
  expect(res.statusCode).toBe(201);
  const sent = await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { attachmentId: res.json().id, clientTxn: `lv${++txn}` });
  expect(sent.status).toBe(201);
}

describe("the level a reply is sent is the level it was sized for", () => {
  // fast_think: a reply limit of 4 096 and a 100 000 context, so high's whole allowance (12 000 by default) fits.
  const LIMIT = { none: 4096, high: 4096 + 12_000 } as const;

  it.each([
    ["high", "none"],
    ["none", "high"],
  ] as const)("the Agent changed from %s to %s while the reply read its files: the plan made at the first is thrown away (the admission compares the Agent's settings: limits redesign, Part 2) and the call is sent at the second, with its limit", async (from, to) => {
    const owner = await signUp(app, `level_${from}`);
    const agent = await mustCreateAgent(app, owner, { model: FAST_THINK, persona: "简短地回答。", reasoning: from });
    const conv = agent.conversationId as string;
    await sendFile(owner, conv, "读一读");
    // Between the reply's first transaction (its model resolved, its limit sized) and its admission and call.
    store.probe.beforeGet = async () => {
      store.probe.beforeGet = undefined;
      expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { reasoning: to })).status).toBe(200);
    };
    gateway.reply("好。", { usage: { inputTokens: 5, outputTokens: 3 } });
    expect(await app.agentWorker.runOnce()).toBe(true);
    // Planned twice (the files read twice), one call made: at the level the Agent has as it is admitted.
    expect(store.probe.gets).toHaveLength(2);
    const sent = gateway.calls.at(-1)!;
    expect([sent.reasoning, sent.maxOutputTokens]).toEqual([to, LIMIT[to]]);

    // And so is the next reply.

    gateway.reply("好的。", { usage: { inputTokens: 5, outputTokens: 3 } });
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text: "再来", clientTxn: `lv${++txn}` })).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(true);
    const next = gateway.calls.at(-1)!;
    expect([next.reasoning, next.maxOutputTokens]).toEqual([to, LIMIT[to]]);
    expect(await held()).toBe("0");
  });
});
