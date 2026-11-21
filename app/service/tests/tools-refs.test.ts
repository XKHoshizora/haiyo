import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ContextPlan, FILE_MAX_CHARS } from "../src/agents/runtime/context.ts";
import { groupSystemText, notesPassage } from "../src/agents/runtime/prompt.ts";
import { excerpt } from "../src/agents/tools/search.ts";
import { citesIn, RunRefs, withoutCitations } from "../src/agents/tools/refs.ts";
import { MESSAGE_TEXT_MAX } from "../src/messages/send.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";

/**
 * A reply's numbers (agents/tools/refs.ts) mean something only in the run that gave them (Task 6 fix 1, I-2): what a
 * reply cites is checked against its own run's numbers, however the model wrote them, and every text the model is shown
 * that it did not write in this run is shown without any citation. Pure functions: no database.
 */

const at = (n: number) => ({ conversationId: "c", seq: n });

describe("what a reply's citations become", () => {
  it("〔 M1 〕 is 〔m1〕; a file's number this run gave stays, unlinked; one it never gave, or a message's past the first 20, is taken out", () => {
    const refs = new RunRefs();
    for (let i = 1; i <= 21; i++) refs.message("c", i);
    refs.file("att-1");
    const many = Array.from({ length: 21 }, (_, i) => `〔m${i + 1}〕`).join("");
    const { text, cites } = citesIn(`见〔 M1 〕和〔F1 〕〔f2〕〔m1〕。${many}`, refs);
    expect(text).toBe(`见〔m1〕和〔f1〕〔m1〕。${many.replace("〔m21〕", "")}`);
    expect(cites).toEqual(Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`m${i + 1}`, at(i + 1)])));
  });

  it("text the run did not write keeps no citation of any kind; what is not one is left alone", () => {
    expect(withoutCitations("在河边〔m1〕，见〔 M12 〕和〔f3〕〔F 4〕。")).toBe("在河边，见和。");
    expect(withoutCitations("〔m0〕〔mx〕〔m1234567〕【m1】〔注〕")).toBe("〔m0〕〔mx〕〔m1234567〕【m1】〔注〕");
  });

  it("one citation built around another leaves none behind once the inner one is taken out (final review I-3)", () => {
    expect(withoutCitations("主〔m〔m1〕1〕人")).toBe("主人");
    expect(withoutCitations("〔〔f1〕m〔 M2 〕2〕")).toBe("");
  });

  it("the shared table's cases (app/shared/citation-cases.json, which the web's tests assert too)", () => {
    const table = JSON.parse(readFileSync(new URL("../../shared/citation-cases.json", import.meta.url), "utf8")) as { cases: Array<[string, string]> };
    expect(table.cases.length).toBeGreaterThan(10);
    for (const [text, kept] of table.cases) expect([text, withoutCitations(text)]).toEqual([text, kept]);
  });

  it("one pass gives what taking every citation out again and again until none is left gives (round 2, N-1): random texts of brackets, letters, digits and spaces", () => {
    const CITATION = /〔\s*([mMfF])\s*([1-9][0-9]{0,5})\s*〕/g;
    const again = (text: string): string => {
      let out = text;
      for (let next = out.replace(CITATION, ""); next !== out; next = out.replace(CITATION, "")) out = next;
      return out;
    };
    const alphabet = ["〔", "〕", "m", "M", "f", "F", "1", "2", "0", "9", " ", "　", "\t", "x", "主", "人"];
    // A seeded generator: the same texts every run.
    let seed = 20261121;
    const next = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8) / 16777216;
    for (let i = 0; i < 50_000; i++) {
      const text = Array.from({ length: 1 + Math.floor(next() * 24) }, () => alphabet[Math.floor(next() * alphabet.length)]!).join("");
      const want = again(text);
      if (withoutCitations(text) !== want) expect([text, withoutCitations(text)]).toEqual([text, want]);
    }
  });

  it("linear in the text however it nests (round 2, N-1): a message's longest, and a file's", { timeout: LOADED_TIMEOUT_MS }, () => {
    // `〔m` d times, then `1〕` d times: each citation completes only once the one inside it is out.
    const nest = (n: number): string => "〔m".repeat(n / 4) + "1〕".repeat(n / 4);
    for (const longest of [MESSAGE_TEXT_MAX, FILE_MAX_CHARS]) {
      expect(nest(longest).length).toBe(longest);
      expectLinear({
        n: longest / 4,
        make: nest,
        run: (text) => {
          if (withoutCitations(text) !== "") throw new Error(`a nest of ${text.length} characters left something`);
        },
      });
    }
  });
});

describe("what the model is shown keeps no citation", () => {
  it("a note and a heard thing in the notes passage", () => {
    const passage = notesPassage(
      {
        owner: [{ text: "喜欢河边那家〔m1〕", updatedAt: new Date("2026-11-01T00:00:00Z") }],
        self: [],
        hearsay: [{ text: "他说过〔m2〕周三有空", speakerName: "mia", group: "饭搭子", saidAt: new Date("2026-11-02T00:00:00Z") }],
      },
      false,
      "Asia/Shanghai",
    );
    expect(passage).toContain("喜欢河边那家");
    expect(passage).toContain("他说过周三有空");
    expect(passage).not.toContain("〔");
  });
});

describe("the other strings someone else controls keep no citation either", () => {
  it("a group's title in its system text; a heard thing's speaker and group in the notes passage", () => {
    const scene = { title: "读书会〔m1〕", agents: [], more: false, people: [], morePeople: false };
    const text = groupSystemText({ name: "小帮手", handle: "helper_bot", persona: "P" }, { displayName: "主人甲" }, scene, new Date("2026-11-20T00:00:00Z"), "UTC", "k7f2ab").text;
    expect(text).toContain("读书会");
    expect(text).not.toContain("〔m1〕");
    const passage = notesPassage(
      { owner: [], self: [], hearsay: [{ text: "周三有空", speakerName: "mia〔m2〕", group: "饭搭子〔 M3 〕", saidAt: new Date("2026-11-02T00:00:00Z") }] },
      false,
      "Asia/Shanghai",
    );
    expect(passage).toContain("饭搭子");
    expect(passage).not.toContain("〔");
  });
});

describe("a call never ends with the Agent's own turn", () => {
  const entry = (role: "user" | "assistant", text: string) => ({ role, text, attachment: null });
  /** The roles of the built call, older turns kept as `buildContext` keeps them. */
  const roles = (entries: ReturnType<typeof entry>[], budget = 1000) => {
    const plan = new ContextPlan(entries, budget);
    plan.keepOlder();
    return plan.build().messages.map((m) => m.role);
  };

  it("the plan shows the conversation from the newest person's message, so it ends with a person's turn whatever follows it", () => {
    // A retry: the acknowledgement after the question is not shown.
    expect(roles([entry("user", "查一下"), entry("assistant", "我先查一下。")])).toEqual(["user"]);
    // A told reply: its own 没找到 after the question is not shown either, with older turns kept or not.
    const told = roles([entry("user", "早"), entry("assistant", "早。"), entry("user", "那个计划在哪"), entry("assistant", "没找到。")]);
    expect(told.at(-1)).toBe("user");
    expect(told[0]).toBe("user");
    // Several Agent turns after the question.
    expect(roles([entry("user", "查一下"), entry("assistant", "好。"), entry("assistant", "稍等。")])).toEqual(["user"]);
    // Only the Agent's own turns: nothing is shown (never a call that is just its own turn).
    expect(roles([entry("assistant", "你好。")])).toEqual([]);
    // A budget too small for everything: what is kept still ends with, and starts with, a person's turn.
    const tight = roles([entry("user", "字".repeat(50)), entry("assistant", "好。"), entry("user", "再问"), entry("assistant", "嗯。")], 10);
    expect([tight[0], tight.at(-1)]).toEqual(["user", "user"]);
  });
});

describe("a search result's excerpt", () => {
  it("is cut around the words in the text itself, whatever lower-casing would do to its length", () => {
    // "İ" lower-cases to two code units: an index found in a lower-cased copy lands too far on.
    const text = `${"İ".repeat(150)}${"中".repeat(60)}要找的词${"文".repeat(200)}`;
    expect(excerpt(text, "要找的词")).toContain("要找的词");
  });
});
