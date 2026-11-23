import type { ConversationEvents } from "../conversations/events.ts";
import type { MemoryCallDeps } from "./call.ts";
import type { Hub } from "../sync/hub.ts";

/**
 * The background worker of Agent social's judgements: the persona aid in ring 1a (lane A's A8b), the batch note judge and the
 * withheld check in ring 1b (A7, A8a). STEP 0: a handle that does nothing, so that `app.noteJudge` exists and lanes only fill
 * it in. `runOnce` does one pass and returns the units of work it did; `close` ends what is under way.
 */
export interface NoteJudge {
  runOnce(): Promise<number>;
  close(): Promise<void>;
}

export function startNoteJudge(
  _deps: MemoryCallDeps & { conversations: ConversationEvents; realtime?: Pick<Hub, "pushAgentChanged"> },
  _opts: { timer?: false } = {},
): NoteJudge {
  return {
    async runOnce() {
      return 0;
    },
    async close() {},
  };
}
