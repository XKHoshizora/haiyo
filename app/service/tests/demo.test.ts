import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { DemoRefused, seedDemo } from "../src/demo.ts";
import { api, cookieHeaderFrom, signIn, signUp } from "./helpers/actors.ts";
import { SITE_ENV } from "./helpers/agents.ts";
import { testDatabaseUrl } from "./helpers/env.ts";
import { useApp } from "./helpers/harness.ts";

/**
 * `demo:seed` (src/demo.ts; README "Commands", Demo account): the account App Review signs in with, made once and put back
 * after, with a group, an Agent and a few messages of made-up people; never another account; no secret printed.
 */

const { app, db } = useApp({ env: SITE_ENV });

const EMAIL = "review@example.test";
const PASSWORD = "the reviewer's password";
const seed = (over: Partial<Parameters<typeof seedDemo>[3]> = {}) => seedDemo(app.deps.db, app.deps.config, app.auth, { email: EMAIL, password: PASSWORD, ...over });

const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0]!.n);
/** Everything the command makes or touches, counted. */
const totals = async () => ({
  people: await count("select count(*) n from principals where kind = 'human'"),
  agents: await count("select count(*) n from agents where deleted_at is null"),
  groups: await count("select count(*) n from conversations where type = 'group'"),
  messages: await count("select count(*) n from messages"),
  acceptances: await count("select count(*) n from terms_acceptances"),
});

async function signedIn(email: string, password: string) {
  const res = await signIn(app, email, password);
  expect(res.statusCode).toBe(200);
  return { cookie: cookieHeaderFrom(res.headers["set-cookie"]) };
}

/** The demo group as the reviewer reads it: its members' handles and its messages (sender handle, kind, text). */
async function demoGroup(reviewer: { cookie: string }) {
  const { rows } = await db.query<{ id: string }>("select id from conversations where type = 'group' and title = 'Weekend plans' and closed_at is null order by created_at desc limit 1");
  const id = rows[0]!.id;
  const members = await api<{ members: Array<{ handle: string; kind: string }> }>(app, reviewer, "GET", `/api/conversations/${id}/members`);
  const handles = await db.query<{ id: string; handle: string }>(
    "select p.id, coalesce(o.handle::text || '.', '') || p.handle::text as handle from principals p left join principals o on o.id = p.owner_id",
  );
  const handleOf = new Map(handles.rows.map((r) => [r.id, r.handle]));
  const said = await db.query<{ sender_id: string | null; kind: string; text: string | null }>(
    "select sender_id, kind, body->>'text' as text from messages where conversation_id = $1 and kind = 'text' order by seq",
    [id],
  );
  return {
    id,
    status: members.status,
    members: (members.json.members ?? []).map((m) => m.handle).sort(),
    said: said.rows.map((m) => [handleOf.get(m.sender_id ?? "") ?? null, m.text]),
  };
}

describe("demo:seed", () => {
  test("the first run makes a verified account that has accepted the terms, with an Agent and a group of four", async () => {
    const result = await seed();
    expect(result).toEqual({ created: true, email: EMAIL, handle: "app_review", agentHandle: "app_review.mochi", model: "fast", groupTitle: "Weekend plans" });
    const reviewer = await signedIn(EMAIL, PASSWORD);
    const me = await api(app, reviewer, "GET", "/api/me");
    expect(me.json).toMatchObject({ handle: "app_review", displayName: "Reviewer", termsAccepted: true });
    const group = await demoGroup(reviewer);
    expect(group.status).toBe(200);
    expect(group.members).toEqual(["app_review", "app_review.mochi", "app_review_mika", "app_review_ren"].sort());
    // Five lines by the two people, none by the Agent (it says only what its model writes).
    expect(group.said).toHaveLength(5);
    expect(new Set(group.said.map(([by]) => by))).toEqual(new Set(["app_review_mika", "app_review_ren"]));
    expect(await count("select count(*) n from messages m join agents a on a.principal_id = m.sender_id")).toBe(0);
    // Its Agent replies with the site's free model and is its owner's to talk to.
    const agents = await api<{ agents: Array<{ handle: string; model: unknown; paused: boolean }> }>(app, reviewer, "GET", "/api/agents");
    expect(agents.json.agents.map((a) => [a.handle, a.model, a.paused])).toEqual([["app_review.mochi", { source: "site", id: "fast" }, false]]);
    // Nobody can sign in as the two people.
    expect(await count(`select count(*) n from account a join principals p on p.auth_user_id = a."userId" where p.handle in ('app_review_mika', 'app_review_ren')`)).toBe(0);
  });

  test("a second run changes nothing but the password, and ends the sessions of the first", async () => {
    await seed();
    const before = await signedIn(EMAIL, PASSWORD);
    const counted = await totals();
    const again = await seed({ password: "a new reviewer password" });
    expect(again.created).toBe(false);
    expect(await totals()).toEqual(counted);
    expect((await api(app, before, "GET", "/api/me")).status).toBe(401);
    expect((await signIn(app, EMAIL, PASSWORD)).statusCode).toBe(401);
    const now = await signedIn(EMAIL, "a new reviewer password");
    expect((await demoGroup(now)).said).toHaveLength(5);
  });

  test("puts back what a review undid: a deleted Agent, a left group, a block, a paused Agent", async () => {
    await seed();
    const reviewer = await signedIn(EMAIL, PASSWORD);
    const first = await demoGroup(reviewer);
    const agent = (await api<{ agents: Array<{ id: string }> }>(app, reviewer, "GET", "/api/agents")).json.agents[0]!;
    const mika = (await db.query<{ id: string }>("select id from principals where handle = 'app_review_mika'")).rows[0]!.id;
    expect((await api(app, reviewer, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect((await api(app, reviewer, "PUT", `/api/blocks/${mika}`)).status).toBe(200);
    expect((await api(app, reviewer, "DELETE", `/api/conversations/${first.id}/members/${(await api(app, reviewer, "GET", "/api/me")).json.id}`)).status).toBe(200);

    await seed();
    const back = await signedIn(EMAIL, PASSWORD);
    const group = await demoGroup(back);
    expect(group.id).not.toBe(first.id);
    expect(group.members).toEqual(["app_review", "app_review.mochi", "app_review_mika", "app_review_ren"].sort());
    expect(group.said).toHaveLength(5);
    expect(await count("select count(*) n from blocks")).toBe(0);
    const agents = (await api<{ agents: Array<{ id: string; deleted: boolean; paused: boolean }> }>(app, back, "GET", "/api/agents")).json.agents.filter((a) => !a.deleted);
    expect(agents).toHaveLength(1);
    expect(agents[0]!.id).not.toBe(agent.id);

    expect((await api(app, back, "POST", `/api/agents/${agents[0]!.id}/pause`)).status).toBe(200);
    await seed();
    expect((await api<{ agents: Array<{ paused: boolean; deleted: boolean }> }>(app, await signedIn(EMAIL, PASSWORD), "GET", "/api/agents")).json.agents.filter((a) => !a.deleted).map((a) => a.paused)).toEqual([false]);
  });

  test("never touches an account that is not the demo account: its e-mail, its handle, or the people's handles", async () => {
    const someone = await signUp(app, "someone");
    const before = await totals();
    await expect(seed({ email: someone.email })).rejects.toThrow(DemoRefused);
    await expect(seed({ handle: someone.handle })).rejects.toThrow(DemoRefused);
    expect(await totals()).toEqual(before);
    expect((await signIn(app, someone.email, someone.password)).statusCode).toBe(200);

    const mika = await signUp(app, "app_review_mika");
    const withMika = await totals();
    await expect(seed()).rejects.toThrow(/app_review_mika belongs to someone else/);
    // One transaction: not even the reviewer's account is left behind.
    expect(await totals()).toEqual(withMika);
    expect(await count(`select count(*) n from "user" where email = $1`, [EMAIL])).toBe(0);
    expect((await signIn(app, mika.email, mika.password)).statusCode).toBe(200);
  });

  test("puts back a handle the reviewer changed, and says the handle it has", async () => {
    await seed();
    const reviewer = await signedIn(EMAIL, PASSWORD);
    expect((await api(app, reviewer, "PATCH", "/api/me", { handle: "renamed_review" })).status).toBe(200);
    const again = await seed();
    expect([again.handle, again.agentHandle]).toEqual(["app_review", "app_review.mochi"]);
    expect((await api(app, await signedIn(EMAIL, PASSWORD), "GET", "/api/me")).json.handle).toBe("app_review");
  });

  test("another e-mail for the same handle is told which demo account holds it", async () => {
    await seed();
    await expect(seed({ email: "someone-else@example.test" })).rejects.toThrow(/app_review is the demo account of review@example\.test/);
  });

  test("the two people's handles follow the reviewer's (a chosen --handle keeps them unguessable)", async () => {
    const r = await seed({ handle: "rev_x7q" });
    expect(r.handle).toBe("rev_x7q");
    const people = (await db.query<{ handle: string }>("select p.handle::text from principals p join demo_principals d on d.principal_id = p.id where d.role = 'member' order by 1")).rows.map((x) => x.handle);
    expect(people).toEqual(["rev_x7q_mika", "rev_x7q_ren"]);
  });

  test("an address of the two people already held by another account is a refusal, not a database error", async () => {
    await db.query(`insert into "user" (id, name, email, "emailVerified") values ('squatter', 'Squatter', 'app_review-mika@demo.invalid', false)`);
    await expect(seed()).rejects.toThrow(DemoRefused);
    expect(await count(`select count(*) n from "user" where email = $1`, [EMAIL])).toBe(0);
  });

  test("refuses a password shorter than 10 or longer than 128 characters, and a handle that is not one", async () => {
    await expect(seed({ password: "short" })).rejects.toThrow(DemoRefused);
    await expect(seed({ password: "x".repeat(129) })).rejects.toThrow(DemoRefused);
    await expect(seed({ handle: "Not A Handle" })).rejects.toThrow(DemoRefused);
    expect(await count(`select count(*) n from "user"`)).toBe(0);
  });
});

describe("the demo:seed command", () => {
  const tsx = createRequire(import.meta.url).resolve("tsx/cli");
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  async function cli(env: Record<string, string>, ...args: string[]) {
    const all = {
      ...process.env,
      ...SITE_ENV,
      DATABASE_URL: testDatabaseUrl(),
      APP_ORIGIN: "http://localhost:5173",
      AUTH_SECRET: "test-secret-test-secret-test-secret-0000",
      PROVIDER_KEY_SECRET: "test-provider-key-secret-0000000000",
      ...env,
    };
    delete (all as Record<string, string | undefined>).DEMO_PASSWORD;
    Object.assign(all, env);
    try {
      // stdin is not a terminal here: without DEMO_PASSWORD there is nobody to ask.
      const { stdout, stderr } = await promisify(execFile)(process.execPath, [tsx, "src/cli.ts", "demo:seed", ...args], { cwd, env: all });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const e = err as { code?: number; stdout?: string; stderr?: string };
      return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  test("without a password from the operator it stops and says how to give one; with one it never prints it", async () => {
    const none = await cli({}, "--email", EMAIL);
    expect(none.code).not.toBe(0);
    expect(none.stderr).toContain("DEMO_PASSWORD");
    expect(await count(`select count(*) n from "user"`)).toBe(0);

    const made = await cli({ DEMO_PASSWORD: PASSWORD }, "--email", EMAIL);
    expect(made.code).toBe(0);
    expect(made.stdout).toContain(EMAIL);
    expect(made.stdout).toContain("app_review");
    expect(made.stdout + made.stderr).not.toContain(PASSWORD);
    expect((await signIn(app, EMAIL, PASSWORD)).statusCode).toBe(200);

    const refused = await cli({ DEMO_PASSWORD: PASSWORD }, "--email", (await signUp(app, "other")).email);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("not the demo account");
    expect(refused.stdout + refused.stderr).not.toContain(PASSWORD);
  }, 90_000);
});
