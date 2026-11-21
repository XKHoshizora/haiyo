import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
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
});

/**
 * `GET /api/models` (README "Calling a model"): what a client's model picker reads. The site models in configuration
 * order, each with what its owner chooses by and whether its replies may be offered tools (`tools`) — never where it is
 * called (`baseUrl`, `protocol`), by what upstream name, with which key (`apiKeyEnv`, the key) or at what price — the
 * defaults a provider model gets, and whether proactive replies can be turned on (`proactiveAvailable`: the judgement
 * model is configured), and — only when it does — that the site offers web search (`webSearchAvailable`).
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
        ...(app.deps.webEngine !== null ? { webSearchAvailable: true as const } : {}),
      };
    },
  );
}
