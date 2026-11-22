/**
 * The search tool's name and the fixed sentences it refuses a call with (search.ts; tool results, never the Agent's
 * words). A module of its own that imports nothing, as web/words.ts is for the web search: what an earlier reply keeps of
 * its calls (agents/replay.ts) reads these, and search.ts sits in an import cycle with the context (search.ts →
 * agents/context.ts → replay.ts), where a value read from search.ts itself could still be unset while the cycle loads.
 */

export const SEARCH_MESSAGES = "search_messages";

export const SEARCH_TIMEOUT = "这次查找超时了。";
export const SEARCH_BUSY = "现在查找的人太多了，过一会儿再查。";
export const QUERY_TOO_SHORT = "要查的词至少要两个字。";
export const QUERY_TOO_LONG = "要查的词太长了，换几个关键的字再查。";
export const BAD_DATE = "日期要写成 YYYY-MM-DD，比如 2026-11-20。";
