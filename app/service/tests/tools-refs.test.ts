import { describe, expect, it } from "vitest";
import { REASONING_MAX } from "../src/agents/conversation.ts";
import { CONTINUE_TURN, endWithPerson } from "../src/agents/runtime/context.ts";
import { groupSystemText, notesPassage } from "../src/agents/runtime/prompt.ts";
import { ReplyStream } from "../src/agents/runtime/stream.ts";
import { excerpt } from "../src/agents/tools/search.ts";
import { drawTag, RunRefs, takeCites, TokenHold } from "../src/agents/tools/refs.ts";
import { CITES_MAX } from "../src/messages/lookups.ts";
import { MESSAGE_TEXT_MAX } from "../src/messages/send.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";

/**
 * A reply's numbers (agents/tools/refs.ts; README "Agents and runs", Citations): what its tools show the model carries the
 * run's own tag (`〔m1·k7q2〕`), and only such a token, copied whole into the reply, becomes a citation — taken out of the
 * text, kept beside it at its place. Anything else that looks like one is text. Pure functions: no database.
 */

const at = (n: number) => ({ conversationId: "c", seq: n });
const TAG = "k7q2";

/** A run's numbers with `messages` messages (m1… for seq 1…) and one file (f1, in the message of seq 90). */
function numbered(messages = 3, tag = TAG): RunRefs {
  const refs = new RunRefs(tag);
  for (let i = 1; i <= messages; i++) refs.message("c", i);
  refs.file("att-1", at(90));
  return refs;
}

describe("a run's numbers", () => {
  it("each thing gets a number once, in the order it is first shown, written as a token carrying the run's tag", () => {
    const refs = new RunRefs(TAG);
    expect(refs.message("c", 5)).toBe("〔m1·k7q2〕");
    expect(refs.message("c", 6)).toBe("〔m2·k7q2〕");
    expect(refs.message("c", 5)).toBe("〔m1·k7q2〕");
    expect(refs.file("att-1", at(9))).toBe("〔f1·k7q2〕");
    expect(refs.file("att-1", at(9))).toBe("〔f1·k7q2〕");
    expect(refs.tag).toBe(TAG);
  });

  it("a file's number names its attachment however the tool is passed it — the number alone or the run's token; another run's token names nothing", () => {
    const refs = numbered();
    for (const ref of ["f1", " F1 ", "〔f1·k7q2〕", "f1·k7q2", "〔 f1 · k7q2 〕"]) expect([ref, refs.fileOf(ref)]).toEqual([ref, "att-1"]);
    for (const ref of ["f2", "m1", "〔f1·zzzz〕", "f1·k7q", "〔f1〕x", ""]) expect([ref, refs.fileOf(ref)]).toEqual([ref, null]);
  });

  it("a tag is drawn for each run: four letters or digits", () => {
    for (let i = 0; i < 200; i++) expect(drawTag()).toMatch(/^[a-z0-9]{4}$/);
    expect(new RunRefs().tag).toMatch(/^[a-z0-9]{4}$/);
    expect(() => new RunRefs("a|b")).toThrow();
  });
});

describe("what a reply's tokens become", () => {
  it("a token of this run is taken out and kept as a cite at its place in the text that is left (UTF-16, after surrogate pairs); one with no tag or another tag is text as written", () => {
    const refs = numbered();
    const { text, cites } = takeCites(`😀在河边〔m1·k7q2〕，〔m1〕和〔m1·zzzz〕也写着，见文件〔f1·k7q2〕。`, refs);
    expect(text).toBe("😀在河边，〔m1〕和〔m1·zzzz〕也写着，见文件。");
    expect(cites).toEqual([
      { at: 5, kind: "m", ref: at(1) },
      { at: text.length - 1, kind: "f", ref: at(90) },
    ]);
  });

  it("a number this run never gave goes with nothing kept; past the first 20 none is kept; the same number twice is cited twice", () => {
    const refs = numbered(25);
    const many = Array.from({ length: 22 }, (_, i) => `〔m${i + 1}·k7q2〕`).join("");
    const { text, cites } = takeCites(`a〔m26·k7q2〕〔m0·k7q2〕〔m01·k7q2〕〔f2·k7q2〕b〔m2·k7q2〕c${many}`, refs);
    expect(text).toBe("abc");
    expect(cites).toHaveLength(CITES_MAX);
    expect(cites.slice(0, 2)).toEqual([
      { at: 2, kind: "m", ref: at(2) },
      { at: 3, kind: "m", ref: at(1) },
    ]);
    expect(cites.at(-1)).toEqual({ at: 3, kind: "m", ref: at(19) });
  });

  it("without citing (an acknowledgement, a reasoning) every token of this run goes and none is kept; nor one whose message may not be pointed at", () => {
    const refs = numbered();
    expect(takeCites("找到了〔m1·k7q2〕〔f1·k7q2〕，〔m1〕", refs, { cite: false })).toEqual({ text: "找到了，〔m1〕", cites: [] });
    const elsewhere = takeCites("在〔m1·k7q2〕和〔m2·k7q2〕", refs, { keep: (r) => r.seq !== 1 });
    expect(elsewhere).toEqual({ text: "在和", cites: [{ at: 2, kind: "m", ref: at(2) }] });
  });

  it("one built around another leaves no token behind", () => {
    const refs = numbered();
    expect(takeCites("主〔m1·〔m2·k7q2〕k7q2〕人", refs)).toEqual({
      text: "主人",
      cites: [
        { at: 1, kind: "m", ref: at(2) },
        { at: 1, kind: "m", ref: at(1) },
      ],
    });
    expect(takeCites("〔m1·k7q〔m2·k7q2〕2〕", refs).text).toBe("");
    expect(takeCites("〔m1·〔x〕k7q2〕", refs).text).toBe("〔m1·〔x〕k7q2〕");
  });

  it("at a cut, what it left of a token at the very end goes too; without one, it is text", () => {
    const refs = numbered();
    for (const end of ["〔", "〔m", "〔m1", "〔m1·", "〔m1·k7", "〔m1·k7q2"]) {
      expect([end, takeCites(`见〔m1·k7q2〕又见${end}`, refs, { cut: true })]).toEqual([end, { text: "见又见", cites: [{ at: 1, kind: "m", ref: at(1) }] }]);
      expect([end, takeCites(`又见${end}`, refs).text]).toEqual([end, `又见${end}`]);
    }
    expect(takeCites("又见〔m1·zz", refs, { cut: true }).text).toBe("又见〔m1·zz");
  });

  it("trimmed once its tokens are out, its cites moved with the text", () => {
    const refs = numbered();
    expect(takeCites("〔m1·k7q2〕 好 〔m2·k7q2〕", refs)).toEqual({
      text: "好",
      cites: [
        { at: 0, kind: "m", ref: at(1) },
        { at: 1, kind: "m", ref: at(2) },
      ],
    });
  });

  it("linear in the text however it nests: a reply's longest, and a reasoning's", { timeout: LOADED_TIMEOUT_MS }, () => {
    const refs = numbered(1);
    // `〔m1·` d times, then `k7q2〕` d times (nine characters a level): each token completes only once the one inside it is out.
    const nest = (n: number): string => "〔m1·".repeat(n / 9) + "k7q2〕".repeat(n / 9);
    for (const longest of [MESSAGE_TEXT_MAX, REASONING_MAX]) {
      expectLinear({
        n: Math.floor(longest / 4 / 9) * 9,
        make: nest,
        run: (text) => {
          if (takeCites(text, refs).text !== "") throw new Error(`a nest of ${text.length} characters left something`);
        },
      });
    }
  });
});

describe("what streams of a reply shows no token of its run", () => {
  /** What the pushes of a stream carrying `tag` say when `pieces` arrive one by one, each pushed at once. */
  function pushed(pieces: string[], kind: "text" | "reasoning" = "text", tag: string | null = TAG): string[] {
    const out: string[] = [];
    const stream = new ReplyStream(
      (d) => {
        const piece = d[kind];
        if (piece !== undefined) out.push(piece);
      },
      0,
      tag,
    );
    for (const p of pieces) stream.add(kind, p);
    stream.end();
    return out;
  }

  it("for every split of the text into two or three pieces, no push holds the tag and nothing else is lost or reordered", () => {
    const texts = [
      "在河边〔m1·k7q2〕。",
      "〔m1·k7q2〕〔f2·k7q2〕",
      "见〔m1〕和〔m1·zzzz〕和〔m12·k7q2〕",
      "〔注〕一句〔m3·k7q2〕😀",
      "末尾是〔m1·k7",
    ];
    for (const kind of ["text", "reasoning"] as const) {
      for (const text of texts) {
        // (A reasoning is pushed as it comes, unsafe characters stripped from each push: a surrogate pair split between two
        // pushes is lost from them, as it always was. Only the text keeps a pair a piece split.)
        if (kind === "reasoning" && /[\uD800-\uDFFF]/.test(text)) continue;
        const expected = text.replace(/〔[mf]\d+·k7q2〕/g, "");
        const n = text.length;
        for (let i = 0; i <= n; i++) {
          for (let j = i; j <= n; j++) {
            const pieces = [text.slice(0, i), text.slice(i, j), text.slice(j)].filter((p) => p !== "");
            const out = pushed(pieces, kind);
            for (const piece of out) expect([kind, text, i, j, piece.includes("k7q2〕")]).toEqual([kind, text, i, j, false]);
            expect([kind, text, i, j, out.join("")]).toEqual([kind, text, i, j, expected]);
          }
        }
      }
    }
  });

  it("a held piece is the shortest: a bracket that can no longer start a token goes out as soon as that is known", () => {
    const hold = new TokenHold(TAG);
    expect(hold.push("好〔m1")).toBe("好");
    expect(hold.push("x，")).toBe("〔m1x，");
    expect(hold.push("〔m2·k7q2〕完")).toBe("完");
    expect(hold.push("〔m3·k7")).toBe("");
    expect(hold.end()).toBe("〔m3·k7");
  });

  it("a stream with no tag (a reply offered no tools) pushes its text as written", () => {
    expect(pushed(["在河边〔m1·k7q2〕。"], "text", null).join("")).toBe("在河边〔m1·k7q2〕。");
  });
});

describe("what someone else wrote reaches the model as written, citation-shaped or not", () => {
  it("a note, a heard thing, its speaker and its group in the notes passage; a group's title in its system text", () => {
    const passage = notesPassage(
      {
        owner: [{ text: "喜欢河边那家〔m1〕", updatedAt: new Date("2026-11-01T00:00:00Z") }],
        self: [],
        hearsay: [{ text: "他说过〔m2·k7q2〕周三有空", speakerName: "mia〔m2〕", group: "饭搭子〔 M3 〕", saidAt: new Date("2026-11-02T00:00:00Z") }],
      },
      false,
      "Asia/Shanghai",
    );
    for (const said of ["喜欢河边那家〔m1〕", "他说过〔m2·k7q2〕周三有空", "mia〔m2〕", "饭搭子〔 M3 〕"]) expect(passage).toContain(said);
    const scene = { title: "读书会〔m1〕", agents: [], more: false, people: [], morePeople: false };
    const text = groupSystemText({ name: "小帮手", handle: "helper_bot", persona: "P" }, { displayName: "主人甲" }, scene, new Date("2026-11-20T00:00:00Z"), "UTC", "k7f2ab").text;
    expect(text).toContain("读书会〔m1〕");
  });
});

describe("a call never ends with the Agent's own turn", () => {
  it("one ending with it gets a person's turn of fixed text (the given one, else CONTINUE_TURN), counted; one ending with a person's is left as it is", () => {
    const text = (t: string) => ({ type: "text" as const, text: t });
    const theirs = [
      { role: "user" as const, parts: [text("查一下")] },
      { role: "assistant" as const, parts: [text("我先查一下。")] },
    ];
    expect(endWithPerson(theirs)).toBeGreaterThan(0);
    expect(theirs.at(-1)).toEqual({ role: "user", parts: [text(CONTINUE_TURN)] });
    const told = [{ role: "assistant" as const, parts: [text("没找到。")] }];
    endWithPerson(told, "（告诉大家。）");
    expect(told.at(-1)).toEqual({ role: "user", parts: [text("（告诉大家。）")] });
    const mine = [{ role: "user" as const, parts: [text("你好")] }];
    expect(endWithPerson(mine)).toBe(0);
    expect(mine).toHaveLength(1);
  });
});

describe("a search result's excerpt", () => {
  it("is cut around the words in the text itself, whatever lower-casing would do to its length", () => {
    // "İ" lower-cases to two code units: an index found in a lower-cased copy lands too far on.
    const text = `${"İ".repeat(150)}${"中".repeat(60)}要找的词${"文".repeat(200)}`;
    expect(excerpt(text, "要找的词")).toContain("要找的词");
  });
});
