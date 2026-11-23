import type { ConversationEvents } from "../conversations/events.ts";
import type { MemoryCallDeps } from "./call.ts";
import type { Hub } from "../sync/hub.ts";

/**
 * The background worker of Agent social's judgements: the persona aid in ring 1a (lane A's A8b), the batch note judge and the
 * withheld check in ring 1b (A7, A8a). STEP 0: a handle that does nothing, so that `app.noteJudge` exists and lanes only fill
 * it in. `runOnce` does one pass and returns the units of work it did; `close` ends what is under way. `deps.closing` is the signal
 * every memory call is made with (`memoryCall(deps, ownerId, input, closing)`): the service aborts it as it stops, before it waits for
 * the memory calls, so a call in flight returns at once instead of holding the stop; `close()` is called then too, and a worker that
 * has its own timer clears it there and starts no pass after it.
 */
export interface NoteJudge {
  runOnce(): Promise<number>;
  close(): Promise<void>;
}

export function startNoteJudge(
  _deps: MemoryCallDeps & { conversations: ConversationEvents; realtime?: Pick<Hub, "pushAgentChanged">; closing: AbortSignal },
  _opts: { timer?: false } = {},
): NoteJudge {
  return {
    async runOnce() {
      return 0;
    },
    async close() {},
  };
}
