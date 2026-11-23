import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cleanText, modelNote, ownerNote } from "../src/memory/clean.ts";
import { loadNotes } from "../src/memory/passage.ts";
import { setNewNotes } from "../src/memory/store.ts";
import { weight } from "../src/memory/weight.ts";
import { api, group, signUp, type Actor } from "./helpers/actors.ts";
import { mustCreateAgent, SITE_ENV } from "./helpers/agents.ts";
import { useApp } from "./helpers/harness.ts";
import { scriptedJudge } from "./helpers/judge.ts";

/**
 * The owner reads and edits the palace (README "An Agent's memory"): the cleaning rules for what an owner types and for
 * what a model writes, the owner's room and each Agent's, hearsay, and the one rule that matters most — only the
 * owner takes a note out of the vault.
 */

const JUDGE = {
  model: "jev-1",
  channels: [{ url: "https://judge-a.example.test/v1/systemone", apiKeyEnv: "UPSTREAM_TEST_KEY" }],
  timeoutMs: 500,
  dailyLimit: 20_000,
};
const judge = scriptedJudge();
const { app, db } = useApp({ env: { ...SITE_ENV, RATE_LIMIT_SCALE: "1000" }, judge, agentWorker: false, config: { judge: JUDGE } });

describe("ownerNote and modelNote", () => {
  it("both remove control characters and lone surrogates (the database refuses them) but still turn tabs and line breaks into a space", () => {
    for (const clean of [ownerNote, modelNote]) {
      expect(clean("likes\u0000tea")).toBe("likestea");
      expect(clean("a\ud800b")).toBe("ab");
      expect(clean("a\udc00b")).toBe("ab");
      expect(clean("a\u0007\u001bb\u007fc")).toBe("abc");
      expect(clean("a\tb\nc\r\nd")).toBe("a b c d");
      expect(clean("a \u0000 b")).toBe("a b");
      expect(clean("\u0000\ud800")).toBeNull();
      // A proper pair is not lone.
      expect(clean("ok \u{1F600}")).toBe("ok \u{1F600}");
    }
  });

  it("both put the text on one line, trimmed, and refuse the empty and key-like ones", () => {
    for (const clean of [ownerNote, modelNote]) {
      expect(clean("  喜欢\n喝  美式 ")).toBe("喜欢 喝 美式");
      expect(clean("   ")).toBeNull();
      expect(clean("")).toBeNull();
      expect(clean("the key is sk-abcdef123456")).toBeNull();
      expect(clean("token ghp_abcdefghijklmnop")).toBeNull();
      expect(clean("id AKIAIOSFODNN7EXAMPLE")).toBeNull();
      expect(clean("-----BEGIN PRIVATE KEY-----")).toBeNull();
      expect(clean("code a1b2c3d4e5f6a7b8c9d0e1")).toBeNull();
      expect(clean("a_b-c_d-e_f-g_h-i_j-k1")).toBeNull();
      // Long runs of only letters (or only digits), and words that merely contain a prefix, are fine.
      expect(clean("internationalizationlocalization")).toBe("internationalizationlocalization");
      expect(clean("13800138000138001380013800")).toBe("13800138000138001380013800");
      expect(clean("a task-based person")).toBe("a task-based person");
    }
  });

  it("storage keeps the owner's text as typed: no folding, no bracket or punctuation stripping, nothing refused for it", () => {
    for (const clean of [ownerNote, modelNote]) {
      expect(clean("不吃辣，也不吃香菜")).toBe("不吃辣，也不吃香菜");
      expect(clean("don’t like 《三体》")).toBe("don’t like 《三体》");
      expect(clean("ＡＢＣ｜x [y] “z”")).toBe("ＡＢＣ｜x [y] “z”");
      expect(clean("现在喜欢麻婆豆腐（以前喜欢鱼香肉丝，2026 年 11 月改的）")).toBe("现在喜欢麻婆豆腐（以前喜欢鱼香肉丝，2026 年 11 月改的）");
      // Invisible format characters (zero-width, bidi controls) are removed, not refused; line breaks become a space.
      expect(clean("a\u200bb\u202ec\u2066d")).toBe("abcd");
      expect(clean("a\r\n\n b\t\tc\u2028d")).toBe("a b c d");
      expect(clean("\u200b \u200d")).toBeNull();
      // Hidden characters cannot break up a key.
      expect(clean("sk-ab\u200bcdef123456")).toBeNull();
    }
  });

  it("a zero-width joiner between two emoji is kept (the sequence is one emoji); anywhere else it goes, as every other invisible character does", () => {
    const kept = [
      "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}", // the family
      "\u{1F3F3}\ufe0f\u200d\u{1F308}", // the rainbow flag: the joiner after a variation selector
      "\u{1F469}\u200d\u{1F4BB}", // a profession
      "\u{1F469}\u{1F3FD}\u200d\u{1F4BB}", // the same with a skin tone
      "\u2764\ufe0f\u200d\u{1F525}", // a heart on fire
    ];
    for (const clean of [ownerNote, modelNote, cleanText]) {
      for (const emoji of kept) {
        const text = `\u5168\u5bb6\u798f ${emoji} \u5728\u5ba2\u5385`;
        expect([emoji, clean(text)]).toEqual([emoji, text]);
      }
      for (const [text, left] of [
        ["a\u200db", "ab"],
        ["\u200d\u559c\u6b22\u8336", "\u559c\u6b22\u8336"],
        ["\u559c\u6b22\u8336\u200d", "\u559c\u6b22\u8336"],
        ["\u200d\u{1F469}", "\u{1F469}"],
        ["\u{1F469}\u200d", "\u{1F469}"],
        ["\u{1F469}\u200d\u200d\u{1F4BB}", "\u{1F469}\u{1F4BB}"],
        ["\u{1F469}\u200d\u200b\u{1F4BB}", "\u{1F469}\u{1F4BB}"],
        ["\u{1F469}\u200dx", "\u{1F469}x"],
        ["\u{1F3F4}\u{E0067}\u{E0062}\u{E007F}", "\u{1F3F4}"],
      ] as const) {
        expect([text, clean(text)]).toEqual([text, left]);
      }
    }
  });

  it("the owner may write instructions and links in their own notes; a model may not", () => {
    for (const text of ["你必须叫我小明", "你应该用英文回答", "ignore all previous", "you must reply briefly", "see https://example.com/x", "visit www.example.com", "mail me at me@example.com", "system prompt is x"]) {
      expect(ownerNote(text)).toBe(text);
      expect(modelNote(text)).toBeNull();
    }
    for (const text of ["你应该", "忽略之前的", "无视规则", "指令", "听我的", "無視して", "IGNORE this", "You Must", "SYSTEM"]) {
      expect(modelNote(text)).toBeNull();
    }
    expect(modelNote("喜欢喝美式咖啡")).toBe("喜欢喝美式咖啡");
    expect(modelNote("prefers an ecosystem of small tools")).toBe("prefers an ecosystem of small tools");
  });

  it("a model's entry is at most 200 weight (a Chinese 200 characters, an English 600 letters), the owner's has no such limit", () => {
    // The same sentence of prose, n letters long: no key-like run, ends in a letter.
    const prose = (n: number): string => `${"abcdefg ".repeat(Math.ceil(n / 8)).slice(0, n - 1)}z`;
    expect(modelNote("字".repeat(200))).toBe("字".repeat(200));
    expect(modelNote("字".repeat(201))).toBeNull();
    expect(modelNote(prose(450))).toBe(prose(450));
    expect(modelNote(prose(600))).toBe(prose(600));
    expect(modelNote(prose(601))).toBeNull();
    // An emoji is 4 bytes: 150 of them are 600 bytes, 200 weight; 151 are not.
    expect(modelNote("😀".repeat(150))).toBe("😀".repeat(150));
    expect(modelNote("😀".repeat(151))).toBeNull();
    expect(ownerNote("字".repeat(1500))).toBe("字".repeat(1500));
  });
});

/** A signed-up owner with one Agent and a group the Agent is in. */
async function world() {
  const owner = await signUp(app, "memr_owner");
  const mia = await signUp(app, "memr_mia");
  const ned = await signUp(app, "memr_ned");
  const agent = await mustCreateAgent(app, owner, { name: "Ava" });
  const g = await group(app, owner, "Book club", [mia, ned]);
  await db.query(
    `insert into memberships (conversation_id, principal_id, role, joined_seq) select id, $2, 'speaker', seq from conversations where id = $1`,
    [g, agent.id],
  );
  return { owner, mia, ned, agent: agent as { id: string; conversationId: string }, g };
}

const notes = (who: Actor) => api(app, who, "GET", "/api/memory/notes");
const insertOwnerNote = async (ownerId: string, text: string, vault: boolean, vaultBy: "auto" | "owner" = "auto", origin: string | null = null, conv: string | null = null) =>
  (
    await db.query<{ id: string }>(
      "insert into owner_notes (owner_id, text, vault, vault_by, origin, origin_conversation_id) values ($1, $2, $3, $4, $5, $6) returning id",
      [ownerId, text, vault, vaultBy, origin ?? "review", conv],
    )
  ).rows[0]!.id;
const insertAgentNote = async (agentId: string, text: string, vault: boolean) =>
  (await db.query<{ id: string }>("insert into agent_notes (agent_id, text, vault) values ($1, $2, $3) returning id", [agentId, text, vault])).rows[0]!.id;
const insertHearsay = async (agentId: string, conv: string, text: string, speaker: string | null = null) =>
  (
    await db.query<{ id: string }>(
      "insert into agent_hearsay (agent_id, conversation_id, speaker_id, speaker_name, text, said_at) values ($1, $2, $3, 'Mia', $4, now()) returning id",
      [agentId, conv, speaker, text],
    )
  ).rows[0]!.id;
const rowOf = async (id: string) =>
  (await db.query("select vault, vault_by, unsure, origin, text from owner_notes where id = $1", [id])).rows[0] as
    | { vault: boolean; vault_by: string; unsure: boolean; origin: string; text: string }
    | undefined;

describe("the owner's room: /api/memory/notes", () => {
  it("lists the notes with the room used and its limit, oldest first, in the wire shape", async () => {
    const { owner, agent, g } = await world();
    const manual = await insertOwnerNote(owner.id, "喜欢美式", false, "owner", "owner");
    const fromAgent = await insertOwnerNote(owner.id, "养了一只猫", true, "auto", "review", agent.conversationId);
    const fromGroup = await insertOwnerNote(owner.id, "周三有读书会", false, "auto", "review", g);
    const res = await notes(owner);
    expect(res.status).toBe(200);
    expect(res.json.used).toBe(4 + 5 + 6);
    expect(res.json.limit).toBe(2000);
    expect(res.json.notes.map((n: { id: string }) => n.id)).toEqual([manual, fromAgent, fromGroup]);
    expect(res.json.notes[0]).toEqual({
      id: manual,
      text: "喜欢美式",
      vault: false,
      unsure: false,
      origin: "owner",
      source: { kind: "manual", title: null },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      strength: 0,
      seenAt: expect.any(String),
    });
    expect(res.json.notes[1]).toMatchObject({ vault: true, origin: "review", source: { kind: "agent", title: "Ava" } });
    expect(res.json.notes[2]).toMatchObject({ source: { kind: "group", title: "Book club" } });
    expect(Object.keys(res.json.notes[0]).sort()).toEqual(["createdAt", "id", "origin", "seenAt", "source", "strength", "text", "unsure", "updatedAt", "vault"]);
  });

  it("another user sees none of it", async () => {
    const { owner } = await world();
    await insertOwnerNote(owner.id, "mine", true);
    const other = await signUp(app, "memr_other");
    expect((await notes(other)).json).toEqual({ notes: [], used: 0, limit: 2000, maxNotes: 150 });
  });

  it("POST adds a note as the owner's setting says: vault, open, auto with no judge answer", async () => {
    const { owner } = await world();
    await setNewNotes(db, owner.id, "vault");
    const a = await api(app, owner, "POST", "/api/memory/notes", { text: "喜欢爵士乐" });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ text: "喜欢爵士乐", vault: true, unsure: false, origin: "owner", source: { kind: "manual", title: null } });
    expect(await rowOf(a.json.id)).toMatchObject({ vault: true, vault_by: "auto", origin: "owner" });
    await setNewNotes(db, owner.id, "open");
    const b = await api(app, owner, "POST", "/api/memory/notes", { text: "爱喝茶" });
    expect(b.json.vault).toBe(false);
    expect(await rowOf(b.json.id)).toMatchObject({ vault: false, vault_by: "auto" });
    await setNewNotes(db, owner.id, "auto");
    judge.calls.splice(0);
    judge.answer(() => ({ sort: 0.95 }));
    const c = await api(app, owner, "POST", "/api/memory/notes", { text: "爱吃辣" });
    expect(c.json).toMatchObject({ vault: false, unsure: false });
    expect(judge.calls).toHaveLength(1);
    judge.answer(() => ({ sort: 0.4 }));
    const d = await api(app, owner, "POST", "/api/memory/notes", { text: "最近在存钱" });
    expect(d.json).toMatchObject({ vault: true, unsure: true });
    judge.answer(() => new Error("down"));
    const e = await api(app, owner, "POST", "/api/memory/notes", { text: "一条" });
    expect(e.json).toMatchObject({ vault: true, unsure: false });
    judge.answer(() => ({}));
  });

  it("POST with vault given is the owner's choice: vault_by owner, no judge call", async () => {
    const { owner } = await world();
    judge.calls.splice(0);
    const a = await api(app, owner, "POST", "/api/memory/notes", { text: "公开的事", vault: false });
    expect(a.status).toBe(201);
    expect(a.json.vault).toBe(false);
    expect(await rowOf(a.json.id)).toMatchObject({ vault: false, vault_by: "owner", unsure: false });
    const b = await api(app, owner, "POST", "/api/memory/notes", { text: "私密的事", vault: true });
    expect(b.json.vault).toBe(true);
    expect(await rowOf(b.json.id)).toMatchObject({ vault: true, vault_by: "owner" });
    expect(judge.calls).toHaveLength(0);
  });

  it("a note added with vault true lands in the vault as the owner's own lock whatever the setting says, in the owner's room and the Agent's, and the sorter is not asked", async () => {
    const { owner, agent } = await world();
    await setNewNotes(db, owner.id, "open");
    judge.calls.splice(0);
    const mine = await api(app, owner, "POST", "/api/memory/notes", { text: "手动放进保险箱的事", vault: true });
    expect(await rowOf(mine.json.id)).toMatchObject({ vault: true, vault_by: "owner", unsure: false, origin: "owner" });
    const theirs = await api(app, owner, "POST", `/api/agents/${agent.id}/memory/notes`, { text: "回答里不要提的事", vault: true });
    expect((await db.query("select vault, vault_by, unsure from agent_notes where id = $1", [theirs.json.id])).rows[0]).toEqual({ vault: true, vault_by: "owner", unsure: false });
    expect(judge.calls).toHaveLength(0);
  });

  it("a 2500 character entry is refused by the room of 2000 and stored nowhere; 1500 fits and leaves 500", async () => {
    const { owner } = await world();
    const big = await api(app, owner, "POST", "/api/memory/notes", { text: "字".repeat(2500) });
    expect(big.status).toBe(409);
    expect(big.json).toEqual({ error: "room_full", left: 2000 });
    expect((await db.query("select 1 from owner_notes")).rowCount).toBe(0);
    const ok = await api(app, owner, "POST", "/api/memory/notes", { text: "字".repeat(1500) });
    expect(ok.status).toBe(201);
    expect((await notes(owner)).json).toMatchObject({ used: 1500, limit: 2000 });
    const more = await api(app, owner, "POST", "/api/memory/notes", { text: "字".repeat(501) });
    expect(more.status).toBe(409);
    expect(more.json).toEqual({ error: "room_full", left: 500 });
    expect((await api(app, owner, "POST", "/api/memory/notes", { text: "字".repeat(500) })).status).toBe(201);
  });

  it("a room holds 2000 weight whatever the language: 2000 Chinese characters or 6000 English letters; used and left are the weight of what is stored", async () => {
    const english = (n: number): string => `${"abcdefg ".repeat(Math.ceil(n / 8)).slice(0, n - 1)}z`;
    const zh = await world();
    expect((await api(app, zh.owner, "POST", "/api/memory/notes", { text: "字".repeat(2000), vault: true })).status).toBe(201);
    expect((await notes(zh.owner)).json).toMatchObject({ used: 2000, limit: 2000 });
    expect((await api(app, zh.owner, "POST", "/api/memory/notes", { text: "字", vault: true })).json).toEqual({ error: "room_full", left: 0 });
    const en = await signUp(app, "memr_english");
    expect((await api(app, en, "POST", "/api/memory/notes", { text: english(6001), vault: true })).json).toEqual({ error: "room_full", left: 2000 });
    expect((await api(app, en, "POST", "/api/memory/notes", { text: english(6000), vault: true })).status).toBe(201);
    expect((await notes(en)).json).toMatchObject({ used: 2000, limit: 2000 });
    expect((await api(app, en, "POST", "/api/memory/notes", { text: "a", vault: true })).json).toEqual({ error: "room_full", left: 0 });
    // Mixed notes: used is the sum of each note's weight (each rounded up on its own), left is the limit less that.
    const mixed = await signUp(app, "memr_mixed");
    const texts = ["我喜欢咖啡", "I like coffee in the morning", "🙂", "café"];
    for (const text of texts) expect((await api(app, mixed, "POST", "/api/memory/notes", { text, vault: true })).status).toBe(201);
    const expected = texts.reduce((sum, t) => sum + weight(t), 0);
    expect(expected).toBe(5 + 10 + 2 + 2);
    expect((await notes(mixed)).json).toMatchObject({ used: expected, limit: 2000 });
    expect((await api(app, mixed, "POST", "/api/memory/notes", { text: english(6000), vault: true })).json).toEqual({ error: "room_full", left: 2000 - expected });
  });

  it("a note whose origin was cleared (a merge, a rewrite from elsewhere, the owner's edit) while it was not the owner's own is source.kind mixed; one the owner typed stays manual", async () => {
    const { owner, agent } = await world();
    const typed = await insertOwnerNote(owner.id, "自己写的", false, "owner", "owner");
    const merged = await insertOwnerNote(owner.id, "整理而成的", false, "auto", "review", null);
    const heardThenKept = await insertOwnerNote(owner.id, "听说后属实的", true, "auto", "hearsay", null);
    const mine = (await api(app, owner, "GET", "/api/memory/notes")).json.notes as Array<{ id: string; source: unknown }>;
    expect(Object.fromEntries(mine.map((n) => [n.id, n.source]))).toEqual({
      [typed]: { kind: "manual", title: null },
      [merged]: { kind: "mixed", title: null },
      [heardThenKept]: { kind: "mixed", title: null },
    });
    await db.query("insert into agent_notes (agent_id, text, vault, origin, origin_conversation_id) values ($1, $2, false, 'review', null)", [agent.id, "它自己整理的"]);
    const own = (await api(app, owner, "GET", `/api/agents/${agent.id}/memory`)).json.notes as Array<{ source: unknown }>;
    expect(own.map((n) => n.source)).toEqual([{ kind: "mixed", title: null }]);
  });

  it("a room of 150 notes takes no more, however short: 409 room_full with nothing left; deleting one makes room", async () => {
    const { owner } = await world();
    await db.query("insert into owner_notes (owner_id, text) select $1, 'n' || g from generate_series(1, 150) g", [owner.id]);
    const res = await api(app, owner, "POST", "/api/memory/notes", { text: "短" });
    expect(res.status).toBe(409);
    // `left` is the weight really left (the 150 short notes weigh little); `count` says it is the number of notes that refused.
    const held = Array.from({ length: 150 }, (_, i) => weight(`n${i + 1}`)).reduce((a, b) => a + b, 0);
    expect(res.json).toEqual({ error: "room_full", left: 2000 - held, count: true });
    expect((await db.query("select 1 from owner_notes")).rowCount).toBe(150);
    const first = (await notes(owner)).json.notes[0].id;
    expect((await api(app, owner, "DELETE", `/api/memory/notes/${first}`)).status).toBe(200);
    expect((await api(app, owner, "POST", "/api/memory/notes", { text: "短" })).status).toBe(201);
  });

  it("refused text is 422 note_refused and nothing is stored; a body that does not fit is 400", async () => {
    const { owner } = await world();
    for (const text of ["", "   ", "key sk-abcdef123456", "\u200b"]) {
      const res = await api(app, owner, "POST", "/api/memory/notes", { text });
      expect([text, res.status, res.json]).toEqual([text, 422, { error: "note_refused" }]);
    }
    expect((await api(app, owner, "POST", "/api/memory/notes", {})).status).toBe(400);
    expect((await api(app, owner, "POST", "/api/memory/notes", { text: "x", extra: 1 })).status).toBe(400);
    expect((await api(app, owner, "POST", "/api/memory/notes", { text: "x", vault: "yes" })).status).toBe(400);
    expect((await db.query("select 1 from owner_notes")).rowCount).toBe(0);
  });

  it("PATCH vault false on a vault note opens it for the owner and records vault_by owner; true locks it", async () => {
    const { owner } = await world();
    const id = await insertOwnerNote(owner.id, "在备孕", true);
    await db.query("update owner_notes set unsure = true where id = $1", [id]);
    const res = await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { vault: false });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ id, vault: false, unsure: false });
    expect(await rowOf(id)).toMatchObject({ vault: false, vault_by: "owner", unsure: false });
    const back = await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { vault: true });
    expect(back.json.vault).toBe(true);
    expect(await rowOf(id)).toMatchObject({ vault: true, vault_by: "owner" });
  });

  it("PATCH changes the text, keeps the room, refuses what POST refuses, and an empty body is 400", async () => {
    const { owner } = await world();
    const id = await insertOwnerNote(owner.id, "旧的", false, "owner");
    const other = await insertOwnerNote(owner.id, "字".repeat(1990), false, "owner");
    const res = await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "新的\n内容" });
    expect(res.status).toBe(200);
    expect(res.json.text).toBe("新的 内容");
    expect((await rowOf(id))!.text).toBe("新的 内容");
    // The note's own old text is freed: 10 may be as long as 2000 - 1990.
    const fits = await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "字".repeat(10) });
    expect(fits.status).toBe(200);
    const over = await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "字".repeat(11) });
    expect(over.status).toBe(409);
    expect(over.json).toEqual({ error: "room_full", left: 10 });
    expect((await rowOf(id))!.text).toBe("字".repeat(10));
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "sk-abcdef123456" })).status).toBe(422);
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${id}`, {})).status).toBe(400);
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "x", id: other })).status).toBe(400);
    expect((await rowOf(other))!.text).toBe("字".repeat(1990));
  });

  it("a room over its limit (the operator lowered it) still takes an edit that makes a note shorter, or keeps its length; one that makes it longer is room_full", async () => {
    const { owner } = await world();
    // 2500 of 2000: what a room holds once its limit was lowered below it.
    const id = await insertOwnerNote(owner.id, "字".repeat(100), false, "owner");
    await insertOwnerNote(owner.id, "字".repeat(2400), false, "owner");
    const shorter = await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "字".repeat(60) });
    expect(shorter.status).toBe(200);
    expect((await rowOf(id))!.text).toBe("字".repeat(60));
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "文".repeat(60) })).status).toBe(200);
    const longer = await api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "字".repeat(61) });
    expect(longer).toEqual({ status: 409, json: { error: "room_full", left: 0 } });
    expect((await rowOf(id))!.text).toBe("文".repeat(60));
  });

  it("a text edit alone may move a note into the vault, never out, and never touches an owner's choice", async () => {
    const { owner } = await world();
    // Outside by auto: an edit that sorts as private goes in; one that sorts as fine stays out.
    const open = await insertOwnerNote(owner.id, "爱喝茶", false);
    judge.answer(() => ({ sort: 0.1 }));
    judge.calls.splice(0);
    const a = await api(app, owner, "PATCH", `/api/memory/notes/${open}`, { text: "欠了一笔钱" });
    expect(a.json).toMatchObject({ vault: true, unsure: false });
    expect(await rowOf(open)).toMatchObject({ vault: true, vault_by: "auto" });
    expect(judge.calls).toHaveLength(1);
    const open2 = await insertOwnerNote(owner.id, "爱喝茶", false);
    judge.answer(() => ({ sort: 0.95 }));
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${open2}`, { text: "爱喝咖啡" })).json.vault).toBe(false);
    // The judge cannot be asked or fails: fail closed, into the vault.
    judge.answer(() => new Error("down"));
    const open3 = await insertOwnerNote(owner.id, "爱喝茶", false);
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${open3}`, { text: "爱喝奶茶" })).json.vault).toBe(true);
    // Inside by auto: whatever the new text sorts as, it stays inside and the judge is not even asked.
    judge.answer(() => ({ sort: 0.99 }));
    judge.calls.splice(0);
    const inside = await insertOwnerNote(owner.id, "在备孕", true);
    const b = await api(app, owner, "PATCH", `/api/memory/notes/${inside}`, { text: "爱喝茶" });
    expect(b.json.vault).toBe(true);
    expect(await rowOf(inside)).toMatchObject({ vault: true, vault_by: "auto" });
    // The owner's choice is never re-sorted, outside or inside.
    const mine = await insertOwnerNote(owner.id, "爱喝茶", false, "owner");
    judge.answer(() => ({ sort: 0.01 }));
    const c = await api(app, owner, "PATCH", `/api/memory/notes/${mine}`, { text: "欠了一笔钱" });
    expect(c.json.vault).toBe(false);
    expect(await rowOf(mine)).toMatchObject({ vault: false, vault_by: "owner" });
    expect(judge.calls).toHaveLength(0);
    // A text edit sent together with vault: false is the owner's choice, not a re-sort.
    const both = await insertOwnerNote(owner.id, "在备孕", true);
    const d = await api(app, owner, "PATCH", `/api/memory/notes/${both}`, { text: "改了", vault: false });
    expect(d.json.vault).toBe(false);
    expect(await rowOf(both)).toMatchObject({ vault: false, vault_by: "owner" });
    expect(judge.calls).toHaveLength(0);
    judge.answer(() => ({}));
  });

  it("a text edit with the owner's setting 'vault' or 'open' sorts as the setting says, towards the vault only", async () => {
    const { owner } = await world();
    const open = await insertOwnerNote(owner.id, "爱喝茶", false);
    await setNewNotes(db, owner.id, "vault");
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${open}`, { text: "爱喝咖啡" })).json.vault).toBe(true);
    await setNewNotes(db, owner.id, "open");
    const open2 = await insertOwnerNote(owner.id, "爱喝茶", false);
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${open2}`, { text: "爱喝咖啡" })).json.vault).toBe(false);
    const inside = await insertOwnerNote(owner.id, "秘密", true);
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${inside}`, { text: "不秘密了" })).json.vault).toBe(true);
    await setNewNotes(db, owner.id, "auto");
  });

  it("DELETE removes the note; deleting it again, or another user's, is 404", async () => {
    const { owner } = await world();
    const other = await signUp(app, "memr_del_other");
    const id = await insertOwnerNote(owner.id, "x", true);
    expect((await api(app, other, "DELETE", `/api/memory/notes/${id}`)).status).toBe(404);
    expect((await api(app, other, "PATCH", `/api/memory/notes/${id}`, { text: "y" })).status).toBe(404);
    expect(await rowOf(id)).toBeDefined();
    expect((await api(app, owner, "DELETE", `/api/memory/notes/${id}`)).status).toBe(200);
    expect(await rowOf(id)).toBeUndefined();
    expect((await api(app, owner, "DELETE", `/api/memory/notes/${id}`)).status).toBe(404);
    expect((await api(app, owner, "DELETE", "/api/memory/notes/not-an-id")).status).toBe(400);
  });

  it("requires a session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/memory/notes" });
    expect(res.statusCode).toBe(401);
  });
});

describe("an Agent's room: /api/agents/:id/memory", () => {
  it("lists its notes and its hearsay with the rooms, the group title null once the Agent has left", async () => {
    const { owner, mia, ned, agent, g } = await world();
    const n1 = await insertAgentNote(agent.id, "回答简短一点", false);
    const h1 = await insertHearsay(agent.id, g, "周五聚餐", mia.id);
    const solo = await group(app, owner, "Short lived", [mia, ned]);
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq, left_seq) select id, $2, 'speaker', seq, seq from conversations where id = $1`,
      [solo, agent.id],
    );
    const h2 = await insertHearsay(agent.id, solo, "说了别的", mia.id);
    const res = await api(app, owner, "GET", `/api/agents/${agent.id}/memory`);
    expect(res.status).toBe(200);
    expect(res.json.notes).toHaveLength(1);
    expect(res.json.notes[0]).toEqual({
      id: n1,
      text: "回答简短一点",
      vault: false,
      unsure: false,
      origin: "review",
      source: { kind: "mixed", title: null },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
      strength: 0,
      seenAt: expect.any(String),
    });
    // The hearsay room counts each entry's text and its speaker's name, in weight: 4 for the text and 1 for "Mia" (3 bytes), twice.
    expect(res.json).toMatchObject({ used: 6, limit: 3000, hearsayUsed: 2 * (4 + 1), hearsayLimit: 2000 });
    expect(res.json.hearsay).toEqual([
      { id: h1, text: "周五聚餐", speakerName: "Mia", speakerHandle: "memr_mia", group: { id: g, title: "Book club" }, saidAt: expect.any(String) },
      { id: h2, text: "说了别的", speakerName: "Mia", speakerHandle: "memr_mia", group: null, saidAt: expect.any(String) },
    ]);
  });

  it("another user, a co-member of the group and an unknown id all get 404 on every route", async () => {
    const { owner, mia, agent, g } = await world();
    const n = await insertAgentNote(agent.id, "x", true);
    const h = await insertHearsay(agent.id, g, "y");
    const base = `/api/agents/${agent.id}/memory`;
    const missing = "/api/agents/00000000-0000-4000-8000-000000000000/memory";
    for (const who of [mia, await signUp(app, "memr_stranger")]) {
      for (const [method, url, body] of [
        ["GET", base],
        ["POST", `${base}/notes`, { text: "z" }],
        ["PATCH", `${base}/notes/${n}`, { text: "z" }],
        ["DELETE", `${base}/notes/${n}`],
        ["DELETE", `${base}/hearsay/${h}`],
        ["POST", `${base}/hearsay/${h}/confirm`, {}],
      ] as const) {
        const res = await api(app, who, method, url, body);
        expect([method, url, res.status]).toEqual([method, url, 404]);
        expect(res.json).toEqual({ error: "not_found" });
      }
    }
    expect((await api(app, owner, "GET", missing)).status).toBe(404);
    expect((await db.query("select 1 from agent_notes")).rowCount).toBe(1);
    expect((await db.query("select 1 from agent_hearsay")).rowCount).toBe(1);
  });

  it("a note id of the owner's room or of another Agent's is not found through this Agent", async () => {
    const { owner, agent } = await world();
    const second = await mustCreateAgent(app, owner, { name: "Bo" });
    const theirs = await insertAgentNote(second.id, "x", true);
    const shared = await insertOwnerNote(owner.id, "s", true);
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}/memory/notes/${theirs}`, { text: "z" })).status).toBe(404);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}/memory/notes/${shared}`)).status).toBe(404);
    expect((await api(app, owner, "PATCH", `/api/memory/notes/${theirs}`, { text: "z" })).status).toBe(404);
  });

  it("POST, PATCH and DELETE follow the rules of the owner's room, with the room of 3000", async () => {
    const { owner, agent } = await world();
    const base = `/api/agents/${agent.id}/memory/notes`;
    await setNewNotes(db, owner.id, "open");
    const a = await api(app, owner, "POST", base, { text: "回答要简短" });
    expect(a.status).toBe(201);
    expect(a.json).toMatchObject({ text: "回答要简短", vault: false, origin: "owner", source: { kind: "manual", title: null } });
    const row = async (id: string) => (await db.query("select vault, vault_by, text from agent_notes where id = $1", [id])).rows[0];
    expect(await row(a.json.id)).toEqual({ vault: false, vault_by: "auto", text: "回答要简短" });
    const locked = await api(app, owner, "POST", base, { text: "先说结论", vault: true });
    expect(await row(locked.json.id)).toMatchObject({ vault: true, vault_by: "owner" });
    expect((await api(app, owner, "POST", base, { text: "字".repeat(3001) })).json).toEqual({ error: "room_full", left: 3000 - 5 - 4 });
    expect((await api(app, owner, "POST", base, { text: "token sk-abcdef123456" })).status).toBe(422);
    const big = await api(app, owner, "POST", base, { text: "字".repeat(2000) });
    expect(big.status).toBe(201);
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}/memory`)).json.used).toBe(5 + 4 + 2000);
    // Edit: the owner opens the locked one; the open one stays out whatever its edit says.
    const p = await api(app, owner, "PATCH", `${base}/${locked.json.id}`, { vault: false });
    expect(p.json.vault).toBe(false);
    expect(await row(locked.json.id)).toMatchObject({ vault: false, vault_by: "owner" });
    await setNewNotes(db, owner.id, "auto");
    judge.answer(() => ({ sort: 0.01 }));
    const q = await api(app, owner, "PATCH", `${base}/${a.json.id}`, { text: "回答要详细" });
    expect(q.json.vault).toBe(true);
    judge.answer(() => ({}));
    const insideBy = await api(app, owner, "PATCH", `${base}/${a.json.id}`, { text: "又改了" });
    expect(insideBy.json.vault).toBe(true);
    expect((await api(app, owner, "DELETE", `${base}/${a.json.id}`)).status).toBe(200);
    expect(await row(a.json.id)).toBeUndefined();
    expect((await api(app, owner, "DELETE", `${base}/${a.json.id}`)).status).toBe(404);
    await setNewNotes(db, owner.id, "auto");
  });

  it("a self note is sorted with the Agent's own wording (kind self)", async () => {
    const { owner, agent } = await world();
    judge.calls.splice(0);
    judge.answer(() => ({ sort: 0.95 }));
    await api(app, owner, "POST", `/api/agents/${agent.id}/memory/notes`, { text: "回答要简短" });
    expect((judge.calls[0]!.questions[0] as { instructions: string }).instructions).toContain("AI 助手给自己记的");
    judge.answer(() => ({}));
  });

  it("writes to a deleted Agent are 409 agent_deleted, reads still work", async () => {
    const { owner, agent } = await world();
    const n = await insertAgentNote(agent.id, "x", true);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}`)).status).toBe(200);
    expect((await api(app, owner, "GET", `/api/agents/${agent.id}/memory`)).json.notes).toHaveLength(1);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/memory/notes`, { text: "y" })).json).toEqual({ error: "agent_deleted" });
    expect((await api(app, owner, "PATCH", `/api/agents/${agent.id}/memory/notes/${n}`, { text: "y" })).status).toBe(409);
    // Taking back is allowed: DELETE of a note.
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}/memory/notes/${n}`)).status).toBe(200);
  });

  it("DELETE of hearsay removes it; again is 404; another Agent's hearsay is not found", async () => {
    const { owner, agent, g } = await world();
    const second = await mustCreateAgent(app, owner, { name: "Bo" });
    const h = await insertHearsay(agent.id, g, "听来的");
    const other = await insertHearsay(second.id, g, "别人听来的");
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}/memory/hearsay/${other}`)).status).toBe(404);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}/memory/hearsay/${h}`)).status).toBe(200);
    expect((await api(app, owner, "DELETE", `/api/agents/${agent.id}/memory/hearsay/${h}`)).status).toBe(404);
    expect((await db.query("select 1 from agent_hearsay")).rowCount).toBe(1);
  });

  it("confirming hearsay moves it into the owner's room, in the vault, and removes the hearsay", async () => {
    const { owner, mia, agent, g } = await world();
    const h = await insertHearsay(agent.id, g, "周三有读书会", mia.id);
    judge.calls.splice(0);
    const res = await api(app, owner, "POST", `/api/agents/${agent.id}/memory/hearsay/${h}/confirm`, {});
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ text: "周三有读书会", vault: true, unsure: false, origin: "hearsay", source: { kind: "group", title: "Book club" } });
    expect(await rowOf(res.json.id)).toMatchObject({ vault: true, vault_by: "auto", origin: "hearsay" });
    expect((await db.query("select 1 from agent_hearsay")).rowCount).toBe(0);
    expect(judge.calls).toHaveLength(0);
    expect((await notes(owner)).json.notes.map((n: { id: string }) => n.id)).toEqual([res.json.id]);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/memory/hearsay/${h}/confirm`, {})).status).toBe(404);
  });

  it("confirming into a full room is 409 room_full with what is left, and keeps the hearsay", async () => {
    const { owner, agent, g } = await world();
    await insertOwnerNote(owner.id, "字".repeat(1998), true);
    const h = await insertHearsay(agent.id, g, "三个字");
    const res = await api(app, owner, "POST", `/api/agents/${agent.id}/memory/hearsay/${h}/confirm`, {});
    expect(res.status).toBe(409);
    expect(res.json).toEqual({ error: "room_full", left: 2 });
    expect((await db.query("select 1 from agent_hearsay")).rowCount).toBe(1);
    expect((await db.query("select 1 from owner_notes")).rowCount).toBe(1);
  });

  it("confirming hearsay that the owner's rules refuse (a key) is 422 note_refused and leaves it in place", async () => {
    const { owner, agent, g } = await world();
    const h = await insertHearsay(agent.id, g, "the key is sk-abcdef123456");
    const res = await api(app, owner, "POST", `/api/agents/${agent.id}/memory/hearsay/${h}/confirm`, {});
    expect([res.status, res.json]).toEqual([422, { error: "note_refused" }]);
    expect((await db.query("select 1 from agent_hearsay")).rowCount).toBe(1);
    expect((await db.query("select 1 from owner_notes")).rowCount).toBe(0);
  });

  it("the confirmation body is none or {}", async () => {
    const { owner, agent, g } = await world();
    const h = await insertHearsay(agent.id, g, "听来的");
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/memory/hearsay/${h}/confirm`, ["x"])).status).toBe(400);
    expect((await api(app, owner, "POST", `/api/agents/${agent.id}/memory/hearsay/${h}/confirm`)).status).toBe(201);
  });
});

describe("races under the room's lock", () => {
  it("two parallel 1200-point entries: exactly one is stored, the other is room_full", async () => {
    const { owner, agent } = await world();
    const post = () => api(app, owner, "POST", "/api/memory/notes", { text: "字".repeat(1200), vault: true });
    const results = await Promise.all([post(), post()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.json).toEqual({ error: "room_full", left: 800 });
    expect((await db.query("select 1 from owner_notes")).rowCount).toBe(1);
    // The same on an Agent's room of 3000: two of 1600 do not both fit.
    const postSelf = () => api(app, owner, "POST", `/api/agents/${agent.id}/memory/notes`, { text: "字".repeat(1600), vault: true });
    expect((await Promise.all([postSelf(), postSelf()])).map((r) => r.status).sort()).toEqual([201, 409]);
  });

  it("two parallel edits that each fit alone but not together: one wins, the room is never over", async () => {
    const { owner } = await world();
    const a = await insertOwnerNote(owner.id, "a", true, "owner");
    const b = await insertOwnerNote(owner.id, "b", true, "owner");
    const edit = (id: string) => api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "字".repeat(1500) });
    expect((await Promise.all([edit(a), edit(b)])).map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await notes(owner)).json.used).toBeLessThanOrEqual(2000);
  });

  it("a text edit racing the owner's vault:false: the owner's choice wins, whichever lands first", async () => {
    const { owner } = await world();
    for (const order of [0, 1]) {
      const id = await insertOwnerNote(owner.id, "在备孕", true);
      judge.answer(() => ({ sort: 0.1 }));
      const text = () => api(app, owner, "PATCH", `/api/memory/notes/${id}`, { text: "改了一句" });
      const open = () => api(app, owner, "PATCH", `/api/memory/notes/${id}`, { vault: false });
      const results = await Promise.all(order === 0 ? [text(), open()] : [open(), text()]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(await rowOf(id)).toMatchObject({ vault: false, vault_by: "owner", text: "改了一句" });
    }
    judge.answer(() => ({}));
  });
});

describe("a group the owner has left", () => {
  /** A group of mia's the owner (and the Agent) is in, a note of each room and a heard thing learned there; then the owner leaves and mia renames it. */
  async function leftGroup() {
    const w = await world();
    const club = await group(app, w.mia, "OLD-TITLE-g3", [w.owner, w.ned]);
    await db.query(
      `insert into memberships (conversation_id, principal_id, role, joined_seq) select id, $2, 'speaker', seq from conversations where id = $1`,
      [club, w.agent.id],
    );
    await insertOwnerNote(w.owner.id, "周五打球", false, "auto", "review", club);
    await db.query("insert into agent_notes (agent_id, text, vault, origin, origin_conversation_id) values ($1, '球场在东门', false, 'review', $2)", [w.agent.id, club]);
    await insertHearsay(w.agent.id, club, "下周换场地", w.mia.id);
    const leave = async () => {
      expect((await api(app, w.owner, "DELETE", `/api/conversations/${club}/members/${w.owner.id}`)).status).toBe(200);
      expect((await api(app, w.mia, "PATCH", `/api/conversations/${club}`, { title: "NEW-TITLE-g3" })).status).toBe(200);
    };
    return { ...w, club, leave };
  }
  const agentRow = async (agentId: string) =>
    (await db.query<{ id: string; ownerId: string }>("select id, owner_id as \"ownerId\" from principals where id = $1", [agentId])).rows.map((r) => ({ ...r, memory: true, sharedNotes: true }))[0]!;

  it("the notes page names it by no title once the owner has left — not the title it had, nor a rename made after", async () => {
    const w = await leftGroup();
    const page = async () => ({ mine: (await notes(w.owner)).json, agent: (await api(app, w.owner, "GET", `/api/agents/${w.agent.id}/memory`)).json });
    const before = await page();
    expect(before.mine.notes.map((n: { source: unknown }) => n.source)).toEqual([{ kind: "group", title: "OLD-TITLE-g3" }]);
    expect(before.agent.notes.map((n: { source: unknown }) => n.source)).toEqual([{ kind: "group", title: "OLD-TITLE-g3" }]);
    expect(before.agent.hearsay.map((h: { group: unknown }) => h.group)).toEqual([{ id: w.club, title: "OLD-TITLE-g3" }]);

    await w.leave();
    const after = await page();
    expect(after.mine.notes.map((n: { source: unknown }) => n.source)).toEqual([{ kind: "group", title: null }]);
    expect(after.agent.notes.map((n: { source: unknown }) => n.source)).toEqual([{ kind: "group", title: null }]);
    expect(after.agent.hearsay.map((h: { group: unknown }) => h.group)).toEqual([null]);
    expect(JSON.stringify(after)).not.toMatch(/TITLE-g3/);
  });

  it("the notes passage calls it 一个已离开的群 once the owner has left — not the title it had, nor a rename made after", async () => {
    const w = await leftGroup();
    const own = { place: "own" } as const;
    expect((await loadNotes(db, await agentRow(w.agent.id), own, app.deps.config)).notes.hearsay.map((h) => h.group)).toEqual(["OLD-TITLE-g3"]);
    await w.leave();
    const { notes: passage } = await loadNotes(db, await agentRow(w.agent.id), own, app.deps.config);
    expect(passage.hearsay.map((h) => [h.text, h.group])).toEqual([["下周换场地", "一个已离开的群"]]);
    expect(JSON.stringify(passage)).not.toMatch(/TITLE-g3/);
  });

  it("back in the group (added again), the owner's notes page and passage name it by its title now", async () => {
    const w = await leftGroup();
    await w.leave();
    expect((await api(app, w.mia, "POST", `/api/conversations/${w.club}/members`, { principalId: w.owner.id })).status).toBe(201);
    expect((await notes(w.owner)).json.notes.map((n: { source: unknown }) => n.source)).toEqual([{ kind: "group", title: "NEW-TITLE-g3" }]);
    const agentPage = (await api(app, w.owner, "GET", `/api/agents/${w.agent.id}/memory`)).json;
    expect(agentPage.notes.map((n: { source: unknown }) => n.source)).toEqual([{ kind: "group", title: "NEW-TITLE-g3" }]);
    const { notes: passage } = await loadNotes(db, await agentRow(w.agent.id), { place: "own" }, app.deps.config);
    expect(passage.hearsay.map((h) => h.group)).toEqual(["NEW-TITLE-g3"]);
    // The hearsay page goes by the Agent's own membership: until the Agent is added back it says no group.
    expect(agentPage.hearsay.map((h: { group: unknown }) => h.group)).toEqual([null]);
  });
});

describe("README", () => {
  it("has a heading for every memory route (tests/readme.test.ts checks the whole list)", () => {
    const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    for (const route of [
      "GET /api/memory/notes",
      "POST /api/memory/notes",
      "PATCH /api/memory/notes/:id",
      "DELETE /api/memory/notes/:id",
      "GET /api/agents/:id/memory",
      "POST /api/agents/:id/memory/notes",
      "PATCH /api/agents/:id/memory/notes/:noteId",
      "DELETE /api/agents/:id/memory/notes/:noteId",
      "DELETE /api/agents/:id/memory/hearsay/:hearsayId",
      "POST /api/agents/:id/memory/hearsay/:hearsayId/confirm",
    ]) {
      const [method, path] = route.split(" ");
      expect(README).toContain(`#### \`${method} ${path}\``);
    }
    expect(README).toContain("room_full");
    expect(README).toContain("note_refused");
  });
});
