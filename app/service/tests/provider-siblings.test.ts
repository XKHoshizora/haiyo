import { readFileSync } from "node:fs";
import type http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { catalogueModels } from "../src/providers/catalogue.ts";
import { guardedFetch } from "../src/providers/guard.ts";
import { hostUnderSuffix, MIN_SUFFIX_LABELS } from "../src/providers/host-suffix.ts";
import { MAX_SIBLING_REQUESTS, siblingListingUrls, type SiblingTable } from "../src/providers/listing-siblings.ts";
import { createProviderProbe, PROBE_GUARD, ProviderCallError } from "../src/providers/probe.ts";
import type { Resolve } from "../src/providers/guard.ts";
import { holdsKeyPiece } from "../src/providers/upstream-detail.ts";
import { createSlots } from "../src/slots.ts";
import { api, signUp, type Actor } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { protocolStub, type ProtocolStub, type StubHandler } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * A provider's model list when its chat address does not offer one (README "Model providers", `POST /api/providers/:id/models/list`):
 * a short fixed set of sibling listing paths on the SAME origin is tried with the same key (src/providers/listing-siblings.json).
 */

const KEY = "sk-live-Q7f3K9pX2mZ8vB4n";
const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const NOT_SUPPORT = { code: "InvalidParameter", message: "Not support" };
const models = (...ids: string[]) => ({ object: "list", data: ids.map((id) => ({ id })) });
const origin = (stub: ProtocolStub) => new URL(stub.baseUrl).origin;

describe("the sibling table (data) and the host suffix rule", () => {
  const table = JSON.parse(readFileSync(new URL("../src/providers/listing-siblings.json", import.meta.url), "utf8")) as SiblingTable;

  it("hostUnderSuffix: the suffix itself or a name under it, on a label boundary", () => {
    expect([
      hostUnderSuffix("maas.aliyuncs.com", "maas.aliyuncs.com"),
      hostUnderSuffix("ws-1.cn-beijing.maas.aliyuncs.com", "maas.aliyuncs.com"),
      hostUnderSuffix("maas.aliyuncs.com.evil.example", "maas.aliyuncs.com"),
      hostUnderSuffix("xmaas.aliyuncs.com", "maas.aliyuncs.com"),
      hostUnderSuffix("aliyuncs.com", "maas.aliyuncs.com"),
      hostUnderSuffix("evil-maas.aliyuncs.com", "maas.aliyuncs.com"),
    ]).toEqual([true, true, false, false, false, false]);
  });

  it("every committed rule: lower-case suffixes of at least three labels, listing paths that start with / and end in /models; at most MAX_SIBLING_REQUESTS candidates for any host", () => {
    expect(table.rules.length).toBeGreaterThan(0);
    for (const rule of table.rules) {
      expect(rule.paths.length).toBeGreaterThan(0);
      for (const s of rule.hostSuffixes) expect([s, s === s.toLowerCase(), s.split(".").length >= MIN_SUFFIX_LABELS, /^[a-z0-9.-]+$/.test(s)]).toEqual([s, true, true, true]);
      for (const path of rule.paths) expect([path, /^\/[a-z0-9/_.-]*\/models$/.test(path)]).toEqual([path, true]);
    }
    for (const path of table.generic) expect([path, /^\/[a-z0-9/_.-]*\/models$/.test(path)]).toEqual([path, true]);
    expect(table.generic).toEqual(["/v1/models"]);
    expect(MAX_SIBLING_REQUESTS).toBeGreaterThanOrEqual(2);
    expect(MAX_SIBLING_REQUESTS).toBeLessThanOrEqual(3);
  });

  it("siblingListingUrls: the Aliyun family first lists /compatible-mode/v1/models, then the generic /v1/models; same origin only", () => {
    const ws = "https://ws-abc123.cn-beijing.maas.aliyuncs.com";
    expect(siblingListingUrls(`${ws}/apps/anthropic/v1`)).toEqual([`${ws}/compatible-mode/v1/models`, `${ws}/v1/models`]);
    for (const host of ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com", "maas.aliyuncs.com"]) {
      expect([host, siblingListingUrls(`https://${host}/api/v2/apps/anthropic`)]).toEqual([
        host,
        [`https://${host}/compatible-mode/v1/models`, `https://${host}/v1/models`],
      ]);
    }
    // A port stays; the scheme stays.
    expect(siblingListingUrls("https://ws-1.maas.aliyuncs.com:8443/x/v1")).toEqual([
      "https://ws-1.maas.aliyuncs.com:8443/compatible-mode/v1/models",
      "https://ws-1.maas.aliyuncs.com:8443/v1/models",
    ]);
  });

  it("siblingListingUrls: look-alike hosts get only the generic one; a base that already is /v1 gets none of its own listing again", () => {
    for (const host of ["maas.aliyuncs.com.evil.example", "xmaas.aliyuncs.com", "aliyuncs.com", "www.aliyuncs.com", "dashscope.aliyuncs.com.evil.example", "other.example"]) {
      expect([host, siblingListingUrls(`https://${host}/apps/anthropic/v1`)]).toEqual([host, [`https://${host}/v1/models`]]);
    }
    expect(siblingListingUrls("https://other.example/v1")).toEqual([]);
    expect(siblingListingUrls("https://ws-1.maas.aliyuncs.com/v1")).toEqual(["https://ws-1.maas.aliyuncs.com/compatible-mode/v1/models"]);
    expect(siblingListingUrls("https://api.example.com/api/v1")).toEqual(["https://api.example.com/v1/models"]);
    expect(siblingListingUrls("not a url")).toEqual([]);
  });

  it("siblingListingUrls: never more than MAX_SIBLING_REQUESTS, whatever a table holds", () => {
    const many: SiblingTable = { rules: [{ hostSuffixes: ["a.b.example"], paths: ["/1/models", "/2/models", "/3/models", "/4/models", "/5/models"] }], generic: ["/v1/models"] };
    expect(siblingListingUrls("https://x.a.b.example/y", many)).toHaveLength(MAX_SIBLING_REQUESTS);
  });
});

describe("the catalogue by host suffix", () => {
  it("a workspace host under maas.aliyuncs.com gets the Aliyun catalogue's models; look-alikes and the bare family get none", () => {
    const aliyun = catalogueModels("https://dashscope.aliyuncs.com/compatible-mode/v1")!;
    expect(aliyun.length).toBeGreaterThan(10);
    expect(catalogueModels("https://ws-abc123.cn-beijing.maas.aliyuncs.com/apps/anthropic/v1")).toEqual(aliyun);
    expect(catalogueModels("https://WS-1.MAAS.aliyuncs.com:8443/x")).toEqual(aliyun);
    for (const other of [
      "https://maas.aliyuncs.com.evil.example/v1",
      "https://xmaas.aliyuncs.com/v1",
      "https://evil-maas.aliyuncs.com/v1",
      "https://aliyuncs.com/v1",
      "https://www.aliyuncs.com/v1",
      "https://cn-beijing.aliyuncs.com/v1",
      "https://example.com/v1",
    ]) {
      expect([other, catalogueModels(other)]).toEqual([other, null]);
    }
  });

  it("an exact catalogue host still wins over a suffix rule (the token-plan hosts keep their own models)", () => {
    const plan = catalogueModels("https://token-plan.cn-beijing.maas.aliyuncs.com/v1")!;
    expect(plan).toHaveLength(29);
    expect(plan).not.toEqual(catalogueModels("https://dashscope.aliyuncs.com/v1"));
  });
});

// --- the probe, with a table of our own (the loopback stub's host is not an Aliyun host) -------------------------------

let stub: ProtocolStub;
let other: ProtocolStub;
beforeAll(async () => {
  stub = await protocolStub();
  other = await protocolStub();
});
afterAll(async () => {
  await stub.close();
  await other.close();
});
beforeEach(() => {
  stub.reset();
  other.reset();
});

const probeWith = (table?: SiblingTable) => createProviderProbe(guardedFetch({ ...PROBE_GUARD, calls: createSlots(8), allowInsecureLocal: true }), table);
const loopbackTable = (paths: string[]): SiblingTable => ({ rules: [{ hostSuffixes: ["127.0.0.1"], paths }], generic: [] });
const target = (path: string, protocol: "anthropic" | "openai_chat" = "anthropic") => ({ protocol, baseUrl: `${origin(stub)}${path}`, apiKey: KEY });
const seen = () => stub.requests.map((r) => `${r.method} ${r.path}`);
/** Answers by path: the table's entries, else 404 "Not support". */
const byPath = (answers: Record<string, (res: http.ServerResponse) => void>): StubHandler => (req, res) => (answers[req.path] ?? ((r) => send(r, 404, NOT_SUPPORT)))(res);
const failure = async (p: Promise<unknown>) => (await p.then(() => null, (e: unknown) => e)) as ProviderCallError;

describe("listModels with discovery (the probe)", () => {
  it("the measured case: /models is 404 Not support, the sibling lists: the names come from the sibling, in OpenAI form with Bearer; the base was asked first, in the protocol's own headers", async () => {
    stub.answer(byPath({ "/compatible-mode/v1/models": (res) => send(res, 200, models("qwen-max", "qwen-plus")) }));
    let sibling = 0;
    const names = await probeWith(loopbackTable(["/compatible-mode/v1/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => void sibling++ });
    expect([names, sibling]).toEqual([["qwen-max", "qwen-plus"], 1]);
    expect(seen()).toEqual(["GET /apps/anthropic/v1/models", "GET /compatible-mode/v1/models"]);
    const [first, second] = stub.requests;
    expect([first!.headers["x-api-key"], first!.headers.authorization]).toEqual([KEY, undefined]);
    expect([second!.headers.authorization, second!.headers["x-api-key"]]).toEqual([`Bearer ${KEY}`, undefined]);
  });

  it("without a discovery request the probe is as it was: one request, the base's failure", async () => {
    stub.answer(byPath({ "/compatible-mode/v1/models": (res) => send(res, 200, models("a")) }));
    const err = await failure(probeWith(loopbackTable(["/compatible-mode/v1/models"])).listModels(target("/apps/anthropic/v1")));
    expect([err.code, err.upstreamStatus, seen()]).toEqual(["provider_unavailable", 404, ["GET /apps/anthropic/v1/models"]]);
  });

  it("a base that lists is asked once, whatever else the table says, and never reports a sibling (also an empty list, and the OpenAI case)", async () => {
    for (const body of [models("a", "b"), models()]) {
      stub.reset();
      stub.answer(byPath({ "/v1/models": (res) => send(res, 200, body) }));
      let sibling = 0;
      const names = await probeWith(loopbackTable(["/compatible-mode/v1/models"])).listModels(target("/v1", "openai_chat"), { onSibling: () => void sibling++ });
      expect([names.length, sibling, seen()]).toEqual([(body as { data: unknown[] }).data.length, 0, ["GET /v1/models"]]);
    }
  });

  it("a 405 and a 200 that is no list (an HTML page, JSON without data) also look further; any other failure does not", async () => {
    const siblingList = (res: http.ServerResponse) => send(res, 200, models("found"));
    const cases: Array<[string, (res: http.ServerResponse) => void, boolean]> = [
      ["405", (res) => send(res, 405, "no"), true],
      ["html 200", (res) => send(res, 200, "<html>hi</html>", { "content-type": "text/html" }), true],
      ["json 200 without data", (res) => send(res, 200, { object: "thing" }), true],
      ["500", (res) => send(res, 500, "boom"), false],
      ["429", (res) => send(res, 429, "slow down"), false],
      ["401", (res) => send(res, 401, "no key"), false],
      ["400", (res) => send(res, 400, "bad"), false],
    ];
    for (const [label, base, looks] of cases) {
      stub.reset();
      stub.answer(byPath({ "/a/v1/models": base, "/s/models": siblingList }));
      const run = probeWith(loopbackTable(["/s/models"])).listModels(target("/a/v1"), { onSibling: () => {} });
      if (looks) expect([label, await run, seen().length]).toEqual([label, ["found"], 2]);
      else expect([label, (await failure(run)).code, seen().length]).toEqual([label, expect.any(String), 1]);
    }
  });

  it("no sibling lists either: the base's own failure (its status and its text), within the bound; MAX_SIBLING_REQUESTS candidates at most", async () => {
    stub.answer(byPath({}));
    const paths = Array.from({ length: 8 }, (_, i) => `/s${i}/models`);
    const err = await failure(probeWith(loopbackTable(paths)).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} }));
    expect([err.code, err.upstreamStatus]).toEqual(["provider_unavailable", 404]);
    expect(err.detail).toEqual({ upstreamStatus: "404", message: "Not support" });
    expect(stub.requests).toHaveLength(1 + MAX_SIBLING_REQUESTS);
    expect(seen().slice(1)).toEqual(paths.slice(0, MAX_SIBLING_REQUESTS).map((p) => `GET ${p}`));
  });

  it("a sibling that refuses the key (401, 403) stops further tries, but is never a statement about the key: the answer is the base's own failure", async () => {
    for (const status of [401, 403]) {
      stub.reset();
      stub.answer(byPath({ "/s1/models": (res) => send(res, status, { error: { message: "bad key" } }), "/s2/models": (res) => send(res, 200, models("late")) }));
      const err = await failure(probeWith(loopbackTable(["/s1/models", "/s2/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} }));
      expect([status, err.code, err.upstreamStatus, seen()]).toEqual([status, "provider_unavailable", 404, ["GET /apps/anthropic/v1/models", "GET /s1/models"]]);
      expect(err.detail).toEqual({ upstreamStatus: "404", message: "Not support" });
    }
  });

  it("the base's own 401/403 still says the key was refused (and nothing else is tried)", async () => {
    stub.answer(byPath({ "/apps/anthropic/v1/models": (res) => send(res, 401, { error: { message: "bad key" } }), "/s1/models": (res) => send(res, 200, models("late")) }));
    const err = await failure(probeWith(loopbackTable(["/s1/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} }));
    expect([err.code, err.upstreamStatus, seen()]).toEqual(["provider_rejected", 401, ["GET /apps/anthropic/v1/models"]]);
  });

  it("a 200 that is not a usable list is not offered in every form: the failure with the upstream's own words once no sibling lists", async () => {
    const forms: Array<[string, (res: http.ServerResponse) => void, string]> = [
      ["json without a list", (res) => send(res, 200, NOT_SUPPORT), "Not support"],
      ["json, data is no array", (res) => send(res, 200, { data: "x", message: "odd" }), "odd"],
      ["html", (res) => send(res, 200, "<html>hello</html>", { "content-type": "text/html" }), "<html>hello</html>"],
    ];
    for (const [label, answer, said] of forms) {
      stub.reset();
      stub.answer(byPath({ "/a/v1/models": answer }));
      const err = await failure(probeWith(loopbackTable(["/s1/models"])).listModels(target("/a/v1"), { onSibling: () => {} }));
      expect([label, err.code, err.upstreamStatus, err.detail, seen()]).toEqual([label, "provider_unavailable", 200, { upstreamStatus: "200", message: said }, ["GET /a/v1/models", "GET /s1/models"]]);
    }
  });

  it("a list that cannot be read to its end carries no status (it is not a 200 that is no list)", async () => {
    stub.answer(
      byPath({
        "/a/v1/models": (res) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(`{"data":[{"id":"${"x".repeat(PROBE_GUARD.maxResponseBytes + 10)}"}]}`);
        },
      }),
    );
    const err = await failure(probeWith(loopbackTable([])).listModels(target("/a/v1"), { onSibling: () => {} }));
    expect([err.code, err.upstreamStatus]).toEqual(["provider_unavailable", undefined]);
  });

  it("every sibling is resolved and checked again: a name that turns private between the requests is address_not_allowed, one request sent", async () => {
    const answers = [["127.0.0.1"], ["10.0.0.5"]];
    const resolve: Resolve = async () => (answers.shift() ?? ["10.0.0.5"]).map((address) => ({ address, family: 4 }));
    const table: SiblingTable = { rules: [{ hostSuffixes: ["rebind.test"], paths: ["/s1/models"] }], generic: [] };
    const probe = createProviderProbe(guardedFetch({ ...PROBE_GUARD, calls: createSlots(8), allowInsecureLocal: true, resolve }), table);
    const port = new URL(stub.baseUrl).port;
    const err = await failure(probe.listModels({ protocol: "anthropic", baseUrl: `http://rebind.test:${port}/a/v1`, apiKey: KEY }, { onSibling: () => {} }));
    expect([err.code, seen()]).toEqual(["address_not_allowed", ["GET /a/v1/models"]]);
  });

  it("one deadline covers the whole listing: a sibling that never answers ends it, with the base's failure", async () => {
    stub.answer((req, res) => {
      if (req.path === "/s1/models") return; // never answers
      send(res, 404, NOT_SUPPORT);
    });
    const probe = createProviderProbe(guardedFetch({ ...PROBE_GUARD, calls: createSlots(8), allowInsecureLocal: true }), loopbackTable(["/s1/models"]), 400);
    const started = Date.now();
    const err = await failure(probe.listModels(target("/a/v1"), { onSibling: () => {} }));
    expect([err.code, err.upstreamStatus, Date.now() - started < 5000]).toEqual(["provider_unavailable", 404, true]);
  });

  it("a sibling that fails otherwise (500, an oversize body) is skipped for the next one; both failing: the base's failure, and the one after the bound is not reached", async () => {
    const oversize = (res: http.ServerResponse) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"data":[{"id":"${"x".repeat(PROBE_GUARD.maxResponseBytes + 10)}"}]}`);
    };
    stub.answer(byPath({ "/s1/models": (res) => send(res, 500, "oops"), "/s2/models": oversize, "/s3/models": (res) => send(res, 200, models("third")) }));
    const err = await failure(probeWith(loopbackTable(["/s1/models", "/s2/models", "/s3/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} }));
    expect([err.code, err.upstreamStatus, seen()]).toEqual(["provider_unavailable", 404, ["GET /apps/anthropic/v1/models", "GET /s1/models", "GET /s2/models"]]);
    stub.reset();
    stub.answer(byPath({ "/s1/models": (res) => send(res, 500, "oops"), "/s2/models": (res) => send(res, 200, models("second")) }));
    expect(await probeWith(loopbackTable(["/s1/models", "/s2/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} })).toEqual(["second"]);
  });

  it("a sibling that answers an empty list is not a list; the next is tried", async () => {
    stub.answer(byPath({ "/s1/models": (res) => send(res, 200, models()), "/s2/models": (res) => send(res, 200, models("second")) }));
    expect(await probeWith(loopbackTable(["/s1/models", "/s2/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} })).toEqual(["second"]);
  });

  it("a sibling redirecting to another origin: refused, nothing is sent there; the base's failure stands", async () => {
    stub.answer(byPath({ "/s1/models": (res) => send(res, 302, "", { location: `${origin(other)}/steal/models` }) }));
    other.answer((_req, res) => send(res, 200, models("stolen")));
    const err = await failure(probeWith(loopbackTable(["/s1/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} }));
    expect([err.code, err.upstreamStatus]).toEqual(["provider_unavailable", 404]);
    expect(other.requests).toEqual([]);
    expect(seen()).toEqual(["GET /apps/anthropic/v1/models", "GET /s1/models"]);
  });

  it("the base redirecting away is not followed either, and a candidate on another origin is never built", async () => {
    stub.answer((_req, res) => send(res, 301, "", { location: `${origin(other)}/v1/models` }));
    const err = await failure(probeWith(loopbackTable(["/s1/models"])).listModels(target("/apps/anthropic/v1"), { onSibling: () => {} }));
    expect(err.code).toBe("provider_unavailable");
    expect(other.requests).toEqual([]);
    // A table path cannot name another origin: the URL is built from the base's own origin.
    expect(siblingListingUrls("https://ws-1.maas.aliyuncs.com/x/v1", { rules: [{ hostSuffixes: ["maas.aliyuncs.com"], paths: ["//evil.example/models", "/models"] }], generic: [] })).toEqual([
      "https://ws-1.maas.aliyuncs.com/models",
    ]);
  });

  it("the guard still decides: a refused address is address_not_allowed before any sibling is built", async () => {
    const err = await failure(createProviderProbe(guardedFetch({ ...PROBE_GUARD, calls: createSlots(8) })).listModels({ protocol: "anthropic", baseUrl: "https://10.0.0.5/apps/anthropic/v1", apiKey: KEY }, { onSibling: () => {} }));
    expect(err.code).toBe("address_not_allowed");
  });
});

// --- the route ---------------------------------------------------------------------------------------------------------

const lines: string[] = [];
const { app } = useApp({ allowInsecureLocal: true, logStream: { write: (line) => void lines.push(line) } });
beforeEach(() => {
  lines.length = 0;
});
async function provider(owner: Actor, over: Record<string, unknown> = {}) {
  const res = await api(app, owner, "POST", "/api/providers", providerBody({ apiKey: KEY, ...over }));
  if (res.status !== 201) throw new Error(`create provider: ${res.status} ${JSON.stringify(res.json)}`);
  return res.json as { id: string };
}
const listOf = async (owner: Actor, id: string) => {
  const res = await app.inject({ method: "POST", url: `/api/providers/${id}/models/list`, headers: { cookie: owner.cookie } });
  return { status: res.statusCode, json: JSON.parse(res.body), raw: res.body };
};

/** The real probe behind a fetch that sends https://api.deepseek.com (a host the catalogue knows) to the local stub. */
const toStub = (inner: typeof fetch): typeof fetch => ((url: string, init?: RequestInit) => inner(String(url).replace("https://api.deepseek.com", origin(stub)), init)) as typeof fetch;
describe("a 200 that is no list, through the real probe (the catalogue host and an unknown one)", () => {
  const rewritten = useApp({ allowInsecureLocal: true, providerProbe: createProviderProbe(toStub(guardedFetch({ ...PROBE_GUARD, calls: createSlots(8), allowInsecureLocal: true }))) });
  const listVia = async (owner: Actor, id: string) => (await api(rewritten.app, owner, "POST", `/api/providers/${id}/models/list`)).json;

  it("JSON without a list and HTML alike: the catalogue's models at a host it knows; at an unknown host the failure with the upstream's words", async () => {
    const owner = await signUp(rewritten.app, "gateway200");
    const known = (await api(rewritten.app, owner, "POST", "/api/providers", providerBody({ name: "ds", apiKey: KEY, baseUrl: "https://api.deepseek.com/v1" }))).json.id as string;
    const unknown = (await api(rewritten.app, owner, "POST", "/api/providers", providerBody({ name: "unk", apiKey: KEY, baseUrl: `${origin(stub)}/v1` }))).json.id as string;
    for (const answer of [(res: http.ServerResponse) => send(res, 200, NOT_SUPPORT), (res: http.ServerResponse) => send(res, 200, "<html>hi</html>", { "content-type": "text/html" })]) {
      stub.reset();
      stub.answer(byPath({ "/v1/models": answer }));
      const viaCatalogue = await listVia(owner, known);
      expect([viaCatalogue.ok, viaCatalogue.source, viaCatalogue.listed.length > 0]).toEqual([true, "catalogue", true]);
      const failed = await listVia(owner, unknown);
      expect([failed.ok, failed.error, failed.upstreamStatus]).toEqual([false, "provider_unavailable", "200"]);
    }
    stub.reset();
    stub.answer(byPath({ "/v1/models": (res) => send(res, 200, NOT_SUPPORT) }));
    expect((await listVia(owner, unknown)).detail).toEqual({ upstreamStatus: "200", message: "Not support" });
  });
});

describe("models/list on an address whose /models is not offered (the route, the generic sibling on the same origin)", () => {
  it("the measured case: a sibling list is returned, marked source \"sibling\", with the catalogue's hints; the base is never changed", async () => {
    const owner = await signUp(app, "bailian");
    const p = await provider(owner, { protocol: "anthropic", baseUrl: `${origin(stub)}/apps/anthropic/v1`, models: [{ name: "qwen-max" }] });
    stub.answer(byPath({ "/v1/models": (res) => send(res, 200, models("qwen-max", "text-embedding-v3", "claude-sonnet-5-5")) }));
    const res = await listOf(owner, p.id);
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(res.json.source).toBe("sibling");
    expect(res.json.listed.map((m: { name: string; added: boolean; chat: boolean }) => [m.name, m.added, m.chat])).toEqual([
      ["qwen-max", true, true],
      ["text-embedding-v3", false, false],
      ["claude-sonnet-5-5", false, true],
    ]);
    expect(seen()).toEqual(["GET /apps/anthropic/v1/models", "GET /v1/models"]);
    // The stored address is what it was.
    const mine = await api(app, owner, "GET", "/api/providers");
    expect(mine.json.providers[0].baseUrl).toBe(`${origin(stub)}/apps/anthropic/v1`);
  });

  it("nothing lists: the failure as before, 404 with the upstream's own text, owner only; the request count is within the bound", async () => {
    const owner = await signUp(app, "nolist");
    const p = await provider(owner, { protocol: "anthropic", baseUrl: `${origin(stub)}/apps/anthropic/v1` });
    stub.answer(byPath({}));
    const res = await listOf(owner, p.id);
    expect(res.json).toEqual({ ok: false, error: "provider_unavailable", upstreamStatus: "404", detail: { upstreamStatus: "404", message: "Not support" } });
    expect(stub.requests.length).toBeLessThanOrEqual(1 + MAX_SIBLING_REQUESTS);
    expect(stub.requests).toHaveLength(2);
  });

  it("the guessed sibling refuses the key: it says nothing about the key, the answer is the address's own 404", async () => {
    const owner = await signUp(app, "refused");
    const p = await provider(owner, { protocol: "anthropic", baseUrl: `${origin(stub)}/apps/anthropic/v1` });
    stub.answer(byPath({ "/v1/models": (res) => send(res, 401, { error: { message: "invalid api key" } }) }));
    expect((await listOf(owner, p.id)).json).toEqual({ ok: false, error: "provider_unavailable", upstreamStatus: "404", detail: { upstreamStatus: "404", message: "Not support" } });
  });

  it("a redirect from the sibling to another origin: the base's failure answers, the other origin received nothing", async () => {
    const owner = await signUp(app, "redirected");
    const p = await provider(owner, { protocol: "anthropic", baseUrl: `${origin(stub)}/apps/anthropic/v1` });
    stub.answer(byPath({ "/v1/models": (res) => send(res, 307, "", { location: `${origin(other)}/v1/models` }) }));
    other.answer((_req, res) => send(res, 200, models("stolen")));
    const res = await listOf(owner, p.id);
    expect([res.json.ok, res.json.upstreamStatus]).toEqual([false, "404"]);
    expect(other.requests).toEqual([]);
  });

  it("an OpenAI-type provider whose /models works: exactly one request, source upstream (no behaviour change); a failing /v1 base does not get its own address asked twice", async () => {
    const owner = await signUp(app, "plain");
    const p = await provider(owner, { baseUrl: stub.baseUrl });
    stub.answer(byPath({ "/v1/models": (res) => send(res, 200, models("a", "b")) }));
    const ok = await listOf(owner, p.id);
    expect([ok.json.source, stub.requests.length]).toEqual(["upstream", 1]);
    stub.reset();
    stub.answer(byPath({}));
    const down = await listOf(owner, p.id);
    expect([down.json.ok, down.json.upstreamStatus, stub.requests.length]).toEqual([false, "404", 1]);
  });

  it("the key is in no log line, the sibling's text in none, and the log says what it said before", async () => {
    const owner = await signUp(app, "quiet");
    const p = await provider(owner, { protocol: "anthropic", baseUrl: `${origin(stub)}/apps/anthropic/v1` });
    stub.answer(byPath({ "/v1/models": (res) => send(res, 500, { error: { message: "sibling secret words" } }) }));
    await listOf(owner, p.id);
    const log = lines.join("\n");
    expect([holdsKeyPiece(log, KEY), log.includes("sibling secret words"), log.includes("Not support"), log.includes("/v1/models")]).toEqual([false, false, false, false]);
    const failures = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => e.msg === "provider call failed");
    expect(failures).toHaveLength(1);
    expect(Object.keys(failures[0]!).filter((k) => !["level", "time", "pid", "hostname", "reqId", "msg"].includes(k)).sort()).toEqual(["error", "protocol", "providerId", "upstreamStatus"]);
  });

  it("test connection (without a model) and the refresh do not discover: one request each", async () => {
    const owner = await signUp(app, "plainer");
    const p = await provider(owner, { protocol: "anthropic", baseUrl: `${origin(stub)}/apps/anthropic/v1` });
    stub.answer(byPath({ "/v1/models": (res) => send(res, 200, models("sib")) }));
    const test = await app.inject({ method: "POST", url: `/api/providers/${p.id}/test`, headers: { cookie: owner.cookie } });
    expect([JSON.parse(test.body).ok, stub.requests.length]).toEqual([false, 1]);
    stub.requests.length = 0;
    const refresh = await app.inject({ method: "POST", url: `/api/providers/${p.id}/models/refresh`, headers: { cookie: owner.cookie } });
    expect([refresh.statusCode, stub.requests.length]).toEqual([502, 1]);
  });
});
