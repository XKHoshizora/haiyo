// @vitest-environment jsdom
// What the owner is told when their Agent remembered something: the small 记忆已更新 chip (closed; opened it lists what
// changed, each line with its vault tag, and 撤销), the two confirmation cards, the full-room hint, the stale refusal —
// only in the owner's own conversation with the Agent, never in a group.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, ME_ID, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, deferred, group, notice, syncOf, wire } from "./fixtures.js";
import { StoreProvider, emptyState, useStore } from "../src/data/store.jsx";
import { MemoryNotice } from "../src/pages/MemoryChip.jsx";
import { click, installBrowser, mainText, openApp, push } from "./harness.jsx";
import { memorySentence } from "../src/data/memoryPhrases.js";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const SITE_FREE = { source: "site", id: "free-1" };
const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "我不吃辣")];
const LINES = ["记住了：不吃辣", "锁进了保险箱：住在上海"];

/** The `memory_changed` notice of the wire contract at `seq`; `fields` override. */
const changed = (seq, fields = {}) =>
  notice(A1, seq, "记忆已更新", {
    event: "memory_changed",
    actorId: AG1,
    changeId: "c1",
    lines: LINES,
    vaultLines: [false, true],
    pending: false,
    unlock: false,
    full: false,
    status: "applied",
    ...fields,
  });

async function openChat(messages, { api = {}, deleted = false } = {}) {
  const record = agentOf(AG1, { model: SITE_FREE, deleted });
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const conversation = agentConv(A1, AG1, { lastSeq, readSeq: lastSeq, agent: { paused: false, deleted }, canSend: deleted ? { ok: false, reason: "agent_deleted" } : { ok: true } });
  const app = await openApp({
    sync: () => syncOf([conversation], messages, [...PRINCIPALS, agentPrincipal()]),
    api: {
      undoMemoryChange: vi.fn(async () => ({ status: "undone" })),
      confirmMemoryChange: vi.fn(async () => ({ status: "applied" })),
      discardMemoryChange: vi.fn(async () => ({ status: "discarded" })),
      listProviders: vi.fn(async () => ({ providers: [] })),
      ...api,
    },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), models: () => MODELS },
  });
  await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
  return app;
}

/** The sentence the chip reads for `changeId` in the notice `fields` (the Agent is 小助手). */
const sentence = (fields = {}) => memorySentence({ name: "小助手", changeId: "c1", phase: "rest", lines: LINES, count: 2, full: false, ...fields });
const timeline = () => document.querySelector("ol.messages");
const li = (seq) => timeline().querySelector(`li[data-msg="m${seq}"]`);
const inLi = (seq) => within(li(seq));

describe("the 记忆已更新 chip", () => {
  it("an applied change is a small chip, closed: it says a sentence with the Agent's name and the count", async () => {
    await openChat([...BASE, changed(3)]);
    expect(li(3).textContent).toBe(sentence());
    expect(sentence()).toMatch(/^小助手.*1 件事/);
    const chip = inLi(3).getByRole("button", { name: sentence() });
    expect(chip.getAttribute("aria-expanded")).toBe("false");
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("opened, it lists the lines with the vault ones tagged 保险箱, and 撤销", async () => {
    await openChat([...BASE, changed(3)]);
    await click(inLi(3).getByRole("button", { name: sentence() }));
    const items = [...li(3).querySelectorAll("li, .memory-line")].map((x) => x.textContent);
    expect(items).toEqual(["记住了：不吃辣", "锁进了保险箱：住在上海保险箱"]);
    expect(inLi(3).getByRole("button", { name: "撤销" })).toBeTruthy();
    expect(li(3).querySelectorAll(".tag").length).toBe(1);
  });

  it("撤销 calls the undo route and the chip then says 已撤销", async () => {
    const { api } = await openChat([...BASE, changed(3)]);
    await click(inLi(3).getByRole("button", { name: sentence() }));
    await click(inLi(3).getByRole("button", { name: "撤销" }));
    expect(api.undoMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(inLi(3).getByText("已撤销")).toBeTruthy();
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("a change already undone reads 已撤销 when opened", async () => {
    await openChat([...BASE, changed(3, { status: "undone" })]);
    await click(inLi(3).getByRole("button", { name: sentence() }));
    expect(inLi(3).getByText("已撤销")).toBeTruthy();
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
  });

  it("a stale undo (409) says so, keeps the lines and leaves no action button", async () => {
    const undoMemoryChange = vi.fn(async () => {
      throw apiError(409, "stale_change");
    });
    await openChat([...BASE, changed(3)], { api: { undoMemoryChange } });
    await click(inLi(3).getByRole("button", { name: sentence() }));
    await click(inLi(3).getByRole("button", { name: "撤销" }));
    expect(inLi(3).getByRole("alert").textContent).toBe("这条改动已经过时了：记忆后来又变过。");
    expect(inLi(3).queryByText("已撤销")).toBeNull();
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
    expect(li(3).textContent).toContain("记住了：不吃辣");
  });

  it("full: the closed chip says 快满了; opened, the hint is there", async () => {
    await openChat([...BASE, changed(3, { full: true })]);
    expect(li(3).textContent).toBe(`${sentence()} · 快满了`);
    await click(inLi(3).getByRole("button", { name: `${sentence()} · 快满了` }));
    expect(inLi(3).getByRole("button", { name: "记忆宫殿快满了，去整理一下。" })).toBeTruthy();
  });

  it("the hint's link goes to the settings page memory (the palace's)", () => {
    const Probe = () => {
      const { state } = useStore();
      return <output>{`${state.nav.section}/${state.nav.settingsPage}`}</output>;
    };
    const msg = { id: "m3", seq: 3, kind: "system", text: "记忆已更新", system: { event: "memory_changed", changeId: "c1", lines: LINES, vaultLines: [false, true], pending: false, unlock: false, full: true, status: "applied" } };
    render(
      <StoreProvider initialState={emptyState()}>
        <Probe />
        <ol>
          <MemoryNotice msg={msg} conv={{ type: "agent", agentId: AG1, id: A1 }} />
        </ol>
      </StoreProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: `${memorySentence({ name: "Agent", changeId: "c1", phase: "rest", lines: LINES, count: 2, full: true })}` }));
    fireEvent.click(screen.getByRole("button", { name: "记忆宫殿快满了，去整理一下。" }));
    expect(screen.getByRole("status").textContent).toBe("settings/memory");
  });

  it("in a deleted Agent's conversation 撤销 is off", async () => {
    await openChat([...BASE, changed(3)], { deleted: true });
    await click(inLi(3).getByRole("button", { name: sentence() }));
    expect(inLi(3).getByRole("button", { name: "撤销" }).disabled).toBe(true);
  });

  it("a push of the same notice with a new status replaces it", async () => {
    const { transport } = await openChat([...BASE, changed(3)]);
    await click(inLi(3).getByRole("button", { name: sentence() }));
    await push(transport, { type: "message", message: changed(3, { status: "undone" }) });
    expect(inLi(3).getByText("已撤销")).toBeTruthy();
  });
});

describe("the chip's sentence", () => {
  it("a dream notice reads as a dream, with its count (not the number of lines)", async () => {
    await openChat([...BASE, changed(3, { phase: "dream", count: 5, lines: ["合并了：爱吃面", "锁进了保险箱：住在上海"] })]);
    expect(li(3).textContent).toBe(sentence({ phase: "dream", count: 5 }));
    expect(li(3).textContent).toMatch(/^小助手.*5 条记忆/);
    expect(li(3).textContent).toMatch(/入梦|梦里/);
  });

  it("a notice without phase or count is a rest, counting its lines", async () => {
    await openChat([...BASE, changed(3, { phase: undefined, count: undefined })]);
    expect(li(3).textContent).toBe(sentence());
    expect(li(3).textContent).toMatch(/1 件事/);
  });

  it("only forgetting and locking: 理了理记忆; only hearsay: 想起听来的", async () => {
    await openChat([
      ...BASE,
      changed(3, { changeId: "c3", lines: ["忘掉了：x"], vaultLines: [false] }),
      changed(4, { changeId: "c4", lines: ["听说：「阿波」在「项目群」里说：y"], vaultLines: [false] }),
    ]);
    expect(li(3).textContent).toBe("小助手小憩时理了理记忆");
    expect(li(4).textContent).toBe("小助手小憩时想起听来的 1 件事");
  });

  it("the same notice reads the same on a push again", async () => {
    const { transport } = await openChat([...BASE, changed(3)]);
    const first = li(3).textContent;
    await push(transport, { type: "message", message: changed(3, { status: "undone" }) });
    expect(li(3).textContent).toBe(first);
  });

  it("opened, a merge lists what it merged on the lines under it (原来：…), each with its vault tag; the chip's sentence is the merge's alone", async () => {
    const lines = ["合并了 2 条：路由器在客厅，是华硕的", "原来：路由器在客厅", "原来：路由器是华硕的"];
    await openChat([...BASE, changed(3, { lines, vaultLines: [true, false, true], sourceLines: [false, true, true], count: 3 })]);
    expect(li(3).textContent).toBe("小助手小憩时理了理记忆");
    await click(inLi(3).getByRole("button", { name: "小助手小憩时理了理记忆" }));
    const items = [...li(3).querySelectorAll(".memory-lines li")];
    expect(items.map((x) => x.textContent)).toEqual(["合并了 2 条：路由器在客厅，是华硕的保险箱", "原来：路由器在客厅", "原来：路由器是华硕的保险箱"]);
    expect(items.map((x) => x.classList.contains("memory-merged"))).toEqual([false, true, true]);
    expect(inLi(3).getByRole("button", { name: "撤销" })).toBeTruthy();
  });

  it("a line is set in as a note a merge joined only when the notice marks it so (sourceLines): a note whose text begins with 原来： is a line like any other", async () => {
    await openChat([...BASE, changed(3, { lines: ["改成了：原来：住在北京", "原来：住在上海"], vaultLines: [false, true], count: 2 })]);
    await click(inLi(3).getByRole("button", { name: /小助手/ }));
    const items = [...li(3).querySelectorAll(".memory-lines li")];
    expect(items.map((x) => x.textContent)).toEqual(["改成了：原来：住在北京", "原来：住在上海保险箱"]);
    expect(items.map((x) => x.classList.contains("memory-merged"))).toEqual([false, false]);
  });

  it("opened after dream lines, the lines are listed as they came", async () => {
    await openChat([...BASE, changed(3, { phase: "dream", count: 2, lines: ["合并了：爱吃面", "拆成了：a；b"], vaultLines: [false, false] })]);
    await click(inLi(3).getByRole("button", { name: sentence({ phase: "dream", count: 2 }) }));
    expect([...li(3).querySelectorAll("li")].map((x) => x.textContent)).toEqual(["合并了：爱吃面", "拆成了：a；b"]);
  });

  it("a full notice with no lines says the palace is nearly full", async () => {
    await openChat([...BASE, changed(3, { lines: [], vaultLines: [], count: 0, full: true })]);
    expect(li(3).textContent).toBe("小助手的记忆宫殿快满了");
  });

  it("an Agent that cannot be named reads 「Agent」, never 「它」 (design §8)", () => {
    const msg = { id: "m3", seq: 3, kind: "system", text: "x", system: { event: "memory_changed", changeId: "c1", lines: ["忘掉了：x"], vaultLines: [false], pending: false, unlock: false, full: false, status: "applied" } };
    render(
      <StoreProvider initialState={emptyState()}>
        <ol>
          <MemoryNotice msg={msg} conv={{ type: "agent", agentId: AG1, id: A1 }} />
        </ol>
      </StoreProvider>,
    );
    expect(screen.getByRole("button").textContent).toBe("Agent小憩时理了理记忆");
  });
});

describe("the confirmation cards", () => {
  // A card that asks first is in the future tense: the service writes its lines so.
  const pending = (fields = {}) => changed(3, { pending: true, status: "pending", lines: ["要记住：不吃辣", "要记住：住在上海"], ...fields });

  it("a pending change that only remembers is the card 要记住这些吗？ with its lines, 记住 and 不用", async () => {
    await openChat([...BASE, pending()]);
    expect(li(3).textContent).toContain("要记住这些吗？");
    expect(li(3).textContent).toContain("要记住：不吃辣");
    expect(inLi(3).getByRole("button", { name: "记住" })).toBeTruthy();
    expect(inLi(3).getByRole("button", { name: "不用" })).toBeTruthy();
    expect(inLi(3).queryByRole("button", { name: "记忆已更新" })).toBeNull();
  });

  it("记住 confirms: the route is called and the card becomes the chip", async () => {
    const { api } = await openChat([...BASE, pending()]);
    await click(inLi(3).getByRole("button", { name: "记住" }));
    expect(api.confirmMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    // (The service pushes the notice again with its lines in the past tense; until then the sentence counts the lines it has.)
    expect(li(3).textContent).toBe(sentence({ lines: ["要记住：不吃辣", "要记住：住在上海"] }));
  });

  it("不用 discards: the route is called and the card goes", async () => {
    const { api } = await openChat([...BASE, pending()]);
    await click(inLi(3).getByRole("button", { name: "不用" }));
    expect(api.discardMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(li(3).textContent).toBe("");
  });

  it("an unlock is the card 要把这条从保险箱取出来吗？ with 取出 and 不用", async () => {
    const { api } = await openChat([...BASE, pending({ unlock: true, lines: ["取出来：住在上海"], vaultLines: [true] })]);
    expect(li(3).textContent).toContain("要把这条从保险箱取出来吗？");
    expect(inLi(3).queryByRole("button", { name: "记住" })).toBeNull();
    await click(inLi(3).getByRole("button", { name: "取出" }));
    expect(api.confirmMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(inLi(3).getByRole("button", { name: "小助手小憩时理了理记忆" })).toBeTruthy();
  });

  it("a stale confirm (409) says so, keeps the lines and leaves no button", async () => {
    const confirmMemoryChange = vi.fn(async () => {
      throw apiError(409, "stale_change");
    });
    await openChat([...BASE, pending()], { api: { confirmMemoryChange } });
    await click(inLi(3).getByRole("button", { name: "记住" }));
    expect(inLi(3).getByRole("alert").textContent).toBe("这条改动已经过时了：记忆后来又变过。");
    expect(inLi(3).queryByRole("button", { name: "记住" })).toBeNull();
    expect(inLi(3).queryByRole("button", { name: "不用" })).toBeNull();
    expect(li(3).textContent).toContain("要记住：不吃辣");
  });

  it("a confirm that applied the adds but dropped in-place ops (their note changed since) says how many with a toast; one that dropped nothing says nothing", async () => {
    const confirmMemoryChange = vi.fn(async () => ({ status: "applied", dropped: 1 }));
    await openChat([...BASE, pending({ lines: ["要改成：喜欢麻婆豆腐", "要记住：喜欢喝茶"] })], { api: { confirmMemoryChange } });
    await click(inLi(3).getByRole("button", { name: "确认" }));
    expect(confirmMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    expect(document.querySelector(".toast").textContent).toBe("有 1 处没有改：那条记忆后来又变过。");
    expect(inLi(3).queryByRole("alert")).toBeNull();
    cleanup();
    await openChat([...BASE, pending()]);
    await click(inLi(3).getByRole("button", { name: "记住" }));
    expect(document.querySelector(".toast")).toBeNull();
  });

  it("a card that also forgets, rewrites or locks asks 要这样整理记忆吗？ with 确认 and 不用: never 记住 above a line that forgets", async () => {
    const { api } = await openChat([...BASE, pending({ lines: ["要忘掉：喜欢喝茶", "要锁进保险箱：住在上海"] })]);
    expect(li(3).textContent).toContain("要这样整理记忆吗？");
    expect(li(3).textContent).not.toContain("要记住这些吗？");
    expect(inLi(3).queryByRole("button", { name: "记住" })).toBeNull();
    await click(inLi(3).getByRole("button", { name: "确认" }));
    expect(api.confirmMemoryChange).toHaveBeenCalledWith(AG1, "c1");
    // A dream's merge and split ask the same.
    cleanup();
    await openChat([...BASE, pending({ lines: ["要合并成：爱喝茶", "要拆成：喜欢茶；对花生过敏"], phase: "dream" })]);
    expect(li(3).textContent).toContain("要这样整理记忆吗？");
  });

  it("an expired notice (its record swept away) keeps the chip and its lines with no 撤销; an expired card reads 已过期 and has no buttons", async () => {
    await openChat([...BASE, changed(3, { status: "expired" })]);
    await click(inLi(3).getByRole("button", { name: sentence() }));
    expect(li(3).textContent).toContain("记住了：不吃辣");
    expect(inLi(3).queryByRole("button", { name: "撤销" })).toBeNull();
    cleanup();
    await openChat([...BASE, changed(3, { status: "expired", lines: ["要记住：不吃辣"], vaultLines: [false] })]);
    expect(li(3).textContent).toBe("已过期");
    expect(inLi(3).queryByRole("button")).toBeNull();
    cleanup();
    await openChat([...BASE, changed(3, { status: "expired", unlock: true, lines: ["住在上海"], vaultLines: [true] })]);
    expect(li(3).textContent).toBe("已过期");
  });

  it("in a deleted Agent's conversation the card's buttons are off", async () => {
    await openChat([...BASE, pending()], { deleted: true });
    expect(inLi(3).getByRole("button", { name: "记住" }).disabled).toBe(true);
    expect(inLi(3).getByRole("button", { name: "不用" }).disabled).toBe(true);
  });

  it("one decision at a time while one is on its way", async () => {
    const wait = deferred();
    const { api } = await openChat([...BASE, pending()], { api: { confirmMemoryChange: vi.fn(() => wait.promise) } });
    await click(inLi(3).getByRole("button", { name: "记住" }));
    expect(inLi(3).getByRole("button", { name: "不用" }).disabled).toBe(true);
    expect(api.discardMemoryChange).not.toHaveBeenCalled();
  });
});

describe("never in a group", () => {
  it("a memory notice in a group shows nothing", async () => {
    const G = "00000000-0000-4000-8000-0000000000c2";
    const members = [ME_ID, ANN].map((id, i) => ({ id, role: "speaker", isCreator: i === 0 }));
    const messages = [wire(G, 1, ANN, "大家好"), notice(G, 2, "记忆已更新", { event: "memory_changed", actorId: AG1, changeId: "c9", lines: ["记住了：x"], pending: false, unlock: false, full: false, status: "applied" })];
    const conversation = group(G, { members, lastSeq: 2, readSeq: 2 });
    await openApp({ sync: () => syncOf([conversation], messages, PRINCIPALS), handlers: { models: () => MODELS } });
    await click(screen.getByText(conversation.title, { selector: ".list-col .row-name" }));
    expect(timeline().textContent).toContain("大家好");
    expect(mainText()).not.toContain("记忆已更新");
    expect(mainText()).not.toContain("记住了");
  });
});
