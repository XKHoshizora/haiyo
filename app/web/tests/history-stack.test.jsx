// @vitest-environment jsdom
// The history never traps and never grows on Back: pages that turn out to be gone (a conversation removed or left, a deleted provider) replace the
// entry they are in with their parent, once, however the entry was reached. Table cases, then a property over random walks.
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { ANN, BO, D1, G1, ME_ID, direct, emptySocial, group, syncOf, wire } from "./fixtures.js";
import { flush, installBrowser, openApp, toastText } from "./harness.jsx";

const G2 = "00000000-0000-4000-8000-0000000000c4";
const world = (alive) => () =>
  syncOf(
    [
      ...(alive.has(D1) ? [direct(D1, ANN, { lastSeq: 1, readSeq: 1 })] : []),
      ...(alive.has(G1) ? [group(G1, { lastSeq: 1, readSeq: 1, members: [{ id: ME_ID, role: "speaker", isCreator: true }, { id: ANN, role: "speaker", isCreator: false }, { id: BO, role: "speaker", isCreator: false }] })] : []),
      ...(alive.has(G2) ? [group(G2, { title: "第二群", lastSeq: 1, readSeq: 1 })] : []),
    ],
    [wire(D1, 1, ANN, "早"), wire(G1, 1, ANN, "你好"), wire(G2, 1, BO, "嗨")].filter((m) => alive.has(m.conversationId)),
  );

const step = async (move) => {
  await act(async () => {
    move();
    await vi.advanceTimersByTimeAsync(60);
  });
};
const back = () => step(() => window.history.back());
const forward = () => step(() => window.history.forward());
const path = () => window.location.pathname;
const index = () => window.history.state?.index ?? 0;
const openRow = async (name) => {
  fireEvent.click(screen.getByText(name, { selector: ".list-col .row-name" }));
  await flush();
};
async function start(alive) {
  installBrowser();
  const app = await openApp({ sync: world(alive), social: emptySocial() });
  return app;
}
const remove = async (app, alive, ...ids) => {
  for (const id of ids) alive.delete(id);
  app.env.sync = world(alive);
  await act(async () => app.layer.actions.syncNow());
  await flush();
};
/** Back until it stops: the stack never grows and the first in-app entry is where it ends. */
async function backToTheStart() {
  const length = window.history.length;
  let last = index();
  for (let i = 0; i < 30; i += 1) {
    await back();
    expect(window.history.length, "Back never grows the stack").toBeLessThanOrEqual(length);
    expect(index(), "Back never goes up").toBeLessThanOrEqual(last);
    last = index();
    if (last === 0) break;
  }
  expect(last).toBe(0);
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("a page that is gone replaces its entry with its parent, once", () => {
  it("a conversation removed while I am inside it, then Back and Forward: no trap, the notice says the removal once", async () => {
    const alive = new Set([D1, G1, G2]);
    const app = await start(alive);
    await openRow("周末小组");
    expect(path()).toBe(`/chat/${G1}`);
    await remove(app, alive, G1);
    expect(path()).toBe("/");
    expect(toastText()).toBe("你已不在该会话中");
    await back();
    await forward();
    await backToTheStart();
  });

  it("Back onto the entry of a conversation that was removed meanwhile: replaced by the list once, the next Back goes below it", async () => {
    const alive = new Set([D1, G1, G2]);
    const app = await start(alive);
    await openRow("周末小组");
    await openRow("第二群"); // (desktop-like: a push per conversation)
    await remove(app, alive, G1);
    const before = window.history.length;
    await back(); // onto /chat/G1: gone
    expect(path()).toBe("/");
    expect(window.history.length).toBe(before);
    const at = index();
    await back();
    expect(index()).toBeLessThan(at);
    await backToTheStart();
  });

  it("Forward into a conversation that is gone: the list, and the entry is the list", async () => {
    const alive = new Set([D1, G1, G2]);
    const app = await start(alive);
    await openRow("周末小组");
    await back();
    await remove(app, alive, G1);
    await forward();
    expect(path()).toBe("/");
    await backToTheStart();
  });

  it("消息 when the last conversation is dead: the entry of the section being left is not overwritten", async () => {
    const alive = new Set([D1, G1, G2]);
    const app = await start(alive);
    await openRow("周末小组");
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /^通讯录/ }));
    await flush();
    expect(path()).toBe("/contacts");
    const entry = window.history.state;
    await remove(app, alive, G1);
    fireEvent.click(within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /^消息/ }));
    await flush();
    // The click went to the list (the dead chat is forgotten) as a push over /contacts, which is still there below it.
    expect(path()).toBe("/");
    expect(index()).toBe(entry.index + 1);
    await back();
    expect(path()).toBe("/contacts");
    await backToTheStart();
  });
});

describe("Back from any reachable stack ends at the first entry and never grows it (random walks)", () => {
  const random = (seed) => {
    let x = seed;
    return () => {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x / 4294967296;
    };
  };
  const names = ["周末小组", "第二群", "小安"];

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])("seed %i", async (seed) => {
    const rand = random(seed * 7919);
    const alive = new Set([D1, G1, G2]);
    const app = await start(alive);
    const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name });
    for (let i = 0; i < 12; i += 1) {
      const pick = Math.floor(rand() * 8);
      if (pick === 0 || pick === 1) {
        const row = screen.queryByText(names[Math.floor(rand() * names.length)], { selector: ".list-col .row-name" });
        if (row) {
          fireEvent.click(row);
          await flush();
        }
      } else if (pick === 2) {
        const button = screen.queryByRole("button", { name: "会话资料" });
        if (button) {
          fireEvent.click(button);
          await flush();
        }
      } else if (pick === 3) {
        const button = screen.queryByRole("button", { name: "群资料" });
        if (button) {
          fireEvent.click(button);
          await flush();
        }
      } else if (pick === 4) {
        fireEvent.click(rail([/^消息/, /^通讯录/, /^Agent/, /^设置/][Math.floor(rand() * 4)]));
        await flush();
      } else if (pick === 5 && alive.size > 1) {
        await remove(app, alive, [...alive][Math.floor(rand() * alive.size)]);
      } else if (pick === 6) await back();
      else await forward();
    }
    await backToTheStart();
  });
});

// ───────── a wider walk: in-app closes, the viewer, a leave chosen in the UI, and the contacts, Agents and providers pages
import { AG1, A1, MODELS, P1, agentConv, agentOf, agentPrincipal, providerOf, PRINCIPALS } from "./fixtures.js";
import { PEOPLE } from "./harness.jsx";
import { navOfAddress } from "../src/state/location.js";

const PIC = "00000000-0000-4000-8000-00000000f0a1";
const world2 = (alive) => () =>
  syncOf(
    [
      ...(alive.has(D1) ? [direct(D1, ANN, { lastSeq: 1, readSeq: 1 })] : []),
      ...(alive.has(G1) ? [group(G1, { lastSeq: 2, readSeq: 2 })] : []),
      ...(alive.has(G2) ? [group(G2, { title: "第二群", lastSeq: 1, readSeq: 1 })] : []),
      agentConv(A1, AG1),
    ],
    [
      wire(D1, 1, ANN, "早"),
      wire(G1, 1, ANN, "你好"),
      wire(G1, 2, BO, "", { kind: "file", attachment: { id: PIC, name: "图.png", size: 10, inline: true } }),
      wire(G2, 1, BO, "嗨"),
    ].filter((m) => alive.has(m.conversationId)),
    [...PRINCIPALS, agentPrincipal(AG1, "helper", "小助手")],
  );

describe("a wider random walk keeps the same promises, and the drawn page is always the address", () => {
  const random = (seed) => {
    let x = seed;
    return () => {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x / 4294967296;
    };
  };
  const CLOSERS = [/^返回列表$/, /^返回群聊/, /^返回通讯录/, /^返回我的 Agent/, /^返回$/, /^返回模型供应商/];

  it.each([11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])("seed %i", async (seed) => {
    const rand = random(seed * 104729);
    const alive = new Set([D1, G1, G2]);
    installBrowser();
    const app = await openApp({
      sync: world2(alive),
      social: { ...emptySocial(), friends: [PEOPLE[ANN]] },
      api: { listProviders: vi.fn(async () => ({ providers: [providerOf(P1)] })), removeMember: vi.fn(async () => ({ ok: true })) },
      handlers: { agents: () => ({ agents: [agentOf(AG1)] }), models: () => MODELS },
    });
    const rail = (name) => within(screen.getByRole("navigation", { name: "主导航" })).queryByRole("button", { name });
    const press = async (el) => {
      if (!el) return;
      fireEvent.click(el);
      await flush();
      await step(() => {}); // (a close goes back: the browser answers a moment later)
    };
    /** The page drawn is the address: the pane says page or list as the path does; a conversation in the path is alive. */
    const drawnIsTheAddress = () => {
      const want = navOfAddress({ path: path(), overlay: null }).pane;
      expect(document.querySelector(".app").dataset.pane, `the pane at ${path()} after ${globalThis.__trail}`).toBe(want);
      const id = /^\/chat\/([^/]+)/.exec(path())?.[1];
      if (id) expect(alive.has(id), `a conversation in the address is alive (${path()})`).toBe(true);
    };
    const trail = [];
    globalThis.__trail = trail;
    for (let i = 0; i < 16; i += 1) {
      const pick = Math.floor(rand() * 14);
      trail.push(`${pick}@${path()}`);
      if (pick <= 1) await press(screen.queryByText(["周末小组", "第二群", "小安"][Math.floor(rand() * 3)], { selector: ".list-col .row-name" }));
      else if (pick === 2) await press(screen.queryByRole("button", { name: "会话资料" }));
      else if (pick === 3) await press(screen.queryByRole("button", { name: "群资料" }));
      else if (pick === 4) await press(rail([/^消息/, /^通讯录/, /^Agent/, /^设置/][Math.floor(rand() * 4)]) ?? null);
      else if (pick === 5 && alive.size > 1) await remove(app, alive, [...alive][Math.floor(rand() * alive.size)]);
      else if (pick === 6) await back();
      else if (pick === 7) await forward();
      else if (pick === 8) await press(CLOSERS.map((re) => screen.queryByRole("button", { name: re })).find(Boolean) ?? within(document.querySelector(".side-col") ?? document.body).queryByRole("button", { name: "关闭" }));
      else if (pick === 9) await press(document.querySelector("button[data-image]"));
      else if (pick === 10) await press(document.querySelector(".list-col .row"));
      else if (pick === 11) await press(screen.queryByText("模型供应商", { selector: ".list-col .row-name" }));
      else if (pick === 12) await press(within(document.querySelector(".main-col")).queryAllByRole("button", { name: /添加供应商|编辑/ })[0]);
      else if (screen.queryByRole("tab", { name: "群设置" })) {
        // The leave chosen in the UI: 群设置, 退出本群, 确认退出 (the service then removes the conversation).
        await press(screen.queryByRole("tab", { name: "群设置" }));
        await press(screen.queryByRole("button", { name: "退出本群" }));
        const confirm = document.querySelector('[role="dialog"]') && within(document.querySelector('[role="dialog"]')).queryByRole("button", { name: "确认退出" });
        if (confirm) {
          await press(confirm);
          await remove(app, alive, G1);
        }
      }
      drawnIsTheAddress();
    }
    // Forward never lands on a page that is gone, and Back always ends at the first entry without growing the stack.
    for (let i = 0; i < 6; i += 1) {
      await forward();
      drawnIsTheAddress();
    }
    await backToTheStart();
    drawnIsTheAddress();
  });
});
