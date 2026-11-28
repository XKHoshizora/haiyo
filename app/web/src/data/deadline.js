/**
 * Whether a deadline the service gave (an ISO time) has passed at `now`: the one rule of a request's end on this page — a friend request's
 * 已过期 (viewmodel.js `expiryText`), an Agent request's (pages/untilText.js), 通讯录's number (state/selectors.js `waitingForMe`) and
 * whether 同意 / 拒绝 / 撤回 is still offered, and the end of the view's other offers (a failed reply's 重试, an open whisper: viewmodel.js
 * `offerAsOf`, `whisperAsOf`). Past from the deadline itself on. An unreadable or missing time is not past: its text says
 * nothing, and the service answers whatever is done with it. (No imports: everything that decides an end can read it.)
 */
export function isPast(iso, now) {
  const ms = typeof iso === "string" ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) && ms <= now;
}
