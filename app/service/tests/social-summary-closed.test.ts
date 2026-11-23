import { afterEach, describe, expect, it } from "vitest";
import { runSummary } from "../src/agents/summary/job.ts";
import type { Db } from "../src/db.ts";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

/**
 * Lane B, B-4 review m6: the summary job fails closed. A social conversation is never summarised; when the job cannot tell what place
 * the conversation is (the read of it fails), it does nothing more — it does not go on to read and summarise as if it were a group.
 */
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, memory: true, config: SOCIAL_ON });
afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

describe("the summary job and a social conversation", () => {
  it("m6: when the place of the conversation cannot be read, the job stops there: no further query, no model call", async () => {
    const owner = await signUp(app, "m6_owner");
    const visitor = await signUp(app, "m6_visitor");
    const agent = (await mustCreateAgent(app, owner, { handle: "m6bot", name: "m6bot", model: { source: "site", id: "fast" }, persona: "简短。" })) as { id: string; conversationId: string };
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor });
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const sent = await api(app, visitor, "POST", `/api/conversations/${seeded.conversationId}/messages`, { text: `第${i}句话`, clientTxn: `m6-${i}` });
      expect(sent.status).toBe(201);
      last = sent.json.message.seq as number;
    }
    const seen: string[] = [];
    let broke = false;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "query") {
          return (sql: string, params?: unknown[]) => {
            if (broke) seen.push(sql);
            else if (sql.includes("left join direct_pairs d on d.conversation_id = c.id")) {
              broke = true;
              return Promise.reject(new Error("the read of the conversation failed"));
            }
            return target.query(sql, params as never);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const before = gateway.calls.length;
    await runSummary({ db: flaky, config: app.deps.config, models: gateway, log: app.log, inFlight: new Set<string>() }, { kind: "summary", agentId: agent.id, conversationId: seeded.conversationId, upTo: last }, { closing: new AbortController().signal });
    expect(broke).toBe(true);
    expect(seen).toEqual([]);
    expect(gateway.calls.length).toBe(before);
  });
});
