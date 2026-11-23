// @vitest-environment jsdom
// A mention in a message (src/ui/MentionText.jsx, MentionCard.jsx): the current display name on a tint, the reader's own
// stronger, a card on hover / focus / tap, a gone account muted without a card; and what the web sends is unchanged.
import React from "react";
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../src/App.jsx";
import { createDataLayer } from "../src/data/store.jsx";
import { AG1, AG2, ANN, BO, D1, G1, ME, ME_ID, PRINCIPALS, agentPrincipal, direct, emptySocial, fakeTimers, fakeTransport, group, syncOf, wire } from "./fixtures.js";

const NOW = new Date(2026, 10, 16, 12, 0).getTime();
const GONE = "00000000-0000-4000-8000-0000000000ee";

beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{ top: 0 }]);
  history.replaceState(null, "", "/");
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const flush = () =>
  act(async () => {
    for (let i = 0; i < 6; i += 1) await vi.advanceTimersByTimeAsync(0);
  });

// 阿波 is a person, 小助 is an Agent of 小安 (shared in the group), 小安 is a person; GONE is nobody the app knows.
const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AG2, "ann.xiaozhu", "小助"), ownerId: ANN }];
const TEXT = "@阿波 @小助 @Mei @已走的人 你们好";
const MENTIONS = [
  { id: BO, start: 0, length: 3 },
  { id: AG2, start: 4, length: 3 },
  { id: ME_ID, start: 8, length: 4 },
  { id: GONE, start: 13, length: 5 },
];

async function openApp({ principals = PEOPLE, messages = [wire(G1, 1, ANN, TEXT, { mentions: MENTIONS })], api: over = {} } = {}) {
  const sync = () => syncOf([direct(D1, ANN, { lastSeq: 0, readSeq: 0 }), group(G1, { lastSeq: messages.length, readSeq: messages.length, members: [{ id: ME_ID, role: "speaker", isCreator: true }, { id: ANN, role: "speaker", isCreator: false }, { id: BO, role: "speaker", isCreator: false }, { id: AG2, role: "speaker", isCreator: false }] })], messages, principals);
  const transport = fakeTransport({ sync, social: emptySocial });
  const api = { sendMessage: vi.fn(() => new Promise(() => {})), markRead: vi.fn(async (_id, seq) => ({ readSeq: seq })), listMessages: vi.fn(async () => ({ messages: [], nextBefore: null })), ...over };
  let n = 0;
  const layer = createDataLayer({ transport, api, timers: fakeTimers(), now: () => NOW, random: () => 0.5, uuid: () => `tx-${++n}` });
  render(<App api={{ getMe: async () => ME }} createLayer={() => layer} />);
  await flush();
  fireEvent.click(screen.getByText("周末小组", { selector: ".list-col .row-name" }));
  await flush();
  return { layer, transport, api };
}
const tags = () => [...document.querySelectorAll('li[data-msg="m1"] .mention')];
const shown = (tag) => tag.querySelector('[aria-hidden="true"]').textContent;
const spokenOf = (tag) => tag.querySelector(".sr-only").textContent;
const card = () => document.querySelector(".mention-card");
const hover = async (tag) => {
  fireEvent.mouseEnter(tag);
  await act(async () => vi.advanceTimersByTimeAsync(300));
};

describe("what a mention shows", () => {
  it("each one is the current display name of whom it means, with @ — not the name it was sent with", async () => {
    await openApp({ messages: [wire(G1, 1, ANN, "@旧名 @旧助手 好", { mentions: [{ id: BO, start: 0, length: 3 }, { id: AG2, start: 4, length: 4 }] })] });
    expect(tags().map(shown)).toEqual(["@阿波", "@小助"]);
    expect(tags().map(spokenOf)).toEqual(["提到 阿波", "提到 小助"]);
    expect(tags().map((t) => t.dataset.mention)).toEqual([BO, AG2]);
  });

  it("follows a rename: the name shown changes, the stored text does not", async () => {
    const { transport } = await openApp();
    expect(tags().map(shown).slice(0, 2)).toEqual(["@阿波", "@小助"]);
    const renamed = PEOPLE.map((p) => (p.id === BO ? { ...p, displayName: "波波" } : p.id === AG2 ? { ...p, displayName: "助理小助" } : p));
    transport.handlers.sync = () => syncOf([direct(D1, ANN, { lastSeq: 0, readSeq: 0 }), group(G1, { lastSeq: 1, readSeq: 1, members: [{ id: ME_ID, role: "speaker", isCreator: true }, { id: ANN, role: "speaker", isCreator: false }, { id: BO, role: "speaker", isCreator: false }, { id: AG2, role: "speaker", isCreator: false }] })], [wire(G1, 1, ANN, TEXT, { mentions: MENTIONS })], renamed);
    await act(async () => transport.socket.emit({ type: "conversation", id: "00000000-0000-4000-8000-0000000000f0" }));
    await flush();
    expect(tags().map(shown).slice(0, 2)).toEqual(["@波波", "@助理小助"]);
    expect(tags().map(spokenOf).slice(0, 2)).toEqual(["提到 波波", "提到 助理小助"]);
  });

  it("the visible name comes first and the hidden words after it, so a pointer's target is the name", async () => {
    await openApp();
    for (const tag of tags()) {
      expect(tag.firstElementChild.getAttribute("aria-hidden")).toBe("true");
      expect(tag.lastElementChild.classList.contains("sr-only")).toBe(true);
    }
  });

  it("a mention of the reader herself is her display name and is the stronger one", async () => {
    await openApp();
    const [bo, agent, me] = tags();
    expect(shown(me)).toBe("@Mei");
    expect(spokenOf(me)).toBe("提到 你");
    expect(me.classList.contains("mention-self")).toBe(true);
    expect(bo.classList.contains("mention-self")).toBe(false);
    expect(agent.classList.contains("mention-agent")).toBe(true);
    expect(bo.classList.contains("mention-agent")).toBe(false);
  });

  it("a mention whose account is gone shows its last known name muted, is no button and has no card", async () => {
    await openApp();
    const gone = tags()[3];
    expect(gone.classList.contains("mention-gone")).toBe(true);
    expect(shown(gone)).toBe("@已走的人");
    expect(spokenOf(gone)).toBe("提到 已走的人");
    expect(gone.getAttribute("role")).toBeNull();
    expect(gone.getAttribute("tabindex")).toBeNull();
    await hover(gone);
    fireEvent.click(gone);
    fireEvent.focus(gone);
    expect(card()).toBeNull();
  });

  it("the stylesheet: accent text on a tint, 4px radius, 1px 4px padding, no frame; the reader's own stronger; a gone one muted", () => {
    const css = readFileSync("src/styles.css", "utf8");
    const rule = (selector) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, "\\$&")} \\{([^}]*)\\}`))?.[1] ?? "";
    const base = rule(".mention");
    expect(base).toMatch(/border-radius: 4px;/);
    expect(base).toMatch(/padding: 1px 4px;/);
    expect(base).toMatch(/background: [^;]*var\(--purple\)/);
    expect(base).toMatch(/color: var\(--purple-dark\);/);
    expect(base).not.toMatch(/box-shadow|border:/);
    expect(css).not.toMatch(/\.mention\.mention-agent \{[^}]*box-shadow/);
    const strength = (text) => Number(text.match(/var\(--purple\) (\d+)%/)?.[1]);
    expect(strength(rule(".mention.mention-self"))).toBeGreaterThan(strength(base));
    expect(rule(".mention.mention-gone")).toMatch(/color: var\(--ink-2\);/);
    // On my own (purple) bubble the accent text is under 4.5:1; plain ink there.
    expect(css).toMatch(/\.msg\.mine \.mention \{[^}]*color: var\(--ink\);/);
    // ...but a gone mention stays muted there too (the rule above would out-rank it).
    expect(css).toMatch(/\.msg\.mine \.mention\.mention-gone \{[^}]*color: var\(--ink-2\);/);
    // The composer's tags have the same tint and radius.
    const chip = rule(".composer-mirror .mention-chip");
    expect(chip).toMatch(/border-radius: 4px;/);
    expect(strength(chip)).toBe(strength(base));
  });
});

describe("the card", () => {
  it("a touch is not a hover: the mouse events a phone emulates after a finger go (the first tap is the tap's own)", async () => {
    await openApp();
    const bo = tags()[0];
    fireEvent.touchStart(bo);
    fireEvent.mouseEnter(bo); // what iOS fires after a touch
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(card()).toBeNull();
    fireEvent.click(bo); // the tap itself opens it at once
    expect(card()).not.toBeNull();
  });

  it("hovering a person opens it after a moment: avatar, display name, kind, account name — and it leaves with the pointer", async () => {
    await openApp();
    const bo = tags()[0];
    fireEvent.mouseEnter(bo);
    expect(card()).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(card().getAttribute("role")).toBe("tooltip");
    expect(card().querySelector("strong").textContent).toBe("阿波");
    // (A person has no label; only an Agent is tagged.)
    expect(card().textContent).not.toContain("真人");
    expect(card().textContent).toContain("@bo");
    expect(card().textContent).not.toContain("主人");
    expect(card().querySelector(".avatar")).not.toBeNull();
    expect(bo.getAttribute("aria-describedby")).toBe(card().id);
    fireEvent.mouseLeave(bo);
    await act(async () => vi.advanceTimersByTimeAsync(300));
    expect(card()).toBeNull();
  });

  it("an Agent's card says Agent, its account name and its owner", async () => {
    await openApp();
    await hover(tags()[1]);
    expect(card().querySelector("strong").textContent).toBe("小助");
    expect(card().textContent).toContain("Agent");
    expect(card().textContent).toContain("@ann.xiaozhu");
    expect(card().textContent).toContain("主人：小安");
  });

  it("my own mention opens a card of me with my account name", async () => {
    await openApp();
    await hover(tags()[2]);
    expect(card().querySelector("strong").textContent).toBe("Mei");
    expect(card().textContent).toContain("@me_one");
  });

  it("the keyboard reaches it: a mention is a focus stop, focus and Enter open the card, Esc closes it, leaving closes it", async () => {
    await openApp();
    const bo = tags()[0];
    expect(bo.getAttribute("role")).toBe("button");
    expect(bo.tabIndex).toBe(0);
    act(() => bo.focus());
    expect(card()).not.toBeNull();
    fireEvent.keyDown(document.activeElement, { key: "Escape" });
    expect(card()).toBeNull();
    fireEvent.keyDown(bo, { key: "Enter" });
    expect(card()).not.toBeNull();
    expect(bo.hasAttribute("aria-expanded")).toBe(false);
    expect(bo.hasAttribute("aria-haspopup")).toBe(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(card()).toBeNull();
    fireEvent.keyDown(bo, { key: " " });
    expect(card()).not.toBeNull();
    act(() => bo.blur());
    expect(card()).toBeNull();
  });

  it("a tap opens it, and a press anywhere else closes it; a press on the card does not", async () => {
    await openApp();
    fireEvent.click(tags()[0]);
    expect(card()).not.toBeNull();
    fireEvent.pointerDown(card());
    expect(card()).not.toBeNull();
    fireEvent.pointerDown(document.body);
    expect(card()).toBeNull();
  });

  it("a click on a mention does not reach a click handler of the message around it", async () => {
    await openApp();
    const seen = vi.fn();
    document.addEventListener("click", seen);
    try {
      fireEvent.click(tags()[0]);
      expect(seen).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("click", seen);
    }
  });

  it("one card at a time", async () => {
    await openApp();
    fireEvent.click(tags()[0]);
    fireEvent.click(tags()[1]);
    expect(document.querySelectorAll(".mention-card")).toHaveLength(1);
    expect(card().querySelector("strong").textContent).toBe("小助");
  });

  it("does not shift the message: it hangs in the page's body, fixed, and the message's own markup is the same", async () => {
    await openApp();
    const li = document.querySelector('li[data-msg="m1"]');
    const before = li.innerHTML;
    fireEvent.click(tags()[0]);
    expect(card().closest("li")).toBeNull();
    expect(card().parentElement).toBe(document.body);
    const sheet = readFileSync("src/styles.css", "utf8");
    expect(sheet).toMatch(/\.mention-card \{[^}]*position: fixed;/);
    // Only the chip's own state attributes differ.
    expect(li.innerHTML.replace(/ aria-describedby="[^"]*"/, "")).toBe(before);
  });
});

describe("what the web sends is unchanged", () => {
  it("a mention picked from the list is sent as text with its id and range — no name, no handle — wherever the name shown has gone", async () => {
    const { api } = await openApp({ messages: [wire(G1, 1, ANN, "hi")] });
    const box = screen.getByLabelText("消息内容");
    fireEvent.change(box, { target: { value: "你好 @", selectionStart: 4, selectionEnd: 4 } });
    fireEvent.click(screen.getAllByRole("option").find((o) => o.querySelector("strong").textContent === "小助"));
    fireEvent.keyDown(box, { key: "Enter" });
    const body = api.sendMessage.mock.calls.at(-1)[1];
    expect(body).toEqual({ clientTxn: "tx-1", text: "你好 @小助", mentions: [{ id: AG2, start: 3, length: 3 }] });
    expect(Object.keys(body.mentions[0]).sort()).toEqual(["id", "length", "start"]);
    expect(JSON.stringify(body)).not.toContain("ann.xiaozhu");
  });
});
