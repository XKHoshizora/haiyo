// What the pages say of other people's use of my Agents, in one place: whether others can still use them today, the one-time notice and
// the hint under the two level selects. (What a conversation shows — the line under a sender's message a limit refused, the owner's
// notice when the day is used up — is worded with every other notice, data/viewmodel.js.)
// All of it is system UI text, never an Agent's voice. The facts are the service's (`reached`, the number, the refusal's reason): the web
// only words them, and never compares what was used with the number.
import { formatPoints } from "./viewmodel.js";

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
