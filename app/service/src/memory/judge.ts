import type { FastifyBaseLogger } from "fastify";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import type { Db } from "../db.ts";
import type { Judge } from "../judge/client.ts";
import { runPersonaAid, type Claimed } from "./persona-aid.ts";
import type { Hub } from "../sync/hub.ts";

/**
 * The background worker of Agent social's persona aid (ring 1a, A8b; ring 1b, option A, adds no judge of its own). `runOnce` does one
 * pass and returns the judgement requests it made (memory/persona-aid.ts `runPersonaAid`: one per sentence asked); `close` ends what
 * is under way. `deps.closing` is the signal every memory judgement and call is made with: the service aborts it as it stops, before it
 * waits for the memory calls, so a request in flight returns at once instead of holding the stop; `close()` is called then too: the
 * timer is cleared and no pass starts after it.
 *
 * A pass reads at most `OTHERS.judgeOwnersPerPoll` Agents whose persona was saved since it was last read (`persona_version >
 * persona_checked_version`), at most one of each owner, each claimed in a statement of its own just before it is read (fix 1, F3): the
 * claim is the stamp, so an Agent is never handled twice for one version, whoever polls, and a process lost mid-pass leaves at most the
 * persona it was reading stamped unread. While the switch is off the worker claims nothing, asks nothing and stamps nothing: at the
 * first switch-on every persona that exists is read once, at this pace (10 owners a poll), each within half of its owner's daily memory
 * judgements (A-4 review I2, reversing attack M11; persona aid v2 fix 1, F1). A claimed Agent whose read ended for good (no judgement
 * model, the half reached, a request that failed) is not read again for that version: the persona aid is a help, never a gate; one
 * refused for a moment (no place among the judgement's calls, the limits unreadable) or cut short by the stop is given back, to be read
 * at a later pass (m5).
 *
 * The timer starts one interval after the worker and is `unref`ed (an app a test builds itself does not pass the option that turns it
 * off); in a test the pass is called by hand. Nothing is logged but counters and ids: never a persona, a sentence or a note.
 */
export interface NoteJudge {
  runOnce(): Promise<number>;
  close(): Promise<void>;
}

export interface NoteJudgeDeps {
  db: Db;
  config: Config;
  /** The judgement model; null when `JUDGE` is not configured (the aid then reads nothing and stamps what it claims). */
  judge: Judge | null;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info" | "debug">;
  conversations: ConversationEvents;
  realtime?: Pick<Hub, "pushAgentChanged">;
  closing: AbortSignal;
}

export function startNoteJudge(deps: NoteJudgeDeps, opts: { timer?: false } = {}): NoteJudge {
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const under = new Set<Promise<number>>();

  /**
   * The claim: one statement, the next due Agent (by owner, then Agent) of an owner not served yet in this pass (`served`), stamped; a row
   * another worker is claiming is passed over. Null: nothing is due.
   */
  async function claim(served: readonly string[]): Promise<Claimed | null> {
    const { rows } = await deps.db.query<{ id: string; owner_id: string; persona: string; persona_version: number }>(
      `with picked as (
         select a.principal_id
           from agents a join principals p on p.id = a.principal_id
          where a.persona_version > a.persona_checked_version and a.deleted_at is null and p.owner_id <> all($1::uuid[])
          order by p.owner_id, a.principal_id
          limit 1
          for update of a skip locked
       )
       update agents a set persona_checked_version = a.persona_version
         from picked, principals p
        where a.principal_id = picked.principal_id and a.persona_version > a.persona_checked_version
          and p.id = a.principal_id
       returning a.principal_id as id, p.owner_id, a.persona, a.persona_version`,
      [served],
    );
    const r = rows[0];
    return r === undefined ? null : { id: r.id, ownerId: r.owner_id, persona: r.persona, personaVersion: r.persona_version };
  }

  async function pass(): Promise<number> {
    if (!deps.config.social.enabled) return 0;
    const served: string[] = [];
    let requests = 0;
    while (served.length < deps.config.others.judgeOwnersPerPoll && !closed && !deps.closing.aborted) {
      const agent = await claim(served);
      if (agent === null) break;
      served.push(agent.ownerId);
      try {
        requests += await runPersonaAid(deps, agent, deps.closing);
      } catch (err) {
        deps.log.error({ agentId: agent.id, kind: (err as { name?: unknown } | null)?.name ?? typeof err }, "the persona aid failed for an Agent; nothing was written");
      }
    }
    return requests;
  }

  function runOnce(): Promise<number> {
    const running = pass();
    under.add(running);
    const done = (): void => void under.delete(running);
    void running.then(done, done);
    return running;
  }

  function arm(): void {
    if (closed || opts.timer === false) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce()
        .catch((err: unknown) => deps.log.error({ kind: (err as { name?: unknown } | null)?.name ?? typeof err }, "a pass of the persona aid failed"))
        .finally(arm);
    }, deps.config.others.judgePollMs);
    timer.unref();
  }
  arm();

  return {
    runOnce,
    async close() {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      await Promise.allSettled([...under]);
    },
  };
}
