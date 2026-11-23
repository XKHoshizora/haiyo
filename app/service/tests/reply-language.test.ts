import { describe, expect, it } from "vitest";
import { MENTION } from "../src/agents/mentions.ts";
import { detectLanguage, HANDLE_PATTERN_SOURCE } from "../src/agents/runtime/language.ts";
import { groupSystemText, NO_NOTES, NO_TOOLS, REPLY_LANGUAGE, REPLY_LANGUAGE_FOR, systemText, toolsPassage } from "../src/agents/runtime/prompt.ts";
import { estimateTokens } from "../src/metering/tokens.ts";

/**
 * The reply's language is decided by code and said concretely (lane lang): `detectLanguage` reads the message being
 * answered by its script, and the system text of a reply offered tools names that language in place of the abstract
 * `REPLY_LANGUAGE` line. Measured on two models: the abstract line was wrong 19 of 100, the concrete one 2 of 100 and 0 of 100.
 */

describe("detectLanguage — by script", () => {
  const cases: Array<[string, string, "zh" | "ja" | "en" | null]> = [
    ["chinese question", "北京今天天气怎么样？", "zh"],
    ["chinese statement", "帮我整理一下今天的会议记录", "zh"],
    ["two han characters only", "你好", "zh"],
    ["chinese with a digit and punctuation", "第 3 章讲了什么？", "zh"],
    ["japanese hiragana question", "今日の大阪の天気は？", "ja"],
    ["japanese katakana only", "コーヒー", "ja"],
    ["japanese short follow-up", "続けて", "ja"],
    ["japanese with two kana among kanji", "東京のお天気", "ja"],
    ["japanese with one kana among kanji", "私は東京へ行く予定です", "ja"],
    ["japanese halfwidth katakana", "ｱｲｳ", "ja"],
    ["kana beats a great deal of han", "中文中文中文中文中文の", "ja"],
    ["english question", "What is the weather in London today?", "en"],
    ["english short", "thanks a lot", "en"],
    ["english three letters", "yes", "en"],
    ["french with diacritics is not claimed as english", "Où est la gare ?", null],
    ["an english sentence with one chinese name is not claimed as english (any Han: null)", "Please ask 小明 about the report tomorrow", null],
    ["chinese with english terms, 3 Han and 26 Latin", "帮我看 TypeScript satisfies operator", null],
    ["chinese with english terms, a question", "这个 useEffect cleanup function 为啥不执行", null],
    ["japanese kanji and english terms, no kana", "東京 release notes summary", null],
    ["decomposed french (e + combining acute)", "Oú est la gare, je cherche", null],
    ["decomposed vietnamese", "Tho̜i tiết hôm nay thế nào", null],
    ["precomposed and decomposed e acute alike", "Let us meet at the café tomorrow", null],
    ["mixed: chinese with a product and a phrase", "帮我查一下 React 19 的 release notes", "zh"],
    ["mixed: chinese with one english word", "这个 bug 怎么修", "zh"],
    ["mixed: japanese with english", "React 19 の release notes を教えて", "ja"],
    ["url only", "https://example.com/a/b?c=d", null],
    ["url and handle only", "@helper https://example.com/a/b%E4%B8%AD", null],
    ["ok is two letters", "OK", null],
    ["emoji", "👍🙂", null],
    ["digits and punctuation", "12345 ?!", null],
    ["empty", "", null],
    ["whitespace", "  \n\t ", null],
    ["one han character", "好", null],
    ["a url inside a chinese sentence does not count as latin", "看看 https://example.com/some/long/path/to/the/page 这个页面讲什么", "zh"],
    ["an english sentence with an ascii url", "see https://ja.example.com/page for details", "en"],
    ["a url ends at the first CJK character: the text glued after it stays", "链接https://x.com这是什么", "zh"],
    ["a url ends at a full-width comma", "https://example.com/a，帮我总结一下", "zh"],
    ["a handle glued to chinese keeps the chinese", "@helper帮我查一下天气", "zh"],
    ["a handle glued to japanese keeps the japanese", "@helper今日の天気", "ja"],
    ["an agent handle with its owner part", "@jia.helper 你好吗", "zh"],
    ["korean with english words", "React 19 의 release notes 알려줘", null],
    ["korean only", "안녕하세요 오늘 날씨 어때요", null],
    ["russian", "Как настроить React?", null],
    ["french with diacritics", "Où est la gare, s'il vous plaît ?", null],
    ["french without diacritics reads english by script", "Where is the station please", "en"],
    ["spanish with n tilde", "¿Cuántos años tienes? Mañana vamos", null],
    ["spanish without diacritics reads english by script", "Donde esta la estacion de tren", "en"],
    ["german with sharp s", "Wie groß ist das Haus", null],
    ["german with umlaut", "Können Sie mir helfen bitte", null],
    ["vietnamese", "Thời tiết hôm nay thế nào", null],
    ["greek", "Τι καιρό κάνει σήμερα", null],
    ["english with one accented word", "Let us meet at the café tomorrow", null],
    ["a chinese message quoting a korean word stays zh", "韩语的 안녕하세요 是什么意思", "zh"],
    ["a japanese message with a french word stays ja", "「Où est la gare」はどういう意味ですか", "ja"],
    ["a chinese message quoting a russian word stays zh", "俄语 привет 是什么意思", "zh"],
    ["an unclosed fence strips only its own line: the text before it stays", "这个报错怎么办 ```js", "zh"],
    ["an unclosed fence keeps the later lines", "```js\nWhat does this error mean for us today?", "en"],
    ["a closed fence is stripped whole", "What is this?\n```\n这是中文代码注释这是中文\n```", "en"],
    ["a handle does not count as latin", "@some_long_handle_name 你好吗", "zh"],
    ["fenced code is stripped", "```js\nconst totalAmountOfThings = compute(items);\n```\n这段代码有什么问题", "zh"],
    ["inline code is stripped", "`getUserProfileByIdentifier` 是做什么的", "zh"],
    ["code only", "```py\nprint('hello world')\n```", null],
    ["english question about code in japanese quotes", "Explain `ありがとう` in this sentence please", "en"],
  ];
  for (const [name, text, want] of cases) {
    it(`${name}: ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)} → ${want}`, () => {
      expect(detectLanguage(text)).toBe(want);
    });
  }

  // A message with no real words says nothing of a language (lane thinkfold): hex bytes, numbers, identifiers and encoded
  // text hold Latin letters, but nobody wrote a sentence with them. The owner's own message was the first row.
  const wordless: Array<[string, string, "zh" | "ja" | "en" | null]> = [
    ["hex bytes (我爱你 in UTF-8), as the owner sent them", "E6 88 91 E7 88 B1 E4 BD A0", null],
    ["hex bytes, lower case, glued", "e68891e788b1e4bda0", null],
    ["hex bytes with 0x", "0xE6 0x88 0x91", null],
    ["three hex pairs", "FF 00 AB", null],
    ["hex pairs of letters only", "FF AB CD EF", null],
    ["a hex colour", "#ffccee", null],
    ["a MAC address of letters", "de:ad:be:ef:fa:ce", null],
    ["words spelt with a–f only read as hex", "deadbeef cafe babe", null],
    ["…also in capitals", "DEADBEEF", null],
    ["…but count once a word with another letter stands beside them", "the cafe was bad", "en"],
    ["…and a hex dump somebody asks about is asked about in English", "what is FF 00 AB", "en"],
    ["hex bytes and a two-letter word: still under three letters", "E6 88 91 ok", null],
    ["digits", "12345", null],
    ["a version", "v2.10.3", null],
    ["a base64 blob", "SGVsbG8gd29ybGQsIGZyaWVuZA==", null],
    ["a base64 blob with no digit in it", "dGhlcmUgdGhlcmUgcGxlYXNl", null],
    ["a token", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dGhlcmUgdGhlcmUgbXk", null],
    ["a camelCase identifier", "getUserProfileById", null],
    ["a snake_case identifier", "user_profile_id", null],
    ["a product name with one inner capital is a word", "TypeScript", "en"],
    ["an identifier in an english question", "why does getUserProfileById return null", "en"],
    ["single letters", "a b c", null],
    ["ok: two letters, as before", "ok", null],
    ["hi: two letters, as before", "hi", null],
    ["two short words", "I am", "en"],
    ["a short word spelt with a–f beside another", "be ok", "en"],
    ["a greeting", "hello", "en"],
    ["a sentence", "Hello, how are you?", "en"],
    ["a sentence with numbers in it", "Call me at 3pm on the 2nd, room 12", "en"],
    ["emphasis marks around a word", "_really_ *good*", "en"],
    ["hex bytes beside chinese stay chinese", "E6 88 91 是什么意思", "zh"],
    ["hex bytes beside japanese stay japanese", "E6 88 91 はどういう意味", "ja"],
    // (Fix round 1.) A piece with a mark inside it that prose does not put inside a word is not prose: @ . / \ = :
    ["an e-mail address", "bob@example.com", null],
    ["another e-mail address", "hello@example.com", null],
    ["a file name", "readme.md", null],
    ["a file name with two dots", "report.final.docx", null],
    ["a windows path", "C:\\Users\\bob\\file.txt", null],
    ["a unix path", "/usr/local/bin", null],
    ["a relative path", "src/app/main.ts", null],
    ["a dotted identifier", "com.example.app", null],
    ["key=value", "key=value", null],
    ["a short hex colour", "#fff", null],
    ["a hex colour of an odd length", "#abcde", null],
    ["an abbreviation with dots alone", "e.g.", null],
    ["two words glued by a slash, alone (the cost of the rule)", "yes/no", null],
    ["an address in a sentence: the other words carry it", "mail me at bob@example.com", "en"],
    ["a file name in a sentence", "what is in readme.md", "en"],
    ["a word before a colon, a comma, a full stop is a word (marks at the edge)", "Note: fine, thanks.", "en"],
    // A word of a–f is hex-looking only in pairs and in one case, as bytes are written: the rest is prose.
    ["a–f prose of odd lengths", "bad dad", "en"],
    ["a–f prose with a capital", "Add a feed", "en"],
    ["a capitalised a–f word", "Dead", "en"],
    ["three capitals of a–f", "ABC", "en"],
    ["a–f prose that looks exactly like bytes stays null (cannot be told apart by script)", "dead beef", null],
    ["…and so does this", "cafe babe", null],
    // A digit-bearing piece or an apostrophe takes nothing from the words beside it.
    ["a time among words", "see you at 3pm", "en"],
    ["an apostrophe", "I'm fine", "en"],
    ["I'm alone: one letter and one letter", "I'm", null],
    ["a time with one two-letter word: under three letters", "at 3pm", null],
    ["a word written with a digit", "gr8", null],
    // Hyphenated English and capitals stay words — and so, known limits, do what looks the same by script.
    ["a hyphenated word", "well-known", "en"],
    ["capitals", "USA", "en"],
    ["known limit: a kebab identifier reads like a hyphenated word", "kebab-case-id", "en"],
    ["known limit: a key of capitals reads like a word in capitals", "AKIAIOSFODNN", "en"],
    ["known limit: short base64 with no digit and under two small→capital steps", "QUJD", "en"],
    ["known limit: an identifier with one inner capital reads like a name", "getUser", "en"],
    ["known limit: pinyin reads en by script", "ni hao", "en"],
  ];
  for (const [name, text, want] of wordless) {
    it(`no real words: ${name}: ${JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text)} → ${want}`, () => {
      expect(detectLanguage(text)).toBe(want);
    });
  }

  it("a long run of marks inside one piece costs time in proportion to its length (a message at the 8000-character cap)", () => {
    const worst = [`a${"!".repeat(7998)}a`, "!".repeat(8000), `${"!".repeat(7999)}a`, `a${"!".repeat(7999)}`];
    for (const text of worst) expect(detectLanguage(text)).toBeNull();
    const from = performance.now();
    for (let i = 0; i < 25; i += 1) for (const text of worst) detectLanguage(text);
    // (Trimmed by a regular expression with two anchored alternatives this took about 50 ms a message: over a second here.)
    expect(performance.now() - from).toBeLessThan(300);
  });

  it("known limit: a Japanese text with no kana at all reads as Chinese", () => {
    expect(detectLanguage("東京都人口")).toBe("zh");
  });

  it("known limit: one kana wins over any amount of Han (a quoted の or a katakana kaomoji in a Chinese message reads ja)", () => {
    expect(detectLanguage("東京の人口")).toBe("ja");
    expect(detectLanguage("东京的人口是多少，请告诉我今年的数字ヮ")).toBe("ja");
  });

  it("known limit: a Chinese message that is mostly English terms reads null (the abstract line), never en", () => {
    expect(detectLanguage("我想了解 Kubernetes deployment strategies")).toBeNull();
  });

  it("is a function of the text alone (no state between calls)", () => {
    expect([detectLanguage("今日の天気"), detectLanguage("weather today"), detectLanguage("今日の天気")]).toEqual(["ja", "en", "ja"]);
  });
});

const NOW = new Date("2026-11-17T04:00:00Z");
const TZ = "Asia/Shanghai";
const agent = { name: "小帮手", persona: "你说话简短。", ownerAppellation: null, memory: true };
const owner = { displayName: "主人甲" };
const gAgent = { name: "小帮手", handle: "jia.helper", persona: "你说话简短。", bare: "helper" };
const scene = { title: "读书会", agents: [], more: false, people: [], morePeople: false };
const lines = { zh: REPLY_LANGUAGE_FOR.zh, ja: REPLY_LANGUAGE_FOR.ja, en: REPLY_LANGUAGE_FOR.en };

describe("the handle pattern is the mention pattern", () => {
  it("one definition: language.ts mirrors mentions.ts MENTION source for source", () => {
    expect(HANDLE_PATTERN_SOURCE).toBe(MENTION.source);
  });
});

describe("the concrete line in the system text", () => {
  it("names the language, in Chinese like the rest, and says the instructions' own language is no hint", () => {
    expect(REPLY_LANGUAGE_FOR.ja).toBe("你要回答的那条消息是日语，这一次请全程用日语回答（包括搜索前后说的话）；这些说明是用中文写的，不代表你要用中文回答。");
    expect(REPLY_LANGUAGE_FOR.en).toBe(
      "你要回答的那条消息是英语（如果它其实是另一种用拉丁字母写的语言，就用那种语言），这一次请全程用它的语言回答，不要用中文（包括搜索前后说的话）；这些说明是用中文写的，不代表你要用中文回答。",
    );
    expect(REPLY_LANGUAGE_FOR.zh).toContain("中文");
    for (const l of Object.values(REPLY_LANGUAGE_FOR)) expect(l).toContain("包括搜索前后说的话");
  });

  for (const lang of ["zh", "ja", "en"] as const) {
    it(`own conversation, tools offered, message in ${lang}: the concrete line stands where the abstract one did, which is gone`, () => {
      const plain = systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, true).text;
      const text = systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, true, lang).text;
      expect(text).toBe(plain.replace(REPLY_LANGUAGE, lines[lang]));
      expect(text).toContain(`\n${lines[lang]}\n${toolsPassage("own")}`);
      expect(text).not.toContain(REPLY_LANGUAGE);
    });

    it(`group, mentioned, tools offered, message in ${lang}: the same`, () => {
      const plain = groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", false, NO_NOTES, true).text;
      const text = groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", false, NO_NOTES, true, lang).text;
      expect(text).toBe(plain.replace(REPLY_LANGUAGE, lines[lang]));
      expect(text).not.toContain(REPLY_LANGUAGE);
    });
  }

  it("a detection of null leaves today's text byte for byte, own conversation and group", () => {
    expect(systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, true, undefined).text).toBe(systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, true).text);
    expect(systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, true).text).toContain(`\n${REPLY_LANGUAGE}\n`);
    expect(groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", false, NO_NOTES, true, undefined).text).toBe(
      groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", false, NO_NOTES, true).text,
    );
  });

  it("a reply offered no tools, a told reply and an unasked group reply are unchanged whatever the language", () => {
    for (const lang of ["zh", "ja", "en"] as const) {
      expect(systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, false, lang).text).toBe(systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, false).text);
      expect(systemText(agent, owner, NOW, "normal", TZ, NO_NOTES, false, lang).text).toContain(NO_TOOLS);
      for (const tools of [false, "told"] as const) {
        expect(groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", false, NO_NOTES, tools, lang).text).toBe(groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", false, NO_NOTES, tools).text);
      }
      const unasked = groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", true, NO_NOTES, true, lang).text;
      expect(unasked).toBe(groupSystemText(gAgent, owner, scene, NOW, TZ, "k7f2ab", true, NO_NOTES, true).text);
      for (const l of Object.values(lines)) expect(unasked).not.toContain(l);
    }
  });

  it("what it adds to the weight of the system text: a few tokens, counted by the one function", () => {
    const abstract = estimateTokens(REPLY_LANGUAGE);
    const delta = Object.fromEntries((["zh", "ja", "en"] as const).map((l) => [l, estimateTokens(lines[l]) - abstract]));
    // Reported in the lane's report (measured at the plan's default ratio); the bound here is that it stays small.
    for (const d of Object.values(delta)) expect(Math.abs(d as number)).toBeLessThan(60);
  });
});
