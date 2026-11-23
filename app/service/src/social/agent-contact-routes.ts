import type { FastifyInstance } from "fastify";

// Lane A's route plugin (plan "Step 0 interfaces", Routes; README "Agent social"). Step 0 wires it in `app.ts` (frozen after Step 0) and
// registers NO route: a route that does not exist answers the ordinary 404, which is all a placeholder could say. A lane adds a route by
// writing it here, with its request and answer schemas, and in the same edit adds what every route has (plan File map, "shared, row per
// route"): its probe row in tests/fuzz.test.ts, its README heading, and, if the name is new, its path parameter in tests/logging.test.ts.
// From that moment fuzz, logging and readme tests hold it in full. Planned routes (README "Agent social" has the shapes): POST and GET
// /api/agent-contacts; POST …/:agentId/:subjectId/approve and /decline; DELETE …/:agentId/:subjectId; GET /api/agents/:id/contacts;
// PUT /api/agents/:id/contact-policy; PUT and DELETE /api/bars/:personId; POST /api/reports; PUT /api/agents/:id/note-verdicts;
// POST /api/agents/:id/persona-facts/:seq. While `SOCIAL.enabled` is false every one of them answers 404 (the lookup,
// `GET /api/principals/lookup`, is not here: it exists already).
export function registerAgentContactRoutes(_app: FastifyInstance): void {}
