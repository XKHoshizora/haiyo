import { z } from "zod";

/**
 * Whether `host` is `suffix` or a name under it, on a label boundary: `maas.aliyuncs.com` matches `ws-1.cn-beijing.maas.aliyuncs.com`
 * and itself, never `xmaas.aliyuncs.com` or `maas.aliyuncs.com.evil.example`. Both lower case. (A bare `.` prefix is not needed.)
 */
export function hostUnderSuffix(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

/** The fewest labels a suffix rule in a hand-kept table may have: `aliyuncs.com` (2) is a whole company's hosts, `maas.aliyuncs.com` (3) is one service. */
export const MIN_SUFFIX_LABELS = 3;

/** A host suffix of a hand-kept table: lower case, at least `MIN_SUFFIX_LABELS` labels, no leading or trailing dot. */
export const hostSuffixSchema = z
  .string()
  .regex(/^[a-z0-9.-]+$/)
  .refine((s) => s.split(".").length >= MIN_SUFFIX_LABELS && !s.startsWith(".") && !s.endsWith("."), `at least ${MIN_SUFFIX_LABELS} labels`);
