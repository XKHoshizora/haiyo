// What the pages say of other people's use of my Agents, in one place: the three states of "can others still use it today" and the
// one-time notice. All of it is system UI text, never an Agent's voice, and the product owner confirms it (plan "Exact copy": the
// three wordings and the notice are marked "copy for the owner to confirm"). The state itself is the service's (`reached`, `tight`
// per Agent and for the owner): the web only words it, and never compares what was used with a limit.
import { formatPoints } from "./viewmodel.js";

/**
 * The three states, in order: every reply fits (正常), a long one may be refused for its size (快用完了…), every reply is refused (今天给别人的
 * 额度用完了: it is OTHER PEOPLE's use that is used up; the owner's own chat with the Agent is not affected).
 */
export const OTHERS_STATES = {
  ok: "正常",
  tight: "快用完了，长一点的回复可能发不出",
  reached: "今天给别人的额度用完了，明天零点恢复",
};

/** Which of the three states a use row says (`agents[]`, or the owner's own): `reached` first (it implies `tight`), then `tight`. */
export function othersStateOf(row) {
  if (row?.reached === true) return "reached";
  if (row?.tight === true) return "tight";
  return "ok";
}

/** The words of a use row's state. */
export const othersStateText = (row) => OTHERS_STATES[othersStateOf(row)];

/**
 * The one-time notice at the top of 我的 Agent, shown while the service says `notice` and dismissed for good (「知道了」): it says what
 * changed — the limit is no longer each Agent's own but one for all of them together (a day's answers and points, proactive replies
 * counted in it), an Agent's own limit that stood at the old 20 points is gone, a number the owner set stays as a limit INSIDE the total,
 * an Agent set to "no limit" is now held to the total too, and the proactive limit that stood at 20 is now 70 — and where to change it.
 * One text, true for every owner (fix round 1, I1): one who never changed a number, one who chose 不限, one above the total, one below. `limits` are the owner's two numbers as the use route gives them.
 */
export const OTHERS_NOTICE_BUTTON = "知道了";
export const othersNoticeText = (limits) =>
  `别人用你的 Agent，每天的上限改了。现在你所有的 Agent 合在一起，每天最多回别人 ${limits.answers} 次、最多花你 ${formatPoints(limits.points)} 点，它们主动回复的也算在内。原来每个 Agent 默认的 20 点上限已取消。你单独给某个 Agent 设过的上限还在，但不会超过这个总数；原来设为“不限”的，现在也按这个总数算。主动回复的上限原来是 20 点的，已改成 70 点。可在“设置 › 别人怎么用我的 Agent”里修改。`;

/** On an Agent's card, when only that Agent's own number is used up (the owner's day is not): three characters, so the name keeps its room. */
export const OTHERS_REACHED_SHORT = "已用完";
