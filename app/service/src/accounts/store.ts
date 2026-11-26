import { z } from "zod";
import type { Queryable, Tx } from "../db.ts";

/** Micro-points in one point. Money is `bigint` micro-points everywhere; on the wire it is a decimal string of points. */
export const MICRO_PER_POINT = 1_000_000n;

/** `5_000_000n` → `"5"`, `3_500_000n` → `"3.5"`, `-1n` → `"-0.000001"`: exact, no trailing zeros. */
export function formatPoints(micro: bigint): string {
  const abs = micro < 0n ? -micro : micro;
  const whole = abs / MICRO_PER_POINT;
  const fraction = (abs % MICRO_PER_POINT).toString().padStart(6, "0").replace(/0+$/, "");
  return `${micro < 0n ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

/**
 * About `micro` (0 or more) in points, for a person to read a price by: rounded half up to one decimal at most, no
 * trailing zero, and never "0" for a price above 0 (`770_350n` → `"0.8"`, `1_000_000n` → `"1"`, `40_000n` → `"0.1"`).
 */
export function aboutPoints(micro: bigint): string {
  const tenths = micro <= 0n ? 0n : (micro + 50_000n) / 100_000n || 1n;
  return tenths % 10n === 0n ? `${tenths / 10n}` : `${tenths / 10n}.${tenths % 10n}`;
}

/**
 * A decimal number of points (optional sign, at most 6 fraction digits, at most 12 integer digits) as exact
 * micro-points; `null` for anything else (no exponent, no spaces, no `1.` or `.5`).
 */
export function parsePoints(text: string): bigint | null {
  const m = /^([+-]?)([0-9]{1,12})(?:\.([0-9]{1,6}))?$/.exec(text);
  if (!m) return null;
  const micro = BigInt(m[2]!) * MICRO_PER_POINT + BigInt((m[3] ?? "").padEnd(6, "0"));
  return m[1] === "-" ? -micro : micro;
}

/**
 * A number of points as a request gives it: a decimal string (no sign, no exponent, at most 6 fraction digits), exact micro-points
 * once parsed, from `min` to `max` micro-points inclusive. The one schema of a points limit in a request body (an Agent's
 * `chainBudget`; the owner's one number for others' use).
 */
export const pointsBetween = (min: bigint, max: bigint) =>
  z
    .string()
    .regex(/^[0-9]{1,6}(?:\.[0-9]{1,6})?$/)
    .transform((s) => parsePoints(s)!)
    .refine((micro) => micro >= min && micro <= max);

const parts = (now: Date, timeZone: string, options: Intl.DateTimeFormatOptions): Record<string, string> =>
  Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", ...options })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );

/** The calendar day (`YYYY-MM-DD`) of `now` in `timezone`: what a "day" means for the free allowance. */
export function siteDay(now: Date, timezone: string): string {
  const p = parts(now, timezone, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${p.year}-${p.month}-${p.day}`;
}

/** `day` (`YYYY-MM-DD`) moved by `n` calendar days. */
function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** How far the wall clock of `timezone` is ahead of UTC at the instant `at`, in milliseconds. */
function offsetMs(at: number, timezone: string): number {
  const p = parts(new Date(at), timezone, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return local - Math.floor(at / 1000) * 1000;
}

/** The instant at which `day` (`YYYY-MM-DD`) begins in `timezone`. */
function startOfDay(day: string, timezone: string): Date {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d);
  let at = wall;
  for (let i = 0; i < 3; i++) at = wall - offsetMs(at, timezone);
  return new Date(at);
}

/** The start of the site day `days` before today's (0: today's own start); used for "the last 7 days". */
export function siteDayStart(now: Date, timezone: string, daysBack: number): Date {
  return startOfDay(addDays(siteDay(now, timezone), -daysBack), timezone);
}

/** When the next site day begins, as an instant: what `free.resetsAt` shows. */
export function nextSiteMidnight(now: Date, timezone: string): Date {
  return midnightAfter(siteDay(now, timezone), timezone);
}

/** When the site day after `day` (`YYYY-MM-DD`) begins, as an instant. */
export function midnightAfter(day: string, timezone: string): Date {
  return startOfDay(addDays(day, 1), timezone);
}

/** Creates the owner's account (free tier, balance 0) if there is none. Idempotent. */
export async function ensureAccount(t: Tx, ownerId: string): Promise<void> {
  await t.query("insert into accounts (principal_id) values ($1) on conflict do nothing", [ownerId]);
}

/** Locks the owner's account row for this transaction (creating it first) and returns what it holds. */
export async function lockAccount(t: Tx, ownerId: string): Promise<{ tier: string; balanceMicro: bigint }> {
  await ensureAccount(t, ownerId);
  const { rows } = await t.query<{ tier: string; balance_micro: string }>(
    "select tier, balance_micro::text from accounts where principal_id = $1 for update",
    [ownerId],
  );
  const row = rows[0]!;
  return { tier: row.tier, balanceMicro: BigInt(row.balance_micro) };
}

/**
 * The only code that changes `accounts.balance_micro`: appends the ledger row and moves the balance by
 * `deltaMicro` in the caller's transaction, so the ledger always sums to the balance. Returns the new balance.
 * Callers that decide on the balance first take `lockAccount` before this.
 */
export async function applyLedger(
  t: Tx,
  ownerId: string,
  deltaMicro: bigint,
  reason: "grant" | "adjust" | "usage",
  note: string | null,
  usageId?: string,
): Promise<bigint> {
  await ensureAccount(t, ownerId);
  await t.query(
    "insert into balance_ledger (owner_id, delta_micro, reason, note, usage_id) values ($1, $2, $3, $4, $5)",
    [ownerId, deltaMicro.toString(), reason, note, usageId ?? null],
  );
  const { rows } = await t.query<{ balance_micro: string }>(
    "update accounts set balance_micro = balance_micro + $2 where principal_id = $1 returning balance_micro::text",
    [ownerId, deltaMicro.toString()],
  );
  return BigInt(rows[0]!.balance_micro);
}

/** What the owner's free allowance has used on the current site day (0 if nothing). */
export async function freeUsedToday(q: Queryable, ownerId: string, now: Date, timezone: string): Promise<bigint> {
  const { rows } = await q.query<{ used_micro: string }>(
    "select used_micro::text from free_usage where owner_id = $1 and day = $2::date",
    [ownerId, siteDay(now, timezone)],
  );
  return rows[0] ? BigInt(rows[0].used_micro) : 0n;
}

/** What the owner's memory allowance (paid by the site, `MEMORY.freeDailyPoints`) has used on the current site day (0 if nothing). */
export async function memoryUsedToday(q: Queryable, ownerId: string, now: Date, timezone: string): Promise<bigint> {
  const { rows } = await q.query<{ used_micro: string }>(
    "select used_micro::text from memory_usage where owner_id = $1 and day = $2::date",
    [ownerId, siteDay(now, timezone)],
  );
  return rows[0] ? BigInt(rows[0].used_micro) : 0n;
}
