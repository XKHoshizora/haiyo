import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { PROTOCOLS, type Protocol } from "../config.ts";
import { AppError, notFound } from "../errors.ts";
import { perPrincipalLimit, type PrincipalLimit } from "../limits.ts";
import { ModelError } from "../models/gateway.ts";
import { uuidParam, userText } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { providerBaseUrl } from "./base-url.ts";
import { catalogueModels } from "./catalogue.ts";
import { KeyUnreadableError } from "./crypto.ts";
import { modelHints } from "./hints.ts";
import { ProviderCallError, toProviderCallError, type ProviderCallCode } from "./probe.ts";
import { holdsKeyPiece } from "./upstream-detail.ts";
import {
  CONTEXT_TOKENS,
  MAX_MODELS,
  MODEL_LEVELS,
  modelLevels,
  createProvider,
  deleteProvider,
  listProviders,
  loadProviderForCall,
  mergeListedModels,
  modelName,
  parseModels,
  updateProvider,
  type ModelLevel,
  type ProviderModel,
  type ProviderRow,
} from "./store.ts";

/** How many entries of a provider's model list a refresh or a listing looks at (a refresh's `listed` holds at most these). */
export const MAX_LISTED_NAMES = 1_000;
/** How many models `POST /api/providers/:id/models/list` answers at most. */
export const MAX_LISTED_MODELS = 500;

/**
 * The names of a provider's model list worth showing: of its first MAX_LISTED_NAMES entries (the list is the upstream's,
 * of any length within the guard's size limit), names a person could have typed (trimmed), each once, in its order, and
 * never one that holds the key or any 6-character run of it (`holdsKeyPiece`).
 */
function usableNames(names: string[], apiKey: string): string[] {
  const seen = new Set<string>();
  for (const raw of names.slice(0, MAX_LISTED_NAMES)) {
    const parsed = modelName.safeParse(raw);
    if (parsed.success && !holdsKeyPiece(parsed.data, apiKey)) seen.add(parsed.data);
  }
  return [...seen];
}

// --- the routes ---------------------------------------------------------------------------------------------------

const empty = z.object({});
/** A route without fields takes no body, `{}` or `null`; anything else (an array, a string, text) is a 400. */
const noBody = empty.nullish();
const idParams = z.object({ id: uuidParam });

const providerName = userText(1, 40, { singleLine: true });
/** An API key as pasted: trimmed, then 8–1000 printable ASCII characters without spaces (it goes into a header). */
const apiKey = z
  .string()
  .trim()
  .regex(/^[\x21-\x7e]{8,1000}$/);
const modelInput = z
  .strictObject({
    name: modelName,
    vision: z.boolean().optional(),
    pdf: z.boolean().optional(),
    reasoning: z.boolean().optional(),
    contextTokens: z.number().int().min(CONTEXT_TOKENS.min).max(CONTEXT_TOKENS.max).optional(),
    reasoningLevels: modelLevels.optional(),
    tools: z.boolean().optional(),
  })
  .refine((m) => m.reasoningLevels === undefined || m.reasoning === true, "reasoningLevels only for a model that reasons");
const modelList = z
  .array(modelInput)
  .max(MAX_MODELS)
  .refine((list) => new Set(list.map((m) => m.name)).size === list.length, "model names must be unique");

const levelsView = z.array(z.enum(MODEL_LEVELS));
const modelView = z.object({
  name: z.string(),
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: z.boolean(),
  contextTokens: z.number(),
  reasoningLevels: levelsView.optional(),
  /** What the catalogue says the model supports (only on a model that reasons and is known to it): kept apart from `reasoningLevels`, the levels in use. */
  reportedLevels: levelsView.optional(),
  tools: z.boolean().optional(),
});
const providerView = z.object({
  id: z.string(),
  name: z.string(),
  protocol: z.enum(PROTOCOLS),
  baseUrl: z.string(),
  keyLast4: z.string(),
  models: z.array(modelView),
});

/** What the upstream said about a failed call (upstream-detail.ts): for the provider's owner, on these two routes only. */
const detailView = z.object({
  upstreamStatus: z.string().optional(),
  message: z.string().nullable().optional(),
  redacted: z.literal(true).optional(),
});
/** A call to the provider that failed, as `/test` and `/models/list` answer it (a 200). */
const callFailure = z.object({
  ok: z.literal(false),
  error: z.enum(["provider_rejected", "provider_unavailable", "address_not_allowed"]),
  upstreamStatus: z.string().optional(),
  detail: detailView.optional(),
});
/**
 * That answer: the code and, when the provider answered with one, its HTTP status, the number only (a 404 or 405: it has
 * no model list); and, when the upstream answered, `detail`: its status again and its own error text, bounded, cleaned
 * and never a piece of the key (`upstreamDetail`).
 */
const failed = (failure: ProviderCallError): z.infer<typeof callFailure> => ({
  ok: false,
  error: failure.code as ProviderCallCode,
  ...(failure.upstreamStatus === undefined ? {} : { upstreamStatus: String(failure.upstreamStatus) }),
  ...(failure.detail === undefined || Object.keys(failure.detail).length === 0 ? {} : { detail: failure.detail }),
});

/** `POST /api/providers/:id/test`'s body: none, `{}` or `null` (the model list is asked for), or a model to say "hi" to. */
const testBody = z.object({ model: modelName.optional() }).nullish();
/** The test's call to a model: one short message, no thinking, a tiny answer, a short deadline. */
export const CHAT_TEST = { text: "hi", maxOutputTokens: 16, timeoutMs: 15_000 } as const;
const testPassed = z.object({ ok: z.literal(true), mode: z.enum(["chat", "list"]), latencyMs: z.number().int().min(0) });
/** Milliseconds since `started` (a `performance.now()`), whole. */
const since = (started: number): number => Math.max(0, Math.round(performance.now() - started));

/** A failed test call as a provider call's failure: the gateway keeps only the code and the upstream's status. */
function chatFailure(err: unknown): ProviderCallError {
  if (err instanceof ModelError && err.code !== "thinking_exhausted") {
    return new ProviderCallError(err.code, err.upstreamStatus, err.upstreamStatus === undefined ? undefined : { upstreamStatus: String(err.upstreamStatus) });
  }
  return new ProviderCallError("provider_unavailable");
}
const listedModel = z.object({
  name: z.string(),
  vision: z.boolean(),
  pdf: z.boolean(),
  reasoning: z.boolean(),
  chat: z.boolean(),
  known: z.boolean(),
  label: z.string().optional(),
  contextTokens: z.number().optional(),
  reasoningLevels: levelsView.optional(),
  added: z.boolean(),
});

/**
 * The levels the catalogue lists for a model that reasons, read when it is shown (not stored: the choice in `reasoningLevels` — none: every level — never
 * loses them, an old row has them too, and a catalogue update reaches the page at once), so the choice between them and every level stays open.
 */
const reported = (m: ProviderModel): { reportedLevels?: ModelLevel[] } => {
  const levels = m.reasoning ? modelHints(m.name).reasoningLevels : undefined;
  return levels === undefined ? {} : { reportedLevels: levels };
};

/** A provider as its owner sees it (a model's `tools` only when its entry says it). */
const toView = (p: ProviderRow): z.infer<typeof providerView> => ({
  id: p.id,
  name: p.name,
  protocol: p.protocol,
  baseUrl: p.baseUrl,
  keyLast4: p.keyLast4,
  models: p.models.map((m) => ({
    name: m.name,
    vision: m.vision,
    pdf: m.pdf,
    reasoning: m.reasoning,
    contextTokens: m.contextTokens,
    ...(m.reasoningLevels === undefined ? {} : { reasoningLevels: m.reasoningLevels }),
    ...reported(m),
    ...(m.tools === undefined ? {} : { tools: m.tools }),
  })),
});

/**
 * Every route here is the owner's: anyone else's provider id, and an id that is no provider, get the same 404.
 * `allowInsecureLocal` (tests only, `BuildOptions`) also lets a baseUrl be `http:`. `readLimit`: the budget
 * `GET /api/providers` shares with the owner's other reads of their Agents and replies.
 */
export function registerProviderRoutes(
  app: FastifyInstance,
  { allowInsecureLocal, readLimit }: { allowInsecureLocal: boolean; readLimit: PrincipalLimit },
): void {
  const { db, config, providerProbe, models } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  const secret = config.providerKeySecret;

  // Create, edit and delete share one budget; the three routes that call the provider share another.
  const writeLimit = perPrincipalLimit(app, 20);
  const callLimit = perPrincipalLimit(app, 10);

  /**
   * An address as typed, checked: what is stored depends on the protocol too (`providerBaseUrl`), so the handlers make
   * it; whether it may be one does not.
   */
  const baseUrl = z
    .string()
    .max(1000)
    .refine((typed) => providerBaseUrl("openai_chat", typed, allowInsecureLocal) !== null, "not an https URL a provider can have");
  const storedBaseUrl = (protocol: Protocol, typed: string): string => providerBaseUrl(protocol, typed, allowInsecureLocal)!;
  /** Models as given, with the conservative defaults filled in (`tools` only when given: an edit keeps the stored one's). */
  const withDefaults = (list: z.infer<typeof modelList>): ProviderModel[] =>
    list.map((m) => ({
      name: m.name,
      vision: m.vision ?? false,
      pdf: m.pdf ?? false,
      reasoning: m.reasoning ?? false,
      contextTokens: m.contextTokens ?? config.providerDefaultContextTokens,
      ...(m.reasoningLevels === undefined ? {} : { reasoningLevels: m.reasoningLevels }),
      ...(m.tools === undefined ? {} : { tools: m.tools }),
    }));

  /** Logs a failed provider call with what may be logged: never the key, the upstream's body or its headers. */
  const logFailure = (log: FastifyBaseLogger, providerId: string, protocol: Protocol, err: ProviderCallError) =>
    log.info({ providerId, protocol, error: err.code, upstreamStatus: err.upstreamStatus }, "provider call failed");

  /**
   * The owner's provider to call, its key opened (404 when it is not theirs). A saved key that cannot be opened —
   * `PROVIDER_KEY_SECRET` changed, or the value was moved from another row — is logged and answered as a key the provider
   * refused (`provider_rejected`: its owner must save it again); nothing is sent.
   */
  const callTarget = async (log: FastifyBaseLogger, ownerId: string, providerId: string) => {
    let target;
    try {
      target = await loadProviderForCall(db, ownerId, providerId, secret);
    } catch (err) {
      if (!(err instanceof KeyUnreadableError)) throw err;
      log.error({ err, providerId }, "provider: its saved key cannot be opened (PROVIDER_KEY_SECRET changed, or the value was moved or damaged); its owner must save it again");
      throw new ProviderCallError("provider_rejected");
    }
    if (!target) throw notFound();
    return target;
  };

  api.post(
    "/api/providers",
    {
      schema: {
        params: empty,
        querystring: empty,
        body: z.strictObject({ name: providerName, protocol: z.enum(PROTOCOLS), baseUrl, apiKey, models: modelList.optional() }),
        response: { 201: providerView },
      },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const b = req.body;
      const created = await db.tx((t) =>
        createProvider(
          t,
          me.id,
          { name: b.name, protocol: b.protocol, baseUrl: storedBaseUrl(b.protocol, b.baseUrl), apiKey: b.apiKey, models: withDefaults(b.models ?? []) },
          secret,
        ),
      );
      return reply.code(201).send(toView(created));
    },
  );

  api.get(
    "/api/providers",
    { schema: { params: empty, querystring: empty, response: { 200: z.object({ providers: z.array(providerView) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      return { providers: (await listProviders(db, me.id)).map(toView) };
    },
  );

  api.patch(
    "/api/providers/:id",
    {
      schema: {
        params: idParams,
        querystring: empty,
        // Strict: the protocol never changes, so naming it (or anything else) is a 400.
        body: z.strictObject({ name: providerName.optional(), baseUrl: baseUrl.optional(), apiKey: apiKey.optional(), models: modelList.optional() }),
        response: { 200: providerView },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const b = req.body;
      const { updated, affected } = await db.tx(async (t) => {
        // The names on its list before the edit (none for a provider that is not theirs: the edit is 404 then).
        const before = await t.query<{ models: unknown }>("select models from providers where id = $1 and owner_id = $2", [req.params.id, me.id]);
        const was = new Set(parseModels(before.rows[0]?.models).map((m) => m.name));
        const updated = await updateProvider(
          t,
          me.id,
          req.params.id,
          {
            ...(b.name === undefined ? {} : { name: b.name }),
            ...(b.baseUrl === undefined ? {} : { baseUrl: (protocol: Protocol) => storedBaseUrl(protocol, b.baseUrl!) }),
            ...(b.apiKey === undefined ? {} : { apiKey: b.apiKey }),
            ...(b.models === undefined ? {} : { models: withDefaults(b.models) }),
          },
          secret,
        );
        // The names the edit took off the list or put on it: the live Agents on one of them can or cannot be called now.
        const is = new Set(updated.models.map((m) => m.name));
        const changed = [...was].filter((n) => !is.has(n)).concat([...is].filter((n) => !was.has(n)));
        const affected =
          changed.length === 0
            ? []
            : (
                await t.query<{ id: string }>(
                  "select principal_id as id from agents where provider_id = $1 and deleted_at is null and provider_model = any($2::text[]) order by principal_id",
                  [req.params.id, changed],
                )
              ).rows.map((r) => r.id);
        return { updated, affected };
      });
      // Those Agents go to their owner's sockets again (`agent`), so their pages read `modelUsable` anew. After commit:
      // nothing here may fail the edit.
      try {
        for (const id of affected) app.realtime.pushAgentChanged(me.id, id);
      } catch (err) {
        req.log.error({ err, providerId: req.params.id }, "provider edit: pushing the Agents whose model changed failed");
      }
      return toView(updated);
    },
  );

  api.delete(
    "/api/providers/:id",
    { schema: { params: idParams, querystring: empty, body: noBody, response: { 200: z.object({ ok: z.literal(true) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      await db.tx((t) => deleteProvider(t, me.id, req.params.id));
      return { ok: true as const };
    },
  );

  api.post(
    "/api/providers/:id/test",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: testBody,
        response: { 200: z.union([testPassed, callFailure]) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await callLimit(req, me.id);
      const model = req.body?.model;
      let target;
      try {
        target = await callTarget(req.log, me.id, req.params.id);
      } catch (err) {
        if (err instanceof ProviderCallError) return failed(err);
        throw err;
      }
      const started = performance.now();
      if (model === undefined) {
        try {
          await providerProbe.test(target);
          return { ok: true as const, mode: "list" as const, latencyMs: since(started) };
        } catch (err) {
          const failure = toProviderCallError(err);
          logFailure(req.log, req.params.id, target.protocol, failure);
          return failed(failure);
        }
      }
      // One of its saved models; any name while it has none yet.
      const saved = target.models.find((m) => m.name === model);
      if (target.models.length > 0 && saved === undefined) throw new AppError(400, "invalid_request");
      // A call through the gateway like a reply's, but nothing is metered or recorded: a provider costs no points.
      const signal = AbortSignal.timeout(CHAT_TEST.timeoutMs);
      try {
        const events = models.stream({
          protocol: target.protocol,
          baseUrl: target.baseUrl,
          apiKey: target.apiKey,
          model,
          system: "",
          messages: [{ role: "user", parts: [{ type: "text", text: CHAT_TEST.text }] }],
          reasoning: "none",
          maxOutputTokens: CHAT_TEST.maxOutputTokens,
          thinkingSwitch: saved?.reasoning === true,
          // As a reply names it (src/models/resolve.ts): what this upstream refused is remembered for both.
          upstreamId: `provider:${req.params.id}@${target.baseUrl}`,
          signal,
        });
        for await (const event of events) if (event.type === "finish") break;
      } catch (err) {
        // A model that spent its 16 tokens thinking did answer: the connection works.
        if (!(err instanceof ModelError && err.code === "thinking_exhausted")) {
          const failure = chatFailure(err);
          logFailure(req.log, req.params.id, target.protocol, failure);
          return failed(failure);
        }
      }
      return { ok: true as const, mode: "chat" as const, latencyMs: since(started) };
    },
  );

  // The provider's model list for its owner to choose from: the same request as the test, nothing stored.
  api.post(
    "/api/providers/:id/models/list",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: noBody,
        response: {
          200: z.union([z.object({ ok: z.literal(true), listed: z.array(listedModel), source: z.enum(["upstream", "sibling", "catalogue"]) }), callFailure]),
        },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await callLimit(req, me.id);
      let target;
      try {
        target = await callTarget(req.log, me.id, req.params.id);
      } catch (err) {
        if (err instanceof ProviderCallError) return failed(err);
        throw err;
      }
      const saved = new Set(target.models.map((m) => m.name));
      const listedOf = (names: string[]) =>
        usableNames(names, target.apiKey)
          .slice(0, MAX_LISTED_MODELS)
          .map((name) => ({ name, ...modelHints(name), added: saved.has(name) }));
      let names: string[];
      let source: "upstream" | "sibling" = "upstream";
      try {
        // Its own `/models` first; when that is not offered, a sibling listing on the same origin (listing-siblings.json).
        names = await providerProbe.listModels(target, { onSibling: () => void (source = "sibling") });
      } catch (err) {
        const failure = toProviderCallError(err);
        logFailure(req.log, req.params.id, target.protocol, failure);
        // No model list there (404, 405): the public catalogue's models of a provider at that very host, if it knows one.
        const noList = failure.code === "provider_unavailable" && (failure.upstreamStatus === 404 || failure.upstreamStatus === 405);
        const known = noList ? catalogueModels(target.baseUrl) : null;
        if (known !== null) return { ok: true as const, listed: listedOf(known), source: "catalogue" as const };
        return failed(failure);
      }
      return { ok: true as const, listed: listedOf(names), source };
    },
  );

  api.post(
    "/api/providers/:id/models/refresh",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: noBody,
        response: { 200: z.object({ listed: z.array(z.string()), provider: providerView }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await callLimit(req, me.id);
      const target = await callTarget(req.log, me.id, req.params.id);
      let names: string[];
      try {
        names = await providerProbe.listModels(target);
      } catch (err) {
        const failure = toProviderCallError(err);
        logFailure(req.log, req.params.id, target.protocol, failure);
        throw failure;
      }
      const listed = usableNames(names, target.apiKey);
      const provider = await db.tx((t) => mergeListedModels(t, me.id, req.params.id, listed, config.providerDefaultContextTokens));
      return { listed, provider: toView(provider) };
    },
  );
}
