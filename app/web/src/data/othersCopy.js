// What the pages say of other people's use of my Agents, in one place: the three states of "can others still use it today" and the
// one-time notice. All of it is system UI text, never an Agent's voice, and the product owner confirms it (plan "Exact copy": the
// three wordings and the notice are marked "copy for the owner to confirm"). The state itself is the service's (`reached`, `tight`
// per Agent and for the owner): the web only words it, and never compares what was used with a limit.
import { formatPoints } from "./viewmodel.js";

/** The three states, in order: every reply fits (正常), a long one may be refused for its size (快用完了…), every reply is refused (…用完了). */
export const OTHERS_STATES = {
  ok: "正常",
  tight: "快用完了，较长的回复可能发不出",
  reached: "今天的额度用完了",
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
 * changed — the limit is now per person, shared by all of the owner's Agents, proactive replies counted in it, and the Agents'
 * own limits that stood at the old 20 points now at 70. `limits` are the owner's two numbers as the use route gives them.
 */
export const OTHERS_NOTICE_BUTTON = "知道了";
export const othersNoticeText = (limits) =>
  `别人让你的 Agent 回复，现在按人算：你所有的 Agent 加起来，每天最多回别人 ${limits.answers} 次、最多花你 ${formatPoints(limits.points)} 点，没人叫它时的主动回复也算在里面。Agent 自己的上限和主动回复的上限，原来是 20 点的，都已经提到 70 点。`;
