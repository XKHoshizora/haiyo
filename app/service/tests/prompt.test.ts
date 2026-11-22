import { describe, expect, test } from "vitest";
import { readKeys, type KeyState } from "../src/prompt.ts";

/** What the hidden prompt of `demo:seed` (src/prompt.ts) takes from a terminal in raw mode: typed text, nothing else. */
const typed = (...chunks: string[]) => {
  let state: KeyState = { text: "", escape: 0 };
  let outcome: "typing" | "done" | "cancelled" = "typing";
  for (const chunk of chunks) {
    const r = readKeys(state, chunk);
    state = r.state;
    outcome = r.outcome;
    if (outcome !== "typing") break;
  }
  return { text: state.text, outcome };
};

describe("the hidden prompt's keys", () => {
  test("letters, digits and spaces are typed; Enter ends", () => {
    expect(typed("my pass", "word 12\r")).toEqual({ text: "my password 12", outcome: "done" });
    expect(typed("abc\n")).toEqual({ text: "abc", outcome: "done" });
  });

  test("arrow keys, Home/End and other escape sequences add nothing, even split across reads", () => {
    expect(typed("ab\u001b[A\u001b[Dcd\u001bOH\u001b[3~ef\r")).toEqual({ text: "abcdef", outcome: "done" });
    expect(typed("ab\u001b", "[", "B", "cd\r")).toEqual({ text: "abcd", outcome: "done" });
    // Alt+key: the escape and the one key after it.
    expect(typed("x\u001bfy\r")).toEqual({ text: "xy", outcome: "done" });
  });

  test("Backspace removes the last character; other control keys add nothing; Ctrl-C cancels", () => {
    expect(typed("abcd\u007f\u007fx\b\r")).toEqual({ text: "ab", outcome: "done" });
    expect(typed("a\tb\u0001c\r")).toEqual({ text: "abc", outcome: "done" });
    expect(typed("secret\u0003more")).toEqual({ text: "secret", outcome: "cancelled" });
  });
});
