import { estimateTokens } from "../../metering/tokens.ts";
import { stripUnsafeText } from "../../schemas.ts";
import { TokenHold } from "../tools/refs.ts";
import type { Delta } from "./port.ts";

/** At most one delta push per this many milliseconds. */
export const DELTA_INTERVAL_MS = 50;

/**
 * Where a persona proposal's block (`<af-persona>` and its kin; agents/persona.ts) starts. From the first one in a
 * reply's text, nothing more of that text is pushed: tags never reach a `delta`, and the rest arrives with the stored
 * message, which has the block taken out.
 */
const BLOCK_START = "<af-";

/** How many characters at the end of `s` could be the start of `BLOCK_START` (`<`, `<a`, `<af`): held until the next piece says. */
function pendingStart(s: string): number {
  for (let n = Math.min(BLOCK_START.length - 1, s.length); n > 0; n--) {
    if (s.endsWith(BLOCK_START.slice(0, n))) return n;
  }
  return 0;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;

/**
 * One reply as it streams: the whole text and reasoning so far, and the pieces not yet pushed. Pieces are coalesced
 * so the owner's sockets get at most one delta every `intervalMs`: the first piece goes out at once, later ones wait
 * for the interval to pass. Characters a message may not hold (`stripUnsafeText`) are left out of each piece, of the
 * text and the reasoning, as it comes (a high surrogate a piece ends with waits for the next); the stored message is
 * cleaned the same way. With `holdTokens` (a reply offered tools, whose stored text keeps no token-shaped string —
 * agents/tools/refs.ts; but one of nothing else, kept as written: agents/conversation.ts `postAsAgent`) none is pushed, of the text or the reasoning: each piece, once cleaned, goes through `TokenHold`
 * — a token goes as it completes, what may still become one waits for the next piece however deep it nests, and at every
 * end (`end`, `flushNow`: a stop, a cut, a time limit, a failure, an acknowledgement) what may have begun one is
 * dropped, never pushed. Nothing of it is secret: the stream shows what the stored message will. The text is pushed only up
 * to the first `BLOCK_START` (looked for in the text as cleaned and without those tokens, as the stored message is
 * read): a `<` that may begin one waits for the next piece, and goes out in order once it turns out not to (or at
 * `end`). The reasoning is pushed as it comes.
 */
export class ReplyStream {
  text = "";
  reasoning = "";
  private pending: Required<Delta> = { text: "", reasoning: "" };
  private timer: NodeJS.Timeout | null = null;
  private lastSent = Number.NEGATIVE_INFINITY;
  /** The text as cleaned, piece by piece (what the pushes are cut from). */
  private shown = "";
  /** How much of `shown` has been handed to `pending`. */
  private released = 0;
  /** A block has begun: no more text is pushed. */
  private held = false;
  /** A high surrogate a piece ended with: kept for the next piece, so a pair split across pieces is not cleaned away. */
  private carry = { text: "", reasoning: "" };
  /** What of the text, and of the reasoning, may still become a token: held back (none without `holdTokens`). */
  private holds: { text: TokenHold; reasoning: TokenHold } | null;

  /** `holdTokens` `"web"`: a reply offered the web tool too, whose `〔w1〕` is held and taken out as well. */
  constructor(
    private readonly send: (delta: Delta) => void,
    private readonly intervalMs: number = DELTA_INTERVAL_MS,
    private readonly holdTokens: boolean | "web" = false,
  ) {
    this.holds = this.freshHolds();
  }

  private freshHolds(): { text: TokenHold; reasoning: TokenHold } | null {
    const web = this.holdTokens === "web";
    return this.holdTokens ? { text: new TokenHold(web), reasoning: new TokenHold(web) } : null;
  }

  add(kind: "text" | "reasoning", piece: string): void {
    this[kind] += piece;
    if (kind === "reasoning") {
      const cleaned = this.cleaned("reasoning", piece);
      this.pending.reasoning += this.holds ? this.holds.reasoning.push(cleaned) : cleaned;
    } else this.addText(piece);
    if (this.timer) return;
    const wait = this.lastSent + this.intervalMs - performance.now();
    if (wait <= 0) this.flush();
    else this.timer = setTimeout(() => this.flush(), wait);
  }

  private addText(piece: string): void {
    if (this.held) return;
    const cleaned = this.cleaned("text", piece);
    this.show(this.holds ? this.holds.text.push(cleaned) : cleaned);
  }

  /** `piece` of `kind` without what a message may not hold, a high surrogate it ends with kept for the next piece. */
  private cleaned(kind: "text" | "reasoning", piece: string): string {
    let raw = this.carry[kind] + piece;
    this.carry[kind] = "";
    if (raw !== "" && isHighSurrogate(raw.charCodeAt(raw.length - 1))) {
      this.carry[kind] = raw.slice(-1);
      raw = raw.slice(0, -1);
    }
    return stripUnsafeText(raw);
  }

  /** `text` (cleaned, without tokens) joins what is shown, which is released up to a block's start (or what may begin one). */
  private show(text: string): void {
    // Searched from just before what was released: a start that straddles two pieces is found too.
    const from = Math.max(0, this.shown.length - (BLOCK_START.length - 1));
    this.shown += text;
    const at = this.shown.indexOf(BLOCK_START, from);
    if (at >= 0) this.held = true;
    this.release(at >= 0 ? at : this.shown.length - pendingStart(this.shown));
  }

  /** Nothing more comes for now: of what was held, what may have begun a token goes, the rest is shown (the text's as any text is). */
  private settle(): void {
    if (!this.holds) return;
    this.pending.reasoning += this.holds.reasoning.end();
    const rest = this.holds.text.end();
    if (!this.held && rest !== "") this.show(rest);
  }

  /** Hands `shown` up to `upTo` to the next push. */
  private release(upTo: number): void {
    if (upTo <= this.released) return;
    this.pending.text += this.shown.slice(this.released, upTo);
    this.released = upTo;
  }

  /** Pushes what is pending now. */
  private flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const text = this.pending.text;
    const reasoning = this.pending.reasoning;
    this.pending = { text: "", reasoning: "" };
    if (text === "" && reasoning === "") return;
    this.lastSent = performance.now();
    this.send({ ...(reasoning === "" ? {} : { reasoning }), ...(text === "" ? {} : { text }) });
  }

  /**
   * The reply has ended, however it ended (before it is posted, if it is): of what was held for a token, what may have
   * begun one goes and the rest goes out, as does what was held for a `<` that began no block; then everything pending.
   */
  end(): void {
    this.settle();
    if (!this.held) this.release(this.shown.length);
    this.flush();
  }

  /**
   * What was said so far is about to be posted on its own (the reply's acknowledgement, worker.ts): what is pending of it
   * goes out now, as at `end` — so the owner's sockets have it before that message.
   */
  flushNow(): void {
    this.settle();
    if (!this.held) this.release(this.shown.length);
    this.flush();
  }

  /** What was said so far was posted on its own: the reply starts again, its text and reasoning empty, nothing held back. */
  restart(): void {
    this.discard();
    this.text = "";
    this.reasoning = "";
    this.shown = "";
    this.released = 0;
    this.held = false;
    this.carry = { text: "", reasoning: "" };
    this.holds = this.freshHolds();
  }

  /** Drops what is pending (nothing more will be pushed). */
  discard(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = { text: "", reasoning: "" };
  }

  /**
   * What was produced so far, reasoning included, in weight (`estimateTokens`, metering/tokens.ts): what settlement counts as
   * output when the upstream reports no usage.
   */
  outputChars(): number {
    return estimateTokens(this.text) + estimateTokens(this.reasoning);
  }
}
