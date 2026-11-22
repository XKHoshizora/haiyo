import type { FastifyBaseLogger } from "fastify";
import type { BlobStore } from "../../attachments/blob.ts";
import type { Config } from "../../config.ts";
import type { Db } from "../../db.ts";
import type { ToolCall, ToolSpec } from "../../models/gateway.ts";
import type { Slots } from "../../slots.ts";
import type { Toolbox } from "../port-impl.ts";
import { UNUSABLE } from "../runtime/loop.ts";
import type { Activity, RunTicket, ToolOutcome } from "../runtime/port.ts";
import { clockSpec, CURRENT_TIME, currentTime } from "./clock.ts";
import { fileSpec, READ_FILE, readFile } from "./file.ts";
import type { RunRefs } from "./refs.ts";
import { SEARCH_MESSAGES, searchMessages, searchSpec } from "./search.ts";

export { CURRENT_TIME } from "./clock.ts";
export { READ_FILE } from "./file.ts";
export { SEARCH_MESSAGES } from "./search.ts";

/**
 * The three tools a reply may be offered (README "Agents and runs", Tools in a reply; plan Task 6): `search_messages`
 * (search.ts), `current_time` (clock.ts) and `read_file` (file.ts) — what they are (`toolSpecs`), how a call of one runs
 * (`runTool`), and the toolbox the port asks (`createToolbox`). Each runs on the database and the blob store as the
 * reply's Agent, within the run's scope (`RunScope`), never on anything the model names but by the numbers the run gave
 * it (refs.ts). Nothing here logs what a tool was asked or gave.
 */

/**
 * The reply run a tool call is for, as the port holds it from `begin` (port-impl.ts): the run, whether it is in a group
 * (anywhere but its Agent's own conversation), the numbers it gave the model (`refs`), how far its conversation had come
 * when it began (`heardTo`: the conversation's seq then — a group reply heard everyone who wrote up to it, runs.ts
 * `hearFrom`, so its tools may show it nothing later), in a group its mark (taken out of whatever someone else wrote), and
 * in its own conversation where what its call shows begins (`shownFrom`).
 */
export interface RunScope extends RunTicket {
  readonly group: boolean;
  readonly refs: RunRefs;
  readonly heardTo: number;
  readonly mark: string | null;
  /**
   * In its Agent's own conversation, where what its call shows begins (context.ts `BuiltContext.shownFrom`): its search
   * leaves out the owner's messages it is shown, and only those (`searchRows` `answering`). Absent or null: from the
   * Agent's last posted reply on.
   */
  readonly shownFrom?: number | null;
}

export interface ToolDeps {
  db: Db;
  blobs: BlobStore;
  /** The searches in progress (app `Deps.searches`): an Agent's take a slot as a person's do, under its own principal. */
  searches: Slots;
  config: Pick<Config, "siteTimezone" | "searchStatementTimeoutMs" | "tools">;
  log: Pick<FastifyBaseLogger, "error" | "warn">;
  /** The clock (`current_time`); default the wall clock. */
  now?: () => Date;
  /**
   * Called when a search in a group found nothing there, with the run and what it was asked (Task 8: whether to look
   * elsewhere for the Agent's owner). It tells the model nothing. None: nothing is done.
   */
  elsewhere?: (scope: RunScope, ask: ElsewhereAsk) => void | Promise<void>;
}

/** What a search was asked, as it ran: the words (cleaned) and the filters (null: none). */
export interface ElsewhereAsk {
  term: string;
  from: string | null;
  before: string | null;
  after: string | null;
}

/** The tools a reply is offered: the search (in a group, of that group only), the clock, the file. */
export function toolSpecs(where: { group: boolean }): ToolSpec[] {
  return [searchSpec(where.group), clockSpec, fileSpec];
}

/** What each tool's work is (its status while it runs, what it is counted under). */
const KINDS: Readonly<Record<string, Activity>> = { [SEARCH_MESSAGES]: "search", [READ_FILE]: "file", [CURRENT_TIME]: "time" };

/**
 * Runs one call for `scope`'s reply: a call of a tool `toolSpecs` offers whose input its schema took (the worker checks
 * both). A call it cannot answer is answered with an error (`{ error }`), never a rejection; a failure of the database or
 * the blob store rejects (the worker answers the model with its own error and logs the failure's kind).
 */
export async function runTool(deps: ToolDeps, scope: RunScope, call: ToolCall, signal: AbortSignal): Promise<ToolOutcome> {
  const input = call.input as Record<string, unknown>;
  switch (call.name) {
    case SEARCH_MESSAGES:
      return searchMessages(deps, scope, input as { query: string; from?: string; before?: string; after?: string }, signal);
    case CURRENT_TIME:
      return { output: currentTime(deps.now?.() ?? new Date(), deps.config.siteTimezone) };
    case READ_FILE:
      return readFile(deps, scope, input as { file: string; from?: number }, signal);
    default:
      return { output: { error: UNUSABLE } };
  }
}

/**
 * The toolbox of the service's port (app.ts): every reply is offered the three tools (`begin` decides first whether it
 * may be offered any), each at most as often as its own `TOOLS` count allows in one reply.
 */
export function createToolbox(deps: ToolDeps): Toolbox {
  const { searchPerReply, filePerReply, timePerReply } = deps.config.tools;
  return {
    offer: (_run, where) => ({
      tools: toolSpecs(where),
      perTool: { [SEARCH_MESSAGES]: searchPerReply, [READ_FILE]: filePerReply, [CURRENT_TIME]: timePerReply },
      kinds: { ...KINDS },
    }),
    run: (scope, call, signal) => runTool(deps, scope, call, signal),
  };
}
