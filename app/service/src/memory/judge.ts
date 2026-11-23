import type { FastifyBaseLogger } from "fastify";
import type { ConversationEvents } from "../conversations/events.ts";
import type { MemoryCallDeps } from "./call.ts";
import { releasePersona, runPersonaAid, type Claimed } from "./persona-aid.ts";
import type { Hub } from "../sync/hub.ts";

/**
 * The background worker of Agent social's judgements: the persona aid in ring 1a (A8b), the batch note judge and the withheld check
 * in ring 1b (A7, A8a, which add to the same per-owner pass). `runOnce` does one pass and returns the model calls it made; `close`
 * ends what is under way. `deps.closing` is the signal every memory call is made with (`memoryCall(deps, ownerId, input, closing)`):
 * the service aborts it as it stops, before it waits for the memory calls, so a call in flight returns at once instead of holding the
 * stop; `close()` is called then too: the timer is cleared and no pass starts after it.
 *
 * A pass claims, in one statement, at most `OTHERS.judgeOwnersPerPoll` Agents whose persona was saved since it was last read
 * (`persona_version > persona_checked_version`), at most one of each owner: the claim is the stamp, so an Agent is never handled twice
 * for one version, whoever polls. While the switch is off the worker claims nothing, calls nothing and stamps nothing: at the first
 * switch-on every persona that exists is read once, at this pace (10 owners a poll), each within its owner's daily memory allowance
 * (A-4 review I2, reversing attack M11). A claimed Agent whose call could not be made for good (the memory allowance spent, no model)
 * is not read again for that version: the persona aid is a help, never a gate; one refused for a moment (the owner's calls are at their
 * cap) or cut short by the stop is given back, to be read at a later pass (m5).
 *
 * The timer starts one interval after the worker and is `unref`ed (an app a test builds itself does not pass the option that turns it
 * off); in a test the pass is called by hand. Nothing is logged but counters and ids: never a persona, a sentence or a note.
 */
export interface NoteJudge {
  runOnce(): Promise<number>;
  close(): Promise<void>;
}

export type NoteJudgeDeps = Omit<MemoryCallDeps, "log"> & {
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">; conversations: ConversationEvents; realtime?: Pick<Hub, "pushAgentChanged">; closing: AbortSignal };

export function startNoteJudge(deps: NoteJudgeDeps, opts: { timer?: false } = {}): NoteJudge {
  let closed = false;
  let timer: NodeJS.Timeout | null = null;
  const under = new Set<Promise<number>>();

  /** The claim: one statement, one Agent per owner, the owners' number capped; the stamp is the claim. */
  async function claim(): Promise<Claimed[]> {
    const { rows } = await deps.db.query<{ id: string; owner_id: string; persona: string; persona_version: number }>(
      `with due as (
         select distinct on (p.owner_id) a.principal_id, p.owner_id
           from agents a join principals p on p.id = a.principal_id
          where a.persona_version > a.persona_checked_version and a.deleted_at is null
          order by p.owner_id, a.principal_id
       ), picked as (select principal_id from due order by owner_id limit $1)
       update agents a set persona_checked_version = a.persona_version
         from picked, principals p
        where a.principal_id = picked.principal_id and a.persona_version > a.persona_checked_version
          and p.id = a.principal_id
       returning a.principal_id as id, p.owner_id, a.persona, a.persona_version`,
      [deps.config.others.judgeOwnersPerPoll],
    );
    return rows.map((r) => ({ id: r.id, ownerId: r.owner_id, persona: r.persona, personaVersion: r.persona_version }));
  }

  async function pass(): Promise<number> {
    if (closed || deps.closing.aborted) return 0;
    if (!deps.config.social.enabled) return 0;
    const claimed = await claim();
    let calls = 0;
    for (const agent of claimed) {
      if (closed || deps.closing.aborted) {
        await releasePersona(deps.db, agent);
        continue;
      }
      try {
        calls += await runPersonaAid(deps, agent, deps.closing);
      } catch (err) {
        deps.log.error({ agentId: agent.id, kind: (err as { name?: unknown } | null)?.name ?? typeof err }, "the persona aid failed for an Agent; nothing was written");
      }
    }
    return calls;
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
