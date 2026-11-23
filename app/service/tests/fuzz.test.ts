import { randomUUID } from "node:crypto";
import net from "node:net";
import type { InjectOptions, LightMyRequestResponse } from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { RouteEntry } from "../src/app.ts";
import { createInvite } from "../src/auth/invites.ts";
import type { ModelEvent, ModelGateway } from "../src/models/gateway.ts";
import type { ProviderProbe } from "../src/providers/probe.ts";
import { api, befriend, group, signUp, TERMS, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON } from "./helpers/social.ts";
import { BOUNDARY, CLOSING, MULTIPART, multipart, partHead } from "./helpers/multipart.ts";
import { providerBody } from "./helpers/providers.ts";
import { APP_ORIGIN, issueTicket, listen, tryConnect } from "./helpers/ws.ts";

/**
 * Robustness: every route the app registers (read from `app.routeList`, so a route added later is fuzzed
 * without touching this file) gets malformed paths, queries, bodies and content types, signed in and
 * signed out. Every answer must be < 500; every 4xx must be a well-formed `{"error": "<snake_case>"}`
 * JSON body whose other fields are strings (one documented exception: `provider_in_use` names the Agents in its
 * `agents` list); and the process must still serve `/api/health` afterwards. The routes of Agents, providers, usage and
 * replies (`isAgentRoute`) are reached with real ids of the fixture's Agent, run, proposal and provider, so malformed
 * bodies get as deep as they can; a malformed path parameter there is always a 4xx, and each of them answers at least one
 * probe from beyond its checks of shape, session and existence.
 */

/** What the fixture's model answers (at once, every call): drafts and replies run to their end without a network. */
const answer = { text: "好的。" };
const models: ModelGateway = {
  async *stream(): AsyncGenerator<ModelEvent> {
    if (answer.text !== "") yield { type: "text", delta: answer.text };
    yield { type: "finish", usage: null, truncated: false, toolCalls: [], assistant: [] };
  },
  async listModels() {
    return ["fuzz-model"];
  },
};
/** A provider that takes every key and lists one model: the provider routes answer without a network. */
const providerProbe: ProviderProbe = { test: async () => {}, listModels: async () => ["fuzz-model"] };

const { blobs } = useProbeBlobs("af-fuzz-");
// The Agent social switch is on, so that no route of it is hidden from the rules below by the switch (the routes are lane A's and B's to add).
const { app } = useApp({ blobs, env: SITE_ENV, models, providerProbe, agentWorker: false, config: SOCIAL_ON });

const FUZZ_TIMEOUT = 120_000;
const UUID = "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b";
const MEGA = "x".repeat(1_000_000);

// --- the verdict ----------------------------------------------------------------------------------

interface Finding {
  probe: string;
  status: number;
  why: string;
  body: string;
}

const SNAKE = /^[a-z][a-z0-9_]*$/;

/**
 * The one 4xx whose details are not all strings (README "Errors"): 409 `provider_in_use` names the Agents that still use
 * the provider, `agents: [{"id", "name"}]`, both strings. Nothing else may carry a non-string detail.
 */
function isProviderInUseList(error: string, key: string, value: unknown): boolean {
  return (
    error === "provider_in_use" &&
    key === "agents" &&
    Array.isArray(value) &&
    value.every((a) => a && typeof a === "object" && Object.keys(a).sort().join() === "id,name" && typeof a.id === "string" && typeof a.name === "string")
  );
}

/** Why `res` is not an acceptable answer, or null. */
function verdict(method: string, res: Pick<LightMyRequestResponse, "statusCode" | "headers" | "body">): string | null {
  if (res.statusCode >= 500) return `status ${res.statusCode}`;
  if (method === "HEAD" || res.statusCode < 400) return null;
  if (!String(res.headers["content-type"] ?? "").startsWith("application/json")) return "4xx without a JSON content type";
  let json: unknown;
  try {
    json = JSON.parse(res.body);
  } catch {
    return "4xx body is not JSON";
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) return "4xx body is not an object";
  const { error, ...rest } = json as Record<string, unknown>;
  if (typeof error !== "string" || !SNAKE.test(error)) return "4xx body has no snake_case error";
  if (Object.entries(rest).some(([k, v]) => typeof v !== "string" && !isProviderInUseList(error, k, v))) return "4xx body has a non-string extra field";
  return null;
}

/** One probe's answer. */
interface Sent {
  label: string;
  status: number;
}

/** Sends probes in order, recording every bad answer; returns every answer's status. */
async function probeAll(probes: Array<InjectOptions & { label: string }>, findings: Finding[]): Promise<Sent[]> {
  const sent: Sent[] = [];
  for (const { label, ...opts } of probes) {
    const res = await app.inject(opts);
    sent.push({ label, status: res.statusCode });
    const why = verdict(String(opts.method), res);
    if (why) findings.push({ probe: label, status: res.statusCode, why, body: res.body.slice(0, 300) });
  }
  return sent;
}

async function stillHealthy(): Promise<void> {
  const res = await app.inject({ method: "GET", url: "/api/health" });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ ok: true });
}

// --- malformed values -------------------------------------------------------------------------------

/** Path segment values: never a canonical UUID or a positive integer. */
const BAD_PATH = [
  "abc",
  "1",
  "0",
  "-1",
  "1.5",
  "1e400",
  "NaN",
  "Infinity",
  "12345678901234567890123",
  "%00",
  "%ED%A0%80", // a lone surrogate, UTF-8 encoded (invalid UTF-8)
  "%F0%9F%98", // a truncated UTF-8 sequence
  "%",
  "%zz",
  "%2F",
  "a%2Fb",
  "%2F..%2F",
  "..",
  "%2e%2e",
  ".",
  "%20",
  "x".repeat(10_000),
  UUID.toUpperCase(),
  `{${UUID}}`,
  `${UUID}%00`,
  `${UUID}%2F..`,
  "00000000-0000-0000-0000-000000000000",
];

/** Query values (already URL-encoded). */
const BAD_QUERY = [
  "",
  "abc",
  "-1",
  "0",
  "1.5",
  "1e400",
  "NaN",
  "12345678901234567890123",
  "%00",
  "%ED%A0%80",
  "%0A",
  "%E2%80%AE",
  "%",
  encodeURIComponent(MEGA),
];

/** JSON texts put in place of one field of an otherwise plausible body. */
const BAD_JSON = [
  "null",
  "[]",
  "[1]",
  "{}",
  '{"a":1}',
  '"1"',
  "1",
  "-1",
  "0",
  "-0",
  "1.5",
  "true",
  "1e400",
  "-1e400",
  "12345678901234567890123",
  '"NaN"',
  '"\\u0000"',
  '"a\\u0000b"',
  '"\\ud800"',
  '"\\udfff\\ud800"',
  JSON.stringify(MEGA),
  '""',
  '" "',
  '"\\n"',
  '"%00"',
  '"../.."',
  JSON.stringify(UUID.toUpperCase()),
  JSON.stringify(randomUUID()),
  '"<script>alert(1)</script>"',
  '{"__proto__":{"polluted":true}}',
  '{"constructor":{"prototype":{"polluted":true}}}',
  `[${'"a",'.repeat(10_000)}"a"]`,
];

/** Whole request bodies (raw text, sent as application/json). */
const BAD_BODIES = [
  "null",
  "[]",
  '"x"',
  "1",
  "true",
  "{",
  '{"a":',
  "NaN",
  "1e400",
  "\u0000",
  JSON.stringify(MEGA),
  '{"__proto__":{"polluted":true}}',
  JSON.stringify({ pad: "y".repeat(2 * 1024 * 1024) }), // over the body limit
];

/** Content types sent with an otherwise plausible JSON body. */
const BAD_CONTENT_TYPES = [
  "text/plain",
  "application/x-www-form-urlencoded",
  "multipart/form-data",
  `multipart/form-data; boundary=${BOUNDARY}`,
  "application/json; charset=utf-16",
  "application/json; charset=bogus",
  "application/octet-stream",
  "image/png",
  "",
];

const HOLE = "\u0001fuzz-hole\u0001";

/** `body` with `field` replaced by the raw JSON text `raw`. */
function withField(body: Record<string, unknown>, field: string, raw: string): string {
  return JSON.stringify({ ...body, [field]: HOLE }).replace(JSON.stringify(HOLE), raw);
}

/** The keys of a zod object schema, looking through optional/nullable/default/pipe wrappers. */
function shapeKeys(schema: unknown): string[] {
  let s = schema as { _zod?: { def: Record<string, any> } } | undefined;
  for (let depth = 0; depth < 10 && s?._zod; depth++) {
    const def = s._zod.def;
    if (def.type === "object") return Object.keys(def.shape);
    if (["optional", "nullable", "default", "catch", "readonly", "nonoptional"].includes(def.type)) s = def.innerType;
    else if (def.type === "pipe") s = def.in;
    else return [];
  }
  return [];
}

const params = (url: string): string[] => [...url.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]!);
const fill = (url: string, values: Record<string, string>): string =>
  url.replace(/:([A-Za-z]+)/g, (_, name: string) => values[name] ?? UUID);

// --- fixtures -----------------------------------------------------------------------------------------

interface Fixture {
  me: Actor;
  peer: Actor;
  victim: Actor;
  stranger: Actor;
  group: string;
  dm: string;
  attachment: string;
  request: string;
  invite: string;
  /** `me`'s Agent on the site model, its conversation, a run of it that failed, and a persona proposal it made. */
  agent: string;
  agentConv: string;
  run: string;
  proposal: string;
  /** The same Agent is a member of `group` too (batch 2C), and a reply of it there failed. */
  groupRun: string;
  /** Another Agent of `me`'s, the one `DELETE /api/agents/:id` deletes. */
  victimAgent: string;
  /** `me`'s provider; an Agent uses it, so deleting it is 409 `provider_in_use` every time. */
  provider: string;
  /**
   * The memory of `agent`: a note of its own to edit and another to delete, an entry it heard to delete and another to take as true
   * (one each, so that neither route takes the other's), and a change of its notes to decide on.
   */
  note: string;
  doomedNote: string;
  heard: string;
  heardToConfirm: string;
  change: string;
  /** A whisper of the fuzzing account's about `agent` in the group, open (src/whispers/). */
  whisper: string;
}

const FAST = { source: "site", id: "fast" } as const;

async function fixture(): Promise<Fixture> {
  const [me, peer, victim, stranger] = [
    await signUp(app, "fuzzer"),
    await signUp(app, "peer"),
    await signUp(app, "victim"),
    await signUp(app, "stranger"),
  ];
  const { conversationId: dm } = await befriend(app, me, peer);
  const g = await group(app, me, "fuzz", [peer, victim]);
  const said = await api(app, me, "POST", `/api/conversations/${g}/messages`, { text: "hello", clientTxn: "fx1" });
  if (said.status !== 201) throw new Error(`fixture send ${said.status}`);
  const up = await app.inject({
    method: "POST",
    url: `/api/conversations/${g}/attachments`,
    headers: { cookie: me.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: "a.txt", type: "text/plain", data: "bytes" }]),
  });
  if (up.statusCode !== 201) throw new Error(`fixture upload ${up.statusCode}`);
  const attachment = up.json().id as string;
  await api(app, me, "POST", `/api/conversations/${g}/messages`, { attachmentId: attachment, clientTxn: "fx2" });
  const req = await api(app, stranger, "POST", "/api/friend-requests", { handle: me.handle });
  if (req.status !== 201) throw new Error(`fixture request ${req.status}`);

  const agent = await mustCreateAgent(app, me, { model: FAST, persona: "你是测试助手。" });
  const victimAgent = await mustCreateAgent(app, me);
  const provider = await api(app, me, "POST", "/api/providers", providerBody({ models: [{ name: "m" }] }));
  if (provider.status !== 201) throw new Error(`fixture provider ${provider.status}`);
  await mustCreateAgent(app, me, { model: { source: "provider", providerId: provider.json.id, model: "m" } });
  // A reply that proposes a persona, then one that fails (an empty answer): the run routes find a run to stop, and a
  // failed latest run to retry.
  const reply = async (text: string, clientTxn: string) => {
    answer.text = text;
    const said = await api(app, me, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "整理一下", clientTxn });
    if (said.status !== 201 || !(await app.agentWorker.runOnce())) throw new Error(`fixture reply ${said.status}`);
  };
  await reply("<af-persona>你是一个测试助手。</af-persona>", "fx3");
  await reply("", "fx4");
  answer.text = "好的。";
  const db = app.deps.db;
  const runs = await db.query<{ id: string; status: string }>("select id, status from agent_runs where agent_id = $1 order by created_at", [agent.id]);
  if (runs.rows.map((r) => r.status).join() !== "done,failed") throw new Error(`fixture runs ${JSON.stringify(runs.rows)}`);
  const proposal = await db.query<{ id: string }>("select id from persona_proposals where agent_id = $1", [agent.id]);
  // Its owner puts it into the group, where a reply of it failed: the group's run routes have a run and an Agent to act on.
  const seated = await api(app, me, "POST", `/api/conversations/${g}/members`, { principalId: agent.id });
  if (seated.status !== 201) throw new Error(`fixture seat ${seated.status}`);
  const groupRun = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, finished_at)
     select 'reply', $1, $2, $3, 'failed', 'provider_unavailable', seq, now() from conversations where id = $1 returning id`,
    [g, agent.id, me.id],
  );
  const notes = await db.query<{ id: string }>("insert into agent_notes (agent_id, text, vault) values ($1, '喜欢喝茶', false), ($1, '喜欢咖啡', false) returning id", [agent.id]);
  const heard = await db.query<{ id: string }>(
    "insert into agent_hearsay (agent_id, conversation_id, speaker_id, speaker_name, text, said_at) values ($1, $2, $3, 'peer', '主人下周出差', now()), ($1, $2, $3, 'peer', '主人喜欢爬山', now()) returning id",
    [agent.id, g, peer.id],
  );
  const change = await db.query<{ id: string }>("insert into memory_changes (owner_id, agent_id, conversation_id, status, ops) values ($1, $2, $3, 'applied', '[]'::jsonb) returning id", [
    me.id,
    agent.id,
    agent.conversationId,
  ]);
  const whisper = await db.query<{ id: string }>(
    `insert into whispers (conversation_id, owner_id, agent_id, after_seq, kind, body)
     select id, $2, $3, seq, 'found_elsewhere', '{"text": "找到了", "actions": ["tell", "dismiss"]}'::jsonb from conversations where id = $1 returning id`,
    [g, me.id, agent.id],
  );
  return {
    me,
    peer,
    victim,
    stranger,
    group: g,
    dm,
    attachment,
    request: req.json.id,
    invite: await createInvite(app.deps.db, { ttlHours: 1 }),
    agent: agent.id,
    agentConv: agent.conversationId,
    run: runs.rows[0]!.id,
    proposal: proposal.rows[0]!.id,
    groupRun: groupRun.rows[0]!.id,
    victimAgent: victimAgent.id,
    provider: provider.json.id,
    note: notes.rows[0]!.id,
    doomedNote: notes.rows[1]!.id,
    heard: heard.rows[0]!.id,
    heardToConfirm: heard.rows[1]!.id,
    change: change.rows[0]!.id,
    whisper: whisper.rows[0]!.id,
  };
}

/** The routes of an Agent's conversation that only its owner has: its run, replies and new topics. */
const AGENT_CONVERSATION = /^\/api\/conversations\/:id\/(run|runs|topic)(\/|$)/;
/** A group member's brakes on its Agents (batch 2C): reached with the fixture's group. */
const GROUP_AGENTS = /^\/api\/conversations\/:id\/agents\//;
/** A group's replies as a member may know them (batch 2C): reached with the fixture's group, not the Agent's conversation. */
const GROUP_RUNS = "/api/conversations/:id/runs";
/** The routes of Agents, providers, usage and replies (this batch's): checked more strictly below. */
const isAgentRoute = (url: string) => /^\/api\/(agents|providers|usage)(\/|$)/.test(url) || AGENT_CONVERSATION.test(url) || GROUP_AGENTS.test(url);

/** A real id for each path parameter, so malformed bodies and queries reach as deep as they can. */
function validParams(route: Pick<RouteEntry, "method" | "url">, fx: Fixture): Record<string, string> {
  const { method, url } = route;
  const out: Record<string, string> = {};
  for (const name of params(url)) {
    if (name === "seq") out[name] = "2";
    else if (name === "principalId") out[name] = fx.victim.id; // the one whose removal, unfriending or blocking costs nothing
    else if (name === "runId") out[name] = fx.run;
    else if (name === "proposalId") out[name] = fx.proposal;
    // An Agent's memory: what each route needs is a real one of the fuzzing account's Agent (one to delete, one to take as true).
    else if (name === "noteId") out[name] = method === "DELETE" ? fx.doomedNote : fx.note;
    else if (name === "hearsayId") out[name] = url.endsWith("/confirm") ? fx.heardToConfirm : fx.heard;
    else if (name === "changeId") out[name] = fx.change;
    // Agent social (lane A): the fuzzing account's own Agent, and a person who has no row on it.
    else if (name === "agentId") out[name] = fx.agent;
    else if (name === "subjectId") out[name] = fx.peer.id;
    else {
      const collection = url.split(`/:${name}`)[0]!.split("/").pop();
      out[name] =
        collection === "conversations"
          ? AGENT_CONVERSATION.test(url) && url !== GROUP_RUNS
            ? fx.agentConv
            : fx.group
          : collection === "attachments"
            ? fx.attachment
            : collection === "friend-requests"
              ? fx.request
              : collection === "principals"
                ? fx.peer.id
                : collection === "agents"
                  ? method === "DELETE" && url === "/api/agents/:id"
                    ? fx.victimAgent // deleting it costs nothing
                    : fx.agent
                  : collection === "providers"
                    ? fx.provider
                    : collection === "whispers"
                      ? fx.whisper
                      : randomUUID(); // a route added later: still fuzzed, with an id nobody has
    }
  }
  return out;
}

let unique = 0;

/** A plausible body for known routes (so one broken field is the only problem); `{}` for anything else. */
function plausibleBody(route: RouteEntry, fx: Fixture): Record<string, unknown> {
  const n = ++unique;
  switch (`${route.method} ${route.url}`) {
    case "POST /api/register":
      return { inviteCode: fx.invite, email: `fz${n}@example.test`, password: "fuzz-password-1", displayName: "Fuzz", handle: `fz${n}`, ...TERMS };
    case "POST /api/friend-requests":
      return { handle: fx.peer.handle };
    case "PATCH /api/me":
      return { displayName: "Fuzz" };
    case "POST /api/me/terms":
      return { ...TERMS };
    case "POST /api/conversations":
      return { title: "t", memberIds: [fx.peer.id, fx.victim.id] };
    case "PATCH /api/conversations/:id":
      return { title: "t" };
    case "POST /api/conversations/:id/members":
      return { principalId: fx.victim.id };
    case "POST /api/conversations/:id/messages":
      return { text: "hi", clientTxn: `fz${n}` };
    case "POST /api/conversations/:id/read":
      return { seq: 1 };
    case "POST /api/sync/catchup":
      return { positions: { [fx.group]: 0 } };
    case "POST /api/agents":
      return { namePart: `fz_${n}`, name: "Fuzz", groupMentions: "owner", chainBudget: "50" };
    case "PATCH /api/agents/:id":
      return { intro: "fuzz", groupMentions: "members", chainBudget: "12.5" };
    case "POST /api/agents/draft-persona":
      return { name: "Fuzz", model: FAST };
    case "POST /api/agent-contacts":
      return { agentId: fx.agent };
    case "POST /api/providers":
      return providerBody({ name: `fz${n}`, models: [{ name: "m", reasoning: true, reasoningLevels: ["low", "high"] }] });
    case "PATCH /api/providers/:id":
      return { name: `fz${n}`, models: [{ name: "m", reasoning: true, reasoningLevels: ["low", "high"] }] };
    case "POST /api/providers/:id/test":
      // A real call to the fixture provider's model (the gateway here answers at once).
      return { model: "m" };
    default:
      return {};
  }
}

/** A plausible query for known routes. */
function plausibleQuery(keys: string[], fx: Fixture): Record<string, string> {
  const q: Record<string, string> = {};
  if (keys.includes("q")) q.q = "hi";
  if (keys.includes("handle")) q.handle = fx.peer.handle;
  if (keys.includes("ticket")) q.ticket = "nope";
  return q;
}

const qs = (q: Record<string, string>): string => {
  const s = Object.entries(q)
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  return s ? `?${s}` : "";
};

const HAS_BODY = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Every probe for one route, each to be sent signed in and signed out. `over` reaches a route another way than
 * `validParams` and `plausibleBody` would (other real ids, another body); with a body given, that body is sent as it is
 * too.
 */
function probesFor(
  route: RouteEntry,
  fx: Fixture,
  over: { params?: Record<string, string>; body?: Record<string, unknown> } = {},
): Array<InjectOptions & { label: string }> {
  const { method, url } = route;
  const good = { ...validParams(route, fx), ...over.params };
  const queryKeys = shapeKeys(route.schema?.querystring);
  const baseQuery = plausibleQuery(queryKeys, fx);
  const at = (values: Record<string, string>, query = baseQuery) => fill(url, values) + qs(query);
  const out: Array<Omit<InjectOptions, "method"> & { label: string }> = [];

  // Paths: each parameter in turn takes every malformed value, the others stay real.
  for (const name of params(url)) {
    for (const bad of BAD_PATH) out.push({ label: `path ${name}=${bad.slice(0, 40)}`, url: at({ ...good, [name]: bad }) });
  }

  // Queries: each known key in turn takes every malformed value, repeated, or nested; plus unknown keys.
  for (const key of queryKeys) {
    for (const bad of BAD_QUERY) out.push({ label: `query ${key}=${bad.slice(0, 40)}`, url: at(good, { ...baseQuery, [key]: bad }) });
    out.push({ label: `query ${key} twice`, url: at(good) + `${Object.keys(baseQuery).length ? "&" : "?"}${key}=1&${key}=2` });
    out.push({ label: `query ${key}[a]`, url: fill(url, good) + `?${key}[a]=1&${key}[]=2` });
  }
  out.push({ label: "query unknown key", url: at(good, { ...baseQuery, zzz: "1", __proto__x: "1" }) });
  // The request as a client would send it (a body-less method; the others get "no body" below).
  if (!HAS_BODY.has(method)) out.push({ label: "plain", url: at(good) });

  // Bodies.
  if (HAS_BODY.has(method)) {
    const body = over.body ?? plausibleBody(route, fx);
    const fields = [...new Set([...Object.keys(body), ...shapeKeys(route.schema?.body)])];
    const json = (payload: string | undefined, contentType = "application/json") => ({
      url: at(good),
      ...(payload === undefined ? {} : { payload, headers: contentType ? { "content-type": contentType } : {} }),
    });
    out.push({ label: "no body", ...json(undefined) });
    if (over.body) out.push({ label: "the body given", ...json(JSON.stringify(body)) });
    for (const raw of BAD_BODIES) out.push({ label: `body ${raw.slice(0, 40)}`, ...json(raw) });
    for (const ct of BAD_CONTENT_TYPES) out.push({ label: `content-type "${ct}"`, ...json(JSON.stringify(body), ct) });
    for (const field of fields) {
      for (const raw of BAD_JSON) out.push({ label: `body.${field}=${raw.slice(0, 40)}`, ...json(withField(body, field, raw)) });
    }
  }
  return out.map((p) => ({ ...p, method: method as InjectOptions["method"] }));
}

/** Every probe as given, plus the same without the session cookie. */
function signedInAndOut(probes: Array<InjectOptions & { label: string }>, cookie: string) {
  return probes.flatMap((p) => [
    { ...p, label: `${p.label} [signed in]`, headers: { ...(p.headers as object), cookie } },
    { ...p, label: `${p.label} [signed out]` },
  ]);
}

// --- the suites -----------------------------------------------------------------------------------------

const isAuthMount = (r: RouteEntry) => r.url.endsWith("/*");

describe("fuzz", () => {
  it("every route answers malformed paths, queries and bodies with < 500 and a well-formed error", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const routes = app.routeList.filter((r) => !isAuthMount(r));
    // The table really is the app's: spot-check routes from every module.
    const names = new Set(routes.map((r) => `${r.method} ${r.url}`));
    for (const known of [
      "GET /api/health",
      "POST /api/register",
      "GET /api/principals/lookup",
      "PUT /api/me/avatar",
      "POST /api/friend-requests/:id/accept",
      "DELETE /api/conversations/:id/members/:principalId",
      "GET /api/conversations/:id/messages/:seq",
      "POST /api/conversations/:id/attachments",
      "GET /api/search",
      "POST /api/sync/catchup",
      "GET /api/ws",
      "HEAD /api/sync",
    ]) {
      expect(names).toContain(known);
    }

    const findings: Finding[] = [];
    // First, while the fixture's Agent is as the fixture left it (the pass below pauses it, edits it, …): the owner's run
    // routes in the group (batch 2C), with the Agent's id in the body and its failed run there. Each is held to the rule
    // below for this batch's routes: a malformed path parameter is a 4xx, and one probe at least gets past the checks.
    const SHALLOW = new Set([400, 401, 404, 405, 413, 414, 415, 429]);
    const inGroup = routes.filter((r) => r.method === "POST" && /^\/api\/conversations\/:id\/runs\/(retry|dismiss|:runId\/stop)$/.test(r.url));
    expect(inGroup.map((r) => r.url).sort()).toEqual(["/api/conversations/:id/runs/:runId/stop", "/api/conversations/:id/runs/dismiss", "/api/conversations/:id/runs/retry"]);
    for (const route of inGroup) {
      const probes = probesFor(route, fx, { params: { id: fx.group, runId: fx.groupRun }, body: { agentId: fx.agent } });
      const got = await probeAll(signedInAndOut(probes, fx.me.cookie), findings);
      const name = `${route.method} ${route.url} (a group)`;
      expect([name, got.filter((x) => x.label.startsWith("path ") && (x.status < 400 || x.status >= 500))]).toEqual([name, []]);
      if (route.url.endsWith("/retry") || route.url.endsWith("/dismiss")) {
        expect([name, got.some((x) => x.label.startsWith("body.agentId="))]).toEqual([name, true]);
      }
      expect([name, got.some((x) => x.label.endsWith("[signed in]") && !SHALLOW.has(x.status))]).toEqual([name, true]);
    }
    expect(findings).toEqual([]);
    // Agent social (A4): the add, with the fuzzing account's own Agent in the body (a 409 `is_yours`, past every check), before the
    // pass below spends the account's twenty adds a minute on malformed ones.
    const addRoute = routes.find((r) => r.method === "POST" && r.url === "/api/agent-contacts")!;
    const added = await probeAll(signedInAndOut(probesFor(addRoute, fx, { body: { agentId: fx.agent } }), fx.me.cookie), findings);
    expect([added.filter((x) => x.label.startsWith("the body given") && x.label.endsWith("[signed in]")).map((x) => x.status)]).toEqual([[409]]);
    expect(findings).toEqual([]);

    const sent = await Promise.all(routes.map((r) => probeAll(signedInAndOut(probesFor(r, fx), fx.me.cookie), findings)));
    expect(findings).toEqual([]);
    expect(sent.flat().length).toBeGreaterThan(4000);

    // This batch's routes, each one of them: a malformed path parameter is always a 4xx, never a success; and the real
    // ids took at least one probe past the checks of shape, session, rate and existence (a status none of those gives).
    const agentRoutes = routes.filter((r) => isAgentRoute(r.url));
    for (const known of [
      "GET /api/usage",
      "POST /api/agents/draft-persona",
      "POST /api/agents/:id/proposals/:proposalId/confirm",
      "DELETE /api/providers/:id",
      "POST /api/providers/:id/models/list",
      "POST /api/conversations/:id/runs/:runId/stop",
      "POST /api/conversations/:id/topic",
      "POST /api/conversations/:id/agents/halt",
      "GET /api/conversations/:id/runs",
    ]) {
      expect(agentRoutes.map((r) => `${r.method} ${r.url}`)).toContain(known);
    }
    const wrongBodies: string[] = [];
    for (const [i, route] of routes.entries()) {
      if (!isAgentRoute(route.url)) continue;
      const name = `${route.method} ${route.url}`;
      const malformedPath = sent[i]!.filter((x) => x.label.startsWith("path "));
      expect([name, malformedPath.filter((x) => x.status < 400 || x.status >= 500)]).toEqual([name, []]);
      // Every field an Agent is created or edited with is walked, `groupMentions` and `chainBudget` (batch 2C) and
      // `othersBudget` (the limits plan) included.
      if (name === "POST /api/agents" || name === "PATCH /api/agents/:id") {
        for (const field of ["groupMentions", "chainBudget", "othersBudget"]) {
          expect([name, field, sent[i]!.some((x) => x.label.startsWith(`body.${field}=`))]).toEqual([name, field, true]);
        }
      }
      // So is a raw body that is no JSON object (`null` aside: "none"), and a body in a content type that is not JSON.
      const malformedBody = sent[i]!.filter((x) => (x.label.startsWith("body ") && !x.label.startsWith("body null ")) || x.label.startsWith("content-type "));
      wrongBodies.push(...malformedBody.filter((x) => x.status < 400 || x.status >= 500).map((x) => `${name}: ${x.label} → ${x.status}`));
      // The avatar takes image bytes, not JSON: the avatar test below reaches it.
      if (route.url === "/api/agents/:id/avatar") continue;
      const deep = sent[i]!.filter((x) => x.label.endsWith("[signed in]") && !SHALLOW.has(x.status));
      expect([name, deep.length > 0]).toEqual([name, true]);
    }
    expect(wrongBodies).toEqual([]);
    // Agent social, lane A (A4): the contact routes. A malformed path parameter is a 4xx; and the real ids took one probe past the
    // checks of shape, session, rate and existence (the delete's row is not there, so it has no deeper answer than its 404; the add's was probed above).
    const contactRoutes = routes.filter((r) => r.url.startsWith("/api/agent-contacts") && r.method !== "HEAD");
    expect(contactRoutes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      "DELETE /api/agent-contacts/:agentId/:subjectId",
      "GET /api/agent-contacts",
      "POST /api/agent-contacts",
      "POST /api/agent-contacts/:agentId/:subjectId/approve",
      "POST /api/agent-contacts/:agentId/:subjectId/decline",
    ]);
    for (const route of contactRoutes) {
      const name = `${route.method} ${route.url}`;
      const got = sent[routes.indexOf(route)]!;
      expect([name, got.filter((x) => x.label.startsWith("path ") && (x.status < 400 || x.status >= 500))]).toEqual([name, []]);
      if (route.method !== "DELETE" && name !== "POST /api/agent-contacts") expect([name, got.some((x) => x.label.endsWith("[signed in]") && !SHALLOW.has(x.status))]).toEqual([name, true]);
    }
    await stillHealthy();
  });

  it("the 4xx rule's one exception is provider_in_use's list of Agents, and nothing else", () => {
    const json = (status: number, body: unknown) => ({ statusCode: status, headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body) });
    const inUse = { error: "provider_in_use", agents: [{ id: UUID, name: "Bot" }] };
    expect(verdict("DELETE", json(409, inUse))).toBeNull();
    expect(verdict("DELETE", json(409, { error: "provider_in_use", agents: [] }))).toBeNull();
    for (const bad of [
      { error: "not_found", agents: [{ id: UUID, name: "Bot" }] },
      { error: "provider_in_use", agents: [{ id: UUID, name: 1 }] },
      { error: "provider_in_use", agents: [{ id: UUID, name: "Bot", key: "x" }] },
      { error: "provider_in_use", agents: { id: UUID, name: "Bot" } },
      { error: "provider_in_use", others: [{ id: UUID, name: "Bot" }] },
      { error: "no_quota", reason: 1 },
    ]) {
      expect([bad, verdict("POST", json(409, bad))]).toEqual([bad, "4xx body has a non-string extra field"]);
    }
  });

  it("the Better Auth mount answers every path and malformed body with < 500 and a well-formed error", { timeout: FUZZ_TIMEOUT }, async () => {
    // Its own actor: sign-out probes end the session they carry.
    const me = await signUp(app, "authfuzz");
    const mounts = app.routeList.filter(isAuthMount);
    expect(mounts.map((r) => r.method).sort()).toEqual(["GET", "HEAD", "POST"]);
    const bodies: Record<string, Record<string, unknown>> = {
      "sign-in/email": { email: me.email, password: "not the password" },
      "request-password-reset": { email: me.email, redirectTo: "/reset" },
      "reset-password": { newPassword: "fuzz-password-2", token: "not-a-token" },
      "sign-out": {},
      "verify-email": {},
      "sign-up/email": { email: "new@example.test", password: "fuzz-password-1", name: "x" },
    };
    const extraFields = ["email", "password", "newPassword", "token", "callbackURL", "rememberMe", "redirectTo", "name"];
    const paths = [
      ...Object.keys(bodies),
      "get-session",
      "list-sessions",
      "",
      "..",
      "%2e%2e/%2e%2e/api/me",
      "sign-in/email/",
      "SIGN-IN/EMAIL",
      "sign-in%2Femail",
      "%00",
      "%ED%A0%80",
      "%",
      "x".repeat(5000),
    ];
    const probes: Array<InjectOptions & { label: string }> = [];
    for (const mount of mounts) {
      for (const path of paths) {
        const url = mount.url.replace("*", path);
        const base = { method: mount.method as InjectOptions["method"], url };
        probes.push({ ...base, label: `${mount.method} ${path.slice(0, 40)}` });
        for (const bad of BAD_QUERY) {
          probes.push({ ...base, url: `${url}?token=${bad}&callbackURL=${bad}`, label: `${mount.method} ${path.slice(0, 40)} ?token=${bad.slice(0, 30)}` });
        }
        if (mount.method !== "POST") continue;
        const body = bodies[path] ?? {};
        for (const raw of BAD_BODIES) {
          probes.push({ ...base, payload: raw, headers: { "content-type": "application/json" }, label: `POST ${path.slice(0, 40)} body ${raw.slice(0, 30)}` });
        }
        for (const ct of BAD_CONTENT_TYPES) {
          probes.push({ ...base, payload: JSON.stringify(body), headers: { "content-type": ct }, label: `POST ${path.slice(0, 40)} ct "${ct}"` });
        }
        for (const field of [...new Set([...Object.keys(body), ...extraFields])]) {
          for (const raw of BAD_JSON) {
            probes.push({
              ...base,
              payload: withField(body, field, raw),
              headers: { "content-type": "application/json" },
              label: `POST ${path.slice(0, 40)} body.${field}=${raw.slice(0, 30)}`,
            });
          }
        }
      }
    }
    const findings: Finding[] = [];
    // Signed out first: the signed-in pass ends its own session at its first sign-out.
    await probeAll(probes, findings);
    await probeAll(signedInAndOut(probes, me.cookie).filter((p) => p.label.endsWith("[signed in]")), findings);
    expect(findings).toEqual([]);
    await stillHealthy();
  });

  it("the upload route answers malformed multipart with < 500, keeps nothing, and keeps serving", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const url = `/api/conversations/${fx.group}/attachments`;
    expect(app.routeList.some((r) => r.method === "POST" && r.url === "/api/conversations/:id/attachments")).toBe(true);
    const file = (data = "bytes") => partHead({ name: "file", filename: "f.txt", type: "text/plain" }) + data;
    const cases: Array<{ label: string; contentType: string; payload: string | Buffer }> = [
      { label: "no boundary", contentType: "multipart/form-data", payload: file() + CLOSING },
      { label: "empty boundary", contentType: "multipart/form-data; boundary=", payload: file() + CLOSING },
      { label: "boundary of 200 characters", contentType: `multipart/form-data; boundary=${"b".repeat(200)}`, payload: file() + CLOSING },
      { label: "boundary mismatch", contentType: "multipart/form-data; boundary=other", payload: file() + CLOSING },
      { label: "truncated body", contentType: MULTIPART, payload: file("half a fi") },
      { label: "truncated part head", contentType: MULTIPART, payload: `--${BOUNDARY}\r\nContent-Dispo` },
      { label: "only the closing delimiter", contentType: MULTIPART, payload: `--${BOUNDARY}--\r\n` },
      { label: "empty body", contentType: MULTIPART, payload: "" },
      { label: "garbage", contentType: MULTIPART, payload: Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0x2d, 0x2d]) },
      { label: "wrong part name", contentType: MULTIPART, payload: multipart([{ name: "files", filename: "f.txt", data: "x" }]) },
      { label: "a field, not a file", contentType: MULTIPART, payload: multipart([{ name: "file", data: "x" }]) },
      { label: "two files", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "a", data: "1" }, { name: "file", filename: "b", data: "2" }]) },
      { label: "no Content-Disposition", contentType: MULTIPART, payload: `--${BOUNDARY}\r\nContent-Type: text/plain\r\n\r\nx${CLOSING}` },
      {
        label: "huge part header",
        contentType: MULTIPART,
        payload: `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${"n".repeat(200_000)}"\r\n\r\nx${CLOSING}`,
      },
      {
        label: "many part headers",
        contentType: MULTIPART,
        payload: `--${BOUNDARY}\r\n${Array.from({ length: 500 }, (_, i) => `X-H${i}: v`).join("\r\n")}\r\nContent-Disposition: form-data; name="file"; filename="f"\r\n\r\nx${CLOSING}`,
      },
      { label: "NUL and lone surrogate in the file name", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "a\u0000b\ud800.txt", data: "x" }]) },
      { label: "invalid UTF-8 in the file name", contentType: MULTIPART, payload: Buffer.concat([Buffer.from(partHead({ name: "file", filename: "" }).replace('filename=""', 'filename="')), Buffer.from([0xc3, 0x28, 0xff]), Buffer.from('"\r\n\r\nx' + CLOSING)]) },
      { label: "path traversal in the file name", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "../../../etc/passwd", data: "x" }]) },
      { label: "multipart/mixed", contentType: `multipart/mixed; boundary=${BOUNDARY}`, payload: file() + CLOSING },
      { label: "JSON", contentType: "application/json", payload: "{}" },
    ];
    const findings: Finding[] = [];
    const probes = cases.map((c) => ({ label: c.label, method: "POST" as const, url, headers: { "content-type": c.contentType }, payload: c.payload }));
    const statuses = (await probeAll(signedInAndOut(probes, fx.me.cookie), findings)).map((x) => x.status);
    // The same against a conversation id that is not one.
    await probeAll(signedInAndOut(probes.map((p) => ({ ...p, url: "/api/conversations/abc/attachments", label: `${p.label} (bad id)` })), fx.me.cookie), findings);
    expect(findings).toEqual([]);
    // Something was refused, and only what was accepted is kept: no stray row, blob or held key, no slot taken.
    const accepted = statuses.filter((s) => s === 201).length;
    expect(statuses.filter((s) => s === 400).length).toBeGreaterThan(10);
    const count = async (sql: string) => Number((await app.deps.db.query<{ n: string }>(sql)).rows[0]!.n);
    expect(await count("select count(*) n from attachments")).toBe(1 + accepted);
    await vi.waitFor(async () => expect(await count("select count(*) n from pending_blobs")).toBe(0));
    expect(app.deps.uploads.inProgress()).toBe(0);
    const names = (await app.deps.db.query<{ name: string }>("select name from attachments")).rows.map((r) => r.name);
    expect(names.every((n) => !/[\u0000-\u001f\ud800-\udfff/\\]/.test(n))).toBe(true);
    await stillHealthy();
  });

  it("the avatar routes, yours and your Agent's, answer malformed bodies and ids with < 500", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d7e2d10000000049454e44ae426082", "hex");
    const cases: Array<{ label: string; contentType?: string; payload?: string | Buffer }> = [
      { label: "no body" },
      { label: "empty png", contentType: "image/png", payload: Buffer.alloc(0) },
      { label: "text as png", contentType: "image/png", payload: "not a png" },
      { label: "svg", contentType: "image/svg+xml", payload: "<svg xmlns='http://www.w3.org/2000/svg'/>" },
      { label: "json", contentType: "application/json", payload: "{}" },
      { label: "upper-case type", contentType: "IMAGE/PNG", payload: png },
      { label: "type with parameters", contentType: "image/png; charset=utf-8", payload: png },
      { label: "multipart", contentType: MULTIPART, payload: multipart([{ name: "file", filename: "a.png", data: png }]) },
      { label: "octet-stream png", contentType: "application/octet-stream", payload: png },
      { label: "truncated png", contentType: "image/png", payload: png.subarray(0, 20) },
      { label: "over 2 MB", contentType: "image/png", payload: Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]) },
      { label: "garbage type", contentType: "image/", payload: png },
    ];
    const findings: Finding[] = [];
    const puts = cases.map((c) => ({
      label: c.label,
      method: "PUT" as const,
      url: "/api/me/avatar",
      ...(c.contentType === undefined ? {} : { headers: { "content-type": c.contentType } }),
      ...(c.payload === undefined ? {} : { payload: c.payload }),
    }));
    await probeAll(signedInAndOut(puts, fx.me.cookie), findings);
    // The Agent's: the same bodies against the fixture's Agent, and a good body against malformed and foreign ids.
    const agentPuts = await probeAll(signedInAndOut(puts.map((p) => ({ ...p, url: `/api/agents/${fx.agent}/avatar`, label: `agent ${p.label}` })), fx.me.cookie), findings);
    expect(agentPuts.filter((x) => x.label.endsWith("[signed in]") && x.status === 200).length).toBeGreaterThan(0);
    const badIds = [fx.victimAgent, fx.peer.id, randomUUID(), ...BAD_PATH].map((id) => ({
      label: `agent avatar of ${id.slice(0, 40)}`,
      method: "PUT" as const,
      url: `/api/agents/${id}/avatar`,
      headers: { "content-type": "image/png" },
      payload: PNG,
    }));
    const byId = await probeAll(signedInAndOut(badIds, fx.me.cookie), findings);
    expect(byId.filter((x) => x.label.startsWith("agent avatar of ") && !x.label.startsWith(`agent avatar of ${fx.victimAgent.slice(0, 40)}`)).every((x) => x.status >= 400)).toBe(true);
    const gets = [fx.peer.id, fx.me.id, fx.agent, randomUUID(), ...BAD_PATH].map((id) => ({
      label: `avatar of ${id.slice(0, 40)}`,
      method: "GET" as const,
      url: `/api/principals/${id}/avatar`,
    }));
    await probeAll(signedInAndOut(gets, fx.me.cookie), findings);
    expect(findings).toEqual([]);
    await stillHealthy();
  });

  it("the WebSocket route refuses bad tickets, foreign origins and plain GETs with < 500 and keeps serving", { timeout: FUZZ_TIMEOUT }, async () => {
    const fx = await fixture();
    const statuses: Array<[string, number | "open"]> = [];
    const attempt = async (label: string, opts: Parameters<typeof tryConnect>[1]) => {
      const r = await tryConnect(app, opts);
      if ("socket" in r) {
        r.socket.close();
        statuses.push([label, "open"]);
      } else {
        statuses.push([label, r.status]);
      }
    };
    await attempt("no ticket", { ticket: null });
    for (const bad of ["", "nope", "x".repeat(128), "x".repeat(129), "x".repeat(5000), "\u0000", "\n", "../..", UUID]) {
      await attempt(`ticket ${JSON.stringify(bad.slice(0, 20))}`, { ticket: bad });
    }
    await attempt("foreign origin", { ticket: await issueTicket(app, fx.me), origin: "https://evil.example.test" });
    await attempt("no origin", { ticket: await issueTicket(app, fx.me), origin: null });
    await attempt("origin null", { ticket: await issueTicket(app, fx.me), origin: "null" });
    await attempt("good", { ticket: await issueTicket(app, fx.me) });
    expect(statuses.filter(([, s]) => s === "open").map(([l]) => l)).toEqual(["good"]);
    expect(statuses.filter(([, s]) => s !== "open" && (s >= 500 || s < 400))).toEqual([]);

    // Raw upgrade requests no client library would send.
    const { port } = await listen(app);
    const raw = async (request: string): Promise<string> =>
      new Promise((resolve) => {
        const socket = net.connect({ port, host: "127.0.0.1" });
        let got = "";
        socket.on("data", (c) => (got += c.toString("latin1")));
        socket.on("error", () => {});
        socket.on("close", () => resolve(got));
        socket.setTimeout(3000, () => socket.destroy());
        socket.write(request);
      });
    const head = (lines: string[]) => [...lines, "", ""].join("\r\n");
    const upgradeHeaders = [`Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade", `Origin: ${APP_ORIGIN}`];
    const answers = [
      await raw(head(["GET /api/ws?ticket=x HTTP/1.1", ...upgradeHeaders])), // no key, no version
      await raw(head(["GET /api/ws?ticket=x HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: short", "Sec-WebSocket-Version: 99"])),
      await raw(head(["GET /api/ws?ticket=%ED%A0%80 HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"])),
      await raw(head(["GET /api/ws?ticket=a&ticket=b HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"])),
      await raw(head(["GET /%61pi/ws?ticket=x HTTP/1.1", ...upgradeHeaders, "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"])),
      await raw(head(["POST /api/ws?ticket=x HTTP/1.1", ...upgradeHeaders, "Content-Length: 0"])),
    ];
    for (const answer of answers) {
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(answer)?.[1] ?? 0);
      // Either an HTTP refusal or a dropped connection, never a server error or an open socket.
      expect(status === 0 || (status >= 400 && status < 500)).toBe(true);
    }

    // A plain GET (no upgrade) is not an upgrade: 404 or 400, never spending a ticket.
    const ticket = await issueTicket(app, fx.me);
    expect(await api(app, fx.me, "GET", `/api/ws?ticket=${ticket}`)).toEqual({ status: 404, json: { error: "not_found" } });
    expect(await api(app, null, "GET", "/api/ws")).toEqual({ status: 400, json: { error: "invalid_request" } });
    expect("socket" in (await tryConnect(app, { ticket }))).toBe(true);
    await stillHealthy();
  });
});
