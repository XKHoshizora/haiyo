import { generateKeyPairSync, randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { MESSAGE_COLUMNS, toStored, type MessageRow } from "../src/messages/model.ts";
import { createApnsClient, type ApnsClient } from "../src/push/apns.ts";
import { PUSH_BODY } from "../src/push/notify.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { fakeApns, type FakeApns } from "./helpers/apns.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON, seedSocial, seedSocialAgents } from "./helpers/social.ts";
import { closeAllSockets } from "./helpers/ws.ts";

// Plan A10, pushes (design §2): a social message is pushed to the people it is for, with the same content-free text as any push; the
// owner who only observes the conversation (the `observer` membership) is pushed for none of it, not the visitor's message, not their
// Agent's reply, not a supervisor's. Their own Agent's reply anywhere else, and a group, are pushed as ever.
const fake: { apns?: FakeApns } = {};
let real: ApnsClient | null = null;
const apns: ApnsClient = { send: (n) => real!.send(n), close: async (grace) => real?.close(grace) };
const { app, db } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false, apns });
const PEM = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
beforeAll(async () => {
  fake.apns = await fakeApns();
  real = createApnsClient({ teamId: "ABCDE12345", keyId: "KEY1234567", keyPem: PEM, topic: "org.haiyo.app", origins: { production: fake.apns.url, sandbox: fake.apns.url }, retryDelaysMs: [5, 10] });
});
afterAll(async () => {
  await real?.close();
  await fake.apns?.close();
});
beforeEach(() => {
  fake.apns!.reset();
  app.push.flush();
});
afterEach(async () => {
  await closeAllSockets();
});

const requests = () => fake.apns!.requests;
const pushedTo = () => requests().map((r) => r.path.replace("/3/device/", ""));
const phone = async (who: Actor): Promise<string> => {
  const token = randomBytes(32).toString("hex");
  expect((await api(app, who, "POST", "/api/push/devices", { token, env: "production" })).status).toBe(200);
  return token;
};
let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const r = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `sp${++txn}` });
  expect(r.status).toBe(201);
  await app.push.idle();
};
/** A message of `senderId` stored and announced as a posted reply is. */
async function posted(conv: string, senderId: string, text: string): Promise<void> {
  const { rows } = await db.query<MessageRow>(
    `with next as (update conversations set seq = seq + 1 where id = $1 returning seq)
     insert into messages as m (conversation_id, seq, sender_id, kind, body) select $1, next.seq, $2, 'text', jsonb_build_object('text', $3::text) from next
     returning ${MESSAGE_COLUMNS}`,
    [conv, senderId, text],
  );
  app.deps.conversations.publish({ messages: rows.map(toStored), conversations: [] }, app.log);
  await app.push.idle();
}

describe("pushes in a social conversation", () => {
  test("the visitor's message, the Agent's reply and the owner's own interjection: the visitor is pushed for the last two, with the fixed text; the observing owner for none", async () => {
    const owner = await signUp(app, "sporowner");
    const visitor = await signUp(app, "spprvisitor");
    const agent = (await mustCreateAgent(app, owner, { handle: "sppry" })) as { id: string };
    const { conversationId } = await seedSocial(app, { owner, agentId: agent.id, visitor });
    const tOwner = await phone(owner);
    const tVisitor = await phone(visitor);
    await say(visitor, conversationId, "CANARY-VISITOR 你好");
    expect(requests()).toEqual([]);
    await posted(conversationId, agent.id, "CANARY-AGENT 你好呀");
    expect(pushedTo()).toEqual([tVisitor]);
    expect(JSON.parse(requests()[0]!.body)).toEqual({ aps: { alert: { title: "Haiyo", body: PUSH_BODY }, sound: "default", "thread-id": conversationId }, c: conversationId });
    fake.apns!.reset();
    await say(owner, conversationId, "CANARY-OWNER 我是主人");
    expect(pushedTo()).toEqual([tVisitor]);
    expect(JSON.stringify(requests())).not.toContain("CANARY");
    expect(pushedTo()).not.toContain(tOwner);
    expect(app.push.flush()).toMatchObject({ sent: 2 });
  });

  test("an Agent-to-Agent conversation: neither observing owner is pushed", async () => {
    const x = await signUp(app, "spaxowner");
    const y = await signUp(app, "spayowner");
    const ax = (await mustCreateAgent(app, x, { handle: "spaxbot" })) as { id: string };
    const ay = (await mustCreateAgent(app, y, { handle: "spaybot" })) as { id: string };
    const { conversationId } = await seedSocialAgents(app, { x: ax.id, y: ay.id });
    await phone(x);
    await phone(y);
    await posted(conversationId, ax.id, "CANARY-X");
    await posted(conversationId, ay.id, "CANARY-Y");
    expect(requests()).toEqual([]);
  });

  test("control: the owner is pushed for their Agent's reply in a group and in their own conversation, and a group member for a group message", async () => {
    const owner = await signUp(app, "spcowner");
    const a = await signUp(app, "spca");
    const b = await signUp(app, "spcb");
    const agent = (await mustCreateAgent(app, owner, { handle: "spcbot" })) as { id: string; conversationId: string };
    const g = await group(app, a, "g", [b, owner]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const tOwner = await phone(owner);
    const tB = await phone(b);
    await posted(g, agent.id, "reply in the group");
    expect(pushedTo().sort()).toEqual([tOwner, tB].sort());
    fake.apns!.reset();
    await posted(agent.conversationId, agent.id, "reply at home");
    expect(pushedTo()).toEqual([tOwner]);
    fake.apns!.reset();
    await say(a, g, "hello");
    expect(pushedTo().sort()).toEqual([tOwner, tB].sort());
  });
});
