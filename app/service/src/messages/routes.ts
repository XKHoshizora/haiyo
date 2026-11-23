import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { actOnTriggered, maybeTrigger, noneTriggered, type Triggered } from "../agents/runs.ts";
import { notFound } from "../errors.ts";
import { perPrincipalLimit } from "../limits.ts";
import { hasVisibleText, messageText, positiveInt, positiveIntString, searchTerm, uuidParam } from "../schemas.ts";
import type { Tx } from "../db.ts";
import { requirePrincipal } from "../session.ts";
import { withSlot } from "../slots.ts";
import { wireMessageSchema } from "./model.ts";
import { principalMapSchema, principalsOf } from "./principals.ts";
import { getMessage, listMessages, markRead, toWireFor } from "./read.ts";
import { decodeSearchCursor, inSearchBudget, searchAll, searchConversation } from "./search.ts";
import { MESSAGE_TEXT_MAX, sendMessage } from "./send.ts";

const empty = z.object({});
const idParams = z.object({ id: uuidParam });
/**
 * A send's answer; `notCalled` only when a call of the sender's on someone else's Agent was refused for their caller
 * limit (the sender's alone: never stored with the message, never pushed).
 */
const sendResult = z.object({
  message: wireMessageSchema,
  duplicate: z.boolean(),
  notCalled: z.array(z.object({ agentId: z.string(), reason: z.literal("caller_rate_limited") })).optional(),
});

const sendBody = z
  .object({
    // A caption may be empty or invisible; a text message must show something (the refinement below).
    text: messageText(0, MESSAGE_TEXT_MAX).optional(),
    attachmentId: uuidParam.optional(),
    replyToSeq: positiveInt.optional(),
    clientTxn: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    // Mentions picked from the @ list (Task M): ranges of `text` as stored; checked against it and the members in the
    // send (400 `bad_mentions`). More than a hundred is no list a client makes.
    mentions: z.array(z.strictObject({ id: uuidParam, start: z.number().int(), length: z.number().int() })).max(100).optional(),
  })
  .refine(
    (b) => b.attachmentId !== undefined || (b.text !== undefined && hasVisibleText(b.text)),
    "a text message needs a visible character; a file message an attachmentId",
  );

// Search terms (schemas.ts `searchTerm`): `%`, `_` and `\` are ordinary characters (see search.ts).
const searchLimit = positiveIntString(50);
const searchCursor = z
  .string()
  .transform((s, ctx) => {
    const cursor = decodeSearchCursor(s);
    if (!cursor) ctx.addIssue({ code: "custom", message: "malformed cursor" });
    return cursor ?? z.NEVER;
  });

/**
 * Whether a message called an Agent, as its trigger found (`maybeTrigger`): a call was acted on or refused — a run, a
 * caller's limit, a spent budget and its notice. Nothing more is read for it. A name the trigger did not reach (an Agent
 * outside the group, or one it skipped) reads as no; the decision then refuses that message at its first read.
 */
const calledAnAgent = (t: Triggered): boolean => t.runs.length > 0 || t.callerLimited.length > 0 || t.budgetReached.length > 0 || t.notices.length > 0;

export function registerMessageRoutes(app: FastifyInstance): void {
  const { db, config, conversations, reads, searches, proactive } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();

  const sendLimit = perPrincipalLimit(app, 120);
  /** Reads of one message: what a reply's lookups open, a row each, and a jump to a message. */
  const oneMessageLimit = perPrincipalLimit(app, 120);

  api.post(
    "/api/conversations/:id/messages",
    {
      schema: { params: idParams, querystring: empty, body: sendBody, response: { 200: sendResult, 201: sendResult } },
    },
    async (req, reply) => {
      const me = await requirePrincipal(req);
      await sendLimit(req, me.id);

      // Rendered inside the transaction, under the locks that just proved the sender may read it. An owner's
      // message to their Agent, and a message in a group whose mentions (decided in the send) mean Agent members, queue their replies in the
      // same transaction (agents/runs.ts `maybeTrigger`; over an owner's replies a minute, a failed `rate_limited` run
      // instead). Each is announced to its own Agent's owner. A call over its sender's limit on other people's Agents
      // starts nothing: it is logged, and the sender alone is told which in this answer (`notCalled`). A call on someone
      // else's Agent whose others' daily budget is spent starts nothing either: the group is told once a day (published
      // after the message) and the Agent's owner is pushed it.
      const { message, duplicate, wire, triggered, lock } = await db.tx(async (t) => {
        const sent = await sendMessage(t, req.params.id, me.id, req.body, config);
        const [rendered] = await toWireFor(t, me.id, [sent.message], config);
        if (!rendered) throw new Error("sendMessage: sender cannot read the message it just stored");
        const triggered = sent.duplicate ? noneTriggered() : await maybeTrigger(t, sent.lock, sent.message, config);
        return { ...sent, wire: rendered, triggered };
      });
      if (!duplicate) conversations.publish({ messages: [message, ...triggered.notices], conversations: [] }, req.log);
      actOnTriggered(triggered, { announce: (run) => app.agentPort.announce(run), log: req.log, realtime: app.realtime, interrupt: (ids) => app.agentPort.interruptRuns(ids) });
      // A person's message in a group may be answered unasked: the scheduler waits for people to stop, then has the latest
      // judged (agents/proactive/scheduler.ts); one that called an Agent cancels the wait instead. Without a judgement
      // model there is no scheduler.
      if (!duplicate && proactive !== null && lock.conversation.type === "group") {
        proactive.noted(message.conversationId, message.seq, message.senderId, calledAnAgent(triggered));
      }
      const notCalled = triggered.callerLimited.map(({ agentId }) => ({ agentId, reason: "caller_rate_limited" as const }));
      return reply.code(duplicate ? 200 : 201).send({ message: wire, duplicate, ...(notCalled.length > 0 ? { notCalled } : {}) });
    },
  );

  api.get(
    "/api/conversations/:id/messages",
    {
      schema: {
        params: idParams,
        querystring: z.object({ before: positiveIntString().optional(), limit: positiveIntString(100).optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.number().nullable(), principals: principalMapSchema }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const { before, limit = 50 } = req.query;
      const page = await listMessages(db, me.id, req.params.id, { before, limit }, config);
      if (!page) throw notFound();
      return page;
    },
  );

  api.get(
    "/api/conversations/:id/messages/:seq",
    {
      schema: {
        params: z.object({ id: uuidParam, seq: positiveIntString() }),
        querystring: empty,
        response: { 200: z.object({ message: wireMessageSchema, principals: principalMapSchema }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      await oneMessageLimit(req, me.id);
      const message = await getMessage(db, me.id, req.params.id, req.params.seq, config);
      if (!message) throw notFound();
      return { message, principals: await principalsOf(db, [message]) };
    },
  );

  // One budget for both search routes: they are the same expensive read.
  const searchRate = perPrincipalLimit(app, 30);
  const searcher = async (req: FastifyRequest): Promise<string> => {
    const me = await requirePrincipal(req);
    await searchRate(req, me.id);
    return me.id;
  };
  /**
   * One search under both bounds: a slot of the caller's (at most 2 in progress; the slot is held until
   * the search's own transaction ends, even if the client has gone, because the work goes on) and the
   * search statement timeout.
   */
  const search = <T>(me: string, run: (t: Tx) => Promise<T>): Promise<T> =>
    withSlot(searches, me, () => inSearchBudget(db, config.searchStatementTimeoutMs, run));

  api.get(
    "/api/conversations/:id/search",
    {
      schema: {
        params: idParams,
        querystring: z.object({ q: searchTerm, before: positiveIntString().optional(), limit: searchLimit.optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.number().nullable(), principals: principalMapSchema }) },
      },
    },
    async (req) => {
      const me = await searcher(req);
      const { q, before, limit = 20 } = req.query;
      const page = await search(me, (t) => searchConversation(t, me, req.params.id, { q, before, limit }, config));
      if (!page) throw notFound();
      return page;
    },
  );

  api.get(
    "/api/search",
    {
      schema: {
        params: empty,
        querystring: z.object({ q: searchTerm, before: searchCursor.optional(), limit: searchLimit.optional() }),
        response: { 200: z.object({ messages: z.array(wireMessageSchema), nextBefore: z.string().nullable(), principals: principalMapSchema }) },
      },
    },
    async (req) => {
      const me = await searcher(req);
      const { q, before, limit = 20 } = req.query;
      return search(me, (t) => searchAll(t, me, { q, before, limit }, config));
    },
  );

  api.post(
    "/api/conversations/:id/read",
    {
      schema: {
        params: idParams,
        querystring: empty,
        body: z.object({ seq: positiveInt }),
        response: { 200: z.object({ readSeq: z.number() }) },
      },
    },
    async (req) => {
      const me = await requirePrincipal(req);
      const marked = await markRead(db, me.id, req.params.id, req.body.seq);
      if (!marked) throw notFound();
      // Only a direct chat shows the other side's read position, and only when it actually moved.
      if (marked.type === "direct" && marked.readSeq > marked.previous) {
        reads.publish({ conversationId: req.params.id, principalId: me.id, seq: marked.readSeq }, req.log);
      }
      return { readSeq: marked.readSeq };
    },
  );
}
