// @vitest-environment jsdom
// The memory palace: 关于我 on the Settings page (with 新记下的内容), and an Agent's own notes and what it heard on the
// Agent's page. Rooms, vaults, the rows that save themselves, the character budget, the refusals; over the real data
// layer with the fake transport and a fake memory service.
import "./markdown-ready.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { A1, AG1, MODELS, P1, PRINCIPALS, ME, agentConv, agentOf, agentPrincipal, apiError, deferred, providerOf, syncOf } from "./fixtures.js";
import { click, elapse, flush, inMain, installBrowser, mainText, openApp } from "./harness.jsx";
import { optionsOf, pickOption } from "./select-helpers.js";
import { weightOf } from "../src/data/memoryWeight.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
const when = (day) => new Date(2026, 10, day, 12, 0).toISOString();
// The fake service measures as the real one does, in weight; tests/memory-weight.test.js pins the function.

const note = (id, text, fields = {}) => ({
  id,
  text,
  vault: false,
  unsure: false,
  origin: "owner",
  source: { kind: "manual", title: null },
  createdAt: when(10),
  updatedAt: when(10),
  ...fields,
});

/**
 * A fake memory service: the rooms' routes over mutable notes; `used` counts the characters of both lists as the service does.
 * `over` replaces any route.
 */
function service({ notes = [], hearsay = [], limit = 100, hearsayLimit = 60, fits = true, maxNotes = undefined, over = {} } = {}) {
  const s = { notes: [...notes], hearsay: [...hearsay], limit, hearsayLimit, fits, maxNotes };
  let n = 100;
  const used = () => weightOf(s.notes);
  const room = () => ({ notes: structuredClone(s.notes), used: used(), limit: s.limit, ...(s.maxNotes === undefined ? {} : { maxNotes: s.maxNotes }) });
  const agentRoom = () => ({
    ...room(),
    hearsay: structuredClone(s.hearsay),
    hearsayUsed: weightOf(s.hearsay),
    hearsayLimit: s.hearsayLimit,
    fits: s.fits,
  });
  const add = (body) => {
    const made = note(`n${(n += 1)}`, body.text, { vault: body.vault === true });
    s.notes.unshift(made);
    return made;
  };
  const patch = (id, body) => {
    const found = s.notes.find((x) => x.id === id);
    if (!found) throw apiError(404, "not_found");
    Object.assign(found, body);
    return structuredClone(found);
  };
  const remove = (id) => {
    s.notes = s.notes.filter((x) => x.id !== id);
    return null;
  };
  s.api = {
    getMe: vi.fn(async () => ({ ...ME, newNotes: "auto", memoryModel: null, memoryModelUsable: true })),
    updateNewNotes: vi.fn(async () => ({})),
    updateMemoryModel: vi.fn(async () => ({})),
    updateDream: vi.fn(async () => ({})),
    updateMemoryLanguage: vi.fn(async () => ({})),
    convertMemoryLanguage: vi.fn(async () => ({ started: true })),
    getMemoryConversion: vi.fn(async () => ({ state: "done", result: { rooms: 0, converted: 0, kept: 0, noRoom: 0, failedRooms: 0 } })),
    getModels: vi.fn(async () => MODELS),
    listProviders: vi.fn(async () => ({ providers: [providerOf()] })),
    listMemoryNotes: vi.fn(async () => room()),
    addMemoryNote: vi.fn(async (body) => add(body)),
    patchMemoryNote: vi.fn(async (id, body) => patch(id, body)),
    deleteMemoryNote: vi.fn(async (id) => remove(id)),
    getAgentMemory: vi.fn(async () => agentRoom()),
    addAgentMemoryNote: vi.fn(async (_agent, body) => add(body)),
    patchAgentMemoryNote: vi.fn(async (_agent, id, body) => patch(id, body)),
    deleteAgentMemoryNote: vi.fn(async (_agent, id) => remove(id)),
    deleteHearsay: vi.fn(async (_agent, id) => {
      s.hearsay = s.hearsay.filter((x) => x.id !== id);
      return null;
    }),
    confirmHearsay: vi.fn(async (_agent, id) => {
      const heard = s.hearsay.find((x) => x.id === id);
      s.hearsay = s.hearsay.filter((x) => x.id !== id);
      s.notes.unshift(note(`n${(n += 1)}`, heard.text, { origin: "hearsay" }));
      return {};
    }),
    ...over,
  };
  return s;
}

const baseSync = () => syncOf([], []);

async function openPalace(svc) {
  const app = await openApp({ sync: baseSync, api: svc.api });
  fireEvent.click(rail(/^设置/));
  await flush();
  // The profile page, shown first, read /api/me for when the account name may change (Task N): counted from here on.
  svc.api.getMe?.mockClear?.();
  await click(screen.getByText("记忆宫殿", { selector: ".list-col .row-name" }));
  return app;
}

const AGENT = agentOf(AG1, { model: { source: "site", id: "free-1" } });

async function openAgentPalace(svc, record = AGENT) {
  const principals = [...PRINCIPALS, agentPrincipal(record.id, record.handle, record.name)];
  const sync = () => syncOf([agentConv(record.conversationId, record.id, { agent: { paused: false, deleted: record.deleted } })], [], principals);
  const app = await openApp({
    sync,
    api: { getModels: vi.fn(async () => MODELS), listProviders: vi.fn(async () => ({ providers: [] })), listAgents: vi.fn(() => new Promise(() => {})), ...svc.api },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, models: () => MODELS },
  });
  fireEvent.click(rail(/^Agent/));
  await flush();
  await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
  await click(inMain().getByRole("tab", { name: "记忆宫殿" }));
  return app;
}

const room = (name) => document.querySelector(`section[aria-label="${name}"]`);
const inRoom = (name) => within(room(name));
const rowsOf = (scope) => [...scope.querySelectorAll("li.memory-row")];
const rowWith = (scope, text) => rowsOf(scope).find((li) => li.textContent.includes(text));
/** Deletes a row the two-step way: 删除, then 确定删除. */
const del = async (row) => {
  await click(within(row).getByRole("button", { name: "删除" }));
  await click(within(row).getByRole("button", { name: "确定删除" }));
};
const typeInto = (box, value) => fireEvent.change(box, { target: { value } });

describe("the 关于我 room on the Settings page", () => {
  it("the settings list offers 记忆宫殿; its page has the room with its helper and 已用 N%", async () => {
    const svc = service({ notes: [note("a", "我不吃辣")], limit: 40 });
    await openPalace(svc);
    expect(document.querySelector(".main-col h2").textContent).toContain("记忆宫殿");
    expect(svc.api.listMemoryNotes).toHaveBeenCalledTimes(1);
    expect(mainText()).toContain("关于我");
    expect(mainText()).toContain("你名下的所有 Agent 共用这一份。");
    expect(inRoom("关于我").getByText("已用 10%")).toBeTruthy(); // 4 of 40
  });

  it("已用 is capped at 100%", async () => {
    const svc = service({ notes: [note("a", "茶".repeat(30))], limit: 20 });
    await openPalace(svc);
    expect(inRoom("关于我").getByText("已用 100%")).toBeTruthy();
  });

  it("an open entry is a row: its text, the source line, and the three icon buttons", async () => {
    await openPalace(service({ notes: [note("a", "我不吃辣")] }));
    const row = rowWith(room("关于我"), "我不吃辣");
    expect(within(row).getByText("我不吃辣")).toBeTruthy();
    for (const label of ["放进保险箱", "编辑", "删除"]) expect(within(row).getByRole("button", { name: label })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "取出" })).toBeNull();
  });

  it("the source line is {date} · {source}: the Agent's conversation, the group's title, or 手动添加", async () => {
    await openPalace(
      service({
        notes: [
          note("a", "住在上海", { origin: "review", source: { kind: "agent", title: "小助手" } }),
          note("b", "周五要加班", { origin: "review", source: { kind: "group", title: "项目群" } }),
          note("c", "喜欢猫", { source: { kind: "manual", title: null } }),
        ],
      }),
    );
    const lines = (text) => rowWith(room("关于我"), text).querySelector(".memory-source").textContent;
    expect(lines("住在上海")).toBe("11月10日 · 和小助手的对话");
    expect(lines("周五要加班")).toBe("11月10日 · 项目群");
    expect(lines("喜欢猫")).toBe("11月10日 · 手动添加");
  });

  it("the vault block is set apart at the bottom: its heading says the count, its rows have 取出, 编辑 and 删除", async () => {
    await openPalace(
      service({ notes: [note("a", "我不吃辣"), note("b", "我的病史", { vault: true }), note("c", "我的存款", { vault: true })] }),
    );
    const vault = room("关于我").querySelector(".memory-vault");
    expect(vault).toBeTruthy();
    // After the open entries.
    expect(room("关于我").querySelector(".memory-open").compareDocumentPosition(vault) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(vault).getByText("保险箱 · 2 条 · 群里的 Agent 拿不到")).toBeTruthy();
    const row = rowWith(vault, "我的病史");
    expect(within(row).getByRole("button", { name: "取出" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "编辑" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "删除" })).toBeTruthy();
    expect(within(row).queryByRole("button", { name: "放进保险箱" })).toBeNull();
    // The open entry is not in the vault block.
    expect(rowWith(vault, "我不吃辣")).toBeUndefined();
  });

  it("an empty vault still says 保险箱 · 0 条", async () => {
    await openPalace(service({ notes: [note("a", "我不吃辣")] }));
    expect(inRoom("关于我").getByText("保险箱 · 0 条 · 群里的 Agent 拿不到")).toBeTruthy();
  });

  it("an unsure entry in the vault carries 拿不准，先锁上了; a sure one does not", async () => {
    await openPalace(service({ notes: [note("a", "存款数目", { vault: true, unsure: true }), note("b", "病史记录", { vault: true })] }));
    expect(within(rowWith(room("关于我"), "存款数目")).getByText("拿不准，先锁上了")).toBeTruthy();
    expect(within(rowWith(room("关于我"), "病史记录")).queryByText("拿不准，先锁上了")).toBeNull();
  });

  it("the lock sends vault: true and the entry moves into the vault; 取出 sends vault: false", async () => {
    const svc = service({ notes: [note("a", "我不吃辣"), note("b", "我的病史", { vault: true })] });
    await openPalace(svc);
    await click(within(rowWith(room("关于我"), "我不吃辣")).getByRole("button", { name: "放进保险箱" }));
    expect(svc.api.patchMemoryNote).toHaveBeenCalledWith("a", { vault: true });
    expect(rowWith(room("关于我").querySelector(".memory-vault"), "我不吃辣")).toBeTruthy();
    expect(inRoom("关于我").getByText("保险箱 · 2 条 · 群里的 Agent 拿不到")).toBeTruthy();
    await click(within(rowWith(room("关于我"), "我的病史")).getByRole("button", { name: "取出" }));
    expect(svc.api.patchMemoryNote).toHaveBeenLastCalledWith("b", { vault: false });
    expect(rowWith(room("关于我").querySelector(".memory-open"), "我的病史")).toBeTruthy();
  });

  it("adding: the add row sends the text; the new entry is listed and the box is empty again", async () => {
    const svc = service();
    await openPalace(svc);
    const box = inRoom("关于我").getByLabelText("新的笔记");
    typeInto(box, "我对花生过敏");
    await click(inRoom("关于我").getByRole("button", { name: "添加" }));
    expect(svc.api.addMemoryNote).toHaveBeenCalledWith({ text: "我对花生过敏" });
    expect(rowWith(room("关于我"), "我对花生过敏")).toBeTruthy();
    expect(inRoom("关于我").getByLabelText("新的笔记").value).toBe("");
  });

  it("adding with 放进保险箱 ticked sends vault true and the entry is listed in the vault; the box is unticked again, and an unticked add sends no vault", async () => {
    const svc = service();
    await openPalace(svc);
    const scope = inRoom("关于我");
    const tick = () => scope.getByRole("checkbox", { name: "放进保险箱" });
    expect(tick().checked).toBe(false);
    // Beside 添加, in the same row.
    expect(tick().closest(".memory-add-line")).toBe(scope.getByRole("button", { name: "添加" }).closest(".memory-add-line"));
    await click(tick());
    typeInto(scope.getByLabelText("新的笔记"), "我的收入");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(svc.api.addMemoryNote).toHaveBeenLastCalledWith({ text: "我的收入", vault: true });
    expect(rowWith(room("关于我").querySelector(".memory-vault"), "我的收入")).toBeTruthy();
    expect(tick().checked).toBe(false);
    typeInto(scope.getByLabelText("新的笔记"), "我爱喝茶");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(svc.api.addMemoryNote).toHaveBeenLastCalledWith({ text: "我爱喝茶" });
  });

  it("an empty or blank entry cannot be added", async () => {
    await openPalace(service());
    const add = inRoom("关于我").getByRole("button", { name: "添加" });
    expect(add.disabled).toBe(true);
    typeInto(inRoom("关于我").getByLabelText("新的笔记"), "   ");
    expect(add.disabled).toBe(true);
  });

  it("editing: 编辑 opens the text; 保存 sends it trimmed; 取消 leaves the entry alone", async () => {
    const svc = service({ notes: [note("a", "我不吃辣")] });
    await openPalace(svc);
    await click(within(rowWith(room("关于我"), "我不吃辣")).getByRole("button", { name: "编辑" }));
    typeInto(inRoom("关于我").getByLabelText("编辑这条笔记"), " 我不吃香菜 ");
    await click(inRoom("关于我").getByRole("button", { name: "保存" }));
    expect(svc.api.patchMemoryNote).toHaveBeenCalledWith("a", { text: "我不吃香菜" });
    expect(rowWith(room("关于我"), "我不吃香菜")).toBeTruthy();
    await click(within(rowWith(room("关于我"), "我不吃香菜")).getByRole("button", { name: "编辑" }));
    typeInto(inRoom("关于我").getByLabelText("编辑这条笔记"), "别的");
    await click(inRoom("关于我").getByRole("button", { name: "取消" }));
    expect(svc.api.patchMemoryNote).toHaveBeenCalledTimes(1);
    expect(rowWith(room("关于我"), "我不吃香菜")).toBeTruthy();
  });

  it("saving an edit that changed nothing sends nothing", async () => {
    const svc = service({ notes: [note("a", "我不吃辣")] });
    await openPalace(svc);
    await click(within(rowWith(room("关于我"), "我不吃辣")).getByRole("button", { name: "编辑" }));
    await click(inRoom("关于我").getByRole("button", { name: "保存" }));
    expect(svc.api.patchMemoryNote).not.toHaveBeenCalled();
  });

  it("deleting sends the delete and the row goes, in the vault too", async () => {
    const svc = service({ notes: [note("a", "我不吃辣"), note("b", "我的病史", { vault: true })] });
    await openPalace(svc);
    await del(rowWith(room("关于我"), "我不吃辣"));
    expect(svc.api.deleteMemoryNote).toHaveBeenCalledWith("a");
    expect(rowWith(room("关于我"), "我不吃辣")).toBeUndefined();
    await del(rowWith(room("关于我"), "我的病史"));
    expect(svc.api.deleteMemoryNote).toHaveBeenLastCalledWith("b");
    expect(inRoom("关于我").getByText("保险箱 · 0 条 · 群里的 Agent 拿不到")).toBeTruthy();
  });

  it("an entry longer than the room left cannot be added: the button is off and the row says it does not fit, with no number", async () => {
    await openPalace(service({ notes: [note("a", "茶".repeat(90))], limit: 100 }));
    const scope = inRoom("关于我");
    typeInto(scope.getByLabelText("新的笔记"), "字".repeat(11));
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(true);
    expect(scope.getByText("这条太长了，这个房间装不下。")).toBeTruthy();
    typeInto(scope.getByLabelText("新的笔记"), "字".repeat(10));
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(false);
    expect(scope.queryByText(/太长/)).toBeNull();
  });

  it("the text is measured as the service will store it: its line breaks and runs of spaces are one space, and it is trimmed", async () => {
    await openPalace(service({ notes: [note("a", "茶".repeat(90))], limit: 100 }));
    const scope = inRoom("关于我");
    // 10 weight is left. 5 + 5 characters with a run of 5 spaces between: stored with one space, 31 bytes, 11 weight: over by one.
    typeInto(scope.getByLabelText("新的笔记"), `${"字".repeat(5)}     ${"字".repeat(5)}`);
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(true);
    // 5 + 4 characters with two line breaks and two spaces between: stored with one space, 28 bytes, 10 weight: it fits (as typed it would weigh 11).
    typeInto(scope.getByLabelText("新的笔记"), `${"字".repeat(5)}\n\n  ${"字".repeat(4)}`);
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(false);
  });

  it("a room that already holds its most notes cannot take another, and says so", async () => {
    await openPalace(service({ notes: [note("a", "我不吃辣"), note("b", "我住上海")], limit: 100, maxNotes: 2 }));
    const scope = inRoom("关于我");
    typeInto(scope.getByLabelText("新的笔记"), "喜欢茶");
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(true);
    expect(scope.getByText("这个房间装不下了，先删掉或合并几条。")).toBeTruthy();
  });

  it("the room left is counted in weight (utf-8 bytes / 3), as the service counts it: an emoji is 4 bytes, an English letter a third", async () => {
    await openPalace(service({ notes: [note("a", "茶".repeat(97))], limit: 100 }));
    const scope = inRoom("关于我");
    // 3 left: two emoji are 8 bytes, 3 weight; three are 12 bytes, 4.
    typeInto(scope.getByLabelText("新的笔记"), "😀😀");
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(false);
    typeInto(scope.getByLabelText("新的笔记"), "😀😀😀");
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(true);
  });

  it("the add row refuses exactly when the service would, for English and mixed text too", async () => {
    // 30 weight left: 90 letters are 90 bytes, 30 weight; 91 are 31.
    await openPalace(service({ notes: [note("a", "茶".repeat(70))], limit: 100 }));
    const scope = inRoom("关于我");
    const input = scope.getByLabelText("新的笔记");
    const add = () => scope.getByRole("button", { name: "添加" });
    typeInto(input, "a".repeat(90));
    expect(add().disabled).toBe(false);
    typeInto(input, "a".repeat(91));
    expect(add().disabled).toBe(true);
    expect(scope.getByText("这条太长了，这个房间装不下。")).toBeTruthy();
    // Mixed: 10 Chinese characters (10 weight) and 60 letters (20 weight) are 30; one more letter is 31.
    typeInto(input, `${"字".repeat(10)}${"b".repeat(60)}`);
    expect(add().disabled).toBe(false);
    typeInto(input, `${"字".repeat(10)}${"b".repeat(61)}`);
    expect(add().disabled).toBe(true);
  });

  it("an edit may use the room its own entry holds: longer than the room left but within left + its own is allowed", async () => {
    await openPalace(service({ notes: [note("a", "茶".repeat(90)), note("b", "我不吃辣")], limit: 100 }));
    const scope = inRoom("关于我");
    await click(within(rowWith(room("关于我"), "我不吃辣")).getByRole("button", { name: "编辑" }));
    // 6 left + the 4 it holds = 10.
    typeInto(scope.getByLabelText("编辑这条笔记"), "字".repeat(11));
    expect(scope.getByRole("button", { name: "保存" }).disabled).toBe(true);
    expect(scope.getByText("这条太长了，这个房间装不下。")).toBeTruthy();
    typeInto(scope.getByLabelText("编辑这条笔记"), "字".repeat(10));
    expect(scope.getByRole("button", { name: "保存" }).disabled).toBe(false);
  });

  it("a full room (409 room_full) says so on the row, in the copy", async () => {
    const svc = service({
      over: {
        addMemoryNote: vi.fn(async () => {
          throw apiError(409, "room_full");
        }),
      },
    });
    await openPalace(svc);
    typeInto(inRoom("关于我").getByLabelText("新的笔记"), "一条");
    await click(inRoom("关于我").getByRole("button", { name: "添加" }));
    expect(within(room("关于我")).getByRole("alert").textContent).toBe("这个房间装不下了，先删掉或合并几条。");
    // What was typed stays for another try.
    expect(inRoom("关于我").getByLabelText("新的笔记").value).toBe("一条");
  });

  it("a refused entry (422 note_refused) says so on the row, in the copy", async () => {
    const svc = service({
      notes: [note("a", "我不吃辣")],
      over: {
        patchMemoryNote: vi.fn(async () => {
          throw apiError(422, "note_refused");
        }),
      },
    });
    await openPalace(svc);
    await click(within(rowWith(room("关于我"), "我不吃辣")).getByRole("button", { name: "编辑" }));
    typeInto(inRoom("关于我").getByLabelText("编辑这条笔记"), "sk-AAAAAAAAAAAAAAAAAAAA1111");
    await click(inRoom("关于我").getByRole("button", { name: "保存" }));
    expect(within(room("关于我")).getByRole("alert").textContent).toBe("这条内容不能记：看起来像指令、链接或密钥。");
  });

  it("an entry gone elsewhere (404) says so and the room is read again", async () => {
    const svc = service({ notes: [note("a", "我不吃辣")] });
    await openPalace(svc);
    svc.notes = [];
    await del(rowWith(room("关于我"), "我不吃辣"));
    expect(svc.api.listMemoryNotes.mock.calls.length).toBeGreaterThan(1);
    expect(rowWith(room("关于我"), "我不吃辣")).toBeUndefined();
  });

  it("a room that cannot be loaded says so", async () => {
    const svc = service({
      over: {
        listMemoryNotes: vi.fn(async () => {
          throw apiError(500, "internal");
        }),
      },
    });
    await openPalace(svc);
    expect(within(document.querySelector(".main-col")).getByRole("alert")).toBeTruthy();
    expect(room("关于我")).toBeNull();
  });
});

describe("新记下的内容", () => {
  const SETTING = "新记下的内容";
  it("sits above the 关于我 room with its three options, showing the stored one", async () => {
    const svc = service();
    svc.api.getMe = vi.fn(async () => ({ ...ME, newNotes: "vault" }));
    await openPalace(svc);
    const select = inMain().getByLabelText(SETTING);
    expect(optionsOf(select).map(([, text]) => text)).toEqual(["自动判断要不要进保险箱", "全部进保险箱", "全部不进保险箱"]);
    expect(select.value).toBe("vault");
    expect(select.compareDocumentPosition(room("关于我")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("choosing one sends newNotes and keeps it", async () => {
    const svc = service();
    await openPalace(svc);
    expect(inMain().getByLabelText(SETTING).value).toBe("auto");
    pickOption(inMain().getByLabelText(SETTING), "open");
    await flush();
    expect(svc.api.updateNewNotes).toHaveBeenCalledWith("open");
    expect(inMain().getByLabelText(SETTING).value).toBe("open");
  });

  it("a refused change goes back to the stored value and says so", async () => {
    const svc = service({
      over: {
        updateNewNotes: vi.fn(async () => {
          throw apiError(500, "internal");
        }),
      },
    });
    await openPalace(svc);
    pickOption(inMain().getByLabelText(SETTING), "open");
    await flush();
    expect(inMain().getByLabelText(SETTING).value).toBe("auto");
    expect(document.querySelector(".toast")).toBeTruthy();
  });
});

describe("作息", () => {
  const meWith = (extra) => vi.fn(async () => ({ ...ME, newNotes: "auto", memoryModel: null, memoryModelUsable: true, ...extra }));
  const dreamBox = () => inMain().getByRole("switch", { name: "入梦" });

  it("is a section above 新记下的内容: the line 小憩 with its helper and no control, and the switch 入梦 with its helper", async () => {
    const svc = service({ over: { getMe: meWith({ dream: true }) } });
    await openPalace(svc);
    const section = inMain().getByRole("region", { name: "作息" });
    expect(within(section).getByRole("heading", { name: "作息" })).toBeTruthy();
    expect(section.compareDocumentPosition(inMain().getByLabelText("新记下的内容")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(section).getByText("小憩")).toBeTruthy();
    // No control, and the row says why: it is always on (a gap beside 入梦's switch would read as a missing one).
    expect(within(section).getByText("一直开着")).toBeTruthy();
    expect(within(section).getByText("聊完一段后，它会回想刚才的对话，记下值得留的事。")).toBeTruthy();
    expect(within(section).getAllByRole("switch")).toHaveLength(1);
    // The switch, and the language's select below it: no control for 小憩.
    expect(section.querySelectorAll("input, select, button")).toHaveLength(2);
    expect(within(section).getByText("你休息的时候，它把这一天记下的整理一遍：合并重复的，分清一时的情绪和长久的事。")).toBeTruthy();
    expect(dreamBox().checked).toBe(true);
  });

  it("an account without the field reads as off; the settings are read once for all three", async () => {
    const svc = service();
    await openPalace(svc);
    expect(dreamBox().checked).toBe(false);
    expect(svc.api.getMe).toHaveBeenCalledTimes(1);
  });

  it("turning it on sends { dream } and shows the new value once saved", async () => {
    const wait = deferred();
    const svc = service({ over: { getMe: meWith({ dream: false }), updateDream: vi.fn(() => wait.promise) } });
    await openPalace(svc);
    await click(dreamBox());
    expect(svc.api.updateDream).toHaveBeenCalledWith(true);
    expect(dreamBox().checked).toBe(false);
    expect(dreamBox().matches(":disabled")).toBe(true);
    wait.resolve({});
    await flush();
    expect(dreamBox().checked).toBe(true);
    expect(dreamBox().matches(":disabled")).toBe(false);
  });

  it("a refused save leaves the switch as it was and says so", async () => {
    const svc = service({
      over: {
        getMe: meWith({ dream: true }),
        updateDream: vi.fn(async () => {
          throw apiError(500, "internal");
        }),
      },
    });
    await openPalace(svc);
    await click(dreamBox());
    expect(dreamBox().checked).toBe(true);
    expect(document.querySelector(".toast")).toBeTruthy();
  });

  it("when the settings cannot be read the switch is off with the same failure line, and retry brings it back", async () => {
    let fail = true;
    const svc = service({
      over: {
        getMe: vi.fn(async () => {
          if (fail) throw apiError(500, "internal");
          return { ...ME, newNotes: "auto", memoryModel: null, memoryModelUsable: true, dream: true };
        }),
      },
    });
    await openPalace(svc);
    expect(dreamBox().matches(":disabled")).toBe(true);
    expect(inMain().getByLabelText("记忆用的语言").matches(":disabled")).toBe(true);
    expect(inMain().getByText(/没能读取这项设置/)).toBeTruthy();
    fail = false;
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(dreamBox().matches(":disabled")).toBe(false);
    expect(dreamBox().checked).toBe(true);
  });
});

describe("记忆用的语言", () => {
  const meWith = (extra) => vi.fn(async () => ({ ...ME, newNotes: "auto", memoryModel: null, memoryModelUsable: true, ...extra }));
  const pick = () => inMain().getByLabelText("记忆用的语言");
  const choose = async (value) => {
    pickOption(pick(), value);
    await flush();
  };
  const NAMES = ["简体中文", "繁體中文", "日本語", "English", "한국어", "Français", "Deutsch", "Español", "Português", "Русский", "Italiano", "Tiếng Việt", "ไทย", "Bahasa Indonesia"];

  it("is a select in 作息 under 入梦: 自动 first, then the languages by their own names, with its helper", async () => {
    const svc = service({ over: { getMe: meWith({ dream: true }) } });
    await openPalace(svc);
    const section = inMain().getByRole("region", { name: "作息" });
    expect(within(section).getByLabelText("记忆用的语言")).toBe(pick());
    expect(inMain().getByRole("switch", { name: "入梦" }).compareDocumentPosition(pick()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(optionsOf(pick()).map(([, text]) => text)).toEqual(["自动", ...NAMES]);
    expect(within(section).getByText("它记下的笔记统一用这种语言写；名字和原话保留原文。")).toBeTruthy();
    expect(pick().value).toBe("auto");
  });

  it("shows what the service holds, and an unknown value reads as 自动; the settings are still read once", async () => {
    const svc = service({ over: { getMe: meWith({ memoryLanguage: "ja" }) } });
    await openPalace(svc);
    expect(pick().value).toBe("ja");
    expect(svc.api.getMe).toHaveBeenCalledTimes(1);
    cleanup();
    const odd = service({ over: { getMe: meWith({ memoryLanguage: "xx" }) } });
    await openPalace(odd);
    expect(pick().value).toBe("auto");
  });

  it("choosing sends { memoryLanguage } and shows the new value once saved; 自动 sends null", async () => {
    const wait = deferred();
    const svc = service({ over: { getMe: meWith({ memoryLanguage: null }), updateMemoryLanguage: vi.fn(() => wait.promise) } });
    await openPalace(svc);
    await choose("en");
    expect(svc.api.updateMemoryLanguage).toHaveBeenCalledWith("en");
    expect(pick().value).toBe("auto");
    expect(pick().matches(":disabled")).toBe(true);
    wait.resolve({});
    await flush();
    expect(pick().value).toBe("en");
    svc.api.updateMemoryLanguage.mockImplementation(async () => ({}));
    await choose("auto");
    expect(svc.api.updateMemoryLanguage).toHaveBeenLastCalledWith(null);
    expect(pick().value).toBe("auto");
  });

  it("a refused save leaves the select as it was and says so", async () => {
    const svc = service({
      over: {
        getMe: meWith({ memoryLanguage: "fr" }),
        updateMemoryLanguage: vi.fn(async () => {
          throw apiError(500, "internal");
        }),
      },
    });
    await openPalace(svc);
    await choose("de");
    expect(pick().value).toBe("fr");
    expect(document.querySelector(".toast")).toBeTruthy();
    expect(inMain().queryByText(/把已有的笔记也转成/)).toBeNull();
  });

  it("asks about the existing notes only after a language is chosen: not at load, not for 自动, and 先不用 puts it away without a call", async () => {
    const svc = service({ over: { getMe: meWith({ memoryLanguage: "ja" }) } });
    await openPalace(svc);
    expect(inMain().queryByRole("button", { name: "转换" })).toBeNull();
    await choose("en");
    expect(inMain().getByText("把已有的笔记也转成English吗？")).toBeTruthy();
    expect(inMain().getByRole("button", { name: "转换" })).toBeTruthy();
    await click(inMain().getByRole("button", { name: "先不用" }));
    expect(inMain().queryByText(/把已有的笔记也转成/)).toBeNull();
    expect(svc.api.convertMemoryLanguage).not.toHaveBeenCalled();
    await choose("ja");
    expect(inMain().getByText("把已有的笔记也转成日本語吗？")).toBeTruthy();
    await choose("auto");
    expect(inMain().queryByText(/把已有的笔记也转成/)).toBeNull();
  });

  /** The GET's answers in turn (the last one repeats). */
  const stands = (...answers) => {
    let i = 0;
    return vi.fn(async () => {
      const answer = answers[Math.min(i, answers.length - 1)];
      i += 1;
      if (answer instanceof Error) throw answer;
      return answer;
    });
  };
  const RUNNING = { state: "running" };
  const done = (result, extra = {}) => ({ state: "done", result: { rooms: 0, converted: 0, kept: 0, noRoom: 0, failedRooms: 0, ...result }, ...extra });

  it("转换 starts the conversion, says 正在转换… and asks how it stands every 3 s until it is done, then how many were converted and how many kept", async () => {
    const svc = service({ over: { getMe: meWith({ memoryLanguage: null }), getMemoryConversion: stands(RUNNING, RUNNING, done({ rooms: 2, converted: 3, kept: 1 })) } });
    await openPalace(svc);
    await choose("en");
    await click(inMain().getByRole("button", { name: "转换" }));
    expect(svc.api.convertMemoryLanguage).toHaveBeenCalledTimes(1);
    expect(inMain().getByText("正在转换…")).toBeTruthy();
    expect(pick().matches(":disabled")).toBe(true);
    // Not asked before 3 s, then once every 3 s.
    await elapse(2999);
    expect(svc.api.getMemoryConversion).toHaveBeenCalledTimes(0);
    await elapse(1);
    expect(svc.api.getMemoryConversion).toHaveBeenCalledTimes(1);
    expect(inMain().getByText("正在转换…")).toBeTruthy();
    await elapse(3000);
    expect(svc.api.getMemoryConversion).toHaveBeenCalledTimes(2);
    expect(inMain().getByText("正在转换…")).toBeTruthy();
    await elapse(3000);
    await flush();
    expect(svc.api.getMemoryConversion).toHaveBeenCalledTimes(3);
    expect(inMain().queryByText("正在转换…")).toBeNull();
    expect(inMain().getByText("转了 3 条，1 条保持原样。")).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "转换" })).toBeNull();
    // Choosing again clears the line and asks again.
    await choose("fr");
    expect(inMain().queryByText("转了 3 条，1 条保持原样。")).toBeNull();
    expect(inMain().getByText("把已有的笔记也转成Français吗？")).toBeTruthy();
  });

  it("says what the conversion could not do, and only when there is something: notes the room could not hold, rooms that did not go through", async () => {
    const answers = [
      [{ rooms: 2, converted: 3, kept: 1, noRoom: 0, failedRooms: 0 }, "转了 3 条，1 条保持原样。"],
      [{ rooms: 2, converted: 3, kept: 4, noRoom: 2, failedRooms: 0 }, "转了 3 条，4 条保持原样。有 2 条因为房间装不下没有转，可以先整理再试。"],
      [{ rooms: 2, converted: 0, kept: 0, noRoom: 0, failedRooms: 1 }, "转了 0 条，0 条保持原样。有 1 个房间这次没转成，稍后可以再试。"],
      [{ rooms: 3, converted: 1, kept: 2, noRoom: 1, failedRooms: 2 }, "转了 1 条，2 条保持原样。有 1 条因为房间装不下没有转，可以先整理再试。有 2 个房间这次没转成，稍后可以再试。"],
    ];
    for (const [answer, line] of answers) {
      cleanup();
      const svc = service({ over: { getMe: meWith({ memoryLanguage: null }), getMemoryConversion: stands(done(answer)) } });
      await openPalace(svc);
      await choose("en");
      await click(inMain().getByRole("button", { name: "转换" }));
      await elapse(3000);
      await flush();
      expect(inMain().getByRole("status").textContent).toBe(line);
    }
  });

  it("keeps the language select off while a conversion runs, and back on after it", async () => {
    const svc = service({ over: { getMe: meWith({ memoryLanguage: null }), getMemoryConversion: stands(RUNNING, done({ rooms: 1, converted: 1 })) } });
    await openPalace(svc);
    await choose("en");
    expect(pick().matches(":disabled")).toBe(false);
    await click(inMain().getByRole("button", { name: "转换" }));
    expect(pick().matches(":disabled")).toBe(true);
    await elapse(3000);
    expect(pick().matches(":disabled")).toBe(true);
    await elapse(3000);
    await flush();
    expect(pick().matches(":disabled")).toBe(false);
  });

  it("a conversion the service no longer knows of (asked, it is idle: it restarted) says so, and asking stops", async () => {
    const svc = service({ over: { getMe: meWith({ memoryLanguage: null }), getMemoryConversion: stands(RUNNING, { state: "idle" }) } });
    await openPalace(svc);
    await choose("en");
    await click(inMain().getByRole("button", { name: "转换" }));
    await elapse(6000);
    await flush();
    expect(inMain().getByRole("status").textContent).toBe("转换可能还在进行，稍后在这里看结果。");
    expect(pick().matches(":disabled")).toBe(false);
    await elapse(9000);
    expect(svc.api.getMemoryConversion).toHaveBeenCalledTimes(2);
  });

  it("a conversion that could do nothing at all (unavailable) is told as the refusal unavailable, and the question stays", async () => {
    const svc = service({ over: { getMe: meWith({ memoryLanguage: null }), getMemoryConversion: stands(done({ rooms: 1, failedRooms: 1 }, { unavailable: true })) } });
    await openPalace(svc);
    await choose("en");
    await click(inMain().getByRole("button", { name: "转换" }));
    await elapse(3000);
    await flush();
    expect(document.querySelector(".toast")?.textContent).toBe("现在转不了，稍后再试。");
    expect(inMain().queryByText(/转了/)).toBeNull();
    expect(inMain().queryByText("正在转换…")).toBeNull();
    expect(inMain().getByRole("button", { name: "转换" })).toBeTruthy();
  });

  it("a failed look is asked again 3 s later; leaving the page stops the asking", async () => {
    const svc = service({ over: { getMe: meWith({ memoryLanguage: null }), getMemoryConversion: stands(apiError(500, "internal"), RUNNING) } });
    await openPalace(svc);
    await choose("en");
    await click(inMain().getByRole("button", { name: "转换" }));
    await elapse(6000);
    expect(svc.api.getMemoryConversion).toHaveBeenCalledTimes(2);
    expect(inMain().getByText("正在转换…")).toBeTruthy();
    // Away from the page: no more asking.
    await click(screen.getByText("我的资料", { selector: ".list-col .row-name" }));
    await elapse(3000);
    const asked = svc.api.getMemoryConversion.mock.calls.length;
    await elapse(12000);
    expect(svc.api.getMemoryConversion).toHaveBeenCalledTimes(asked);
    expect(asked).toBeLessThanOrEqual(3);
  });

  it("a refused conversion says why in its own words: no_language, busy, unavailable", async () => {
    const reasons = [
      ["no_language", 409, "先选一种语言。"],
      ["busy", 409, "正在整理记忆，稍等一会儿再试。"],
      ["unavailable", 503, "现在转不了，稍后再试。"],
    ];
    for (const [code, status, text] of reasons) {
      cleanup();
      const svc = service({
        over: {
          getMe: meWith({ memoryLanguage: null }),
          convertMemoryLanguage: vi.fn(async () => {
            throw apiError(status, code);
          }),
        },
      });
      await openPalace(svc);
      await choose("en");
      await click(inMain().getByRole("button", { name: "转换" }));
      expect([code, document.querySelector(".toast")?.textContent]).toEqual([code, text]);
    }
  });

  it("a refused conversion is toasted, no result line is shown, and the question stays", async () => {
    const svc = service({
      over: {
        getMe: meWith({ memoryLanguage: null }),
        convertMemoryLanguage: vi.fn(async () => {
          throw apiError(409, "busy");
        }),
      },
    });
    await openPalace(svc);
    await choose("en");
    await click(inMain().getByRole("button", { name: "转换" }));
    expect(document.querySelector(".toast")).toBeTruthy();
    expect(inMain().queryByText(/转了/)).toBeNull();
    expect(inMain().queryByText("正在转换…")).toBeNull();
    expect(inMain().getByRole("button", { name: "转换" })).toBeTruthy();
  });
});

describe("常提起", () => {
  it("rows whose note has strength 3 or more carry the tag; others do not", async () => {
    const svc = service({
      notes: [
        note("a", "爱吃面", { strength: 3 }),
        note("b", "养了一只猫", { strength: 7, vault: true }),
        note("c", "住在上海", { strength: 2 }),
        note("d", "不吃辣"),
      ],
    });
    await openPalace(svc);
    const tagged = (text) => rowWith(room("关于我"), text).querySelector(".memory-source").textContent.includes("常提起");
    expect(tagged("爱吃面")).toBe(true);
    expect(tagged("养了一只猫")).toBe(true);
    expect(tagged("住在上海")).toBe(false);
    expect(tagged("不吃辣")).toBe(false);
    expect(room("关于我").querySelectorAll(".tag-muted").length).toBe(2);
  });
});

describe("用哪个模型整理记忆", () => {
  const PICK = "用哪个模型整理记忆";
  const OWN = { source: "provider", providerId: P1, model: "gpt-x" };
  const me = (extra) => vi.fn(async () => ({ ...ME, newNotes: "auto", memoryModel: null, memoryModelUsable: true, ...extra }));
  /** A service that keeps what was saved, as `GET /api/me` reads it back. */
  const keeping = (stored = {}) => {
    const held = { memoryModel: null, memoryModelUsable: true, ...stored };
    return service({
      over: {
        getMe: vi.fn(async () => ({ ...ME, newNotes: "auto", ...held })),
        updateMemoryModel: vi.fn(async (memoryModel) => {
          held.memoryModel = memoryModel;
          held.memoryModelUsable = true;
          return {};
        }),
      },
    });
  };

  /** The picker's button; its list (open); a row by its name; choosing a row (opening the list first). */
  const picker = () => inMain().getByLabelText(PICK);
  const list = () => screen.queryByRole("listbox");
  const rowNamed = (name) => [...list().querySelectorAll('[role="option"]')].find((o) => o.querySelector(".model-name")?.textContent === name);
  const choose = async (name) => {
    if (!list()) await click(picker());
    await click(rowNamed(name));
  };

  it("sits right under 新记下的内容: the site's calibrated model first, then the site's and my providers' models as the Agent form groups them", async () => {
    const svc = service();
    await openPalace(svc);
    expect(picker().compareDocumentPosition(inMain().getByLabelText("新记下的内容")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    expect(picker().compareDocumentPosition(room("关于我")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(picker().getAttribute("aria-haspopup")).toBe("listbox");
    expect(picker().textContent).toBe("站点的模型（已校准）");
    await click(picker());
    const first = list().querySelector('[role="option"]');
    expect(first.querySelector(".model-name").textContent).toBe("站点的模型（已校准）");
    expect(first.getAttribute("aria-selected")).toBe("true");
    const groups = [...list().querySelectorAll('[role="group"]')].map((g) => [
      g.getAttribute("aria-label"),
      [...g.querySelectorAll('[role="option"]')].map((o) => (o.getAttribute("aria-disabled") === "true" ? `(${o.querySelector(".model-name").textContent})` : o.querySelector(".model-name").textContent)),
    ]);
    // Memory the site pays for runs only on its free models: a paid one is shown and cannot be chosen, saying why.
    expect(groups).toEqual([
      ["站点提供", ["小模型", "(大模型)"]],
      ["我的供应商 · 我的 OpenAI", ["gpt-x", "plain", "(tiny)"]],
    ]);
    const paid = rowNamed("大模型");
    expect(paid.getAttribute("title")).toBe("记忆由站点出钱，只能用免费模型");
    expect(paid.querySelector(".model-reason").textContent).toBe("记忆由站点出钱，只能用免费模型");
    expect(paid.querySelector(".model-mark")).toBeNull();
    expect(rowNamed("tiny").getAttribute("title")).toBe("上下文太小");
    expect(rowNamed("tiny").querySelector(".model-reason").textContent).toBe("上下文太小");
    await click(paid);
    expect(list()).not.toBeNull();
    expect(svc.api.updateMemoryModel).not.toHaveBeenCalled();
    expect(picker().textContent).toBe("站点的模型（已校准）");
    // Settings: the foot of the list leads to my providers.
    expect(within(document.querySelector(".model-foot")).getByRole("button", { name: "管理供应商" })).toBeTruthy();
    expect(inMain().getByText("换成自己的模型后，记得好不好我们没法保证；安全检查不变。")).toBeTruthy();
    expect(picker().getAttribute("aria-describedby")).toBe(inMain().getByText("换成自己的模型后，记得好不好我们没法保证；安全检查不变。").id);
    expect(inMain().queryByText("选的模型现在用不了，记忆暂时不会更新。")).toBeNull();
  });

  it("shows the stored choice", async () => {
    const svc = service({ over: { getMe: me({ memoryModel: OWN }) } });
    await openPalace(svc);
    expect(picker().textContent).toBe("gpt-x");
    await click(picker());
    expect(rowNamed("gpt-x").getAttribute("aria-selected")).toBe("true");
  });

  it("choosing a model sends memoryModel and keeps it; choosing the site's sends null", async () => {
    const svc = keeping();
    await openPalace(svc);
    await choose("gpt-x");
    expect(svc.api.updateMemoryModel).toHaveBeenLastCalledWith(OWN);
    expect(picker().textContent).toBe("gpt-x");
    await choose("小模型");
    expect(svc.api.updateMemoryModel).toHaveBeenLastCalledWith({ source: "site", id: "free-1" });
    await choose("站点的模型（已校准）");
    expect(svc.api.updateMemoryModel).toHaveBeenLastCalledWith(null);
    expect(picker().textContent).toBe("站点的模型（已校准）");
  });

  it("a refused change goes back to the stored choice and says so", async () => {
    const svc = service({
      over: {
        updateMemoryModel: vi.fn(async () => {
          throw apiError(400, "invalid_request");
        }),
      },
    });
    await openPalace(svc);
    await choose("gpt-x");
    expect(picker().textContent).toBe("站点的模型（已校准）");
    expect(document.querySelector(".toast")).toBeTruthy();
  });

  it("says so when the chosen model cannot be used now, and not after a new choice was saved", async () => {
    const svc = keeping({ memoryModel: OWN, memoryModelUsable: false });
    await openPalace(svc);
    expect(inMain().getByText("选的模型现在用不了，记忆暂时不会更新。")).toBeTruthy();
    await choose("站点的模型（已校准）");
    expect(inMain().queryByText("选的模型现在用不了，记忆暂时不会更新。")).toBeNull();
  });

  it("a saved model that cannot be used shows the warning at once (the settings are read again after the save)", async () => {
    const svc = service();
    await openPalace(svc);
    svc.api.getMe.mockImplementation(async () => ({ ...ME, newNotes: "auto", memoryModel: OWN, memoryModelUsable: false }));
    await choose("gpt-x");
    expect(svc.api.updateMemoryModel).toHaveBeenLastCalledWith(OWN);
    expect(inMain().getByText("选的模型现在用不了，记忆暂时不会更新。")).toBeTruthy();
  });

  it("a choice that is no longer offered stays shown (as the Agent form shows its current model)", async () => {
    const svc = service({ over: { getMe: me({ memoryModel: { source: "provider", providerId: P1, model: "gone" }, memoryModelUsable: false }) } });
    await openPalace(svc);
    expect(picker().textContent).toContain("已不可用");
    await click(picker());
    const current = [...list().querySelectorAll('[role="option"]')].find((o) => o.getAttribute("aria-selected") === "true");
    expect(current.querySelector(".model-name").textContent).toContain("已不可用");
  });

  it("when the settings cannot be read, both boxes stay off and say so, with a retry", async () => {
    let fail = true;
    const svc = service({
      over: {
        getMe: vi.fn(async () => {
          if (fail) throw apiError(500, "internal");
          return { ...ME, newNotes: "vault", memoryModel: OWN, memoryModelUsable: true };
        }),
      },
    });
    await openPalace(svc);
    expect(inMain().getByLabelText(PICK).disabled).toBe(true);
    expect(inMain().getByLabelText("新记下的内容").disabled).toBe(true);
    fail = false;
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(inMain().getByLabelText(PICK).disabled).toBe(false);
    expect(inMain().getByLabelText("新记下的内容").value).toBe("vault");
  });
});

describe("an Agent's page: its own notes and what it heard", () => {
  const HEARD = {
    id: "h1",
    text: "周五发布会推迟了",
    speakerName: "阿波",
    group: { id: "g1", title: "项目群" },
    saidAt: when(12),
  };
  const GONE = { id: "h2", text: "他想换工作", speakerName: "小陈", group: null, saidAt: when(11) };

  it("the 记忆宫殿 tab has the two rooms, 小助手自己的笔记 and 小助手听说的", async () => {
    const svc = service({ notes: [note("a", "它学到的事", { origin: "review", source: { kind: "agent", title: "小助手" } })], hearsay: [HEARD] });
    await openAgentPalace(svc);
    expect(svc.api.getAgentMemory).toHaveBeenCalledWith(AG1);
    expect(svc.api.listMemoryNotes).not.toHaveBeenCalled();
    expect(room("小助手自己的笔记")).toBeTruthy();
    expect(room("小助手听说的")).toBeTruthy();
    expect(mainText()).toContain("只当线索 · 只用在来源的群和你们的对话里");
    expect(inRoom("小助手自己的笔记").getByText("已用 5%")).toBeTruthy();
    expect(inRoom("小助手听说的").getByText("已用 13%")).toBeTruthy(); // 8 of 60, rounded
  });

  it("says so on the Agent's tab when its model cannot carry the whole palace, and only then", async () => {
    const SMALL = "这个模型的上下文较小，每次只带得下一部分记忆。";
    await openAgentPalace(service({ notes: [note("a", "它学到的事")], fits: false }));
    expect(mainText()).toContain(SMALL);
    cleanup();
    await openAgentPalace(service({ notes: [note("a", "它学到的事")], fits: true }));
    expect(mainText()).not.toContain(SMALL);
  });

  it("its own notes are a room like the shared one: the lock, edit, delete and add use the Agent's routes", async () => {
    const svc = service({ notes: [note("a", "它学到的事")] });
    await openAgentPalace(svc);
    const scope = inRoom("小助手自己的笔记");
    await click(within(rowWith(room("小助手自己的笔记"), "它学到的事")).getByRole("button", { name: "放进保险箱" }));
    expect(svc.api.patchAgentMemoryNote).toHaveBeenCalledWith(AG1, "a", { vault: true });
    typeInto(scope.getByLabelText("新的笔记"), "新学的");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(svc.api.addAgentMemoryNote).toHaveBeenCalledWith(AG1, { text: "新学的" });
    await click(scope.getByRole("checkbox", { name: "放进保险箱" }));
    typeInto(scope.getByLabelText("新的笔记"), "不外传的");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(svc.api.addAgentMemoryNote).toHaveBeenLastCalledWith(AG1, { text: "不外传的", vault: true });
    await del(rowWith(room("小助手自己的笔记"), "新学的"));
    expect(svc.api.deleteAgentMemoryNote).toHaveBeenCalledWith(AG1, expect.any(String));
    expect(svc.api.addMemoryNote).not.toHaveBeenCalled();
  });

  it("a conversation with another Agent shows its name in the source line", async () => {
    await openAgentPalace(service({ notes: [note("a", "它学到的事", { origin: "review", source: { kind: "agent", title: "小助手" } })] }));
    expect(rowWith(room("小助手自己的笔记"), "它学到的事").querySelector(".memory-source").textContent).toBe("11月10日 · 和小助手的对话");
  });

  it("a heard line is {speakerName}说：{text} with {date} · {group title or 一个已离开的群} and 属实 / 删除", async () => {
    await openAgentPalace(service({ hearsay: [HEARD, GONE] }));
    const scope = room("小助手听说的");
    const a = rowWith(scope, "周五发布会推迟了");
    expect(a.querySelector(".memory-text").textContent).toBe("阿波说：周五发布会推迟了");
    expect(a.querySelector(".memory-source").textContent).toBe("11月12日 · 项目群");
    expect(within(a).getByRole("button", { name: "属实" })).toBeTruthy();
    expect(within(a).getByRole("button", { name: "删除" })).toBeTruthy();
    expect(rowWith(scope, "他想换工作").querySelector(".memory-source").textContent).toBe("11月11日 · 一个已离开的群");
  });

  it("a heard line names the speaker's account name when the service gives it: {speakerName}（@{speakerHandle}）说：{text}", async () => {
    await openAgentPalace(
      service({ hearsay: [{ ...HEARD, speakerHandle: "abo" }, { ...GONE, speakerHandle: null }] }),
    );
    const scope = room("小助手听说的");
    expect(rowWith(scope, "周五发布会推迟了").querySelector(".memory-text").textContent).toBe("阿波（@abo）说：周五发布会推迟了");
    expect(rowWith(scope, "他想换工作").querySelector(".memory-text").textContent).toBe("小陈说：他想换工作");
  });

  it("属实 confirms the line: it leaves what it heard and becomes one of its own notes", async () => {
    const svc = service({ hearsay: [HEARD] });
    await openAgentPalace(svc);
    await click(within(rowWith(room("小助手听说的"), "周五发布会推迟了")).getByRole("button", { name: "属实" }));
    expect(svc.api.confirmHearsay).toHaveBeenCalledWith(AG1, "h1");
    expect(rowWith(room("小助手听说的"), "周五发布会推迟了")).toBeUndefined();
    expect(rowWith(room("小助手自己的笔记"), "周五发布会推迟了")).toBeTruthy();
  });

  it("删除 forgets a heard line", async () => {
    const svc = service({ hearsay: [HEARD] });
    await openAgentPalace(svc);
    await del(rowWith(room("小助手听说的"), "周五发布会推迟了"));
    expect(svc.api.deleteHearsay).toHaveBeenCalledWith(AG1, "h1");
    expect(rowWith(room("小助手听说的"), "周五发布会推迟了")).toBeUndefined();
  });

  it("属实 into a full room says the room is full, on the row", async () => {
    const svc = service({
      hearsay: [HEARD],
      over: {
        confirmHearsay: vi.fn(async () => {
          throw apiError(409, "room_full");
        }),
      },
    });
    await openAgentPalace(svc);
    await click(within(rowWith(room("小助手听说的"), "周五发布会推迟了")).getByRole("button", { name: "属实" }));
    expect(within(rowWith(room("小助手听说的"), "周五发布会推迟了")).getByRole("alert").textContent).toBe("这个房间装不下了，先删掉或合并几条。");
    expect(rowWith(room("小助手听说的"), "周五发布会推迟了")).toBeTruthy();
  });

  it("nothing heard says so; a deleted Agent has no memory tab", async () => {
    await openAgentPalace(service());
    expect(within(room("小助手听说的")).getByText("还没有听说什么")).toBeTruthy();
    cleanup();
    const svc = service();
    const principals = [...PRINCIPALS, agentPrincipal(AG1, "helper", "小助手")];
    const record = agentOf(AG1, { deleted: true });
    await openApp({
      sync: () => syncOf([agentConv(A1, AG1, { agent: { paused: false, deleted: true } })], [], principals),
      api: { ...svc.api, listAgents: vi.fn(() => new Promise(() => {})) },
      handlers: { agents: () => ({ agents: [record] }), agent: () => record, models: () => MODELS },
    });
    fireEvent.click(rail(/^Agent/));
    await flush();
    await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
    expect(inMain().queryByRole("tab", { name: "记忆宫殿" })).toBeNull();
  });
});

describe("phone width", () => {
  const css = readFileSync(path.join(import.meta.dirname, "..", "src/styles.css"), "utf8");
  const rule = (selector) => css.split("}").find((block) => block.trim().startsWith(`${selector} {`)) ?? "";

  it("a row wraps, its text may break anywhere, and the actions are a wrapping group inside the same row", async () => {
    await openPalace(service({ notes: [note("a", "我不吃辣")] }));
    expect(rule(".memory-row")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(".memory-text")).toMatch(/overflow-wrap:\s*anywhere/);
    const row = rowWith(room("关于我"), "我不吃辣");
    const actions = row.querySelector(".memory-actions");
    expect(rule(".memory-actions")).toMatch(/flex-wrap:\s*wrap/);
    for (const label of ["放进保险箱", "编辑", "删除"]) expect(actions.contains(within(row).getByRole("button", { name: label }))).toBe(true);
  });
});

describe("fix round 1", () => {
  const buttons = (row) => [...row.querySelectorAll(".memory-actions button")];

  it("an empty room says so without a full stop", async () => {
    await openPalace(service());
    expect(inRoom("关于我").getByText("还没有记下的内容")).toBeTruthy();
  });

  it("a mixed source (an entry made of words from more than one place) reads 多处整理而成", async () => {
    await openPalace(service({ notes: [note("a", "整理出来的事", { origin: "review", source: { kind: "mixed", title: null } })] }));
    expect(rowWith(room("关于我"), "整理出来的事").querySelector(".memory-source").textContent).toBe("11月10日 · 多处整理而成");
  });

  it("a manual source of an entry that did not come from the owner is a deleted origin; a group without a title is one the owner has left (一个已离开的群)", async () => {
    await openPalace(
      service({
        notes: [
          note("a", "旧的事", { origin: "review", source: { kind: "manual", title: null } }),
          note("b", "群里的事", { origin: "review", source: { kind: "group", title: null } }),
        ],
      }),
    );
    expect(rowWith(room("关于我"), "旧的事").querySelector(".memory-source").textContent).toBe("11月10日 · 来源已删除");
    expect(rowWith(room("关于我"), "群里的事").querySelector(".memory-source").textContent).toBe("11月10日 · 一个已离开的群");
  });

  it("the add row is locked through the reload: a second Enter or 添加 sends nothing", async () => {
    const svc = service();
    const gate = deferred();
    await openPalace(svc);
    const first = svc.api.listMemoryNotes.getMockImplementation();
    svc.api.listMemoryNotes.mockImplementation(async () => {
      await gate.promise;
      return first();
    });
    const scope = inRoom("关于我");
    typeInto(scope.getByLabelText("新的笔记"), "我对花生过敏");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(true);
    fireEvent.submit(scope.getByLabelText("新的笔记").closest("form"));
    await flush();
    expect(svc.api.addMemoryNote).toHaveBeenCalledTimes(1);
    gate.resolve();
    await flush();
    expect(svc.api.addMemoryNote).toHaveBeenCalledTimes(1);
    expect(scope.getByLabelText("新的笔记").value).toBe("");
  });

  it("a row's buttons stay off through the reload after a delete", async () => {
    const svc = service({ notes: [note("a", "我不吃辣"), note("b", "喜欢猫")] });
    const gate = deferred();
    await openPalace(svc);
    const first = svc.api.listMemoryNotes.getMockImplementation();
    svc.api.listMemoryNotes.mockImplementation(async () => {
      await gate.promise;
      return first();
    });
    const row = rowWith(room("关于我"), "我不吃辣");
    await click(within(row).getByRole("button", { name: "删除" }));
    await click(within(row).getByRole("button", { name: "确定删除" }));
    expect(buttons(row).every((b) => b.disabled)).toBe(true);
    gate.resolve();
    await flush();
    expect(svc.api.deleteMemoryNote).toHaveBeenCalledTimes(1);
  });

  it("删除 is a first step: it turns into 确定删除？ and sends nothing until clicked again", async () => {
    const svc = service({ notes: [note("a", "我不吃辣")] });
    await openPalace(svc);
    const row = rowWith(room("关于我"), "我不吃辣");
    await click(within(row).getByRole("button", { name: "删除" }));
    const sure = within(row).getByRole("button", { name: "确定删除" });
    expect(sure.textContent).toBe("确定删除？");
    expect(svc.api.deleteMemoryNote).not.toHaveBeenCalled();
    await click(sure);
    expect(svc.api.deleteMemoryNote).toHaveBeenCalledWith("a");
  });

  it("the confirmation goes back by itself after 4 seconds, on blur and on Escape", async () => {
    const svc = service({ notes: [note("a", "我不吃辣")] });
    await openPalace(svc);
    const row = () => rowWith(room("关于我"), "我不吃辣");
    const ask = () => click(within(row()).getByRole("button", { name: "删除" }));
    await ask();
    await elapse(3900);
    expect(within(row()).queryByRole("button", { name: "确定删除" })).toBeTruthy();
    await elapse(200);
    expect(within(row()).queryByRole("button", { name: "确定删除" })).toBeNull();
    await ask();
    fireEvent.blur(within(row()).getByRole("button", { name: "确定删除" }));
    await flush();
    expect(within(row()).queryByRole("button", { name: "确定删除" })).toBeNull();
    await ask();
    fireEvent.keyDown(within(row()).getByRole("button", { name: "确定删除" }), { key: "Escape" });
    await flush();
    expect(within(row()).queryByRole("button", { name: "确定删除" })).toBeNull();
    expect(svc.api.deleteMemoryNote).not.toHaveBeenCalled();
  });

  it("a heard line is deleted the same two-step way", async () => {
    const svc = service({
      hearsay: [{ id: "h1", text: "周五发布会推迟了", speakerName: "阿波", group: { id: "g1", title: "项目群" }, saidAt: when(12) }],
    });
    await openAgentPalace(svc);
    const row = rowWith(room("小助手听说的"), "周五发布会推迟了");
    await click(within(row).getByRole("button", { name: "删除" }));
    expect(svc.api.deleteHearsay).not.toHaveBeenCalled();
    await click(within(row).getByRole("button", { name: "确定删除" }));
    expect(svc.api.deleteHearsay).toHaveBeenCalledWith(AG1, "h1");
  });

  it("after a delete the focus goes to the next row's first action; with none left, to the add box", async () => {
    await openPalace(service({ notes: [note("a", "我不吃辣"), note("b", "喜欢猫")] }));
    await del(rowWith(room("关于我"), "我不吃辣"));
    expect(document.activeElement).toBe(buttons(rowWith(room("关于我"), "喜欢猫"))[0]);
    await del(rowWith(room("关于我"), "喜欢猫"));
    expect(document.activeElement).toBe(inRoom("关于我").getByLabelText("新的笔记"));
  });

  it("after the lock the focus stays among the open rows; after saving or cancelling an edit it is on that row's 编辑", async () => {
    await openPalace(service({ notes: [note("a", "我不吃辣"), note("b", "喜欢猫")] }));
    await click(within(rowWith(room("关于我"), "我不吃辣")).getByRole("button", { name: "放进保险箱" }));
    expect(document.activeElement).toBe(buttons(rowWith(room("关于我").querySelector(".memory-open"), "喜欢猫"))[0]);
    await click(within(rowWith(room("关于我"), "喜欢猫")).getByRole("button", { name: "编辑" }));
    typeInto(inRoom("关于我").getByLabelText("编辑这条笔记"), "喜欢狗");
    await click(inRoom("关于我").getByRole("button", { name: "保存" }));
    expect(document.activeElement).toBe(within(rowWith(room("关于我"), "喜欢狗")).getByRole("button", { name: "编辑" }));
    await click(within(rowWith(room("关于我"), "喜欢狗")).getByRole("button", { name: "编辑" }));
    await click(inRoom("关于我").getByRole("button", { name: "取消" }));
    expect(document.activeElement).toBe(within(rowWith(room("关于我"), "喜欢狗")).getByRole("button", { name: "编辑" }));
  });

  it("every row button describes itself by the row's text", async () => {
    await openPalace(service({ notes: [note("a", "我不吃辣"), note("b", "我的病史", { vault: true })] }));
    for (const text of ["我不吃辣", "我的病史"]) {
      const row = rowWith(room("关于我"), text);
      const id = row.querySelector(".memory-text").id;
      expect(id).toBeTruthy();
      for (const b of buttons(row)) expect(b.getAttribute("aria-describedby")).toBe(id);
    }
  });

  it("a change saved but a list that did not refresh says so quietly, with 重试", async () => {
    const svc = service({ notes: [note("a", "我不吃辣")] });
    await openPalace(svc);
    const first = svc.api.listMemoryNotes.getMockImplementation();
    svc.api.listMemoryNotes.mockImplementationOnce(async () => {
      throw apiError(500, "internal");
    });
    await click(within(rowWith(room("关于我"), "我不吃辣")).getByRole("button", { name: "放进保险箱" }));
    expect(inRoom("关于我").getByText(/刚才的改动已保存，但列表没刷新出来。/)).toBeTruthy();
    svc.api.listMemoryNotes.mockImplementation(first);
    await click(inRoom("关于我").getByRole("button", { name: "重试" }));
    expect(inRoom("关于我").queryByText(/刚才的改动已保存/)).toBeNull();
    expect(rowWith(room("关于我").querySelector(".memory-vault"), "我不吃辣")).toBeTruthy();
  });

  it("a 409 room_full with `left` updates the room's remaining count at once", async () => {
    const svc = service({
      limit: 100,
      over: {
        addMemoryNote: vi.fn(async () => {
          throw apiError(409, "room_full", null, { left: 3 });
        }),
      },
    });
    await openPalace(svc);
    const scope = inRoom("关于我");
    typeInto(scope.getByLabelText("新的笔记"), "一二三四五");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(scope.getByText("这条太长了，这个房间装不下。")).toBeTruthy();
    expect(scope.getByRole("button", { name: "添加" }).disabled).toBe(true);
    expect(scope.getByText("已用 97%")).toBeTruthy();
  });

  it("a 409 room_full with `count` says the room is out of room for notes, with the real limit; the weight left is still taken", async () => {
    const svc = service({
      limit: 100,
      maxNotes: 150,
      over: {
        addMemoryNote: vi.fn(async () => {
          throw apiError(409, "room_full", null, { left: 90, count: true });
        }),
      },
    });
    await openPalace(svc);
    const scope = inRoom("关于我");
    typeInto(scope.getByLabelText("新的笔记"), "一条");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(within(room("关于我")).getByRole("alert").textContent).toBe("这个房间的笔记条数到上限了（最多 150 条），先删掉或合并几条。");
    expect(scope.getByText("已用 10%")).toBeTruthy();
  });

  it("a 409 room_full with `count` when the page does not know how many notes the room holds says the room is full, in general words", async () => {
    const svc = service({
      limit: 100,
      over: {
        addMemoryNote: vi.fn(async () => {
          throw apiError(409, "room_full", null, { left: 90, count: true });
        }),
      },
    });
    await openPalace(svc);
    const scope = inRoom("关于我");
    typeInto(scope.getByLabelText("新的笔记"), "一条");
    await click(scope.getByRole("button", { name: "添加" }));
    expect(within(room("关于我")).getByRole("alert").textContent).toBe("这个房间装不下了，先删掉或合并几条。");
    expect(scope.getByText("已用 10%")).toBeTruthy();
  });

  it("新记下的内容 that cannot be read is off and says so with 重试, not 自动判断", async () => {
    const svc = service();
    svc.api.getMe = vi.fn(async () => {
      throw apiError(500, "internal");
    });
    await openPalace(svc);
    const select = inMain().getByLabelText("新记下的内容");
    expect(select.disabled).toBe(true);
    expect(select.textContent).toBe("读取失败");
    expect(inMain().getByText(/没能读取这项设置，请重试。/)).toBeTruthy();
    svc.api.getMe.mockImplementation(async () => ({ ...ME, newNotes: "open" }));
    await click(inMain().getByRole("button", { name: "重试" }));
    expect(inMain().getByLabelText("新记下的内容").value).toBe("open");
    expect(inMain().getByLabelText("新记下的内容").disabled).toBe(false);
  });
});
