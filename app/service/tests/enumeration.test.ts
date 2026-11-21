import type { InjectOptions } from "fastify";
import { describe, expect, it } from "vitest";
import { api, befriend, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, PNG, SITE_ENV } from "./helpers/agents.ts";
import { useProbeBlobs } from "./helpers/blobs.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { providerBody } from "./helpers/providers.ts";
import { createWhisper } from "../src/whispers/store.ts";

/**
 * Enumeration: for every route that takes a conversation id, a message seq, an attachment id, a
 * friend-request id, a principal id, an Agent, provider, run or persona-proposal id, an id that exists but is not the
 * caller's business gets exactly (status, content type and body, byte for byte) the answer a random id gets. Where the
 * product means to answer differently, the intended difference is asserted instead and named in the test.
 */

const gateway = scriptedGateway();
const { blobs } = useProbeBlobs("af-enum-");
const { app, db } = useApp({ blobs, env: SITE_ENV, models: gateway, agentWorker: false });

const RANDOM = "6a0d4c2e-1b3f-4a5e-9c7d-8e9f0a1b2c3d";

let txn = 0;
const say = (who: Actor, conv: string, text: string, extra: object = {}) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `e${++txn}`, ...extra });
const add = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "POST", `/api/conversations/${conv}/members`, { principalId: target.id });
const remove = (who: Actor, conv: string, target: Actor) =>
  api(app, who, "DELETE", `/api/conversations/${conv}/members/${target.id}`);

async function upload(who: Actor, conv: string, name = "f.bin"): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv}/attachments`,
    headers: { cookie: who.cookie, "content-type": MULTIPART },
    payload: multipart([{ name: "file", filename: name, type: "application/octet-stream", data: Buffer.from(`bytes of ${name}`) }]),
  });
  if (res.statusCode !== 201) throw new Error(`upload ${res.statusCode} ${res.body}`);
  return res.json().id;
}

async function sendFile(who: Actor, conv: string, name: string): Promise<string> {
  const id = await upload(who, conv, name);
  const res = await api(app, who, "POST", `/api/conversations/${conv}/messages`, { attachmentId: id, clientTxn: `e${++txn}` });
  if (res.status !== 201) throw new Error(`sendFile ${res.status}`);
  return id;
}

/** What a client can observe of an answer, with `id` (when the answer echoes it) replaced by a placeholder. */
async function observe(who: Actor, req: InjectOptions, id?: string): Promise<{ status: number; type: string; body: string }> {
  const res = await app.inject({ ...req, headers: { ...(req.headers as object), cookie: who.cookie } });
  const body = id ? res.body.split(id).join("<id>") : res.body;
  return { status: res.statusCode, type: String(res.headers["content-type"] ?? ""), body };
}

/** Asserts that every `existing` id is answered exactly like `random`. Returns that common answer. */
async function indistinguishable(
  who: Actor,
  label: string,
  request: (id: string) => InjectOptions,
  existing: Record<string, string>,
  random = RANDOM,
  echoes = false,
) {
  const reference = await observe(who, request(random), echoes ? random : undefined);
  expect(reference.status, `${label}: reference`).toBeGreaterThanOrEqual(400);
  for (const [kind, id] of Object.entries(existing)) {
    const got = await observe(who, request(id), echoes ? id : undefined);
    expect([label, kind, got]).toEqual([label, kind, reference]);
  }
  return reference;
}

const json = (method: InjectOptions["method"], url: string, payload?: object): InjectOptions => ({
  method,
  url,
  ...(payload === undefined ? {} : { payload }),
});

describe("enumeration: an existing id that is not yours is answered like a random one", () => {
  it("conversation ids: never in it, left it, removed from it, someone else's direct chat, closed — on every route", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    await befriend(app, alice, eve);
    await befriend(app, eve, carol);
    const { conversationId: direct } = await befriend(app, alice, bob);
    const neverIn = await group(app, alice, "never", [bob, carol]);
    const left = await group(app, alice, "left", [eve, bob]);
    const removed = await group(app, alice, "removed", [eve, bob]);
    const closed = await group(app, alice, "closed", [eve, bob]);
    for (const g of [neverIn, left, removed, direct, closed]) await say(alice, g, "hello secret");
    await sendFile(alice, neverIn, "secret.bin");
    expect((await remove(eve, left, eve)).status).toBe(200);
    expect((await remove(alice, removed, eve)).status).toBe(200);
    for (const who of [eve, alice, bob]) expect((await remove(who, closed, who)).status).toBe(200);

    const existing = { neverIn, left, removed, direct, closed, upperCase: neverIn.toUpperCase() };
    const routes: Array<[string, (id: string) => InjectOptions]> = [
      ["one conversation", (id) => json("GET", `/api/conversations/${id}`)],
      ["rename", (id) => json("PATCH", `/api/conversations/${id}`, { title: "mine" })],
      ["members", (id) => json("GET", `/api/conversations/${id}/members`)],
      ["add member", (id) => json("POST", `/api/conversations/${id}/members`, { principalId: carol.id })],
      ["leave", (id) => json("DELETE", `/api/conversations/${id}/members/${eve.id}`)],
      ["remove someone", (id) => json("DELETE", `/api/conversations/${id}/members/${bob.id}`)],
      ["send", (id) => json("POST", `/api/conversations/${id}/messages`, { text: "hi", clientTxn: "enum-1" })],
      ["send a quote", (id) => json("POST", `/api/conversations/${id}/messages`, { text: "hi", replyToSeq: 1, clientTxn: "enum-2" })],
      ["history", (id) => json("GET", `/api/conversations/${id}/messages`)],
      ["history page", (id) => json("GET", `/api/conversations/${id}/messages?before=3&limit=2`)],
      ["one message", (id) => json("GET", `/api/conversations/${id}/messages/1`)],
      ["search", (id) => json("GET", `/api/conversations/${id}/search?q=secret`)],
      ["read marker", (id) => json("POST", `/api/conversations/${id}/read`, { seq: 1 })],
      // A group's replies and its brakes on Agents (batch 2C).
      ["group replies", (id) => json("GET", `/api/conversations/${id}/runs`)],
      ["halt Agents", (id) => json("POST", `/api/conversations/${id}/agents/halt`)],
      ["stop a run", (id) => json("POST", `/api/conversations/${id}/runs/${RANDOM}/stop`)],
      ["retry an Agent's run", (id) => json("POST", `/api/conversations/${id}/runs/retry`, { agentId: RANDOM })],
      ["dismiss an Agent's run", (id) => json("POST", `/api/conversations/${id}/runs/dismiss`, { agentId: RANDOM })],
      // An owner's whispers there (src/whispers/).
      ["whispers", (id) => json("GET", `/api/conversations/${id}/whispers`)],
      ["a page of whispers", (id) => json("GET", `/api/conversations/${id}/whispers?before=3&limit=2`)],
      [
        "upload",
        (id) => ({
          method: "POST",
          url: `/api/conversations/${id}/attachments`,
          headers: { "content-type": MULTIPART },
          payload: multipart([{ name: "file", filename: "x.bin", data: "x" }]),
        }),
      ],
    ];
    for (const [label, request] of routes) {
      const answer = await indistinguishable(eve, label, request, existing);
      expect([label, answer.status, answer.body]).toEqual([label, 404, '{"error":"not_found"}']);
    }

    // Catch-up echoes the id it was given: the same answer once the id itself is taken out.
    for (const [kind, id] of Object.entries(existing)) {
      const got = await observe(eve, json("POST", "/api/sync/catchup", { positions: { [id]: 0 } }), id.toLowerCase());
      const reference = await observe(eve, json("POST", "/api/sync/catchup", { positions: { [RANDOM]: 0 } }), RANDOM);
      expect([kind, got]).toEqual([kind, reference]);
      expect(JSON.parse(reference.body)).toEqual({ messages: [], gone: ["<id>"], more: false });
    }
    // And none of them appears anywhere in /api/sync or a global search.
    const sync = (await api(app, eve, "GET", "/api/sync")).json;
    expect(JSON.stringify(sync)).not.toMatch(new RegExp([neverIn, left, removed, direct, closed].join("|")));
    expect((await api(app, eve, "GET", "/api/search?q=secret")).json).toEqual({ messages: [], nextBefore: null, principals: {} });
    // Nothing she sent got in anywhere (her own leave notices aside).
    const hers = await db.query("select count(*) n from messages where sender_id = $1 and kind <> 'system'", [eve.id]);
    expect(Number(hers.rows[0].n)).toBe(0);
  });

  it("message seqs: a seq from before you joined is answered like one that does not exist", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    await befriend(app, alice, eve);
    const g = await group(app, alice, "late", [bob, carol]);
    for (let i = 0; i < 4; i++) await say(alice, g, `before you ${i}`);
    expect((await add(alice, g, eve)).status).toBe(201);
    const joinedAt = Number((await db.query("select seq from conversations where id = $1", [g])).rows[0].seq);
    expect(joinedAt).toBeGreaterThan(3);

    // The path seq, and a quote's seq in a send.
    const one = (seq: string) => json("GET", `/api/conversations/${g}/messages/${seq}`);
    const answer = await indistinguishable(eve, "one message", one, { first: "1", preJoin: "3", lastPreJoin: String(joinedAt - 1) }, "999999");
    expect(answer.status).toBe(404);
    const quote = (seq: string) => json("POST", `/api/conversations/${g}/messages`, { text: "re", replyToSeq: Number(seq), clientTxn: `q${seq}` });
    const refused = await indistinguishable(eve, "quote", quote, { preJoin: "2", lastPreJoin: String(joinedAt - 1) }, "999999");
    expect(refused).toMatchObject({ status: 400, body: '{"error":"invalid_request"}' });
    // Positive control: the join notice is hers.
    expect((await api(app, eve, "GET", `/api/conversations/${g}/messages/${joinedAt}`)).status).toBe(200);
  });

  it("attachment ids: download and send treat other people's, unsent, pre-join and left-behind attachments like a random id", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    await befriend(app, alice, eve);
    const elsewhere = await group(app, alice, "elsewhere", [bob, carol]);
    const sentElsewhere = await sendFile(alice, elsewhere, "elsewhere.bin");
    const unsentElsewhere = await upload(alice, elsewhere, "unsent-elsewhere.bin");
    const shared = await group(app, alice, "shared", [bob, carol]);
    const preJoin = await sendFile(alice, shared, "pre.bin");
    expect((await add(alice, shared, eve)).status).toBe(201);
    const othersUnsent = await upload(alice, shared, "alice-unsent.bin");
    const ownUnsent = await upload(eve, shared, "eve-unsent.bin");
    const formerHome = await group(app, alice, "former", [eve, bob]);
    const leftBehind = await sendFile(alice, formerHome, "left-behind.bin");
    expect((await remove(eve, formerHome, eve)).status).toBe(200);

    const download = (id: string) => json("GET", `/api/attachments/${id}`);
    const answer = await indistinguishable(eve, "download", download, {
      sentElsewhere,
      unsentElsewhere,
      preJoin,
      othersUnsent,
      ownUnsent,
      leftBehind,
      upperCase: sentElsewhere.toUpperCase(),
    });
    expect(answer).toMatchObject({ status: 404, body: '{"error":"not_found"}' });

    const send = (id: string) => json("POST", `/api/conversations/${shared}/messages`, { attachmentId: id, clientTxn: `s-${id.slice(0, 8)}` });
    const refused = await indistinguishable(eve, "send", send, { sentElsewhere, unsentElsewhere, preJoin, othersUnsent, leftBehind });
    expect(refused).toMatchObject({ status: 400, body: '{"error":"invalid_request"}' });
    // Positive control: her own upload, in this conversation, sends.
    expect((await app.inject({ ...send(ownUnsent), headers: { cookie: eve.cookie } })).statusCode).toBe(201);
  });

  it("friend-request ids: someone else's request, or your own in the wrong role, is answered like a random id", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const othersPending = (await api(app, alice, "POST", "/api/friend-requests", { handle: bob.handle })).json.id;
    const othersAccepted = (await api(app, carol, "POST", "/api/friend-requests", { handle: bob.handle })).json.id;
    expect((await api(app, bob, "POST", `/api/friend-requests/${othersAccepted}/accept`)).status).toBe(200);
    const mineSent = (await api(app, eve, "POST", "/api/friend-requests", { handle: carol.handle })).json.id;
    const mineReceived = (await api(app, alice, "POST", "/api/friend-requests", { handle: eve.handle })).json.id;

    const others = { othersPending, othersAccepted, upperCase: othersPending.toUpperCase() };
    for (const route of ["", "/accept", "/reject", "/withdraw"]) {
      const request = (id: string) => json(route ? "POST" : "GET", `/api/friend-requests/${id}${route}`);
      const answer = await indistinguishable(eve, `request${route}`, request, others);
      expect(answer).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    }
    // Your own request, in the role you do not have: the sender cannot accept or reject, the recipient cannot withdraw.
    for (const route of ["/accept", "/reject"]) {
      await indistinguishable(eve, `own sent${route}`, (id) => json("POST", `/api/friend-requests/${id}${route}`), { mineSent });
    }
    await indistinguishable(eve, "own received/withdraw", (id) => json("POST", `/api/friend-requests/${id}/withdraw`), { mineReceived });
    // Positive control: both are hers to read.
    expect((await api(app, eve, "GET", `/api/friend-requests/${mineSent}`)).status).toBe(200);
    expect((await api(app, eve, "GET", `/api/friend-requests/${mineReceived}`)).status).toBe(200);
  });

  it("principal ids: unfriend, unblock, adding to a group or a new group, and removing from a group treat a stranger like a random id", async () => {
    const [eve, friend1, friend2, stranger] = [await signUp(app, "eve"), await signUp(app, "friend1"), await signUp(app, "friend2"), await signUp(app, "stranger")];
    await befriend(app, eve, friend1);
    await befriend(app, eve, friend2);
    const g = await group(app, eve, "mine", [friend1, friend2]);
    const exStrangerFriend = await signUp(app, "exfriend");
    await befriend(app, eve, exStrangerFriend);
    expect((await api(app, eve, "DELETE", `/api/friends/${exStrangerFriend.id}`)).status).toBe(200);
    const strangers = { stranger: stranger.id, exFriend: exStrangerFriend.id, upperCase: stranger.id.toUpperCase() };

    // Someone else's Agent, too: only its owner may put it into a group, and eve is the creator here, so taking it out of
    // a group it is not in is the 404 anyone not in it gets. Her own Agent cannot be among a new group's members either.
    const othersAgent = (await mustCreateAgent(app, stranger)).id as string;
    const ownAgent = (await mustCreateAgent(app, eve)).id as string;
    const ids = { ...strangers, othersAgent };

    const unfriend = await indistinguishable(eve, "unfriend", (id) => json("DELETE", `/api/friends/${id}`), strangers);
    expect(unfriend).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    const addToGroup = await indistinguishable(eve, "add", (id) => json("POST", `/api/conversations/${g}/members`, { principalId: id }), ids);
    expect(addToGroup).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
    const newGroup = await indistinguishable(eve, "new group", (id) => json("POST", "/api/conversations", { title: "t", memberIds: [friend1.id, id] }), {
      ...ids,
      ownAgent,
    });
    expect(newGroup).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });
    const removeFromGroup = await indistinguishable(eve, "remove", (id) => json("DELETE", `/api/conversations/${g}/members/${id}`), { ...ids, ownAgent });
    expect(removeFromGroup).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    // A member who is not the creator: removing anybody is refused, someone else's Agent included.
    const notCreator = await indistinguishable(friend1, "remove, not the creator", (id) => json("DELETE", `/api/conversations/${g}/members/${id}`), {
      ...ids,
      ownAgent,
    });
    expect(notCreator).toMatchObject({ status: 403, body: '{"error":"forbidden"}' });

    // Unblocking someone you never blocked is a no-op, existing or not: the same 200.
    const unblock = async (id: string) => observe(eve, json("DELETE", `/api/blocks/${id}`));
    expect(await unblock(stranger.id)).toEqual(await unblock(RANDOM));
    expect((await unblock(RANDOM)).status).toBe(200);
  });

  it("an Agent's id: its avatar is as a random id's for everyone but its owner and whoever shares a conversation with it now, and blocking or unblocking it is as a random id's for everyone", async () => {
    const [owner, stranger, other] = [await signUp(app, "agentowner"), await signUp(app, "agentstranger"), await signUp(app, "otherowner")];
    const agent = (await api(app, owner, "POST", "/api/agents", { namePart: "enum_bot", name: "Enum" })).json;
    const otherAgent = (await api(app, other, "POST", "/api/agents", { namePart: "enum_other", name: "Other" })).json;
    expect([agent.id, otherAgent.id].every((id) => typeof id === "string")).toBe(true);
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a5d7e2d10000000049454e44ae426082", "hex");
    const put = await app.inject({ method: "PUT", url: `/api/agents/${agent.id}/avatar`, headers: { cookie: owner.cookie, "content-type": "image/png" }, payload: png });
    expect(put.statusCode).toBe(200);

    // A stranger, and the owner of a different Agent: GET and HEAD of the avatar as for a random id.
    for (const who of [stranger, other]) {
      for (const method of ["GET", "HEAD"] as const) {
        const answer = await indistinguishable(who, `${who.handle} ${method} avatar`, (id) => json(method, `/api/principals/${id}/avatar`), { agent: agent.id, upperCase: agent.id.toUpperCase() });
        expect(answer.status).toBe(404);
      }
    }
    // Its owner still loads it.
    const mine = await observe(owner, json("GET", `/api/principals/${agent.id}/avatar`));
    expect([mine.status, mine.type]).toEqual([200, "image/png"]);
    expect((await observe(owner, json("HEAD", `/api/principals/${agent.id}/avatar`))).status).toBe(200);

    // The members of a group it is in load it too, while both of them are members (its owner adds it). Once either
    // membership ends, its id is a random id's again for that member.
    const [mate, leaver] = [await signUp(app, "agentmate"), await signUp(app, "agentleaver")];
    const g = await group(app, owner, "with a bot", [mate, leaver]);
    expect((await api(app, owner, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const avatarOf = (method: "GET" | "HEAD") => (id: string) => json(method, `/api/principals/${id}/avatar`);
    for (const who of [mate, leaver]) {
      const seen = await observe(who, avatarOf("GET")(agent.id));
      expect([who.handle, seen.status, seen.type, seen.body]).toEqual([who.handle, 200, "image/png", mine.body]);
      expect((await observe(who, avatarOf("HEAD")(agent.id))).status).toBe(200);
    }
    // Seated in a group: still a random id's, byte for byte, for a stranger and for the owner of a different Agent.
    for (const who of [stranger, other]) {
      for (const method of ["GET", "HEAD"] as const) {
        const answer = await indistinguishable(who, `seated: ${who.handle} ${method} avatar`, avatarOf(method), { agent: agent.id, upperCase: agent.id.toUpperCase() });
        expect(answer.status).toBe(404);
      }
    }
    expect((await remove(leaver, g, leaver)).status).toBe(200);
    for (const method of ["GET", "HEAD"] as const) {
      expect((await indistinguishable(leaver, `left the group: ${method} avatar`, avatarOf(method), { agent: agent.id })).status).toBe(404);
    }
    expect((await observe(mate, avatarOf("GET")(agent.id))).status).toBe(200);
    expect((await api(app, owner, "DELETE", `/api/conversations/${g}/members/${agent.id}`)).status).toBe(200);
    for (const method of ["GET", "HEAD"] as const) {
      expect((await indistinguishable(mate, `the Agent left: ${method} avatar`, avatarOf(method), { agent: agent.id })).status).toBe(404);
    }
    expect((await observe(owner, avatarOf("GET")(agent.id))).status).toBe(200);

    // Blocks: an Agent cannot be blocked, by anybody, its owner included; unblocking it is the no-op a random id gets.
    for (const who of [stranger, other, owner]) {
      const block = await indistinguishable(who, `${who.handle} block`, (id) => json("PUT", `/api/blocks/${id}`), { agent: agent.id });
      expect(block).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
      const unblock = async (id: string) => observe(who, json("DELETE", `/api/blocks/${id}`));
      expect([who.handle, await unblock(agent.id)]).toEqual([who.handle, await unblock(RANDOM)]);
    }
    expect((await db.query("select 1 from blocks")).rowCount).toBe(0);
    // People are unaffected: the stranger still sees the owner's avatar and can block them.
    expect((await observe(stranger, json("GET", `/api/principals/${owner.id}/avatar`))).status).toBe(200);
    expect((await observe(stranger, json("PUT", `/api/blocks/${owner.id}`))).status).toBe(200);
  });

  it("the halt: a group you were never in, one you left, a closed one, an Agent's own conversation (yours or another's) and a direct chat (yours or others') are a random id's", async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    await befriend(app, alice, eve);
    const { conversationId: ownDirect } = await befriend(app, eve, carol);
    const { conversationId: othersDirect } = await befriend(app, alice, bob);
    const neverIn = await group(app, alice, "never", [bob, carol]);
    const left = await group(app, alice, "left", [eve, bob]);
    const closed = await group(app, alice, "closed", [eve, bob]);
    const ownAgent = (await mustCreateAgent(app, eve)).conversationId as string;
    const othersAgent = (await mustCreateAgent(app, alice)).conversationId as string;
    expect((await remove(eve, left, eve)).status).toBe(200);
    // She is the last to leave: the group closes behind her.
    for (const who of [alice, bob, eve]) expect((await remove(who, closed, who)).status).toBe(200);
    expect((await db.query("select closed_at is not null as closed from conversations where id = $1", [closed])).rows).toEqual([{ closed: true }]);

    const halt = (id: string) => json("POST", `/api/conversations/${id}/agents/halt`);
    const answer = await indistinguishable(eve, "halt", halt, { neverIn, left, closed, ownAgent, othersAgent, ownDirect, othersDirect, upperCase: closed.toUpperCase() });
    expect(answer).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    // Nothing was halted, and nobody was told anything.
    expect((await db.query("select count(*)::int as n from conversations where agents_halted_seq is not null")).rows).toEqual([{ n: 0 }]);
    expect((await db.query("select count(*)::int as n from messages where body ->> 'event' = 'agents_halted'")).rows).toEqual([{ n: 0 }]);
    // Positive control: in a group she is in, she may.
    const hers = await group(app, eve, "hers", [alice, carol]);
    expect(await api(app, eve, "POST", `/api/conversations/${hers}/agents/halt`)).toEqual({ status: 200, json: { ok: true } });
  });

  it("intended differences: any existing person can be blocked and has an avatar; a random id is 404", async () => {

    // Principal ids are learnt from handles (lookup, rate-limited) and from shared conversations; ids
    // themselves are random UUIDs, so answering by existence here reveals nothing guessable.
    const [eve, stranger] = [await signUp(app, "eve"), await signUp(app, "stranger")];
    const avatar = (id: string) => observe(eve, json("GET", `/api/principals/${id}/avatar`));
    expect((await avatar(stranger.id)).status).toBe(200);
    expect(await avatar(RANDOM)).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
    const block = (id: string) => observe(eve, json("PUT", `/api/blocks/${id}`));
    expect((await block(stranger.id)).status).toBe(200);
    expect(await block(RANDOM)).toMatchObject({ status: 404, body: '{"error":"not_found"}' });
  });
});

describe("enumeration: Agent, provider, run and persona-proposal ids", () => {
  const FAST = { source: "site", id: "fast" } as const;
  const OTHER_RANDOM = "0b6f3d2a-7c1e-4f5a-8d9b-1a2b3c4d5e6f";

  interface Ids {
    agent: string;
    conv: string;
    run: string;
    proposal: string;
    provider: string;
  }
  /** Every route of this batch that takes one of these ids, as a request built from them. */
  const routes: Array<[string, (ids: Ids) => InjectOptions]> = [
    ["agent", ({ agent }) => json("GET", `/api/agents/${agent}`)],
    ["agent HEAD", ({ agent }) => json("HEAD", `/api/agents/${agent}`)],
    ["edit", ({ agent }) => json("PATCH", `/api/agents/${agent}`, { intro: "mine now" })],
    ["edit the model", ({ agent, provider }) => json("PATCH", `/api/agents/${agent}`, { model: { source: "provider", providerId: provider, model: "m" } })],
    ["pause", ({ agent }) => json("POST", `/api/agents/${agent}/pause`)],
    ["resume", ({ agent }) => json("POST", `/api/agents/${agent}/resume`)],
    ["delete", ({ agent }) => json("DELETE", `/api/agents/${agent}`)],
    ["set an appellation", ({ agent }) => json("PUT", `/api/agents/${agent}/appellations/${RANDOM}`, { appellation: "称呼" })],
    ["remove an appellation", ({ agent }) => json("DELETE", `/api/agents/${agent}/appellations/${RANDOM}`)],
    ["avatar", ({ agent }) => ({ method: "PUT", url: `/api/agents/${agent}/avatar`, headers: { "content-type": "image/png" }, payload: PNG })],
    ["confirm", ({ agent, proposal }) => json("POST", `/api/agents/${agent}/proposals/${proposal}/confirm`, {})],
    ["confirm edited", ({ agent, proposal }) => json("POST", `/api/agents/${agent}/proposals/${proposal}/confirm`, { persona: "我的" })],
    ["discard", ({ agent, proposal }) => json("POST", `/api/agents/${agent}/proposals/${proposal}/discard`)],
    ["provider edit", ({ provider }) => json("PATCH", `/api/providers/${provider}`, { name: "mine now" })],
    ["provider rekey", ({ provider }) => json("PATCH", `/api/providers/${provider}`, { apiKey: "sk-attacker-key-0001" })],
    ["provider move", ({ provider }) => json("PATCH", `/api/providers/${provider}`, { baseUrl: "https://evil.example.test/v1" })],
    ["provider delete", ({ provider }) => json("DELETE", `/api/providers/${provider}`)],
    ["provider test", ({ provider }) => json("POST", `/api/providers/${provider}/test`)],
    ["provider test with a model", ({ provider }) => json("POST", `/api/providers/${provider}/test`, { model: "m" })],
    ["provider model list", ({ provider }) => json("POST", `/api/providers/${provider}/models/list`)],
    ["provider refresh", ({ provider }) => json("POST", `/api/providers/${provider}/models/refresh`)],
    ["run", ({ conv }) => json("GET", `/api/conversations/${conv}/run`)],
    ["stop", ({ conv, run }) => json("POST", `/api/conversations/${conv}/runs/${run}/stop`)],
    ["retry", ({ conv }) => json("POST", `/api/conversations/${conv}/runs/retry`)],
    ["dismiss", ({ conv }) => json("POST", `/api/conversations/${conv}/runs/dismiss`)],
    ["topic", ({ conv }) => json("POST", `/api/conversations/${conv}/topic`)],
    ["new Agent on the provider", ({ provider }) => json("POST", "/api/agents", { namePart: "enum_taker", name: "T", model: { source: "provider", providerId: provider, model: "m" } })],
    ["draft on the provider", ({ provider }) => json("POST", "/api/agents/draft-persona", { name: "T", model: { source: "provider", providerId: provider, model: "m" } })],
  ];

  it("a stranger and the owner of a different Agent get exactly a random id's answer, on every route, with every mix of real and random ids", async () => {
    const [owner, stranger, other] = [await signUp(app, "enum_owner"), await signUp(app, "enum_stranger"), await signUp(app, "enum_other")];
    // The owner: a provider an Agent uses, an Agent on the site model with a persona proposal, and its latest run failed.
    const provider = (await api(app, owner, "POST", "/api/providers", providerBody({ models: [{ name: "m" }] }))).json.id as string;
    await mustCreateAgent(app, owner, { model: { source: "provider", providerId: provider, model: "m" } });
    const agent = await mustCreateAgent(app, owner, { model: FAST, persona: "你是助手。" });
    const conv = agent.conversationId as string;
    for (const [i, step] of [() => gateway.reply("<af-persona>你是一个新助手。</af-persona>"), () => gateway.fail("provider_unavailable")].entries()) {
      step();
      expect((await api(app, owner, "POST", `/api/conversations/${conv}/messages`, { text: "整理一下", clientTxn: `enum-run-${i}` })).status).toBe(201);
      expect(await app.agentWorker.runOnce()).toBe(true);
    }
    const run = (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json.run;
    expect(run).toMatchObject({ status: "failed", retryable: true });
    const proposal = (await db.query<{ id: string }>("select id from persona_proposals where agent_id = $1", [agent.id])).rows[0]!.id;
    const real: Ids = { agent: agent.id, conv, run: run.id, proposal, provider };
    const random: Ids = { agent: RANDOM, conv: RANDOM, run: OTHER_RANDOM, proposal: OTHER_RANDOM, provider: RANDOM };
    // The other owner: an Agent, its conversation and a provider of their own.
    const otherProvider = (await api(app, other, "POST", "/api/providers", providerBody({ models: [{ name: "m" }] }))).json.id as string;
    const otherAgent = await mustCreateAgent(app, other, { model: FAST, persona: "你是助手。" });
    const own: Ids = { agent: otherAgent.id, conv: otherAgent.conversationId, run: OTHER_RANDOM, proposal: OTHER_RANDOM, provider: otherProvider };

    const before = {
      agent: (await api(app, owner, "GET", `/api/agents/${agent.id}`)).json,
      providers: (await api(app, owner, "GET", "/api/providers")).json,
      run: (await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json,
      proposal: (await db.query("select status from persona_proposals where id = $1", [proposal])).rows,
    };

    for (const who of [stranger, other]) {
      for (const [label, request] of routes) {
        const reference = await observe(who, request(random));
        // Every id real, and each id real on its own.
        const mixes: Array<[string, Ids]> = [
          ["all real", real],
          ...(Object.keys(real) as Array<keyof Ids>).map((k): [string, Ids] => [`only ${k} real`, { ...random, [k]: real[k] }]),
        ];
        for (const [mix, ids] of mixes) {
          expect([who.handle, label, mix, await observe(who, request(ids))]).toEqual([who.handle, label, mix, reference]);
        }
        if (who === other) {
          // Their own Agent, conversation and provider, with the owner's proposal, run or provider in the other place —
          // or a random one there: the same answer. (Only where the route takes that id: else the two are one request.)
          const ownMix: Array<[string, Ids, Ids]> = [
            ["own Agent: foreign or random proposal", { ...own, proposal }, { ...own, proposal: OTHER_RANDOM }],
            ["own conversation: foreign or random run", { ...own, run: run.id }, { ...own, run: OTHER_RANDOM }],
            ["own Agent: foreign or random provider", { ...own, provider }, { ...own, provider: RANDOM }],
          ];
          for (const [mix, foreign, rand] of ownMix) {
            if (JSON.stringify(request(foreign)) === JSON.stringify(request(rand))) continue;
            expect([label, mix, await observe(who, request(foreign))]).toEqual([label, mix, await observe(who, request(rand))]);
          }
        }
      }
    }

    // Nothing anybody tried changed anything of the owner's.
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}`)).json).toEqual(before.agent);
    expect((await api(app, owner, "GET", "/api/providers")).json).toEqual(before.providers);
    expect((await api(app, owner, "GET", `/api/conversations/${conv}/run`)).json).toEqual(before.run);
    expect((await db.query("select status from persona_proposals where id = $1", [proposal])).rows).toEqual(before.proposal);
    expect((await db.query("select 1 from agents a join principals p on p.id = a.principal_id where p.handle = 'enum_taker'")).rowCount).toBe(0);
    expect(gateway.pending()).toBe(0);
    // Positive control: the owner's own requests are answered (the ids are real).
    expect((await observe(owner, routes[0]![1](real))).status).toBe(200);
    expect((await observe(owner, json("POST", `/api/providers/${provider}/test`))).status).toBe(200);
    expect((await observe(owner, json("POST", `/api/providers/${provider}/models/list`))).status).toBe(200);
  });

  it("in a group: a run, or an Agent's run, of anyone but you is a random one's; a group you are not in is a random conversation; nor do an Agent's own conversation or a direct chat have a group's replies", async () => {
    const [owner, other, mate, leaver, stranger] = [
      await signUp(app, "grp_owner"),
      await signUp(app, "grp_other"),
      await signUp(app, "grp_mate"),
      await signUp(app, "grp_leaver"),
      await signUp(app, "grp_stranger"),
    ];
    const g = await group(app, owner, "replies", [other, mate, leaver]);
    expect((await remove(leaver, g, leaver)).status).toBe(200);
    const seat = async (who: Actor, handle: string) => {
      const agent = await mustCreateAgent(app, who, { handle, name: handle, model: FAST, persona: "你是助手。" });
      expect((await api(app, who, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
      return agent as { id: string; conversationId: string };
    };
    const anna = await seat(owner, "grp_anna");
    const theirs = await seat(other, "grp_theirs");
    const failedRun = async (agentId: string, ownerId: string, conv: string) =>
      (
        await db.query<{ id: string }>(
          `insert into agent_runs (purpose, conversation_id, agent_id, owner_id, status, error, covers_seq, finished_at)
           select 'reply', $1, $2, $3, 'failed', 'provider_unavailable', seq, now() from conversations where id = $1 returning id`,
          [conv, agentId, ownerId],
        )
      ).rows[0]!.id;
    const annaRun = await failedRun(anna.id, owner.id, g);
    const theirRun = await failedRun(theirs.id, other.id, g);
    const ownChatRun = await failedRun(anna.id, owner.id, anna.conversationId);
    const { conversationId: direct } = await befriend(app, owner, stranger);
    const stop = (run: string) => json("POST", `/api/conversations/${g}/runs/${run}/stop`);
    const retry = (agentId: string) => json("POST", `/api/conversations/${g}/runs/retry`, { agentId });
    const dismiss = (agentId: string) => json("POST", `/api/conversations/${g}/runs/dismiss`, { agentId });

    // Fellow members — one owns another Agent there — and the owner, with someone else's run, Agent or person.
    for (const [who, foreignRuns, foreignAgents] of [
      [mate, { annaRun, theirRun, ownChatRun }, { anna: anna.id, theirs: theirs.id, person: owner.id }],
      [other, { annaRun, ownChatRun, upperCase: annaRun.toUpperCase() }, { anna: anna.id, person: mate.id, upperCase: anna.id.toUpperCase() }],
      [owner, { theirRun }, { theirs: theirs.id, person: other.id }],
    ] as const) {
      expect((await indistinguishable(who, `${who.handle} stop`, stop, foreignRuns, OTHER_RANDOM)).body).toBe('{"error":"not_found"}');
      for (const [label, request] of [
        ["retry", retry],
        ["dismiss", dismiss],
      ] as const) {
        expect((await indistinguishable(who, `${who.handle} ${label}`, request, foreignAgents)).body).toBe('{"error":"not_found"}');
      }
    }
    // A former member and a stranger: every group route on it, as on a conversation that does not exist.
    const onGroup: Array<[string, (id: string) => InjectOptions]> = [
      ["group replies", (id) => json("GET", `/api/conversations/${id}/runs`)],
      ["halt", (id) => json("POST", `/api/conversations/${id}/agents/halt`)],
      ["stop", (id) => json("POST", `/api/conversations/${id}/runs/${annaRun}/stop`)],
      ["retry", (id) => json("POST", `/api/conversations/${id}/runs/retry`, { agentId: anna.id })],
      ["dismiss", (id) => json("POST", `/api/conversations/${id}/runs/dismiss`, { agentId: anna.id })],
      ["retry without agentId", (id) => json("POST", `/api/conversations/${id}/runs/retry`)],
    ];
    for (const who of [leaver, stranger]) {
      for (const [label, request] of onGroup) {
        expect((await indistinguishable(who, `${who.handle} ${label}`, request, { g, upperCase: g.toUpperCase() })).status).toBe(404);
      }
    }
    // A group's replies are a group's: the owner's own Agent conversation and a direct chat answer as a random id.
    const replies = (id: string) => json("GET", `/api/conversations/${id}/runs`);
    expect((await indistinguishable(owner, "replies of another kind of conversation", replies, { own: anna.conversationId, direct })).status).toBe(404);

    // Nothing anybody tried changed anything; and the owners' own requests are answered (positive control).
    const states = await db.query("select id, status, dismissed_at from agent_runs where id = any($1::uuid[]) order by id", [[annaRun, theirRun, ownChatRun]]);
    expect(states.rows.map((r) => [r.status, r.dismissed_at])).toEqual([0, 1, 2].map(() => ["failed", null]));
    expect((await db.query("select count(*)::int as n from agent_runs where conversation_id = $1", [g])).rows[0].n).toBe(2);
    expect((await api(app, owner, "GET", `/api/conversations/${g}/runs`)).json.runs).toHaveLength(2);
    expect(await api(app, other, "POST", `/api/conversations/${g}/runs/dismiss`, { agentId: theirs.id })).toEqual({ status: 200, json: { ok: true } });
    expect(await api(app, owner, "POST", `/api/conversations/${g}/runs/${annaRun}/stop`)).toEqual({ status: 200, json: { ok: true } });
  });
});

describe("enumeration by timing (coarse)", () => {
  // Coarse on purpose: medians of interleaved calls, compared within a factor of 2. Before the catch-up
  // fix the busy conversation's median was ~2.8x the random id's (16 ms vs 6 ms with 30 000 messages).
  const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
  const ratio = (a: number, b: number) => Math.max(a, b) / Math.min(a, b);

  /** Times `a` and `b` alternately (so load drift hits both alike) and returns both medians in ms. */
  async function race(a: () => Promise<unknown>, b: () => Promise<unknown>, rounds = 25): Promise<[number, number]> {
    const time = async (f: () => Promise<unknown>) => {
      const t0 = performance.now();
      await f();
      return performance.now() - t0;
    };
    for (let i = 0; i < 3; i++) await Promise.all([time(a), time(b)]); // warm up both paths
    const ta: number[] = [];
    const tb: number[] = [];
    for (let i = 0; i < rounds; i++) {
      ta.push(await time(a));
      tb.push(await time(b));
    }
    return [median(ta), median(tb)];
  }

  /** `n` text messages from `sender`, written straight into the table (setup only; nothing reads them through the API). */
  async function seed(conversationId: string, sender: string, n: number): Promise<void> {
    await db.query(
      `with c as (select seq from conversations where id = $1 for update)
       insert into messages (conversation_id, seq, sender_id, kind, body)
       select $1, c.seq + g, $2, 'text', jsonb_build_object('text', 'filler ' || g) from c, generate_series(1, $3::int) g`,
      [conversationId, sender, n],
    );
    await db.query("update conversations set seq = seq + $2 where id = $1", [conversationId, n]);
  }

  it("catch-up: a busy conversation you are not in costs about what a random id costs", { timeout: 60_000 }, async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const busy = await group(app, alice, "busy", [bob, carol]);
    await seed(busy, alice.id, 30_000);
    const catchUp = (id: string) => async () => {
      const res = await api(app, eve, "POST", "/api/sync/catchup", { positions: { [id]: 0 } });
      expect(res.json).toEqual({ messages: [], gone: [id], more: false });
    };
    const [existing, random] = await race(catchUp(busy), catchUp(RANDOM));
    expect(ratio(existing, random), `medians: existing ${existing.toFixed(2)} ms, random ${random.toFixed(2)} ms`).toBeLessThan(2);
  });

  it("whispers: someone else's, open or answered, is a random id's to accept and decline; a group you are in without an Agent of yours has no whisper list for you", async () => {
    const [eve, alice, bob] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob")];
    const g = await group(app, alice, "told", [eve, bob]);
    const agent = await mustCreateAgent(app, alice, { model: { source: "site", id: "fast" } });
    expect((await api(app, alice, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    // A found_elsewhere one that reads open: its hit is a real reference (alice's note to her Agent).
    const note = await api(app, alice, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "记一下", clientTxn: "enum-note" });
    const detail = { hits: [{ conversationId: agent.conversationId, seq: note.json.message.seq, at: 0 }] };
    const make = () => db.tx((t) => createWhisper(t, { conversationId: g, ownerId: alice.id, agentId: agent.id, kind: "found_elsewhere", body: { text: "只给 alice", actions: ["tell", "dismiss"], detail } }));
    const open = (await make())!;
    const answered = (await make())!;
    expect((await api(app, alice, "POST", `/api/whispers/${answered.id}/decline`)).status).toBe(200);
    for (const verb of ["accept", "decline"]) {
      const answer = await indistinguishable(eve, verb, (id) => json("POST", `/api/whispers/${id}/${verb}`), { open: open.id, answered: answered.id, upperCase: open.id.toUpperCase() });
      expect([verb, answer.status, answer.body]).toEqual([verb, 404, '{"error":"not_found"}']);
    }
    const list = await indistinguishable(eve, "whispers", (id) => json("GET", `/api/conversations/${id}/whispers`), { member: g, agentConversation: agent.conversationId });
    expect([list.status, list.body]).toEqual([404, '{"error":"not_found"}']);
    // Nothing she tried answered anything.
    expect((await db.query("select status from whispers order by created_at")).rows).toEqual([{ status: "open" }, { status: "declined" }]);
  });

  it("whispers: answering someone else's costs about what a random id costs", { timeout: 60_000 }, async () => {
    const [eve, alice, bob] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob")];
    const g = await group(app, alice, "told", [eve, bob]);
    const agent = await mustCreateAgent(app, alice, { model: { source: "site", id: "fast" } });
    expect((await api(app, alice, "POST", `/api/conversations/${g}/members`, { principalId: agent.id })).status).toBe(201);
    const note = await api(app, alice, "POST", `/api/conversations/${agent.conversationId}/messages`, { text: "记一下", clientTxn: "enum-note" });
    const detail = { hits: [{ conversationId: agent.conversationId, seq: note.json.message.seq, at: 0 }] };
    const told = await db.tx((t) => createWhisper(t, { conversationId: g, ownerId: alice.id, agentId: agent.id, kind: "found_elsewhere", body: { text: "只给 alice", actions: ["tell", "dismiss"], detail } }));
    const accept = (id: string) => async () => {
      const res = await api(app, eve, "POST", `/api/whispers/${id}/accept`);
      expect(res).toEqual({ status: 404, json: { error: "not_found" } });
    };
    const [existing, random] = await race(accept(told!.id), accept(RANDOM));
    expect(ratio(existing, random), `medians: existing ${existing.toFixed(2)} ms, random ${random.toFixed(2)} ms`).toBeLessThan(2);
  });

  it("download: an attachment you may not see costs about what a random id costs", { timeout: 60_000 }, async () => {
    const [eve, alice, bob, carol] = [await signUp(app, "eve"), await signUp(app, "alice"), await signUp(app, "bob"), await signUp(app, "carol")];
    const elsewhere = await group(app, alice, "elsewhere", [bob, carol]);
    await seed(elsewhere, alice.id, 30_000);
    const hidden = await sendFile(alice, elsewhere, "hidden.bin");
    const download = (id: string) => async () => {
      const res = await app.inject({ method: "GET", url: `/api/attachments/${id}`, headers: { cookie: eve.cookie } });
      expect(res.statusCode).toBe(404);
    };
    const [existing, random] = await race(download(hidden), download(RANDOM));
    expect(ratio(existing, random), `medians: existing ${existing.toFixed(2)} ms, random ${random.toFixed(2)} ms`).toBeLessThan(2);
  });
});
