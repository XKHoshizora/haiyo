import type { FastifyBaseLogger } from "fastify";
import { siteDay } from "../accounts/store.ts";
import { judgementsOn } from "../agents/proactive/decide.ts";
import type { Config } from "../config.ts";
import type { ConversationEvents } from "../conversations/events.ts";
import type { Db } from "../db.ts";
import type { Judge } from "../judge/client.ts";
import { ownerRoom, releasePersona, runPersonaAid, siteRoom, type Claimed } from "./persona-aid.ts";
import type { Hub } from "../sync/hub.ts";

/**
 * The background worker of Agent social's persona aid (ring 1a, A8b; ring 1b, option A, adds no judge of its own). `runOnce` does one
 * pass and returns the judgement requests it made (memory/persona-aid.ts `runPersonaAid`: one per sentence asked); `close` ends what
 * is under way. `deps.closing` is the signal every memory judgement and call is made with: the service aborts it as it stops, before it
 * waits for the memory calls, so a request in flight returns at once instead of holding the stop; `close()` is called then too: the
 * timer is cleared and no pass starts after it.
 *
 * A pass claims, in one statement, at most `OTHERS.judgeOwnersPerPoll` Agents whose persona was saved since it was last read
 * (`persona_version > persona_checked_version`), at most one of each owner: the claim is the stamp, so an Agent is never handled twice
 * for one version, whoever polls. While the switch is off the worker claims nothing, asks nothing and stamps nothing: at the first
 * switch-on every persona that exists is read once, at this pace (10 owners a poll), each within its owner's daily memory judgements
 * (A-4 review I2, reversing attack M11). Sorting keeps priority (persona aid v2, round 1, A3): an owner who has used half their
 * judgements of the day (`ownerRoom`) is not claimed, and while the site has used half of memory's share of its day (`siteRoom`) nothing
 * is; their personas stay due, so a poll is never spent on what could not be read. A claimed Agent whose persona could not be asked
 * for good (no judgement model, the day used up while asking) is not read again for that version: the persona aid is a help, never a
 * gate; one refused for a moment (no place among the judgement's calls, the limits unreadable, a read that would crowd out sorting) or
 * cut short by the stop is given back, to be read at a later pass (m5).
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
   * The claim: one statement, one Agent per owner, the owners' number capped, no owner who has used `ownerRoom` of their judgements of
   * site day `day`; the stamp is the claim.
   */
  async function claim(day: string): Promise<Claimed[]> {
    const { rows } = await deps.db.query<{ id: string; owner_id: string; persona: string; persona_version: number }>(
      `with due as (
         select distinct on (p.owner_id) a.principal_id, p.owner_id
           from agents a join principals p on p.id = a.principal_id
           left join memory_judge_usage u on u.owner_id = p.owner_id and u.day = $2::date
          where a.persona_version > a.persona_checked_version and a.deleted_at is null and coalesce(u.calls, 0) < $3::numeric
          order by p.owner_id, a.principal_id
       ), picked as (select principal_id from due order by owner_id limit $1)
       update agents a set persona_checked_version = a.persona_version
         from picked, principals p
        where a.principal_id = picked.principal_id and a.persona_version > a.persona_checked_version
          and p.id = a.principal_id
       returning a.principal_id as id, p.owner_id, a.persona, a.persona_version`,
      [deps.config.others.judgeOwnersPerPoll, day, ownerRoom(deps.config)],
    );
    return rows.map((r) => ({ id: r.id, ownerId: r.owner_id, persona: r.persona, personaVersion: r.persona_version }));
  }

  async function pass(): Promise<number> {
    if (closed || deps.closing.aborted) return 0;
    if (!deps.config.social.enabled) return 0;
    const day = siteDay(new Date(), deps.config.siteTimezone);
    if ((await judgementsOn(deps.db, day)) >= siteRoom(deps.config)) return 0;
    const claimed = await claim(day);
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
