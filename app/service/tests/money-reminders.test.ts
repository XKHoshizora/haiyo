import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentPort } from "../src/agents/port-impl.ts";
import { createAgentWorker } from "../src/agents/runtime/worker.ts";
import type { ModelGateway } from "../src/models/gateway.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { nextSiteMidnight } from "../src/accounts/store.ts";
import { grant, METER_ENV } from "./helpers/metering.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * Reminders to the owner (Task H, rule 6; README "Metering", Reminders; src/metering/reminders.ts): a whisper of kind
 * `allowance`, no button, in the replying Agent's own conversation, seen by its owner alone — when the day's free allowance
 * is 80 % used (`ALLOWANCE.warnAt`), when it is used up and the balance is at or below zero (it comes back at the site's
 * midnight), at most one of each per owner and site day, whichever Agent replied; and `余额用完了。` each time a reply takes
 * the balance from above zero to zero or below. Counters only in the log. On the real port and database with the meter
 * models (3 free points a day; 1 000 micro-points an output token).
 */

const lines: string[] = [];
/** The app's own model gateway: what persona drafts call. */
const drafts = scriptedGateway();
const { app, db } = useApp({ env: METER_ENV, models: drafts, agentWorker: false, logStream: { write: (line) => void lines.push(line) } });

afterEach(async () => {
  await closeAllSockets();
});

const FREE = { source: "site", id: "meter_free" } as const;
const PAID = { source: "site", id: "meter_paid" } as const;
const POINT = 1_000_000n;
const WARN = "这个周期的额度已经用了 80%。";
/**
 * When the allowance comes back, written as the web writes a date ("M月D日 HH:MM", app/web/src/data/errorTexts.js
 * `resetTimeText`), in the site's time zone: a whisper stays open for days, so never "明天".
 */
const resetText = (): string => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(nextSiteMidnight(new Date(), "Asia/Shanghai"))
      .map((x) => [x.type, x.value]),
  );
  return `${Number(parts.month)}月${Number(parts.day)}日 ${parts.hour}:${parts.minute}`;
};
const EMPTY = `额度用完了，${resetText()} 恢复。`;
const BALANCE = "余额用完了。";
/** `n` output tokens: n × 1 000 micro-points on a meter model. */
const out = (n: number) => ({ inputTokens: 0, outputTokens: n });

function workerWith(gateway: ModelGateway) {
  const { db: pool, config, blobs, conversations, reads } = app.deps;
  const port = createAgentPort({ db: pool, config, blobs, realtime: app.realtime, conversations, reads, log: app.log });
  return createAgentWorker({ port, models: gateway, runTimeoutMs: config.agentRunTimeoutMs, maxRunsInFlight: 16, background: false, log: app.log });
}

let txn = 0;
const say = async (who: Actor, conv: string, text: string) => {
  const sent = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `mr${++txn}` });
  expect(sent.status).toBe(201);
};

/** The owner's whispers in `conv`, oldest first, as text. */
const whispersIn = async (who: Actor, conv: string): Promise<string[]> => {
  const res = await api(app, who, "GET", `/api/conversations/${conv}/whispers`);
  expect(res.status).toBe(200);
  return (res.json.whispers as Array<{ kind: string; text: string; actions: string[] }>)
    .map((w) => {
      expect(w).toMatchObject({ kind: "allowance", actions: [] });
      return w.text;
    })
    .reverse();
};
const metrics = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => typeof e.metric === "string" && /^(allowance_|balance_)/.test(e.metric as string));
/** The log lines that tell of a deadlock (40P01) Postgres broke since `lines` was last emptied. */
const deadlocks = () => lines.filter((l) => l.includes("40P01") || l.includes("deadlock detected"));
/** A reminder a settlement recorded for `agentId` today (or `daysBack` site days ago), its whisper not made yet: its id. */
const recorded = async (ownerId: string, threshold: "warn" | "empty" | "balance", agentId: string, daysBack = 0) =>
  (
    await db.query<{ id: string }>(
      `insert into allowance_reminders (owner_id, day, threshold, agent_id)
       values ($1, (now() at time zone 'Asia/Shanghai')::date - $4::int, $2, $3) returning id::text`,
      [ownerId, threshold, agentId, daysBack],
    )
  ).rows[0]!.id;
/** How many statements of this database wait for a row lock now. */
const lockWaits = async () =>
  (await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'")).rows[0]!.n;
const freeUsed = async (ownerId: string) =>
  (await db.query<{ used: string }>("select coalesce(sum(used_micro), 0)::text as used from free_usage where owner_id = $1", [ownerId])).rows[0]!.used;
/** Someone else's spending (a persona draft, say): today's free allowance used, set to `micro`. */
const setFreeUsed = (ownerId: string, micro: bigint) =>
  db.query(
    `insert into free_usage (owner_id, day, used_micro) values ($1, (now() at time zone 'Asia/Shanghai')::date, $2)
     on conflict (owner_id, day) do update set used_micro = $2`,
    [ownerId, micro.toString()],
  );

describe("reminders of the day's free allowance and of the balance", () => {
  it("at 80 % once, used up once (the balance at zero), not again the same day — whichever Agent replies —, and a new day starts over", async () => {
    const gateway = scriptedGateway();
    for (const n of [1000, 1000, 500, 400, 1000, 500]) gateway.reply("好。", { usage: out(n) });
    const worker = workerWith(gateway);
    const owner = await signUp(app, "warned");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    lines.length = 0;
    const reply = async (conv: string) => {
      await say(owner, conv, "你好");
      expect(await worker.runOnce()).toBe(true);
    };

    await reply(ann.conversationId); // 1 of 3 points
    await reply(ann.conversationId); // 2
    expect(await whispersIn(owner, ann.conversationId)).toEqual([]);
    await reply(ann.conversationId); // 2.5: past 80 %
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN]);
    await reply(bob.conversationId); // 2.9: Bob's reply, the same owner and day — nothing again
    expect(await whispersIn(owner, bob.conversationId)).toEqual([]);
    await reply(bob.conversationId); // 3 (the rest forgiven), and no balance: used up
    expect(await freeUsed(owner.id)).toBe("3000000");
    expect(await whispersIn(owner, bob.conversationId)).toEqual([EMPTY]);
    // Refused now: nothing settles, nothing more is said.
    await say(owner, bob.conversationId, "还在吗");
    await worker.runOnce();
    expect(await whispersIn(owner, bob.conversationId)).toEqual([EMPTY]);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN]);
    expect(metrics().map((m) => m.metric)).toEqual(["allowance_warn_80", "allowance_empty"]);
    // Counters only: no owner, Agent, conversation or amount with them.
    for (const m of metrics()) expect(Object.keys(m).filter((k) => !["level", "time", "pid", "hostname", "msg", "metric"].includes(k))).toEqual([]);

    // The next site day: what today used and was told moves to yesterday; today starts over.
    await db.query("update free_usage set day = day - 1 where owner_id = $1", [owner.id]);
    await db.query("update allowance_reminders set day = day - 1 where owner_id = $1", [owner.id]);
    await setFreeUsed(owner.id, 2n * POINT);
    await reply(ann.conversationId); // 2.5 of today's 3
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN, WARN]);
    // Yesterday's are gone: one row, today's warning.
    expect((await db.query("select threshold from allowance_reminders where owner_id = $1", [owner.id])).rows).toEqual([{ threshold: "warn" }]);
    expect(gateway.pending()).toBe(0);
  });

  it("余额用完了 each time a reply takes the balance from above zero to zero or below — and not while it stays there", async () => {
    const gateway = scriptedGateway();
    for (let i = 0; i < 4; i++) gateway.reply("好。", { usage: out(1000) });
    const worker = workerWith(gateway);
    const owner = await signUp(app, "spender");
    const tess = await mustCreateAgent(app, owner, { model: PAID, name: "Tess", persona: "简短地回答。" });
    const conv = tess.conversationId as string;
    const reply = async () => {
      await say(owner, conv, "你好");
      expect(await worker.runOnce()).toBe(true);
    };
    await grant(app.deps.db, owner.id, (3n * POINT) / 2n);
    lines.length = 0;
    await reply(); // 0.5 left
    expect(await whispersIn(owner, conv)).toEqual([]);
    await reply(); // −0.5: crossed
    expect(await whispersIn(owner, conv)).toEqual([BALANCE]);
    await reply(); // refused: nothing settles
    expect(await whispersIn(owner, conv)).toEqual([BALANCE]);
    await grant(app.deps.db, owner.id, 2n * POINT); // 1.5
    await reply(); // 0.5
    await reply(); // −0.5: crossed again
    expect(await whispersIn(owner, conv)).toEqual([BALANCE, BALANCE]);
    // The free allowance was never touched: no allowance reminder.
    expect(metrics().map((m) => m.metric)).toEqual(["balance_empty", "balance_empty"]);
    expect(gateway.pending()).toBe(0);
  });

  it("in a group: a reply someone else called for that crosses 80 % tells the Agent's owner in the Agent's own conversation; the group and its other members see nothing of it", async () => {
    const gateway = scriptedGateway().reply("好的。", { usage: out(500) });
    const worker = workerWith(gateway);
    const owner = await signUp(app, "groupowner");
    const mia = await signUp(app, "groupmia");
    const ned = await signUp(app, "groupned");
    const agent = await mustCreateAgent(app, owner, { model: FREE, handle: "warn_bot", name: "Warn Bot", persona: "简短地回答。" });
    const g = await group(app, owner, "team", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await setFreeUsed(owner.id, 2n * POINT);
    const [miaSocket, ownerSocket] = [await connect(app, mia), await connect(app, owner)];
    const readsOf = async (who: Actor) => {
      const out: unknown[] = [];
      for (const url of ["/api/sync", `/api/conversations/${g}`, `/api/conversations/${g}/messages`, `/api/conversations/${g}/runs`]) out.push((await api(app, who, "GET", url)).json);
      out.push((await api(app, who, "POST", "/api/sync/catchup", { positions: { [g]: 0 } })).json);
      return out;
    };
    await say(mia, g, "@warn_bot 你好");
    expect(await worker.runOnce()).toBe(true);
    await ownerSocket.waitFor((e) => e.type === "whisper" && e.whisper.kind === "allowance" && e.whisper.conversationId === agent.conversationId);
    expect(await whispersIn(owner, agent.conversationId)).toEqual([WARN]);
    expect((await api(app, owner, "GET", `/api/conversations/${g}/whispers`)).json.whispers).toEqual([]);
    // Mia: no whisper frame, nothing of it in any frame or anything she reads.
    await vi.waitFor(() => expect(miaSocket.events.some((e) => e.type === "message" && e.message.senderId === agent.id)).toBe(true));
    for (const e of miaSocket.events) {
      expect(e.type).not.toBe("whisper");
      expect(JSON.stringify(e)).not.toMatch(/额度|allowance|余额/);
    }
    for (const body of await readsOf(mia)) expect(JSON.stringify(body)).not.toMatch(/额度|allowance|余额/);
    expect(gateway.pending()).toBe(0);
  });

  it("two replies of one owner settling at once, both finding 80 % passed, behind a third holder of the account row: both end, no deadlock, one reminder", async () => {
    const gateway = scriptedGateway();
    const [one, two] = [gateway.hang(), gateway.hang()];
    const worker = workerWith(gateway);
    const owner = await signUp(app, "twosettle");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    await say(owner, ann.conversationId, "你好");
    await say(owner, bob.conversationId, "你好");
    // Both start on today's 3 points (their holds fit together); then someone else's spending takes the day to 2.4 used.
    const runs = [worker.runOnce(), worker.runOnce()];
    await Promise.all([one.reached, two.reached]);
    await setFreeUsed(owner.id, (12n * POINT) / 5n);
    const holder = await db.pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from accounts where principal_id = $1 for update", [owner.id]);
      one.release("一。", { usage: out(100) });
      two.release("二。", { usage: out(100) });
      await vi.waitFor(
        async () =>
          expect(
            (await db.query<{ n: number }>("select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and query like '%from accounts where principal_id = $1 for update%'"))
              .rows[0]!.n,
          ).toBe(2),
        { timeout: 5_000 },
      );
      await holder.query("commit");
    } finally {
      await holder.query("rollback").catch(() => {});
      holder.release();
    }
    await Promise.all(runs);
    expect([...(await whispersIn(owner, ann.conversationId)), ...(await whispersIn(owner, bob.conversationId))]).toEqual([WARN]);
    expect((await db.query("select threshold from allowance_reminders where owner_id = $1", [owner.id])).rows).toEqual([{ threshold: "warn" }]);
    expect(gateway.pending()).toBe(0);
  });

  it("a persona draft that takes the allowance past 80 % tells its owner too: in the conversation of the Agent they used last, recorded with the draft's settlement and made once it has committed", async () => {
    const owner = await signUp(app, "draftwarn");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    await say(owner, ann.conversationId, "早");
    await say(owner, bob.conversationId, "晚");
    await setFreeUsed(owner.id, (23n * POINT) / 10n);
    drafts.reply("你是一个助手。", { usage: out(200) });
    lines.length = 0;
    expect((await api(app, owner, "POST", "/api/agents/draft-persona", { name: "Cai", model: FREE })).status).toBe(200);
    expect(await whispersIn(owner, bob.conversationId)).toEqual([WARN]);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([]);
    expect(metrics().map((m) => m.metric)).toEqual(["allowance_warn_80"]);
    expect(drafts.pending()).toBe(0);
  });

  it("a reply whose Agent was deleted while it ran still tells its owner, in the conversation of the Agent they used last of those left", async () => {
    const gateway = scriptedGateway().reply("早。", { usage: out(0) });
    const call = gateway.hang();
    const worker = workerWith(gateway);
    const owner = await signUp(app, "deletedwarn");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    const cai = await mustCreateAgent(app, owner, { model: FREE, name: "Cai", persona: "简短地回答。" });
    // Cai was used before Bob was; Ann's conversation, used last of all, goes with Ann.
    await say(owner, cai.conversationId, "早");
    expect(await worker.runOnce()).toBe(true);
    await say(owner, bob.conversationId, "也早");
    await db.query("update agent_runs set status = 'cancelled', finished_at = now() where conversation_id = $1 and status = 'queued'", [bob.conversationId]);
    await setFreeUsed(owner.id, (12n * POINT) / 5n - 1n);
    await say(owner, ann.conversationId, "你好");
    const running = worker.runOnce();
    await call.reached;
    expect((await api(app, owner, "DELETE", `/api/agents/${ann.id}`)).status).toBe(200);
    call.release("好。", { usage: out(100) });
    await running;
    expect(BigInt(await freeUsed(owner.id))).toBeGreaterThanOrEqual((12n * POINT) / 5n);
    expect(await whispersIn(owner, bob.conversationId)).toEqual([WARN]);
    expect(await whispersIn(owner, cai.conversationId)).toEqual([]);
    expect(gateway.pending()).toBe(0);
  });

  it("lock order: a group reply's reminder is made in its Agent's own conversation after the settlement commits — a transaction that holds that conversation and then asks for the Agent's row (a message to the Agent, another of its runs) never deadlocks with it", async () => {
    const gateway = scriptedGateway();
    const call = gateway.hang();
    const worker = workerWith(gateway);
    const owner = await signUp(app, "cycleone");
    const [mia, ned] = [await signUp(app, "cyclemia"), await signUp(app, "cyclened")];
    const agent = await mustCreateAgent(app, owner, { model: FREE, handle: "cycle_a", name: "Cycle", persona: "简短地回答。" });
    const g = await group(app, owner, "team", [mia, ned]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    await setFreeUsed(owner.id, (23n * POINT) / 10n);
    await say(mia, g, "@cycle_a 你好");
    lines.length = 0;
    const running = worker.runOnce();
    await call.reached;
    const other = await db.pool.connect();
    try {
      await other.query("begin");
      await other.query("select 1 from conversations where id = $1 for update", [agent.conversationId]);
      call.release("好的。", { usage: out(200) });
      // The reply's settlement, or its reminder after it, comes to wait for the conversation held here…
      await vi.waitFor(async () => expect(await lockWaits()).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
      // …which now asks for the Agent's row.
      await other.query("select 1 from agents where principal_id = $1 for update", [agent.id]);
      await other.query("commit");
    } finally {
      await other.query("rollback").catch(() => {});
      other.release();
    }
    await running;
    expect(deadlocks()).toEqual([]);
    expect((await db.query("select status from agent_runs where conversation_id = $1 and agent_id = $2", [g, agent.id])).rows).toEqual([{ status: "done" }]);
    await vi.waitFor(async () => expect(await whispersIn(owner, agent.conversationId)).toEqual([WARN]), { timeout: 5_000 });
    expect(gateway.pending()).toBe(0);
  });

  it("lock order: a persona draft's reminder is made in the conversation of the Agent used last after the draft's settlement commits — a run of that Agent that holds its conversation and its row and then asks for the owner's account never deadlocks with it", async () => {
    const owner = await signUp(app, "cycletwo");
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    await say(owner, bob.conversationId, "晚");
    await setFreeUsed(owner.id, (23n * POINT) / 10n);
    const draftCall = drafts.hang();
    lines.length = 0;
    const posting = api(app, owner, "POST", "/api/agents/draft-persona", { name: "Cai", model: FREE });
    await draftCall.reached;
    const other = await db.pool.connect();
    try {
      // As a run of Bob in `begin`'s third step, `extend` or its `finish` holds them.
      await other.query("begin");
      await other.query("select 1 from conversations where id = $1 for update", [bob.conversationId]);
      await other.query("select 1 from agents where principal_id = $1 for update", [bob.id]);
      draftCall.release("你是一个助手。", { usage: out(200) });
      await vi.waitFor(async () => expect(await lockWaits()).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
      await other.query("select 1 from accounts where principal_id = $1 for update", [owner.id]);
      await other.query("commit");
    } finally {
      await other.query("rollback").catch(() => {});
      other.release();
    }
    const posted = await posting;
    expect(deadlocks()).toEqual([]);
    expect(posted.status).toBe(200);
    await vi.waitFor(async () => expect(await whispersIn(owner, bob.conversationId)).toEqual([WARN]), { timeout: 5_000 });
    expect(drafts.pending()).toBe(0);
  });

  it("a reminder whose Agent is deleted while its whisper is being made is said in the conversation of the owner's Agent used last of those left, and marked made only then", async () => {
    const owner = await signUp(app, "racewarn");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const bob = await mustCreateAgent(app, owner, { model: FREE, name: "Bob", persona: "简短地回答。" });
    await say(owner, ann.conversationId, "早");
    const id = await recorded(owner.id, "warn", bob.id);
    const { deliverReminder } = await import("../src/metering/reminders.ts");
    const other = await db.pool.connect();
    try {
      // Bob's row held: the delivery has read Bob alive and waits for his row inside `createWhisper`…
      await other.query("begin");
      await other.query("select 1 from agents where principal_id = $1 for update", [bob.id]);
      const delivering = deliverReminder(db, app.deps.config, id);
      await vi.waitFor(async () => expect(await lockWaits()).toBeGreaterThanOrEqual(1), { timeout: 5_000 });
      // …and Bob is deleted meanwhile: no whisper can be made in his conversation.
      await other.query("update agents set deleted_at = now() where principal_id = $1", [bob.id]);
      await other.query("commit");
      expect((await delivering)?.whisper?.conversationId).toBe(ann.conversationId);
    } finally {
      await other.query("rollback").catch(() => {});
      other.release();
    }
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN]);
    const [row] = (await db.query("select whisper_id, delivered_at from allowance_reminders where id = $1", [id])).rows;
    expect(row.whisper_id).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });

  it("a reminder of an owner with no Agent left at all is marked done with nothing made, and counted (reminder_no_agent)", async () => {
    const owner = await signUp(app, "noagentleft");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const id = await recorded(owner.id, "warn", ann.id);
    expect((await api(app, owner, "DELETE", `/api/agents/${ann.id}`)).status).toBe(200);
    const { deliverReminder } = await import("../src/metering/reminders.ts");
    expect(await deliverReminder(db, app.deps.config, id)).toEqual({ whisper: null, metric: "reminder_no_agent" });
    const [row] = (await db.query("select whisper_id, delivered_at from allowance_reminders where id = $1", [id])).rows;
    expect(row.whisper_id).toBeNull();
    expect(row.delivered_at).not.toBeNull();
    // Done: never made again.
    expect(await deliverReminder(db, app.deps.config, id)).toBeNull();
  });

  it("the sweep drops a reminder recorded on an earlier site day: marked done, nothing made — what it said is no longer true", async () => {
    const owner = await signUp(app, "staleday");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const id = await recorded(owner.id, "warn", ann.id, 1);
    const { deliverReminders } = await import("../src/metering/reminders.ts");
    const made = await deliverReminders(db, app.deps.config, app.log);
    expect(made.filter((r) => r.whisper?.ownerId === owner.id)).toEqual([]);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([]);
    const [row] = (await db.query("select whisper_id, delivered_at from allowance_reminders where id = $1", [id])).rows;
    expect(row.whisper_id).toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });

  it("the used-up reminder names the midnight after the site day it was recorded for, whenever its whisper is made", async () => {
    const owner = await signUp(app, "emptyday");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    const id = await recorded(owner.id, "empty", ann.id);
    // Its settlement's transaction began the day before (by milliseconds, at midnight): the day recorded is what counts.
    await db.query("update allowance_reminders set created_at = now() - interval '1 day' where id = $1", [id]);
    const { deliverReminder } = await import("../src/metering/reminders.ts");
    await deliverReminder(db, app.deps.config, id);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([EMPTY]);
  });

  it("the sweep delivers what is due oldest first, and reminders recorded together in the order they were recorded: ids as numbers, 10 after 9, not as text", async () => {
    const owners: Array<{ owner: Actor; agent: { id: string } }> = [];
    for (const name of ["tiea", "tieb", "tiec"]) {
      const owner = await signUp(app, name);
      owners.push({ owner, agent: await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" }) });
    }
    // Eight done before (ids 1–8), then three recorded together — one statement, one created_at: ids 9, 10 and 11.
    await db.query(
      "insert into allowance_reminders (owner_id, day, threshold, agent_id, delivered_at) select $1, (now() at time zone 'Asia/Shanghai')::date, 'balance', $2, now() from generate_series(1, 8)",
      [owners[0]!.owner.id, owners[0]!.agent.id],
    );
    await db.query(
      `insert into allowance_reminders (owner_id, day, threshold, agent_id)
       select o, (now() at time zone 'Asia/Shanghai')::date, 'warn', a from unnest($1::uuid[], $2::uuid[]) with ordinality as t(o, a, n) order by n`,
      [owners.map((o) => o.owner.id), owners.map((o) => o.agent.id)],
    );
    const due = (await db.query("select id::int as id, owner_id from allowance_reminders where delivered_at is null order by allowance_reminders.id")).rows;
    expect(due).toEqual(owners.map((o, i) => ({ id: 9 + i, owner_id: o.owner.id })));
    const { deliverReminders } = await import("../src/metering/reminders.ts");
    const made = await deliverReminders(db, app.deps.config, app.log);
    expect(made.map((r) => r.whisper?.ownerId)).toEqual(owners.map((o) => o.owner.id));
  });

  it("a reminder whose whisper was never made — the service stopped between the settlement and the whisper — is made by the periodic sweep, once, also when two sweeps run at once", async () => {
    const owner = await signUp(app, "sweepwarn");
    const ann = await mustCreateAgent(app, owner, { model: FREE, name: "Ann", persona: "简短地回答。" });
    // What the settlement wrote before the stop: the reminder is due, its whisper not made.
    await db.query("insert into allowance_reminders (owner_id, day, threshold, agent_id) values ($1, (now() at time zone 'Asia/Shanghai')::date, 'warn', $2)", [owner.id, ann.id]);
    const { deliverReminders } = await import("../src/metering/reminders.ts");
    const made = await Promise.all([deliverReminders(db, app.deps.config, app.log), deliverReminders(db, app.deps.config, app.log)]);
    expect(made.flat()).toHaveLength(1);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN]);
    expect(await deliverReminders(db, app.deps.config, app.log)).toEqual([]);
    expect(await whispersIn(owner, ann.conversationId)).toEqual([WARN]);
    const [row] = (await db.query("select whisper_id, delivered_at from allowance_reminders where owner_id = $1", [owner.id])).rows;
    expect(row.whisper_id).not.toBeNull();
    expect(row.delivered_at).not.toBeNull();
  });
});
