import type { FastifyInstance } from "fastify";

// Lane B's route plugin (plan "Step 0 interfaces", Routes; README "Agent social"). Step 0 wires it in `app.ts` (frozen after Step 0) and
// registers NO route; lane B adds each one here with its schemas and, in the same edit, its probe row in tests/fuzz.test.ts, its README
// heading and a new path parameter's name in tests/logging.test.ts (plan File map, "shared, row per route"). Planned: GET /api/me/others-use,
// PUT /api/me/others-limits, POST /api/me/others-limits/seen. Unlike lane A's they are live whatever `SOCIAL.enabled` says (step L).
export function registerOthersRoutes(_app: FastifyInstance): void {}
