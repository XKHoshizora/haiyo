import { afterEach, describe, expect, it, vi } from "vitest";
import { createInvite } from "../src/auth/invites.ts";
import { api, befriend, group, signUp, TERMS, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { holdThen, someoneWaits } from "./helpers/locks.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { closeAllSockets, connect, type Push } from "./helpers/ws.ts";

/**
 * Changing one's handle (Task N): `PATCH /api/me {handle}` once every 365 days (the first change waits for nothing). The
 * new handle must be free: no person's now, and none a person gave up — every handle a person gave up stays theirs for
 * good (they may take it back once their year has passed), never anyone else's, and names nobody while it is not their
 * current one. Everything that shows the handle follows at once, their Agents' full handles included; old messages keep
 * their text.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;
const DAY = 86_400_000;

const rename = (who: Actor, handle: string, more: Record<string, unknown> = {}) => api(app, who, "PATCH", "/api/me", { handle, ...more });
/** As if `who`'s last change was `days` days ago. */
const changedDaysAgo = (who: Actor, days: number) => db.query("update principals set handle_changed_at = now() - make_interval(days => $2) where id = $1", [who.id, days]);

async function register(handle: string) {
  const inviteCode = await createInvite(db, { ttlHours: 1 });
  return api(app, null, "POST", "/api/register", { inviteCode, email: `${handle}-${Date.now()}@example.test`, password: "a-long-password-1", displayName: handle, handle, ...TERMS });
}

let txn = 0;
const say = (who: Actor, conv: string, text: string) => api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ph${++txn}` });

describe("PATCH /api/me {handle}", () => {
  it("changes the handle: the answer, GET /api/me and lookup say the new one; the next change is a year away", async () => {
    const [xiaolin, bobby] = [await signUp(app, "xiaolin"), await signUp(app, "bobby")];
    expect((await api(app, xiaolin, "GET", "/api/me")).json.handleChangeAvailableAt).toBeNull();
    const before = Date.now();
    const res = await rename(xiaolin, "xiaolin_2");
    expect(res).toEqual({ status: 200, json: { id: xiaolin.id, handle: "xiaolin_2", displayName: "xiaolin", avatarVersion: 0 } });
    const me = (await api(app, xiaolin, "GET", "/api/me")).json;
    expect(me.handle).toBe("xiaolin_2");
    // A year after the change, by the database's clock (a little apart from this one's).
    const available = Date.parse(me.handleChangeAvailableAt);
    expect(available).toBeGreaterThanOrEqual(before + 365 * DAY - 60_000);
    expect(available).toBeLessThanOrEqual(Date.now() + 365 * DAY + 60_000);
    expect((await api(app, xiaolin, "GET", "/api/sync")).json.me.handle).toBe("xiaolin_2");
    expect((await api(app, bobby, "GET", "/api/principals/lookup?handle=xiaolin_2")).json).toMatchObject({ id: xiaolin.id, handle: "xiaolin_2" });
    expect((await api(app, bobby, "GET", "/api/principals/lookup?handle=xiaolin")).status).toBe(404);
  });

  it("a second change within the year is 429 handle_change_too_soon with availableAt; once the year has passed it is allowed again", async () => {
    const xiaolin = await signUp(app, "xiaolin");
    expect((await rename(xiaolin, "xiaolin_2")).status).toBe(200);
    const availableAt = (await api(app, xiaolin, "GET", "/api/me")).json.handleChangeAvailableAt;
    const soon = await rename(xiaolin, "xiaolin_3");
    expect(soon).toEqual({ status: 429, json: { error: "handle_change_too_soon", availableAt } });
    await changedDaysAgo(xiaolin, 364);
    expect((await rename(xiaolin, "xiaolin_3")).status).toBe(429);
    await changedDaysAgo(xiaolin, 366);
    expect((await rename(xiaolin, "xiaolin_3")).json.handle).toBe("xiaolin_3");
    // Too soon is said before whether the name is free.
    const other = await signUp(app, "other");
    expect((await rename(xiaolin, other.handle)).json.error).toBe("handle_change_too_soon");
  });

  it("the same handle again changes nothing and starts no year; a malformed one is 400", async () => {
    const xiaolin = await signUp(app, "xiaolin");
    expect((await rename(xiaolin, "xiaolin")).json.handle).toBe("xiaolin");
    expect((await api(app, xiaolin, "GET", "/api/me")).json.handleChangeAvailableAt).toBeNull();
    for (const bad of ["ab", "Xiaolin_2", "x".repeat(25), "xiao.lin", "xiao-lin", "", "小林"]) {
      expect([bad, (await rename(xiaolin, bad)).status]).toEqual([bad, 400]);
    }
    expect((await api(app, xiaolin, "GET", "/api/me")).json).toMatchObject({ handle: "xiaolin", handleChangeAvailableAt: null });
  });

  it("refuses a handle a person holds now with 409 handle_taken, and changes nothing else of the request", async () => {
    const [xiaolin, bobby] = [await signUp(app, "xiaolin"), await signUp(app, "bobby")];
    expect(await rename(xiaolin, "bobby", { displayName: "小林" })).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect(await rename(xiaolin, "BOBBY")).toMatchObject({ status: 400 });
    expect((await api(app, xiaolin, "GET", "/api/me")).json).toMatchObject({ handle: "xiaolin", displayName: "xiaolin", handleChangeAvailableAt: null });
    expect((await api(app, bobby, "GET", "/api/me")).json.handle).toBe("bobby");
  });

  it("an Agent's name part is no person's handle: a person may take one", async () => {
    const [xiaolin, bobby] = [await signUp(app, "xiaolin"), await signUp(app, "bobby")];
    await mustCreateAgent(app, bobby, { namePart: "jarvis" });
    expect((await rename(xiaolin, "jarvis")).json.handle).toBe("jarvis");
  });

  it("the old handle stays its former holder's: nobody else may register it or change to it; it finds nobody; its holder may take it back after a year", async () => {
    const [xiaolin, bobby] = [await signUp(app, "xiaolin"), await signUp(app, "bobby")];
    expect((await rename(xiaolin, "xiaolin_2")).status).toBe(200);
    // Somebody else: refused exactly as for a handle held now.
    expect(await rename(bobby, "xiaolin")).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect(await register("xiaolin")).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect(await register("xiaolin_2")).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect((await api(app, bobby, "GET", "/api/principals/lookup?handle=xiaolin")).status).toBe(404);
    expect((await api(app, bobby, "POST", "/api/friend-requests", { handle: "xiaolin" })).status).toBe(404);
    // Its former holder, once their year has passed: back to it; the one they leave is theirs too now.
    expect((await rename(xiaolin, "xiaolin")).status).toBe(429);
    await changedDaysAgo(xiaolin, 366);
    expect((await rename(xiaolin, "xiaolin")).json.handle).toBe("xiaolin");
    // Refused changes started no year for bobby; the one xiaolin left is still not his.
    expect(await rename(bobby, "xiaolin_2")).toEqual({ status: 409, json: { error: "handle_taken" } });
    expect((await db.query("select handle::text as handle, principal_id from reserved_handles order by handle")).rows).toEqual([
      { handle: "xiaolin", principal_id: xiaolin.id },
      { handle: "xiaolin_2", principal_id: xiaolin.id },
    ]);
  });

  it("everything that shows it follows at once — the person and their Agents, everywhere — and is pushed to whoever sees them; old messages keep their text", async () => {
    const [xiaolin, bobby, carla, dora] = [await signUp(app, "xiaolin"), await signUp(app, "bobby"), await signUp(app, "carla"), await signUp(app, "dora")];
    await befriend(app, xiaolin, carla);
    const g = await group(app, xiaolin, "family", [bobby, dora]);
    const agent = await mustCreateAgent(app, xiaolin, { namePart: "jarvis", model: FAST, persona: "简短。" });
    expect((await api(app, xiaolin, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const old = await say(bobby, g, "@xiaolin.jarvis 你好");
    expect(old.status).toBe(201);
    await db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");
    const [sb, sc, sx] = [await connect(app, bobby), await connect(app, carla), await connect(app, xiaolin)];

    expect((await rename(xiaolin, "lin")).status).toBe(200);
    const isPrincipal = (id: string) => (e: Push) => e.type === "principal" && e.id === id;
    expect(await sb.next(isPrincipal(xiaolin.id))).toEqual({ type: "principal", id: xiaolin.id, avatarVersion: 0, handle: "lin" });
    expect(await sb.next(isPrincipal(agent.id))).toEqual({ type: "principal", id: agent.id, avatarVersion: 0, handle: "lin.jarvis" });
    expect(await sc.next(isPrincipal(xiaolin.id))).toMatchObject({ handle: "lin" });
    expect(await sx.next(isPrincipal(agent.id))).toMatchObject({ handle: "lin.jarvis" });
    await sx.next((e) => e.type === "agent" && e.id === agent.id);

    // The owner's view of the Agent, a member's views of both, a friend's list.
    expect((await api(app, xiaolin, "GET", `/api/agents/${agent.id}`)).json.handle).toBe("lin.jarvis");
    const members = (await api(app, bobby, "GET", `/api/conversations/${g}/members`)).json.members;
    expect(Object.fromEntries(members.map((m: { id: string; handle: string }) => [m.id, m.handle]))).toMatchObject({ [xiaolin.id]: "lin", [agent.id]: "lin.jarvis" });
    const sync = (await api(app, bobby, "GET", "/api/sync")).json;
    expect(Object.fromEntries(sync.principals.map((p: { id: string; handle: string }) => [p.id, p.handle]))).toMatchObject({ [xiaolin.id]: "lin", [agent.id]: "lin.jarvis" });
    expect((await api(app, carla, "GET", "/api/social")).json.friends.find((f: { id: string }) => f.id === xiaolin.id).handle).toBe("lin");
    // The old message is as it was sent.
    const page = (await api(app, bobby, "GET", `/api/conversations/${g}/messages`)).json;
    expect(page.messages.find((m: { seq: number }) => m.seq === old.json.message.seq).text).toBe("@xiaolin.jarvis 你好");
    expect(page.principals[agent.id].handle).toBe("lin.jarvis");

    // A mention by the new full handle calls the Agent; by the old one, nobody.
    const runs = async () => Number((await db.query("select count(*) n from agent_runs where agent_id = $1 and conversation_id = $2", [agent.id, g])).rows[0].n);
    const had = await runs();
    expect((await say(bobby, g, "@xiaolin.jarvis 还在吗")).status).toBe(201);
    expect(await runs()).toBe(had);
    expect((await say(bobby, g, "@lin.jarvis 还在吗")).status).toBe(201);
    expect(await runs()).toBe(had + 1);
  });

  it("once committed it stands: a push failing afterwards does not answer an error; deleted Agents get no principal push (fix round 1, M2)", async () => {
    const xiaolin = await signUp(app, "xiaolin");
    const live = await mustCreateAgent(app, xiaolin, { namePart: "jarvis" });
    const gone = await mustCreateAgent(app, xiaolin, { namePart: "gone" });
    expect((await api(app, xiaolin, "DELETE", `/api/agents/${gone.id}`)).status).toBe(200);
    const pushed = vi.spyOn(app.realtime, "pushPrincipalChanged").mockRejectedValue(new Error("the hub is down"));
    try {
      expect(await rename(xiaolin, "lin")).toEqual({ status: 200, json: { id: xiaolin.id, handle: "lin", displayName: "xiaolin", avatarVersion: 0 } });
      expect(pushed.mock.calls.map(([id]) => id)).toEqual([xiaolin.id, live.id]);
    } finally {
      pushed.mockRestore();
    }
    expect((await api(app, xiaolin, "GET", "/api/me")).json.handle).toBe("lin");
  });

  it("is a person's own: an Agent's handle cannot be changed this way, nor anyone else's", async () => {
    const [xiaolin, bobby] = [await signUp(app, "xiaolin"), await signUp(app, "bobby")];
    const agent = await mustCreateAgent(app, xiaolin, { namePart: "jarvis" });
    expect((await api(app, xiaolin, "PATCH", `/api/agents/${agent.id}`, { handle: "jarvis_2" })).status).toBe(400);
    expect((await api(app, xiaolin, "PATCH", `/api/agents/${agent.id}`, { namePart: "jarvis_2" })).status).toBe(400);
    expect((await api(app, null, "PATCH", "/api/me", { handle: "xiaolin_9" })).status).toBe(401);
    expect((await rename(xiaolin, "xiaolin_9", { id: bobby.id })).json.handle).toBe("xiaolin_9");
    expect((await api(app, bobby, "GET", "/api/me")).json.handle).toBe("bobby");
  });

  /**
   * `PATCH /api/me {handle, …a memory setting}` beside a transaction that takes `first`, then — once the change is under
   * way — `then`: whichever order the two take the person's row and their account's in, nothing waits in a circle and both
   * commit (final review m-7; round 2, N-2: the change locks the person's row as an update that changes no key does, so no
   * foreign key's check on it ever waits for it).
   */
  async function renameBeside(name: string, first: (id: string) => readonly [string, readonly unknown[]], then: (id: string) => readonly [string, readonly unknown[]]) {
    const who = await signUp(app, name);
    // An account row to update (as a person who has used the site has).
    await db.query("insert into accounts (principal_id) values ($1) on conflict do nothing", [who.id]);
    const other = holdThen(db, first(who.id), then(who.id));
    await other.locked;
    const renaming = rename(who, `${name}_2`, { dream: false, memoryLanguage: "ja" });
    // The change either goes through at once or waits for what the other holds; then the other asks for its second lock.
    await Promise.race([renaming, someoneWaits(db, ["%for update%", "%for no key update%", "%insert into accounts%"])]).finally(() => other.release());
    await other.done;
    expect((await renaming).status).toBe(200);
    expect((await api(app, who, "GET", "/api/me")).json.handle).toBe(`${name}_2`);
    expect((await db.query("select dream, memory_language from accounts where principal_id = $1", [who.id])).rows).toEqual([{ dream: false, memory_language: "ja" }]);
  }

  it("with a memory setting in the same body, beside a send of theirs (its message's foreign key holds their row, then a mention locks their account): both commit (final review m-7)", async () => {
    await renameBeside(
      "xiaolin",
      (id) => ["select 1 from principals where id = $1 for key share", [id]],
      (id) => ["select 1 from accounts where principal_id = $1 for update", [id]],
    );
  });

  it("with a memory setting in the same body, beside a settlement of their reply (it locks their account, then its usage record's foreign key takes their row): both commit (round 2, N-2)", async () => {
    await renameBeside(
      "xiaoli",
      (id) => ["select 1 from accounts where principal_id = $1 for update", [id]],
      (id) => ["select 1 from principals where id = $1 for key share", [id]],
    );
  });
});
