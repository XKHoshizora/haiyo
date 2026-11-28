import pg from "pg";
import { describe, expect, it, vi } from "vitest";
import { api, befriend, group, signUp, type Actor, type ApiResult } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { seedSocialAgents, SOCIAL_ON } from "./helpers/social.ts";

// Finding someone's Agent (find-agent design, rulings D1, D4–D8): `GET /api/principals/search` — the caller's circle by any
// fragment of a name, and, asked explicitly (`exact=1`), one person by their exact handle with their Agents, or one Agent by its
// full handle — and `GET /api/principals/agent-card/:id`. Every Agent passes `discoverableSql`, inside each query.
const lines: string[] = [];
// A tier above the old sketch's cut of 50: a person's Agents are all listed, up to what an account may own (D7).
const { app, db } = useApp({
  env: { ...SITE_ENV, AGENT_TIERS: JSON.stringify({ free: 20, plus: 60 }) },
  config: SOCIAL_ON,
  agentWorker: false,
  logStream: { write: (line) => void lines.push(line) },
});

const search = (who: Actor, q: string, exact = false) =>
  api(app, who, "GET", `/api/principals/search?q=${encodeURIComponent(q)}${exact ? "&exact=1" : ""}`);
const card = (who: Actor, id: string) => api(app, who, "GET", `/api/principals/agent-card/${id}`);
const circleIds = (r: ApiResult) => (r.json.circle as Array<{ id: string }>).map((c) => c.id);
const sql = (q: string, p: unknown[] = []) => db.query(q, p);
const rename = (id: string, name: string) => sql("update principals set display_name = $2 where id = $1", [id, name]);
/** The operator moves an account to the tier of 60 Agents (its row may not exist yet: one never touched reads as `free`). */
const plusTier = (id: string) => sql("insert into accounts (principal_id, tier) values ($1, 'plus') on conflict (principal_id) do update set tier = 'plus'", [id]);
const addToGroup = async (who: Actor, g: string, principalId: string) => expect((await api(app, who, "POST", `/api/conversations/${g}/members`, { principalId })).status).toBe(201);
const leaveGroup = async (who: Actor, g: string, principalId: string) => expect((await api(app, who, "DELETE", `/api/conversations/${g}/members/${principalId}`)).status).toBe(200);

const lookup = (who: Actor, handle: string) => api(app, who, "GET", `/api/principals/lookup?handle=${handle}`);

/**
 * Every statement one call sends to the database, on any connection — the pool's, a transaction's (the explicit step reads on one
 * snapshot), the session's own (the same for every call compared).
 */
async function counted(fn: () => Promise<ApiResult>): Promise<ApiResult & { queries: number }> {
  const spy = vi.spyOn(pg.Client.prototype, "query");
  try {
    const r = await fn();
    return { ...r, queries: spy.mock.calls.length };
  } finally {
    spy.mockRestore();
  }
}

interface MadeAgent {
  id: string;
  handle: string;
  avatarVersion: number;
  field: string;
}
// Every Agent has a field: the one card shape carries it (fix round 1, F4).
const agentOf = (owner: Actor, namePart: string, name: string, intro = "") =>
  mustCreateAgent(app, owner, { handle: namePart, name, intro, field: `${namePart} field` }) as Promise<MadeAgent>;
/** The card of an Agent as every route answers it: the lookup's card, `field` included (fix round 1, F4). */
const cardOf = (a: MadeAgent, owner: Actor, ownerName: string, displayName: string, intro: string) => ({
  id: a.id,
  handle: a.handle,
  displayName,
  avatarVersion: a.avatarVersion,
  kind: "agent",
  ownerId: owner.id,
  ownerName,
  intro,
  field: a.field,
});
const CARD_KEYS = ["avatarVersion", "displayName", "field", "handle", "id", "intro", "kind", "ownerId", "ownerName"];
const PERSON_KEYS = ["avatarVersion", "displayName", "handle", "id"];

describe("the circle: friends and their Agents", () => {
  it("matches a fragment of a friend's name or handle, and of a friend's Agent's name, name part, full handle or owner's name; unfriending ends it", async () => {
    const me = await signUp(app, "cme");
    const fred = await signUp(app, "cfred");
    await rename(fred.id, "Fred Kite");
    await befriend(app, me, fred);
    const kite = await agentOf(fred, "kitebot", "Hawk", "flies over maps");
    const quiet = await agentOf(fred, "hk_bot", "Owl");

    const r = await search(me, "kite");
    expect(r.status).toBe(200);
    expect(Object.keys(r.json)).toEqual(["circle"]); // typing suggests the circle only (D6)
    // The person by their display name; both Agents by their owner's name (Hawk also by its name part), the person first, then by name.
    expect(r.json.circle).toEqual([
      { id: fred.id, handle: "cfred", displayName: "Fred Kite", avatarVersion: 0 },
      { ...cardOf(kite, fred, "Fred Kite", "Hawk", "flies over maps"), via: "friend" },
      { ...cardOf(quiet, fred, "Fred Kite", "Owl", ""), via: "friend" },
    ]);
    expect(Object.keys(r.json.circle[0]).sort()).toEqual(PERSON_KEYS);
    expect(Object.keys(r.json.circle[1]).sort()).toEqual([...CARD_KEYS, "via"].sort());
    // One card shape: an Agent of the circle is the lookup's answer for its handle, and why it is there (F4).
    expect(r.json.circle[1]).toEqual({ ...(await lookup(me, kite.handle)).json, via: "friend" });
    expect(r.json.circle[0]).toEqual((await lookup(me, fred.handle)).json);

    expect(circleIds(await search(me, "HAWK"))).toEqual([kite.id]); // the Agent's name, case ignored
    expect(circleIds(await search(me, "cfred.kite"))).toEqual([kite.id]); // its full handle
    expect(circleIds(await search(me, "hk_b"))).toEqual([quiet.id]); // its name part
    expect(circleIds(await search(me, "  @cfred  "))).toEqual([fred.id, kite.id, quiet.id]); // trimmed, a leading @ dropped
    expect(circleIds(await search(me, "fred k"))).toEqual([fred.id, kite.id, quiet.id]); // Hawk and Owl by their owner's name only
    expect(await search(me, "")).toEqual({ status: 200, json: { circle: [] } });
    expect(await search(me, "   @ ")).toEqual({ status: 200, json: { circle: [] } });
    expect(await search(me, "nothing like it")).toEqual({ status: 200, json: { circle: [] } });

    expect((await api(app, me, "DELETE", `/api/friends/${fred.id}`)).status).toBe(200);
    expect(await search(me, "kite")).toEqual({ status: 200, json: { circle: [] } });
  });

  it("a friend I block, or who blocks me, is still my friend; their Agents are not listed either way", async () => {
    const me = await signUp(app, "bme");
    const fred = await signUp(app, "bfred");
    await befriend(app, me, fred);
    const bot = await agentOf(fred, "bbot", "Bee");
    expect(circleIds(await search(me, "bfred"))).toEqual([fred.id, bot.id]);
    for (const [blocker, blocked] of [
      [me.id, fred.id],
      [fred.id, me.id],
      [me.id, bot.id],
    ]) {
      await sql("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [blocker, blocked]);
      expect(circleIds(await search(me, "bfred"))).toEqual([fred.id]);
      await sql("delete from blocks");
    }
    expect(circleIds(await search(me, "bfred"))).toEqual([fred.id, bot.id]);
  });
});

describe("the circle: a friendship row that names an Agent", () => {
  it("is no friend: the schema lets such a row be stored, and the Agent is never a person's card, hidden or not (F2)", async () => {
    const me = await signUp(app, "rme");
    const ann = await signUp(app, "rann");
    const bot = await agentOf(ann, "rowbot", "Rowan");
    await sql("insert into friendships (a_id, b_id) values (least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid))", [me.id, bot.id]);
    await sql("update agents set disabled_at = now() where principal_id = $1", [bot.id]);
    expect(await search(me, "rowan")).toEqual({ status: 200, json: { circle: [] } });
    expect(await search(me, "rann.rowbot")).toEqual({ status: 200, json: { circle: [] } });
    await sql("update agents set disabled_at = null where principal_id = $1", [bot.id]);
    expect(await search(me, "rowan")).toEqual({ status: 200, json: { circle: [] } });
  });
});

describe("the explicit step: one moment", () => {
  it("reads the circle and the exact match on one snapshot: an Agent hidden between the two reads is in both or in neither (F1)", async () => {
    const me = await signUp(app, "pme");
    const fred = await signUp(app, "pfred");
    await befriend(app, me, fred);
    const bot = await agentOf(fred, "snapbot", "Snap");
    const original = pg.Client.prototype.query as (...a: unknown[]) => unknown;
    let hidden = false;
    const hide = () => db.query("update agents set contact_policy = 'none' where principal_id = $1", [bot.id]);
    // The moment the circle's statement has its answer, the Agent stops taking contacts (another connection, committed at once).
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const [text, values, done] = args;
      const statement = typeof text === "string" ? text : (text as { text?: string } | undefined)?.text;
      if (hidden || typeof statement !== "string" || !statement.includes("with friends as")) return original.apply(this, args);
      hidden = true;
      if (typeof done === "function") {
        return original.call(this, text, values, (err: unknown, res: unknown) => void hide().finally(() => (done as (e: unknown, r: unknown) => void)(err, res)));
      }
      return (original.call(this, text, values) as Promise<unknown>).then(async (res) => {
        await hide();
        return res;
      });
    } as typeof pg.Client.prototype.query);
    let r: ApiResult;
    try {
      r = await search(me, "pfred.snapbot", true);
    } finally {
      spy.mockRestore();
    }
    expect(hidden).toBe(true);
    expect([circleIds(r), r.json.exact?.agent?.id ?? null]).toEqual([[bot.id], bot.id]);
    // Asked again, it is hidden in both.
    expect(await search(me, "pfred.snapbot", true)).toEqual({ status: 200, json: { circle: [], exact: null } });
  });
});

describe("the circle: Agents in my groups", () => {
  it("an Agent that is a current member of a group I am a current member of; not after I leave, am removed, or it is removed", async () => {
    const me = await signUp(app, "gme");
    const host = await signUp(app, "ghost");
    const gina = await signUp(app, "ggina"); // not my friend: host's
    const g = await group(app, host, "g", [me, gina]);
    const bot = await agentOf(gina, "grpbot", "Grouper", "in the group");
    await addToGroup(gina, g, bot.id);

    const found = await search(me, "grouper");
    expect(found.json.circle).toEqual([{ ...cardOf(bot, gina, "ggina", "Grouper", "in the group"), via: "group" }]);
    // Gina herself is no friend of mine: only her Agent, by its full handle.
    expect(circleIds(await search(me, "ggina"))).toEqual([bot.id]);

    await leaveGroup(me, g, me.id);
    expect(circleIds(await search(me, "grouper"))).toEqual([]);
    await addToGroup(host, g, me.id);
    expect(circleIds(await search(me, "grouper"))).toEqual([bot.id]);
    await leaveGroup(host, g, me.id); // removed
    expect(circleIds(await search(me, "grouper"))).toEqual([]);
    await addToGroup(host, g, me.id);
    await leaveGroup(gina, g, bot.id); // the Agent removed
    expect(circleIds(await search(me, "grouper"))).toEqual([]);
  });

  it("never a social conversation's members: watching my Agent's talk with a stranger's Agent lists nobody", async () => {
    const me = await signUp(app, "sme");
    const stranger = await signUp(app, "sstranger");
    const mine = await agentOf(me, "mybot", "Mine");
    const theirs = await agentOf(stranger, "farbot", "Faraway");
    // I am the observer there (its owner), and the stranger's Agent's row is my Agent's: its person is me, its subject is not.
    await seedSocialAgents(app, { x: mine.id, y: theirs.id });
    expect((await db.query("select 1 from agent_contacts where agent_id = $1 and person_id = $2", [theirs.id, me.id])).rowCount).toBe(1);
    expect(circleIds(await search(me, "faraway"))).toEqual([]);
    expect(circleIds(await search(me, "sstranger"))).toEqual([]);
  });
});

describe("the circle: Agents I added", () => {
  it("an Agent with a row whose subject is me, in any state, is listed as a contact; the stranger's other Agents are not", async () => {
    const me = await signUp(app, "ame");
    const sam = await signUp(app, "asam");
    const added = await agentOf(sam, "addedbot", "Added One");
    const other = await agentOf(sam, "otherbot", "Other One");
    expect(circleIds(await search(me, "one"))).toEqual([]);
    expect((await api(app, me, "POST", "/api/agent-contacts", { agentId: added.id })).status).toBe(202);
    const r = await search(me, "one");
    expect(r.json.circle).toEqual([{ ...cardOf(added, sam, "asam", "Added One", ""), via: "contact" }]);
    for (const state of ["live", "ended"]) {
      await sql(
        `update agent_contacts set state = $2, basis = case when $2 = 'live' then 'approved' end, until = null,
                end_reason = case when $2 = 'ended' then 'declined' end where agent_id = $1`,
        [added.id, state],
      );
      expect([state, circleIds(await search(me, "one"))]).toEqual([state, [added.id]]);
    }
    expect(circleIds(await search(me, "other"))).toEqual([]);
    expect(other.id).not.toBe(added.id);
  });
});

describe("the circle: what is hidden, and its order", () => {
  it("hidden Agents are filtered inside the query: the same body and the same number of statements as when they do not exist", async () => {
    const me = await signUp(app, "hme");
    const fred = await signUp(app, "hfred");
    await befriend(app, me, fred);
    const shown = await agentOf(fred, "shown", "Kit Shown");
    const missing = await counted(() => search(me, "kit"));
    expect(circleIds(missing)).toEqual([shown.id]);

    const hidden = await agentOf(fred, "hidden", "Kit Hidden");
    expect(circleIds(await search(me, "kit"))).toEqual([hidden.id, shown.id]);
    const hides: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      ["policy none", () => sql("update agents set contact_policy = 'none' where principal_id = $1", [hidden.id]), () => sql("update agents set contact_policy = 'ask' where principal_id = $1", [hidden.id])],
      ["disabled", () => sql("update agents set disabled_at = now() where principal_id = $1", [hidden.id]), () => sql("update agents set disabled_at = null where principal_id = $1", [hidden.id])],
      ["I block it", () => sql("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [me.id, hidden.id]), () => sql("delete from blocks")],
    ];
    for (const [name, hide, undo] of hides) {
      await hide();
      const r = await counted(() => search(me, "kit"));
      expect([name, r.status, r.json, r.queries]).toEqual([name, missing.status, missing.json, missing.queries]);
      await undo();
    }
    expect((await api(app, fred, "DELETE", `/api/agents/${hidden.id}`)).status).toBe(200);
    const deleted = await counted(() => search(me, "kit"));
    expect([deleted.json, deleted.queries]).toEqual([missing.json, missing.queries]);

    // My own Agents are never mine to find, not even in a group I share with them.
    const g = await group(app, me, "mine", [fred, await signUp(app, "hthird")]);
    const own = await agentOf(me, "ownkit", "Kit Own");
    await addToGroup(me, g, own.id);
    expect(circleIds(await search(me, "kit"))).toEqual([shown.id]);
  });

  it("at most 20, a hidden Agent displacing none; people, then friends' Agents, then group Agents, then contacts, each by name; each once", async () => {
    const me = await signUp(app, "ome");
    const amy = await signUp(app, "oamy");
    const zed = await signUp(app, "ozed");
    const gus = await signUp(app, "ogus"); // in my group, not my friend
    const cal = await signUp(app, "ocal"); // a stranger whose Agent I added
    await befriend(app, me, amy);
    await befriend(app, me, zed);
    await rename(amy.id, "Ord Amy");
    await rename(zed.id, "Ord Zed");
    const fb = await agentOf(zed, "ord_b", "Ord B");
    const fa = await agentOf(amy, "ord_a", "Ord A");
    const gx = await agentOf(gus, "ord_g", "Ord G");
    const ct = await agentOf(cal, "ord_c", "Ord C");
    const g = await group(app, amy, "ord", [me, gus]);
    await addToGroup(gus, g, gx.id);
    await addToGroup(amy, g, fa.id); // a friend's Agent in my group too: listed once, as a friend's
    expect((await api(app, me, "POST", "/api/agent-contacts", { agentId: ct.id })).status).toBe(202);
    expect((await api(app, me, "POST", "/api/agent-contacts", { agentId: fb.id })).status).toBe(202); // a friend's, added too
    const r = await search(me, "ord");
    expect((r.json.circle as Array<{ id: string; via?: string }>).map((c) => [c.id, c.via])).toEqual([
      [amy.id, undefined],
      [zed.id, undefined],
      [fa.id, "friend"],
      [fb.id, "friend"],
      [gx.id, "group"],
      [ct.id, "contact"],
    ]);

    const many = await signUp(app, "omany");
    await befriend(app, me, many);
    await plusTier(many.id);
    const made: MadeAgent[] = [];
    for (let i = 2; i <= 22; i++) made.push(await agentOf(many, `lim_${i}`, `Lim ${String(i).padStart(2, "0")}`));
    const twenty = await search(me, "lim");
    expect(circleIds(twenty)).toEqual(made.slice(0, 20).map((a) => a.id));
    // One more, first by name and hidden: the same twenty.
    const first = await agentOf(many, "lim_1", "Lim 01");
    await sql("update agents set contact_policy = 'none' where principal_id = $1", [first.id]);
    expect(circleIds(await search(me, "lim"))).toEqual(made.slice(0, 20).map((a) => a.id));
  }, 60_000);

  it("the wildcards of LIKE are plain characters", async () => {
    const me = await signUp(app, "wme");
    const pct = await signUp(app, "pct_one");
    const txo = await signUp(app, "ptxone");
    await befriend(app, me, pct);
    await befriend(app, me, txo);
    await rename(pct.id, "100% sure");
    await rename(txo.id, "1000 sure");
    expect(circleIds(await search(me, "100%"))).toEqual([pct.id]);
    expect(circleIds(await search(me, "t_o"))).toEqual([pct.id]);
    expect(circleIds(await search(me, "%"))).toEqual([pct.id]);
    expect(circleIds(await search(me, "_"))).toEqual([pct.id]);
    expect(circleIds(await search(me, "\\"))).toEqual([]);
  });
});

describe("the exact step: a person by their handle, and their Agents", () => {
  it("lists every Agent of theirs that is discoverable to me, by name, as cards with no field; typing alone never reaches them", async () => {
    const me = await signUp(app, "xme");
    const ann = await signUp(app, "xann");
    const bravo = await agentOf(ann, "bravo_np", "Bravo", "second");
    const alpha = await agentOf(ann, "alpha_np", "Alpha", "first");
    const none = await agentOf(ann, "delta_np", "Delta");
    const off = await agentOf(ann, "echo_np", "Echo");
    const gone = await agentOf(ann, "fox_np", "Fox");
    await sql("update agents set contact_policy = 'none' where principal_id = $1", [none.id]);
    await sql("update agents set disabled_at = now() where principal_id = $1", [off.id]);
    expect((await api(app, ann, "DELETE", `/api/agents/${gone.id}`)).status).toBe(200);

    expect(await search(me, "xann")).toEqual({ status: 200, json: { circle: [] } });
    const r = await search(me, "xann", true);
    expect(r).toEqual({
      status: 200,
      json: {
        circle: [],
        exact: {
          person: { id: ann.id, handle: "xann", displayName: "xann", avatarVersion: 0 },
          agents: [cardOf(alpha, ann, "xann", "Alpha", "first"), cardOf(bravo, ann, "xann", "Bravo", "second")],
        },
      },
    });
    for (const a of r.json.exact.agents) {
      expect(Object.keys(a).sort()).toEqual(CARD_KEYS);
      expect(a).toEqual((await lookup(me, a.handle)).json); // the lookup's card (F4)
    }
    expect(r.json.exact.person).toEqual((await lookup(me, "xann")).json);
    expect((await search(me, " @XANN ", true)).json).toEqual(r.json);

    // A block either way: the person as the lookup answers them, no Agent.
    for (const [blocker, blocked] of [
      [me.id, ann.id],
      [ann.id, me.id],
    ]) {
      await sql("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [blocker, blocked]);
      expect((await search(me, "xann", true)).json.exact).toEqual({ person: r.json.exact.person, agents: [] });
      await sql("delete from blocks");
    }
    // My own handle: me, and none of my Agents.
    await agentOf(me, "minebot", "Mine");
    expect((await search(me, me.handle, true)).json.exact).toEqual({ person: { id: me.id, handle: me.handle, displayName: "xme", avatarVersion: 0 }, agents: [] });
  });

  it("a hidden Agent and a missing one: the same list, the same number of statements", async () => {
    const me = await signUp(app, "yme");
    const ann = await signUp(app, "yann");
    await agentOf(ann, "seen_np", "Seen");
    const missing = await counted(() => search(me, "yann", true));
    expect(missing.json.exact.agents).toHaveLength(1);
    const hidden = await agentOf(ann, "hid_np", "Hid");
    await sql("update agents set contact_policy = 'none' where principal_id = $1", [hidden.id]);
    const r = await counted(() => search(me, "yann", true));
    expect([r.status, r.json, r.queries]).toEqual([missing.status, missing.json, missing.queries]);
  });

  it("all of them up to the most an account may own: no cut at 50, no pages", async () => {
    const me = await signUp(app, "zme");
    const big = await signUp(app, "zbig");
    await plusTier(big.id);
    for (let i = 1; i <= 55; i++) await agentOf(big, `z_${i}`, `Z ${String(i).padStart(2, "0")}`);
    const agents = (await search(me, "zbig", true)).json.exact.agents as Array<{ displayName: string }>;
    expect(agents).toHaveLength(55);
    expect(agents.map((a) => a.displayName)).toEqual(Array.from({ length: 55 }, (_, i) => `Z ${String(i + 1).padStart(2, "0")}`));
  }, 120_000);

  it("an unknown handle, a handle given up and anything that is no handle: null", async () => {
    const me = await signUp(app, "nme");
    const ann = await signUp(app, "nann");
    expect((await api(app, ann, "PATCH", "/api/me", { handle: "nann_new" })).status).toBe(200);
    for (const q of ["nobody_here", "nann", "ab", "two words", "x".repeat(25), "nann_new."]) {
      expect([q, await search(me, q, true)]).toEqual([q, { status: 200, json: { circle: [], exact: null } }]);
    }
    expect((await search(me, "", true)).json).toEqual({ circle: [], exact: null });
    expect((await search(me, "nann_new", true)).json.exact.person.id).toBe(ann.id);
  });
});

describe("the exact step: an Agent by its full handle", () => {
  it("its card (no field), however cased; a hidden one is answered as one nobody has, statement for statement", async () => {
    const me = await signUp(app, "kme");
    const ann = await signUp(app, "kann");
    const bot = await agentOf(ann, "kbot", "Kay", "knows things");
    const r = await search(me, "@KANN.KBOT", true);
    expect(r).toEqual({ status: 200, json: { circle: [], exact: { agent: cardOf(bot, ann, "kann", "Kay", "knows things") } } });
    // Today's lookup answer for the same handle, byte for byte (F4).
    const looked = await app.inject({ method: "GET", url: "/api/principals/lookup?handle=kann.kbot", headers: { cookie: me.cookie } });
    const searched = await app.inject({ method: "GET", url: "/api/principals/search?q=kann.kbot&exact=1", headers: { cookie: me.cookie } });
    expect(searched.body).toBe(`{"circle":[],"exact":{"agent":${looked.body}}}`);

    const unknown = await counted(() => search(me, "kann.nobody", true));
    expect(unknown.json).toEqual({ circle: [], exact: null });
    await sql("update agents set contact_policy = 'none' where principal_id = $1", [bot.id]);
    const hidden = await counted(() => search(me, "kann.kbot", true));
    expect([hidden.status, hidden.json, hidden.queries]).toEqual([unknown.status, unknown.json, unknown.queries]);
  });
});

describe("GET /api/principals/agent-card/:id", () => {
  it("a discoverable Agent's card; a hidden, missing, own or malformed id: one 404, statement for statement", async () => {
    const me = await signUp(app, "dme");
    const ann = await signUp(app, "dann");
    const bot = await agentOf(ann, "dbot", "Dee", "card intro");
    const r = await card(me, bot.id);
    expect(r).toEqual({ status: 200, json: cardOf(bot, ann, "dann", "Dee", "card intro") });
    expect(Object.keys(r.json).sort()).toEqual(CARD_KEYS);
    expect(r.json).toEqual((await lookup(me, bot.handle)).json); // the lookup's card (F4)
    expect(await card(me, bot.id.toUpperCase())).toEqual(r);

    const missing = await counted(() => card(me, "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d"));
    expect([missing.status, missing.json]).toEqual([404, { error: "not_found" }]);
    const hides: Array<[string, () => Promise<unknown>, () => Promise<unknown>]> = [
      ["policy none", () => sql("update agents set contact_policy = 'none' where principal_id = $1", [bot.id]), () => sql("update agents set contact_policy = 'ask' where principal_id = $1", [bot.id])],
      ["disabled", () => sql("update agents set disabled_at = now() where principal_id = $1", [bot.id]), () => sql("update agents set disabled_at = null where principal_id = $1", [bot.id])],
      ["I block the owner", () => sql("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [me.id, ann.id]), () => sql("delete from blocks")],
      ["the owner blocks me", () => sql("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [ann.id, me.id]), () => sql("delete from blocks")],
      ["I block it", () => sql("insert into blocks (blocker_id, blocked_id) values ($1, $2)", [me.id, bot.id]), () => sql("delete from blocks")],
    ];
    for (const [name, hide, undo] of hides) {
      await hide();
      const h = await counted(() => card(me, bot.id));
      expect([name, h.status, h.json, h.queries]).toEqual([name, missing.status, missing.json, missing.queries]);
      await undo();
    }
    // Its owner, a person's id, and ids that are no id — short, over the router's parameter limit, with a slash, encoded NUL:
    // the same 404, never 400 or 414, in the same one read as a missing id (F5).
    for (const [who, id] of [
      [ann, bot.id],
      [me, ann.id],
      [me, "abc"],
      [me, "1"],
      [me, `${bot.id}x`],
      [me, encodeURIComponent(`{${bot.id}}`)],
      [me, "x".repeat(150)],
      [me, "x".repeat(10_000)],
      [me, `${bot.id}/x`],
      [me, "%00"],
    ] as const) {
      const r = await counted(() => card(who, id));
      expect([id.slice(0, 40), r.status, r.json, r.queries]).toEqual([id.slice(0, 40), 404, { error: "not_found" }, missing.queries]);
    }
    expect((await api(app, ann, "DELETE", `/api/agents/${bot.id}`)).status).toBe(200);
    expect(await card(me, bot.id)).toEqual({ status: 404, json: { error: "not_found" } });
  });

  it("a co-member of my group that takes no contacts: 404 too (the roster shows what it already had)", async () => {
    const me = await signUp(app, "eme");
    const host = await signUp(app, "ehost");
    const bot = await agentOf(host, "ebot", "Eee");
    const g = await group(app, host, "g", [me, await signUp(app, "ethird")]);
    await addToGroup(host, g, bot.id);
    expect((await card(me, bot.id)).status).toBe(200);
    await sql("update agents set contact_policy = 'none' where principal_id = $1", [bot.id]);
    expect(await card(me, bot.id)).toEqual({ status: 404, json: { error: "not_found" } });
  });
});

describe("the switch off", () => {
  it("both routes answer 404 after the session and before anything else — the query's shape included (F6) — as the other routes of Agent social do", async () => {
    const me = await signUp(app, "ume");
    const ann = await signUp(app, "uann");
    const bot = await agentOf(ann, "ubot", "You");
    const social = app.deps.config.social;
    (app.deps.config as { social: unknown }).social = { enabled: false };
    try {
      for (const url of [
        "/api/principals/search?q=uann",
        "/api/principals/search?q=uann&exact=1",
        "/api/principals/search",
        "/api/principals/search?q=a%00b",
        "/api/principals/search?q=a&exact=2",
        `/api/principals/search?q=${"a".repeat(101)}`,
        `/api/principals/agent-card/${bot.id}`,
        "/api/principals/agent-card/abc",
        `/api/principals/agent-card/${"x".repeat(150)}`,
      ]) {
        expect([url, await api(app, me, "GET", url)]).toEqual([url, { status: 404, json: { error: "not_found" } }]);
        expect([url, (await api(app, null, "GET", url)).status]).toEqual([url, 401]);
      }
    } finally {
      (app.deps.config as { social: unknown }).social = social;
    }
    expect((await card(me, bot.id)).status).toBe(200);
  });
});

describe("the query's shape", () => {
  it("over 100 characters, a control character or a second exact value: 400; exact takes only 1", async () => {
    const me = await signUp(app, "qme");
    for (const url of [
      `/api/principals/search?q=${"a".repeat(101)}`,
      "/api/principals/search?q=a%00b",
      "/api/principals/search?q=a%0Ab",
      "/api/principals/search?q=a&exact=true",
      "/api/principals/search?q=a&exact=0",
      "/api/principals/search?q=a&q=b",
      "/api/principals/search",
    ]) {
      expect([url, (await api(app, me, "GET", url)).status]).toEqual([url, 400]);
    }
    expect((await search(me, "a".repeat(100))).status).toBe(200);
    // The leading @ is dropped before the length is counted (F7).
    expect((await search(me, `@${"a".repeat(100)}`)).status).toBe(200);
    expect((await search(me, ` @${"a".repeat(100)} `)).status).toBe(200);
    expect((await search(me, `@${"a".repeat(101)}`)).status).toBe(400);
  });
});

describe("the log", () => {
  it("never has a search's text, a name or an intro it found", async () => {
    const me = await signUp(app, "lme");
    const fred = await signUp(app, "lfred");
    await befriend(app, me, fred);
    await rename(fred.id, "LOGNAMEZQX");
    const bot = await agentOf(fred, "lbot", "LOGAGENTZQX", "LOGINTROZQX");
    lines.length = 0;
    expect(circleIds(await search(me, "lognamezqx"))).toEqual([fred.id, bot.id]);
    expect((await search(me, "lfred", true)).json.exact.agents).toHaveLength(1);
    expect((await card(me, bot.id)).status).toBe(200);
    expect(lines.length).toBeGreaterThan(0);
    const log = lines.join("");
    for (const secret of ["lognamezqx", "LOGNAMEZQX", "LOGAGENTZQX", "LOGINTROZQX", "lfred"]) expect([secret, log.includes(secret)]).toEqual([secret, false]);
  });
});
