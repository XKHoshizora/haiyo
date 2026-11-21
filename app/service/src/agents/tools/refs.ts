import { CITES_MAX, type Cite, type MessageRef } from "../../messages/lookups.ts";
import { withoutMarkPlaced } from "../runtime/prompt.ts";

/**
 * The numbers a reply's model is given for what its tools and its context show it (README "Agents and runs", Tools in a
 * reply, Citations): `m1`, `m2`… for messages a search handed it, `f1`, `f2`… for files (every attachment label of a reply
 * offered tools, in the order its context shows them, and every file a search found). Never a conversation id, a seq or
 * an attachment id: the model names a thing only by a number this run gave it, and a number means nothing in any other
 * run. Each is shown plainly, `〔m1〕`, and the model is told to cite by copying one: nothing about them is secret. What a
 * reply offered tools says loses every token-shaped string (`takeCites`), one of a number its run gave kept beside its
 * text as a citation. One per plan of a reply run, in memory, held by the port from `begin` until the run is finished or
 * released (port-impl.ts). A number is minted once per thing, in the order things are first numbered.
 */
export class RunRefs {
  private readonly messages = new Map<string, string>();
  private readonly files = new Map<string, string>();
  private readonly byFileRef = new Map<string, string>();
  /** What each number names: the message, or for a file the message it is attached to. */
  private readonly targets = new Map<string, { kind: Cite["kind"]; ref: MessageRef }>();

  /** `number` (`m1`, `f2`) as the model is shown it: `〔m1〕`. */
  token(number: string): string {
    return `${OPEN}${number}${CLOSE}`;
  }

  /** The token of message `seq` of `conversationId`: the number it was given, or the next `m`. */
  message(conversationId: string, seq: number): string {
    const key = `${conversationId}|${seq}`;
    let ref = this.messages.get(key);
    if (ref === undefined) {
      ref = `m${this.messages.size + 1}`;
      this.messages.set(key, ref);
      this.targets.set(ref, { kind: "m", ref: { conversationId, seq } });
    }
    return this.token(ref);
  }

  /** The token of attachment `attachmentId` of the message `at`: the number it was given, or the next `f`. */
  file(attachmentId: string, at: MessageRef): string {
    let ref = this.files.get(attachmentId);
    if (ref === undefined) {
      ref = `f${this.files.size + 1}`;
      this.files.set(attachmentId, ref);
      this.byFileRef.set(ref, attachmentId);
      this.targets.set(ref, { kind: "f", ref: { conversationId: at.conversationId, seq: at.seq } });
    }
    return this.token(ref);
  }

  /** The attachment `ref` names, as the file tool may be passed it (`fileNumber`: `f1` or `〔f1〕`), or null: one this run never gave. */
  fileOf(ref: string): string | null {
    return this.byFileRef.get(fileNumber(ref)) ?? null;
  }

  /** What the number `ref` (`m1`, `f2`, as a token holds it) names, or null for one this run never gave. */
  target(ref: string): { kind: Cite["kind"]; ref: MessageRef } | null {
    return this.targets.get(ref) ?? null;
  }
}

/** A token's brackets. */
const OPEN = "〔";
const CLOSE = "〕";

/**
 * A file number as the file tool may be passed it, made one form (so that one file is one call, runtime/loop.ts): its
 * spaces gone, lower case, without its brackets — `f1`, `〔f1〕` and `〔 F1 〕` are `f1`. Anything else is left as it is.
 */
export function fileNumber(ref: string): string {
  let s = ref.replace(/\s+/g, "").toLowerCase();
  if (s.startsWith(OPEN) && s.endsWith(CLOSE)) s = s.slice(OPEN.length, -CLOSE.length);
  return s;
}

/** The longest inside a token-shaped string may have: a letter, six digits, and spaces around them. */
const INSIDE_MAX = 16;

/** What a token-shaped string holds between its brackets: `m` or `f` in either case, one to six digits, spaces around each. */
const INSIDE = /^\s*([mf])\s*([0-9]{1,6})\s*$/i;

/** How one begins — `〔`, `〔m`, `〔m1`, spaces and case as `INSIDE` allows them. */
const BEGINNING = /^〔\s*(?:[mf]\s*(?:[0-9]{1,6}\s*)?)?$/i;

/** Whether `s` (from a `〔`, no `〕` after it) is how a token-shaped string begins (checked on at most `INSIDE_MAX` characters). */
const beginsToken = (s: string): boolean => s.length <= INSIDE_MAX + 1 && BEGINNING.test(s);

/**
 * Token-shaped strings taken out of a text as it is read, one UTF-16 unit at a time, in time proportional to the text
 * however it nests (the shape of runtime/prompt.ts `withoutMark`): the text is copied (`out`), keeping where each `〔`
 * that may still open one stands in the copy (`opens`); at a `〕`, what follows the last such `〔` is a token's inside or
 * not — a token is taken out of the copy, so that a `〔` before it may still open one (`〔m〔m2〕1〕` leaves nothing behind);
 * anything else stays, and then no `〔` before it can open one any more (a token holds no bracket). Each token taken out
 * is kept with where it stood (`tokens`); one taken out where an earlier one stood inside it moves that one to where it
 * stood itself (`settled`: a later token at a smaller place always held the earlier ones — the copy is only ever cut back
 * at a `〔`).
 */
class TokenScanner {
  readonly out: string[] = [];
  readonly opens: number[] = [];
  readonly tokens: Array<{ at: number; ref: string }> = [];

  push(c: string): void {
    const { out, opens } = this;
    if (c === OPEN) {
      opens.push(out.length);
      out.push(c);
    } else if (c === CLOSE && opens.length > 0) {
      const at = opens[opens.length - 1]!;
      const m = out.length - at - 1 <= INSIDE_MAX ? INSIDE.exec(out.slice(at + 1).join("")) : null;
      if (m) {
        out.length = at;
        opens.pop();
        this.tokens.push({ at, ref: `${m[1]!.toLowerCase()}${m[2]}` });
      } else {
        opens.length = 0;
        out.push(c);
      }
    } else out.push(c);
  }

  /** The tokens with their final places (see above). */
  settled(): Array<{ at: number; ref: string }> {
    const tokens = this.tokens;
    for (let k = tokens.length - 2; k >= 0; k--) if (tokens[k]!.at > tokens[k + 1]!.at) tokens[k]!.at = tokens[k + 1]!.at;
    return tokens;
  }

  /**
   * Where the copy's end begins that may still become a token (its length when none may), not before `from`: the earliest
   * `〔` still open from which each piece up to the next open one, and the last to the end, begins one — a token inside
   * another goes once it closes, so the outer one may still close after it.
   */
  pendingFrom(from = 0): number {
    const { out, opens } = this;
    let at = out.length;
    for (let k = opens.length - 1; k >= 0 && opens[k]! >= from; k--) {
      const end = k === opens.length - 1 ? out.length : opens[k + 1]!;
      if (end - opens[k]! > INSIDE_MAX + 1 || !beginsToken(out.slice(opens[k]!, end).join(""))) break;
      at = opens[k]!;
    }
    return at;
  }

  /** Whether the copy's last open `〔` still begins a token. */
  lastBegins(): boolean {
    const at = this.opens.at(-1);
    return at !== undefined && this.out.length - at <= INSIDE_MAX + 1 && beginsToken(this.out.slice(at).join(""));
  }
}

/** A text and its citations' places in it: what a reply's text is carried as through what cuts it (agents/conversation.ts). */
export interface Placed {
  text: string;
  cites: Cite[];
}

/** `p` with `places` (one per cite, in order) as its cites' new places; a cite whose place is null is gone. */
const replaced = (p: Placed, text: string, places: ReadonlyArray<number | null>): Placed => ({
  text,
  cites: p.cites.flatMap((c, i) => (places[i] === null ? [] : [{ ...c, at: places[i]! }])),
});

/** `p` cut at `end`: what follows goes, with every cite past it. */
export const cutPlaced = (p: Placed, end: number): Placed => replaced(p, p.text.slice(0, end), p.cites.map((c) => (c.at > end ? null : c.at)));

/** `p` trimmed, its cites moved with its text (one in what was trimmed at the end, at the end). */
export function trimPlaced(p: Placed): Placed {
  const lead = p.text.length - p.text.trimStart().length;
  const text = p.text.trim();
  return replaced(p, text, p.cites.map((c) => Math.min(Math.max(0, c.at - lead), text.length)));
}

/** `p` without `[start, end)`: a cite inside it goes, one after it moves back. */
export const withoutSpanPlaced = (p: Placed, start: number, end: number): Placed =>
  replaced(
    p,
    p.text.slice(0, start) + p.text.slice(end),
    p.cites.map((c) => (c.at <= start ? c.at : c.at >= end ? c.at - (end - start) : null)),
  );

/** `p` without a group's `mark` (runtime/prompt.ts `withoutMarkPlaced`; `cut`: also what a cut left of it), its cites moved onto what is left. */
export function withoutMarkFrom(p: Placed, mark: string, cut = false): Placed {
  const done = withoutMarkPlaced(p.text, mark, p.cites.map((c) => c.at), cut);
  return replaced(p, done.text, done.places);
}

/** Where a space before a removed token goes with it: before another space, a punctuation mark, or the end. */
const LOOSE_AFTER = /[\s\p{P}]/u;

/**
 * What a reply offered tools says, as it is stored (design rule 4; README "Agents and runs", Citations;
 * agents/conversation.ts `postAsAgent`, the first thing done to its text, its reasoning and its search words): without
 * any token-shaped string (`TokenScanner`: `〔`, `m` or `f` in either case, one to six digits, `〕`, spaces around them;
 * however they nest) and without what may have begun one at its very end (it ended there: `pendingFrom`), a space left
 * before a removed one and another space, a punctuation mark or the end taken with it, and trimmed. What goes does not
 * depend on what the run handed out, so the text is the same whatever it found. With `cite` (the default) each one of
 * a number the run gave becomes a cite where it stood in the text that is left (`at`, UTF-16 code units, ascending):
 * what it names (a message, or the message a file is in), when `keep` lets the reply point at it, the first `CITES_MAX`
 * only. One of a number the run never gave, past those, or one `keep` refuses, goes all the same and cites nothing; so
 * does every one of an acknowledgement, a reasoning and a search word (`cite` false).
 */
export function takeCites(text: string, refs: RunRefs, { cite = true, keep = () => true }: { cite?: boolean; keep?: (r: MessageRef) => boolean } = {}): Placed {
  const scanner = new TokenScanner();
  for (let i = 0; i < text.length; i++) scanner.push(text[i]!);
  const end = scanner.pendingFrom();
  const copy = scanner.out.slice(0, end).join("");
  const tokens = scanner.settled().map((t) => ({ ...t, at: Math.min(t.at, end) }));
  // A space left before a removed one, with another space, a punctuation mark or the end after it, goes with it.
  const loose = new Set<number>();
  for (const { at } of tokens) if (at > 0 && copy[at - 1] === " " && (at === copy.length || LOOSE_AFTER.test(copy[at]!))) loose.add(at - 1);
  let out = "";
  const shift: number[] = [];
  for (let i = 0; i <= copy.length; i++) {
    shift.push(out.length);
    if (i < copy.length && !loose.has(i)) out += copy[i];
  }
  const cites: Cite[] = [];
  for (const t of tokens) {
    if (!cite || cites.length >= CITES_MAX) break;
    const target = refs.target(t.ref);
    if (target === null || !keep(target.ref)) continue;
    cites.push({ at: shift[t.at]!, kind: target.kind, ref: target.ref });
  }
  return trimPlaced({ text: out, cites });
}

/**
 * A reply's text or reasoning as it streams (runtime/stream.ts), a reply offered tools: each piece goes through the same
 * `TokenScanner` as the stored text, so no token-shaped string is pushed, and what may still become one — from the first
 * `〔` still open while the last one still begins one, however deep they nest — is held until the next piece says. Nothing
 * is secret: this keeps the stream as the stored text will be. `end`: nothing more comes — what may have begun one goes
 * with the reply (`pendingFrom`, as the stored text loses it), the rest of what was held goes out.
 */
export class TokenHold {
  private scanner = new TokenScanner();
  /** How much of the scanner's copy has gone out. */
  private released = 0;

  push(piece: string): string {
    for (let i = 0; i < piece.length; i++) this.scanner.push(piece[i]!);
    const { out, opens } = this.scanner;
    let until = out.length;
    if (this.scanner.lastBegins()) {
      // From the first open `〔` not yet out (opens are in order; those before `released` can no longer close as tokens).
      let [low, high] = [0, opens.length - 1];
      while (low < high) {
        const mid = (low + high) >> 1;
        if (opens[mid]! >= this.released) high = mid;
        else low = mid + 1;
      }
      until = Math.max(this.released, opens[low]!);
    }
    return this.release(until);
  }

  /** Nothing more comes of this text: what may have begun a token goes, the rest goes out, and a text after it starts afresh. */
  end(): string {
    const shown = this.release(this.scanner.pendingFrom(this.released));
    this.scanner = new TokenScanner();
    this.released = 0;
    return shown;
  }

  /** What is copied up to `until` goes out. */
  private release(until: number): string {
    if (until <= this.released) return "";
    const piece = this.scanner.out.slice(this.released, until).join("");
    this.released = until;
    return piece;
  }
}
