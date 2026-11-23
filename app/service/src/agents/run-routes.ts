import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { perPrincipalLimit, type PrincipalLimit } from "../limits.ts";
import { uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";
import { modelUsable } from "../models/resolve.ts";
import { readOwnedAgent } from "./store.ts";
import { dismissRun, groupRuns, haltAgents, latestRun, ownedAgentOf, pushBudgetReached, retryRun, stopRun, toWireRun, wireRunSchema } from "./runs.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });
const ok = z.object({ ok: z.literal(true) });
/** Retry and dismiss: which Agent's run, in a group (required there); in an Agent's own conversation it plays no part. */
const agentBody = z.object({ agentId: uuidParam.optional() }).nullish();

/**
 * The owner's view of their Agent's replies, per conversation (README "Replies"). For anyone else, and for a
 * conversation that is not an Agent's, a group or a social conversation, every route answers the JSON 404 exactly as for an id that does not
 * exist. In a group a run's owner stops, retries and dismisses it (retry and dismiss name the Agent, `agentId`), and
 * every current member reads what they may know of the group's replies (`GET …/runs`). In a social conversation (`placeOf`) the same
 * but for retry, which is 404: the owner is there as an observer, the visitor reads the state. The one route here that is not
 * about one owner's runs: a group member's halt of Agents calling each other (`…/agents/halt`).
 * `readLimit`: the budget `GET …/run` and `GET …/runs` share with the owner's other reads of their Agents and providers.
 */
export function registerRunRoutes(app: FastifyInstance, { readLimit }: { readLimit: PrincipalLimit }): void {
  const { db, config, conversations } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  // Stop, retry and dismiss share one budget; a retry also counts toward the replies one may start a minute.
  const writeLimit = perPrincipalLimit(app, 60);
  const noBody = empty.nullish();

  api.get(
    "/api/conversations/:id/run",
    { schema: { params: idParams, querystring: empty, response: { 200: z.object({ run: wireRunSchema.nullable() }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      const agentId = await ownedAgentOf(db, me.id, req.params.id);
      if (!agentId) throw notFound();
      const run = await latestRun(db, req.params.id);
      // A failure the owner dismissed is no longer shown. One shown is retryable by the Agent's model as it is now.
      if (!run || (run.status === "failed" && run.dismissed_at !== null)) return { run: null };
      const agent = run.status === "failed" ? await readOwnedAgent(db, me.id, agentId) : null;
      return { run: toWireRun(run, agent ? await modelUsable(db, config, agent) : undefined) };
    },
  );

  // A group's replies as this member may know them: the state of each Agent's, the run of their own (runs.ts `groupRuns`).
  const groupEntry = z.object({ agentId: z.string(), state: z.enum(["replying", "unavailable"]), run: wireRunSchema.optional() });
  api.get(
    "/api/conversations/:id/runs",
    { schema: { params: idParams, querystring: empty, response: { 200: z.object({ runs: z.array(groupEntry) }) } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      return { runs: await groupRuns(db, me.id, req.params.id, config) };
    },
  );

  api.post(
    "/api/conversations/:id/runs/:runId/stop",
    { schema: { params: z.object({ id: uuidParam, runId: uuidParam }), querystring: empty, body: noBody, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const { stopped, running, followed } = await db.tx((t) => stopRun(t, me.id, req.params.id, req.params.runId, config));
      // (A told reply's announcement brings its owner its whisper as it is now: open again — sync/hub.ts.)
      if (stopped) app.agentPort.announce(stopped);
      // A queued run stopped: what was noted on it is followed up (a told reply's members' calls; what an admission handed back).
      if (followed.run) app.agentPort.announce(followed.run);
      if (followed.notices.length > 0) app.deps.conversations.publish({ messages: followed.notices, conversations: [] }, req.log);
      pushBudgetReached(app.realtime, followed.budgetReached);
      if (running) {
        // This process's worker stops it within 50 ms; a later attempt of it ends stopped (the stop is kept in its row).
        // A run nobody here is working on (another instance's, or one left by a process that is gone) would never read
        // the flag: it is released now, as recovery would end it.
        if (app.agentWorker.isWorking(req.params.runId)) app.agentPort.stopAsked(req.params.runId);
        else await app.agentPort.releaseRun(req.params.runId);
      }
      return { ok: true as const };
    },
  );

  api.post(
    "/api/conversations/:id/runs/retry",
    { schema: { params: idParams, querystring: empty, body: agentBody, response: { 201: z.object({ run: wireRunSchema }) } } },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const queued = await db.tx((t) => retryRun(t, me.id, req.params.id, req.body?.agentId, config));
      app.agentPort.announce(queued);
      return reply.code(201).send({ run: queued.run });
    },
  );

  // Any current member of a group stops Agents calling each other there (runs.ts `haltAgents`); a budget of its own.
  const haltLimit = perPrincipalLimit(app, 20);
  api.post(
    "/api/conversations/:id/agents/halt",
    { schema: { params: idParams, querystring: empty, body: noBody, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await haltLimit(req, me.id);
      const halted = await db.tx((t) => haltAgents(t, req.params.id, me.id, config));
      // Before answering: the interrupted calls are abandoned, and nothing more of them reaches their owners.
      app.agentPort.interruptRuns(halted.running);
      for (const cancelled of halted.cancelled) app.agentPort.announce(cancelled);
      if (halted.notice) conversations.publish({ messages: [halted.notice], conversations: [] }, req.log);
      // A person's call noted on a queued run it ended gets its follow-up (announced above): what deciding it appended.
      if (halted.followed.notices.length > 0) conversations.publish({ messages: halted.followed.notices, conversations: [] }, req.log);
      pushBudgetReached(app.realtime, halted.followed.budgetReached);
      return { ok: true as const };
    },
  );

  api.post(
    "/api/conversations/:id/runs/dismiss",
    { schema: { params: idParams, querystring: empty, body: agentBody, response: { 200: ok } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await writeLimit(req, me.id);
      const dismissed = await db.tx((t) => dismissRun(t, me.id, req.params.id, req.body?.agentId));
      // In a group the others' line for that Agent goes (its owner, who closed it, is not told).
      if (dismissed) app.realtime.pushRunState(dismissed.conversationId, dismissed.runId);
      return { ok: true as const };
    },
  );
}
