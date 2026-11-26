import { cutToWeight, weight } from "../../metering/tokens.ts";
import type { ToolCall } from "../../models/gateway.ts";

/**
 * The rules of a reply's tool rounds that need nothing but the calls themselves (README "Agents and runs", Tools in a
 * reply): what is a repeat, what is over a cap, what input a tool takes, how a result is cut, and the fixed sentences the
 * model is answered with. Pure: the worker (worker.ts) runs the loop.
 */

/** The result of a call made before with the same input: not run again. */
export const REPEATED = "这个已经查过了，结果和上次一样。请用已经查到的内容回答。";
/** The result of a call of a tool the reply has used as often as it may. */
export const OVER_CAP = "这类查询这次回复里不能再用了。";
/** The result of a call that cannot be run: a tool not offered, an input its schema refuses, a call cut short, a tool that failed. */
export const UNUSABLE = "这个请求无法执行。";
/** What a hold counts, for one tool result, besides the result itself (port-impl.ts `roomGrowth`: its id, its name, its JSON). */
export const RESULT_FRAMING_BYTES = 200;
/** The line the system text gains for the last call of a reply that used tools. */
export const FINAL_LINE = "你已经不能再查了，请用上面查到的内容直接回答。";
/** What ends a result cut to its weight. */
export const CUT_MARK = "…（结果太长，后面的省略了）";

/** The system text of a reply's last call: the fixed line after it. */
export const withFinalLine = (system: string): string => (system === "" ? FINAL_LINE : `${system}\n\n${FINAL_LINE}`);

/**
 * `value` as JSON text with every object's keys in order, at every depth, and every string and key in one Unicode form
 * (NFC): the same input written in another order, or with its accents composed otherwise, is the same.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value)
      .map((k) => [k.normalize("NFC"), k] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map(([shown, k]) => `${JSON.stringify(shown)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  return JSON.stringify(value) ?? "null";
}

/**
 * The counts of one reply's tool calls. A call is known by its tool's name and its input (`canonicalJson`) — as `same`
 * makes it, when given (worker.ts: a file call by its file's number, however the token was copied) — never by the
 * provider's id (ids repeat, and may be empty). `admit`: the first time a call is seen it runs ("run"), unless its
 * tool has been run as often as `perTool` allows it (looked up as the tool's own entry; a tool with none has only the
 * round cap) — then "over"; a call run before is a "repeat", and one seen a third time ends the tool phase (`mustEnd`).
 * `roundDone` counts a round that called tools; `exhausted` once `maxRounds` have. `maxCalls` (an others' reply: one real call,
 * `OTHERS.toolCalls`) bounds the calls that run in the whole reply, all tools together: the first usable ones run, the
 * rest are "over" — a repeat is still a repeat.
 */
export class LoopGuard {
  private readonly seen = new Map<string, number>();
  private readonly ran = new Set<string>();
  private readonly used = new Map<string, number>();
  private rounds = 0;
  private runs = 0;
  private repeatedThrice = false;

  constructor(private readonly limits: { maxRounds: number; perTool: Readonly<Record<string, number>>; same?: (call: ToolCall) => unknown; maxCalls?: number }) {}

  admit(call: ToolCall): "run" | "repeat" | "over" {
    const key = `${call.name}\u0000${canonicalJson(this.limits.same ? this.limits.same(call) : call.input)}`;
    const times = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, times);
    if (times >= 3) this.repeatedThrice = true;
    if (this.ran.has(key)) return "repeat";
    if (this.limits.maxCalls !== undefined && this.runs >= this.limits.maxCalls) return "over";
    const cap = Object.hasOwn(this.limits.perTool, call.name) ? this.limits.perTool[call.name] : undefined;
    const used = this.used.get(call.name) ?? 0;
    if (cap !== undefined && used >= cap) return "over";
    this.used.set(call.name, used + 1);
    this.ran.add(key);
    this.runs++;
    return "run";
  }

  roundDone(): void {
    this.rounds++;
  }

  /** The rounds that called tools have reached `maxRounds`. */
  exhausted(): boolean {
    return this.rounds >= this.limits.maxRounds;
  }

  /** A call was made a third time: the tool phase ends. */
  mustEnd(): boolean {
    return this.repeatedThrice;
  }
}

/** A JSON Schema as a tool's `parameters` gives it, as far as `fitsSchema` reads it. */
interface Schema {
  type?: unknown;
  properties?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Whether a tool's output is its refusal — an object with an own `error` (the search timed out, its words were too
 * short, a file cannot be read): the model is sent it as it is, but the call looked nothing up (messages/lookups.ts
 * `LookedUp`: not counted, nothing it found or searched for kept).
 */
export const isRefusal = (output: unknown): boolean => isRecord(output) && Object.hasOwn(output, "error");

/** Whether `value` is of the JSON Schema primitive `type` (an unknown or missing type takes anything). */
function ofType(value: unknown, type: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

/**
 * Whether a call's `input` is one its tool takes, by a small reading of the tool's schema (the gateway checks none): an
 * object for an object schema; every `required` key there; each key it has of the primitive type its property names;
 * no other key when `additionalProperties` is false. Keys are read as the input's own.
 */
export function fitsSchema(input: unknown, schema: Readonly<Record<string, unknown>>): boolean {
  const s = schema as Schema;
  if (!ofType(input, s.type)) return false;
  if (!isRecord(input)) return true;
  const properties = isRecord(s.properties) ? s.properties : {};
  const required = Array.isArray(s.required) ? s.required.filter((k): k is string => typeof k === "string") : [];
  if (!required.every((k) => Object.hasOwn(input, k))) return false;
  for (const key of Object.keys(input)) {
    const property = Object.hasOwn(properties, key) ? properties[key] : undefined;
    if (property === undefined) {
      if (s.additionalProperties === false) return false;
      continue;
    }
    if (isRecord(property) && !ofType(input[key], property.type)) return false;
  }
  return true;
}

/**
 * A tool's output as it goes back to the model, at most `maxWeight` (metering/tokens.ts `weight`): a string longer than
 * that is cut (`cutToWeight`) and ends with `CUT_MARK`; any other value is kept as it is when its JSON text fits, else that
 * text is cut so and sent as a string. With room for nothing but the mark, the mark alone.
 */
export function cutResult(output: unknown, maxWeight: number): unknown {
  const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "null");
  if (weight(text) <= maxWeight) return output === undefined ? null : output;
  return cutToWeight(text, Math.max(0, maxWeight - weight(CUT_MARK))) + CUT_MARK;
}
