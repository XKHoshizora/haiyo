import { isPast } from "../data/deadline.js";

/**
 * Whole days left of a request, to the nearest day (a request made a moment ago with 7 days to live reads 7 even when the clocks differ by a
 * few minutes; rounding up would read 8), 1 at least. `untilText` counts the same way, so the dialog and the rows never read two numbers.
 */
export function daysLeft(iso, now) {
  const left = Date.parse(iso) - now;
  return Number.isFinite(left) ? Math.max(1, Math.round(left / 86_400_000)) : null;
}

/**
 * When a request or a card runs out, in the words of a person: whole days from a day on, hours below it (never 「168 小时」); 已过期 from the
 * deadline on (data/deadline.js `isPast`, the one rule); nothing for an unreadable time, as a friend request's `expiryText` says.
 */
export function untilText(iso, now) {
  const left = Date.parse(iso) - now;
  if (!Number.isFinite(left)) return "";
  if (isPast(iso, now)) return "已过期";
  const hours = Math.ceil(left / 3_600_000);
  return hours >= 24 ? `还有 ${daysLeft(iso, now)} 天过期` : `还有 ${Math.max(1, hours)} 小时过期`;
}
