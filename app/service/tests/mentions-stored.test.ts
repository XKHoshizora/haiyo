import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ADDRESS_PATTERN, addressRanges, codeRanges, inAddress, mentionsAtSend } from "../src/agents/mentions.ts";
import { judgeable, namesAnAgent } from "../src/agents/proactive/candidates.ts";
import { NOTHING, type RunTicket } from "../src/agents/runtime/port.ts";
import { postAsAgent } from "../src/agents/conversation.ts";
import { triggerFromAgent } from "../src/agents/runs.ts";
import { lockAgent } from "../src/agents/store.ts";
import { insertMessage } from "../src/messages/model.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedGateway } from "./helpers/models.ts";
import { MULTIPART, multipart } from "./helpers/multipart.ts";
import { closeAllSockets, connect } from "./helpers/ws.ts";

/**
 * A mention carries who it means (Task M): who a mention means is decided once, when the message is sent, and stored with
 * it (`messages.mentions`: `[{id, start, length}]`, UTF-16 code units of the stored text). A mention picked from the @
 * list is sent with its id; `@…` typed and not picked is read once, at send, with the reading of family names; an
 * Agent's reply is read once, at its post. Every reader — the triggers, the follow-up, the proactive judgement, the web —
 * reads the stored entries, never the text again. Runs are only queued here: no worker picks them up.
 */

const gateway = scriptedGateway();
const { app, db } = useApp({ env: SITE_ENV, models: gateway, agentWorker: false });

afterEach(async () => {
  await closeAllSockets();
  expect(gateway.pending()).toBe(0);
});

const FAST = { source: "site", id: "fast" } as const;

type Mention = { id: string; start: number; length: number };

/** Puts principal `id` into conversation `conv` from its current seq on. */
const join = (conv: string, id: string) =>
  db.query(`insert into memberships (conversation_id, principal_id, role, joined_seq) select $1, $2, 'speaker', seq from conversations where id = $1`, [
    conv,
    id,
  ]);

/** An Agent of `owner` with name part `namePart` and name `name`, answering on the site model, put into `conv` when given. */
async function agentOf(owner: Actor, namePart: string, conv: string | null, name = `${namePart}的名字`) {
  const agent = await mustCreateAgent(app, owner, { namePart, name, model: FAST, persona: "简短地回答。" });
  if (conv) await join(conv, agent.id);
  return agent as { id: string; handle: string; conversationId: string };
}

let txn = 0;
/** Sends `text` (with `mentions` picked, when given) as `who`; the answer as it came. */
const send = (who: Actor, conv: string, text: string, mentions?: unknown) =>
  api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ms${++txn}`, ...(mentions === undefined ? {} : { mentions }) });
const say = async (who: Actor, conv: string, text: string, mentions?: Mention[]): Promise<number> => {
  const sent = await send(who, conv, text, mentions);
  if (sent.status !== 201) throw new Error(`say: ${sent.status} ${JSON.stringify(sent.json)}`);
  return sent.json.message.seq as number;
};

/** What is stored for the message at `seq`. */
const stored = async (conv: string, seq: number): Promise<Mention[] | null> =>
  (await db.query<{ mentions: Mention[] | null }>("select mentions from messages where conversation_id = $1 and seq = $2", [conv, seq])).rows[0]!.mentions;

/** The seqs the Agent's runs in `conv` cover, oldest first. */
const covered = async (agentId: string, conv: string): Promise<number[]> =>
  (await db.query<{ covers: number }>("select covers_seq::int as covers from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at, id", [agentId, conv])).rows.map(
    (r) => r.covers,
  );
const allRuns = async () => Number((await db.query("select count(*) n from agent_runs")).rows[0].n);
const usage = async () => Number((await db.query("select count(*) n from usage_records")).rows[0].n);
const settleAll = () => db.query("update agent_runs set status = 'done', finished_at = now() where status in ('queued', 'running')");

/** The message at `seq` as `who` reads it (history). */
const read = async (who: Actor, conv: string, seq: number) => {
  const page = await api(app, who, "GET", `/api/conversations/${conv}/messages`);
  return (page.json.messages as Array<{ seq: number; [k: string]: unknown }>).find((m) => m.seq === seq)!;
};

interface World {
  xiaolin: Actor;
  bobby: Actor;
  anna: Actor;
  /** The person 「Jarvis」, handle tony. */
  tony: Actor;
  g: string;
}

async function world(): Promise<World> {
  const [xiaolin, bobby, anna, tony] = [await signUp(app, "xiaolin"), await signUp(app, "bobby"), await signUp(app, "anna"), await signUp(app, "tony")];
  expect((await api(app, tony, "PATCH", "/api/me", { displayName: "Jarvis" })).status).toBe(200);
  return { xiaolin, bobby, anna, tony, g: await group(app, xiaolin, "family", [bobby, anna, tony]) };
}

describe("a mention picked from the list means the one picked", () => {
  it("the person 「Jarvis」 (handle tony) picked with the Agent xiaolin.jarvis in the group: no run, no points; the Agent picked (shown by its name): one run", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g, "贾维斯");
    const runs = await allRuns();
    const person = [{ id: w.tony.id, start: 0, length: 7 }];
    const one = await say(w.anna, w.g, "@Jarvis 你好", person);
    expect(await stored(w.g, one)).toEqual(person);
    expect([await allRuns(), await usage()]).toEqual([runs, 0]);

    const agent = [{ id: jarvis.id, start: 2, length: 4 }];
    const two = await say(w.anna, w.g, "问问@贾维斯 吧", agent);
    expect(await stored(w.g, two)).toEqual(agent);
    expect(await covered(jarvis.id, w.g)).toEqual([two]);
  });

  it("a multi-word name 「Jarvis Lee」 picked is one mention of that person and calls no Agent; the @Jarvis inside it is not read", async () => {
    const w = await world();
    const lee = await signUp(app, "lee");
    expect((await api(app, lee, "PATCH", "/api/me", { displayName: "Jarvis Lee" })).status).toBe(200);
    await join(w.g, lee.id);
    // No person 「Jarvis」 here: tony leaves, so a typed @jarvis would call the Agent.
    expect((await api(app, w.tony, "DELETE", `/api/conversations/${w.g}/members/${w.tony.id}`)).status).toBe(200);
    await agentOf(w.xiaolin, "jarvis", w.g);
    const runs = await allRuns();
    const picked = [{ id: lee.id, start: 0, length: 11 }];
    const seq = await say(w.anna, w.g, "@Jarvis Lee 明天见", picked);
    expect(await stored(w.g, seq)).toEqual(picked);
    expect(await allRuns()).toBe(runs);
  });

  it("two people with the same display name are each mentioned by their own id", async () => {
    const w = await world();
    const other = await signUp(app, "tony_two");
    expect((await api(app, other, "PATCH", "/api/me", { displayName: "Jarvis" })).status).toBe(200);
    await join(w.g, other.id);
    const both = [
      { id: w.tony.id, start: 0, length: 7 },
      { id: other.id, start: 10, length: 7 },
    ];
    const seq = await say(w.anna, w.g, "@Jarvis 和 @Jarvis 都来", both);
    expect(await stored(w.g, seq)).toEqual(both);
    expect((await read(w.bobby, w.g, seq)).mentions).toEqual(both);
  });
});

describe("what was decided at send stays decided", () => {
  it("the owner renames after sending: the message still means the same Agent, and a reply waiting on it is answered", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    await say(w.anna, w.g, "@xiaolin.jarvis 一");
    const ticket = await claim(jarvis.id, w.g);
    const noted = await say(w.bobby, w.g, "@xiaolin.jarvis 帮我查一下");
    const entry = [{ id: jarvis.id, start: 0, length: 15 }];
    expect(await stored(w.g, noted)).toEqual(entry);
    expect((await api(app, w.xiaolin, "PATCH", "/api/me", { handle: "lin" })).status).toBe(200);
    // Shown over the same range, meaning the same Agent, though its handle is lin.jarvis now.
    expect((await read(w.anna, w.g, noted)).mentions).toEqual(entry);
    await finish(ticket);
    const next = await latestRun(jarvis.id, w.g);
    expect(next).toMatchObject({ status: "queued", by: "human", lane: "others", caller: w.bobby.id });
    expect(next!.calls).toContain(noted);
  });

  it("a second Agent with the same name part joins after sending: nothing changes for the sent message; a new bare one means nobody", async () => {
    const w = await world();
    const mine = await agentOf(w.xiaolin, "helper", w.g);
    const one = await say(w.anna, w.g, "@helper 在吗");
    expect(await stored(w.g, one)).toEqual([{ id: mine.id, start: 0, length: 7 }]);
    await settleAll();
    await agentOf(w.bobby, "helper", w.g);
    expect(await stored(w.g, one)).toEqual([{ id: mine.id, start: 0, length: 7 }]);
    expect((await read(w.bobby, w.g, one)).mentions).toEqual([{ id: mine.id, start: 0, length: 7 }]);
    const runs = await allRuns();
    const two = await say(w.anna, w.g, "@helper 你好");
    expect(await stored(w.g, two)).toBeNull();
    expect(await allRuns()).toBe(runs);
  });

  it("a stored entry whose principal has left or been deleted stays as data and calls nobody new", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const one = await say(w.anna, w.g, "@xiaolin.jarvis 一");
    await settleAll();
    expect((await api(app, w.xiaolin, "DELETE", `/api/agents/${jarvis.id}`)).status).toBe(200);
    expect(await stored(w.g, one)).toEqual([{ id: jarvis.id, start: 0, length: 15 }]);
    expect((await read(w.anna, w.g, one)).mentions).toEqual([{ id: jarvis.id, start: 0, length: 15 }]);
  });
});

describe("picked mentions are checked: anything wrong is 400 bad_mentions and nothing is stored", () => {
  it.each<[string, (w: World & { jarvis: string; stranger: string; outside: string; gone: string }) => [string, unknown]]>([
    ["an id that is not a member", (w) => ["@路人 你好", [{ id: w.stranger, start: 0, length: 3 }]]],
    // Fix round 1 (M-7): a deleted Agent, still a member of the group, cannot be picked.
    ["a deleted Agent", (w) => ["@已删 你好", [{ id: w.gone, start: 0, length: 3 }]]],
    // Fix round 1 (M-2): a range is exactly one `@name`: not `@` alone, not `@` and spaces, no line break inside, no
    // space at either end, at most 1 + 49 characters.
    ["a range of just @", (w) => ["@ 你好", [{ id: w.tony.id, start: 0, length: 1 }]]],
    ["a range of @ and a space", (w) => ["@ Jarvis", [{ id: w.tony.id, start: 0, length: 8 }]]],
    ["a range with a space at its end", (w) => ["@Jarvis 你好", [{ id: w.tony.id, start: 0, length: 8 }]]],
    ["a range across a line break", (w) => ["@Jar\nvis", [{ id: w.tony.id, start: 0, length: 8 }]]],
    ["a range longer than any name", (w) => [`@${"长".repeat(50)}`, [{ id: w.tony.id, start: 0, length: 51 }]]],
    // Fix round 1 (I-3): a name inside an address is nobody being addressed.
    ["a range right after a / (an address)", (w) => ["看 https://example.com/@Jarvis", [{ id: w.tony.id, start: 22, length: 7 }]]],
    ["a range inside a link target", (w) => ["[主页](x.example/u?@Jarvis)", [{ id: w.tony.id, start: 17, length: 7 }]]],
    ["an Agent that is not in the group", (w) => ["@外人 你好", [{ id: w.outside, start: 0, length: 3 }]]],
    ["an unknown id", () => ["@谁 你好", [{ id: "3f1c2a4e-9b7d-4c1e-8a2f-5d6e7f809a1b", start: 0, length: 2 }]]],
    ["a range past the end", (w) => ["@Jarvis", [{ id: w.tony.id, start: 0, length: 8 }]]],
    ["a start past the end", (w) => ["@Jarvis", [{ id: w.tony.id, start: 9, length: 1 }]]],
    ["a range not beginning with @", (w) => ["你好 @Jarvis", [{ id: w.tony.id, start: 0, length: 3 }]]],
    [
      "overlapping ranges",
      (w) => [
        "@Jarvis @贾维斯",
        [
          { id: w.tony.id, start: 0, length: 9 },
          { id: w.jarvis, start: 8, length: 4 },
        ],
      ],
    ],
    [
      "ranges out of order",
      (w) => [
        "@Jarvis @贾维斯",
        [
          { id: w.jarvis, start: 8, length: 4 },
          { id: w.tony.id, start: 0, length: 7 },
        ],
      ],
    ],
    ["a range that ends inside a surrogate pair", (w) => ["@😀x", [{ id: w.tony.id, start: 0, length: 2 }]]],
    ["21 entries", (w) => ["@J ".repeat(21).trim(), Array.from({ length: 21 }, (_, i) => ({ id: w.tony.id, start: i * 3, length: 2 }))]],
  ])("%s", async (_name, make) => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g, "贾维斯");
    const stranger = await signUp(app, "stranger");
    const outside = await agentOf(w.bobby, "outside", null);
    const gone = await agentOf(w.bobby, "gone", w.g, "已删");
    expect((await api(app, w.bobby, "DELETE", `/api/agents/${gone.id}`)).status).toBe(200);
    const [text, mentions] = make({ ...w, jarvis: jarvis.id, stranger: stranger.id, outside: outside.id, gone: gone.id });
    const seq = Number((await db.query("select seq from conversations where id = $1", [w.g])).rows[0].seq);
    const runs = await allRuns();
    expect(await send(w.anna, w.g, text, mentions)).toMatchObject({ status: 400, json: { error: "bad_mentions" } });
    expect(Number((await db.query("select seq from conversations where id = $1", [w.g])).rows[0].seq)).toBe(seq);
    expect(await allRuns()).toBe(runs);
  });

  it("20 picked entries are taken", async () => {
    const w = await world();
    const text = "@J ".repeat(20).trim();
    const mentions = Array.from({ length: 20 }, (_, i) => ({ id: w.tony.id, start: i * 3, length: 2 }));
    expect(await stored(w.g, await say(w.anna, w.g, text, mentions))).toEqual(mentions);
  });

  it("ranges count in UTF-16 code units of the text as stored (trimmed, bidi controls removed)", async () => {
    const w = await world();
    // Stored as "😀😀 @Jarvis" (the spaces trimmed, the override removed): the @ is at code unit 5 of that.
    const seq = await say(w.anna, w.g, "  😀\u202E😀 @Jarvis", [{ id: w.tony.id, start: 5, length: 7 }]);
    expect(await stored(w.g, seq)).toEqual([{ id: w.tony.id, start: 5, length: 7 }]);
  });
});

describe("typed mentions are read once, at send", () => {
  it("a typed full handle and a typed bare name are stored with the range they matched; an ambiguous bare name stores nothing", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const one = await say(w.anna, w.g, "请 @xiaolin.jarvis。");
    expect(await stored(w.g, one)).toEqual([{ id: jarvis.id, start: 2, length: 15 }]);
    expect(await covered(jarvis.id, w.g)).toEqual([one]);
    await settleAll();
    // tony (「Jarvis」) leaves: the bare name is the Agent's.
    expect((await api(app, w.tony, "DELETE", `/api/conversations/${w.g}/members/${w.tony.id}`)).status).toBe(200);
    const two = await say(w.anna, w.g, "@jarvis 在吗 @jarvis");
    expect(await stored(w.g, two)).toEqual([
      { id: jarvis.id, start: 0, length: 7 },
      { id: jarvis.id, start: 11, length: 7 },
    ]);
    await settleAll();
    // A second jarvis: the bare name means nobody, and nothing is stored.
    await agentOf(w.bobby, "jarvis", w.g);
    const runs = await allRuns();
    const three = await say(w.anna, w.g, "@jarvis 你好");
    expect(await stored(w.g, three)).toBeNull();
    expect(await allRuns()).toBe(runs);
  });

  it("a typed person's handle or one-word display name is stored as that person, and calls no Agent", async () => {
    const w = await world();
    await agentOf(w.xiaolin, "jarvis", w.g);
    const runs = await allRuns();
    const seq = await say(w.bobby, w.g, "@Jarvis 和 @anna 好");
    expect(await stored(w.g, seq)).toEqual([
      { id: w.tony.id, start: 0, length: 7 },
      { id: w.anna.id, start: 10, length: 5 },
    ]);
    expect(await allRuns()).toBe(runs);
  });

  it("typed text inside a picked range is not read again; typed text beside it is", async () => {
    const w = await world();
    const helper = await agentOf(w.bobby, "helper", w.g);
    const seq = await say(w.anna, w.g, "@Jarvis @helper", [{ id: w.tony.id, start: 0, length: 7 }]);
    expect(await stored(w.g, seq)).toEqual([
      { id: w.tony.id, start: 0, length: 7 },
      { id: helper.id, start: 8, length: 7 },
    ]);
  });

  it("nothing inside code — a backtick span or a fenced block — is read", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const runs = await allRuns();
    for (const text of ["写 `@xiaolin.jarvis` 就行", "```\n@xiaolin.jarvis\n```", "~~~js\nask(@xiaolin.jarvis)\n~~~\n", "``a ` @xiaolin.jarvis``"]) {
      expect([text, await stored(w.g, await say(w.anna, w.g, text))]).toEqual([text, null]);
    }
    expect(await allRuns()).toBe(runs);
    // Outside a span that closes, and after an unclosed backtick, it is read.
    const after = await say(w.anna, w.g, "`code` @xiaolin.jarvis");
    expect(await stored(w.g, after)).toEqual([{ id: jarvis.id, start: 7, length: 15 }]);
    const unclosed = await say(w.anna, w.g, "`@xiaolin.jarvis");
    expect(await stored(w.g, unclosed)).toEqual([{ id: jarvis.id, start: 1, length: 15 }]);
  });

  it("codeRanges: fenced blocks (closed or to the end) and backtick spans of the same length; escaped and unmatched backticks are text", () => {
    expect(codeRanges("a `b` c")).toEqual([[2, 5]]);
    expect(codeRanges("``a ` b`` c")).toEqual([[0, 9]]);
    expect(codeRanges("\\`a` b")).toEqual([]);
    expect(codeRanges("`a")).toEqual([]);
    expect(codeRanges("x\n```\ncode\n```\ny")).toEqual([[2, 14]]);
    expect(codeRanges("x\n~~~\nopen")).toEqual([[2, 10]]);
    expect(codeRanges("`a\n\nb`")).toEqual([]);
  });

  it("in an Agent's own conversation (answering when called) its name after @ still calls it, and is stored", async () => {
    const owner = await signUp(app, "xiaolin");
    const agent = await mustCreateAgent(app, owner, { namePart: "jarvis", name: "贾维斯", model: FAST, persona: "简短地回答。", replyMode: "mention" });
    const conv = agent.conversationId as string;
    const seq = await say(owner, conv, "那么@贾维斯 在吗");
    expect(await stored(conv, seq)).toEqual([{ id: agent.id, start: 2, length: 4 }]);
    expect(await covered(agent.id, conv)).toEqual([seq]);
    await settleAll();
    const picked = await say(owner, conv, "@小助手 你好", [{ id: agent.id, start: 0, length: 4 }]);
    expect(await covered(agent.id, conv)).toEqual([seq, picked]);
    await settleAll();
    // Its name in an address is no call there either (fix round 2, M-2): after a /, or inside a URL.
    const runs = await allRuns();
    for (const text of ["看 https://x.example/@贾维斯", "见 x.example/@贾维斯 吧", "链接 https://x.example/u?n=@贾维斯 打开"]) {
      expect([text, await stored(conv, await say(owner, conv, text))]).toEqual([text, null]);
    }
    expect(await allRuns()).toBe(runs);
  });
});

describe("an Agent's reply is read once, at its post", () => {
  it("a reply naming another Agent by its full handle stores the entry and calls it by that entry", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const helper = await agentOf(w.bobby, "helper", w.g);
    await say(w.anna, w.g, "@xiaolin.jarvis 帮忙");
    const ticket = await claim(jarvis.id, w.g);
    const posted = await db.tx((t) =>
      postAsAgent(t, jarvis.id, w.g, ticket.id, { text: "我请 @bobby.helper 来。", reasoning: "", stopped: false, truncated: false }, "k7f2ab", app.deps.config),
    );
    expect(posted?.triggered.runs).toHaveLength(1);
    expect(posted!.message.mentions).toEqual([{ id: helper.id, start: 3, length: 13 }]);
    expect(await stored(w.g, posted!.message.seq)).toEqual([{ id: helper.id, start: 3, length: 13 }]);
    expect(await covered(helper.id, w.g)).toEqual([posted!.message.seq]);
  });

  it("the trigger reads the stored entries, not the text: an entry calls its Agent whatever the text says; the text alone calls nobody", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const helper = await agentOf(w.bobby, "helper", w.g);
    await say(w.anna, w.g, "大家好");
    const posted = (text: string, mentions: Mention[] | null) =>
      db.tx(async (t) => {
        const poster = await lockAgent(t, jarvis.id, w.g);
        const message = await insertMessage(t, w.g, jarvis.id, "text", { text }, null, { mentions, asksAgent: false });
        return triggerFromAgent(t, w.g, message, poster, null, app.deps.config, null);
      });
    expect((await posted("@bobby.helper 你来", null)).runs).toEqual([]);
    expect((await posted("@他 你来", [{ id: helper.id, start: 0, length: 2 }])).runs).toHaveLength(1);
  });
});

describe("a message stored before mentions were (mentions null) names nobody", () => {
  it("no run, no name for the judgement, no `mentions` on the wire", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const seq = await db.tx(async (t) => {
      await t.query("select 1 from conversations where id = $1 for update", [w.g]);
      return (await insertMessage(t, w.g, w.anna.id, "text", { text: "@xiaolin.jarvis 旧消息" }, null)).seq;
    });
    expect(await stored(w.g, seq)).toBeNull();
    expect(await namesAnAgent(db, null)).toBe(false);
    expect(await judgeable(db, w.g, seq)).toEqual({ senderId: w.anna.id });
    expect(await covered(jarvis.id, w.g)).toEqual([]);
    expect((await read(w.bobby, w.g, seq)).mentions).toBeUndefined();
    // Read with the stored entries alone: an Agent picked names an Agent for the judgement; a person does not.
    expect(await namesAnAgent(db, [{ id: jarvis.id, start: 0, length: 2 }])).toBe(true);
    expect(await namesAnAgent(db, [{ id: w.tony.id, start: 0, length: 2 }])).toBe(false);
  });

  it("mentionsAtSend is the one reading: it is what an Agent's post and a person's send store", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    expect(await db.tx((t) => mentionsAtSend(t, { id: w.g, type: "group" }, "hi @xiaolin.jarvis"))).toEqual({
      mentions: [{ id: jarvis.id, start: 3, length: 15 }],
      asksAgent: false,
    });
    expect(await db.tx((t) => mentionsAtSend(t, { id: w.g, type: "group" }, "hi"))).toEqual({ mentions: null, asksAgent: false });
  });
});

describe("what goes out", () => {
  it("every member who can read the message gets `mentions` with it, and nothing new besides", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const socket = await connect(app, w.bobby);
    const seq = await say(w.anna, w.g, "@Jarvis 和 @xiaolin.jarvis", [{ id: w.tony.id, start: 0, length: 7 }]);
    const entries = [
      { id: w.tony.id, start: 0, length: 7 },
      { id: jarvis.id, start: 10, length: 15 },
    ];
    const history = await api(app, w.bobby, "GET", `/api/conversations/${w.g}/messages`);
    const message = (history.json.messages as Array<Record<string, unknown>>).find((m) => m.seq === seq)!;
    expect(Object.keys(message).sort()).toEqual(["conversationId", "createdAt", "kind", "mentions", "senderId", "seq", "text"]);
    expect(message.mentions).toEqual(entries);
    for (const entry of message.mentions as Array<Record<string, unknown>>) expect(Object.keys(entry).sort()).toEqual(["id", "length", "start"]);
    const one = await api(app, w.tony, "GET", `/api/conversations/${w.g}/messages/${seq}`);
    expect(one.json.message.mentions).toEqual(entries);
    // The principals of the read are the sender's alone: a mention adds nobody to them.
    expect(Object.keys(one.json.principals)).toEqual([w.anna.id]);
    const pushed = await socket.next((e) => e.type === "message" && e.message.seq === seq);
    expect(pushed.message.mentions).toEqual(entries);
    const sent = await send(w.anna, w.g, "@anna 自己", [{ id: w.anna.id, start: 0, length: 5 }]);
    expect(sent.json.message.mentions).toEqual([{ id: w.anna.id, start: 0, length: 5 }]);
  });
});

/** Whether the message at `seq` was found, at send, to ask an Agent it could not name (`messages.asks_agent`). */
const asks = async (conv: string, seq: number): Promise<boolean> =>
  (await db.query<{ asks: boolean }>("select asks_agent as asks from messages where conversation_id = $1 and seq = $2", [conv, seq])).rows[0]!.asks;

describe("fix round 1: an Agent asked but not named is decided at send too (I-1)", () => {
  it("a full handle of an Agent outside the group, and a bare name two Agent members share: nothing stored, asks_agent, not judged", async () => {
    const w = await world();
    await agentOf(w.bobby, "loner", null);
    await agentOf(w.xiaolin, "helper", w.g);
    await agentOf(w.bobby, "helper", w.g);
    const outside = await say(w.anna, w.g, "@bobby.loner 你在哪");
    expect([await stored(w.g, outside), await asks(w.g, outside)]).toEqual([null, true]);
    expect(await judgeable(db, w.g, outside)).toBeNull();
    const shared = await say(w.anna, w.g, "@helper 你们谁来");
    expect([await stored(w.g, shared), await asks(w.g, shared)]).toEqual([null, true]);
    expect(await judgeable(db, w.g, shared)).toBeNull();
  });

  it("a plain message, one naming a person, and one whose @ meant nobody at all are judged as before", async () => {
    const w = await world();
    await agentOf(w.xiaolin, "jarvis", w.g);
    for (const text of ["今晚吃什么？", "@anna 你说呢", "@nobody_here 在吗", "`@xiaolin.jarvis` 是它的名字"]) {
      const seq = await say(w.bobby, w.g, text);
      expect([text, await asks(w.g, seq), await judgeable(db, w.g, seq)]).toEqual([text, false, { senderId: w.bobby.id }]);
    }
  });

  it("an Agent's own reply sets it by the same reading", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    await agentOf(w.bobby, "loner", null);
    await say(w.anna, w.g, "@xiaolin.jarvis 帮忙");
    const ticket = await claim(jarvis.id, w.g);
    const posted = await db.tx((t) =>
      postAsAgent(t, jarvis.id, w.g, ticket.id, { text: "问问 @bobby.loner 吧", reasoning: "", stopped: false, truncated: false }, "k7f2ab", app.deps.config),
    );
    expect(posted!.message.mentions).toBeNull();
    expect(await asks(w.g, posted!.message.seq)).toBe(true);
  });

  it("asks_agent never reaches anyone: not in history, a single read, a push or the send's answer", async () => {
    const w = await world();
    await agentOf(w.bobby, "loner", null);
    const socket = await connect(app, w.bobby);
    const sent = await send(w.anna, w.g, "@bobby.loner 你在哪");
    const seq = sent.json.message.seq as number;
    expect(await asks(w.g, seq)).toBe(true);
    const pushed = await socket.next((e) => e.type === "message" && e.message.seq === seq);
    const history = await api(app, w.bobby, "GET", `/api/conversations/${w.g}/messages`);
    const one = await api(app, w.tony, "GET", `/api/conversations/${w.g}/messages/${seq}`);
    for (const shown of [sent.json, pushed, history.json, one.json]) expect(JSON.stringify(shown)).not.toMatch(/asks_?agent/i);
  });
});

describe("fix round 1: a name inside an address is no mention (I-3)", () => {
  it("an @ right after a / or inside a URL or a link target is not read, and calls nobody", async () => {
    const w = await world();
    await agentOf(w.xiaolin, "jarvis", w.g);
    const runs = await allRuns();
    for (const text of [
      "我的主页 https://www.youtube.com/@anna",
      "见 example.org/@anna 吧",
      "[主页](https://x.example/@xiaolin.jarvis)",
      "<https://mastodon.social/@xiaolin.jarvis>",
      "链接 https://x.example/u?who=@anna 打开",
    ]) {
      const seq = await say(w.bobby, w.g, text);
      expect([text, await stored(w.g, seq), await asks(w.g, seq)]).toEqual([text, null, false]);
    }
    expect(await allRuns()).toBe(runs);
    // Outside the address, the same name is read.
    const seq = await say(w.bobby, w.g, "https://x.example/ @anna");
    expect(await stored(w.g, seq)).toEqual([{ id: w.anna.id, start: 19, length: 5 }]);
  });
});

describe("fix round 2: addresses (M-5)", () => {
  it("an e-mail address names nobody and asks no Agent; a mention in a link's TEXT is read (only its target is an address)", async () => {
    const w = await world();
    await agentOf(w.xiaolin, "jarvis", w.g);
    const mail = await say(w.bobby, w.g, "写信到 anna@example.com 或 xiaolin.jarvis@example.com");
    expect([await stored(w.g, mail), await asks(w.g, mail)]).toEqual([null, false]);
    const text = await say(w.bobby, w.g, "[@anna](https://x.example/p) 看这个");
    expect(await stored(w.g, text)).toEqual([{ id: w.anna.id, start: 1, length: 5 }]);
  });

  it("the address rule is the shared table's (app/shared/address-cases.json, which the web's tests assert too): the pattern, the addresses, a picked tag's own text never an address, in an address or not (tidy round, m-6, m-7)", () => {
    const table = JSON.parse(readFileSync(new URL("../../shared/address-cases.json", import.meta.url), "utf8")) as {
      pattern: string;
      cases: Array<{ note: string; text: string; taken: Array<[number, number]>; addresses: Array<[number, number]>; checks: Array<[number, number, boolean]> }>;
    };
    expect(ADDRESS_PATTERN.source).toBe(table.pattern);
    expect(table.cases.length).toBeGreaterThan(10);
    for (const c of table.cases) {
      const found = addressRanges(c.text, c.taken);
      expect([c.note, found]).toEqual([c.note, c.addresses]);
      for (const [start, length, expected] of c.checks) expect([c.note, start, inAddress(c.text, start, length, found)]).toEqual([c.note, start, expected]);
    }
  });

  it("a person whose display name looks like an address (www., ://) is picked like anyone: stored, no bad_mentions (tidy round, m-6)", async () => {
    const w = await world();
    const site = await signUp(app, "wwwanna");
    expect((await api(app, site, "PATCH", "/api/me", { displayName: "www.anna" })).status).toBe(200);
    const scheme = await signUp(app, "schemeb");
    expect((await api(app, scheme, "PATCH", "/api/me", { displayName: "a://b" })).status).toBe(200);
    await join(w.g, site.id);
    await join(w.g, scheme.id);
    const picked = [
      { id: site.id, start: 0, length: 9 },
      { id: scheme.id, start: 12, length: 6 },
    ];
    const seq = await say(w.anna, w.g, "@www.anna 和 @a://b 你们好", picked);
    expect(await stored(w.g, seq)).toEqual(picked);
    // A tag a URL runs into is still in an address: refused.
    const glued = await send(w.anna, w.g, "看 https://x.example?n=@www.anna", [{ id: site.id, start: 22, length: 9 }]);
    expect([glued.status, glued.json?.error]).toEqual([400, "bad_mentions"]);
  });
});

describe("fix round 1: code as the web shows it (M-4)", () => {
  it("a fence opened on a list item's line, and an indented code block, are code: nothing in them is read", async () => {
    const w = await world();
    await agentOf(w.xiaolin, "jarvis", w.g);
    const runs = await allRuns();
    for (const text of ["- ```js\n  @xiaolin.jarvis\n  ```", "1. ```\n   @xiaolin.jarvis\n   ```", "示例：\n\n    @xiaolin.jarvis 帮忙\n\n就这样"]) {
      expect([text, await stored(w.g, await say(w.anna, w.g, text))]).toEqual([text, null]);
    }
    expect(await allRuns()).toBe(runs);
    // A list item's own text, indented under it, is no code.
    const seq = await say(w.anna, w.g, "1. 第一项\n\n    @xiaolin.jarvis 帮忙看看");
    expect((await stored(w.g, seq))?.length).toBe(1);
  });

  it("codeRanges: list fences and indented blocks", () => {
    expect(codeRanges("- ```\nx\n```")).toEqual([[0, 11]]);
    expect(codeRanges("a\n\n    code\n    more\n\nb")).toEqual([[3, 20]]);
    expect(codeRanges("    first")).toEqual([[0, 9]]);
    expect(codeRanges("a\n    not code (no blank line)")).toEqual([]);
    expect(codeRanges("- item\n\n    in the item")).toEqual([]);
  });
});

describe("fix round 1: the remaining cases (M-7)", () => {
  it("a picked person who left: the entry stays, and the message calls nobody", async () => {
    const w = await world();
    const seq = await say(w.anna, w.g, "@Jarvis 你好", [{ id: w.tony.id, start: 0, length: 7 }]);
    expect((await api(app, w.tony, "DELETE", `/api/conversations/${w.g}/members/${w.tony.id}`)).status).toBe(200);
    expect(await stored(w.g, seq)).toEqual([{ id: w.tony.id, start: 0, length: 7 }]);
    expect((await read(w.anna, w.g, seq)).mentions).toEqual([{ id: w.tony.id, start: 0, length: 7 }]);
    expect(await allRuns()).toBe(0);
  });

  it("one Agent picked twice is stored twice and called once", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g, "贾维斯");
    const twice = [
      { id: jarvis.id, start: 0, length: 4 },
      { id: jarvis.id, start: 7, length: 4 },
    ];
    const seq = await say(w.anna, w.g, "@贾维斯 和 @贾维斯", twice);
    expect(await stored(w.g, seq)).toEqual(twice);
    expect(await covered(jarvis.id, w.g)).toEqual([seq]);
  });

  it("an Agent picked by someone its owner blocked: stored, and no run", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g, "贾维斯");
    expect((await api(app, w.xiaolin, "PUT", `/api/blocks/${w.anna.id}`)).status).toBe(200);
    const seq = await say(w.anna, w.g, "@贾维斯 在吗", [{ id: jarvis.id, start: 0, length: 4 }]);
    expect(await stored(w.g, seq)).toEqual([{ id: jarvis.id, start: 0, length: 4 }]);
    expect(await covered(jarvis.id, w.g)).toEqual([]);
  });

  it("a picked range over a handle that would be read anyway: one entry, one run", async () => {
    const w = await world();
    const jarvis = await agentOf(w.xiaolin, "jarvis", w.g);
    const seq = await say(w.anna, w.g, "@xiaolin.jarvis 帮忙", [{ id: jarvis.id, start: 0, length: 15 }]);
    expect(await stored(w.g, seq)).toEqual([{ id: jarvis.id, start: 0, length: 15 }]);
    expect(await covered(jarvis.id, w.g)).toEqual([seq]);
    expect(await allRuns()).toBe(1);
  });
});

/** The Agent's queued run in `conv`, made running as the worker's claim makes it. */
async function claim(agentId: string, conv: string): Promise<RunTicket> {
  const { rows } = await db.query<{ id: string; owner_id: string }>(
    "update agent_runs set status = 'running', started_at = now() where agent_id = $1 and conversation_id = $2 and status = 'queued' returning id, owner_id",
    [agentId, conv],
  );
  return { id: rows[0]!.id, agentId, ownerId: rows[0]!.owner_id, conversationId: conv };
}

/** Ends a running run as the worker ends one that answered: `finish`, which follows it up. */
const finish = (ticket: RunTicket) => app.agentPort.finish(ticket, { status: "done" }, null, NOTHING);

/** The Agent's latest run in `conv`: who and what it answers. */
const latestRun = async (agentId: string, conv: string) =>
  (
    await db.query<{ status: string; by: string; lane: string; caller: string | null; calls: number[] | null }>(
      `select status, triggered_by as by, lane, caller_id as caller, call_seqs::int[] as calls
         from agent_runs where agent_id = $1 and conversation_id = $2 order by created_at desc, id desc limit 1`,
      [agentId, conv],
    )
  ).rows[0];

describe("a quote carries the quoted message's mentions, under the preview's own visibility", () => {
  const quoteOf = (message: object) => (message as { replyTo?: unknown }).replyTo as { seq: number; visible: boolean; text?: string; mentions?: Mention[] };
  const replyTo = (who: Actor, conv: string, text: string, replyToSeq: number) =>
    api(app, who, "POST", `/api/conversations/${conv}/messages`, { text, clientTxn: `ms${++txn}`, replyToSeq });

  it("the preview has the ranges (ids of accounts) of the quoted message, to every member who may see it; none when it mentions nobody", async () => {
    const [ann, bo, cy] = [await signUp(app, "quote_ann"), await signUp(app, "quote_bo"), await signUp(app, "quote_cy")];
    const g = await group(app, ann, "引用群", [bo, cy]);
    const typed = `@${bo.handle} 早`;
    const said = await say(ann, g, typed, [{ id: bo.id, start: 0, length: `@${bo.handle}`.length }]);
    const plain = await say(ann, g, "没有提到谁");
    const reply = await replyTo(cy, g, "回它", said);
    expect(quoteOf(reply.json.message)).toEqual({ seq: said, visible: true, senderId: ann.id, text: typed, kind: "text", mentions: [{ id: bo.id, start: 0, length: `@${bo.handle}`.length }] });
    expect(quoteOf((await replyTo(cy, g, "回它", plain)).json.message).mentions).toBeUndefined();
    // Every reader of the history gets the same preview, ranges included.
    const seen = await read(bo, g, reply.json.message.seq);
    expect(quoteOf(seen)).toEqual(quoteOf(reply.json.message));
  });

  it("a preview cut at 200 characters keeps only the ranges that still lie inside it", async () => {
    const [ann, bo, extra] = [await signUp(app, "cut_ann"), await signUp(app, "cut_bo"), await signUp(app, "cut_cy")];
    const g = await group(app, ann, "截断群", [bo, extra]);
    const first = `@${bo.handle}`;
    const text = `${first} ${"字".repeat(250)} ${first}`;
    const said = await say(ann, g, text, [
      { id: bo.id, start: 0, length: first.length },
      { id: bo.id, start: text.length - first.length, length: first.length },
    ]);
    const quote = quoteOf((await replyTo(bo, g, "回", said)).json.message);
    expect(Array.from(quote.text!).length).toBe(200);
    expect(quote.mentions).toEqual([{ id: bo.id, start: 0, length: first.length }]); // (the second lies past the cut)
  });

  it("a range the 200-character cut runs across is left out whole, not shortened: the preview ends before it", async () => {
    const [ann, bo, extra] = [await signUp(app, "edge_ann"), await signUp(app, "edge_bo"), await signUp(app, "edge_cy")];
    const g = await group(app, ann, "边界群", [bo, extra]);
    const typed = `@${bo.handle}`;
    const text = `${"字".repeat(198)}${typed}后面`; // (begins two characters before the cut, ends past it)
    const said = await say(ann, g, text, [{ id: bo.id, start: 198, length: typed.length }]);
    const quote = quoteOf((await replyTo(bo, g, "回", said)).json.message);
    expect(Array.from(quote.text!)).toHaveLength(200);
    expect(quote.mentions).toBeUndefined(); // (not `[]`, not a range into text that is not there)
  });

  it("an astral character before a range moves it by two units, as the text is drawn; one at the cut is not split", async () => {
    const [ann, bo, extra] = [await signUp(app, "astral_ann"), await signUp(app, "astral_bo"), await signUp(app, "astral_cy")];
    const g = await group(app, ann, "星群", [bo, extra]);
    const typed = `@${bo.handle}`;
    const text = `😀${typed} ${"字".repeat(190)}😀😀`;
    const said = await say(ann, g, text, [{ id: bo.id, start: 2, length: typed.length }]);
    const quote = quoteOf((await replyTo(bo, g, "回", said)).json.message);
    expect(quote.mentions).toEqual([{ id: bo.id, start: 2, length: typed.length }]);
    expect(quote.text!.slice(2, 2 + typed.length)).toBe(typed);
    // The cut is of 200 characters (code points): a pair is whole or not there, never half.
    const long = `${"字".repeat(199)}😀😀`;
    const cut = quoteOf((await replyTo(bo, g, "回", await say(ann, g, long))).json.message);
    expect(Array.from(cut.text!)).toHaveLength(200);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(cut.text!)).toBe(false);
  });

  it("a file sent with a caption: its quote is a file's, with the file's name, and the caption's ranges inside it; a late joiner's is still only {seq, visible: false}", async () => {
    const [ann, bo, extra, late] = [await signUp(app, "file_ann"), await signUp(app, "file_bo"), await signUp(app, "file_cy"), await signUp(app, "file_dee")];
    const g = await group(app, ann, "文件群", [bo, extra]);
    const typed = `@${bo.handle}`;
    const uploaded = await app.inject({
      method: "POST",
      url: `/api/conversations/${g}/attachments`,
      headers: { cookie: ann.cookie, "content-type": MULTIPART },
      payload: multipart([{ name: "file", filename: "plan.txt", type: "text/plain", data: "hello" }]),
    });
    expect(uploaded.statusCode).toBe(201);
    const sent = await api(app, ann, "POST", `/api/conversations/${g}/messages`, {
      attachmentId: uploaded.json().id,
      text: `${typed} 请看`,
      clientTxn: `ms${++txn}`,
      mentions: [{ id: bo.id, start: 0, length: typed.length }],
    });
    expect(sent.status).toBe(201);
    await join(g, late.id);
    const reply = await replyTo(bo, g, "收到", sent.json.message.seq);
    expect(quoteOf(reply.json.message)).toMatchObject({ visible: true, kind: "file", text: `${typed} 请看`, attachmentName: "plan.txt", mentions: [{ id: bo.id, start: 0, length: typed.length }] });
    const lateQuote = quoteOf(await read(late, g, reply.json.message.seq));
    expect(lateQuote).toEqual({ seq: sent.json.message.seq, visible: false });
  });

  it("a late joiner gets no preview, so no ranges, of a quoted message from before they joined; an earlier member gets both; nothing is widened", async () => {
    const [ann, bo, extra, late] = [await signUp(app, "late_ann"), await signUp(app, "late_bo"), await signUp(app, "late_cy"), await signUp(app, "late_dee")];
    const g = await group(app, ann, "迟到群", [bo, extra]);
    const said = await say(ann, g, `@${bo.handle} 早`, [{ id: bo.id, start: 0, length: `@${bo.handle}`.length }]);
    await join(g, late.id);
    const reply = await replyTo(bo, g, "回它", said); // (after they joined, quoting what was said before)
    const seenBy = async (who: Actor) => quoteOf(await read(who, g, reply.json.message.seq));
    expect(await seenBy(bo)).toMatchObject({ seq: said, visible: true, mentions: [{ id: bo.id, start: 0, length: `@${bo.handle}`.length }] });
    const lateQuote = await seenBy(late);
    expect(lateQuote).toEqual({ seq: said, visible: false }); // (no text, no ranges, no ids)
    expect(JSON.stringify(lateQuote)).not.toContain(bo.id);
  });
});
