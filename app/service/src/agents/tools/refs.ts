import { randomInt } from "node:crypto";
import { CITES_MAX, type Cite, type MessageRef } from "../../messages/lookups.ts";
import { withoutSecretsPlaced } from "../runtime/prompt.ts";

/**
 * The numbers a reply's model is given for what its tools and its context show it (README "Agents and runs", Tools in a
 * reply, Citations): `m1`, `m2`… for messages a search handed it, `f1`, `f2`… for files (every attachment label of a reply
 * offered tools, and every file a search found). Never a conversation id, a seq or an attachment id: the model names a
 * thing only by a number this run gave it, and a number means nothing in any other run. Each is shown written as a token
 * carrying the run's tag, `〔m1·k7q2m9x4〕` (`tag`: drawn for the run, `drawTag`, and drawn again while it occurs in
 * anything the model is shown, port-impl.ts `begin`; never stored, pushed or shown to anyone), and the model is told to
 * cite by copying a token whole: only a token carrying this run's tag can become a citation of the reply (`takeCites`) —
 * whatever else looks like one (`〔m1〕`, another run's `〔m1·zzzzzzzz〕`) is text someone wrote. One per plan of a reply
 * run, in memory, held by the port from `begin` until the run is finished or released (port-impl.ts). A number is minted
 * once per thing, in the order things are first shown.
 */
export class RunRefs {
  private readonly messages = new Map<string, string>();
  private readonly files = new Map<string, string>();
  private readonly byFileRef = new Map<string, string>();
  /** What each number names: the message, or for a file the message it is attached to. */
  private readonly targets = new Map<string, { kind: Cite["kind"]; ref: MessageRef }>();

  constructor(readonly tag: string = drawTag()) {
    if (!TAG_SHAPE.test(tag)) throw new Error("a run's tag is at least eight letters and digits");
  }

  /** `number` (`m1`, `f2`) as the model is shown it: the token carrying this run's tag, `〔m1·k7q2m9x4〕`. */
  token(number: string): string {
    return `${OPEN}${number}${SEPARATOR}${this.tag}${CLOSE}`;
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

  /**
   * The attachment `ref` names, as the file tool may be passed it (`fileNumber`: the number alone or the run's token,
   * however copied), or null: a number this run never gave, or a token of another run's tag.
   */
  fileOf(ref: string): string | null {
    return this.byFileRef.get(fileNumber(ref, this.tag)) ?? null;
  }

  /** What the number `ref` (`m1`, `f2`, as a token holds it) names, or null for one this run never gave. */
  target(ref: string): { kind: Cite["kind"]; ref: MessageRef } | null {
    return this.targets.get(ref) ?? null;
  }
}

/** A token's brackets, what stands between its number and its tag, and what a copy may write there instead. */
const OPEN = "〔";
const CLOSE = "〕";
const SEPARATOR = "·";
const SEPARATORS = "·・•";

/** The characters a run's tag is made of, and how many it has. */
const TAG_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
export const TAG_LENGTH = 8;
const TAG_SHAPE = /^[a-z0-9]{8,16}$/;

/** A run's tag (`RunRefs.tag`): `TAG_LENGTH` characters of `TAG_CHARACTERS`, each drawn by `crypto`. */
export const drawTag = (): string => Array.from({ length: TAG_LENGTH }, () => TAG_CHARACTERS.charAt(randomInt(TAG_CHARACTERS.length))).join("");

/**
 * A file number as the file tool may be passed it, made one form (so that one file is one call, runtime/loop.ts): its
 * spaces gone, lower case, without its brackets and without `tag` after a separator — `f1`, `〔f1·k7q2m9x4〕`,
 * `〔 F1 · K7Q2M9X4 〕` and `f1・k7q2m9x4` are `f1`. Anything else (another run's tag) is left as it is, and names nothing.
 */
export function fileNumber(ref: string, tag: string): string {
  let s = ref.replace(/\s+/g, "").toLowerCase();
  if (s.startsWith(OPEN)) s = s.slice(OPEN.length);
  if (s.endsWith(CLOSE)) s = s.slice(0, -CLOSE.length);
  const parts = s.split(new RegExp(`[${SEPARATORS}]`));
  return parts.length === 2 && parts[1] === tag ? parts[0]! : s;
}

/** The longest inside a token may have: a letter, six digits, a separator, the tag, and spaces between them. */
const INSIDE_MAX = 64;

/**
 * What a token of `tag` holds between its brackets, as a model may copy it: `m` or `f`, a number of one to six digits
 * (any, `m0` too), a separator (`·`, or the look-alikes `・` `•`), the tag — spaces around each, letters in any case.
 */
const insideOf = (tag: string): RegExp => new RegExp(`^\\s*([mf])\\s*([0-9]{1,6})\\s*[${SEPARATORS}]\\s*${tag}\\s*$`, "i");

/**
 * How a token begins — `〔`, `〔m`, `〔m1`, `〔m1·`, `〔m1·k7`… up to its whole inside, spaces and case as `insideOf`
 * allows them — with what is typed of a tag (`beginsToken` holds that to the run's).
 */
const BEGINNING = new RegExp(`^〔\\s*(?:[mf]\\s*(?:[0-9]{1,6}\\s*(?:[${SEPARATORS}]\\s*([a-z0-9]*)(\\s*))?)?)?$`, "i");

/** Whether `s` (from a `〔`, no `〕` after it) is how a token of `tag` begins (`BEGINNING`, the tag's first letters at most). */
function beginsToken(s: string, tag: string): boolean {
  if (s.length > INSIDE_MAX + 1) return false;
  const m = BEGINNING.exec(s);
  if (m === null || m[1] === undefined) return m !== null;
  const typed = m[1].toLowerCase();
  return m[2] === "" ? tag.startsWith(typed) : typed === tag;
}

/**
 * Tokens of a tag taken out of a text as it is read, one UTF-16 unit at a time, in time proportional to the text however
 * it nests (the shape of runtime/prompt.ts `withoutMark`): the text is copied (`out`), keeping where each `〔` that may
 * still open a token stands in the copy (`opens`); at a `〕`, what follows the last such `〔` is a token's inside or not —
 * a token is taken out of the copy, so that a `〔` before it may still open one (`〔m1·〔m2·…〕…〕` leaves nothing behind);
 * anything else stays, and then no `〔` before it can open one any more (a token holds no bracket). Each token taken out
 * is kept with where it stood (`tokens`); one taken out where an earlier one stood inside it moves that one to where it
 * stood itself (`settled`: a later token at a smaller place always held the earlier ones — the copy is only ever cut back
 * at a `〔`).
 */
class TokenScanner {
  readonly out: string[] = [];
  readonly opens: number[] = [];
  readonly tokens: Array<{ at: number; ref: string }> = [];
  private readonly inside: RegExp;

  constructor(readonly tag: string) {
    this.inside = insideOf(tag);
  }

  push(c: string): void {
    const { out, opens } = this;
    if (c === OPEN) {
      opens.push(out.length);
      out.push(c);
    } else if (c === CLOSE && opens.length > 0) {
      const at = opens[opens.length - 1]!;
      const m = out.length - at - 1 <= INSIDE_MAX ? this.inside.exec(out.slice(at + 1).join("")) : null;
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
   * `〔` still open from which each piece up to the next open one, and the last to the end, begins a token — a token inside
   * another goes once it closes, so the outer one may still close after it.
   */
  pendingFrom(from = 0): number {
    const { out, opens } = this;
    let at = out.length;
    for (let k = opens.length - 1; k >= 0 && opens[k]! >= from; k--) {
      const end = k === opens.length - 1 ? out.length : opens[k + 1]!;
      if (!beginsToken(out.slice(opens[k]!, end).join(""), this.tag)) break;
      at = opens[k]!;
    }
    return at;
  }

  /** Whether the copy's last open `〔` still begins a token (checked on at most `INSIDE_MAX` characters). */
  lastBegins(): boolean {
    const at = this.opens.at(-1);
    return at !== undefined && this.out.length - at <= INSIDE_MAX + 1 && beginsToken(this.out.slice(at).join(""), this.tag);
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

/** `p` without the run's secrets (runtime/prompt.ts `withoutSecretsPlaced`), its cites moved onto what is left. */
export function withoutSecretsFrom(p: Placed, mark: string | null, tag: string | null, cut = false): Placed {
  const done = withoutSecretsPlaced(p.text, mark, tag, p.cites.map((c) => c.at), cut);
  return replaced(p, done.text, done.places);
}

/** Where a space before a removed token goes with it: before another space, a punctuation mark, or the end. */
const LOOSE_AFTER = /[\s\p{P}]/u;

/**
 * What a reply offered tools says, as it is stored (design rule 4; README "Agents and runs", Citations;
 * agents/conversation.ts `postAsAgent`, the first thing done to its text, its reasoning and its search words): without any
 * token of the run `refs` numbers for (`TokenScanner`: copied exactly, or with spaces, another case or a look-alike
 * separator), without what may have begun one at its very end (it ended there: `pendingFrom`), then without any other
 * occurrence of the run's tag (runtime/prompt.ts `withoutSecretsPlaced`: in any case, also one put together by taking
 * another out), a space left before a removed token and another space, a punctuation mark or the end taken with it, and
 * trimmed. With `cite` (the default) each token of a number the run gave becomes a cite where it stood in the text that
 * is left (`at`, UTF-16 code units, ascending): what it names (a message, or the message a file is in), when `keep` lets
 * the reply point at it, the first `CITES_MAX` only. A token of a number the run never gave, past those, or one `keep`
 * refuses, is taken out all the same and cites nothing; so is every token of an acknowledgement, a reasoning and a search
 * word (`cite` false). Anything else is left as written: a `〔m1〕` with no tag, or with another run's, is text someone
 * wrote.
 */
export function takeCites(text: string, refs: RunRefs, { cite = true, keep = () => true }: { cite?: boolean; keep?: (r: MessageRef) => boolean } = {}): Placed {
  const scanner = new TokenScanner(refs.tag);
  for (let i = 0; i < text.length; i++) scanner.push(text[i]!);
  const end = scanner.pendingFrom();
  const copy = scanner.out.slice(0, end).join("");
  const tokens = scanner.settled().map((t) => ({ ...t, at: Math.min(t.at, end) }));
  // Every token's place, then the tag's other occurrences out, every place moved with them.
  const free = withoutSecretsPlaced(copy, null, refs.tag, tokens.map((t) => t.at));
  // A space left before a removed token, with another space, a punctuation mark or the end after it, goes with it.
  const loose = new Set<number>();
  for (const at of free.places) if (at > 0 && free.text[at - 1] === " " && (at === free.text.length || LOOSE_AFTER.test(free.text[at]!))) loose.add(at - 1);
  let out = "";
  const shift: number[] = [];
  for (let i = 0; i <= free.text.length; i++) {
    shift.push(out.length);
    if (i < free.text.length && !loose.has(i)) out += free.text[i];
  }
  const cites: Cite[] = [];
  tokens.forEach((t, i) => {
    if (!cite || cites.length >= CITES_MAX) return;
    const target = refs.target(t.ref);
    if (target === null || !keep(target.ref)) return;
    cites.push({ at: shift[free.places[i]!]!, kind: target.kind, ref: target.ref });
  });
  return trimPlaced({ text: out, cites });
}

/**
 * A reply's text or reasoning as it streams (runtime/stream.ts), without any token of its run's `tag` or the tag itself:
 * each piece goes through the same `TokenScanner` as the stored text, and what may still become a token — from the first
 * `〔` still open while the last one still begins a token, however deep they nest — is held until the next piece says.
 * What is copied then loses every occurrence of the tag as the stored text does (runtime/prompt.ts `withoutSecrets`: in
 * any case, also one put together by taking out a token or another tag), one character at a time; since taking one out
 * can join what stood before it to what comes after, the run of the tag's letters at the end of what is left waits too,
 * and goes out once something else follows it. So no push, nor pushes put together, ever shows the tag. `end`: nothing
 * more comes — what may have begun a token goes with the reply (`pendingFrom`, as the stored text loses it), the rest of
 * what was held goes out.
 */
export class TokenHold {
  private scanner: TokenScanner;
  /** How much of the scanner's copy has been read on, past what can still become a token. */
  private released = 0;
  /** The copy as read on, without the tag; from `shownTo` on, not yet out. */
  private kept: string[] = [];
  private shownTo = 0;
  /** How long the run of the tag's letters is at the end of `kept` (all of it after `shownTo`). */
  private run = 0;
  private readonly wanted: string[];
  private readonly letters: Set<string>;

  constructor(private readonly tag: string) {
    this.scanner = new TokenScanner(tag);
    this.wanted = Array.from(tag.toLowerCase());
    this.letters = new Set(this.wanted);
  }

  push(piece: string): string {
    for (let i = 0; i < piece.length; i++) this.scanner.push(piece[i]!);
    const { out, opens } = this.scanner;
    let until = out.length;
    if (this.scanner.lastBegins()) {
      // From the first open `〔` not yet read on (opens are in order; those before `released` can no longer close as tokens).
      let [low, high] = [0, opens.length - 1];
      while (low < high) {
        const mid = (low + high) >> 1;
        if (opens[mid]! >= this.released) high = mid;
        else low = mid + 1;
      }
      until = Math.max(this.released, opens[low]!);
    }
    this.readOn(until);
    return this.show(this.kept.length - this.run);
  }

  /** Nothing more comes of this text: what may have begun a token goes, the rest goes out, and a text after it starts afresh. */
  end(): string {
    this.readOn(this.scanner.pendingFrom(this.released));
    const shown = this.show(this.kept.length);
    this.scanner = new TokenScanner(this.tag);
    this.released = 0;
    this.kept = [];
    this.shownTo = 0;
    this.run = 0;
    return shown;
  }

  /** The copy up to `until` joins `kept`, each character in turn, the tag taken out as soon as it ends there. */
  private readOn(until: number): void {
    const out = this.scanner.out;
    const size = this.wanted.length;
    const last = this.wanted[size - 1];
    for (let i = this.released; i < until; i++) {
      const c = out[i]!;
      const lower = c.toLowerCase();
      this.kept.push(c);
      this.run = this.letters.has(lower) ? this.run + 1 : 0;
      // (A tag is made of its letters only, so one that ends here lies within the run, none of it out yet.)
      const n = this.kept.length;
      if (lower === last && this.run >= size && this.wanted.every((w, j) => this.kept[n - size + j]!.toLowerCase() === w)) {
        this.kept.length = n - size;
        this.run -= size;
      }
    }
    this.released = Math.max(this.released, until);
  }

  /** What is kept up to `to` goes out. */
  private show(to: number): string {
    if (to <= this.shownTo) return "";
    const shown = this.kept.slice(this.shownTo, to).join("");
    this.shownTo = to;
    if (this.shownTo > 4096 && this.shownTo * 2 > this.kept.length) {
      this.kept = this.kept.slice(this.shownTo);
      this.shownTo = 0;
    }
    return shown;
  }
}
