/**
 * The fixed sentences the web search answers the model with (tool results, never the Agent's words; lane websearch). A
 * module of their own, imported by tool.ts and hold.ts alike, so that no import cycle can leave one undefined when a module
 * reads it as it loads (fix round 1: hold.ts builds its table of refusals at load).
 */
export const WEB_QUERY_LENGTH = "搜索词要 2 到 120 个字。";
export const WEB_QUERY_PRIVATE = "这个搜索词里有不能发到外面的内容（比如笔记里的私事，或群里的人名）。只写要查的公开信息，换个说法再搜。";
export const WEB_BUSY = "现在联网搜索的人太多了，过一会儿再试。";
export const WEB_SITE_DAY = "联网搜索今天暂时用不了了。";
export const WEB_NO_MONEY = "这次回复的点数不够再联网搜索了。";
/**
 * Refused by the reply's own bound (`TOOLS.maxPoints`) and by a budget of its lane (hold.ts `RefusedBy`). The lane
 * budget's words say only the situation — nothing of the owner, of a cap or of its state, which the model could pass on
 * to a group (re-review N1); which bound it was stays in the metric (`web_refused_lane_budget`).
 */
export const WEB_REPLY_CAP = "这次回复能花的点数到上限了，不能再联网搜索了。";
export const WEB_LANE_BUDGET = "这次回复不能再联网搜索了。";
export const WEB_UNAVAILABLE = "联网搜索暂时用不了。";
export const WEB_TIMEOUT = "这次联网搜索超时了。";
export const WEB_REFUSED = "搜索服务拒绝了这个搜索。";
export const WEB_NO_RESULTS = "网上没搜到相关的结果。";
