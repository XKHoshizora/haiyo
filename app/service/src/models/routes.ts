import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { aboutPoints } from "../accounts/store.ts";
import { siteOffersWebSearch } from "../agents/tools/web/engine.ts";
import { REASONING_LEVELS } from "../config.ts";
import { perPrincipalLimit } from "../limits.ts";
import { requirePrincipal } from "../session.ts";

const modelsResponse = z.object({
  siteModels: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      tier: z.enum(["free", "paid"]),
      vision: z.boolean(),
      pdf: z.boolean(),
      reasoning: z.array(z.enum(REASONING_LEVELS)),
      contextTokens: z.number(),
      tools: z.boolean(),
    }),
  ),
  providerDefaults: z.object({ contextTokens: z.number(), maxOutputTokens: z.number() }),
  proactiveAvailable: z.boolean(),
  /** Present (true) only while the site offers web search (`TOOLS.web.enabled` and its key there): the Agent form then shows 联网搜索. */
  webSearchAvailable: z.literal(true).optional(),
  /** With it: about what one search costs, in points (`aboutPoints` of `TOOLS.web.pointsMicroPerSearch`): the form's 每次约 n 点. */
  webSearchPoints: z.string().optional(),
  memoryCatchUp: z.object({ days: z.number(), lines: z.number() }),
});

/**
 * `GET /api/models` (README "Calling a model"): what a client's model picker reads. The site models in configuration
 * order, each with what its owner chooses by and whether its replies may be offered tools (`tools`) — never where it is
 * called (`baseUrl`, `protocol`), by what upstream name, with which key (`apiKeyEnv`, the key) or at what price — the
 * defaults a provider model gets, and whether proactive replies can be turned on (`proactiveAvailable`: the judgement
 * model is configured), that the site offers web search (`webSearchAvailable`, only when it does) and about what a search costs (`webSearchPoints`), and how far back turning an Agent's memory on again may look (`memoryCatchUp`: `MEMORY.catchUpDays`
 * and `MEMORY.catchUpLines`, what the question under 记忆 says).
 */
export function registerModelRoutes(app: FastifyInstance): void {
  const { config } = app.deps;
  const api = app.withTypeProvider<ZodTypeProvider>();
  // A budget of its own.
  const readLimit = perPrincipalLimit(app, 120);

  api.get(
    "/api/models",
    { schema: { params: z.object({}), querystring: z.object({}), response: { 200: modelsResponse } } },
    async (req) => {
      const me = await requirePrincipal(req);
      await readLimit(req, me.id);
      return {
        siteModels: config.siteModels.map((m) => ({
          id: m.id,
          label: m.label,
          tier: m.tier,
          vision: m.vision,
          pdf: m.pdf,
          reasoning: m.reasoning,
          contextTokens: m.contextTokens,
          tools: m.tools,
        })),
        providerDefaults: { contextTokens: config.providerDefaultContextTokens, maxOutputTokens: config.providerDefaultMaxOutputTokens },
        proactiveAvailable: config.judge !== null,
        ...(siteOffersWebSearch(config, app.deps.webEngine)
          ? { webSearchAvailable: true as const, webSearchPoints: aboutPoints(BigInt(config.tools.web.pointsMicroPerSearch)) }
          : {}),
        // How far back turning an Agent's memory on again may look (memory/catchup.ts): what its question says.
        memoryCatchUp: { days: config.memory.catchUpDays, lines: config.memory.catchUpLines },
      };
    },
  );
}
