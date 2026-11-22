import { describe, expect, it } from "vitest";
import { withoutMarkPlaced } from "../src/agents/runtime/prompt.ts";
import { ReplyStream } from "../src/agents/runtime/stream.ts";
import { RunRefs, takeCites, TokenHold, withoutMarkFrom } from "../src/agents/tools/refs.ts";
import { tokenRef } from "../src/agents/tools/tokens.ts";

/**
 * The web tool's numbers (lane websearch; agents/tools/refs.ts): `〔w1〕` is a token only for a run that was offered the
 * web tool (`new RunRefs({}, true)`); every other run reads it as text, exactly as before. Pure: no database.
 */

const SOURCE = (n: number) => ({ url: `https://news.example.com/${n}`, title: `标题${n}` });

describe("the w token only for a run offered the web tool", () => {
  it("the matcher: w is a token's letter only when asked (web), m and f as always", () => {
    expect(tokenRef("w1")).toBeNull();
    expect(tokenRef(" W 01 ")).toBeNull();
    expect(tokenRef("w1", true)).toBe("w1");
    expect(tokenRef(" W 01 ", true)).toBe("w1");
    expect(tokenRef("ｗ１", true)).toBe("w1");
    expect(tokenRef("m1", true)).toBe("m1");
    expect(tokenRef("f2")).toBe("f2");
  });

  it("a run not offered the web tool keeps 〔w1〕 as written: takeCites, the stream and the mark pass leave it alone", () => {
    const refs = new RunRefs();
    refs.message("c", 1);
    const said = "看〔m1〕和〔w1〕这里";
    expect(takeCites(said, refs)).toEqual({ text: "看和〔w1〕这里", cites: [{ at: 1, kind: "m", ref: { conversationId: "c", seq: 1 } }] });
    const hold = new TokenHold();
    expect(hold.push(said) + hold.end()).toBe("看和〔w1〕这里");
    expect(withoutMarkPlaced("看〔w1〕k7q2这里", "k7q2", [], false, true).text).toBe("看〔w1〕这里");
    expect(withoutMarkFrom({ text: "看〔w1〕这里", cites: [] }, "k7q2", false, true).text).toBe("看〔w1〕这里");
    const pushed: string[] = [];
    const stream = new ReplyStream((d) => pushed.push(d.text ?? ""), 0, true);
    stream.add("text", said);
    stream.end();
    expect(pushed.join("")).toBe("看和〔w1〕这里");
  });

  it("a run offered it: 〔w1〕 of a number it handed out becomes a web cite at its place; one it never handed out goes and cites nothing", () => {
    const refs = new RunRefs({}, true);
    expect(refs.web(SOURCE(1))).toBe("〔w1〕");
    expect(refs.web(SOURCE(2))).toBe("〔w2〕");
    const { text, cites } = takeCites("据报道〔w1〕，另一说〔w2〕，还有〔w9〕。", refs);
    expect(text).toBe("据报道，另一说，还有。");
    expect(cites).toEqual([
      { at: 3, kind: "w", n: 1 },
      { at: 7, kind: "w", n: 2 },
    ]);
    const hold = new TokenHold(true);
    expect(hold.push("据报道〔w") + hold.push("1〕。") + hold.end()).toBe("据报道。");
    expect(withoutMarkPlaced("看〔w1〕k7q2这里", "k7q2", [], false, true, true).text).toBe("看这里");
    const pushed: string[] = [];
    const stream = new ReplyStream((d) => pushed.push(d.text ?? ""), 0, "web");
    stream.add("text", "看〔w");
    stream.add("text", "1〕这里");
    stream.end();
    expect(pushed.join("")).toBe("看这里");
  });

  it("plant before mint: a page holding 〔w1〕 planted first makes the run's first number w2, and 〔w1〕 cites nothing", () => {
    const refs = new RunRefs({}, true);
    refs.plant("页面里写着〔w1〕〔ｗ３〕");
    expect(refs.web(SOURCE(1))).toBe("〔w2〕");
    expect(refs.web(SOURCE(2))).toBe("〔w4〕");
    const { cites } = takeCites("甲〔w1〕乙〔w2〕丙〔w3〕丁〔w4〕", refs);
    expect(cites).toEqual([
      { at: 2, kind: "w", n: 2 },
      { at: 4, kind: "w", n: 4 },
    ]);
  });

  it("the run's sources are every result it handed out, in order, numbered, whether cited or not", () => {
    const refs = new RunRefs({}, true);
    expect(refs.webSources()).toEqual([]);
    refs.plant("〔w1〕");
    refs.web(SOURCE(1));
    refs.web(SOURCE(2));
    expect(refs.webSources()).toEqual([
      { n: 2, ...SOURCE(1) },
      { n: 3, ...SOURCE(2) },
    ]);
    expect(new RunRefs().webSources()).toEqual([]);
  });

  it("a run not offered the web tool mints no w number", () => {
    expect(new RunRefs().web(SOURCE(1))).toBeNull();
  });

  it("web cites keep their own count: m and f cites and w cites each stop at 20", () => {
    const refs = new RunRefs({}, true);
    for (let i = 1; i <= 25; i++) {
      refs.message("c", i);
      refs.web(SOURCE(i));
    }
    const said = Array.from({ length: 25 }, (_, i) => `a〔m${i + 1}〕b〔w${i + 1}〕`).join("");
    const { cites } = takeCites(said, refs);
    expect(cites.filter((c) => c.kind === "m")).toHaveLength(20);
    expect(cites.filter((c) => c.kind === "w")).toHaveLength(20);
  });

  it("an acknowledgement or reasoning (cite: false) loses w tokens and cites nothing", () => {
    const refs = new RunRefs({}, true);
    refs.web(SOURCE(1));
    expect(takeCites("先查一下〔w1〕", refs, { cite: false })).toEqual({ text: "先查一下", cites: [] });
  });
});
