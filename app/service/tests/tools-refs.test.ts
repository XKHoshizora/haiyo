import { describe, expect, it } from "vitest";
import { REASONING_MAX } from "../src/agents/conversation.ts";
import { CONTINUE_TURN, endWithPerson } from "../src/agents/runtime/context.ts";
import { groupSystemText, notesPassage, withoutMarkPlaced } from "../src/agents/runtime/prompt.ts";
import { ReplyStream } from "../src/agents/runtime/stream.ts";
import { excerpt } from "../src/agents/tools/search.ts";
import { fileNumber, RunRefs, takeCites, TokenHold } from "../src/agents/tools/refs.ts";
import { CITES_MAX } from "../src/messages/lookups.ts";
import { MESSAGE_TEXT_MAX } from "../src/messages/send.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";

/**
 * A reply's numbers (agents/tools/refs.ts; README "Agents and runs", Citations): what its tools show the model is
 * numbered plainly, `〔m1〕`, `〔f1〕`, per run; what a reply offered tools says loses every token-shaped string, one of a
 * number its run handed out kept beside the text as a cite at its place, any other dropped — so the stored text is the
 * same whatever was handed out. Nothing is secret. Pure functions: no database.
 */

const at = (n: number) => ({ conversationId: "c", seq: n });
/** Every token-shaped string: what no stored reply offered tools holds. */
const TOKEN_SHAPE = /〔\s*[mf]\s*[0-9]{1,6}\s*〕/i;

/** A run's numbers with `messages` messages (m1… for seq 1…) and one file (f1, in the message of seq 90). */
function numbered(messages = 3): RunRefs {
  const refs = new RunRefs();
  for (let i = 1; i <= messages; i++) refs.message("c", i);
  refs.file("att-1", at(90));
  return refs;
}

describe("a run's numbers", () => {
  it("each thing gets a number once, in the order it is first shown, written plainly", () => {
    const refs = new RunRefs();
    expect(refs.message("c", 5)).toBe("〔m1〕");
    expect(refs.message("c", 6)).toBe("〔m2〕");
    expect(refs.message("c", 5)).toBe("〔m1〕");
    expect(refs.file("att-1", at(9))).toBe("〔f1〕");
    expect(refs.file("att-1", at(9))).toBe("〔f1〕");
    expect(refs.file("att-2", at(9))).toBe("〔f2〕");
  });

  it("a file's number names its attachment however the tool is passed it — `f1` or `〔f1〕`, spaces and case aside; anything else names nothing", () => {
    const refs = numbered();
    for (const ref of ["f1", " F1 ", "〔f1〕", "〔 F1 〕"]) expect([ref, refs.fileOf(ref), fileNumber(ref)]).toEqual([ref, "att-1", "f1"]);
    for (const ref of ["f2", "m1", "〔m1〕", "〔f1·k7q2〕", "〔f1〕x", ""]) expect([ref, refs.fileOf(ref)]).toEqual([ref, null]);
  });
});

describe("what a reply's token-shaped strings become", () => {
  it("every one goes: one of a number this run handed out becomes a cite at its place (UTF-16, after surrogate pairs), any other is dropped and cites nothing", () => {
    const { text, cites } = takeCites("😀在河边〔m1〕，〔m9〕和〔f7〕也写着，见文件〔f1〕。", numbered());
    expect(text).toBe("😀在河边，和也写着，见文件。");
    expect(cites).toEqual([
      { at: 5, kind: "m", ref: at(1) },
      { at: text.length - 1, kind: "f", ref: at(90) },
    ]);
  });

  it("spaces inside and either case make no difference", () => {
    const { text, cites } = takeCites("甲〔M1〕乙〔 m2 〕丙〔m 3〕丁〔F1〕", numbered());
    expect(text).toBe("甲乙丙丁");
    expect(cites.map((c) => [c.at, c.kind, c.ref.seq])).toEqual([
      [1, "m", 1],
      [2, "m", 2],
      [3, "m", 3],
      [4, "f", 90],
    ]);
  });

  it("what is not token-shaped stays as written", () => {
    const kept = "〔注〕〔m1·k7q2〕〔m1234567〕〔x1〕〔m〕〔1〕〔m-1〕【m1】〔ｍ1〕";
    expect(takeCites(kept, numbered())).toEqual({ text: kept, cites: [] });
  });

  it("the stored text is the same whatever the run handed out: an echo of 〔m1〕…〔m8〕 leaves the same text whether 0, 3 or 8 were found — only the cites differ", () => {
    const echo = `答：${Array.from({ length: 8 }, (_, i) => `〔m${i + 1}〕`).join("")}好`;
    const results = [0, 3, 8].map((found) => {
      const refs = new RunRefs();
      for (let i = 1; i <= found; i++) refs.message("c", i);
      return takeCites(echo, refs);
    });
    expect(results.map((r) => r.text)).toEqual(["答：好", "答：好", "答：好"]);
    expect(results.map((r) => r.cites.length)).toEqual([0, 3, 8]);
  });

  it("past the first 20 none is kept; the same number twice is cited twice", () => {
    const refs = numbered(25);
    const many = Array.from({ length: 22 }, (_, i) => `〔m${i + 1}〕`).join("");
    const { text, cites } = takeCites(`a〔m26〕〔m0〕〔m01〕〔f2〕b〔m2〕c${many}`, refs);
    expect(text).toBe("abc");
    expect(cites).toHaveLength(CITES_MAX);
    expect(cites.slice(0, 2)).toEqual([
      { at: 2, kind: "m", ref: at(2) },
      { at: 3, kind: "m", ref: at(1) },
    ]);
    expect(cites.at(-1)).toEqual({ at: 3, kind: "m", ref: at(19) });
  });

  it("without citing (an acknowledgement, a reasoning, a search word) every one goes and none is kept; nor one whose message may not be pointed at", () => {
    const refs = numbered();
    expect(takeCites("找到了〔m1〕〔f1〕，〔m9〕", refs, { cite: false })).toEqual({ text: "找到了，", cites: [] });
    expect(takeCites("在〔m1〕和〔m2〕", refs, { keep: (r) => r.seq !== 1 })).toEqual({ text: "在和", cites: [{ at: 2, kind: "m", ref: at(2) }] });
  });

  it("one built around another leaves nothing: 〔m〔m2〕1〕 is two, both gone", () => {
    const refs = numbered();
    expect(takeCites("主〔m〔m2〕1〕人", refs)).toEqual({
      text: "主人",
      cites: [
        { at: 1, kind: "m", ref: at(2) },
        { at: 1, kind: "m", ref: at(1) },
      ],
    });
    expect(takeCites("〔m1 〔m2〕〕", refs).text).toBe("");
    expect(takeCites("〔m〔m9〕1〕", refs).text).toBe("");
    expect(takeCites("〔m〔x〕1〕", refs).text).toBe("〔m〔x〕1〕");
  });

  it("what may have begun one at its very end goes, however the reply ended; what may not stays", () => {
    const refs = numbered();
    for (const end of ["〔", "〔m", "〔m1", "〔 M1 ", "〔m12", "〔m〔m1"]) {
      expect([end, takeCites(`见〔m1〕又见${end}`, refs)]).toEqual([end, { text: "见又见", cites: [{ at: 1, kind: "m", ref: at(1) }] }]);
    }
    expect(takeCites("又见〔m1x", refs).text).toBe("又见〔m1x");
  });

  it("a space left before a removed one goes with it before another space, a punctuation mark or the end; trimmed, its cites moved with the text", () => {
    const refs = numbered();
    expect(takeCites("A 〔m1〕 B", refs)).toEqual({ text: "A B", cites: [{ at: 1, kind: "m", ref: at(1) }] });
    expect(takeCites("火锅 〔m1〕。", refs)).toEqual({ text: "火锅。", cites: [{ at: 2, kind: "m", ref: at(1) }] });
    expect(takeCites("A 〔m1〕B", refs).text).toBe("A B");
    expect(takeCites("〔m1〕 好 〔m2〕", refs)).toEqual({
      text: "好",
      cites: [
        { at: 0, kind: "m", ref: at(1) },
        { at: 1, kind: "m", ref: at(2) },
      ],
    });
  });

  it("linear in the text however it nests or ends — up to 400 000 `〔` — a reply's longest, and a reasoning's", { timeout: LOADED_TIMEOUT_MS }, () => {
    const refs = numbered(1);
    // `〔m` d times, then `1〕` d times: each completes only once the one inside it is out; openings that never close, all
    // dropped at the end; and nothing but `〔`.
    const nest = (n: number): string => "〔m".repeat(n / 4) + "1〕".repeat(n / 4);
    const open = (n: number): string => "〔m1".repeat(n / 3);
    const brackets = (n: number): string => "〔".repeat(n);
    for (const longest of [MESSAGE_TEXT_MAX, REASONING_MAX]) {
      for (const [make, size] of [
        [nest, 4],
        [open, 3],
      ] as const) {
        expectLinear({
          n: Math.floor(longest / 4 / size) * size,
          make,
          run: (text) => {
            if (takeCites(text, refs).text !== "") throw new Error(`${text.length} characters left something`);
          },
        });
      }
    }
    expectLinear({
      n: 100_000,
      make: brackets,
      run: (text) => {
        if (takeCites(text, refs).text !== "") throw new Error("brackets left something");
      },
    });
  });
});

describe("a group's mark, with places", () => {
  it("in one pass, a place inside what goes is where it went", () => {
    expect(withoutMarkPlaced("前mkabcd后", "mkabcd", [1, 5, 7])).toEqual({ text: "前后", places: [1, 1, 1] });
    expect(withoutMarkPlaced("前〔mkabcd 阿哲｜你的主人〕后", "mkabcd", [0, 3, 17])).toEqual({ text: "前后", places: [0, 1, 1] });
  });

  it("at a cut, what it left of the mark or of a label at the end goes too, a place past the end at the end", () => {
    expect(withoutMarkPlaced("好〔mkab", "mkabcd", [1, 5], true)).toEqual({ text: "好", places: [1, 1] });
  });
});

describe("what streams of a reply offered tools holds back only an open `〔` that may still be a token", () => {
  /** What the pushes of such a stream say when `pieces` arrive one by one, each pushed at once; `end`: how it ends. */
  function pushed(pieces: string[], kind: "text" | "reasoning" = "text", holds = true, end: "end" | "flushNow" = "end"): string[] {
    const out: string[] = [];
    const stream = new ReplyStream(
      (d) => {
        const piece = d[kind];
        if (piece !== undefined) out.push(piece);
      },
      0,
      holds,
    );
    for (const p of pieces) stream.add(kind, p);
    stream[end]();
    return out;
  }

  it("for every split of the text into two or three pieces: no push holds a token or the beginning of one; what is pushed is the text as stored", () => {
    const cases: Array<[string, string]> = [
      ["在河边〔m1〕。", "在河边。"],
      ["〔m1〕〔f2〕", ""],
      ["见〔m9〕和〔m1·zz〕", "见和〔m1·zz〕"],
      ["〔注〕一句〔 M3 〕😀", "〔注〕一句😀"],
      ["末尾是〔m1", "末尾是"],
      ["控制\u0001〔m1\u0002〕字", "控制字"],
      ["主〔m〔m2〕1〕人", "主人"],
    ];
    for (const kind of ["text", "reasoning"] as const) {
      for (const [text, expected] of cases) {
        const n = text.length;
        for (let i = 0; i <= n; i++) {
          for (let j = i; j <= n; j++) {
            // (A pair split by a piece is kept whole by each kind: a high surrogate waits for the next piece.)
            const pieces = [text.slice(0, i), text.slice(i, j), text.slice(j)].filter((p) => p !== "");
            const out = pushed(pieces, kind);
            for (const piece of out) expect([kind, text, i, j, piece, TOKEN_SHAPE.test(piece)]).toEqual([kind, text, i, j, piece, false]);
            expect([kind, text, i, j, out.join("")]).toEqual([kind, text, i, j, expected]);
          }
        }
      }
    }
  });

  it("however deep they nest, nothing of them is pushed, in pieces of any size", () => {
    const deep = `${"〔m".repeat(20)}${"1〕".repeat(20)}好`;
    const unclosed = `前${"〔m".repeat(20)}`;
    for (const size of [1, 2, 3, 5, 8, 13, 400]) {
      const split = (text: string) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
      for (const [text, expected] of [
        [deep, "好"],
        [unclosed, "前"],
      ] as const) {
        expect([size, text, pushed(split(text)).join("")]).toEqual([size, text, expected]);
      }
    }
  });

  it("at every end — the reply's own, a stop, a cut, a time limit, a failure, an acknowledgement — what may have begun one is dropped, never pushed", () => {
    for (const end of ["end", "flushNow"] as const) {
      for (const kind of ["text", "reasoning"] as const) {
        expect([end, kind, pushed(["好〔m1"], kind, true, end).join("")]).toEqual([end, kind, "好"]);
        expect([end, kind, pushed(["好〔", "m1"], kind, true, end).join("")]).toEqual([end, kind, "好"]);
      }
    }
  });

  it("a held piece is the shortest: a bracket that can no longer start one goes out as soon as that is known; a text after an end starts afresh", () => {
    const hold = new TokenHold();
    expect(hold.push("好〔m1")).toBe("好");
    expect(hold.push("x，")).toBe("〔m1x，");
    expect(hold.push("〔m2〕完")).toBe("完");
    expect(hold.push("〔m3")).toBe("");
    expect(hold.end()).toBe("");
    expect(hold.push("新〔注〕")).toBe("新〔注〕");
  });

  it("one push per character stays linear however deep they nest, and on 400 000 `〔`", { timeout: LOADED_TIMEOUT_MS }, () => {
    for (const [make, n] of [
      [(k: number): string => "〔m".repeat(k / 4) + "1〕".repeat(k / 4), Math.floor(MESSAGE_TEXT_MAX / 4 / 4) * 4],
      [(k: number): string => "〔".repeat(k), 100_000],
    ] as const) {
      expectLinear({
        n,
        make,
        run: (text) => {
          const hold = new TokenHold();
          let out = "";
          for (let i = 0; i < text.length; i++) out += hold.push(text[i]!);
          out += hold.end();
          if (out !== "") throw new Error("something of a nest was pushed");
        },
      });
    }
  });

  it("a stream of a reply offered no tools pushes its text as written", () => {
    expect(pushed(["在河边〔m1〕。"], "text", false).join("")).toBe("在河边〔m1〕。");
  });
});

describe("what someone else wrote reaches the model as written, citation-shaped or not", () => {
  it("a note, a heard thing, its speaker and its group in the notes passage; a group's title in its system text", () => {
    const passage = notesPassage(
      {
        owner: [{ text: "喜欢河边那家〔m1〕", updatedAt: new Date("2026-11-01T00:00:00Z") }],
        self: [],
        hearsay: [{ text: "他说过〔m2〕周三有空", speakerName: "mia〔m2〕", group: "饭搭子〔 M3 〕", saidAt: new Date("2026-11-02T00:00:00Z") }],
      },
      false,
      "Asia/Shanghai",
    );
    for (const said of ["喜欢河边那家〔m1〕", "他说过〔m2〕周三有空", "mia〔m2〕", "饭搭子〔 M3 〕"]) expect(passage).toContain(said);
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
