import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, request, setUnauthenticatedHandler } from "../src/api/http.js";
import * as routes from "../src/api/routes.js";

const ID = "0b9c1c6e-0000-4000-8000-000000000001";
const ID2 = "0b9c1c6e-0000-4000-8000-000000000002";

let fetchMock;
function reply(status, body) {
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  fetchMock = vi.fn(async () => reply(200, { ok: true }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  setUnauthenticatedHandler(null);
  vi.unstubAllGlobals();
});

// [name, call, method, path, body]  (body undefined: no body and no content type)
const table = [
  ["register", () => routes.register({ email: "a@b.test", password: "pppppppppp", displayName: "A", handle: "alice" }), "POST", "/api/register", { email: "a@b.test", password: "pppppppppp", displayName: "A", handle: "alice" }],
  ["signIn", () => routes.signIn({ email: "a@b.test", password: "x" }), "POST", "/api/auth/sign-in/email", { email: "a@b.test", password: "x" }],
  ["signOut", () => routes.signOut(), "POST", "/api/auth/sign-out", undefined],
  ["verifyEmail", () => routes.verifyEmail("t k"), "GET", "/api/auth/verify-email?token=t+k", undefined],
  ["requestPasswordReset", () => routes.requestPasswordReset({ email: "a@b.test" }), "POST", "/api/auth/request-password-reset", { email: "a@b.test" }],
  ["resetPassword", () => routes.resetPassword({ newPassword: "n", token: "t" }), "POST", "/api/auth/reset-password", { newPassword: "n", token: "t" }],
  ["getMe", () => routes.getMe(), "GET", "/api/me", undefined],
  ["updateMe", () => routes.updateMe("新名字"), "PATCH", "/api/me", { displayName: "新名字" }],
  ["lookupPrincipal", () => routes.lookupPrincipal("bob"), "GET", "/api/principals/lookup?handle=bob", undefined],
  ["getSocial", () => routes.getSocial(), "GET", "/api/social", undefined],
  ["sendFriendRequest", () => routes.sendFriendRequest("bob"), "POST", "/api/friend-requests", { handle: "bob" }],
  ["getFriendRequest", () => routes.getFriendRequest(ID), "GET", `/api/friend-requests/${ID}`, undefined],
  ["acceptFriendRequest", () => routes.acceptFriendRequest(ID), "POST", `/api/friend-requests/${ID}/accept`, undefined],
  ["rejectFriendRequest", () => routes.rejectFriendRequest(ID), "POST", `/api/friend-requests/${ID}/reject`, undefined],
  ["withdrawFriendRequest", () => routes.withdrawFriendRequest(ID), "POST", `/api/friend-requests/${ID}/withdraw`, undefined],
  ["removeFriend", () => routes.removeFriend(ID), "DELETE", `/api/friends/${ID}`, undefined],
  ["blockPrincipal", () => routes.blockPrincipal(ID), "PUT", `/api/blocks/${ID}`, undefined],
  ["unblockPrincipal", () => routes.unblockPrincipal(ID), "DELETE", `/api/blocks/${ID}`, undefined],
  ["createGroup", () => routes.createGroup({ title: "team", memberIds: [ID, ID2] }), "POST", "/api/conversations", { title: "team", memberIds: [ID, ID2] }],
  ["getConversation", () => routes.getConversation(ID), "GET", `/api/conversations/${ID}`, undefined],
  ["renameGroup", () => routes.renameGroup(ID, "new"), "PATCH", `/api/conversations/${ID}`, { title: "new" }],
  ["listMembers", () => routes.listMembers(ID), "GET", `/api/conversations/${ID}/members`, undefined],
  ["addMember", () => routes.addMember(ID, ID2), "POST", `/api/conversations/${ID}/members`, { principalId: ID2 }],
  ["removeMember", () => routes.removeMember(ID, ID2), "DELETE", `/api/conversations/${ID}/members/${ID2}`, undefined],
  ["sendMessage", () => routes.sendMessage(ID, { text: "hi", replyToSeq: 3, clientTxn: "tx_1" }), "POST", `/api/conversations/${ID}/messages`, { text: "hi", replyToSeq: 3, clientTxn: "tx_1" }],
  ["sendMessage (file)", () => routes.sendMessage(ID, { attachmentId: ID2, clientTxn: "tx_2" }), "POST", `/api/conversations/${ID}/messages`, { attachmentId: ID2, clientTxn: "tx_2" }],
  ["listMessages", () => routes.listMessages(ID), "GET", `/api/conversations/${ID}/messages`, undefined],
  ["listMessages (page)", () => routes.listMessages(ID, { before: 31, limit: 30 }), "GET", `/api/conversations/${ID}/messages?before=31&limit=30`, undefined],
  ["getMessage", () => routes.getMessage(ID, 7), "GET", `/api/conversations/${ID}/messages/7`, undefined],
  ["markRead", () => routes.markRead(ID, 12), "POST", `/api/conversations/${ID}/read`, { seq: 12 }],
  ["getSync", () => routes.getSync(), "GET", "/api/sync", undefined],
  ["catchUp", () => routes.catchUp({ [ID]: 4 }), "POST", "/api/sync/catchup", { positions: { [ID]: 4 } }],
  ["requestWsTicket", () => routes.requestWsTicket(), "POST", "/api/ws-ticket", undefined],
  ["searchConversation", () => routes.searchConversation(ID, { q: "100% 报告" }), "GET", `/api/conversations/${ID}/search?q=100%25+%E6%8A%A5%E5%91%8A`, undefined],
  ["searchConversation (page)", () => routes.searchConversation(ID, { q: "a", before: 9, limit: 20 }), "GET", `/api/conversations/${ID}/search?q=a&before=9&limit=20`, undefined],
  ["searchAll", () => routes.searchAll({ q: "a" }), "GET", "/api/search?q=a", undefined],
  ["searchAll (cursor)", () => routes.searchAll({ q: "a", before: "cur+sor/=", limit: 5 }), "GET", "/api/search?q=a&before=cur%2Bsor%2F%3D&limit=5", undefined],
  // Agents, proposals, replies, providers, usage, site models (batch 2A)
  ["listAgents", () => routes.listAgents(), "GET", "/api/agents", undefined],
  ["createAgent", () => routes.createAgent({ handle: "helper", name: "小助手", model: null }), "POST", "/api/agents", { handle: "helper", name: "小助手", model: null }],
  ["getAgent", () => routes.getAgent(ID), "GET", `/api/agents/${ID}`, undefined],
  ["patchAgent", () => routes.patchAgent(ID, { name: "新", model: null }), "PATCH", `/api/agents/${ID}`, { name: "新", model: null }],
  ["pauseAgent", () => routes.pauseAgent(ID), "POST", `/api/agents/${ID}/pause`, undefined],
  ["resumeAgent", () => routes.resumeAgent(ID), "POST", `/api/agents/${ID}/resume`, undefined],
  ["deleteAgent", () => routes.deleteAgent(ID), "DELETE", `/api/agents/${ID}`, undefined],
  ["draftPersona", () => routes.draftPersona({ name: "小助手", model: { source: "site", id: "m" } }), "POST", "/api/agents/draft-persona", { name: "小助手", model: { source: "site", id: "m" } }],
  ["confirmProposal", () => routes.confirmProposal(ID, ID2), "POST", `/api/agents/${ID}/proposals/${ID2}/confirm`, undefined],
  ["confirmProposal (edits)", () => routes.confirmProposal(ID, ID2, { persona: "改过的" }), "POST", `/api/agents/${ID}/proposals/${ID2}/confirm`, { persona: "改过的" }],
  ["discardProposal", () => routes.discardProposal(ID, ID2), "POST", `/api/agents/${ID}/proposals/${ID2}/discard`, undefined],
  ["getRun", () => routes.getRun(ID), "GET", `/api/conversations/${ID}/run`, undefined],
  ["stopRun", () => routes.stopRun(ID, ID2), "POST", `/api/conversations/${ID}/runs/${ID2}/stop`, undefined],
  ["retryRun", () => routes.retryRun(ID), "POST", `/api/conversations/${ID}/runs/retry`, undefined],
  ["dismissRun", () => routes.dismissRun(ID), "POST", `/api/conversations/${ID}/runs/dismiss`, undefined],
  ["resetTopic", () => routes.resetTopic(ID), "POST", `/api/conversations/${ID}/topic`, undefined],
  // An Agent's reply in a group, and the stop for Agent-to-Agent talk (batch 2C)
  ["getGroupRuns", () => routes.getGroupRuns(ID), "GET", `/api/conversations/${ID}/runs`, undefined],
  ["retryRun (a group's Agent)", () => routes.retryRun(ID, ID2), "POST", `/api/conversations/${ID}/runs/retry`, { agentId: ID2 }],
  ["dismissRun (a group's Agent)", () => routes.dismissRun(ID, ID2), "POST", `/api/conversations/${ID}/runs/dismiss`, { agentId: ID2 }],
  ["haltAgents", () => routes.haltAgents(ID), "POST", `/api/conversations/${ID}/agents/halt`, undefined],
  // Whispers (悄悄话): a conversation's, a page at a time, and the two answers
  ["listWhispers", () => routes.listWhispers(ID, { before: 11, limit: 100 }), "GET", `/api/conversations/${ID}/whispers?before=11&limit=100`, undefined],
  ["listWhispers (newest)", () => routes.listWhispers(ID), "GET", `/api/conversations/${ID}/whispers`, undefined],
  ["acceptWhisper", () => routes.acceptWhisper(ID), "POST", `/api/whispers/${ID}/accept`, undefined],
  ["declineWhisper", () => routes.declineWhisper(ID), "POST", `/api/whispers/${ID}/decline`, undefined],
  ["listProviders", () => routes.listProviders(), "GET", "/api/providers", undefined],
  ["createProvider", () => routes.createProvider({ name: "p", protocol: "gemini", baseUrl: "https://g.example", apiKey: "k-12345678" }), "POST", "/api/providers", { name: "p", protocol: "gemini", baseUrl: "https://g.example", apiKey: "k-12345678" }],
  ["patchProvider", () => routes.patchProvider(ID, { name: "q" }), "PATCH", `/api/providers/${ID}`, { name: "q" }],
  ["deleteProvider", () => routes.deleteProvider(ID), "DELETE", `/api/providers/${ID}`, undefined],
  ["testProvider", () => routes.testProvider(ID), "POST", `/api/providers/${ID}/test`, undefined],
  ["listProviderModels", () => routes.listProviderModels(ID), "POST", `/api/providers/${ID}/models/list`, undefined],
  ["getUsage", () => routes.getUsage(), "GET", "/api/usage", undefined],
  ["getModels", () => routes.getModels(), "GET", "/api/models", undefined],
];

describe("routes.js builds the service's method, path and body", () => {
  it.each(table)("%s", async (_name, call, method, path, body) => {
    await call();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(path);
    expect(init.method).toBe(method);
    expect(init.credentials).toBe("same-origin");
    if (body === undefined) {
      expect(init.body).toBeUndefined();
      expect(init.headers["Content-Type"]).toBeUndefined();
    } else {
      expect(JSON.parse(init.body)).toEqual(body);
      expect(init.headers["Content-Type"]).toBe("application/json");
    }
  });

  it("encodes path segments", async () => {
    await routes.getMessage("a/b", 1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/conversations/a%2Fb/messages/1");
  });

  it("uploadAgentAvatar PUTs the raw image bytes to the Agent's avatar", async () => {
    const file = new File(["png"], "a.png", { type: "image/png" });
    await routes.uploadAgentAvatar(ID, file);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/agents/${ID}/avatar`);
    expect(init).toMatchObject({ method: "PUT", credentials: "same-origin", body: file });
    expect(init.headers["Content-Type"]).toBe("image/png");
    await routes.uploadAgentAvatar(ID, new File(["?"], "a", { type: "" }));
    expect(fetchMock.mock.calls[1][1].headers["Content-Type"]).toBe("application/octet-stream");
  });
});

describe("a group's avatar routes", () => {
  it("uploadGroupAvatar PUTs the raw bytes; removeGroupAvatar DELETEs; both for the one conversation", async () => {
    const file = new File(["webp"], "avatar.webp", { type: "image/webp" });
    await routes.uploadGroupAvatar(ID, file);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`/api/conversations/${ID}/avatar`);
    expect(init).toMatchObject({ method: "PUT", credentials: "same-origin", body: file });
    expect(init.headers["Content-Type"]).toBe("image/webp");
    await routes.removeGroupAvatar(ID);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/conversations/${ID}/avatar`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "DELETE" });
  });

  it("builds the versioned URL of a group's avatar", () => {
    expect(routes.groupAvatarUrl(ID)).toBe(`/api/conversations/${ID}/avatar`);
    expect(routes.groupAvatarUrl(ID, 0)).toBe(`/api/conversations/${ID}/avatar`);
    expect(routes.groupAvatarUrl(ID, 3)).toBe(`/api/conversations/${ID}/avatar?v=3`);
    expect(routes.groupAvatarUrl("a/b", 1)).toBe("/api/conversations/a%2Fb/avatar?v=1");
  });
});

describe("URL builders", () => {
  it("builds attachment and avatar URLs", () => {
    expect(routes.attachmentUploadUrl(ID)).toBe(`/api/conversations/${ID}/attachments`);
    expect(routes.attachmentUrl(ID)).toBe(`/api/attachments/${ID}`);
    expect(routes.avatarUrl(ID)).toBe(`/api/principals/${ID}/avatar`);
    expect(routes.avatarUrl(ID, 0)).toBe(`/api/principals/${ID}/avatar`);
    expect(routes.avatarUrl(ID, 3)).toBe(`/api/principals/${ID}/avatar?v=3`);
    expect(routes.myAvatarUploadUrl()).toBe("/api/me/avatar");
  });

  it("derives ws: or wss: from the page's own location", () => {
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:5273" });
    expect(routes.socketUrl("t+1")).toBe("ws://127.0.0.1:5273/api/ws?ticket=t%2B1");
    vi.stubGlobal("location", { protocol: "https:", host: "family.example" });
    expect(routes.socketUrl("abc")).toBe("wss://family.example/api/ws?ticket=abc");
  });
});

describe("ApiError mapping", () => {
  it("maps {error, reason} bodies", async () => {
    fetchMock.mockResolvedValue(reply(403, { error: "cannot_send", reason: "blocked" }));
    const err = await request("POST", "/api/x", {}).catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 403, code: "cannot_send", reason: "blocked" });
  });

  it("keeps the details the client shows: no_quota's resetsAt, provider_in_use's Agents", async () => {
    fetchMock.mockResolvedValueOnce(reply(402, { error: "no_quota", reason: "free_and_balance", resetsAt: "2026-11-16T16:00:00.000Z" }));
    await expect(request("POST", "/api/agents/draft-persona", {})).rejects.toMatchObject({ code: "no_quota", reason: "free_and_balance", resetsAt: "2026-11-16T16:00:00.000Z" });
    fetchMock.mockResolvedValueOnce(reply(409, { error: "provider_in_use", agents: [{ id: ID, name: "小助手" }, { id: 7 }, "x"] }));
    await expect(request("DELETE", `/api/providers/${ID2}`)).rejects.toMatchObject({ code: "provider_in_use", agents: [{ id: ID, name: "小助手" }] });
    fetchMock.mockResolvedValueOnce(reply(409, { error: "busy_run" }));
    const plain = await request("POST", "/api/x").catch((e) => e);
    expect(plain.resetsAt).toBeNull();
    expect(plain.agents).toBeNull();
  });

  it("maps a body without a reason, including busy", async () => {
    fetchMock.mockResolvedValue(reply(503, { error: "busy" }));
    await expect(request("GET", "/api/search")).rejects.toMatchObject({ status: 503, code: "busy", reason: null });
  });

  it("falls back to unknown for a non-JSON error body", async () => {
    fetchMock.mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ status: 502, code: "unknown", reason: null });
  });

  it("maps a failed fetch to status 0 network_error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ status: 0, code: "network_error" });
  });

  it("returns parsed JSON on success", async () => {
    fetchMock.mockResolvedValue(reply(201, { id: ID }));
    await expect(request("POST", "/api/conversations", {})).resolves.toEqual({ id: ID });
  });
});

describe("401 handler", () => {
  it("is called once per 401 and the ApiError is still thrown", async () => {
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    fetchMock.mockImplementation(async () => reply(401, { error: "unauthenticated" }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(handler).toHaveBeenCalledTimes(1);
    await expect(request("GET", "/api/sync")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("is not called for other errors, and a throwing handler does not replace the ApiError", async () => {
    const handler = vi.fn(() => {
      throw new Error("boom");
    });
    setUnauthenticatedHandler(handler);
    fetchMock.mockResolvedValue(reply(403, { error: "forbidden" }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ code: "forbidden" });
    expect(handler).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(reply(401, { error: "unauthenticated" }));
    await expect(request("GET", "/api/me")).rejects.toMatchObject({ code: "unauthenticated" });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe("uploadAttachment (XMLHttpRequest)", () => {
  let xhrs;
  class FakeXhr {
    constructor() {
      this.upload = {};
      this.headers = {};
      this.aborted = false;
      xhrs.push(this);
    }
    open(method, url) {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name, value) {
      this.headers[name] = value;
    }
    send(body) {
      this.body = body;
    }
    abort() {
      this.aborted = true;
      this.onabort?.();
    }
    answer(status, body) {
      this.status = status;
      this.responseText = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
      this.onload();
    }
  }
  beforeEach(() => {
    xhrs = [];
    vi.stubGlobal("XMLHttpRequest", FakeXhr);
  });
  const pick = () => new File(["hello"], "报告.pdf", { type: "application/pdf" });

  it("POSTs multipart with one part named file, no Content-Type, and reports progress", async () => {
    const onProgress = vi.fn();
    const sent = routes.uploadAttachment(ID, pick(), { onProgress });
    const [xhr] = xhrs;
    expect(xhr).toMatchObject({ method: "POST", url: `/api/conversations/${ID}/attachments` });
    expect(xhr.headers).toEqual({ Accept: "application/json" });
    expect(xhr.body).toBeInstanceOf(FormData);
    expect([...xhr.body.keys()]).toEqual(["file"]);
    expect(xhr.body.get("file").name).toBe("报告.pdf");
    xhr.upload.onprogress({ lengthComputable: true, loaded: 1, total: 4 });
    xhr.upload.onprogress({ lengthComputable: false, loaded: 2, total: 0 });
    expect(onProgress.mock.calls).toEqual([[0.25]]);
    xhr.answer(201, { id: ID2, name: "报告.pdf", size: 5, inline: false });
    await expect(sent).resolves.toEqual({ id: ID2, name: "报告.pdf", size: 5, inline: false });
  });

  it("maps error bodies like request(), including reason", async () => {
    const sent = routes.uploadAttachment(ID, pick());
    xhrs[0].answer(413, { error: "too_large", reason: "quota" });
    await expect(sent).rejects.toMatchObject({ status: 413, code: "too_large", reason: "quota" });
    const plain = routes.uploadAttachment(ID, pick());
    xhrs[1].answer(502, "<html>bad gateway</html>");
    await expect(plain).rejects.toMatchObject({ status: 502, code: "unknown" });
  });

  it("a network failure is status 0 network_error; aborting is code aborted (also when already aborted)", async () => {
    const failed = routes.uploadAttachment(ID, pick());
    xhrs[0].onerror();
    await expect(failed).rejects.toMatchObject({ status: 0, code: "network_error" });
    const controller = new AbortController();
    const sent = routes.uploadAttachment(ID, pick(), { signal: controller.signal });
    controller.abort();
    expect(xhrs[1].aborted).toBe(true);
    await expect(sent).rejects.toMatchObject({ status: 0, code: "aborted" });
    await expect(routes.uploadAttachment(ID, pick(), { signal: controller.signal })).rejects.toMatchObject({ code: "aborted" });
    expect(xhrs).toHaveLength(2);
  });

  it("a 401 reaches the unauthenticated handler", async () => {
    const handler = vi.fn();
    setUnauthenticatedHandler(handler);
    const sent = routes.uploadAttachment(ID, pick());
    xhrs[0].answer(401, { error: "unauthenticated" });
    await expect(sent).rejects.toMatchObject({ status: 401 });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
