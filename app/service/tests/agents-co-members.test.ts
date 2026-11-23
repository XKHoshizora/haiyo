import { describe, expect, it } from "vitest";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { providerBody } from "./helpers/providers.ts";
import { createWhisper } from "../src/whispers/store.ts";

/**
 * What the fellow members of a group learn about an Agent in it (design rules 16–17): its name, avatar, handle, intro,
 * field and owner — on the member list and in the principals of sync, history, a single message and both searches — and
 * nothing else of it. The membership routes do not take Agents yet, so these tests seat the Agent in the group directly
 * in the database. The avatar rule is in tests/enumeration.test.ts.
 */

const gateway = scriptedGateway();
const { blobs } = useProbeBlobs("af-agents-co-");
const { app, db } = useApp({ blobs, env: SITE_ENV, models: gateway, agentWorker: false });

const FAST = { source: "site", id: "fast" } as const;
const INTRO = "INTRO-co7 帮大家整理";
const FIELD = "FIELD-co7";

/** Distinctive values of the Agent and of its owner's private chat that only the owner may ever see. */
const HIDDEN = {
  persona: "PERSONA-zq7 你是只属于主人的秘密助手。",
  proposed: "PROPOSED-zq7 一个新的秘密人格。",
  reasoning: "REASONING-zq7 private thinking",
  /** The thinking stored with its message in the group: its owner's to read, nobody else's. */
  groupReasoning: "GROUPTHINK-zq7 what it thought there",
  privateAsk: "PRIVATE-ASK-zq7",
  privateReply: "PRIVATE-REPLY-zq7",
  providerName: "Vendor zq7",
  model: "model-zq7-hidden",
  /** What the Agent calls its owner, and what it calls mia: the owner's settings. */
  ownerAppellation: "OWNERNAME-zq7",
  appellation: "NAMED-zq7",
  /** Memory: a note about the owner, one of the Agent's own, and something it heard in the group (never shown to anyone else). */
  ownerNote: "OWNERNOTE-zq7 keeps bees",
  selfNote: "SELFNOTE-zq7 likes tea",
  hearsay: "HEARSAY-zq7 said in the group",
  /** A whisper (悄悄话) of the owner's about the Agent in the group: theirs alone (whispers-privacy.test.ts). */
  whisper: "WHISPER-zq7 只给主人看",
  /** What a reply searched for: its owner's to read in its own conversation only — never in a group, not even theirs. */
  query: "QUERY-zq7 主人的搜索词",
};
/** Keys of an Agent's configuration, state and runs: no response to anyone but its owner carries one, at any depth. */
const HIDDEN_KEYS = [
  // When a person may change their handle again: `GET /api/me` alone (family names).
  "handleChangeAvailableAt",
  // Whether a message asked an Agent it could not name (Task M fix round 1): read by the proactive judgement only.
  "asksAgent",
  "asks_agent",
  "persona",
  "personaVersion",
  "model",
  "reasoning",
  "replyMode",
  "groupMentions",
  "othersBudget",
  "othersSpentToday",
  "proactive",
  "proactiveLevel",
  "proactiveBudget",
  "proactiveSpentToday",
  // Agent social (plan Step 0, T0.4): what a non-owner is shown of the owner's notes, the owner's numbers and settings for
  // others' use, and the owner's verdicts and cards: the owner's alone, whoever else is in a conversation.
  "shownNotes",
  "withheld",
  "shown_notes",
  "withheld_notes",
  "othersLimit",
  "othersUsedToday",
  "proactivePoints",
  "proactiveAnswers",
  "canReply",
  // The use page's own keys (plan B4): the owner's numbers per person and per Agent.
  "byPerson",
  "perDay",
  "contactPolicy",
  "contactPicked",
  "picks",
  "audienceId",
  "noteId",
  "ownerShare",
  "judgeShare",
  "card",
  // Why an access ended: the owner's to read; the other side never learns it.
  "endReason",
  "end_reason",
  "ownerAppellation",
  "appellations",
  "memory",
  "memoryAsk",
  "sharedNotes",
  "whisperElsewhere",
  // 联网搜索 (lane websearch): the owner's switch, and how many searches a reply's points include (in `via`).
  "webSearch",
  "webSearches",
  "whisperId",
  "whisper_id",
  "newNotes",
  "memoryModel",
  "memoryModelUsable",
  "modelUsable",
  "memoryLanguage",
  "fits",
  "noRoom",
  "failedRooms",
  "converted",
  "unavailable",
  "dream",
  "strength",
  "seenAt",
  "paused",
  "deleted",
  "provider",
  "providerId",
  "proposal",
  "proposalId",
  "run",
  "agent",
  "agentId",
  "via",
  // A whisper's (src/whispers/): the push, the sync and catch-up lists, the conversation's count, where it sits.
  "whisper",
  "whispers",
  "afterSeq",
  // What a reply searched for (its owner's, in its own conversation only).
  "queries",
  // Whether a provider's model may be offered tools (its owner's provider list only).
  "tools",
  // Whose questions a reply answers (`agent_runs.asker_ids`, Task 10b): never on the wire, not even to its owner.
  "askerIds",
  "asker_ids",
  "askers",
  // Which messages called for a reply (`agent_runs.call_seqs`, fix round 2): never on the wire either.
  "callSeqs",
  "call_seqs",
  // Which lines of a memory notice are the notes a merge joined (its owner's notice only).
  "sourceLines",
  // Whether a reply could start on the free allowance now (the owner's `GET /api/usage` only; Task H).
  "canStartFreeReply",
  // A run held back at admission, and an owner's stop kept in its row (Task H): never on the wire, not even to its owner.
  "heldBackBy",
  "held_back_by",
  "stopAsked",
  "stop_asked",
  // A whisper's revision and whether its last tell failed (Redesign D): its owner's only, as every whisper field.
  "revision",
  "lastTellFailed",
  // When a found_elsewhere whisper stops reading open, and its failed told reply stops being offered 重试 (fix round 3).
  "openUntil",
  "retryableUntil",
];
const HUMAN_PRINCIPAL_KEYS = ["avatarVersion", "displayName", "handle", "id", "kind"];

let txn = 0;
const say = (who: Actor, conv: string, text: string, extra: object = {}) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `co${++txn}`, ...extra });

/** Every key of every object in `value`, at any depth. */
function keysOf(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, out);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  return out;
}

/** Makes `principalId` a current member of `conv` from its current seq on, as `addMember` would (no notice). */
async function seat(conv: string, principalId: string): Promise<void> {
  await db.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq)
     select id, $2, 'speaker', seq from conversations where id = $1`,
    [conv, principalId],
  );
}

/**
 * A text message from `senderId` in `conv` (with `reasoning`, as an Agent's reply stores it), written straight into the
 * table, posted by run `runId` when given (`client_txn`, as `postAsAgent` writes it); returns its seq.
 */
async function postAs(conv: string, senderId: string, text: string, reasoning?: string, runId?: string): Promise<number> {
  const { rows } = await db.query<{ seq: string }>(
    `with c as (update conversations set seq = seq + 1 where id = $1 returning seq)
     insert into messages (conversation_id, seq, sender_id, kind, body, client_txn)
     select $1, c.seq, $2, 'text', jsonb_strip_nulls(jsonb_build_object('text', $3::text, 'reasoning', $4::text)), $5 from c returning seq`,
    [conv, senderId, text, reasoning ?? null, runId ?? null],
  );
  return Number(rows[0]!.seq);
}

/**
 * A reply run of `agentId` in `conv` that ended `done`, called on its owner's provider model `model` at `reasoning`, and
 * its usage record (a provider call costs nothing); returns its id.
 */
async function providerRun(conv: string, agentId: string, ownerId: string, model: string, reasoning: string, lane: "own" | "others" | "proactive"): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, covers_seq, source, model, reasoning, started_at, finished_at, lane)
     select 'reply', $1, $2, $3, 'done', c.seq, 'provider', $4, $5, now(), now(), $6 from conversations c where c.id = $1 returning id`,
    [conv, agentId, ownerId, model, reasoning, lane],
  );
  const id = rows[0]!.id;
  await db.query(
    `insert into usage_records (owner_id, agent_id, run_id, purpose, source, model, input_tokens, output_tokens, outcome)
     values ($1, $2, $3, 'reply', 'provider', $4, 10, 10, 'done')`,
    [ownerId, agentId, id, model],
  );
  return id;
}

/**
 * olive's Agent (persona, a private chat with reasoning replies and a persona proposal, then a model of her own provider,
 * answering only when called, an avatar, paused) seated in olive's group with mia and ned, where it has said something
 * (stored with its thinking, as a reply there is) and mia quoted it.
 * sam is mia's friend and in no conversation with the Agent.
 */
async function world() {
  const [owner, mia, ned, sam] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned"), await signUp(app, "sam")];
  const agent = await mustCreateAgent(app, owner, {
    handle: "team_bot",
    name: "Team Bot",
    intro: INTRO,
    field: FIELD,
    persona: HIDDEN.persona,
    model: FAST,
    groupMentions: "owner",
  });
  const dedicated = agent.conversationId as string;

  gateway.reply(`<af-persona>${HIDDEN.proposed}</af-persona>`, { reasoning: HIDDEN.reasoning });
  expect((await say(owner, dedicated, HIDDEN.privateAsk)).status).toBe(201);
  expect(await app.agentWorker.runOnce()).toBe(true);
  gateway.reply(HIDDEN.privateReply, { reasoning: HIDDEN.reasoning });
  expect((await say(owner, dedicated, "再说一次")).status).toBe(201);
  expect(await app.agentWorker.runOnce()).toBe(true);

  const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ name: HIDDEN.providerName, models: [{ name: HIDDEN.model }] }))).json.id as string;
  const patched = await api(app, owner, "PATCH", `/api/agents/${agent.id}`, { model: { source: "provider", providerId: provider, model: HIDDEN.model }, replyMode: "mention", ownerAppellation: HIDDEN.ownerAppellation });
  expect(patched.status).toBe(200);
  const avatar = await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/avatar`, headers: { cookie: owner.cookie, "content-type": "image/png" }, payload: PNG });
  expect(avatar.statusCode).toBe(200);
  expect((await api(app, owner, "POST", `/api/agents/${agent.id}/pause`)).status).toBe(200);

  const g = await group(app, owner, "team", [mia, ned]);
  await befriend(app, mia, sam);
  await seat(g, agent.id);
  // What its memory holds, out of the vault and in the group's own origin: the strongest case for a leak.
  await db.query("insert into owner_notes (owner_id, text, vault, origin_conversation_id) values ($1, $2, false, $3)", [owner.id, HIDDEN.ownerNote, g]);
  await db.query("insert into agent_notes (agent_id, text, vault, origin_conversation_id) values ($1, $2, false, $3)", [agent.id, HIDDEN.selfNote, g]);
  await db.query("insert into agent_hearsay (agent_id, conversation_id, speaker_name, text, said_at) values ($1, $2, 'mia', $3, now())", [agent.id, g, HIDDEN.hearsay]);
  expect((await api(app, owner, "PUT", `/api/agents/${agent.id}/appellations/${mia.id}`, { appellation: HIDDEN.appellation })).status).toBe(200);
  // Said as a reply its owner's provider model gave there at a thinking level, unasked (its owner's `via`).
  // A reply nobody asked for: the owner's copy says so (`via.proactive`), nobody else's has a `via`.
  const groupRun = await providerRun(g, agent.id, owner.id, HIDDEN.model, "high", "proactive");
  const agentSeq = await postAs(g, agent.id, "agent says needle-co7", HIDDEN.groupReasoning, groupRun);
  const quoteSeq = (await say(mia, g, "thanks", { replyToSeq: agentSeq })).json.message.seq as number;
  // A reply of it there that looked things up, its body as stored, words and all (a reply in a group is never stored with
  // them: this is the wire's own rule): what it found includes a message of the owner's private chat.
  const looked = { search: 2 };
  const lookedSeq = await postBody(g, agent.id, { text: "looked up co7", lookups: looked, found: [{ conversationId: dedicated, seq: 1 }, { conversationId: g, seq: agentSeq }], queries: [HIDDEN.query] });
  // An open whisper of the owner's about it there, pushed to them: the owner's alone.
  const whisper = await db.tx((t) => createWhisper(t, { conversationId: g, ownerId: owner.id, agentId: agent.id, kind: "found_elsewhere", body: { text: HIDDEN.whisper, actions: ["tell", "dismiss"] } }));
  app.realtime.pushWhisper(whisper!);
  expect((await api(app, owner, "GET", "/api/sync")).json.whispers.map((x: any) => x.text)).toEqual([HIDDEN.whisper]);

  // The owner's view really holds every hidden value (so their absence below means something).
  const mine = (await api(app, owner, "GET", `/api/agents/${agent.id}`)).json;
  expect(mine).toMatchObject({
    persona: HIDDEN.persona,
    replyMode: "mention",
    groupMentions: "owner",
    proactive: false,
    proactiveLevel: "normal",
    proactiveBudget: "70",
    memory: true,
    memoryAsk: false,
    sharedNotes: true,
    whisperElsewhere: true,
    ownerAppellation: HIDDEN.ownerAppellation,
    appellations: [{ principalId: mia.id, appellation: HIDDEN.appellation }],
    paused: true,
    model: { model: HIDDEN.model },
  });
  const privateChat = JSON.stringify((await api(app, owner, "GET", `/api/conversations/${dedicated}/messages`)).json);
  for (const value of [HIDDEN.privateAsk, HIDDEN.privateReply, HIDDEN.proposed, HIDDEN.reasoning]) expect(privateChat).toContain(value);

  const expected = { id: agent.id, handle: "olive.team_bot", displayName: "Team Bot", avatarVersion: 1, kind: "agent", ownerId: owner.id, intro: INTRO, field: FIELD };
  return { owner, mia, ned, sam, agent, dedicated, provider, g, agentSeq, quoteSeq, lookedSeq, looked, expected };
}

/** A text message from `senderId` in `conv` with `body` as it is, written straight into the table; returns its seq. */
async function postBody(conv: string, senderId: string, body: Record<string, unknown>): Promise<number> {
  const { rows } = await db.query<{ seq: string }>(
    `with c as (update conversations set seq = seq + 1 where id = $1 returning seq)
     insert into messages (conversation_id, seq, sender_id, kind, body) select $1, c.seq, $2, 'text', $3::jsonb from c returning seq`,
    [conv, senderId, JSON.stringify(body)],
  );
  return Number(rows[0]!.seq);
}

describe("an Agent's fellow group members see its name, avatar, handle, intro, field and owner", () => {
  it("on the member list and in the principals of sync, history, a single message and both searches", async () => {
    const { owner, mia, agent, g, agentSeq, quoteSeq, expected } = await world();
    for (const who of [mia, owner]) {
      const members = (await api(app, who, "GET", `/api/conversations/${g}/members`)).json.members as any[];
      expect(members.find((m) => m.id === agent.id)).toEqual({ ...expected, role: "speaker", isCreator: false });
      for (const m of members.filter((m) => m.id !== agent.id)) {
        expect(Object.keys(m).sort()).toEqual([...HUMAN_PRINCIPAL_KEYS, "isCreator", "role"].sort());
      }

      const sync = (await api(app, who, "GET", "/api/sync")).json;
      expect(sync.principals.find((p: any) => p.id === agent.id)).toEqual(expected);
      for (const p of sync.principals.filter((p: any) => p.id !== agent.id)) expect(Object.keys(p).sort()).toEqual(HUMAN_PRINCIPAL_KEYS);

      const history = (await api(app, who, "GET", `/api/conversations/${g}/messages`)).json;
      expect(history.messages.some((m: any) => m.senderId === agent.id)).toBe(true);
      expect(history.principals[agent.id]).toEqual(expected);
      expect(history.principals[mia.id]).toEqual({ id: mia.id, handle: mia.handle, displayName: "mia", avatarVersion: 0, kind: "human" });

      // A single message: the Agent's own, and one that quotes it.
      expect((await api(app, who, "GET", `/api/conversations/${g}/messages/${agentSeq}`)).json.principals).toEqual({ [agent.id]: expected });
      const quoting = (await api(app, who, "GET", `/api/conversations/${g}/messages/${quoteSeq}`)).json;
      expect(quoting.message.replyTo).toMatchObject({ visible: true, senderId: agent.id });
      expect(quoting.principals[agent.id]).toEqual(expected);

      expect((await api(app, who, "GET", `/api/conversations/${g}/search?q=needle-co7`)).json.principals).toEqual({ [agent.id]: expected });
      expect((await api(app, who, "GET", "/api/search?q=needle-co7")).json.principals).toEqual({ [agent.id]: expected });
    }
    // The owner's own sync names it the same way (through its dedicated conversation as well).
    expect((await api(app, owner, "GET", "/api/sync")).json.principals.filter((p: any) => p.id === agent.id)).toEqual([expected]);
  });

  it("and nothing else: no response a fellow member gets carries its persona, model, provider, settings, pause, proposals, runs, private chat or the thinking of its replies there", async () => {
    const { owner, mia, agent, dedicated, provider, g, agentSeq, quoteSeq, lookedSeq, looked } = await world();
    // Its owner does read the thinking stored with its message in the group, and which model and level gave it (so
    // their absence below means something).
    const ownersCopy = (await api(app, owner, "GET", `/api/conversations/${g}/messages/${agentSeq}`)).json.message;
    expect([ownersCopy.reasoning, ownersCopy.via]).toEqual([HIDDEN.groupReasoning, { model: { source: "provider", model: HIDDEN.model }, reasoning: "high", points: "0", proactive: true }]);
    // What a reply looked up: its owner reads all it found (their private chat's message too), a fellow member only what
    // they can see; both the counts; neither the words — in a group not even its owner.
    const ownersLooked = (await api(app, owner, "GET", `/api/conversations/${g}/messages/${lookedSeq}`)).json.message;
    expect([ownersLooked.lookups, ownersLooked.found, "queries" in ownersLooked]).toEqual([looked, [{ conversationId: dedicated, seq: 1 }, { conversationId: g, seq: agentSeq }], false]);
    const miasLooked = (await api(app, mia, "GET", `/api/conversations/${g}/messages/${lookedSeq}`)).json.message;
    expect([miasLooked.lookups, miasLooked.found, "queries" in miasLooked]).toEqual([looked, [{ conversationId: g, seq: agentSeq }], false]);
    const bodies: Array<[string, unknown]> = [];
    const read = async (label: string, method: "GET" | "POST", url: string, body?: unknown) => {
      const res = await api(app, mia, method, url, body);
      expect([label, res.status]).toEqual([label, 200]);
      bodies.push([label, res.json]);
    };
    await read("sync", "GET", "/api/sync");
    await read("one conversation", "GET", `/api/conversations/${g}`);
    await read("members", "GET", `/api/conversations/${g}/members`);
    await read("history", "GET", `/api/conversations/${g}/messages`);
    await read("history page", "GET", `/api/conversations/${g}/messages?limit=1`);
    await read("the Agent's message", "GET", `/api/conversations/${g}/messages/${agentSeq}`);
    await read("a quote of it", "GET", `/api/conversations/${g}/messages/${quoteSeq}`);
    await read("search", "GET", `/api/conversations/${g}/search?q=needle-co7`);
    await read("global search", "GET", "/api/search?q=needle-co7");
    await read("catch-up", "POST", "/api/sync/catchup", { positions: { [g]: 0 } });
    for (const value of Object.values(HIDDEN)) await read(`global search for ${value}`, "GET", `/api/search?q=${encodeURIComponent(value.slice(0, 20))}`);

    for (const [label, body] of bodies) {
      const text = JSON.stringify(body);
      for (const value of [...Object.values(HIDDEN), dedicated, provider]) expect([label, value, text.includes(value)]).toEqual([label, value, false]);
      const keys = keysOf(body);
      expect([label, HIDDEN_KEYS.filter((k) => keys.has(k))]).toEqual([label, []]);
      // A memory notice that has expired (its change swept away) is the owner's alone, as any notice of memory is.
      expect([label, text.includes('"expired"')]).toEqual([label, false]);
    }
    // Positive control: the reads did name the Agent, with what fellow members may see.
    for (const label of ["sync", "members", "history", "search"]) {
      const text = JSON.stringify(bodies.find(([l]) => l === label)![1]);
      expect([label, text.includes(agent.id), text.includes(INTRO), text.includes(FIELD)]).toEqual([label, true, true, true]);
    }
  });

  it("someone in no conversation with it, and a member who has left, never hear of it in their sync", async () => {
    const { owner, ned, sam, agent, g } = await world();
    expect((await api(app, ned, "DELETE", `/api/conversations/${g}/members/${ned.id}`)).status).toBe(200);
    for (const who of [sam, ned]) {
      const text = JSON.stringify((await api(app, who, "GET", "/api/sync")).json);
      for (const value of [agent.id, "team_bot", "Team Bot", INTRO, FIELD]) expect([who.handle, value, text.includes(value)]).toEqual([who.handle, value, false]);
      // Nobody else they can see carries the Agent's fields either (the owner, ned's friend, is a person).
      expect(text).not.toContain("ownerId");
    }
    expect(JSON.stringify((await api(app, ned, "GET", "/api/sync")).json)).toContain(owner.id);
  });

  it("an Agent principal without an agents row (a bare fixture) lists with its owner and empty intro and field", async () => {
    const [owner, mia, ned] = [await signUp(app, "olive"), await signUp(app, "mia"), await signUp(app, "ned")];
    const g = await group(app, owner, "bare", [mia, ned]);
    const bare = (
      await db.query<{ id: string }>(`insert into principals (kind, handle, display_name, owner_id) values ('agent', 'bare_bot', 'Bare', $1) returning id`, [owner.id])
    ).rows[0]!.id;
    await seat(g, bare);
    // Its handle is its owner's and its name part (family names), whether or not it has an agents row.
    const shape = { id: bare, handle: "olive.bare_bot", displayName: "Bare", avatarVersion: 0, kind: "agent", ownerId: owner.id, intro: "", field: "" };
    const members = (await api(app, mia, "GET", `/api/conversations/${g}/members`)).json.members as any[];
    expect(members.find((m) => m.id === bare)).toEqual({ ...shape, role: "speaker", isCreator: false });
    expect((await api(app, mia, "GET", "/api/sync")).json.principals.find((p: any) => p.id === bare)).toEqual(shape);
  });
});
