import { CITES_MAX, WEB_CITES_MAX, type Cite, type MessageRef, type WebSource } from "../../messages/lookups.ts";
import { withoutMarkPlaced } from "../runtime/prompt.ts";
import { CLOSE, fileNumber, INSIDE_MAX, MAX_NUMBER, OPEN, pendingStart, beginsToken, tokenRef } from "./tokens.ts";

export { fileNumber } from "./tokens.ts";

/**
 * The numbers a reply's model is given for what its tools and its context show it (README "Agents and runs", Tools in a
 * reply, Citations): `m1`, `m2`… for messages a search handed it, `f1`, `f2`… for files (every attachment label of a reply
 * offered tools, in the order its context shows them, and every file a search found). Never a conversation id, a seq or
 * an attachment id: the model names a thing only by a number this run gave it, and a number means nothing in any other
 * run. Each is shown plainly, `〔m1〕`, and the model is told to cite by copying one: nothing about them is secret. What a
 * reply offered tools says loses every token-shaped string (`takeCites`), one of a number its run gave kept beside its
 * text as a citation (but a reply of nothing else keeps them as written, citing nothing: conversation.ts `postAsAgent`). A number someone typed is never one of the run's (`plant`): every token-shaped string in what the
 * run is shown that its model did not write — what anyone wrote in its context and system text, a file's text, every
 * tool result — is read for its number as it arrives, numbering skips every number so read (`〔m1〕…〔m8〕` typed: the
 * run's finds start at m9), and one minted before it was read is never cited (`citable`). Numbers go up to the largest a
 * token holds, `MAX_NUMBER` (999999, tokens.ts): past it nothing is minted (`message` and `file` give null, and the
 * thing is shown without one). One per plan of a reply run, in memory, held by the port from `begin` until the run is
 * finished or released (port-impl.ts). A number is minted once per thing, in the order things are first numbered.
 * A run offered the web tool (`web`, lane websearch) numbers the web pages its search hands the model `w1`, `w2`… too
 * (`web`), and `〔w1〕` is a token for it alone (tokens.ts): for every other run it is text, as it always was.
 */
export class RunRefs {
  private readonly messages = new Map<string, string>();
  private readonly files = new Map<string, string>();
  private readonly byFileRef = new Map<string, string>();
  /** What each number names: the message, or for a file the message it is attached to. */
  private readonly targets = new Map<string, { kind: Cite["kind"]; ref: MessageRef }>();
  /** The web pages handed out, in the order they were numbered (a run offered the web tool only). */
  private readonly pages: WebSource[] = [];
  private readonly pageNumbers = new Set<string>();
  /** Every number someone typed, token-shaped, in what the run was shown (`plant`): never one of the run's. */
  private readonly planted = new Set<string>();
  /** The last number minted of each kind: the next is the first after it nobody typed. */
  private readonly last: { m: number; f: number; w: number };

  /**
   * `start`: the last number already given of each kind (none: 0), so a test can number near the ceiling. `webOffered`:
   * the run was offered the web tool (port-impl.ts `begin`).
   */
  constructor(
    start: Partial<Record<"m" | "f" | "w", number>> = {},
    readonly webOffered = false,
  ) {
    this.last = { m: start.m ?? 0, f: start.f ?? 0, w: start.w ?? 0 };
  }

  /**
   * Reads `text` (what the run is shown that its model did not write) for numbers someone typed (`tokensIn`): as written,
   * and NFKC-normalised as a whole — so a look-alike bracket (`﹝m1﹞`) a model might write back as the real one is planted
   * too. Planting more than was typed only skips a number.
   */
  plant(text: string): void {
    const normalised = text.normalize("NFKC");
    for (const ref of tokensIn(text, this.webOffered)) this.planted.add(ref);
    if (normalised !== text) for (const ref of tokensIn(normalised, this.webOffered)) this.planted.add(ref);
  }

  /** Whether `ref` (`m1`, as a token holds it) can become a citation: a number the run gave, and nobody typed. */
  citable(ref: string): boolean {
    return (this.targets.has(ref) || this.pageNumbers.has(ref)) && !this.planted.has(ref);
  }

  /**
   * The token of a web page the run's search hands the model (`〔w1〕`), the next `w` nobody typed; null for a run not
   * offered the web tool, or past `MAX_NUMBER`. Each call is a page of its own (a search's results are handed once).
   */
  web(page: { url: string; title: string }): string | null {
    if (!this.webOffered) return null;
    const ref = this.mint("w");
    if (ref === null) return null;
    this.pages.push({ n: Number(ref.slice(1)), url: page.url, title: page.title });
    this.pageNumbers.add(ref);
    return this.token(ref);
  }

  /** Every web page the run handed out, in order, with its number: what its reply keeps as `webSources`, cited or not. */
  webSources(): WebSource[] {
    return this.pages.map((p) => ({ ...p }));
  }

  /** The next number of `kind` nobody typed, or null past `MAX_NUMBER` (none is minted any more). */
  private mint(kind: "m" | "f" | "w"): string | null {
    let n = this.last[kind] + 1;
    while (n <= MAX_NUMBER && this.planted.has(`${kind}${n}`)) n++;
    if (n > MAX_NUMBER) return null;
    this.last[kind] = n;
    return `${kind}${n}`;
  }

  /** `number` (`m1`, `f2`) as the model is shown it: `〔m1〕`. */
  token(number: string): string {
    return `${OPEN}${number}${CLOSE}`;
  }

  /** The token of message `seq` of `conversationId`: the number it was given, or the next `m` (null: none is left). */
  message(conversationId: string, seq: number): string | null {
    const key = `${conversationId}|${seq}`;
    let ref = this.messages.get(key) ?? null;
    if (ref === null) {
      ref = this.mint("m");
      if (ref === null) return null;
      this.messages.set(key, ref);
      this.targets.set(ref, { kind: "m", ref: { conversationId, seq } });
    }
    return this.token(ref);
  }

  /** The token of attachment `attachmentId` of the message `at`: the number it was given, or the next `f` (null: none is left). */
  file(attachmentId: string, at: MessageRef): string | null {
    let ref = this.files.get(attachmentId) ?? null;
    if (ref === null) {
      ref = this.mint("f");
      if (ref === null) return null;
      this.files.set(attachmentId, ref);
      this.byFileRef.set(ref, attachmentId);
      this.targets.set(ref, { kind: "f", ref: { conversationId: at.conversationId, seq: at.seq } });
    }
    return this.token(ref);
  }

  /** The attachment `ref` names, as the file tool may be passed it (`fileNumber`: `f1`, `〔f1〕`, `f01`, `〔ｆ１〕`), or null: one this run never gave. */
  fileOf(ref: string): string | null {
    return this.byFileRef.get(fileNumber(ref)) ?? null;
  }

  /** What the number `ref` (`m1`, `f2`, as a token holds it) names, or null for one this run never gave. */
  target(ref: string): { kind: Cite["kind"]; ref: MessageRef } | null {
    return this.targets.get(ref) ?? null;
  }
}


/**
 * Token-shaped strings taken out of a text as it is read, one UTF-16 unit at a time, in time proportional to the text
 * however it nests (the shape of runtime/prompt.ts `withoutMark`): the text is copied (`out`), keeping where each `〔`
 * that may still open one stands in the copy (`opens`); at a `〕`, what follows the last such `〔` is a token's inside or
 * not — a token is taken out of the copy, so that a `〔` before it may still open one (`〔m〔m2〕1〕` leaves nothing behind);
 * anything else stays, and then no `〔` before it can open one any more (a token holds no bracket). Each token taken out
 * is kept with where it stood (`tokens`); one taken out where an earlier one stood inside it moves that one to where it
 * stood itself (`settled`: a later token at a smaller place always held the earlier ones — the copy is only ever cut back
 * at a `〔`). `web`: a run offered the web tool, whose `〔w1〕` is a token too (tokens.ts).
 */
class TokenScanner {
  readonly out: string[] = [];
  /** Where each character of `out` stood in what was pushed (its UTF-16 offset), in order. */
  readonly origin: number[] = [];
  readonly opens: number[] = [];
  readonly tokens: Array<{ at: number; ref: string }> = [];
  private pushed = 0;

  constructor(readonly web = false) {}

  push(c: string): void {
    const { out, origin, opens } = this;
    const from = this.pushed++;
    if (c === OPEN) {
      opens.push(out.length);
      out.push(c);
      origin.push(from);
    } else if (c === CLOSE && opens.length > 0) {
      const at = opens[opens.length - 1]!;
      const ref = out.length - at - 1 <= INSIDE_MAX ? tokenRef(out.slice(at + 1).join(""), this.web) : null;
      if (ref !== null) {
        out.length = at;
        origin.length = at;
        opens.pop();
        this.tokens.push({ at, ref });
      } else {
        opens.length = 0;
        out.push(c);
        origin.push(from);
      }
    } else {
      out.push(c);
      origin.push(from);
    }
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
    return pendingStart(this.out, this.opens, from, this.web);
  }

  /** Whether the copy's last open `〔` still begins a token. */
  lastBegins(): boolean {
    const at = this.opens.at(-1);
    return at !== undefined && this.out.length - at <= INSIDE_MAX + 1 && beginsToken(this.out.slice(at).join(""), this.web);
  }
}

/** A citation as a reply's text carries it: of a message or a file (`Cite`), or of a web page its run handed out (`w`, its number). */
export type PlacedCite = Cite | { at: number; kind: "w"; n: number };

/** A text and its citations' places in it: what a reply's text is carried as through what cuts it (agents/conversation.ts). */
export interface Placed {
  text: string;
  cites: PlacedCite[];
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

/**
 * `p` without a group's `mark` (runtime/prompt.ts `withoutMarkPlaced`; `cut`: also what a cut left of it) and, with
 * `tokens` (a reply offered tools), without every token-shaped string, in the same one pass — so that neither taking out
 * puts the other together (N-2, N-4) — its cites moved onto what is left. A token taken out here cites nothing.
 */
export function withoutMarkFrom(p: Placed, mark: string, cut = false, tokens = false, web = false): Placed {
  const done = withoutMarkPlaced(p.text, mark, p.cites.map((c) => c.at), cut, tokens, web);
  return replaced(p, done.text, done.places);
}

/** Every token-shaped string's number in `text` (`m1`, as `TokenScanner` reads it, however they nest), in one pass. */
function tokensIn(text: string, web = false): string[] {
  if (!text.includes(OPEN)) return [];
  const scanner = new TokenScanner(web);
  for (let i = 0; i < text.length; i++) scanner.push(text[i]!);
  return scanner.tokens.map((t) => t.ref);
}

/** Where a space before a removed token goes with it: before another space, a punctuation mark, or the end. */
const LOOSE_AFTER = /[\s\p{P}]/u;

/**
 * `text` without any token-shaped string and without what may have begun one at its very end, a loose space before a
 * removed one taken with it (`takeCites`): what is left, each token's number with where it stood in it, and `places`
 * (ascending UTF-16 offsets in `text`) moved onto it — a place inside what goes is where it went.
 */
function stripped(text: string, places: readonly number[], web = false): { text: string; tokens: Array<{ at: number; ref: string }>; places: number[] } {
  const scanner = new TokenScanner(web);
  for (let i = 0; i < text.length; i++) scanner.push(text[i]!);
  const end = scanner.pendingFrom();
  const copy = scanner.out.slice(0, end).join("");
  const tokens = scanner.settled().map((t) => ({ ...t, at: Math.min(t.at, end) }));
  // A place goes to how many kept characters stood before it (the kept ones stand in order).
  const origin = scanner.origin;
  let k = 0;
  const moved = places.map((p) => {
    while (k < end && origin[k]! < p) k++;
    return k;
  });
  // A space left before a removed one, with another space, a punctuation mark or the end after it, goes with it.
  const loose = new Set<number>();
  for (const { at } of tokens) if (at > 0 && copy[at - 1] === " " && (at === copy.length || LOOSE_AFTER.test(copy[at]!))) loose.add(at - 1);
  let out = "";
  const shift: number[] = [];
  for (let i = 0; i <= copy.length; i++) {
    shift.push(out.length);
    if (i < copy.length && !loose.has(i)) out += copy[i];
  }
  return { text: out, tokens: tokens.map((t) => ({ ...t, at: shift[t.at]! })), places: moved.map((p) => shift[p]!) };
}

/**
 * What a reply offered tools says, as it is stored (design rule 4; README "Agents and runs", Citations;
 * agents/conversation.ts `postAsAgent`, the first thing done to its text, its reasoning and its search words): without
 * any token-shaped string (`TokenScanner`: `〔`, `m` or `f` in either case, one to six digits, `〕`, spaces around them;
 * however they nest) and without what may have begun one at its very end (it ended there: `pendingFrom`), a space left
 * before a removed one and another space, a punctuation mark or the end taken with it, and trimmed. What goes does not
 * depend on what the run handed out, so the text is the same whatever it found. With `cite` (the default) each one of
 * a number the run gave becomes a cite where it stood in the text that is left (`at`, UTF-16 code units, ascending):
 * what it names (a message, or the message a file is in), when `keep` lets the reply point at it, the first `CITES_MAX`
 * only. One of a number the run never gave, or one someone typed in what the run was shown (`RunRefs.citable`), past
 * those, or one `keep` refuses, goes all the same and cites nothing; so does every one of an acknowledgement, a reasoning
 * and a search word (`cite` false). A run offered the web tool (`refs.webOffered`) reads `〔w1〕` too: one of a page it
 * handed out becomes a web cite (`{at, kind: "w", n}`), the first `WEB_CITES_MAX` of those, counted apart.
 */
export function takeCites(text: string, refs: RunRefs, { cite = true, keep = () => true }: { cite?: boolean; keep?: (r: MessageRef) => boolean } = {}): Placed {
  const done = stripped(text, [], refs.webOffered);
  const cites: PlacedCite[] = [];
  let kept = 0;
  let pages = 0;
  for (const t of done.tokens) {
    if (!cite) break;
    if (!refs.citable(t.ref)) continue;
    if (t.ref.startsWith("w")) {
      if (pages >= WEB_CITES_MAX) continue;
      pages++;
      cites.push({ at: t.at, kind: "w", n: Number(t.ref.slice(1)) });
      continue;
    }
    const target = refs.target(t.ref);
    if (kept >= CITES_MAX || target === null || !keep(target.ref)) continue;
    kept++;
    cites.push({ at: t.at, kind: target.kind, ref: target.ref });
  }
  return trimPlaced({ text: done.text, cites });
}

/**
 * A reply's text or reasoning as it streams (runtime/stream.ts), a reply offered tools: each piece goes through the same
 * `TokenScanner` as the stored text, so no token-shaped string is pushed, and what may still become one — from the first
 * `〔` still open while the last one still begins one, however deep they nest — is held until the next piece says. Nothing
 * is secret: this keeps the stream as the stored text will be. `end`: nothing more comes — what may have begun one goes
 * with the reply (`pendingFrom`, as the stored text loses it), the rest of what was held goes out.
 */
export class TokenHold {
  private scanner: TokenScanner;
  /** How much of the scanner's copy has gone out. */
  private released = 0;

  /** `web`: a run offered the web tool, whose `〔w1〕` is held and taken out too. */
  constructor(private readonly web = false) {
    this.scanner = new TokenScanner(web);
  }

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
    this.scanner = new TokenScanner(this.web);
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
