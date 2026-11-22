import { describe, expect, it } from "vitest";
import * as loop from "../src/agents/runtime/loop.ts";
import * as elsewhere from "../src/agents/tools/elsewhere.ts";
import * as file from "../src/agents/tools/file.ts";
import * as search from "../src/agents/tools/search.ts";

/**
 * Principle P2: the Agent never says a canned sentence. What is shown in the system's voice (a whisper's line) is written
 * as the system, never as the Agent ("我"); and what a tool hands the model is a plain description of the situation, never
 * a sentence in the Agent's first person for it to repeat (the model words it itself).
 */
describe("no first-person fixed sentence", () => {
  it("the found-elsewhere whisper's line is the system's: 在别处查到了相关内容，要告诉他们吗？", () => {
    expect(elsewhere.FOUND_ELSEWHERE).toBe("在别处查到了相关内容，要告诉他们吗？");
  });

  it("every fixed sentence a tool or the tool loop hands the model is a description, with no 我 in it", () => {
    const sentences = (Object.entries({ ...loop, ...file, ...search }) as Array<[string, unknown]>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && /[一-鿿]/.test(entry[1]),
    );
    expect(sentences.length).toBeGreaterThan(15);
    for (const [name, text] of sentences) expect([name, text.includes("我")]).toEqual([name, false]);
  });

  it("a file the tool cannot read and a group search that only the owner could widen are said as what is so", () => {
    expect(file.CANNOT_READ).toBe("这种文件不是文本，读不了内容。");
    expect(search.ASK_ME_AT_HOME).toBe("只有在你和主人的专属会话里才能查所有地方。");
  });
});
