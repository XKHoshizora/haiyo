// The search tool first: it starts the chain search.ts → agents/context.ts → agents/replay.ts that once closed a cycle.
import { SEARCH_MESSAGES } from "../src/agents/tools/search.ts";
import { describe, expect, it } from "vitest";
import { REFUSAL_SENTENCES, REPLAY_TOOLS } from "../src/agents/replay.ts";
import { QUERY_TOO_SHORT, SEARCH_TIMEOUT } from "../src/agents/tools/search-words.ts";
import { SEARCH_WEB } from "../src/agents/tools/web/tool.ts";

/**
 * agents/replay.ts builds its tables as it loads (review M3, fix round 1): the tools' names and sentences it reads live in
 * leaf modules (tools/search-words.ts, tools/web/words.ts), so however the service's modules are first loaded — here the
 * search tool first, the order that left `search_messages` unset when replay.ts still imported tools/search.ts — every
 * name and sentence is there.
 */
describe("replay.ts's tables, whatever is loaded first", () => {
  it("name every step-1 tool and hold every refusal sentence: nothing an import cycle left unset", () => {
    expect(REPLAY_TOOLS).toEqual([SEARCH_WEB, SEARCH_MESSAGES, "current_time"]);
    expect(REPLAY_TOOLS.every((name) => typeof name === "string")).toBe(true);
    expect([...REFUSAL_SENTENCES].every((s) => typeof s === "string" && s !== "")).toBe(true);
    expect([REFUSAL_SENTENCES.has(SEARCH_TIMEOUT), REFUSAL_SENTENCES.has(QUERY_TOO_SHORT)]).toEqual([true, true]);
  });
});
