import { describe, expect, it } from "vitest";
import { api, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { seedSocial } from "./helpers/social.ts";

/**
 * Step 0 registers every route of both rings as a stub: a signed-in caller gets 404 `not_found`, nobody 401, and a malformed
 * request 400 before the stub is reached. Lane A (the contact routes) and lane B (the others' use routes) replace the bodies and
 * keep the schemas. The README carries a heading for each (tests/readme.test.ts).
 */
const { app, db } = useApp({ env: SITE_ENV, models: scriptedGateway(), agentWorker: false });

const ID = "00000000-0000-4000-8000-000000000001";
const ID2 = "00000000-0000-4000-8000-000000000002";
type Method = "GET" | "POST" | "PUT" | "DELETE";
interface Stub {
  method: Method;
  url: string;
  /** A valid body (none: the route takes none). */
  body?: unknown;
  /** Bodies and URLs the schema must refuse before the stub answers. */
  bad?: Array<{ url?: string; body?: unknown }>;
}

const STUBS: Stub[] = [
  // Lane A: social/agent-contact-routes.ts
  { method: "POST", url: "/api/agent-contacts", body: { agentId: ID }, bad: [{ body: {} }, { body: { agentId: "nope" } }, { body: { agentId: ID, extra: 1 } }] },
  { method: "GET", url: "/api/agent-contacts" },
  { method: "POST", url: `/api/agent-contacts/${ID}/${ID2}/approve`, bad: [{ url: `/api/agent-contacts/nope/${ID2}/approve` }] },
  { method: "POST", url: `/api/agent-contacts/${ID}/${ID2}/decline`, bad: [{ url: `/api/agent-contacts/${ID}/nope/decline` }] },
  { method: "DELETE", url: `/api/agent-contacts/${ID}/${ID2}`, bad: [{ url: `/api/agent-contacts/nope/${ID2}` }] },
  { method: "GET", url: `/api/agents/${ID}/contacts`, bad: [{ url: "/api/agents/nope/contacts" }] },
  {
    method: "PUT",
    url: `/api/agents/${ID}/contact-policy`,
    body: { policy: "ask", picked: false, picks: [], dryRun: true },
    bad: [
      { body: {} },
      { body: { policy: "everyone", picked: false, picks: [] } },
      { body: { policy: "ask", picked: false, picks: ["nope"] } },
      { body: { policy: "ask", picked: false, picks: Array.from({ length: 501 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`) } },
    ],
  },
  { method: "PUT", url: `/api/bars/${ID}`, bad: [{ url: "/api/bars/nope" }] },
  { method: "DELETE", url: `/api/bars/${ID}`, bad: [{ url: "/api/bars/nope" }] },
  {
    method: "POST",
    url: "/api/reports",
    body: { agentId: ID, reason: "spam", note: "n" },
    bad: [{ body: {} }, { body: { agentId: ID, reason: "boring" } }, { body: { agentId: ID, reason: "spam", note: "x".repeat(501) } }],
  },
  {
    method: "PUT",
    url: `/api/agents/${ID}/note-verdicts`,
    body: { noteKind: "owner", noteId: ID2, audienceId: ID, share: true, cardSeq: 3 },
    bad: [{ body: {} }, { body: { noteKind: "other", noteId: ID2, audienceId: ID, share: true } }, { body: { noteKind: "self", noteId: ID2, audienceId: ID, share: "yes" } }],
  },
  { method: "POST", url: `/api/agents/${ID}/persona-facts/4`, body: { move: true }, bad: [{ body: {} }, { url: `/api/agents/${ID}/persona-facts/x`, body: { move: true } }] },
  // Lane B: accounts/others-routes.ts
  { method: "GET", url: "/api/me/others-use" },
  {
    method: "PUT",
    url: "/api/me/others-limits",
    body: { answers: 50, points: "70" },
    bad: [{ body: {} }, { body: { answers: 0, points: "70" } }, { body: { answers: 1001, points: "70" } }, { body: { answers: 50, points: "0" } }, { body: { answers: 50, points: "100001" } }, { body: { answers: 50, points: "7e1" } }],
  },
  { method: "POST", url: "/api/me/others-limits/seen" },
];

describe("the route stubs of Agent social", () => {
  it("every one answers 404 not_found to a signed-in caller, 401 to nobody", async () => {
    const me = await signUp(app, "stubby");
    for (const s of STUBS) {
      const label = `${s.method} ${s.url}`;
      const signedIn = await api(app, me, s.method, s.url, s.body);
      expect({ label, status: signedIn.status, json: signedIn.json }, label).toEqual({ label, status: 404, json: { error: "not_found" } });
      const anonymous = await api(app, null, s.method, s.url, s.body);
      expect({ label, status: anonymous.status }, label).toEqual({ label, status: 401 });
    }
  });

  it("a malformed request is 400 before the stub is reached", async () => {
    const me = await signUp(app, "stubby2");
    let refused = 0;
    for (const s of STUBS) {
      for (const bad of s.bad ?? []) {
        const url = bad.url ?? s.url;
        const res = await api(app, me, s.method, url, "body" in bad ? bad.body : s.body);
        expect({ url, status: res.status }, `${s.method} ${url} ${JSON.stringify(bad.body ?? null).slice(0, 80)}`).toEqual({ url, status: 400 });
        refused++;
      }
    }
    expect(refused).toBe(27);
  });

  it("answers 404 also over a seeded social conversation: the stubs read nothing", async () => {
    const owner = await signUp(app, "stubowner");
    const visitor = await signUp(app, "stubvisitor");
    const agent = (await mustCreateAgent(app, owner, { handle: "stubbot" })) as { id: string };
    const seeded = await seedSocial(app, { owner, agentId: agent.id, visitor });
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}/contacts`)).status).toBe(404);
    expect((await api(app, visitor, "GET", "/api/agent-contacts")).status).toBe(404);
    expect((await api(app, owner, "GET", "/api/me/others-use")).status).toBe(404);
    // The seeded rows are what the add flow's own write will leave (A4 compares): members, a live row, the notice.
    const members = await db.query<{ principal_id: string; role: string; joined_seq: number }>(
      "select principal_id, role, joined_seq::int from memberships where conversation_id = $1",
      [seeded.conversationId],
    );
    expect(members.rows.map((r) => `${r.role}:${r.joined_seq}`).sort()).toEqual(["observer:0", "speaker:0", "speaker:0"]);
  });
});
