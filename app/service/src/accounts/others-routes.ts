import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { notFound } from "../errors.ts";
import { requirePrincipal } from "../session.ts";
import { MICRO_PER_POINT, pointsBetween } from "./store.ts";

// Lane B's routes (plan "Step 0 interfaces", Routes; README "Agent social, Others' use"). STEP 0 registers each with its request
// schema and answers 404 `not_found` to a signed-in caller (401 to nobody, 400 to a malformed request, before the stub). Lane B
// (ring 1a: B4) writes the bodies and the answers and keeps the schemas. Unlike lane A's, these are live whatever
// `SOCIAL.enabled` says: the owner's numbers are step L, which ships with the first deploy.

/** The routes of this file that are still Step 0 stubs (see `CONTACT_STUBS` in social/agent-contact-routes.ts): lane B removes an entry when it writes the route. */
export const OTHERS_STUBS: readonly string[] = ["GET /api/me/others-use", "PUT /api/me/others-limits", "POST /api/me/others-limits/seen"];

const empty = z.object({});

/** Points as a request gives them, from 1 to 100 000 (the Agents' budgets' schema). */
const points = pointsBetween(MICRO_PER_POINT, 100_000n * MICRO_PER_POINT);

/** An owner's own pair of daily numbers for what others cause: answers 1 to 1000, points 1 to 100 000. */
const limitsBody = z.strictObject({ answers: z.number().int().min(1).max(1000), points });

export function registerOthersRoutes(app: FastifyInstance): void {
  const api = app.withTypeProvider<ZodTypeProvider>();
  const stub = async (req: Parameters<typeof requirePrincipal>[0]): Promise<never> => {
    await requirePrincipal(req);
    throw notFound();
  };

  api.get("/api/me/others-use", { schema: { params: empty, querystring: empty } }, async (req) => stub(req));
  api.put("/api/me/others-limits", { schema: { params: empty, querystring: empty, body: limitsBody } }, async (req) => stub(req));
  api.post("/api/me/others-limits/seen", { schema: { params: empty, querystring: empty } }, async (req) => stub(req));
}
