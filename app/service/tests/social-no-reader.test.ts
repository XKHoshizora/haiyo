import { afterEach, describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

// Plan A3b (design §2, §8 test 4): a social conversation has no reader position. Nobody sees how far the Agent (or its owner)
// has read, and no read of the owner's is announced to the visitor.
const { app } = useApp({ env: SITE_ENV, config: SOCIAL_ON, agentWorker: false });
afterEach(closeAllSockets);

/** Whether any object at any depth carries a position of someone else's (the Agent's or the other side's). */
const hasPosition = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(hasPosition);
  if (value && typeof value === "object") return Object.entries(value).some(([k, v]) => k === "peerReadSeq" || k === "agentReadSeq" || hasPosition(v));
  return false;
};

describe("no reader position in a social conversation", () => {
  it("the owner reads and is connected: the visitor's socket gets no read frame, and nothing the visitor reads carries a position but their own", async () => {
    const owner = await signUp(app, "nrowner");
    const v = await signUp(app, "nrvisitor");
    const agent = (await mustCreateAgent(app, owner, { handle: "nrbot" })) as { id: string };
    const { conversationId: conv } = await seedSocial(app, { owner, agentId: agent.id, visitor: v });
    expect((await api(app, v, "POST", `/api/conversations/${conv}/messages`, { text: "hi", clientTxn: "nr1" })).status).toBe(201);
    const visitorSocket = await connect(app, v);
    const ownerSocket = await connect(app, owner);
    const before = visitorSocket.events.length;
    // The owner reads everything, twice (the second moves nothing).
    const read = await api(app, owner, "POST", `/api/conversations/${conv}/read`, { seq: 2 });
    expect(read).toMatchObject({ status: 200, json: { readSeq: 2 } });
    expect((await api(app, owner, "POST", `/api/conversations/${conv}/read`, { seq: 2 })).status).toBe(200);
    // And the visitor reads and sends: still nothing announced to anyone's socket.
    expect((await api(app, v, "POST", `/api/conversations/${conv}/read`, { seq: 2 })).status).toBe(200);
    expect((await api(app, v, "POST", `/api/conversations/${conv}/messages`, { text: "again", clientTxn: "nr2" })).status).toBe(201);
    await ownerSocket.next((e) => e.type === "message");
    await visitorSocket.next((e) => e.type === "message" && e.message.text === "again");
    for (const s of [visitorSocket, ownerSocket]) expect(s.events.filter((e) => e.type === "read")).toEqual([]);
    expect(visitorSocket.events.length).toBeGreaterThan(before);
    // Reads: the visitor's own position, no one else's.
    const sync = (await api(app, v, "GET", "/api/sync")).json;
    const entry = sync.conversations.find((c: { id: string }) => c.id === conv);
    expect(entry).toMatchObject({ readSeq: 2 });
    expect("peerReadSeq" in entry).toBe(false);
    for (const [label, body] of [
      ["sync", sync],
      ["one conversation", (await api(app, v, "GET", `/api/conversations/${conv}`)).json],
      ["members", (await api(app, v, "GET", `/api/conversations/${conv}/members`)).json],
      ["history", (await api(app, v, "GET", `/api/conversations/${conv}/messages`)).json],
      ["catch-up", (await api(app, v, "POST", "/api/sync/catchup", { positions: { [conv]: 0 } })).json],
    ] as const) {
      expect([label, hasPosition(body)]).toEqual([label, false]);
    }
    // The owner's own entry is theirs: their readSeq, still no peer's.
    const ours = (await api(app, owner, "GET", "/api/sync")).json.conversations.find((c: { id: string }) => c.id === conv);
    expect(ours).toMatchObject({ readSeq: 2 });
    expect("peerReadSeq" in ours).toBe(false);
  });
});
