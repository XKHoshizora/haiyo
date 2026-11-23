import { z } from "zod";
import tableFile from "./listing-siblings.json" with { type: "json" };
import { hostSuffixSchema, hostUnderSuffix } from "./host-suffix.ts";

/**
 * Where a provider may keep its model list when its own `{baseUrl}/models` has none (README "Model providers",
 * `POST /api/providers/:id/models/list`): a short, fixed, hand-kept table (listing-siblings.json), never guessed in code.
 * A sibling is always on the SAME origin as the stored base URL (scheme, host and port), asked with the same key in the
 * OpenAI-compatible form (`Authorization: Bearer`), and never stored as the provider's address.
 */

/** At most this many sibling listings are asked after the base's own `/models` (so a listing is at most 1 + this requests). */
export const MAX_SIBLING_REQUESTS = 2;

const listingPath = z.string().regex(/^\/[a-z0-9/_.-]*\/models$/).refine((p) => !p.startsWith("//"), "a path on the same origin");
const tableSchema = z.strictObject({
  /** Hosts under one of the suffixes (the suffix itself too) are tried at these paths, in this order. */
  rules: z.array(z.strictObject({ hostSuffixes: z.array(hostSuffixSchema).min(1), paths: z.array(listingPath).min(1) })),
  /** Tried last, for any host, unless it is the base's own listing. */
  generic: z.array(listingPath),
});
export type SiblingTable = z.infer<typeof tableSchema>;

/** The committed table. */
export const SIBLING_TABLE: SiblingTable = tableSchema.parse(tableFile);

/**
 * The sibling listing URLs to ask after `{baseUrl}/models`, in order: the paths of every rule whose suffix the host is
 * under, then the generic ones; each built as the base's own origin + the path, so none can name another host; none that
 * is the base's own listing; each once; at most `MAX_SIBLING_REQUESTS`. Empty for a base URL that does not parse.
 */
export function siblingListingUrls(baseUrl: string, table: SiblingTable = SIBLING_TABLE): string[] {
  let origin: string;
  let host: string;
  try {
    const url = new URL(baseUrl);
    origin = url.origin;
    host = url.hostname.toLowerCase();
  } catch {
    return [];
  }
  const own = `${baseUrl}/models`;
  const paths = [...table.rules.filter((r) => r.hostSuffixes.some((s) => hostUnderSuffix(host, s))).flatMap((r) => r.paths), ...table.generic];
  let ownHref = own;
  try {
    ownHref = new URL(own).href;
  } catch {
    // an unparseable base gave no origin above
  }
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const path of paths) {
    if (!path.startsWith("/") || path.startsWith("//")) continue;
    const candidate = `${origin}${path}`;
    let same = false;
    try {
      same = new URL(candidate).origin === origin;
    } catch {
      // not a URL: skipped
    }
    // Compared as URLs, so another spelling of the same path (`/%76 1`) is the same resource.
    let href = candidate;
    try {
      href = new URL(candidate).href;
    } catch {
      // not a URL: skipped by `same`
    }
    if (same && href !== ownHref && !seen.has(href)) {
      urls.push(candidate);
      seen.add(href);
    }
  }
  return urls.slice(0, MAX_SIBLING_REQUESTS);
}
