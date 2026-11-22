import { afterEach, describe, expect, it } from "vitest";
import { redactQuery, redactUrl } from "../src/app.ts";
import { api, befriend, signUp } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { closeAllSockets, connect, issueTicket, tryConnect } from "./helpers/ws.ts";

// The real logger, at info level, writing into this array instead of stdout.
const lines: string[] = [];
const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });
afterEach(closeAllSockets);

describe("request logging", () => {
  it("never writes a query string: no WebSocket ticket, verification token or search term reaches the log", async () => {
    const [a, b] = [await signUp(app, "alice"), await signUp(app, "bob")]; // follows a verification link
    await befriend(app, a, b);
    const verifyToken = new URL(
      /https?:\/\/\S+/.exec((await db.query<{ body: string }>("select body from mail_outbox where recipient = $1", [a.email])).rows[0]!.body)![0],
    ).searchParams.get("token")!;

    const ticket = await issueTicket(app, a);
    const opened = await tryConnect(app, { ticket });
    expect("socket" in opened).toBe(true);
    const unknownTicket = "u".repeat(43);
    expect(await tryConnect(app, { ticket: unknownTicket })).toEqual({ status: 401 });
    expect((await api(app, a, "GET", "/api/search?q=very-private-term")).status).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/attachments/%zz?also=secret-in-a-bad-url" })).statusCode).toBe(400);

    const log = lines.join("");
    for (const secret of [ticket, unknownTicket, verifyToken, "very-private-term", "secret-in-a-bad-url"]) {
      expect(log).not.toContain(secret);
    }
    // Nor the session cookie (headers are not logged at all).
    expect(log).not.toContain(a.cookie.split("=")[1]!.slice(0, 20));

    // The requests themselves are logged, each URL without its query.
    const urls = lines.map((l) => JSON.parse(l) as { req?: { url: string } }).flatMap((e) => (e.req ? [e.req.url] : []));
    expect(urls).toContain("/api/ws?[redacted]");
    expect(urls).toContain("/api/search?[redacted]");
    expect(urls.some((u) => u.startsWith("/api/auth/verify-email?[redacted]"))).toBe(true);
    expect(urls.filter((u) => u.includes("?")).every((u) => u.endsWith("?[redacted]"))).toBe(true);
  });

  it("a whole reply logs no persona, no message or reply text and no provider key at info and above (every line the log has)", async () => {
    const KEY = "sk-live-LOGGING-secret-key-9f8e7d6c";
    const PERSONA = "PERSONA-SECRET-你是只在这里出现的设定";
    const MESSAGE = "MESSAGE-SECRET-主人的一句私话";
    const REPLY = "REPLY-SECRET-Agent 的回答";
    const REASONING = "REASONING-SECRET-模型的思考";
    const PROPOSED = "PROPOSAL-SECRET-新的设定";
    const owner = await signUp(app, "logger");
    const provider = await api(app, owner, "POST", "/api/providers", providerBody({ apiKey: KEY, models: [{ name: "m", reasoning: true }] }));
    expect(provider.status).toBe(201);
    const agent = await mustCreateAgent(app, owner, {
      persona: PERSONA,
      reasoning: "low",
      model: { source: "provider", providerId: provider.json.id, model: "m" },
    });
    const socket = await connect(app, owner);
    lines.length = 0;

    // Owner's message → model call (the key handed to the gateway) → the Agent's message, a proposal in it.
    gateway.reply(`${REPLY}\n<af-persona>${PROPOSED}</af-persona>`, { reasoning: REASONING, usage: { inputTokens: 10, outputTokens: 5 } });
    expect((await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: MESSAGE, clientTxn: "log-1" })).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(true);
    const call = gateway.calls.at(-1)!;
    expect([call.apiKey, call.system.includes(PERSONA)]).toEqual([KEY, true]);
    await socket.next((e) => e.type === "run" && e.run.status === "done");
    const messages = (await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/messages`)).json.messages;
    expect(messages.at(-1)).toMatchObject({ text: REPLY, reasoning: REASONING, proposal: { persona: PROPOSED } });

    // And a reply that fails at the provider, and a provider test that fails: their log lines too.
    gateway.fail("provider_rejected", { afterText: REPLY });
    expect((await api(app, owner, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: MESSAGE, clientTxn: "log-2" })).status).toBe(201);
    expect(await app.agentWorker.runOnce()).toBe(true);
    expect((await api(app, owner, "GET", `/api/conversations/${agent.conversationId}/run`)).json.run).toMatchObject({ status: "failed", error: "provider_rejected" });

    expect(lines.length).toBeGreaterThan(0); // the requests themselves were logged
    const log = lines.join("");
    for (const secret of [KEY, KEY.slice(0, 16), KEY.slice(-12), PERSONA, MESSAGE, REPLY, REASONING, PROPOSED]) {
      expect([secret, log.includes(secret)]).toEqual([secret, false]);
    }
    // Nor anything of them in another encoding a log line could carry them in.
    for (const secret of [PERSONA, MESSAGE, REPLY]) expect(log).not.toContain(JSON.stringify(secret).slice(1, -1).slice(0, 20));
  });

  it("never writes a file name: the named download address is logged as its pattern", async () => {
    const [a] = [await signUp(app, "carol")];
    const id = "00000000-0000-4000-8000-0000000000aa";
    const NAME = "体检报告-张三.pdf";
    lines.length = 0;
    await app.inject({ method: "GET", url: `/api/attachments/${id}/${encodeURIComponent(NAME)}`, headers: { cookie: a.cookie } });
    await app.inject({ method: "HEAD", url: `/api/attachments/${id}/${encodeURIComponent(NAME)}?x=1`, headers: { cookie: a.cookie } });
    const log = lines.join("");
    for (const text of [NAME, encodeURIComponent(NAME), "体检报告", encodeURIComponent("体检报告")]) expect(log).not.toContain(text);
    const urls = lines.map((l) => JSON.parse(l) as { req?: { url: string } }).flatMap((e) => (e.req ? [e.req.url] : []));
    expect(urls).toContain(`/api/attachments/${id}/[name]`);
    expect(urls).toContain(`/api/attachments/${id}/[name]?[redacted]`);
  });

  it("redactUrl: a name segment of the attachments route goes, everything else is as redactQuery leaves it", () => {
    expect(redactUrl("/api/attachments/abc/%E4%BD%A0.png")).toBe("/api/attachments/abc/[name]");
    expect(redactUrl("/api/attachments/abc/a%2Fb.png?x=1")).toBe("/api/attachments/abc/[name]?[redacted]");
    expect(redactUrl("/api/attachments/abc")).toBe("/api/attachments/abc");
    // With the route known, the last segment is the name however the path before it was written.
    expect(redactUrl("/%61pi/attachments/abc/%E4%BD%A0.png", "/api/attachments/:id/:name")).toBe("/%61pi/attachments/abc/[name]");
    expect(redactUrl("/api/attachments/abc/n.png?x=1", "/api/attachments/:id/:name")).toBe("/api/attachments/abc/[name]?[redacted]");
    expect(redactUrl("/api/conversations/abc/messages")).toBe("/api/conversations/abc/messages");
  });

  it("every route with a path parameter takes an id or a number, except the attachment's name (the log redacts that one)", () => {
    const params = new Set(app.routeList.flatMap((r) => [...r.url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!)));
    expect([...params].sort()).toEqual(["changeId", "decision", "hearsayId", "id", "name", "noteId", "principalId", "proposalId", "runId", "seq", "verb"].filter((p) => params.has(p)));
    // (decision and verb are fixed words, not user text; the rest are ids and a sequence number.)
    expect(params.has("handle")).toBe(false);
    // Only the attachments route has a :name, and it is the one the log redacts.
    expect(app.routeList.filter((r) => r.url.includes(":name")).map((r) => r.url)).toEqual(["/api/attachments/:id/:name", "/api/attachments/:id/:name"]);
  });

  it("redactQuery keeps the path and drops everything after the first ?", () => {
    expect(redactQuery("/api/ws?ticket=abc")).toBe("/api/ws?[redacted]");
    expect(redactQuery("/api/search?q=a?b&limit=2")).toBe("/api/search?[redacted]");
    expect(redactQuery("/api/me")).toBe("/api/me");
    expect(redactQuery("/api/me?")).toBe("/api/me?[redacted]");
  });
});
