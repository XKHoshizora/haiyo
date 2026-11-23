// What the pages say of other people's use of my Agents, in one place: the three states of "can others still use it today" and the
// one-time notice. All of it is system UI text, never an Agent's voice, and the product owner confirms it (plan "Exact copy": the
// three wordings and the notice are marked "copy for the owner to confirm"). The state itself is the service's (`reached`, `tight`
// per Agent and for the owner): the web only words it, and never compares what was used with a limit.
import { formatPoints } from "./viewmodel.js";

/**
 * The three states, in order: every reply fits (正常), a long one may be refused for its size (余量不多…), every reply is refused (别人今天的
 * 额度已用完: it is OTHER PEOPLE's use that is used up; the owner's own chat with the Agent is not affected).
 */
export const OTHERS_STATES = {
  ok: "正常",
  tight: "余量不多，较长的回复可能发不出",
  reached: "别人今天的额度已用完",
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
 * counted in it), an Agent's own limit that stood at the old 20 points is gone, and the proactive limit that stood at 20 is now 70 —
 * and where to change it. `limits` are the owner's two numbers as the use route gives them.
 */
export const OTHERS_NOTICE_BUTTON = "知道了";
export const othersNoticeText = (limits) =>
  `别人用你的 Agent，每天的上限变了：以前每个 Agent 各有 20 点，现在你所有的 Agent 合在一起，每天最多回别人 ${limits.answers} 次、最多花你 ${formatPoints(limits.points)} 点，它们主动说的话也算在里面。每个 Agent 原来的 20 点上限已取消；主动回复的上限原来是 20 点的，已改成 70 点。可以在“设置 › 别人怎么用我的 Agent”里改。`;
