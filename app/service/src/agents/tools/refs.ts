import { randomInt } from "node:crypto";
import { CITES_MAX, type Cite, type MessageRef } from "../../messages/lookups.ts";

/**
 * The numbers a reply's model is given for what its tools and its context show it (README "Agents and runs", Tools in a
 * reply, Citations): `m1`, `m2`… for messages a search handed it, `f1`, `f2`… for files (every attachment label of a reply
 * offered tools, and every file a search found). Never a conversation id, a seq or an attachment id: the model names a
 * thing only by a number this run gave it, and a number means nothing in any other run. Each is shown written as a token
 * carrying the run's tag, `〔m1·k7q2〕` (`tag`: drawn for the run, `drawTag`; never stored, pushed or shown to anyone), and
 * the model is told to cite by copying a token whole: only a token carrying this run's tag can become a citation of the
 * reply (`takeCites`) — whatever else looks like one (`〔m1〕`, another run's `〔m1·zzzz〕`) is text someone wrote. One per
 * reply run, in memory, held by the port from `begin` until the run is finished or released (port-impl.ts). A number is
 * minted once per thing, in the order things are first shown.
 */
export class RunRefs {
  private readonly messages = new Map<string, string>();
  private readonly files = new Map<string, string>();
  private readonly byFileRef = new Map<string, string>();
  /** What each number names: the message, or for a file the message it is attached to. */
  private readonly targets = new Map<string, { kind: Cite["kind"]; ref: MessageRef }>();

  constructor(readonly tag: string = drawTag()) {
    if (!TAG_SHAPE.test(tag)) throw new Error("a run's tag is letters and digits");
  }

  /** `number` (`m1`, `f2`) as the model is shown it: the token carrying this run's tag, `〔m1·k7q2〕`. */
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
   * The attachment `ref` names, as the file tool may be passed it — the number alone (`f1`) or the run's whole token
   * (`〔f1·k7q2〕`, or without its brackets), spaces in it and its case not mattering — or null: a number this run never gave,
   * or a token of another run's tag.
   */
  fileOf(ref: string): string | null {
    let s = ref.replace(/\s+/g, "").toLowerCase();
    if (s.startsWith(OPEN)) s = s.slice(OPEN.length);
    if (s.endsWith(CLOSE)) s = s.slice(0, -CLOSE.length);
    const [number = "", tag, ...rest] = s.split(SEPARATOR);
    if (rest.length > 0 || (tag !== undefined && tag !== this.tag)) return null;
    return this.byFileRef.get(number) ?? null;
  }

  /** What the number `ref` (`m1`, `f2`, as a token holds it) names, or null for one this run never gave. */
  target(ref: string): { kind: Cite["kind"]; ref: MessageRef } | null {
    return this.targets.get(ref) ?? null;
  }
}

/** A token's brackets, and what stands between its number and its tag. */
const OPEN = "〔";
const CLOSE = "〕";
const SEPARATOR = "·";

/** The characters a run's tag is made of, and how many it has. */
const TAG_CHARACTERS = "abcdefghijklmnopqrstuvwxyz0123456789";
export const TAG_LENGTH = 4;
const TAG_SHAPE = /^[a-z0-9]{1,8}$/;

/** A run's tag (`RunRefs.tag`): `TAG_LENGTH` characters of `TAG_CHARACTERS`, each drawn by `crypto`. */
export const drawTag = (): string => Array.from({ length: TAG_LENGTH }, () => TAG_CHARACTERS.charAt(randomInt(TAG_CHARACTERS.length))).join("");

/** The longest inside of a token: a letter, six digits, the separator, the tag. */
const insideMax = (tag: string): number => 1 + 6 + SEPARATOR.length + tag.length;

/** What a token of `tag` holds between its brackets: `m` or `f`, a number of one to six digits (any, `m0` too), the tag. */
const insideOf = (tag: string): RegExp => new RegExp(`^([mf])([0-9]{1,6})${SEPARATOR}${tag}$`);

/** Whether `s` (from a `〔`, no `〕` after it) is how a token of `tag` begins: `〔`, `〔m`, `〔m1`, `〔m1·`, `〔m1·k7`… up to its whole inside. */
function beginsToken(s: string, tag: string): boolean {
  const m = /^〔(?:[mf](?:[0-9]{1,6}(?:·([a-z0-9]*))?)?)?$/.exec(s);
  return m !== null && (m[1] === undefined || tag.startsWith(m[1]));
}

/** A text with the tokens of a tag taken out: what is left, where a `〔` that may still open one stands, the tokens. */
interface Scanned {
  text: string;
  /** Where in `text` each `〔` stands that a `〕` may still close as a token (none past a `〕` that closed none). */
  opens: number[];
  /** Each token taken out, in order, with where it stood in `text` (a token inside another, where the outer one stood). */
  tokens: Array<{ at: number; ref: string }>;
}

/**
 * `text` without any token of `tag`, in ONE pass, in time proportional to the text however it nests (the shape of
 * runtime/prompt.ts `withoutMark`): the text is copied, keeping where each `〔` that may still open a token stands in the
 * copy; at a `〕`, what follows the last such `〔` is a token's inside or not — a token is taken out of the copy, so that a
 * `〔` before it may still open one (`〔m1·〔m2·k7q2〕k7q2〕` leaves nothing behind); anything else stays, and then no `〔`
 * before it can open one any more (a token holds no bracket). A token taken out where an earlier one stood inside it
 * moves that one to where it stood itself (a later token at a smaller place always held the earlier ones: the copy is
 * only ever cut back at a `〔`).
 */
function scan(text: string, tag: string): Scanned {
  if (!text.includes(OPEN)) return { text, opens: [], tokens: [] };
  const out: string[] = [];
  const opens: number[] = [];
  const tokens: Scanned["tokens"] = [];
  const max = insideMax(tag);
  const inside = insideOf(tag);
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === OPEN) {
      opens.push(out.length);
      out.push(c);
    } else if (c === CLOSE && opens.length > 0) {
      const at = opens[opens.length - 1]!;
      const m = out.length - at - 1 <= max ? inside.exec(out.slice(at + 1).join("")) : null;
      if (m) {
        out.length = at;
        opens.pop();
        tokens.push({ at, ref: `${m[1]}${m[2]}` });
      } else {
        opens.length = 0;
        out.push(c);
      }
    } else out.push(c);
  }
  for (let k = tokens.length - 2; k >= 0; k--) if (tokens[k]!.at > tokens[k + 1]!.at) tokens[k]!.at = tokens[k + 1]!.at;
  return { text: out.join(""), opens, tokens };
}

/**
 * Where in `s.text` its end begins that may still become a token of `tag` (`s.text.length` when none may): from the
 * earliest `〔` still open from which each piece up to the next open one, and the last to the end, begins a token — a
 * token inside another goes once it closes, so the outer one may still close after it. At most `max` from the end.
 */
function pendingFrom(s: Scanned, tag: string, max = Number.POSITIVE_INFINITY): number {
  let from = s.text.length;
  for (let k = s.opens.length - 1; k >= 0; k--) {
    const at = s.opens[k]!;
    const end = k === s.opens.length - 1 ? s.text.length : s.opens[k + 1]!;
    if (s.text.length - at > max || !beginsToken(s.text.slice(at, end), tag)) break;
    from = at;
  }
  return from;
}

/**
 * A reply's text (or reasoning) as it is stored (design rule 4; README "Agents and runs", Citations; agents/conversation.ts
 * `postAsAgent`): without any token of the run `refs` numbers for (`scan`) — and, when it was cut for length (`cut`), without
 * what the cut left of one at its very end (`pendingFrom`) —, then trimmed. With `cite` (the default) each token of a
 * number the run gave becomes a cite where it stood in the text that is left (`at`, UTF-16 code units, ascending): what it
 * names (a message, or the message a file is in), when `keep` lets the reply point at it, the first `CITES_MAX` only. A
 * token of a number the run never gave, past those, or one `keep` refuses, is taken out all the same and cites nothing;
 * so is every token of an acknowledgement and of a reasoning (`cite` false). Anything else is left as written: a `〔m1〕`
 * with no tag, or with another run's, is text someone wrote.
 */
export function takeCites(
  text: string,
  refs: RunRefs,
  { cite = true, keep = () => true, cut = false }: { cite?: boolean; keep?: (r: MessageRef) => boolean; cut?: boolean } = {},
): { text: string; cites: Cite[] } {
  const scanned = scan(text, refs.tag);
  let out = scanned.text;
  if (cut) out = out.slice(0, pendingFrom(scanned, refs.tag));
  const lead = out.length - out.trimStart().length;
  out = out.trim();
  const cites: Cite[] = [];
  if (!cite) return { text: out, cites };
  for (const token of scanned.tokens) {
    if (cites.length >= CITES_MAX) break;
    const target = refs.target(token.ref);
    if (target === null || !keep(target.ref)) continue;
    cites.push({ at: Math.min(Math.max(0, token.at - lead), out.length), kind: target.kind, ref: target.ref });
  }
  return { text: out, cites };
}

/** The most a stream holds back for a token that may still be coming: enough for one inside another. */
const HOLD_MAX = 32;

/**
 * A reply's text or reasoning as it streams (runtime/stream.ts), without the tokens of its run's `tag`: each piece is
 * pushed with every token it completes taken out (`scan`), and what may still become one — its end from a `〔` on
 * (`pendingFrom`, at most `HOLD_MAX`) — is held until the next piece says; once it can no longer be one, it goes out.
 * `end`: nothing more comes, and what is held goes out as it is.
 */
export class TokenHold {
  private held = "";

  constructor(private readonly tag: string) {}

  push(piece: string): string {
    const scanned = scan(this.held + piece, this.tag);
    const from = pendingFrom(scanned, this.tag, HOLD_MAX);
    this.held = scanned.text.slice(from);
    return scanned.text.slice(0, from);
  }

  end(): string {
    const rest = this.held;
    this.held = "";
    return rest;
  }
}
