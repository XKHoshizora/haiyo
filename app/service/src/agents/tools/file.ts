import { findDownloadable } from "../../attachments/store.ts";
import { weight } from "../../metering/tokens.ts";
import type { ToolSpec } from "../../models/gateway.ts";
import { askerLine, readPrefix } from "../context.ts";
import { fileText, startsLikeText, UTF8_MAX_BYTES_PER_CHAR } from "../runtime/context.ts";
import type { ToolOutcome } from "../runtime/port.ts";
import { TOOL_MATERIAL, withoutMark } from "../runtime/prompt.ts";
import type { RunScope, ToolDeps } from "./index.ts";

/**
 * The file tool (README "Agents and runs", Tools in a reply): the text of a file the reply was shown the number of — by
 * its context's labels or a search's results (refs.ts) — read in pages. Only a file the Agent can see now
 * (`findDownloadable`, the Agent as reader) and, in a group, only one of that group sent after the reply's asker's line
 * and no later than what it had heard when it began (the calls it answers at or before the line are shown as their text
 * only: their files are not read either); in the Agent's own conversation also a file a search found in one of its groups.
 * Text only, decided by the bytes (runtime/context.ts `fileText`); an image, a PDF or anything else is refused. A
 * negative `from` is refused as such (`BAD_FROM`).
 */

export const READ_FILE = "read_file";

/** Characters of a file the tool reads into at most (`from` may not go past them). */
export const FILE_READ_MAX_CHARS = 1_000_000;

// The fixed sentences the model is answered with.
export const NO_SUCH_FILE = "没有这个文件编号。";
export const FILE_NOT_SEEN = "这个文件现在看不到了。";
export const CANNOT_READ = "这种文件我读不了内容。";
export const FILE_MISSING = "这个文件的内容找不到了。";
export const FROM_PAST_END = "from 超出了文件的长度。";
export const BAD_FROM = "from 要写 0 或更大的整数。";
export const FROM_TOO_FAR = "这个文件太长了，只能读前 100 万个字。";
export const READ_ON = "只读了一部分，可以用 from 接着读。";

export const fileSpec: ToolSpec = {
  name: READ_FILE,
  description:
    "读对话里一个文本文件的内容，用文件编号（对话里文件名前面的那个，或查找结果里 file 的 ref，原样照抄；只写 f1 这样的编号也行）。图片和 PDF 读不了。一次读一部分：还有没读的时候会给出 next，用 from 接着读。",
  parameters: {
    type: "object",
    properties: {
      file: { type: "string", description: "文件编号，比如 f1。" },
      from: { type: "integer", description: "从第几个字开始读，默认 0。" },
    },
    required: ["file"],
    additionalProperties: false,
  },
};

interface FileInput {
  file: string;
  from?: number;
}

/**
 * What one page of a file is: `TOOL_MATERIAL`, its name, where it starts, where to go on (null at the end) and, then, a
 * note — before the text, so that a cut of the result (runtime/loop.ts) keeps them — and the text from `from`.
 */
interface Page {
  about: string;
  name: string;
  from: number;
  next: number | null;
  note?: string;
  text: string;
}

/**
 * Reads one page of the file `input.file` names for `scope`'s reply: at most `TOOLS.resultMaxWeight` in all (the page as
 * JSON), from character `from` of the file's text (as `fileText` gives it). The read is bounded by what the page can hold:
 * the file's first `from` + 3 × that weight characters at most (a character weighs at least a third), read as at most four
 * bytes each, and never past `FILE_READ_MAX_CHARS`. A blob that is gone, or a number it was never given, is said so.
 */
export async function readFile(deps: ToolDeps, scope: RunScope, input: FileInput, signal: AbortSignal): Promise<ToolOutcome> {
  const attachmentId = scope.refs.fileOf(input.file);
  if (attachmentId === null) return { output: { error: NO_SUCH_FILE } };
  const from = input.from ?? 0;
  if (from < 0) return { output: { error: BAD_FROM } };
  if (from >= FILE_READ_MAX_CHARS) return { output: { error: FROM_TOO_FAR } };

  const within = scope.group ? { conversationId: scope.conversationId, after: await askerLine(deps.db, scope.id), upTo: scope.heardTo } : null;
  const found = await findDownloadable(deps.db, scope.agentId, attachmentId, within);
  if (found === null) return { output: { error: FILE_NOT_SEEN } };
  if (found.inline || found.mime === "application/pdf") return { output: { error: CANNOT_READ } };

  const max = deps.config.tools.resultMaxWeight;
  const chars = Math.min(FILE_READ_MAX_CHARS, from + 3 * max + 1);
  const got = await readPrefix(deps.blobs, found.blobKey, Math.min(found.size, chars * UTF8_MAX_BYTES_PER_CHAR), { probe: startsLikeText, signal });
  if (got === null) return { output: { error: FILE_MISSING } };
  const text = fileText(got.data, got.complete, chars);
  if (text === null) return { output: { error: CANNOT_READ } };
  const shown = Array.from(text.text);
  // `fileText` marks a text it cut (or whose bytes were cut) after the characters of the file it shows.
  const more = shown.length > text.chars;
  const rest = shown.slice(0, text.chars).slice(from);
  if (rest.length === 0) return { output: { error: FROM_PAST_END } };

  // In a group the run's mark is taken out; the rest is shown as it is (what looks like a citation in it is what someone
  // wrote). `from` and `next` count the file's own characters.
  const clean = (s: string): string => withoutMark(s, scope.group ? scope.mark : null);
  const name = clean(found.name);
  const page = (n: number): Page => {
    const next = n < rest.length || more ? from + n : null;
    return { about: TOOL_MATERIAL, name, from, next, ...(next === null ? {} : { note: READ_ON }), text: clean(rest.slice(0, n).join("")) };
  };
  // The most characters whose page fits (JSON escapes count): found by halving.
  let [low, high] = [0, rest.length];
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (weight(JSON.stringify(page(mid))) <= max) low = mid;
    else high = mid - 1;
  }
  // What the page shows of what anyone wrote is read for numbers they typed (refs.ts `RunRefs.plant`): none is cited.
  const shownPage = page(low);
  scope.refs.plant(shownPage.name);
  scope.refs.plant(shownPage.text);
  return { output: shownPage };
}
