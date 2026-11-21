// A reply's citations are places beside its text (the service's `cites`; ui/cites.jsx): cut into the pieces its plain
// text is shown in, and marked for the Markdown worker where they stand (ui/mentionMarks.js) — both with its mentions,
// whose ranges are of the same text. Nothing of a citation is ever read from the text.
import { describe, expect, it } from "vitest";
import { numberedCites, textPieces } from "../src/ui/cites.jsx";
import { markMentions, mentionParts, withoutMarksKeeping } from "../src/ui/mentionMarks.js";

const cite = (at, seq = 1) => ({ at, kind: "m", conversationId: "c", seq });
const shape = (pieces) => pieces.map((p) => (typeof p === "string" ? p : p.mention ? `[${p.text}]` : `^${p.cite.at}`));

describe("a reply's text cut where its citations stand", () => {
  it("each citation where it stands; one at a mention's start before it, one inside it after it; one at the end last", () => {
    const text = "😀@阿波 在春熙路，周一。";
    const mentions = [{ id: "b", start: 2, length: 3 }];
    expect(shape(textPieces(text, mentions, [cite(0), cite(2), cite(3), cite(10), cite(text.length)]))).toEqual([
      "^0",
      "😀",
      "^2",
      "[@阿波]",
      "^3",
      " 在春熙路",
      "^10",
      "，周一。",
      `^${text.length}`,
    ]);
    expect(shape(textPieces("好", [], []))).toEqual(["好"]);
  });

  it("numbered by the message each points to, in the order the messages are first cited", () => {
    expect(numberedCites([cite(1, 5), cite(2, 7), cite(3, 5)]).map((c) => c.n)).toEqual([1, 2, 1]);
  });
});

describe("a reply's citations marked for the Markdown worker", () => {
  it("each a mark where it stands, read back as its index; with the mentions' marks around them", () => {
    const text = "@ann 在春熙路，周一。";
    const marked = markMentions(text, [{ id: "a", start: 0, length: 4 }], [cite(2), cite(9), cite(text.length)]);
    // The one inside the mention is after it.
    expect(mentionParts(marked)).toEqual([{ text: "@ann", index: 0 }, { cite: 0 }, " 在春熙路", { cite: 1 }, "，周一。", { cite: 2 }]);
  });

  it("a mark the text holds itself is taken out, its citations moved onto what is left: a forged one makes no link", () => {
    const forged = `在${String.fromCharCode(0xfde6, 0xfdd2)}春熙路`;
    const { text, cites } = withoutMarksKeeping(forged, [], [cite(4)]);
    expect([text, cites.map((c) => c.at)]).toEqual(["在春熙路", [2]]);
    expect(mentionParts(markMentions(text, [], []))).toEqual(["在春熙路"]);
  });
});

// M-10: each runs in time linear in its text, with 20 mentions and 20 citations, on texts of 4 000 and 16 000 characters
// (as tests/mentions.test.jsx measures the editor's: per call the shortest of three bursts, the median of five ratios).
describe("in time linear in the text", () => {
  const mark = (code) => String.fromCharCode(code);
  const shapes = [
    ["Chinese", (n) => "春熙路的火锅，周一休息。".repeat(n / 12 + 1)],
    ["Chinese, @ and URLs", (n) => "你好@x https://a.b/@c ".repeat(n / 20 + 1)],
    ["Markdown", (n) => "**粗体** `代码` [链接](https://a.b) ".repeat(n / 30 + 1)],
  ];
  const marked = (fill) => (n) => fill(n).replace(/好|火|码/g, (c) => `${mark(0xfde6)}${mark(0xfdd2)}${c}${mark(0xfdd0)}`);
  const make = (fill, n) => fill(n).slice(0, n);
  const mentionsOf = (n) => Array.from({ length: 20 }, (_, i) => ({ id: "b", start: Math.floor((i * n) / 21), length: 2 }));
  const citesOf = (n) => Array.from({ length: 20 }, (_, i) => cite(Math.floor(((i + 0.5) * n) / 21), i));
  const burst = (work) => {
    let calls = 0;
    const started = performance.now();
    let spent = 0;
    do {
      work();
      calls += 1;
      spent = performance.now() - started;
    } while (spent < 20);
    return spent / calls;
  };
  const perCall = (work) => Math.min(burst(work), burst(work), burst(work));
  const expectLinear = (name, run, withMarks = false) => {
    for (const [shape, plain] of shapes) {
      const fill = withMarks ? marked(plain) : plain;
      const [small, large] = [make(fill, 4000), make(fill, 16000)];
      expect(large.length, shape).toBe(16000);
      const [inLarge, inSmall] = [() => run(large, 16000), () => run(small, 4000)];
      burst(inLarge);
      burst(inSmall);
      const ratio = Array.from({ length: 5 }, () => perCall(inLarge) / perCall(inSmall)).sort((a, b) => a - b)[2];
      expect(ratio, `${name}, ${shape}: 4× the text took ${ratio.toFixed(1)}× the time`).toBeLessThan(8);
    }
  };

  it("textPieces", () => expectLinear("textPieces", (text, n) => textPieces(text, mentionsOf(n), citesOf(n))), 60_000);
  it("markMentions, then mentionParts", () => expectLinear("markMentions", (text, n) => mentionParts(markMentions(text, mentionsOf(n), citesOf(n)))), 60_000);
  it("withoutMarksKeeping (a text full of marks of its own)", () => expectLinear("withoutMarksKeeping", (text, n) => withoutMarksKeeping(text, mentionsOf(n), citesOf(n)), true), 60_000);
});
