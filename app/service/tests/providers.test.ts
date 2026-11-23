import type { InjectOptions } from "fastify";
import http from "node:http";
import type net from "node:net";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.ts";
import { modelHints } from "../src/providers/hints.ts";
import { loadProviderForCall } from "../src/providers/store.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { createAgent, mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { NO_ANSWER_FLOOR, useApp } from "./helpers/harness.ts";
import { providerBody, useProviderStub } from "./helpers/providers.ts";

const stub = useProviderStub();
const { app, db } = useApp({ env: SITE_ENV, allowInsecureLocal: true });

const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";
const secret = () => app.deps.config.providerKeySecret;

const create = (who: Actor, over: Record<string, unknown> = {}) => api(app, who, "POST", "/api/providers", providerBody(over));
async function mustCreate(who: Actor, over: Record<string, unknown> = {}) {
  const res = await create(who, over);
  if (res.status !== 201) throw new Error(`create provider: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json;
}
const model = (name: string, over: Record<string, unknown> = {}) => ({ name, vision: false, pdf: false, reasoning: false, contextTokens: 16000, ...over });
const useModel = (providerId: string, name: string) => ({ source: "provider", providerId, model: name });

describe("creating and reading providers", () => {
  it("answers the Provider: the baseUrl normalised, the key's last four, models with conservative defaults", async () => {
    const owner = await signUp(app, "olga");
    const res = await create(owner, {
      name: " Home lab ",
      baseUrl: "https://API.Example.com:443/v1/?x=1#frag",
      apiKey: "  sk-live-abcdef-WXYZ1234\n",
      models: [{ name: "gpt-x" }, { name: "deep", vision: true, pdf: true, reasoning: true, contextTokens: 200000 }],
    });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Home lab",
      protocol: "openai_chat",
      baseUrl: "https://api.example.com/v1",
      keyLast4: "1234",
      models: [model("gpt-x"), model("deep", { vision: true, pdf: true, reasoning: true, contextTokens: 200000 })],
    });
    expect(await api(app, owner, "GET", "/api/providers")).toEqual({ status: 200, json: { providers: [res.json] } });

    expect(await loadProviderForCall(db, owner.id, res.json.id, secret())).toEqual({
      protocol: "openai_chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-live-abcdef-WXYZ1234",
      models: res.json.models,
    });
    const other = await signUp(app, "otto");
    expect(await loadProviderForCall(db, other.id, res.json.id, secret())).toBeNull();
    expect(await loadProviderForCall(db, owner.id, RANDOM, secret())).toBeNull();
  });

  it("lists only the caller's providers, oldest first", async () => {
    const [a, b] = [await signUp(app, "ann"), await signUp(app, "ben")];
    const first = await mustCreate(a, { name: "first" });
    await mustCreate(b, { name: "theirs" });
    const second = await mustCreate(a, { name: "second", protocol: "gemini" });
    expect((await api(app, a, "GET", "/api/providers")).json.providers.map((p: any) => p.id)).toEqual([first.id, second.id]);
  });

  it("refuses what does not fit (400) and accepts the boundaries", async () => {
    const owner = await signUp(app, "vlad");
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `m${i}` }));
    const bad: Array<Record<string, unknown>> = [
      { name: "" },
      { name: "x".repeat(41) },
      { name: "two\nlines" },
      { protocol: "openai" },
      { protocol: undefined },
      { baseUrl: "ftp://api.example.com/v1" },
      { baseUrl: "https://user:pw@api.example.com/v1" },
      { baseUrl: "https://exa_mple.com/v1" },
      { baseUrl: "not a url" },
      { baseUrl: `https://api.example.com/${"p".repeat(1000)}` },
      { baseUrl: undefined },
      { apiKey: undefined },
      { apiKey: "short" },
      { apiKey: "has a space in it" },
      { apiKey: "ключ-не-ascii-1234" },
      { apiKey: "x".repeat(1001) },
      { models: many(101) },
      { models: [{ name: "x".repeat(101) }] },
      { models: [{ name: "" }] },
      { models: [{ name: "a\u0000b" }] },
      { models: [{ name: "same" }, { name: "same" }] },
      { models: [{ name: "m", contextTokens: 999 }] },
      { models: [{ name: "m", contextTokens: 2_000_001 }] },
      { models: [{ name: "m", contextTokens: 1500.5 }] },
      { models: [{ name: "m", vision: "yes" }] },
      { models: [{ name: "m", extra: 1 }] },
      { models: "m1,m2" },
      // reasoningLevels: distinct levels above none, in order, only on a model that reasons.
      { models: [{ name: "m", reasoning: true, reasoningLevels: ["high", "low"] }] },
      { models: [{ name: "m", reasoning: true, reasoningLevels: ["low", "low"] }] },
      { models: [{ name: "m", reasoning: true, reasoningLevels: ["none", "low"] }] },
      { models: [{ name: "m", reasoning: true, reasoningLevels: ["minimal"] }] },
      { models: [{ name: "m", reasoning: true, reasoningLevels: ["turbo"] }] },
      { models: [{ name: "m", reasoning: true, reasoningLevels: [] }] },
      { models: [{ name: "m", reasoning: true, reasoningLevels: "low" }] },
      { models: [{ name: "m", reasoning: false, reasoningLevels: ["low"] }] },
      { models: [{ name: "m", reasoningLevels: ["low"] }] },
      { keyLast4: "1234" },
      { ownerId: owner.id },
    ];
    for (const over of bad) expect([over, (await create(owner, over)).status]).toEqual([over, 400]);
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([]);

    const edge = await create(owner, {
      name: "x".repeat(40),
      apiKey: "12345678",
      models: [
        { name: "y".repeat(100), contextTokens: 1000 },
        { name: "z", contextTokens: 2_000_000 },
        ...many(98),
      ],
    });
    expect(edge.status).toBe(201);
    expect(edge.json.models).toHaveLength(100);
    expect(edge.json.keyLast4).toBe("5678");
  });

  it("allows 10 providers per user; the 11th is 400 provider_limit; others are unaffected", async () => {
    const [a, b] = [await signUp(app, "max"), await signUp(app, "mia")];
    for (let i = 1; i <= 10; i++) await mustCreate(a, { name: `p${i}` });
    expect(await create(a, { name: "p11" })).toEqual({ status: 400, json: { error: "provider_limit" } });
    expect((await create(b, { name: "p1" })).status).toBe(201);
    // Deleting one makes room again.
    const list = (await api(app, a, "GET", "/api/providers")).json.providers;
    expect(list).toHaveLength(10);
    expect((await api(app, a, "DELETE", `/api/providers/${list[0].id}`)).status).toBe(200);
    expect((await create(a, { name: "p11" })).status).toBe(201);
  });

  it("ten concurrent creates at nine providers yield exactly one 201", async () => {
    const owner = await signUp(app, "rush");
    for (let i = 1; i <= 9; i++) await mustCreate(owner, { name: `p${i}` });
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => create(owner, { name: `late${i}` })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 400, 400, 400, 400, 400, 400, 400, 400, 400]);
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toHaveLength(10);
  });

  it("a name is unique per owner: 409 name_taken, on creation and on rename", async () => {
    const [a, b] = [await signUp(app, "nina"), await signUp(app, "noah")];
    const one = await mustCreate(a, { name: "Same" });
    const two = await mustCreate(a, { name: "Other" });
    expect(await create(a, { name: "Same" })).toEqual({ status: 409, json: { error: "name_taken" } });
    expect(await api(app, a, "PATCH", `/api/providers/${two.id}`, { name: "Same" })).toEqual({ status: 409, json: { error: "name_taken" } });
    expect((await api(app, a, "PATCH", `/api/providers/${one.id}`, { name: "Same" })).status).toBe(200);
    expect((await create(b, { name: "Same" })).status).toBe(201);
  });
});

describe("editing", () => {
  it("PATCH changes name, baseUrl and models; a new apiKey is sealed again; without one the stored key stays", async () => {
    const owner = await signUp(app, "edda");
    const p = await mustCreate(owner, { apiKey: "sk-first-key-0000AAAA", models: [{ name: "a" }] });
    const keyOf = async () => (await loadProviderForCall(db, owner.id, p.id, secret()))!.apiKey;
    const cipherOf = async () => (await db.query("select key_cipher from providers where id = $1", [p.id])).rows[0].key_cipher as Buffer;
    const before = await cipherOf();

    // Another path on the same origin keeps the stored key.
    const renamed = await api(app, owner, "PATCH", `/api/providers/${p.id}`, { name: "Renamed", baseUrl: "https://API.example.com:443/v2/" });
    expect(renamed).toEqual({ status: 200, json: { ...p, name: "Renamed", baseUrl: "https://api.example.com/v2" } });
    expect(await keyOf()).toBe("sk-first-key-0000AAAA");
    expect((await cipherOf()).equals(before)).toBe(true);

    const rekeyed = await api(app, owner, "PATCH", `/api/providers/${p.id}`, { apiKey: "sk-second-key-0000BBBB" });
    expect(rekeyed.json.keyLast4).toBe("BBBB");
    expect(await keyOf()).toBe("sk-second-key-0000BBBB");
    expect((await cipherOf()).equals(before)).toBe(false);

    const remodelled = await api(app, owner, "PATCH", `/api/providers/${p.id}`, { models: [{ name: "b", reasoning: true }, { name: "c" }] });
    expect(remodelled.json.models).toEqual([model("b", { reasoning: true }), model("c")]);
    expect(await api(app, owner, "PATCH", `/api/providers/${p.id}`, {})).toEqual({ status: 200, json: remodelled.json });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([remodelled.json]);
  });

  it("a baseUrl on another origin (scheme, host or port) needs the key in the same request: the stored key never follows a new address", async () => {
    const owner = await signUp(app, "redi");
    const p = await mustCreate(owner, { apiKey: "sk-first-key-0000AAAA" }); // https://api.example.com/v1
    const cipherOf = async () => (await db.query("select key_cipher from providers where id = $1", [p.id])).rows[0].key_cipher as Buffer;
    const before = await cipherOf();
    for (const baseUrl of ["https://other.example/v1", "https://api.example.com:8443/v1", "https://api.example.com.evil.test/v1", "https://203.0.113.9/v1"]) {
      for (const body of [{ baseUrl }, { baseUrl, name: "Moved" }, { baseUrl, models: [{ name: "m" }] }]) {
        expect([body, await api(app, owner, "PATCH", `/api/providers/${p.id}`, body)]).toEqual([body, { status: 400, json: { error: "invalid_request" } }]);
      }
    }
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([p]);
    expect((await cipherOf()).equals(before)).toBe(true);

    // With the key, the provider moves; its new key is sealed.
    const moved = await api(app, owner, "PATCH", `/api/providers/${p.id}`, { baseUrl: "https://other.example/v1/", apiKey: "sk-other-key-0000CCCC" });
    expect(moved).toEqual({ status: 200, json: { ...p, baseUrl: "https://other.example/v1", keyLast4: "CCCC" } });
    expect((await loadProviderForCall(db, owner.id, p.id, secret()))!.apiKey).toBe("sk-other-key-0000CCCC");
    // Back on that origin, a path change alone is fine.
    expect((await api(app, owner, "PATCH", `/api/providers/${p.id}`, { baseUrl: "https://OTHER.example:443/v2" })).json.baseUrl).toBe("https://other.example/v2");
  });

  it("a model's reasoningLevels are kept and shown, on creation and edit; refresh keeps them; without them, every level", async () => {
    const owner = await signUp(app, "levi");
    const created = await mustCreate(owner, {
      baseUrl: stub.baseUrl(),
      models: [{ name: "some", reasoning: true, reasoningLevels: ["low", "high", "max"] }, { name: "all", reasoning: true }],
    });
    expect(created.models).toEqual([model("some", { reasoning: true, reasoningLevels: ["low", "high", "max"] }), model("all", { reasoning: true })]);
    const all5 = ["low", "medium", "high", "xhigh", "max"];
    const edited = await api(app, owner, "PATCH", `/api/providers/${created.id}`, { models: [{ name: "some", reasoning: true, reasoningLevels: all5 }, { name: "all", reasoning: true }] });
    expect(edited.json.models[0]).toEqual(model("some", { reasoning: true, reasoningLevels: all5 }));
    stub.answer(() => ({ status: 200, body: JSON.stringify({ data: [{ id: "some" }, { id: "new" }] }) }));
    const refreshed = await api(app, owner, "POST", `/api/providers/${created.id}/models/refresh`);
    expect(refreshed.json.provider.models).toEqual([model("some", { reasoning: true, reasoningLevels: all5 }), model("all", { reasoning: true }), model("new")]);
    expect((await api(app, owner, "GET", "/api/providers")).json.providers[0].models).toEqual(refreshed.json.provider.models);
  });

  it("reportedLevels: what the catalogue says the model supports is shown beside the levels in use, so a model set to every level can go back; absent for a model it does not know or one that does not reason", async () => {
    const owner = await signUp(app, "rhea");
    // "o3-mini" reasons and the catalogue lists its levels; it is saved with NO levels (every level): the choice made.
    const created = await mustCreate(owner, {
      baseUrl: stub.baseUrl(),
      models: [{ name: "o3-mini", reasoning: true }, { name: "my-own-think", reasoning: true }, { name: "o3-mini-plain" }, { name: "gpt-x" }],
    });
    const byName = Object.fromEntries(created.models.map((m: { name: string }) => [m.name, m]));
    expect(byName["o3-mini"].reasoningLevels).toBeUndefined();
    expect(byName["o3-mini"].reportedLevels).toEqual(["low", "medium", "high"]);
    // Not known to the catalogue, or not reasoning: nothing is reported.
    expect(byName["my-own-think"]).not.toHaveProperty("reportedLevels");
    expect(byName["gpt-x"]).not.toHaveProperty("reportedLevels");
    // The same after a reload (GET), and after the choice is put back to the levels it reports.
    const listed = (await api(app, owner, "GET", "/api/providers")).json.providers[0].models;
    expect(listed.find((m: { name: string }) => m.name === "o3-mini").reportedLevels).toEqual(["low", "medium", "high"]);
    const back = await api(app, owner, "PATCH", `/api/providers/${created.id}`, { models: [{ name: "o3-mini", reasoning: true, reasoningLevels: ["low", "medium", "high"] }] });
    expect(back.json.models[0]).toMatchObject({ reasoningLevels: ["low", "medium", "high"], reportedLevels: ["low", "medium", "high"] });
    // It is not stored and not accepted back: what the service reports is the catalogue's.
    const refused = await api(app, owner, "PATCH", `/api/providers/${created.id}`, { models: [{ name: "o3-mini", reasoning: true, reportedLevels: ["low"] }] });
    expect(refused.status).toBe(400);
  });

  it("the protocol cannot change, and other keys are refused (400)", async () => {
    const owner = await signUp(app, "pete");
    const p = await mustCreate(owner);
    for (const body of [{ protocol: "anthropic" }, { keyLast4: "0000" }, { id: RANDOM }, { ownerId: owner.id }, { apiKey: "short" }, { baseUrl: "ftp://api.example.com" }]) {
      expect([body, (await api(app, owner, "PATCH", `/api/providers/${p.id}`, body)).status]).toEqual([body, 400]);
    }
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([p]);
  });
});

describe("deleting", () => {
  it("is 409 provider_in_use naming the Agents that use it and are not deleted; once none do, it is deleted", async () => {
    const owner = await signUp(app, "dora");
    const p = await mustCreate(owner, { models: [{ name: "m" }] });
    const user = await mustCreateAgent(app, owner, { name: "User", model: useModel(p.id, "m") });
    const gone = await mustCreateAgent(app, owner, { name: "Gone", model: useModel(p.id, "m") });
    await mustCreateAgent(app, owner, { name: "Elsewhere", model: { source: "site", id: "fast" } });
    expect((await api(app, owner, "DELETE", `/api/agents/${gone.id}`)).status).toBe(200);

    expect(await api(app, owner, "DELETE", `/api/providers/${p.id}`)).toEqual({
      status: 409,
      json: { error: "provider_in_use", agents: [{ id: user.id, name: "User" }] },
    });
    expect((await api(app, owner, "PATCH", `/api/agents/${user.id}`, { model: null })).status).toBe(200);
    expect(await api(app, owner, "DELETE", `/api/providers/${p.id}`)).toEqual({ status: 200, json: { ok: true } });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([]);
    // The deleted Agent no longer points at it.
    expect((await api(app, owner, "GET", `/api/agents/${gone.id}`)).json).toMatchObject({ deleted: true, model: null });
    expect((await api(app, owner, "DELETE", `/api/providers/${p.id}`)).status).toBe(404);
  });

  it("racing an Agent that takes the provider: never a 5xx, and never an Agent left on a deleted provider", async () => {
    const owner = await signUp(app, "race");
    for (let round = 0; round < 6; round++) {
      const p = await mustCreate(owner, { name: `r${round}`, models: [{ name: "m" }] });
      const agent = await mustCreateAgent(app, owner);
      const [patch, del] = await Promise.all([
        api(app, owner, "PATCH", `/api/agents/${agent.id}`, { model: useModel(p.id, "m") }),
        api(app, owner, "DELETE", `/api/providers/${p.id}`),
      ]);
      const outcome = `${patch.status}/${del.status}`;
      expect(["200/409", "400/200"]).toContain(outcome);
      if (del.status === 409) {
        // Free the provider for the next round's count.
        await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { model: null });
        expect((await api(app, owner, "DELETE", `/api/providers/${p.id}`)).status).toBe(200);
      }
    }
  });
});

describe("another person's provider", () => {
  it("is 404 on every route, exactly like an id that does not exist; their list does not show it; an Agent cannot use it", async () => {
    const [alice, eve] = [await signUp(app, "alice"), await signUp(app, "eve")];
    const theirs = await mustCreate(alice, { models: [{ name: "m" }], baseUrl: stub.baseUrl() });
    const requests = (id: string): InjectOptions[] => [
      { method: "PATCH", url: `/api/providers/${id}`, payload: { name: "mine now" } },
      { method: "PATCH", url: `/api/providers/${id}`, payload: { apiKey: "sk-attacker-key-0001" } },
      { method: "DELETE", url: `/api/providers/${id}` },
      { method: "POST", url: `/api/providers/${id}/test` },
      { method: "POST", url: `/api/providers/${id}/models/list` },
      { method: "POST", url: `/api/providers/${id}/models/refresh` },
    ];
    const observe = async (req: InjectOptions) => {
      const res = await app.inject({ ...req, headers: { cookie: eve.cookie } });
      return { status: res.statusCode, type: String(res.headers["content-type"]), body: res.body };
    };
    const reference = await Promise.all(requests(RANDOM).map(observe));
    for (const r of reference) expect([r.status, r.body]).toEqual([404, '{"error":"not_found"}']);
    const got = await Promise.all(requests(theirs.id).map(observe));
    expect(got).toEqual(reference);
    expect(stub.requests).toEqual([]); // nothing was called on their behalf

    expect((await api(app, eve, "GET", "/api/providers")).json.providers).toEqual([]);
    expect((await createAgent(app, eve, { model: useModel(theirs.id, "m") })).status).toBe(400);
    const agent = await mustCreateAgent(app, eve);
    expect((await api(app, eve, "PATCH", `/api/agents/${agent.id}`, { model: useModel(theirs.id, "m") })).status).toBe(400);
    expect((await api(app, alice, "GET", "/api/providers")).json.providers).toEqual([theirs]);
    expect((await loadProviderForCall(db, alice.id, theirs.id, secret()))!.apiKey).toBe(providerBody().apiKey);
  });
});

describe("testing the connection", () => {
  it("is one authenticated GET of {baseUrl}/models, with each protocol's own key header", async () => {
    const owner = await signUp(app, "tess");
    const KEY = "sk-protocol-key-1234";
    const expected: Record<string, Record<string, string | undefined>> = {
      openai_chat: { authorization: `Bearer ${KEY}`, "x-api-key": undefined, "x-goog-api-key": undefined },
      openai_responses: { authorization: `Bearer ${KEY}`, "x-api-key": undefined, "x-goog-api-key": undefined },
      anthropic: { authorization: undefined, "x-api-key": KEY, "anthropic-version": "2023-06-01", "x-goog-api-key": undefined },
      gemini: { authorization: undefined, "x-api-key": undefined, "x-goog-api-key": KEY },
    };
    for (const [protocol, headers] of Object.entries(expected)) {
      const p = await mustCreate(owner, { name: protocol, protocol, baseUrl: `${stub.baseUrl()}/`, apiKey: KEY });
      stub.requests.length = 0;
      expect(await api(app, owner, "POST", `/api/providers/${p.id}/test`)).toEqual({ status: 200, json: { ok: true, mode: "list", latencyMs: expect.any(Number) } });
      expect(stub.requests).toHaveLength(1);
      const [req] = stub.requests;
      expect([protocol, req!.method, req!.path]).toEqual([protocol, "GET", "/v1/models"]);
      for (const [name, value] of Object.entries(headers)) expect([protocol, name, req!.headers[name]]).toEqual([protocol, name, value]);
    }
  });

  it("401 and 403 are provider_rejected; anything but a 200 with JSON is provider_unavailable; a private address is address_not_allowed", async () => {
    const owner = await signUp(app, "tom");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl() });
    const test = () => api(app, owner, "POST", `/api/providers/${p.id}/test`);
    // The provider's HTTP status comes back as a string, and in `detail` with what it said (provider-ux.test.ts); a
    // redirect is refused before its status is kept.
    const cases: Array<[number, string, Record<string, string>, string, string | undefined, string | undefined]> = [
      [401, '{"error":"bad key"}', {}, "provider_rejected", "401", "bad key"],
      [403, '{"error":"forbidden"}', {}, "provider_rejected", "403", "forbidden"],
      [500, '{"error":"oops"}', {}, "provider_unavailable", "500", "oops"],
      [404, '{"error":"no such path"}', {}, "provider_unavailable", "404", "no such path"],
      [405, '{"error":"method not allowed"}', {}, "provider_unavailable", "405", "method not allowed"],
      [429, '{"error":"slow down"}', {}, "provider_unavailable", "429", "slow down"],
      [200, "<html>not json</html>", { "content-type": "text/html" }, "provider_unavailable", "200", "<html>not json</html>"],
      [302, "", { location: "https://127.0.0.1/" }, "provider_unavailable", undefined, undefined],
      [201, '{"data":[]}', {}, "provider_unavailable", "201", '{"data":[]}'],
    ];
    for (const [status, body, headers, error, upstreamStatus, message] of cases) {
      stub.answer(() => ({ status, body, headers }));
      const said = upstreamStatus === undefined ? {} : { upstreamStatus, detail: { upstreamStatus, message } };
      expect([status, await test()]).toEqual([status, { status: 200, json: { ok: false, error, ...said } }]);
    }
    // (This app allows loopback for its stub, so the private addresses here are not loopback ones.)
    for (const baseUrl of ["https://10.0.0.5/v1", "https://169.254.169.254/latest", "https://[fd00::1]/v1"]) {
      const q = await mustCreate(owner, { name: baseUrl, baseUrl });
      expect([baseUrl, await api(app, owner, "POST", `/api/providers/${q.id}/test`)]).toEqual([
        baseUrl,
        { status: 200, json: { ok: false, error: "address_not_allowed" } },
      ]);
    }
  });

  it("PROVIDER_MAX_CONCURRENT_CALLS caps the app's calls to providers: one count for the provider routes and the model gateway", async () => {
    // A provider that answers only when told to.
    const waiting: http.ServerResponse[] = [];
    const server = http.createServer((_req, res) => void waiting.push(res));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const baseUrl = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`;
    const capped = await buildApp(
      { config: { ...app.deps.config, providerMaxConcurrentCalls: 2 }, db },
      { allowInsecureLocal: true, answerFloor: NO_ANSWER_FLOOR, agentWorker: false },
    );
    try {
      const owner = await signUp(capped, "cappy");
      const p = (await api(capped, owner, "POST", "/api/providers", providerBody({ baseUrl }))).json;
      const test = () => api(capped, owner, "POST", `/api/providers/${p.id}/test`);
      const [first, second] = [test(), test()];
      const deadline = Date.now() + 5000;
      while (waiting.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
      expect(waiting).toHaveLength(2);

      // A third call, through the routes or through the model gateway, finds no slot: refused at once.
      const started = Date.now();
      expect(await test()).toEqual({ status: 200, json: { ok: false, error: "provider_unavailable" } });
      await expect(capped.deps.models.listModels({ protocol: "openai_chat", baseUrl, apiKey: "sk-test-abcdefgh12345678" })).rejects.toMatchObject({
        code: "provider_unavailable",
      });
      expect(Date.now() - started).toBeLessThan(1000);
      expect(waiting).toHaveLength(2);

      for (const res of waiting.splice(0)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
      }
      expect([(await first).json, (await second).json]).toEqual([0, 0].map(() => ({ ok: true, mode: "list", latencyMs: expect.any(Number) })));
    } finally {
      await capped.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("refreshing the model list", () => {
  it("merges the names the provider lists into models, keeping the flags of the ones already there", async () => {
    const owner = await signUp(app, "rita");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: [{ name: "keep", reasoning: true, vision: true, contextTokens: 50000 }] });
    stub.answer(() => ({
      status: 200,
      body: JSON.stringify({
        data: [{ id: "new-1" }, { id: "keep" }, { id: "new-2" }, { id: 42 }, { id: "x".repeat(101) }, { id: "" }, { id: "bad\nname" }, { id: "new-1" }, {}, "loose"],
      }),
    }));
    const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/refresh`);
    const models = [model("keep", { reasoning: true, vision: true, contextTokens: 50000 }), model("new-1"), model("new-2")];
    expect(res).toEqual({ status: 200, json: { listed: ["new-1", "keep", "new-2"], provider: { ...p, models } } });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers).toEqual([{ ...p, models }]);
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
  });

  it("reads each protocol's list: data[].id for OpenAI and Anthropic, models[].name without models/ for Gemini", async () => {
    const owner = await signUp(app, "lena");
    const cases: Array<[string, unknown, string[]]> = [
      ["openai_responses", { object: "list", data: [{ id: "gpt-a", object: "model" }] }, ["gpt-a"]],
      ["anthropic", { data: [{ id: "claude-a", type: "model", display_name: "Claude A" }], has_more: false }, ["claude-a"]],
      ["gemini", { models: [{ name: "models/gemini-a", displayName: "A" }, { name: "gemini-b" }] }, ["gemini-a", "gemini-b"]],
      ["openai_chat", { unexpected: true }, []],
    ];
    for (const [protocol, body, names] of cases) {
      const p = await mustCreate(owner, { name: protocol, protocol, baseUrl: stub.baseUrl() });
      stub.answer(() => ({ status: 200, body: JSON.stringify(body) }));
      const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/refresh`);
      expect([protocol, res.status, res.json.listed, res.json.provider.models.map((m: any) => m.name)]).toEqual([protocol, 200, names, names]);
    }
  });

  it("never keeps more than 100 models: names past the hundredth are left out", async () => {
    const owner = await signUp(app, "hugo");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: Array.from({ length: 98 }, (_, i) => ({ name: `old${i}` })) });
    stub.answer(() => ({ status: 200, body: JSON.stringify({ data: ["n1", "n2", "n3", "n4"].map((id) => ({ id })) }) }));
    const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/refresh`);
    expect(res.json.listed).toEqual(["n1", "n2", "n3", "n4"]);
    expect(res.json.provider.models).toHaveLength(100);
    expect(res.json.provider.models.slice(-2).map((m: any) => m.name)).toEqual(["n1", "n2"]);
  });

  it("a huge list (~150 000 names, just under the 2 MiB limit) is answered quickly: only the first 1 000 names are looked at", async () => {
    const owner = await signUp(app, "huge");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl() });
    const N = 149_000;
    const ids = Array.from({ length: N }, (_, i) => i.toString(36).padStart(4, "0"));
    const body = JSON.stringify({ data: ids.map((id) => ({ id })) });
    expect(body.length).toBeLessThan(2 * 1024 * 1024);
    stub.answer(() => ({ status: 200, body }));
    const started = Date.now();
    const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/refresh`);
    const took = Date.now() - started;
    expect(res.status).toBe(200);
    expect(res.json.listed).toEqual(ids.slice(0, 1000));
    expect(res.json.provider.models.map((m: any) => m.name)).toEqual(ids.slice(0, 100));
    expect(took).toBeLessThan(2000);
  });

  it("an upstream refusal is 502 provider_rejected, a failure 502 provider_unavailable, a private address 400; nothing changes", async () => {
    const owner = await signUp(app, "fay");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: [{ name: "kept" }] });
    const refresh = (id: string) => api(app, owner, "POST", `/api/providers/${id}/models/refresh`);
    stub.answer(() => ({ status: 401, body: '{"error":"nope"}' }));
    expect(await refresh(p.id)).toEqual({ status: 502, json: { error: "provider_rejected" } });
    stub.answer(() => ({ status: 503, body: "<html>down</html>" }));
    expect(await refresh(p.id)).toEqual({ status: 502, json: { error: "provider_unavailable" } });
    const q = await mustCreate(owner, { name: "private", baseUrl: "https://192.168.0.10/v1" });
    expect(await refresh(q.id)).toEqual({ status: 400, json: { error: "address_not_allowed" } });
    expect((await api(app, owner, "GET", "/api/providers")).json.providers.map((x: any) => x.models.map((m: any) => m.name))).toEqual([["kept"], []]);
  });
});

describe("what the catalogue knows of a saved model reaches its owner, read when shown and never stored", () => {
  const ABILITIES = ["audioIn", "videoIn", "imageOut", "videoOut", "audioOut"];
  const byName = (models: Array<{ name: string }>) => Object.fromEntries(models.map((m) => [m.name, m as Record<string, unknown>]));

  it("tools: true for a model saved with nothing said that the catalogue knows to use them; an owner's or a learned value always wins; a model it does not know, or knows without tools, says nothing", async () => {
    const owner = await signUp(app, "tessa");
    const created = await mustCreate(owner, {
      baseUrl: stub.baseUrl(),
      models: [{ name: "deepseek-chat" }, { name: "DeepSeek/deepseek-chat-latest" }, { name: "qwen-max", tools: false }, { name: "qwen-plus", tools: true }, { name: "house-blend-tools" }, { name: "gemini-embedding-001" }],
    });
    const check = (models: Array<{ name: string }>) => {
      const m = byName(models);
      expect(Object.entries(m).map(([name, e]) => [name, e.tools, "tools" in e])).toEqual([
        ["deepseek-chat", true, true],
        ["DeepSeek/deepseek-chat-latest", true, true],
        ["qwen-max", false, true],
        ["qwen-plus", true, true],
        ["house-blend-tools", undefined, false],
        ["gemini-embedding-001", undefined, false],
      ]);
    };
    check(created.models);
    check((await api(app, owner, "GET", "/api/providers")).json.providers[0].models);
    // Not stored: the row says of tools only what its owner said.
    const stored = (await db.query<{ models: Array<Record<string, unknown>> }>("select models from providers where id = $1", [created.id])).rows[0]!.models;
    expect(stored.map((m) => [m.name, m.tools])).toEqual([
      ["deepseek-chat", undefined],
      ["DeepSeek/deepseek-chat-latest", undefined],
      ["qwen-max", false],
      ["qwen-plus", true],
      ["house-blend-tools", undefined],
      ["gemini-embedding-001", undefined],
    ]);
    // Its owner turns one off: off it reads, whatever the catalogue says.
    const off = await api(app, owner, "PATCH", `/api/providers/${created.id}`, { models: [{ name: "deepseek-chat", tools: false }, { name: "house-blend-tools" }] });
    expect(off.json.models.map((m: { name: string; tools?: boolean }) => [m.name, m.tools])).toEqual([
      ["deepseek-chat", false],
      ["house-blend-tools", undefined],
    ]);
    // A refresh that adds a name the catalogue knows shows it able at once.
    stub.answer(() => ({ status: 200, body: JSON.stringify({ data: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }) }));
    const refreshed = await api(app, owner, "POST", `/api/providers/${created.id}/models/refresh`);
    expect(refreshed.json.provider.models.map((m: { name: string; tools?: boolean }) => [m.name, m.tools])).toEqual([
      ["deepseek-chat", false],
      ["house-blend-tools", undefined],
      ["deepseek-reasoner", true],
    ]);
  });

  it("audioIn, videoIn, imageOut, videoOut, audioOut: only as true, only for a model the catalogue knows; never stored, never accepted back", async () => {
    const owner = await signUp(app, "uma");
    const created = await mustCreate(owner, {
      baseUrl: stub.baseUrl(),
      models: [{ name: "qwen-omni-turbo" }, { name: "gemini-2.5-pro" }, { name: "gemini-omni-1.1-flash" }, { name: "gemini-2.5-flash-image" }, { name: "deepseek-chat" }, { name: "my-audio-video-omni" }],
    });
    const m = byName(created.models);
    const has = (name: string) => ABILITIES.filter((a) => a in m[name]!).map((a) => [a, m[name]![a]]);
    expect(has("qwen-omni-turbo")).toEqual([["audioIn", true], ["videoIn", true], ["audioOut", true]]);
    expect(has("gemini-2.5-pro")).toEqual([["audioIn", true], ["videoIn", true]]);
    expect(has("gemini-omni-1.1-flash")).toEqual([["videoIn", true], ["videoOut", true]]);
    expect(has("gemini-2.5-flash-image")).toEqual([["imageOut", true]]);
    expect(has("deepseek-chat")).toEqual([]);
    // Nothing is guessed from a name's wording.
    expect(m["my-audio-video-omni"]).toEqual(model("my-audio-video-omni"));
    expect((await api(app, owner, "GET", "/api/providers")).json.providers[0].models).toEqual(created.models);
    const stored = (await db.query<{ models: Array<Record<string, unknown>> }>("select models from providers where id = $1", [created.id])).rows[0]!.models;
    expect(stored.flatMap((e) => ABILITIES.filter((a) => a in e))).toEqual([]);
    for (const a of ABILITIES) {
      expect([a, (await api(app, owner, "PATCH", `/api/providers/${created.id}`, { models: [{ name: "qwen-omni-turbo", [a]: true }] })).status]).toEqual([a, 400]);
    }
  });
});

describe("listing the provider's models", () => {
  const listed = (name: string, added = false) => ({ ...modelHints(name), name, added });

  it("answers the names the provider lists, in its order, with hints for each and whether it is already added; stores nothing", async () => {
    const owner = await signUp(app, "lily");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: [{ name: "gpt-4o", reasoning: true, contextTokens: 50000 }] });
    stub.answer(() => ({
      status: 200,
      body: JSON.stringify({
        data: [
          { id: "o3-mini" },
          { id: "gpt-4o" },
          { id: "  claude-sonnet-5-5  " },
          { id: "text-embedding-3-small" },
          { id: "house-blend-v2" },
          { id: 42 },
          { id: "x".repeat(101) },
          { id: "" },
          { id: "bad\nname" },
          { id: "o3-mini" },
          {},
          "loose",
        ],
      }),
    }));
    const before = await api(app, owner, "GET", "/api/providers");
    const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/list`);
    expect(res).toEqual({
      status: 200,
      json: {
        ok: true,
        listed: [listed("o3-mini"), listed("gpt-4o", true), listed("claude-sonnet-5-5"), listed("text-embedding-3-small"), listed("house-blend-v2")],
        source: "upstream",
      },
    });
    // Known to the catalogue: its display name, context and (from the lab) thinking levels; else guesses from the name.
    expect(res.json.listed[2]).toEqual({
      name: "claude-sonnet-5-5",
      vision: true,
      pdf: true,
      reasoning: true,
      chat: true,
      known: true,
      label: "Claude Sonnet 5.5",
      contextTokens: 1000000,
      reasoningLevels: ["low", "medium", "high", "xhigh", "max"],
      tools: true,
      added: false,
    });
    expect(res.json.listed.map((m: any) => [m.name, m.known, m.chat])).toEqual([
      ["o3-mini", true, true],
      ["gpt-4o", true, true],
      ["claude-sonnet-5-5", true, true],
      ["text-embedding-3-small", false, false],
      ["house-blend-v2", false, true],
    ]);
    expect(res.json.listed[4]).toEqual({ name: "house-blend-v2", vision: false, pdf: false, reasoning: false, chat: true, known: false, added: false });
    expect(stub.requests.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /v1/models"]);
    // Nothing was stored: the provider is as it was.
    expect(await api(app, owner, "GET", "/api/providers")).toEqual(before);
    expect((await api(app, owner, "POST", `/api/providers/${p.id}/models/list`, {})).json.listed).toHaveLength(5);
    expect(await api(app, owner, "GET", "/api/providers")).toEqual(before);
  });

  it("a listed model the catalogue knows comes with its abilities — tools, and what else it takes and answers with — only as true; an unknown name with none", async () => {
    const owner = await signUp(app, "abel");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl() });
    stub.answer(() => ({ status: 200, body: JSON.stringify({ data: [{ id: "qwen-omni-turbo" }, { id: "gemini-omni-1.1-flash" }, { id: "gemini-2.5-flash-image" }, { id: "my-tools-audio-model" }] }) }));
    const able = (await api(app, owner, "POST", `/api/providers/${p.id}/models/list`)).json.listed;
    expect(able[0]).toEqual({ name: "qwen-omni-turbo", vision: true, pdf: false, reasoning: false, chat: true, known: true, label: "Qwen-Omni Turbo", contextTokens: 32768, tools: true, audioIn: true, videoIn: true, audioOut: true, added: false });
    expect(able[1]).toMatchObject({ known: true, videoIn: true, videoOut: true });
    expect(able[1]).not.toHaveProperty("tools");
    expect(able[2]).toMatchObject({ known: true, imageOut: true });
    expect(able[3]).toEqual({ name: "my-tools-audio-model", vision: false, pdf: false, reasoning: false, chat: false, known: false, added: false });
  });

  it("added follows the saved models; a body that is no object is 400", async () => {
    const owner = await signUp(app, "addy");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl() });
    stub.answer(() => ({ status: 200, body: JSON.stringify({ data: [{ id: "a" }, { id: "b" }] }) }));
    const added = async () => (await api(app, owner, "POST", `/api/providers/${p.id}/models/list`)).json.listed.map((m: any) => [m.name, m.added]);
    expect(await added()).toEqual([["a", false], ["b", false]]);
    expect((await api(app, owner, "PATCH", `/api/providers/${p.id}`, { models: [{ name: "b" }, { name: "c" }] })).status).toBe(200);
    expect(await added()).toEqual([["a", false], ["b", true]]);
    for (const body of [[], [1]]) expect([body, (await api(app, owner, "POST", `/api/providers/${p.id}/models/list`, body)).status]).toEqual([body, 400]);
  });

  it("at most 500 entries, from the first 1 000 the provider lists; a huge list is answered quickly", async () => {
    const owner = await signUp(app, "many");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl() });
    const ids = Array.from({ length: 149_000 }, (_, i) => i.toString(36).padStart(4, "0"));
    const body = JSON.stringify({ data: ids.map((id) => ({ id })) });
    expect(body.length).toBeLessThan(2 * 1024 * 1024);
    stub.answer(() => ({ status: 200, body }));
    const started = Date.now();
    const res = await api(app, owner, "POST", `/api/providers/${p.id}/models/list`);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res.json.listed.map((m: any) => m.name)).toEqual(ids.slice(0, 500));
    // Past the first 1 000 entries nothing is looked at, even when none of those is a usable name.
    stub.answer(() => ({ status: 200, body: JSON.stringify({ data: [...Array.from({ length: 1000 }, () => ({ id: "" })), { id: "late" }] }) }));
    expect(await api(app, owner, "POST", `/api/providers/${p.id}/models/list`)).toEqual({ status: 200, json: { ok: true, listed: [], source: "upstream" } });
  });

  it("a failure is answered as 测试连接 answers it (a 200, ok false, the code and the provider's status), with the code refresh would give", async () => {
    const owner = await signUp(app, "lars");
    const p = await mustCreate(owner, { baseUrl: stub.baseUrl(), models: [{ name: "kept" }] });
    const call = (route: string, id = p.id) => api(app, owner, "POST", `/api/providers/${id}/${route}`);
    const cases: Array<[number, string, Record<string, string>]> = [
      [401, '{"error":"bad key"}', {}],
      [403, '{"error":"forbidden"}', {}],
      [404, '{"error":"no such path"}', {}],
      [405, '{"error":"method not allowed"}', {}],
      [429, '{"error":"slow down"}', {}],
      [500, '{"error":"oops"}', {}],
      [200, "<html>not json</html>", { "content-type": "text/html" }],
      [302, "", { location: "https://127.0.0.1/" }],
    ];
    for (const [status, body, headers] of cases) {
      stub.answer(() => ({ status, body, headers }));
      const [list, test, refresh] = [await call("models/list"), await call("test"), await call("models/refresh")];
      expect([status, list]).toEqual([status, test]);
      expect([status, list.status, list.json.ok, list.json.error]).toEqual([status, 200, false, refresh.json.error]);
      expect(Object.keys(list.json).sort()).toEqual(status === 302 ? ["error", "ok"] : ["detail", "error", "ok", "upstreamStatus"]);
    }
    // (This host is in no catalogue: a 404 stays a failure. provider-catalog.test.ts has the catalogue's.)
    stub.answer(() => ({ status: 404, body: "{}" }));
    expect(await call("models/list")).toEqual({
      status: 200,
      json: { ok: false, error: "provider_unavailable", upstreamStatus: "404", detail: { upstreamStatus: "404", message: "{}" } },
    });
    const q = await mustCreate(owner, { name: "private", baseUrl: "https://192.168.0.10/v1" });
    expect(await call("models/list", q.id)).toEqual({ status: 200, json: { ok: false, error: "address_not_allowed" } });
    expect((await call("models/refresh", q.id)).json.error).toBe("address_not_allowed");
    // Nothing changed.
    expect((await api(app, owner, "GET", "/api/providers")).json.providers.map((x: any) => x.models.map((m: any) => m.name))).toEqual([["kept"], []]);
  });
});

describe("an Agent's provider model", () => {
  it("a stored models value that is malformed counts as no models: listing works and choosing one is 400, not 500", async () => {
    const owner = await signUp(app, "mal");
    const insert = async (name: string, models: string) =>
      (
        await db.query<{ id: string }>(
          `insert into providers (owner_id, name, protocol, base_url, key_cipher, key_last4, models)
           values ($1, $2, 'openai_chat', 'https://api.example.com/v1', '\\x00', 'abcd', $3::jsonb) returning id`,
          [owner.id, name, models],
        )
      ).rows[0]!.id;
    const object = await insert("object", '{"name":"m"}');
    const text = await insert("text", '"m"');
    const mixed = await insert("mixed", '[1, {"name": 5}, {"name": "m", "reasoning": "yes"}, {"name": "ok", "vision": false, "pdf": false, "reasoning": true, "contextTokens": 4000}]');

    const listed = (await api(app, owner, "GET", "/api/providers")).json.providers;
    expect(listed.map((p: any) => [p.name, p.models.map((m: any) => m.name)])).toEqual([["object", []], ["text", []], ["mixed", ["ok"]]]);
    expect((await createAgent(app, owner, { model: useModel(object, "m") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: useModel(text, "m") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: useModel(mixed, "m") })).status).toBe(400);
    expect((await createAgent(app, owner, { model: useModel(mixed, "ok"), reasoning: "high" })).status).toBe(201);
  });
});
