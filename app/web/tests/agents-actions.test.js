// The Agent, proposal, reply, provider, usage and model actions: what they send, what they keep, what they say.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDataLayer } from "../src/data/store.jsx";
import { toView } from "../src/data/viewmodel.js";
import { ME } from "../src/data/identities.js";
import {
  A1,
  AG1,
  ANN,
  D1,
  G1,
  ME_ID,
  PRINCIPALS,
  agentConv,
  agentOf,
  agentPrincipal,
  apiError,
  deferred,
  direct,
  fakeFile,
  fakeTimers,
  fakeTransport,
  group,
  notice,
  runOf,
  settle,
  syncOf,
  wire,
} from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const KEY = "sk-live-0123456789abcdefWXYZ";
const PID = "00000000-0000-4000-8000-0000000000aa";
const P1 = "00000000-0000-4000-8000-0000000000f7";
const R1 = "00000000-0000-4000-8000-0000000000e1";
const R2 = "00000000-0000-4000-8000-0000000000e2";

const provider = (fields = {}) => ({
  id: PID,
  name: "我的 OpenAI",
  protocol: "openai_chat",
  baseUrl: "https://api.example.com/v1",
  keyLast4: "WXYZ",
  models: [{ name: "gpt-x", vision: false, pdf: false, reasoning: false, contextTokens: 16000 }],
  ...fields,
});

const card = (status) => wire(A1, 3, AG1, "", { proposal: { id: P1, status, persona: "你是小助手。" } });

function agentSync() {
  return syncOf(
    [agentConv(A1, AG1, { lastSeq: 3, readSeq: 3 }), direct(D1, ANN)],
    [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "在吗"), card("open")],
    [...PRINCIPALS, agentPrincipal()],
  );
}

let layers = [];
afterEach(() => {
  for (const l of layers) l.stop();
  layers = [];
});

const conversationOf = (id) => {
  const found = agentSync().conversations.find((c) => c.id === id);
  if (!found) throw apiError(404, "not_found");
  return found;
};

async function loaded({ api = {}, transport } = {}) {
  const t = transport ?? fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), conversation: conversationOf });
  const layer = createDataLayer({ transport: t, api, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => "tx-1" });
  layers.push(layer);
  // Every model the layer ever shows, serialised (a key must never reach any of them).
  const shown = [];
  layer.subscribe(() => shown.push(JSON.stringify(layer.getSnapshot().model)));
  layer.start();
  await settle();
  const model = () => layer.getSnapshot().model;
  const view = () => toView(model(), { now: NOW });
  return { layer, actions: layer.actions, transport: t, model, view, shown };
}

describe("providers: the API key is sent once and kept nowhere", () => {
  it("createProvider sends the key, keeps the provider without it, and resolves without it", async () => {
    const createProvider = vi.fn(async () => provider());
    const { actions, model, shown } = await loaded({ api: { createProvider } });
    const fields = { name: "我的 OpenAI", protocol: "openai_chat", baseUrl: "https://api.example.com/v1", apiKey: KEY };
    const result = await actions.createProvider(fields);
    expect(createProvider).toHaveBeenCalledWith({ name: "我的 OpenAI", protocol: "openai_chat", baseUrl: "https://api.example.com/v1", apiKey: KEY });
    expect(result).toEqual({ ok: true, value: provider() });
    expect(model().providers[PID]).toEqual(provider());
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(model())).not.toContain(KEY);
    expect(shown.length).toBeGreaterThan(0);
    for (const snapshot of shown) expect(snapshot).not.toContain(KEY);
    expect(JSON.stringify(toView(model(), { now: NOW }))).not.toContain(KEY);
  });

  it("an answer that (wrongly) echoed the key is still kept and resolved without it", async () => {
    const { actions, model, shown } = await loaded({ api: { createProvider: vi.fn(async () => ({ ...provider(), apiKey: KEY })) } });
    const result = await actions.createProvider({ name: "x", protocol: "anthropic", baseUrl: "https://a.example", apiKey: KEY });
    expect(JSON.stringify(result)).not.toContain(KEY);
    for (const snapshot of [...shown, JSON.stringify(model())]) expect(snapshot).not.toContain(KEY);
  });

  it("patchProvider with a new key: the same; a refusal resolves to its sentence and holds no key either", async () => {
    const patchProvider = vi.fn(async () => provider({ keyLast4: "9999" }));
    const { actions, model, shown } = await loaded({ api: { patchProvider, createProvider: vi.fn(async () => Promise.reject(apiError(409, "name_taken"))) } });
    const patched = await actions.patchProvider(PID, { apiKey: KEY, baseUrl: "https://other.example.com" });
    expect(patchProvider).toHaveBeenCalledWith(PID, { apiKey: KEY, baseUrl: "https://other.example.com" });
    expect(patched).toEqual({ ok: true, value: provider({ keyLast4: "9999" }) });
    const refused = await actions.createProvider({ name: "我的 OpenAI", protocol: "openai_chat", baseUrl: "https://api.example.com/v1", apiKey: KEY });
    expect(refused).toEqual({ ok: false, error: { code: "name_taken", reason: null, status: 409 }, text: "你已经有一个同名的供应商了，请换个名称。" });
    for (const snapshot of [...shown, JSON.stringify(model()), JSON.stringify(refused), JSON.stringify(patched)]) expect(snapshot).not.toContain(KEY);
  });
});

describe("providers: the other actions", () => {
  it("listProviderModels: the provider's list with its hints, nothing kept; a failure as 测试连接's, with the provider's status", async () => {
    const entry = (name, fields = {}) => ({ name, vision: false, pdf: false, reasoning: false, chat: true, known: false, added: false, ...fields });
    const known = { known: true, label: "GPT-6 Sol", vision: true, pdf: true, reasoning: true, contextTokens: 1050000, reasoningLevels: ["low", "high"] };
    const listProviderModels = vi.fn(async () => ({
      ok: true,
      listed: [
        entry("gpt-x", { added: true }),
        entry("gpt-6-sol", known),
        entry("text-embedding-3", { chat: false }),
        { name: 5 },
        null,
        { name: "loose", vision: "yes", label: 7, contextTokens: "big", reasoningLevels: ["turbo"] },
        entry("odd-levels", { known: true, label: "Odd", reasoning: true, contextTokens: 1.5, reasoningLevels: ["max", "low", "none"] }),
      ],
    }));
    const { actions, model } = await loaded({ api: { listProviders: vi.fn(async () => ({ providers: [provider()] })), listProviderModels } });
    await actions.loadProviders();
    const before = JSON.stringify(model().providers);
    await expect(actions.listProviderModels(PID)).resolves.toEqual({
      ok: true,
      value: {
        listed: [
          entry("gpt-x", { added: true }),
          entry("gpt-6-sol", known),
          entry("text-embedding-3", { chat: false }),
          entry("loose"),
          // Only a whole positive context, and the known levels in order, are kept.
          entry("odd-levels", { known: true, label: "Odd", reasoning: true, reasoningLevels: ["low", "max"] }),
        ],
      },
    });
    expect(listProviderModels).toHaveBeenCalledWith(PID);
    expect(JSON.stringify(model().providers)).toBe(before);

    listProviderModels.mockResolvedValueOnce({ ok: false, error: "provider_unavailable", upstreamStatus: "404" });
    await expect(actions.listProviderModels(PID)).resolves.toEqual({
      ok: false,
      error: { code: "provider_unavailable", reason: null, status: 200, upstreamStatus: "404" },
      text: "供应商有回应，但这个地址没有模型列表（404）。可以手动添加模型。",
    });
    listProviderModels.mockResolvedValueOnce({ ok: false, error: "provider_rejected", upstreamStatus: "401" });
    await expect(actions.listProviderModels(PID)).resolves.toMatchObject({
      ok: false,
      text: "供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。（供应商返回的状态码：401）",
    });
    listProviderModels.mockRejectedValueOnce(apiError(429, "rate_limited"));
    await expect(actions.listProviderModels(PID)).resolves.toMatchObject({ ok: false, error: { code: "rate_limited", status: 429 }, text: "操作太频繁了，请稍等一分钟再试。" });
    listProviderModels.mockResolvedValueOnce({ ok: true, listed: "nope" });
    await expect(actions.listProviderModels(PID)).resolves.toEqual({ ok: true, value: { listed: [] } });
  });

  it("loadProviders, testProvider and deleteProvider", async () => {
    const api = {
      listProviders: vi.fn(async () => ({ providers: [provider()] })),
      testProvider: vi.fn(async () => ({ ok: false, error: "provider_rejected" })),
      deleteProvider: vi.fn(async () => Promise.reject(apiError(409, "provider_in_use", null, { agents: [{ id: AG1, name: "小助手" }, { id: "x", name: "写作助手" }] }))),
    };
    const { actions, model } = await loaded({ api });
    await expect(actions.loadProviders()).resolves.toMatchObject({ ok: true });
    expect(Object.keys(model().providers)).toEqual([PID]);
    await expect(actions.testProvider(PID)).resolves.toEqual({
      ok: false,
      error: { code: "provider_rejected", reason: null, status: 200 },
      text: "供应商拒绝了这个密钥，或已保存的密钥无法再使用。请重新填写密钥并保存，然后再试。",
    });
    // The provider's own HTTP status is kept with the code (a 404 or 405: it has no model list).
    api.testProvider.mockResolvedValueOnce({ ok: false, error: "provider_unavailable", upstreamStatus: "404" });
    await expect(actions.testProvider(PID)).resolves.toMatchObject({ ok: false, error: { code: "provider_unavailable", status: 200, upstreamStatus: "404" } });
    api.testProvider.mockResolvedValueOnce({ ok: true });
    await expect(actions.testProvider(PID)).resolves.toEqual({ ok: true, value: { ok: true } });
    const inUse = await actions.deleteProvider(PID);
    expect(inUse.text).toBe("还有 Agent 在使用这个供应商：小助手、写作助手。请先给它们换一个模型。");
    expect(model().providers[PID]).toBeDefined();
    api.deleteProvider.mockResolvedValueOnce({ ok: true });
    await expect(actions.deleteProvider(PID)).resolves.toMatchObject({ ok: true });
    expect(model().providers[PID]).toBeUndefined();
  });
});

describe("Agents", () => {
  it("createAgent keeps the new Agent and loads its conversation; a refusal resolves to the sentence for its code", async () => {
    const createAgent = vi.fn(async () => agentOf(AG1, { name: "新助手" }));
    const { actions, model, transport } = await loaded({ api: { createAgent } });
    const syncs = transport.log.filter((x) => x === "sync").length;
    const body = { handle: "helper", name: "新助手", persona: "你是新助手。", model: { source: "site", id: "free-1" } };
    await expect(actions.createAgent(body)).resolves.toEqual({ ok: true, value: agentOf(AG1, { name: "新助手" }) });
    expect(createAgent).toHaveBeenCalledWith(body);
    expect(model().agents[AG1].name).toBe("新助手");
    await settle();
    expect(transport.log.filter((x) => x === "sync")).toHaveLength(syncs + 1);

    createAgent.mockRejectedValueOnce(apiError(409, "handle_taken"));
    await expect(actions.createAgent(body)).resolves.toMatchObject({ ok: false, error: { code: "handle_taken" }, text: "你已经有一个用这个账号名的 Agent 了，请换一个。" });
    createAgent.mockRejectedValueOnce(apiError(403, "agent_limit"));
    await expect(actions.createAgent(body)).resolves.toMatchObject({ ok: false, text: "你的 Agent 数量已达到当前档位的上限。" });
    createAgent.mockRejectedValueOnce(apiError(418, "something_new"));
    await expect(actions.createAgent(body)).resolves.toMatchObject({ ok: false, text: "操作没有成功，请稍后再试。" });
  });

  it("patch, pause, resume and delete apply the answer and refresh the conversation", async () => {
    const api = {
      patchAgent: vi.fn(async (id, patch) => agentOf(id, patch)),
      pauseAgent: vi.fn(async (id) => agentOf(id, { paused: true })),
      resumeAgent: vi.fn(async (id) => agentOf(id, { paused: false })),
      deleteAgent: vi.fn(async (id) => agentOf(id, { deleted: true })),
    };
    const { actions, model, transport } = await loaded({ api });
    await actions.patchAgent(AG1, { name: "改名了" });
    expect(api.patchAgent).toHaveBeenCalledWith(AG1, { name: "改名了" });
    expect(model().agents[AG1].name).toBe("改名了");
    expect(model().principals[AG1].displayName).toBe("改名了");
    await actions.pauseAgent(AG1);
    expect(model().agents[AG1].paused).toBe(true);
    await settle();
    expect(transport.log.at(-1)).toEqual(["conversation", A1]);
    await actions.resumeAgent(AG1);
    expect(model().agents[AG1].paused).toBe(false);
    await actions.deleteAgent(AG1);
    expect(model().agents[AG1].deleted).toBe(true);

    api.pauseAgent.mockRejectedValueOnce(apiError(409, "agent_deleted"));
    await expect(actions.pauseAgent(AG1)).resolves.toMatchObject({ ok: false, text: "这个 Agent 已删除。" });
  });

  it("uploadAgentAvatar gives the Agent's avatar URL its next version at once", async () => {
    const uploadAgentAvatar = vi.fn(async () => ({ ok: true }));
    const { actions, view } = await loaded({ api: { uploadAgentAvatar } });
    const file = fakeFile("a.png", 10, "image/png");
    await expect(actions.uploadAgentAvatar(AG1, file)).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(uploadAgentAvatar).toHaveBeenCalledWith(AG1, file);
    expect(view().agents[AG1].avatar).toBe(`/api/principals/${AG1}/avatar?v=1`);
    uploadAgentAvatar.mockRejectedValueOnce(apiError(413, "too_large"));
    await expect(actions.uploadAgentAvatar(AG1, file)).resolves.toMatchObject({ ok: false, text: "头像不能超过 2 MB。" });
  });

  it("draftPersona resolves the persona; no_quota says which allowance ran out and when it comes back", async () => {
    const draftPersona = vi.fn(async () => ({ persona: "你是旅行助手。" }));
    const { actions } = await loaded({ api: { draftPersona } });
    const body = { name: "旅行助手", intro: "规划行程", model: { source: "site", id: "free-1" } };
    await expect(actions.draftPersona(body)).resolves.toEqual({ ok: true, value: { persona: "你是旅行助手。" } });
    expect(draftPersona).toHaveBeenCalledWith(body);
    // The next midnight of the site, shown in local time.
    const resetsAt = new Date(2026, 10, 17, 0, 0).toISOString();
    draftPersona.mockRejectedValueOnce(apiError(402, "no_quota", "free_and_balance", { resetsAt }));
    await expect(actions.draftPersona(body)).resolves.toMatchObject({
      ok: false,
      error: { code: "no_quota", reason: "free_and_balance", resetsAt },
      text: "今天的免费额度和余额都已用完，免费额度将在明天 00:00 重置。",
    });
    draftPersona.mockRejectedValueOnce(apiError(402, "no_quota", "balance"));
    await expect(actions.draftPersona(body)).resolves.toMatchObject({ ok: false, text: "余额不足：这个模型需要余额才能使用。" });
  });

  it("loadAgents replaces the list", async () => {
    const { actions, model } = await loaded({ api: { listAgents: vi.fn(async () => ({ agents: [] })) } });
    await expect(actions.loadAgents()).resolves.toMatchObject({ ok: true });
    expect(model().agents).toEqual({});
  });
});

describe("persona proposals (Review Focus 4)", () => {
  it("confirming applies the Agent and marks the card at once", async () => {
    const confirmProposal = vi.fn(async () => agentOf(AG1, { persona: "你是小助手。", personaVersion: 1 }));
    const { actions, model } = await loaded({ api: { confirmProposal } });
    await expect(actions.confirmProposal(AG1, P1, { persona: "你是小助手。" })).resolves.toMatchObject({ ok: true });
    expect(confirmProposal).toHaveBeenCalledWith(AG1, P1, { persona: "你是小助手。" });
    expect(model().agents[AG1].personaVersion).toBe(1);
    expect(model().messages[A1].find((m) => m.seq === 3).proposal.status).toBe("confirmed");
  });

  it("a stale proposal says so and fetches the Agent and the card again (once, no loop)", async () => {
    const t = fakeTransport({
      sync: agentSync,
      agents: () => ({ agents: [agentOf()] }),
      agent: (id) => agentOf(id, { personaVersion: 2 }),
      message: () => ({ message: card("superseded"), principals: {} }),
    });
    const confirmProposal = vi.fn(async () => Promise.reject(apiError(409, "stale_proposal")));
    const { actions, model } = await loaded({ api: { confirmProposal }, transport: t });
    t.agentLog.length = 0;
    await expect(actions.confirmProposal(AG1, P1)).resolves.toMatchObject({ ok: false, text: "这份提议已失效，请让它重新生成提议。" });
    expect(confirmProposal).toHaveBeenCalledWith(AG1, P1, undefined);
    await settle();
    expect(t.agentLog).toEqual([["agent", AG1], ["message", A1, 3]]);
    expect(model().messages[A1].find((m) => m.seq === 3).proposal.status).toBe("superseded");
    expect(confirmProposal).toHaveBeenCalledTimes(1);
  });

  it("discarding marks the card discarded", async () => {
    const discardProposal = vi.fn(async () => ({ ok: true }));
    const { actions, model } = await loaded({ api: { discardProposal } });
    await expect(actions.discardProposal(AG1, P1)).resolves.toEqual({ ok: true, value: { ok: true } });
    expect(discardProposal).toHaveBeenCalledWith(AG1, P1);
    expect(model().messages[A1].find((m) => m.seq === 3).proposal.status).toBe("discarded");
  });
});

describe("replies", () => {
  async function failedRun(api) {
    const t = fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), run: () => ({ run: runOf(R1, "failed", { error: "provider_unavailable", retryable: true }) }) });
    return loaded({ api, transport: t });
  }

  it("retryRun replaces the failed run with the new one; busy_run says why", async () => {
    const retryRun = vi.fn(async () => ({ run: runOf(R2, "queued") }));
    const { actions, model } = await failedRun({ retryRun });
    await expect(actions.retryRun(A1)).resolves.toMatchObject({ ok: true, value: { run: runOf(R2, "queued") } });
    // The failure shown is named by its id (T2 fix 1, F4).
    expect(retryRun).toHaveBeenCalledWith(A1, R1);
    expect(model().runs[A1]).toMatchObject({ id: R2, status: "queued" });
    retryRun.mockRejectedValueOnce(apiError(409, "busy_run"));
    await expect(actions.retryRun(A1)).resolves.toMatchObject({ ok: false, text: "它正在回复，请等这次回复结束。" });
  });

  it("a retry answer that arrives after a newer run was pushed changes nothing", async () => {
    const answer = deferred();
    const { actions, model, transport } = await failedRun({ retryRun: vi.fn(() => answer.promise) });
    const retrying = actions.retryRun(A1);
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    answer.resolve({ run: runOf(R2, "queued") });
    await retrying;
    expect(model().runs[A1]).toMatchObject({ id: R2, status: "running" });
  });

  it("dismissRun clears the failure; stopRun stops the current run; both say why when refused", async () => {
    const api = { dismissRun: vi.fn(async () => ({ ok: true })), stopRun: vi.fn(async () => ({ ok: true })) };
    const { actions, model, transport } = await failedRun(api);
    await expect(actions.dismissRun(A1)).resolves.toMatchObject({ ok: true });
    expect(api.dismissRun).toHaveBeenCalledWith(A1);
    expect(model().runs[A1]).toBeNull();
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    await expect(actions.stopRun(A1)).resolves.toMatchObject({ ok: true });
    expect(api.stopRun).toHaveBeenCalledWith(A1, R2);
    // Nothing to stop: no request.
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "stopped") });
    await expect(actions.stopRun(A1)).resolves.toMatchObject({ ok: false, error: { code: "no_run" }, text: "现在没有正在进行的回复。" });
    expect(api.stopRun).toHaveBeenCalledTimes(1);
    // A 404 there is not "it has ended": the conversation or the run is not mine to act on.
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf("00000000-0000-4000-8000-0000000000e3", "running") });
    api.stopRun.mockRejectedValueOnce(apiError(404, "not_found"));
    await expect(actions.stopRun(A1)).resolves.toMatchObject({ ok: false, text: "找不到要操作的内容，它可能已经不存在了。" });
  });

  it("a dismissed failure stays dismissed when a GET .../run already on its way answers with it (M3)", async () => {
    const failedR1 = runOf(R1, "failed", { error: "provider_unavailable", retryable: true });
    const t = fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), conversation: conversationOf, run: () => ({ run: failedR1 }) });
    const api = { dismissRun: vi.fn(async () => ({ ok: true })), retryRun: vi.fn(async () => Promise.reject(apiError(409, "busy_run"))) };
    const { actions, model, transport } = await loaded({ api, transport: t });
    expect(model().runs[A1]).toMatchObject({ id: R1, status: "failed" });
    // A refused retry asks for the run again; that answer is held back until after the dismissal.
    const late = deferred();
    transport.handlers.run = () => late.promise;
    await actions.retryRun(A1);
    await settle();
    await expect(actions.dismissRun(A1)).resolves.toMatchObject({ ok: true });
    expect(model().runs[A1]).toBeNull();
    late.resolve({ run: failedR1 });
    await settle();
    expect(model().runs[A1]).toBeNull();
    // A newer run is shown as usual.
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "queued") });
    expect(model().runs[A1]).toMatchObject({ id: R2, status: "queued" });
  });

  it("resetTopic shows the notice at once", async () => {
    const topic = notice(A1, 4, "Mei 开始了新话题，之前的对话不再发给 小助手", { event: "topic_reset", actorId: ME_ID });
    const resetTopic = vi.fn(async () => ({ message: topic }));
    const { actions, view } = await loaded({ api: { resetTopic } });
    await expect(actions.resetTopic(A1)).resolves.toMatchObject({ ok: true });
    expect(view().convs[A1].messages.at(-1)).toMatchObject({ seq: 4, kind: "system", text: "你开始了新话题，之前的对话不再发给小助手" });
    resetTopic.mockRejectedValueOnce(apiError(403, "cannot_send", "agent_deleted"));
    await expect(actions.resetTopic(A1)).resolves.toMatchObject({ ok: false, text: "这个 Agent 已删除，不能再开始新话题。" });
  });
});

describe("replies in a group (batch 2C)", () => {
  const OAG = "00000000-0000-4000-8000-0000000000b9"; // 小安's Agent
  function groupSync() {
    const base = agentSync();
    const members = [ME_ID, ANN, AG1, OAG].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    return syncOf(
      [group(G1, { members, lastSeq: 1, readSeq: 1 }), ...base.conversations],
      [wire(G1, 1, ANN, "@helper 在吗"), ...base.messages],
      [...base.principals, { ...agentPrincipal(OAG, "annbot", "安的助手"), ownerId: ANN }],
    );
  }
  const inGroup = (api) => {
    const conversation = (id) => {
      const found = groupSync().conversations.find((c) => c.id === id);
      if (!found) throw apiError(404, "not_found");
      return found;
    };
    return loaded({ api, transport: fakeTransport({ sync: groupSync, agents: () => ({ agents: [agentOf()] }), conversation }) });
  };
  const ownerPush = (run) => ({ type: "run", conversationId: G1, agentId: AG1, run });

  it("stopRun stops my Agent's reply in the group by its run; someone else's Agent, or nothing going, sends nothing", async () => {
    const api = { stopRun: vi.fn(async () => ({ ok: true })) };
    const { actions, transport } = await inGroup(api);
    transport.socket.emit(ownerPush(runOf(R1, "running")));
    transport.socket.emit({ type: "run", conversationId: A1, run: runOf(R2, "running") });
    await expect(actions.stopRun(G1, AG1)).resolves.toMatchObject({ ok: true });
    expect(api.stopRun).toHaveBeenCalledWith(G1, R1);
    transport.socket.emit({ type: "run", conversationId: G1, agentId: OAG, state: "replying" });
    await expect(actions.stopRun(G1, OAG)).resolves.toMatchObject({ ok: false, error: { code: "no_run" }, text: "现在没有正在进行的回复。" });
    transport.socket.emit(ownerPush(runOf(R1, "stopped")));
    await expect(actions.stopRun(G1, AG1)).resolves.toMatchObject({ ok: false, error: { code: "no_run" } });
    expect(api.stopRun).toHaveBeenCalledTimes(1);
    // The Agent's own conversation is stopped as before.
    await actions.stopRun(A1);
    expect(api.stopRun).toHaveBeenLastCalledWith(A1, R2);
  });

  it("retryRun sends the failure shown, dismissRun the Agent: the retry's run replaces the failed one, the dismissal closes the line", async () => {
    const api = { retryRun: vi.fn(async () => ({ run: runOf(R2, "queued") })), dismissRun: vi.fn(async () => ({ ok: true })) };
    const { actions, model, transport, view } = await inGroup(api);
    transport.socket.emit(ownerPush(runOf(R1, "failed", { error: "busy", retryable: true })));
    await expect(actions.retryRun(G1, AG1)).resolves.toMatchObject({ ok: true });
    expect(api.retryRun).toHaveBeenCalledWith(G1, R1);
    expect(model().groupRuns[G1][AG1].run).toMatchObject({ id: R2, status: "queued" });
    expect(model().runs[G1]).toBeUndefined();
    transport.socket.emit(ownerPush(runOf(R2, "failed", { error: "rate_limited", retryable: true })));
    expect(view().convs[G1].agentRuns).toHaveLength(1);
    await expect(actions.dismissRun(G1, AG1)).resolves.toMatchObject({ ok: true });
    expect(api.dismissRun).toHaveBeenCalledWith(G1, AG1);
    expect(view().convs[G1].agentRuns).toEqual([]);
    // The Agent's own conversation's routes go without an Agent, as before; with no failure held there, a retry sends nothing.
    const sent = api.retryRun.mock.calls.length;
    await expect(actions.retryRun(A1)).resolves.toMatchObject({ ok: false, error: { code: "no_run" } });
    expect(api.retryRun).toHaveBeenCalledTimes(sent);
    await actions.dismissRun(A1);
    expect(api.dismissRun).toHaveBeenLastCalledWith(A1);
  });

  it("retryRun and dismissRun for someone else's Agent in a group send nothing", async () => {
    const api = { retryRun: vi.fn(async () => ({ run: runOf(R2, "queued") })), dismissRun: vi.fn(async () => ({ ok: true })) };
    const { actions, transport } = await inGroup(api);
    transport.socket.emit({ type: "run", conversationId: G1, agentId: OAG, state: "unavailable" });
    await expect(actions.retryRun(G1, OAG)).resolves.toMatchObject({ ok: false, error: { code: "no_run" } });
    await expect(actions.dismissRun(G1, OAG)).resolves.toMatchObject({ ok: false, error: { code: "no_run" } });
    expect(api.retryRun).not.toHaveBeenCalled();
    expect(api.dismissRun).not.toHaveBeenCalled();
  });

  it("haltAgents asks the group to stop its Agents; a refusal says why", async () => {
    const api = { haltAgents: vi.fn(async () => ({ ok: true })) };
    const { actions } = await inGroup(api);
    await expect(actions.haltAgents(G1)).resolves.toMatchObject({ ok: true });
    expect(api.haltAgents).toHaveBeenCalledWith(G1);
    api.haltAgents.mockRejectedValueOnce(apiError(429, "rate_limited"));
    await expect(actions.haltAgents(G1)).resolves.toMatchObject({ ok: false, text: "叫停太频繁了，请稍等一会儿再试。" });
    api.haltAgents.mockRejectedValueOnce(apiError(404, "not_found"));
    await expect(actions.haltAgents(G1)).resolves.toMatchObject({ ok: false, text: "你已不在这个群聊中。" });
  });
});

describe("usage and site models", () => {
  it("loadUsage and loadModels keep the answers", async () => {
    const usage = { tier: "free", agentLimit: 20, agentCount: 1, balance: "0", free: { allowance: "10", used: "0", resetsAt: "2026-11-16T16:00:00.000Z" }, canStartFreeReply: true, recent: [] };
    const models = { siteModels: [{ id: "paid-1", label: "付费模型", tier: "paid", vision: true, pdf: true, reasoning: ["low", "high"], contextTokens: 200000 }], providerDefaults: { contextTokens: 16000, maxOutputTokens: 2048 } };
    const { actions, model } = await loaded({ api: { getUsage: vi.fn(async () => usage), getModels: vi.fn(async () => models) } });
    await expect(actions.loadUsage()).resolves.toEqual({ ok: true, value: usage });
    expect(model().usage).toEqual(usage);
    await expect(actions.loadModels()).resolves.toMatchObject({ ok: true });
    expect(model().siteModels.map((m) => m.id)).toEqual(["paid-1"]);
  });
});

describe("only the request decides ok or failed (M5)", () => {
  it("a success whose answer cannot be kept still resolves ok, and that state is fetched again", async () => {
    const malformed = { id: AG1, handle: "helper", conversationId: A1 };
    Object.defineProperty(malformed, "name", {
      enumerable: true,
      get() {
        throw new Error("a malformed answer");
      },
    });
    const t = fakeTransport({ sync: agentSync, agents: () => ({ agents: [agentOf()] }), conversation: conversationOf });
    const { actions, transport } = await loaded({ api: { createAgent: vi.fn(async () => malformed) }, transport: t });
    const lists = transport.agentLog.filter((x) => x === "agents").length;
    const syncs = transport.log.filter((x) => x === "sync").length;
    const result = await actions.createAgent({ handle: "helper", name: "小助手" });
    expect(result.ok).toBe(true);
    await settle();
    expect(transport.agentLog.filter((x) => x === "agents")).toHaveLength(lists + 1);
    expect(transport.log.filter((x) => x === "sync")).toHaveLength(syncs + 1);
  });

  it("a provider answer that cannot be kept resolves ok without it, and the providers are fetched again", async () => {
    const listProviders = vi.fn(async () => ({ providers: [provider()] }));
    const bad = { ...provider(), models: "not a list" };
    Object.defineProperty(bad, "models", {
      get() {
        throw new Error("a malformed answer");
      },
    });
    const { actions, model } = await loaded({ api: { createProvider: vi.fn(async () => bad), listProviders } });
    const result = await actions.createProvider({ name: "x", protocol: "anthropic", baseUrl: "https://a.example", apiKey: KEY });
    expect(result).toEqual({ ok: true, value: null });
    await settle();
    expect(listProviders).toHaveBeenCalledTimes(1);
    expect(model().providers[PID]).toEqual(provider());
  });
});

describe("any of them", () => {
  it("a 401 signs out; an answer that arrives after stop() changes nothing", async () => {
    const answer = deferred();
    const { actions, layer, model } = await loaded({ api: { getUsage: vi.fn(() => answer.promise), listProviders: vi.fn(async () => Promise.reject(apiError(401, "unauthenticated"))) } });
    const signedOut = vi.fn();
    layer.onSignedOut(signedOut);
    await actions.loadProviders();
    expect(signedOut).toHaveBeenCalledTimes(1);
    const loading = actions.loadUsage();
    layer.stop();
    answer.resolve({ balance: "1" });
    await loading;
    expect(model().usage).toBeNull();
    expect(toView(model(), { now: NOW }).people[ME]).toBeUndefined();
  });
});
