// What the pages say of other people's use of my Agents, in one place: whether others can still use them today, the one-time notice and
// the hint under the two level selects. (What a conversation shows — the line under a sender's message a limit refused, the owner's
// notice when the day is used up — is worded with every other notice, data/viewmodel.js.)
// All of it is system UI text, never an Agent's voice. The facts are the service's (`reached`, the number, the refusal's reason): the web
// only words them — but for the one moment it has a new number of mine and no answer with it (`reachedAt`).
import { formatPoints, microPoints } from "./viewmodel.js";

/**
 * Whether today's use (`used`) has reached the number `limit`, by the service's own rule (`reached` is used ≥ limit), in exact
 * micro-points: what the page shows beside a number I have just saved until the service's next answer says it; null when either is
 * no number.
 */
export function reachedAt(used, limit) {
  const [u, l] = [microPoints(used), microPoints(limit)];
  return u === null || l === null ? null : u >= l;
}

/** The two states of the owner's day (`reached` of `GET /api/me/others-use`): every reply for others is still made, or none is. */
export const OTHERS_STATES = {
  ok: "正常",
  reached: "今天给别人的额度用完了，明天恢复",
};

/** Which of the two states the use route says. */
export const othersStateOf = (use) => (use?.reached === true ? "reached" : "ok");

/** The words of the use route's state. */
export const othersStateText = (use) => OTHERS_STATES[othersStateOf(use)];

/**
 * The one-time notice at the top of 我的 Agent, shown while the service says `notice` and dismissed for good (「知道了」): one sentence with
 * the owner's number (`limit`, decimal points), and the entry where it is seen and changed (`OTHERS_NOTICE_LINK`).
 */
export const OTHERS_NOTICE_BUTTON = "知道了";
export const OTHERS_NOTICE_LINK = "查看和修改";
export const othersNoticeText = (limit) => `别人用你的 Agent，每天合计最多花 ${formatPoints(limit)} 点。`;

/** Under each of the two level selects: the most one reply to someone else can cost at that level (decimal points, the service's). */
export const levelCeilingText = (points) => `这一档单条回复最多约 ${formatPoints(points)} 点`;
/**
 * What one reply on the owner's own key counts toward their number (the service's nominal points, `ownKeyPoints` /
 * `othersOwnKeyPoints`): counted, not an "at most" — a web search it makes is charged besides.
 */
export const ownKeyText = (points) => `按 ${formatPoints(points)} 点计，联网搜索另计`;
