import { describe, expect, it } from "vitest";
import { REASONING_MAX } from "../src/agents/conversation.ts";
import { CONTINUE_TURN, endWithPerson } from "../src/agents/runtime/context.ts";
import { groupSystemText, notesPassage, withoutSecretsPlaced } from "../src/agents/runtime/prompt.ts";
import { ReplyStream } from "../src/agents/runtime/stream.ts";
import { excerpt } from "../src/agents/tools/search.ts";
import { drawTag, fileNumber, RunRefs, takeCites, TokenHold } from "../src/agents/tools/refs.ts";
import { CITES_MAX } from "../src/messages/lookups.ts";
import { MESSAGE_TEXT_MAX } from "../src/messages/send.ts";
import { expectLinear, LOADED_TIMEOUT_MS } from "./helpers/linear.ts";

/**
 * A reply's numbers (agents/tools/refs.ts; README "Agents and runs", Citations): what its tools show the model carries the
 * run's own tag (`〔m1·k7q2m9x4〕`), and only such a token, copied into the reply, becomes a citation — taken out of the
 * text, kept beside it at its place. The tag itself is in nothing stored or streamed. Anything else that looks like a token
 * is text. Pure functions: no database.
 */

const at = (n: number) => ({ conversationId: "c", seq: n });
const TAG = "k7q2m9x4";
/** The token of `number` with the run's tag. */
const tk = (number: string): string => `〔${number}·${TAG}〕`;

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
    expect(refs.message("c", 5)).toBe(tk("m1"));
    expect(refs.message("c", 6)).toBe(tk("m2"));
    expect(refs.message("c", 5)).toBe(tk("m1"));
    expect(refs.file("att-1", at(9))).toBe(tk("f1"));
    expect(refs.file("att-1", at(9))).toBe(tk("f1"));
    expect(refs.tag).toBe(TAG);
  });

  it("a file's number names its attachment however the tool is passed it — the number alone or the run's token, however copied; another run's token names nothing", () => {
    const refs = numbered();
    for (const ref of ["f1", " F1 ", tk("f1"), "f1·k7q2m9x4", "〔 f1 · K7Q2M9X4 〕", "f1・k7q2m9x4"]) {
      expect([ref, refs.fileOf(ref), fileNumber(ref, TAG)]).toEqual([ref, "att-1", "f1"]);
    }
    for (const ref of ["f2", "m1", "〔f1·zzzzzzzz〕", "f1·k7q2m9x", "〔f1〕x", ""]) expect([ref, refs.fileOf(ref)]).toEqual([ref, null]);
  });

  it("a tag is drawn for each run: eight letters or digits; a shorter one is refused", () => {
    for (let i = 0; i < 200; i++) expect(drawTag()).toMatch(/^[a-z0-9]{8}$/);
    expect(new RunRefs().tag).toMatch(/^[a-z0-9]{8}$/);
    expect(() => new RunRefs("a|bcdefgh")).toThrow();
    expect(() => new RunRefs("k7q2")).toThrow();
  });
});

describe("what a reply's tokens become", () => {
  it("a token of this run is taken out and kept as a cite at its place in the text that is left (UTF-16, after surrogate pairs); one with no tag or another tag is text as written", () => {
    const refs = numbered();
    const { text, cites } = takeCites(`😀在河边${tk("m1")}，〔m1〕和〔m1·zzzzzzzz〕也写着，见文件${tk("f1")}。`, refs);
    expect(text).toBe("😀在河边，〔m1〕和〔m1·zzzzzzzz〕也写着，见文件。");
    expect(cites).toEqual([
      { at: 5, kind: "m", ref: at(1) },
      { at: text.length - 1, kind: "f", ref: at(90) },
    ]);
  });

  it("a token copied with spaces, in another case or with a look-alike separator is the token", () => {
    const { text, cites } = takeCites("甲〔M1·K7Q2M9X4〕乙〔 m2 · k7q2m9x4 〕丙〔m3・k7q2m9x4〕丁", numbered());
    expect(text).toBe("甲乙丙丁");
    expect(cites.map((c) => [c.at, c.ref.seq])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it("the run's tag anywhere else goes too, in any case — also one that taking out another put together", () => {
    expect(takeCites("标签k7q2m9x4在〔m1·K7Q2M9X4 后〕和k7q2k7q2m9x4m9x4", numbered())).toEqual({ text: "标签在〔m1· 后〕和", cites: [] });
  });

  it("a number this run never gave goes with nothing kept; past the first 20 none is kept; the same number twice is cited twice", () => {
    const refs = numbered(25);
    const many = Array.from({ length: 22 }, (_, i) => tk(`m${i + 1}`)).join("");
    const { text, cites } = takeCites(`a${tk("m26")}${tk("m0")}${tk("m01")}${tk("f2")}b${tk("m2")}c${many}`, refs);
    expect(text).toBe("abc");
    expect(cites).toHaveLength(CITES_MAX);
    expect(cites.slice(0, 2)).toEqual([
      { at: 2, kind: "m", ref: at(2) },
      { at: 3, kind: "m", ref: at(1) },
    ]);
    expect(cites.at(-1)).toEqual({ at: 3, kind: "m", ref: at(19) });
  });

  it("without citing (an acknowledgement, a reasoning, a search word) every token of this run goes and none is kept; nor one whose message may not be pointed at", () => {
    const refs = numbered();
    expect(takeCites(`找到了${tk("m1")}${tk("f1")}，〔m1〕`, refs, { cite: false })).toEqual({ text: "找到了，〔m1〕", cites: [] });
    expect(takeCites(`在${tk("m1")}和${tk("m2")}`, refs, { keep: (r) => r.seq !== 1 })).toEqual({ text: "在和", cites: [{ at: 2, kind: "m", ref: at(2) }] });
  });

  it("one built around another leaves no token behind, nor the tag", () => {
    const refs = numbered();
    expect(takeCites(`主〔m1·${tk("m2")}k7q2m9x4〕人`, refs)).toEqual({
      text: "主人",
      cites: [
        { at: 1, kind: "m", ref: at(2) },
        { at: 1, kind: "m", ref: at(1) },
      ],
    });
    expect(takeCites(`〔m1·k7q2m9x${tk("m2")}4〕`, refs).text).toBe("");
    expect(takeCites("〔m1·〔x〕k7q2m9x4〕", refs).text).toBe("〔m1·〔x〕〕");
  });

  it("what may have begun a token at its very end goes, however the reply ended; what may not stays", () => {
    const refs = numbered();
    for (const end of ["〔", "〔m", "〔m1", "〔m1·", "〔m1·k7", "〔m1·k7q2m9x4", "〔 M1 · K7Q2"]) {
      expect([end, takeCites(`见${tk("m1")}又见${end}`, refs)]).toEqual([end, { text: "见又见", cites: [{ at: 1, kind: "m", ref: at(1) }] }]);
    }
    expect(takeCites("又见〔m1·zz", refs).text).toBe("又见〔m1·zz");
  });

  it("a space left before a removed token goes with it before another space, a punctuation mark or the end; trimmed, its cites moved with the text", () => {
    const refs = numbered();
    expect(takeCites(`A ${tk("m1")} B`, refs)).toEqual({ text: "A B", cites: [{ at: 1, kind: "m", ref: at(1) }] });
    expect(takeCites(`火锅 ${tk("m1")}。`, refs)).toEqual({ text: "火锅。", cites: [{ at: 2, kind: "m", ref: at(1) }] });
    expect(takeCites(`A ${tk("m1")}B`, refs).text).toBe("A B");
    expect(takeCites(`${tk("m1")} 好 ${tk("m2")}`, refs)).toEqual({
      text: "好",
      cites: [
        { at: 0, kind: "m", ref: at(1) },
        { at: 1, kind: "m", ref: at(2) },
      ],
    });
  });

  it("linear in the text however it nests or ends: a reply's longest, and a reasoning's", { timeout: LOADED_TIMEOUT_MS }, () => {
    const refs = numbered(1);
    // `〔m1·` d times, then the tag and `〕` d times (thirteen characters a level): each token completes only once the one
    // inside it is out; and openings that never close, all dropped at the end.
    const nest = (n: number): string => "〔m1·".repeat(n / 13) + `${TAG}〕`.repeat(n / 13);
    const open = (n: number): string => "〔m1·k7".repeat(n / 6);
    for (const longest of [MESSAGE_TEXT_MAX, REASONING_MAX]) {
      for (const make of [nest, open]) {
        const size = make === nest ? 13 : 6;
        expectLinear({
          n: Math.floor(longest / 4 / size) * size,
          make,
          run: (text) => {
            if (takeCites(text, refs).text !== "") throw new Error(`${text.length} characters left something`);
          },
        });
      }
    }
  });
});

describe("the run's secrets, with places", () => {
  it("the mark and the tag in one pass, also one put together by taking the other out; a place inside what goes is where it went", () => {
    expect(withoutSecretsPlaced(`前mkab${TAG}cd后`, "mkabcd", TAG, [1, 5, 13])).toEqual({ text: "前后", places: [1, 1, 1] });
    expect(withoutSecretsPlaced("好K7Q2M9X4坏", null, TAG, [1, 9])).toEqual({ text: "好坏", places: [1, 1] });
  });

  it("at a cut, what it left of the mark or of a label at the end goes too, a place past the end at the end", () => {
    expect(withoutSecretsPlaced("好〔mkab", "mkabcd", null, [1, 5], true)).toEqual({ text: "好", places: [1, 1] });
  });
});

describe("what streams of a reply shows nothing of a token of its run, nor its tag", () => {
  /** What the pushes of a stream carrying `tag` say when `pieces` arrive one by one, each pushed at once; `end`: how it ends. */
  function pushed(pieces: string[], kind: "text" | "reasoning" = "text", tag: string | null = TAG, end: "end" | "flushNow" = "end"): string[] {
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
    stream[end]();
    return out;
  }
  /** Whether a push holds the tag (any case), half of it, or how a token of the run begins at its end (its tag's letters so far). */
  const leaks = (piece: string): boolean => {
    const begun = /〔\s*(?:[mf]\s*(?:\d{1,6}\s*(?:[·・•]\s*([a-z0-9]*)\s*)?)?)?$/i.exec(piece);
    return piece.toLowerCase().includes(TAG) || /k7q2/i.test(piece) || (begun !== null && TAG.startsWith((begun[1] ?? "").toLowerCase()));
  };

  it("for every split of the text into two or three pieces: no push holds a token, a part of one or the tag; what is pushed is the text without them", () => {
    const cases: Array<[string, string]> = [
      [`在河边${tk("m1")}。`, "在河边。"],
      [`${tk("m1")}${tk("f2")}`, ""],
      ["见〔m1〕和〔m1·zzzzzzzz〕和〔m12·K7Q2M9X4〕", "见〔m1〕和〔m1·zzzzzzzz〕和"],
      ["〔注〕一句〔m3 · k7q2m9x4〕😀", "〔注〕一句😀"],
      ["末尾是〔m1·k7", "末尾是"],
      ["控制\u0001〔m1·k7q2\u0002m9x4〕字", "控制字"],
      ["标签k7q2m9x4在", "标签在"],
      // The tag put together across two pushes: around a token that goes, or around another tag that goes.
      [`前k7q2${tk("m1")}m9x4好`, "前好"],
      ["前k7q2k7q2m9x4m9x4好", "前好"],
      ["前K7Q2〔m1·k7q2m9x4〕m9X4好", "前好"],
    ];
    for (const kind of ["text", "reasoning"] as const) {
      for (const [text, expected] of cases) {
        const n = text.length;
        for (let i = 0; i <= n; i++) {
          for (let j = i; j <= n; j++) {
            // (A pair split by a piece is kept whole by each kind: a high surrogate waits for the next piece.)
            const pieces = [text.slice(0, i), text.slice(i, j), text.slice(j)].filter((p) => p !== "");
            const out = pushed(pieces, kind);
            for (const piece of out) expect([kind, text, i, j, piece, leaks(piece)]).toEqual([kind, text, i, j, piece, false]);
            expect([kind, text, i, j, out.join("")]).toEqual([kind, text, i, j, expected]);
          }
        }
      }
    }
  });

  it("however deep tokens nest, nothing of them is pushed, in pieces of any size", () => {
    const deep = `${"〔m1·".repeat(20)}${`${TAG}〕`.repeat(20)}好`;
    const unclosed = `前${"〔m1·".repeat(20)}${TAG}`;
    const inner = `〔m1·k7${tk("m2")}q2m9x4`;
    for (const size of [1, 2, 3, 5, 8, 13, 400]) {
      const split = (text: string) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
      for (const [text, expected] of [
        [deep, "好"],
        [unclosed, "前"],
        [inner, ""],
      ] as const) {
        const out = pushed(split(text));
        for (const piece of out) expect([size, text, piece, leaks(piece)]).toEqual([size, text, piece, false]);
        expect([size, text, out.join("")]).toEqual([size, text, expected]);
      }
    }
  });

  it("at every end — the reply's own, a stop, a cut, a time limit, a failure, an acknowledgement — what may have begun a token is dropped, never pushed", () => {
    for (const end of ["end", "flushNow"] as const) {
      for (const kind of ["text", "reasoning"] as const) {
        expect([end, kind, pushed(["好〔m1·k7"], kind, TAG, end).join("")]).toEqual([end, kind, "好"]);
        expect([end, kind, pushed(["好〔", "m1"], kind, TAG, end).join("")]).toEqual([end, kind, "好"]);
      }
    }
  });

  it("a held piece is the shortest: a bracket that can no longer start a token goes out as soon as that is known; a text after an end starts afresh", () => {
    const hold = new TokenHold(TAG);
    expect(hold.push("好〔m1")).toBe("好");
    expect(hold.push("x，")).toBe("〔m1x，");
    expect(hold.push(`${tk("m2")}完`)).toBe("完");
    expect(hold.push("〔m3·k7")).toBe("");
    expect(hold.end()).toBe("");
    expect(hold.push("新〔m4〕")).toBe("新〔m4〕");
  });

  it("one push per character stays linear however deep the tokens nest", { timeout: LOADED_TIMEOUT_MS }, () => {
    const nest = (n: number): string => "〔m1·".repeat(n / 13) + `${TAG}〕`.repeat(n / 13);
    expectLinear({
      n: Math.floor(MESSAGE_TEXT_MAX / 4 / 13) * 13,
      make: nest,
      run: (text) => {
        const hold = new TokenHold(TAG);
        let out = "";
        for (const c of text) out += hold.push(c);
        out += hold.end();
        if (out !== "") throw new Error("something of a nest was pushed");
      },
    });
  });

  it("one push per character stays linear on a long run of the tag's letters, which waits, and on tags put together inside it", { timeout: LOADED_TIMEOUT_MS }, () => {
    const letters = (n: number): string => "4x9m2q7k".repeat(n / 8);
    const nested = (n: number): string => "k7q2".repeat(n / 8) + "m9x4".repeat(n / 8);
    for (const make of [letters, nested]) {
      expectLinear({
        n: Math.floor(MESSAGE_TEXT_MAX / 8) * 8,
        make,
        run: (text) => {
          const hold = new TokenHold(TAG);
          let out = "";
          for (const c of text) out += hold.push(c);
          out += hold.end();
          if (out.toLowerCase().includes(TAG) || out !== takeCites(text, new RunRefs(TAG)).text) throw new Error("not as stored");
        },
      });
    }
  });

  it("a stream with no tag (a reply offered no tools) pushes its text as written", () => {
    expect(pushed([`在河边${tk("m1")}。`], "text", null).join("")).toBe(`在河边${tk("m1")}。`);
  });
});

describe("what someone else wrote reaches the model as written, citation-shaped or not", () => {
  it("a note, a heard thing, its speaker and its group in the notes passage; a group's title in its system text", () => {
    const passage = notesPassage(
      {
        owner: [{ text: "喜欢河边那家〔m1〕", updatedAt: new Date("2026-11-01T00:00:00Z") }],
        self: [],
        hearsay: [{ text: "他说过〔m2·zzzzzzzz〕周三有空", speakerName: "mia〔m2〕", group: "饭搭子〔 M3 〕", saidAt: new Date("2026-11-02T00:00:00Z") }],
      },
      false,
      "Asia/Shanghai",
    );
    for (const said of ["喜欢河边那家〔m1〕", "他说过〔m2·zzzzzzzz〕周三有空", "mia〔m2〕", "饭搭子〔 M3 〕"]) expect(passage).toContain(said);
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
