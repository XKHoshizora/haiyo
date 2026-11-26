import { IMAGE_TOKENS, pdfTokens } from "../../metering/prices.ts";
import { CONTEXT_HEADROOM, estimateTokens, lastToWeight, TOOL_TEXT_FACTOR, weight, weightWithin } from "../../metering/tokens.ts";
import type { ModelCall, Part, ReplayCall, ReplayResult, TurnPart } from "../../models/gateway.ts";
import { characters as countCharacters, stripUnsafeText } from "../../schemas.ts";
import { systemTokens, type SystemText } from "./prompt.ts";

/**
 * What the model is shown (spec 6.5 "发给模型的内容"; README "Agents and runs"), as pure functions: the budget, how a
 * message becomes parts, what of a file is text, and which turns and attachment contents fit. The queries and blob
 * reads that feed them are in `src/agents/context.ts`, outside the runtime (they need the database and the blob store).
 */

/** Characters of a quoted message shown before the quoting one. */
export const QUOTE_MAX_CHARS = 200;
/** The largest image shown to a model as an image. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** The image formats shown to a model as images: those all four protocols take. Others (GIF) are shown by name. */
export const MODEL_IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp"]);
/**
 * Tokens the conversation must have at least for a call to be made: the owner's newest message whole, or this many of
 * it, whichever is fewer. Less, and the run fails `context_too_small` instead of answering a fragment.
 */
export const MIN_CONVERSATION_TOKENS = 200;
/** Images one call shows at most: the newest. */
export const IMAGES_PER_CALL = 10;
/** The largest PDF handed to a model that reads PDFs. */
export const PDF_MAX_BYTES = 10 * 1024 * 1024;
/** Characters of one file shown as text at most. */
export const FILE_MAX_CHARS = 100_000;
/** Characters of files shown as text in one call at most. */
export const CALL_FILE_MAX_CHARS = 200_000;
/**
 * Bytes of attachments one call holds at most — images, PDFs and files' text together (four images of 5 MiB, or two
 * PDFs of 10 MiB, fill it). With `AGENT_MAX_RUNS_IN_FLIGHT` replies at once, and up to about five copies of what a call
 * sends at its peak (the bytes, their base64 text, the request body holding it, its encoded bytes), this bounds the
 * memory replies take for attachments: 8 × 20 MiB × 5, about 800 MiB, at the default.
 */
export const CALL_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;
/** UTF-8 takes at most this many bytes per character: reading 4 × n bytes yields at least n characters of a text. */
export const UTF8_MAX_BYTES_PER_CHAR = 4;
/** Ends a file's text that was cut. */
export const CUT_MARK = "…（已截断）";
/** Starts the newest message's text when it alone was over the budget and lost its beginning. */
export const CUT_FRONT = "…";

/**
 * A file message's attachment, as the message names it. `image`: one the site shows as a picture (PNG, JPEG, WebP, GIF).
 * `ref`: its number in a reply offered tools (agents/tools/refs.ts), which its label then carries; none otherwise.
 */
export interface ContextAttachment {
  id: string;
  name: string;
  image: boolean;
  ref?: string;
}

/**
 * One round of an earlier reply's tool use as it returns in history (agents/replay.ts `replayOf`; harness design §3): its
 * calls, then their placeholder results.
 */
export interface ReplayRound {
  calls: ReplayCall[];
  results: ReplayResult[];
}

/** One message as it may be shown: the owner's as `user`, the Agent's as `assistant`. */
export interface ContextEntry {
  role: "user" | "assistant";
  /** The quote (`> ` lines) and the message's own text or caption; may be empty when there is an attachment. */
  text: string;
  attachment: ContextAttachment | null;
  /**
   * An Agent's reply that looked something up, in a plan offered the tools it called (agents/context.ts `loadPage`): its
   * rounds, returned before its text (`ContextPlan.build`), kept or left out with it. Absent: none (every other entry).
   */
  replay?: ReplayRound[];
  /**
   * An Agent's acknowledgement (agents/context.ts `loadPage`, a plan that replays): right before an entry with a replay it
   * is sent at the head of that answer's turn, after the last result, not before the first call (`ContextPlan.build`), so
   * that no replayed turn holds text and then a call — the shape of the reply being written, which was copied (harness
   * design §3).
   */
  ack?: true;
  /**
   * A call of the reply's assignment when it answers two or more (agents/context.ts `loadPage`; T2 fix 1, F11): kept whatever else is
   * left out — cut from the front to what the budget holds when it does not fit whole (`ContextPlan`).
   */
  pinned?: true;
}

/** What an attachment is shown as instead of its name: an image, a PDF, or the text of a file (cut already). */
export type AttachmentContent =
  | { type: "image"; mime: string; data: Uint8Array }
  | { type: "pdf"; data: Uint8Array }
  | { type: "text"; text: string; chars: number };

/**
 * `[图片：name]` or `[文件：name]`: an attachment shown by its name; with its number in a reply offered tools,
 * `[图片 f2：name]` or `[文件 f1：name]` (what the file tool is called with).
 */
export const attachmentLabel = (a: Pick<ContextAttachment, "name" | "image" | "ref">): string =>
  `[${a.image ? "图片" : "文件"}${a.ref === undefined ? "" : ` ${a.ref}`}：${a.name}]`;

/**
 * Tokens the conversation may take: of what the model's context leaves beside its output limit, the system text (as
 * `systemTokens` counts its parts at `ratio`) and `reserved`, all but `CONTEXT_HEADROOM` of it, rounded down — the one
 * place the headroom is kept. `ratio`: what the context is planned at (metering/tokens.ts `planRatio`), which every count
 * of the plan uses too. `reserved`: tokens the call sends besides the system text and the conversation, at that ratio (a
 * reply's tool definitions and what providers add around them, agents/port-impl.ts `begin`); none by default.
 */
export function contextBudget(contextTokens: number, maxOutputTokens: number, system: Pick<SystemText, "rest" | "passage">, ratio = 1, reserved = 0): number {
  return Math.floor((contextTokens - maxOutputTokens - systemTokens(system, ratio) - reserved) * (1 - CONTEXT_HEADROOM));
}

/** The first `QUOTE_MAX_CHARS` characters of a quoted message, each line as `> line`. */
export function quoteLines(quoted: string): string {
  return Array.from(quoted)
    .slice(0, QUOTE_MAX_CHARS)
    .join("")
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** A message's text as shown: what it quotes (`quoteLines`), if anything, then its own text. */
export function entryText(own: string, quoted: string | null): string {
  if (quoted === null) return own;
  return own === "" ? quoteLines(quoted) : `${quoteLines(quoted)}\n${own}`;
}

/**
 * THE text a part is weighed as (harness design §3, Holds): a text part its text; an earlier reply's call
 * `{"id","name","input"}` and its result `{"id","name","output"}` as JSON — what the wire carries of them, and more; null
 * for an image or a PDF, which are counted at their constants instead. The plan (`partTokens`), admission (port-impl.ts
 * `begin`) and the worker's holds (worker.ts `toolReply`) all weigh a call's turns by it, so a replay is held as it is
 * planned, once.
 */
export function partText(p: TurnPart): string | null {
  switch (p.type) {
    case "text":
      return p.text;
    case "tool-call":
      return JSON.stringify({ id: p.id, name: p.name, input: p.input });
    case "tool-result":
      return JSON.stringify({ id: p.id, name: p.name, output: p.output });
    default:
      return null;
  }
}

/**
 * Tokens a part is counted as (metering/tokens.ts, prices.ts): a text its weight times `ratio` (the plan's); a replayed
 * call or result its `partText` at `ratio` times `TOOL_TEXT_FACTOR`, as every tool text is planned; an image
 * `IMAGE_TOKENS`, a PDF `pdfTokens` — constants, at any ratio.
 */
export function partTokens(p: TurnPart, ratio = 1): number {
  switch (p.type) {
    case "text":
      return estimateTokens(p.text, ratio);
    case "tool-call":
    case "tool-result":
      return estimateTokens(partText(p)!, ratio * TOOL_TEXT_FACTOR);
    case "image":
      return IMAGE_TOKENS;
    case "file":
      return pdfTokens(p.data.length);
  }
}

/** The parts of an entry's replay, in the order they are sent. */
const replayParts = (e: ContextEntry): TurnPart[] => (e.replay ?? []).flatMap((r) => [...r.calls, ...r.results]);

/** The attachment's part: its content when there is some, else its name. */
function attachmentPart(a: ContextAttachment, content: AttachmentContent | null): Part {
  if (content === null) return { type: "text", text: attachmentLabel(a) };
  switch (content.type) {
    case "image":
      return { type: "image", mime: content.mime, data: content.data };
    case "pdf":
      return { type: "file", mime: "application/pdf", name: a.name, data: content.data };
    case "text":
      return { type: "text", text: `${attachmentLabel(a)}\n${content.text}` };
  }
}

/** Tokens the message takes at least, planned at `ratio`: its text, its attachment's name, and its replay (one unit with it). */
export function minimalTokens(e: ContextEntry, ratio = 1): number {
  return (
    estimateTokens(e.text, ratio) +
    (e.attachment ? estimateTokens(attachmentLabel(e.attachment), ratio) : 0) +
    replayParts(e).reduce((n, p) => n + partTokens(p, ratio), 0)
  );
}

/**
 * Whether `budget` holds what a call needs at least (`MIN_CONVERSATION_TOKENS`), planned at `ratio`; false when there is
 * no owner's message.
 */
export function holdsNewest(entries: readonly ContextEntry[], budget: number, ratio = 1): boolean {
  const newest = [...entries].reverse().find((e) => e.role === "user");
  return newest !== undefined && budget >= Math.min(MIN_CONVERSATION_TOKENS, minimalTokens(newest, ratio));
}

/**
 * Whether messages loaded newest first already reach past the budget, planned at `ratio`: from the owner's newest message
 * (the Agent's later ones are never shown) their least sizes add up to more than it, so nothing older can be shown.
 */
export function pastBudget(newestFirst: readonly ContextEntry[], budget: number, ratio = 1): boolean {
  const from = newestFirst.findIndex((e) => e.role === "user");
  if (from < 0) return false;
  let total = 0;
  for (const e of newestFirst.slice(from)) {
    total += minimalTokens(e, ratio);
    if (total > budget) return true;
  }
  return false;
}

// --- files ------------------------------------------------------------------------------------------------------------

/** Control characters other than the white space text files use (tab, line feed, carriage return, form feed). */
const STRAY_CONTROLS = /(?![\t\n\r\f])\p{Cc}/gu;

/** The length of the longest prefix of `b` that does not end inside a UTF-8 sequence (a read cut short may). */
function wholeCharacters(b: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, b.length); back++) {
    const byte = b[b.length - back]!;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: its sequence starts further back
    const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return length > back ? b.length - back : b.length;
  }
  return b.length;
}

/**
 * A file's bytes as text for the model, decided by the bytes alone (not the name, not the stored type): they must be
 * UTF-8 (a leading byte-order mark is dropped; when `complete` is false the bytes were cut short and a character cut in
 * two at the end is dropped), contain no NUL, and at most 1 in 100 characters may be a control character other than
 * tab, line feed, carriage return and form feed. Otherwise null, as for a file with no characters. The text then
 * loses what message text may not hold (`stripUnsafeText`: bidi controls, control characters, lone surrogates) and is
 * cut to `maxChars` characters, marked `CUT_MARK` when it was cut here or the bytes were. `chars`: the characters of the
 * file shown, without the mark.
 */
export function fileText(bytes: Uint8Array, complete: boolean, maxChars: number): { text: string; chars: number } | null {
  let b = bytes;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  if (!complete) b = b.subarray(0, wholeCharacters(b));
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(b);
  } catch {
    return null;
  }
  if (decoded === "" || decoded.includes("\u0000")) return null;
  const stray = decoded.match(STRAY_CONTROLS)?.length ?? 0;
  if (stray * 100 > countCharacters(decoded)) return null;
  const characters = Array.from(stripUnsafeText(decoded));
  const cut = !complete || characters.length > maxChars;
  const shown = characters.slice(0, maxChars);
  if (shown.length === 0) return null;
  return { text: shown.join("") + (cut ? CUT_MARK : ""), chars: shown.length };
}

/** Whether the first bytes of a file could start a text (`fileText`): reading the rest is pointless otherwise. */
export const startsLikeText = (head: Uint8Array): boolean => fileText(head, false, Number.MAX_SAFE_INTEGER) !== null;

// --- the plan ---------------------------------------------------------------------------------------------------------

interface Kept {
  entry: ContextEntry;
  /** What its attachment is shown as; null: its name. */
  content: AttachmentContent | null;
  /** Where it is in the entries the plan was made of (`shownAt`). */
  at: number;
}

/** An entry with where it is in the entries the plan was made of. */
interface Placed {
  entry: ContextEntry;
  at: number;
}

/**
 * Which messages a call shows and which attachment contents, within `budget` tokens (`contextBudget`), every text counted
 * at `ratio` (the plan's: metering/tokens.ts `planRatio`). Built from the
 * messages after the latest new topic in the order they were answered, oldest first; Agent messages after the owner's
 * newest are left out (a call ends on the owner's turn; answered order leaves none there but after a manual retry), and
 * so are messages with nothing to show. What fits, in this order:
 *
 * 1. The current turn — the owner's messages after the Agent's last — by name only, newest first, while they fit.
 *    The owner's newest message is always shown: when it alone is over the budget, it is cut from the front
 *    (`CUT_FRONT`, then its end).
 * 2. Its attachments' contents, newest first, each if it fits (`offer`).
 * 3. Older messages by name only, newest first, while they fit (`keepOlder`): no gaps, nothing older than one that did
 *    not fit.
 * 4. Their attachments' contents, newest first, each if it fits.
 *
 * So when the budget runs short, older messages' attachment contents go (leaving the name) before older messages do,
 * and the newest attachments are the last to go. At most `IMAGES_PER_CALL` images, `CALL_FILE_MAX_CHARS` characters
 * of files and `CALL_ATTACHMENT_MAX_BYTES` bytes of attachments in all are shown in one call, the newest first; the
 * caller reads nothing larger than `bytesLeft`, and files with `fileCharsLeft` as their limit.
 */
export class ContextPlan {
  /** Newest first: the current turn's (`current` of them), then older ones. */
  private readonly kept: Kept[] = [];
  private readonly current: number;
  private readonly older: Placed[];
  private left: number;
  private imagesLeft = IMAGES_PER_CALL;
  /** Characters of files a text may still take in this call. */
  fileCharsLeft = CALL_FILE_MAX_CHARS;
  /** Bytes attachments may still take in this call. */
  bytesLeft = CALL_ATTACHMENT_MAX_BYTES;

  constructor(
    entries: readonly ContextEntry[],
    budget: number,
    private readonly ratio = 1,
  ) {
    this.left = budget;
    const newestFirst = entries.flatMap((entry, at): Placed[] => (entry.text !== "" || entry.attachment !== null ? [{ entry, at }] : [])).reverse();
    const newestOwn = newestFirst.findIndex((p) => p.entry.role === "user");
    const shown = newestOwn < 0 ? [] : newestFirst.slice(newestOwn);
    const agentAt = shown.findIndex((p) => p.entry.role === "assistant");
    const turn = agentAt < 0 ? shown : shown.slice(0, agentAt);
    let fits = true;
    for (const [i, p] of turn.entries()) {
      if (i === 0) this.keepNewest(p);
      else if (fits && (fits = this.keep(p))) continue;
      // Past what fits, only a call of its assignment is kept (`ContextEntry.pinned`), cut if it must be.
      else if (p.entry.pinned) this.keepPinned(p);
    }
    this.current = this.kept.length;
    this.older = fits ? shown.slice(turn.length) : shown.slice(turn.length).filter((p) => p.entry.pinned === true);
  }

  /** A call of the assignment (`ContextEntry.pinned`): kept whole when it fits, else cut from the front to what is left. */
  private keepPinned(p: Placed): void {
    if (this.keep(p)) return;
    const e = p.entry;
    const whole = [e.text, e.attachment ? attachmentLabel(e.attachment) : ""].filter((s) => s !== "").join("\n");
    const text = CUT_FRONT + lastToWeight(whole, Math.max(0, weightWithin(this.left, this.ratio) - weight(CUT_FRONT)));
    this.kept.push({ entry: { ...e, text, attachment: null }, content: null, at: p.at });
    this.left -= estimateTokens(text, this.ratio);
  }

  /** The owner's newest message: as it is when it fits, else cut from the front to what the budget holds (its end, in weight). */
  private keepNewest(p: Placed): void {
    if (this.keep(p)) return;
    const e = p.entry;
    const whole = [e.text, e.attachment ? attachmentLabel(e.attachment) : ""].filter((s) => s !== "").join("\n");
    const text = CUT_FRONT + lastToWeight(whole, weightWithin(this.left, this.ratio) - weight(CUT_FRONT));
    this.kept.push({ entry: { ...e, text, attachment: null }, content: null, at: p.at });
    this.left -= estimateTokens(text, this.ratio);
  }

  /** Keeps the entry by name when it fits. */
  private keep(p: Placed): boolean {
    const cost = minimalTokens(p.entry, this.ratio);
    if (cost > this.left) return false;
    this.kept.push({ entry: p.entry, content: null, at: p.at });
    this.left -= cost;
    return true;
  }

  /** Step 3: older messages by name, newest first, while they fit. */
  keepOlder(): void {
    let fits = true;
    for (const p of this.older) {
      if (fits && (fits = this.keep(p))) continue;
      if (p.entry.pinned) this.keepPinned(p);
    }
    this.older.length = 0;
  }

  /**
   * Where, in the entries the plan was made of, the messages `build` shows are, oldest first: those kept, but the Agent's a
   * call does not start with — so the first is always one of the owner's (in a group, anyone else's). Everything before them
   * in that order was left out (agents/context.ts `LoadedContext.leftOut`).
   */
  shownAt(): number[] {
    const oldestFirst = [...this.kept].reverse();
    const from = oldestFirst.findIndex((k) => k.entry.role === "user");
    return from < 0 ? [] : oldestFirst.slice(from).map((k) => k.at);
  }

  /**
   * The attachments whose contents may still be offered, newest first: the current turn's (`older` false), or those of
   * the older messages kept by `keepOlder` (`older` true). Each is `[slot, attachment]`; pass the slot to `offer`.
   */
  attachments(older: boolean): Array<[number, ContextAttachment]> {
    const out: Array<[number, ContextAttachment]> = [];
    for (const [slot, k] of this.kept.entries()) {
      if ((slot >= this.current) === older && k.entry.attachment) out.push([slot, k.entry.attachment]);
    }
    return out;
  }

  /** Tokens an attachment's content may take at most: what is left, plus its name's, which the content replaces. */
  room(slot: number): number {
    return this.left + estimateTokens(attachmentLabel(this.kept[slot]!.entry.attachment!), this.ratio);
  }

  /** Tokens `text` is planned at (its weight at the plan's ratio): what the caller compares with `room`. */
  textTokens(text: string): number {
    return estimateTokens(text, this.ratio);
  }

  /** Whether one more image may be shown. */
  canShowImage(): boolean {
    return this.imagesLeft > 0;
  }

  /** Shows `content` instead of the attachment's name when it fits (and is within the per-call limits); true if so. */
  offer(slot: number, content: AttachmentContent): boolean {
    const k = this.kept[slot]!;
    const cost = partTokens(attachmentPart(k.entry.attachment!, content), this.ratio);
    const bytes = content.type === "text" ? Buffer.byteLength(content.text, "utf8") : content.data.length;
    if (cost > this.room(slot) || bytes > this.bytesLeft) return false;
    if (content.type === "image" && this.imagesLeft === 0) return false;
    if (content.type === "text" && content.chars > this.fileCharsLeft) return false;
    this.left = this.room(slot) - cost;
    this.bytesLeft -= bytes;
    k.content = content;
    if (content.type === "image") this.imagesLeft--;
    if (content.type === "text") this.fileCharsLeft -= content.chars;
    return true;
  }

  /**
   * The call's turns, oldest first: a turn of the Agent's first is left out (a call starts with the owner's), and
   * consecutive messages of one side are one turn, their parts in order. The turns never end with the Agent's own: what
   * is shown starts at the person's newest message (the constructor: an Agent's message after it — its acknowledgement a
   * retry answers after, its own reply a told reply's group ends with — is not shown).
   * An Agent's reply with a replay (`ContextEntry.replay`) returns as its rounds first — each round's calls in an
   * Agent's turn, then a `tool` turn of their results — and then its text in a turn of its own, headed by its
   * acknowledgement (`ContextEntry.ack`, held back from before the first call) (harness design §3, the layout); a later
   * round's text before its calls is part of that text, so it comes after the last result. Lowered (gateway.ts
   * `ModelCall.messages`), that is the turns as they were: `[acknowledgement, answer]` in one turn.
   * `tokens`: what they are counted as at ratio 1 (`partTokens`: the estimate admission corrects and settlement learns
   * from, not the plan's count; a replayed call or result at `TOOL_TEXT_FACTOR`); `fixed`: the part of it that is images
   * and PDFs at their constants — never a replayed part, which is text (`partText`) wherever it is weighed.
   */
  build(): { messages: ModelCall["messages"]; tokens: number; fixed: number } {
    const oldestFirst = [...this.kept].reverse();
    while (oldestFirst[0]?.entry.role === "assistant") oldestFirst.shift();
    const messages: ModelCall["messages"] = [];
    let tokens = 0;
    let fixed = 0;
    const add = (role: ModelCall["messages"][number]["role"], parts: TurnPart[]): void => {
      for (const p of parts) {
        const n = partTokens(p);
        tokens += n;
        if (p.type === "image" || p.type === "file") fixed += n;
      }
      const last = messages[messages.length - 1];
      if (last?.role === role && role !== "tool") last.parts.push(...parts);
      else messages.push({ role, parts });
    };
    /** An acknowledgement held back to head its answer's turn after the results (`ContextEntry.ack`). */
    let held: Part[] = [];
    for (const [i, { entry, content }] of oldestFirst.entries()) {
      const parts: Part[] = [];
      if (entry.text !== "") parts.push({ type: "text", text: entry.text });
      if (entry.attachment) parts.push(attachmentPart(entry.attachment, content));
      if (entry.ack && oldestFirst[i + 1]?.entry.replay) {
        held = parts;
        continue;
      }
      for (const round of entry.replay ?? []) {
        add("assistant", round.calls);
        add("tool", round.results);
      }
      add(entry.role, [...held, ...parts]);
      held = [];
    }
    return { messages, tokens, fixed };
  }
}
