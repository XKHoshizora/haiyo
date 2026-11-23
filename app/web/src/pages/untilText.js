/** How long a request or a card still stands, in the words of a person: whole days from a day on, hours below it (never 「168 小时」). */
export function untilText(iso, now) {
  const left = Date.parse(iso) - now;
  if (!Number.isFinite(left) || left <= 0) return "已过期";
  const hours = Math.ceil(left / 3_600_000);
  return hours >= 24 ? `${Math.ceil(hours / 24)} 天内有效` : `${Math.max(1, hours)} 小时内有效`;
}
