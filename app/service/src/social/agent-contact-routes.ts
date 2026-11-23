import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { uuidParam } from "../schemas.ts";
import { requirePrincipal } from "../session.ts";

// Lane A's routes (plan "Step 0 interfaces", Routes; README "Agent social"). STEP 0 registers each with its request schema and
// answers 404 `not_found` to a signed-in caller (401 to nobody, 400 to a malformed request, before the stub). Lane A (ring 1a:
// A2 to A5, A10, A11; ring 1b: A6b, A8b) writes the bodies and the answers, and keeps the schemas. While `SOCIAL.enabled` is
// false the real routes answer 404 as the stubs do (the lookup, `GET /api/principals/lookup`, is not here: it exists already).

const empty = z.object({});
const pairParams = z.object({ agentId: uuidParam, subjectId: uuidParam });
const idParams = z.object({ id: uuidParam });
const personParams = z.object({ personId: uuidParam });

/** Who may add an Agent: after the owner's yes (`ask`), any of the owner's contacts (`contacts`, or only the `picks`), or nobody (`none`). */
const policyBody = z.strictObject({
  policy: z.enum(["ask", "contacts", "none"]),
  picked: z.boolean(),
  picks: z.array(uuidParam).max(500),
  dryRun: z.boolean().optional(),
});

const reportBody = z.strictObject({
  agentId: uuidParam,
  reason: z.enum(["spam", "harassment", "privacy", "other"]),
  note: z.string().max(500).optional(),
});

/** An owner's yes or no on one note for one audience, optionally answering the card it came from (ring 1b). */
const verdictBody = z.strictObject({
  noteKind: z.enum(["owner", "self"]),
  noteId: uuidParam,
  audienceId: uuidParam,
  share: z.boolean(),
  cardSeq: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),
});

const personaFactParams = z.object({ id: uuidParam, seq: z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER) });

export function registerAgentContactRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const stub = async (req: Parameters<typeof requirePrincipal>[0]): Promise<never> => {
    await requirePrincipal(req);
    throw notFound();
  };

  api.post("/api/agent-contacts", { schema: { params: empty, querystring: empty, body: z.strictObject({ agentId: uuidParam }) } }, async (req) => stub(req));
  api.get("/api/agent-contacts", { schema: { params: empty, querystring: empty } }, async (req) => stub(req));
  api.post("/api/agent-contacts/:agentId/:subjectId/approve", { schema: { params: pairParams, querystring: empty } }, async (req) => stub(req));
  api.post("/api/agent-contacts/:agentId/:subjectId/decline", { schema: { params: pairParams, querystring: empty } }, async (req) => stub(req));
  api.delete("/api/agent-contacts/:agentId/:subjectId", { schema: { params: pairParams, querystring: empty } }, async (req) => stub(req));
  api.get("/api/agents/:id/contacts", { schema: { params: idParams, querystring: empty } }, async (req) => stub(req));
  api.put("/api/agents/:id/contact-policy", { schema: { params: idParams, querystring: empty, body: policyBody } }, async (req) => stub(req));
  api.put("/api/bars/:personId", { schema: { params: personParams, querystring: empty } }, async (req) => stub(req));
  api.delete("/api/bars/:personId", { schema: { params: personParams, querystring: empty } }, async (req) => stub(req));
  api.post("/api/reports", { schema: { params: empty, querystring: empty, body: reportBody } }, async (req) => stub(req));
  api.put("/api/agents/:id/note-verdicts", { schema: { params: idParams, querystring: empty, body: verdictBody } }, async (req) => stub(req));
  api.post("/api/agents/:id/persona-facts/:seq", { schema: { params: personaFactParams, querystring: empty, body: z.strictObject({ move: z.boolean() }) } }, async (req) => stub(req));
}
