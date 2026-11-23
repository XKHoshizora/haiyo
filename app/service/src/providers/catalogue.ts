import { z } from "zod";
import providerFile from "./provider-catalog.json" with { type: "json" };
import suffixFile from "./listing-suffixes.json" with { type: "json" };
import { hostSuffixSchema, hostUnderSuffix } from "./host-suffix.ts";

/**
 * The catalogue's providers by the host their API answers at (provider-catalog.json, written with model-catalog.json by
 * `npm run catalog:update`; never fetched at run time): what `POST /api/providers/:id/models/list` offers when the
 * provider's own address has no model list (README "Model providers"). `listing-suffixes.json` (hand-kept; the generated
 * snapshot is never edited) adds hosts by suffix for providers that give each workspace its own subdomain.
 */

const catalogProvider = z.strictObject({
  id: z.string().min(1),
  hosts: z.array(z.string().min(1)).min(1),
  models: z.array(z.string().min(1)).min(1),
});

/** Host name (lower case) → the model ids of every catalogue provider at that host, in the snapshot's order, each once. */
const BY_HOST = new Map<string, string[]>();
for (const provider of z.array(catalogProvider).parse(providerFile)) {
  for (const host of provider.hosts) {
    const ids = BY_HOST.get(host.toLowerCase()) ?? [];
    for (const id of provider.models) if (!ids.includes(id)) ids.push(id);
    BY_HOST.set(host.toLowerCase(), ids);
  }
}

/**
 * Host suffix → the catalogue host whose models it shares (`likeHost` must be a host of the snapshot). A suffix has at
 * least `MIN_SUFFIX_LABELS` labels, so no rule can cover a public suffix or a whole company's domain.
 */
const SUFFIX_RULES = z
  .array(
    z.strictObject({
      hostSuffix: hostSuffixSchema,
      likeHost: z.string().min(1),
    }),
  )
  .parse(suffixFile)
  .map((rule) => {
    if (!BY_HOST.has(rule.likeHost)) throw new Error(`listing-suffixes.json: ${rule.likeHost} is no host of provider-catalog.json`);
    return rule;
  });

/**
 * The model ids the catalogue lists for the providers whose API is at `baseUrl`'s host — the exact host name, port and
 * path aside (`https://api.deepseek.com/v1` is `api.deepseek.com`) — else, for a host under a suffix of
 * `listing-suffixes.json` (a workspace subdomain), those of the host the rule names; or null when it knows none there.
 * An exact host always wins over a suffix.
 */
export function catalogueModels(baseUrl: string): string[] | null {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const exact = BY_HOST.get(host);
  if (exact) return exact.slice();
  const rule = SUFFIX_RULES.find((r) => hostUnderSuffix(host, r.hostSuffix));
  return rule ? BY_HOST.get(rule.likeHost)!.slice() : null;
}
