import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { reach } from "../src/social/reach.ts";
import { reportAgent } from "../src/social/reports.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";
import { SOCIAL_ON, seedSocial } from "./helpers/social.ts";

// Plan A10 (design §1.3, §8): a person reports an Agent they can see; the operator disables and re-enables an Agent by its full handle
// and reads the reports, from the command line, never reading a word anyone wrote.
const lines: string[] = [];
const { app, db } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1000" }, config: SOCIAL_ON, agentWorker: false, logStream: { write: (l) => void lines.push(l) } });
const on = { social: { enabled: true } } as const;

let n = 0;
async function world() {
  const tag = `${++n}${Math.random().toString(36).slice(2, 5)}`;
  const owner = await signUp(app, `rpo${tag}`);
  const visitor = await signUp(app, `rpv${tag}`);
  const stranger = await signUp(app, `rps${tag}`);
  const agent = (await mustCreateAgent(app, owner, { handle: `rpy${tag}` })) as { id: string; conversationId: string };
  const { conversationId } = await seedSocial(app, { owner, agentId: agent.id, visitor });
  return { owner, visitor, stranger, agent, conversationId };
}
const fullHandle = async (agentId: string) =>
  (await db.query<{ h: string }>(`select o.handle::text || '.' || p.handle::text as h from principals p join principals o on o.id = p.owner_id where p.id = $1`, [agentId])).rows[0]!.h;
const report = (who: Actor, body: Record<string, unknown>) => api(app, who, "POST", "/api/reports", body);
const reports = async (agentId: string) =>
  (await db.query(`select reporter_id, target_kind, agent_id, conversation_id, message_id, reason, note, handled_at, outcome from agent_reports where agent_id = $1 order by created_at`, [agentId])).rows;

const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const cwd = fileURLToPath(new URL("..", import.meta.url));
/** Runs the CLI as a process; its code and output. */
async function cli(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = { ...process.env, DATABASE_URL: testDatabaseUrl(), APP_ORIGIN: "http://localhost:5173", AUTH_SECRET: "test-secret-test-secret-test-secret-0000", PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000" };
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [tsx, "src/cli.ts", ...args], { cwd, env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
const TIMEOUT = 90_000;

describe("POST /api/reports", () => {
  it("a person reports an Agent they can see: 201 with an id; one row, with their shared social conversation if they have one; a counter, no text", async () => {
    const w = await world();
    const NOTE = "NOTE_CANARY 他一直发广告";
    const mine = await report(w.visitor, { agentId: w.agent.id, reason: "spam", note: NOTE });
    expect(mine.status).toBe(201);
    expect(Object.keys(mine.json)).toEqual(["id"]);
    // A stranger sees it by its handle (discoverable): reported with no conversation. A group-mate would too.
    const found = await report(w.stranger, { agentId: w.agent.id, reason: "other" });
    expect(found.status).toBe(201);
    const rows = await reports(w.agent.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ reporter_id: w.visitor.id, target_kind: "agent", agent_id: w.agent.id, conversation_id: w.conversationId, message_id: null, reason: "spam", note: NOTE, handled_at: null, outcome: null });
    expect(rows[1]).toMatchObject({ reporter_id: w.stranger.id, conversation_id: null, reason: "other", note: null });
    // The owner may report their own Agent's conversation partner... not a case: the owner sees their Agent and the row is theirs.
    expect((await report(w.owner, { agentId: w.agent.id, reason: "other" })).status).toBe(201);
    const counted = lines.filter((l) => l.includes("agent_reported"));
    expect(counted.length).toBeGreaterThanOrEqual(3);
    expect(lines.join("\n")).not.toContain("NOTE_CANARY");
  });

  it("the body: a reason from the four, a note of at most 500, nothing else; a person's id or a random one is no Agent", async () => {
    const w = await world();
    for (const body of [
      { agentId: w.agent.id },
      { agentId: w.agent.id, reason: "rude" },
      { agentId: w.agent.id, reason: "spam", note: "x".repeat(501) },
      { agentId: "not-a-uuid", reason: "spam" },
      { reason: "spam" },
    ]) expect([body, (await report(w.visitor, body)).status]).toEqual([body, 400]);
    expect((await report(w.visitor, { agentId: w.agent.id, reason: "spam", note: "x".repeat(500) })).status).toBe(201);
    const unknown = await report(w.visitor, { agentId: "00000000-0000-4000-8000-000000000000", reason: "spam" });
    const person = await report(w.visitor, { agentId: w.owner.id, reason: "spam" });
    expect(unknown.status).toBe(404);
    expect([person.status, person.json]).toEqual([unknown.status, unknown.json]);
    expect(await reports(w.agent.id)).toHaveLength(1);
  });

  it("an Agent the reporter cannot see is the answer of an Agent that is not there: undiscoverable, deleted, blocked either way, disabled, the switch off", async () => {
    const w = await world();
    const unknown = await report(w.stranger, { agentId: "00000000-0000-4000-8000-000000000000", reason: "spam" });
    const same = async (label: string) => {
      const got = await report(w.stranger, { agentId: w.agent.id, reason: "spam" });
      expect([label, got.status, got.json]).toEqual([label, unknown.status, unknown.json]);
    };
    await db.query(`update agents set contact_policy = 'none' where principal_id = $1`, [w.agent.id]);
    await same("policy none");
    await db.query(`update agents set contact_policy = 'ask' where principal_id = $1`, [w.agent.id]);
    await db.query(`update agents set disabled_at = now() where principal_id = $1`, [w.agent.id]);
    await same("disabled");
    await db.query(`update agents set disabled_at = null where principal_id = $1`, [w.agent.id]);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [w.owner.id, w.stranger.id]);
    await same("blocked by the owner");
    await db.query(`delete from blocks`);
    await db.query(`insert into blocks (blocker_id, blocked_id) values ($1, $2)`, [w.stranger.id, w.agent.id]);
    // What the reporter blocked stays theirs to see and to report.
    expect((await report(w.stranger, { agentId: w.agent.id, reason: "spam" })).status).toBe(201);
    await db.query(`delete from blocks`);
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      await same("switch off");
      expect((await report(w.stranger, { agentId: w.agent.id, reason: "spam" })).status).toBe(404);
    } finally {
      (app.deps.config as { social: unknown }).social = { enabled: true };
    }
    await db.query(`update agents set deleted_at = now() where principal_id = $1`, [w.agent.id]);
    await same("deleted");
    expect(await reports(w.agent.id)).toHaveLength(1);
  });

  it("a group-mate sees the Agent too, and the visitor of a conversation that has ended still reports it", async () => {
    const w = await world();
    const mate = await signUp(app, `rpm${++n}`);
    const other = await signUp(app, `rpn${n}`);
    await db.query(`update agents set contact_policy = 'none' where principal_id = $1`, [w.agent.id]);
    const g = await group(app, w.owner, "饭搭子", [mate, other]);
    expect((await api(app, w.owner, "POST", `/api/conversations/${g}/members`, { principalId: w.agent.id })).status).toBe(201);
    expect((await report(mate, { agentId: w.agent.id, reason: "harassment" })).status).toBe(201);
    expect((await reports(w.agent.id)).at(-1)).toMatchObject({ reporter_id: mate.id, conversation_id: null });
    expect((await report(w.visitor, { agentId: w.agent.id, reason: "privacy" })).status).toBe(201);
  });
});

describe("the operator's disable and enable", () => {
  /** An Agent's replies in its social conversation, a group and the owner's own: `others` (running, queued) and `own` ones. */
  async function runs(w: Awaited<ReturnType<typeof world>>) {
    // One active reply per Agent and conversation: a group for each.
    const newGroup = async () => (await db.query<{ id: string }>(`insert into conversations (type, creator_id, title) values ('group', $1, 'g') returning id`, [w.visitor.id])).rows[0]!.id;
    const make = async (conv: string, status: "queued" | "running", lane: "own" | "others" | "proactive", caller: string) =>
      (
        await db.query<{ id: string }>(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, pending_seq, triggered_by, lane, caller_id, started_at)
           values ('reply', $1, $2, $3, $4, 0, null, 'human', $5, $6, case when $4 = 'running' then now() end) returning id`,
          [conv, w.agent.id, w.owner.id, status, lane, caller],
        )
      ).rows[0]!.id;
    return {
      socialRunning: await make(w.conversationId, "running", "others", w.visitor.id),
      groupQueued: await make(await newGroup(), "queued", "others", w.visitor.id),
      proactiveQueued: await make(await newGroup(), "queued", "proactive", w.owner.id),
      ownRunning: await make(w.agent.conversationId, "running", "own", w.owner.id),
      ownQueued: await make(await newGroup(), "queued", "own", w.owner.id),
    };
  }
  const runOf = async (id: string) => (await db.query(`select status, error, interrupted from agent_runs where id = $1`, [id])).rows[0] as { status: string; error: string | null; interrupted: string | null };

  it("agent:disable by full handle: reach is gone for everyone but the owner (social and group), the lookup 404s, others' and proactive runs stop, the owner's own run goes on; agent:enable gives it all back with the rows untouched", async () => {
    const w = await world();
    const handle = await fullHandle(w.agent.id);
    const r = await runs(w);
    expect(await reach(db, w.visitor.id, w.agent.id, "social", on)).toBe("ok");
    const before = JSON.stringify((await db.query(`select * from agent_contacts order by agent_id, subject_id`)).rows);
    const out = await cli("agent:disable", handle);
    expect([out.code, out.stderr]).toEqual([0, ""]);
    expect(out.stdout).not.toContain("NOTE_CANARY");
    // The line says the truth about groups (A-4 review I1; the integration): the one access decision, asked in groups too.
    expect(out.stdout).toContain("refusedSql");
    expect(out.stdout).toContain("in groups too");
    expect(out.stdout).not.toContain("B5b");
    expect((await db.query(`select disabled_at is not null as d from agents where principal_id = $1`, [w.agent.id])).rows[0]).toEqual({ d: true });
    expect(await reach(db, w.visitor.id, w.agent.id, "social", on)).toBe("gone");
    expect(await reach(db, w.visitor.id, w.agent.id, "group", on)).toBe("gone");
    expect(await reach(db, w.owner.id, w.agent.id, "social", on)).toBe("ok");
    expect((await api(app, w.stranger, "GET", `/api/principals/lookup?handle=${handle}`)).status).toBe(404);
    // m5 (fix round 1): its owner is told, on the owner's own shape of the Agent; nobody else is sent the key.
    expect((await api(app, w.owner, "GET", `/api/agents/${w.agent.id}`)).json.operatorDisabled).toBe(true);
    expect(JSON.stringify((await api(app, w.visitor, "GET", "/api/sync")).json)).not.toContain("operatorDisabled");
    expect(await runOf(r.socialRunning)).toMatchObject({ status: "running", interrupted: "access_ended" });
    // (In a group a reply that ends so ends quietly, with no error: `access_ended` is a social run's.)
    expect(await runOf(r.groupQueued)).toMatchObject({ status: "cancelled", error: null });
    expect(await runOf(r.proactiveQueued)).toMatchObject({ status: "cancelled", error: null });
    expect(await runOf(r.ownRunning)).toMatchObject({ status: "running", interrupted: null });
    expect(await runOf(r.ownQueued)).toMatchObject({ status: "queued", interrupted: null });
    // Again: nothing more happens, and the same answer.
    expect((await cli("agent:disable", handle)).code).toBe(0);
    const back = await cli("agent:enable", handle);
    expect([back.code, back.stderr]).toEqual([0, ""]);
    expect(await reach(db, w.visitor.id, w.agent.id, "social", on)).toBe("ok");
    expect(await reach(db, w.visitor.id, w.agent.id, "group", on)).toBe("ok");
    expect((await api(app, w.stranger, "GET", `/api/principals/lookup?handle=${handle}`)).status).toBe(200);
    expect(JSON.stringify((await db.query(`select * from agent_contacts order by agent_id, subject_id`)).rows)).toBe(before);
    // A run stopped stays stopped.
    expect(await runOf(r.groupQueued)).toMatchObject({ status: "cancelled" });
  }, TIMEOUT);

  it("a disable keeps the owner's own call that is noted on an interrupted reply (A-4 review m2), and drops what another person's was", async () => {
    const w = await world();
    const handle = await fullHandle(w.agent.id);
    const noted = async (by: string) => {
      const g = (await db.query<{ id: string }>(`insert into conversations (type, creator_id, title) values ('group', $1, 'g') returning id`, [w.visitor.id])).rows[0]!.id;
      const seq = Number((await db.query<{ seq: string }>(`insert into messages (conversation_id, seq, sender_id, kind, body) values ($1, 1, $2, 'text', '{"text":"hi"}'::jsonb) returning seq::text as seq`, [g, by])).rows[0]!.seq);
      return (
        await db.query<{ id: string }>(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, pending_seq, triggered_by, lane, caller_id, started_at)
           values ('reply', $1, $2, $3, 'running', 0, $4, 'human', 'others', $5, now()) returning id`,
          [g, w.agent.id, w.owner.id, seq, w.visitor.id],
        )
      ).rows[0]!.id;
    };
    const ownerCall = await noted(w.owner.id);
    const visitorCall = await noted(w.visitor.id);
    expect((await cli("agent:disable", handle)).code).toBe(0);
    const read = async (id: string) => (await db.query(`select interrupted, pending_seq is not null as noted from agent_runs where id = $1`, [id])).rows[0];
    expect(await read(ownerCall)).toEqual({ interrupted: "access_ended", noted: true });
    expect(await read(visitorCall)).toEqual({ interrupted: "access_ended", noted: false });
  }, TIMEOUT);

  it("an unknown handle, a person's handle, an Agent that is deleted: refused, nothing changed", async () => {
    const w = await world();
    expect((await cli("agent:disable", "nobody_here.nothing")).code).not.toBe(0);
    expect((await cli("agent:disable", w.owner.handle)).code).not.toBe(0);
    expect((await cli("agent:disable")).code).not.toBe(0);
    await db.query(`update agents set deleted_at = now() where principal_id = $1`, [w.agent.id]);
    const gone = await cli("agent:disable", await fullHandle(w.agent.id));
    expect(gone.code).not.toBe(0);
    expect((await db.query(`select disabled_at from agents where principal_id = $1`, [w.agent.id])).rows[0].disabled_at).toBeNull();
  }, TIMEOUT);
});

describe("what the README says of a disable (A-4 review I1; the integration: tests/social-ring1a.test.ts proves the group half)", () => {
  it("says it takes effect through the one access decision, at every group site too, and how its replies are recorded", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const at = readme.indexOf("`agent:disable <full handle>` / `agent:enable <full handle>`");
    expect(at).toBeGreaterThan(0);
    const text = readme.slice(at, at + 1500).replace(/\s+/g, " ");
    expect(text).toContain("`refusedSql`");
    expect(text).toContain("every group site");
    expect(text).toContain("answers nobody but its owner, in a group too");
    expect(text).toContain("with no error in a group");
    expect(text).not.toContain("B5b");
  });
});

describe("one open report per reporter and Agent (fix round 1, m7)", () => {
  it("reporting the same Agent again while the first report is open makes no second row and answers with the first one's id; another person's is its own; after it is closed a new one is made", async () => {
    const w = await world();
    const first = await report(w.visitor, { agentId: w.agent.id, reason: "spam", note: "一" });
    expect(first.status).toBe(201);
    const again = await report(w.visitor, { agentId: w.agent.id, reason: "harassment", note: "二" });
    expect([again.status, again.json.id]).toEqual([201, first.json.id]);
    expect((await reports(w.agent.id)).map((r) => [r.reporter_id, r.reason, r.note])).toEqual([[w.visitor.id, "spam", "一"]]);
    expect((await report(w.owner, { agentId: w.agent.id, reason: "other" })).status).toBe(201);
    expect(await reports(w.agent.id)).toHaveLength(2);
    await db.query("update agent_reports set handled_at = now(), outcome = 'dismissed' where id = $1", [first.json.id]);
    const later = await report(w.visitor, { agentId: w.agent.id, reason: "privacy" });
    expect(later.status).toBe(201);
    expect(later.json.id).not.toBe(first.json.id);
    expect(await reports(w.agent.id)).toHaveLength(3);
  });
});

describe("reports:list and reports:close", () => {
  it("lists ids and prefixes, the Agent's handle, the reason and when: never a note or a message; --open leaves out the closed; close takes a prefix and an outcome, once", async () => {
    const w = await world();
    const handle = await fullHandle(w.agent.id);
    const NOTE = "NOTE_CANARY 他一直发广告";
    const a = await report(w.visitor, { agentId: w.agent.id, reason: "spam", note: NOTE });
    const b = await report(w.stranger, { agentId: w.agent.id, reason: "harassment" });
    const listed = await cli("reports:list");
    expect([listed.code, listed.stderr]).toEqual([0, ""]);
    expect(listed.stdout).not.toContain("NOTE_CANARY");
    expect(listed.stdout).not.toContain(w.visitor.id);
    expect(listed.stdout).toContain((a.json.id as string).slice(0, 8));
    expect(listed.stdout).not.toContain(a.json.id as string);
    expect(listed.stdout).toContain(handle);
    expect(listed.stdout).toContain("spam");
    expect(listed.stdout).toContain("harassment");
    const bad = await cli("reports:close", (a.json.id as string).slice(0, 8), "--outcome", "banished");
    expect(bad.code).not.toBe(0);
    expect((await cli("reports:close", (a.json.id as string).slice(0, 8))).code).not.toBe(0);
    const closed = await cli("reports:close", (a.json.id as string).slice(0, 8), "--outcome", "dismissed");
    expect([closed.code, closed.stderr]).toEqual([0, ""]);
    expect(closed.stdout).not.toContain("NOTE_CANARY");
    expect((await db.query(`select outcome, handled_at is not null as done from agent_reports where id = $1`, [a.json.id])).rows[0]).toEqual({ outcome: "dismissed", done: true });
    // Once: a closed report is not closed again; a prefix too short, or no report, is refused.
    expect((await cli("reports:close", (a.json.id as string).slice(0, 8), "--outcome", "disabled")).code).not.toBe(0);
    expect((await db.query(`select outcome from agent_reports where id = $1`, [a.json.id])).rows[0].outcome).toBe("dismissed");
    expect((await cli("reports:close", "abc", "--outcome", "disabled")).code).not.toBe(0);
    expect((await cli("reports:close", "ffffffff", "--outcome", "disabled")).code).not.toBe(0);
    const open = await cli("reports:list", "--open");
    expect(open.stdout).toContain((b.json.id as string).slice(0, 8));
    expect(open.stdout).not.toContain((a.json.id as string).slice(0, 8));
    // A dismissal turns nothing off; the outcome "disabled" is no trap (A-4 review m1): it disables the Agent, as agent:disable does.
    const disabledAt = async () => (await db.query(`select disabled_at is not null as d from agents where principal_id = $1`, [w.agent.id])).rows[0].d;
    expect(await disabledAt()).toBe(false);
    const gone = await cli("reports:close", (b.json.id as string).slice(0, 8), "--outcome", "disabled");
    expect([gone.code, gone.stderr]).toEqual([0, ""]);
    expect(gone.stdout).toContain("disabled");
    expect(gone.stdout).toContain("agent");
    expect((await db.query(`select outcome from agent_reports where id = $1`, [b.json.id])).rows[0].outcome).toBe("disabled");
    expect(await disabledAt()).toBe(true);
    expect(await reach(db, w.visitor.id, w.agent.id, "social", on)).toBe("gone");
  }, TIMEOUT);

  it("two reports of one Agent by one person at the same moment are one open report (review 2, n4: the index decides, not the read before the insert)", async () => {
    const owner = await signUp(app, "rpt2o");
    const visitor = await signUp(app, "rpt2v");
    const agent = (await mustCreateAgent(app, owner, { handle: "rpt2y", name: "rpt2y" })) as { id: string };
    await seedSocial(app, { owner, agentId: agent.id, visitor });
    const both = await Promise.all([1, 2, 3, 4].map(() => api(app, visitor, "POST", "/api/reports", { agentId: agent.id, reason: "spam" })));
    expect(both.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(new Set(both.map((r) => r.json.id)).size).toBe(1);
    expect((await db.query("select 1 from agent_reports where reporter_id = $1 and agent_id = $2", [visitor.id, agent.id])).rowCount).toBe(1);
    await expect(db.query("insert into agent_reports (reporter_id, target_kind, agent_id, reason) values ($1, 'agent', $2, 'spam')", [visitor.id, agent.id])).rejects.toThrow(/agent_reports_one_open_idx/);
  });

  it("a report that loses to one made at the same moment, which the operator closes before this one is answered: answered with the report that stood, never as an Agent that is not there (fix round 3, point 9)", async () => {
    const owner = await signUp(app, "rpt3o");
    const visitor = await signUp(app, "rpt3v");
    const agent = (await mustCreateAgent(app, owner, { handle: "rpt3y", name: "rpt3y" })) as { id: string };
    await seedSocial(app, { owner, agentId: agent.id, visitor });
    // The interleaving: the other request's report commits just before this call's ONE statement, which meets it; the operator
    // closes that report as soon as the statement has answered; this call is answered. A report is one statement and no other
    // (fix round 4, F7: no read before it, so there is no moment between a read and the insert).
    let n = 0;
    let other = "";
    const stepped = {
      query: (async (text: string, params?: unknown[]) => {
        n++;
        if (n === 1) other = (await db.query<{ id: string }>("insert into agent_reports (reporter_id, target_kind, agent_id, reason) values ($1, 'agent', $2, 'spam') returning id", [visitor.id, agent.id])).rows[0]!.id;
        const result = await db.query(text, params as never);
        if (n === 1) await db.query("update agent_reports set handled_at = now(), outcome = 'dismissed' where id = $1", [other]);
        return result;
      }) as typeof db.query,
    };
    const answered = await reportAgent(stepped as never, on, visitor.id, agent.id, "harassment", null);
    expect(answered).toBe(other);
    expect(n).toBe(1);
    expect((await db.query("select 1 from agent_reports where reporter_id = $1 and agent_id = $2", [visitor.id, agent.id])).rowCount).toBe(1);
  });

  it("a first report, and a second one while it is open, are one statement each (fix round 4, F7)", async () => {
    const owner = await signUp(app, "rpt4o");
    const visitor = await signUp(app, "rpt4v");
    const agent = (await mustCreateAgent(app, owner, { handle: "rpt4y", name: "rpt4y" })) as { id: string };
    await seedSocial(app, { owner, agentId: agent.id, visitor });
    const texts: string[] = [];
    const counted = { query: ((text: string, params?: unknown[]) => (texts.push(text), db.query(text, params as never))) as typeof db.query };
    const made = await reportAgent(counted as never, on, visitor.id, agent.id, "spam", "第一次");
    expect(made).not.toBeNull();
    expect(texts).toHaveLength(1);
    expect(await reportAgent(counted as never, on, visitor.id, agent.id, "harassment", "第二次")).toBe(made);
    expect(texts).toHaveLength(2);
    // The open report keeps its first reason and note.
    expect((await db.query("select reason, note from agent_reports where id = $1", [made])).rows).toEqual([{ reason: "spam", note: "第一次" }]);
  });
});
