import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { DNS_NAME, formatCatalog, reduceProviders } from "../scripts/update-model-catalog.mjs";
import { catalogueModels } from "../src/providers/catalogue.ts";
import { modelHints } from "../src/providers/hints.ts";
import { ProviderCallError, type ProviderProbe } from "../src/providers/probe.ts";
import { api, signUp } from "./helpers/actors.ts";
import { useApp } from "./helpers/harness.ts";
import { providerBody } from "./helpers/providers.ts";

/**
 * The catalogue's providers by their API host (src/providers/provider-catalog.json, `npm run catalog:update`): what
 * `POST /api/providers/:id/models/list` offers when the provider's address has no model list (a 404 or 405).
 */

describe("reduceProviders (the update script)", () => {
  const API = {
    deepseek: { api: "https://api.deepseek.com", doc: "https://api-docs.deepseek.com", models: { "deepseek-chat": {}, "deepseek-reasoner": {} } },
    zhipuai: { api: "https://Open.BigModel.cn/api/paas/v4", doc: "https://docs.bigmodel.cn", models: { "glm-5": {}, " glm-4.6 ": {}, "glm-4.6": {} } },
    // Not kept: no API address (only a documentation site), an address that is no https URL, no usable model id.
    openai: { doc: "https://platform.openai.com", models: { "gpt-x": {} } },
    plain: { api: "http://api.plain.test/v1", models: { a: {} } },
    broken: { api: "not a url", models: { a: {} } },
    empty: { api: "https://api.empty.test/v1", models: { "": {}, [`bad\nid`]: {}, ["x".repeat(101)]: {} } },
    odd: "not an entry",
  };

  it("keeps, per provider with an https API address, its host and its usable model ids, sorted", () => {
    expect(reduceProviders(API)).toEqual([
      { id: "deepseek", hosts: ["api.deepseek.com"], models: ["deepseek-chat", "deepseek-reasoner"] },
      { id: "zhipuai", hosts: ["open.bigmodel.cn"], models: ["glm-4.6", "glm-5"] },
    ]);
    // A host must be a plain DNS name: a template placeholder, an address without a dot, an IPv6 literal are left out.
    expect(
      reduceProviders({
        a: { api: "https://${databricks_host}/serving", models: { m: {} } },
        b: { api: "https://${acct}.snowflakecomputing.com/api", models: { m: {} } },
        c: { api: "https://localhost/v1", models: { m: {} } },
        d: { api: "https://[::1]/v1", models: { m: {} } },
        e: { api: "https://my-host.example.co/v1", models: { m: {} } },
      }),
    ).toEqual([{ id: "e", hosts: ["my-host.example.co"], models: ["m"] }]);
    for (const bad of [null, [], "x", 1, undefined]) expect(reduceProviders(bad)).toEqual([]);
  });
});

describe("the committed provider snapshot", () => {
  const text = readFileSync(new URL("../src/providers/provider-catalog.json", import.meta.url), "utf8");
  const providers = JSON.parse(text) as ReturnType<typeof reduceProviders>;

  it("is a sorted list of well-formed providers, written as the script writes it", () => {
    expect(providers.length).toBeGreaterThan(50);
    expect(text).toBe(formatCatalog(providers));
    for (const [i, p] of providers.entries()) {
      expect([p.id, Object.keys(p)]).toEqual([p.id, ["id", "hosts", "models"]]);
      expect([p.id, p.hosts.length > 0, p.hosts.every((h) => h === h.toLowerCase() && !h.includes("/") && DNS_NAME.test(h)), p.models.length > 0]).toEqual([p.id, true, true, true]);
      expect([p.id, [...p.models].sort()]).toEqual([p.id, p.models]);
      if (i > 0) expect([providers[i - 1]!.id < p.id]).toEqual([true]);
    }
    const readme = readFileSync(new URL("../src/providers/model-catalog.README.md", import.meta.url), "utf8");
    expect(readme).toContain(`Providers (provider-catalog.json): ${providers.length}`);
  });

  it("catalogueModels: by the exact host name, whatever the port, path or case; another host is null", () => {
    const deepseek = providers.find((p) => p.id === "deepseek")!;
    expect(deepseek.hosts).toEqual(["api.deepseek.com"]);
    expect(catalogueModels("https://api.deepseek.com/v1")).toEqual(deepseek.models);
    expect(catalogueModels("https://API.DeepSeek.com:8443/anything")).toEqual(deepseek.models);
    for (const other of ["https://deepseek.com/v1", "https://x.api.deepseek.com/v1", "https://api.deepseek.com.evil.test/v1", "https://unknown.example/v1", "nonsense"]) {
      expect([other, catalogueModels(other)]).toEqual([other, null]);
    }
  });
});

/** A provider whose model list answers what `next` says: names, or a failure with that HTTP status. */
const next: { list: string[] | number } = { list: [] };
const providerProbe: ProviderProbe = {
  test: async () => {},
  listModels: async () => {
    if (typeof next.list !== "number") return next.list;
    throw new ProviderCallError(next.list === 401 || next.list === 403 ? "provider_rejected" : "provider_unavailable", next.list, { upstreamStatus: String(next.list) });
  },
};
const { app } = useApp({ providerProbe });
beforeEach(() => {
  next.list = [];
});

describe("models/list on an address without a model list", () => {
  const listed = (name: string, added = false) => ({ name, ...modelHints(name), added });
  const create = async (who: Awaited<ReturnType<typeof signUp>>, baseUrl: string, models: Array<{ name: string }> = []) =>
    (await api(app, who, "POST", "/api/providers", providerBody({ name: baseUrl.slice(8, 40), baseUrl, models }))).json.id as string;

  it("a 404 or 405 at a host the catalogue knows: ok, its models there (marked added when saved), source catalogue", async () => {
    const owner = await signUp(app, "cataloguer");
    const ids = catalogueModels("https://api.deepseek.com")!;
    const id = await create(owner, "https://api.deepseek.com", [{ name: ids[0]! }]);
    for (const status of [404, 405]) {
      next.list = status;
      expect([status, await api(app, owner, "POST", `/api/providers/${id}/models/list`)]).toEqual([
        status,
        { status: 200, json: { ok: true, listed: ids.map((name, i) => listed(name, i === 0)), source: "catalogue" } },
      ]);
    }
    // Any other failure, and a list the provider gives, are as before.
    for (const status of [401, 500, 429]) {
      next.list = status;
      const res = await api(app, owner, "POST", `/api/providers/${id}/models/list`);
      expect([status, res.json.ok, res.json.upstreamStatus]).toEqual([status, false, String(status)]);
    }
    next.list = ["own-model"];
    expect((await api(app, owner, "POST", `/api/providers/${id}/models/list`)).json).toEqual({ ok: true, listed: [listed("own-model")], source: "upstream" });
    // The test (without a model) and the refresh never use the catalogue.
    next.list = 404;
    expect((await api(app, owner, "POST", `/api/providers/${id}/test`)).json).toMatchObject({ ok: true }); // (this probe's test always passes)
    expect(await api(app, owner, "POST", `/api/providers/${id}/models/refresh`)).toEqual({ status: 502, json: { error: "provider_unavailable" } });
  });

  it("a host the catalogue does not know: the failure, as before", async () => {
    const owner = await signUp(app, "unknown");
    const id = await create(owner, "https://models.unknown-host.example/v1");
    next.list = 404;
    expect(await api(app, owner, "POST", `/api/providers/${id}/models/list`)).toEqual({
      status: 200,
      json: { ok: false, error: "provider_unavailable", upstreamStatus: "404", detail: { upstreamStatus: "404" } },
    });
  });
});
