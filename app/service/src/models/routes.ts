import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { aboutPoints, formatPoints } from "../accounts/store.ts";
import { siteOffersWebSearch } from "../agents/tools/web/engine.ts";
import { REASONING_LEVELS } from "../config.ts";
import { perPrincipalLimit } from "../limits.ts";
import { OWN_KEY_NOMINAL_MICRO, othersReplyCeilingMicro } from "../metering/others.ts";
import { abilitiesOf, abilitiesView, modelHints, type Abilities } from "../providers/hints.ts";
import { requirePrincipal } from "../session.ts";
import { sendableLevels } from "./resolve.ts";

const { reportedTools: _reportedTools, ...siteMediaView } = abilitiesView;

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
      /**
       * For each level it runs at (`none` and `reasoning`), about the most one reply to somebody other than the Agent's owner can cost
       * there, in points (`aboutPoints` of metering/others.ts `othersReplyCeilingMicro`): the hint under the two levels for others.
       */
      othersCeiling: z.record(z.string(), z.string()),
      ...siteMediaView,
    }),
  ),
  /** What one reply to somebody else on an owner's own provider key counts toward the owner's number for others' use (points), never charged. */
  othersOwnKeyPoints: z.string(),
  providerDefaults: z.object({ contextTokens: z.number(), maxOutputTokens: z.number() }),
  proactiveAvailable: z.boolean(),
  /** Present (true) only while the site offers web search (`TOOLS.web.enabled` and its key there): the Agent form then shows 联网搜索. */
  webSearchAvailable: z.literal(true).optional(),
  /** With it: about what one search costs, in points (`aboutPoints` of `TOOLS.web.pointsMicroPerSearch`): the form's 每次约 n 点. */
  webSearchPoints: z.string().optional(),
  memoryCatchUp: z.object({ days: z.number(), lines: z.number() }),
});

/**
 * What the catalogue says a site model takes and answers with besides what its configuration states (audio and video
 * in; images, video and audio out): of the name it is called by when the catalogue knows that name, else of its id —
 * in both cases only when that is a catalogue model itself, never a name that merely starts with one (`modelHints`) —
 * else nothing. Never `reportedTools`, `vision`, `pdf` or its thinking levels: those are the operator's (`tools`).
 */
function siteMedia(site: { id: string; model: string }): Omit<Abilities, "reportedTools"> {
  const called = modelHints(site.model);
  const { reportedTools: _tools, ...media } = abilitiesOf(called.known ? called : modelHints(site.id));
  return media;
}

/**
 * `GET /api/models` (README "Calling a model"): what a client's model picker reads. The site models in configuration
 * order, each with what its owner chooses by, whether its replies may be offered tools (`tools`) and what else the
 * catalogue knows it to take and answer with (`siteMedia`) — never where it is
 * called (`baseUrl`, `protocol`), by what upstream name, with which key (`apiKeyEnv`, the key) or at what price — the
 * defaults a provider model gets, the hint under the two levels for others (`othersCeiling` per site model, `othersOwnKeyPoints`), and
 * whether proactive replies can be turned on (`proactiveAvailable`: the judgement
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
      const web = siteOffersWebSearch(config, app.deps.webEngine);
      // One search's price, when a reply may search the web: part of what one reply to someone else can cost.
      const searchMicro = web ? BigInt(config.tools.web.pointsMicroPerSearch) : null;
      return {
        siteModels: config.siteModels.map((m) => ({
          id: m.id,
          label: m.label,
          tier: m.tier,
          vision: m.vision,
          pdf: m.pdf,
          // (The levels it can run at: a level its protocol sends as another is listed as that one. models/resolve.ts `sendableLevels`.)
          reasoning: sendableLevels(m.protocol, m.reasoning).filter((level) => level !== "none"),
          contextTokens: m.contextTokens,
          tools: m.tools,
          othersCeiling: Object.fromEntries(sendableLevels(m.protocol, m.reasoning).map((level) => [level, aboutPoints(othersReplyCeilingMicro(config, m, level, searchMicro))])),
          ...siteMedia(m),
        })),
        othersOwnKeyPoints: formatPoints(OWN_KEY_NOMINAL_MICRO),
        providerDefaults: { contextTokens: config.providerDefaultContextTokens, maxOutputTokens: config.providerDefaultMaxOutputTokens },
        proactiveAvailable: config.judge !== null,
        ...(web ? { webSearchAvailable: true as const, webSearchPoints: aboutPoints(searchMicro!) } : {}),
        // How far back turning an Agent's memory on again may look (memory/catchup.ts): what its question says.
        memoryCatchUp: { days: config.memory.catchUpDays, lines: config.memory.catchUpLines },
      };
    },
  );
}
