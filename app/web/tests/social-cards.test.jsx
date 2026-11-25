// @vitest-environment jsdom
// The persona aid's card (plan A8b; ring 1a): in the owner's own conversation with their Agent, a sentence of the persona that looks like a
// fact about someone, worded as the plan says, with 「移到“关于我”」 and 「不用」; an answered or over card shows its answer and offers no button.
// System UI text: never the Agent's voice.
import "./markdown-ready.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { A1, AG1, ANN, D1, MODELS, PRINCIPALS, agentConv, agentOf, agentPrincipal, apiError, direct, notice, syncOf, wire, ME_ID } from "./fixtures.js";
import { click, installBrowser, openApp, push } from "./harness.jsx";
import { personaFactQuestion } from "../src/pages/SocialCards.jsx";

beforeEach(() => installBrowser());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const SITE_FREE = { source: "site", id: "free-1" };
const SENTENCE = "主人住在杭州滨江区。";
const BASE = [wire(A1, 1, AG1, "你好，我是小助手"), wire(A1, 2, ME_ID, "你好")];

/** The `persona_fact` event of the wire contract at `seq`, with the `card` the service sends to the owner alone. */
const fact = (seq, card = { answer: null, expired: false, sentence: SENTENCE }, extra = {}) =>
  notice(A1, seq, "人格里有句话可能被说给别人", {
    event: "persona_fact",
    actorId: AG1,
    agentId: AG1,
    sentence: SENTENCE,
    personaVersion: 1,
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    ...(card === null ? {} : { card }),
    ...extra,
  });

async function openChat(messages, { api = {}, social = { enabled: true } } = {}) {
  const record = agentOf(AG1, { model: SITE_FREE });
  const lastSeq = messages.reduce((max, m) => Math.max(max, m.seq), 0);
  const conversation = agentConv(A1, AG1, { lastSeq, readSeq: lastSeq, agent: { paused: false, deleted: false }, canSend: { ok: true } });
  const app = await openApp({
    sync: () => ({ ...syncOf([conversation], messages, [...PRINCIPALS, agentPrincipal()]), social }),
    api: { answerPersonaFact: vi.fn(async () => ({ ok: true, moved: true })), listProviders: vi.fn(async () => ({ providers: [] })), ...api },
    handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), models: () => MODELS },
  });
  await click(screen.getByText("小助手", { selector: ".list-col .row-name" }));
  return app;
}

const li = (seq) => document.querySelector(`ol.messages li[data-msg="m${seq}"]`);
const inLi = (seq) => within(li(seq));
const MOVE = "移到“关于我”";

describe("the persona_fact card", () => {
  it("says the plan's words with the sentence, and offers 移到“关于我” and 不用", async () => {
    await openChat([...BASE, fact(3)]);
    expect(personaFactQuestion(SENTENCE)).toBe("人格里这句话像是关于你或别人的事实：〈主人住在杭州滨江区。〉。别人问起时可能被说出来。要移到“关于我”吗？");
    expect(li(3).textContent).toContain(personaFactQuestion(SENTENCE));
    expect(inLi(3).getByRole("button", { name: MOVE })).toBeTruthy();
    expect(inLi(3).getByRole("button", { name: "不用" })).toBeTruthy();
  });

  it("移到“关于我” sends move: true for this card and then says it was moved, with no button", async () => {
    const { api } = await openChat([...BASE, fact(3)]);
    await click(inLi(3).getByRole("button", { name: MOVE }));
    expect(api.answerPersonaFact).toHaveBeenCalledWith(AG1, 3, true);
    expect(inLi(3).getByText("已移到“关于我”。")).toBeTruthy();
    expect(inLi(3).queryByRole("button", { name: MOVE })).toBeNull();
    expect(inLi(3).queryByRole("button", { name: "不用" })).toBeNull();
  });

  it("不用 sends move: false and says it was kept; a sentence that was no longer in the persona reads as kept too", async () => {
    const { api } = await openChat([...BASE, fact(3), fact(4)], { api: { answerPersonaFact: vi.fn(async (_agent, seq) => ({ ok: true, moved: seq === 99 })) } });
    await click(inLi(3).getByRole("button", { name: "不用" }));
    expect(api.answerPersonaFact).toHaveBeenCalledWith(AG1, 3, false);
    expect(inLi(3).getByText("已保留在人格里。")).toBeTruthy();
    await click(inLi(4).getByRole("button", { name: MOVE }));
    expect(inLi(4).getByText("已保留在人格里。")).toBeTruthy();
  });

  it("an answered card shows its answer and no button; so does one that ran out", async () => {
    await openChat([...BASE, fact(3, { answer: "moved", expired: false, sentence: SENTENCE }), fact(4, { answer: "kept", expired: true, sentence: SENTENCE }), fact(5, { answer: null, expired: true, sentence: SENTENCE })]);
    expect(inLi(3).getByText("已移到“关于我”。")).toBeTruthy();
    expect(inLi(4).getByText("已保留在人格里。")).toBeTruthy();
    expect(inLi(5).getByText("这张卡片已经过期了。")).toBeTruthy();
    for (const seq of [3, 4, 5]) expect(li(seq).querySelectorAll("button").length).toBe(0);
  });

  it("answered elsewhere (409) says so on the card and ends it; a full room says so and leaves the buttons", async () => {
    const answered = vi.fn(async () => {
      throw apiError(409, "answered");
    });
    await openChat([...BASE, fact(3)], { api: { answerPersonaFact: answered } });
    await click(inLi(3).getByRole("button", { name: MOVE }));
    expect(inLi(3).getByRole("alert").textContent).toBe("这件事已经回答过了。");
    expect(li(3).querySelectorAll("button").length).toBe(0);
    cleanup();
    const full = vi.fn(async () => {
      throw apiError(409, "room_full");
    });
    await openChat([...BASE, fact(3)], { api: { answerPersonaFact: full } });
    await click(inLi(3).getByRole("button", { name: MOVE }));
    expect(inLi(3).getByRole("alert").textContent).toContain("装不下");
    expect(inLi(3).getByRole("button", { name: MOVE })).toBeTruthy();
    expect(inLi(3).getByRole("button", { name: "不用" })).toBeTruthy();
  });

  it("while the site's switch is off the card is not drawn at all: no button whose route answers 404 (A-4 review m8)", async () => {
    await openChat([...BASE, fact(3)], { social: { enabled: false } });
    expect(li(3)?.textContent ?? "").toBe("");
    expect(document.body.textContent).not.toContain(MOVE);
  });

  it("an event without the owner's `card` shows nothing (no one else is sent it)", async () => {
    await openChat([...BASE, fact(3, null)]);
    expect(li(3)?.textContent ?? "").toBe("");
  });
});

// Lane I (Controller ruling 2026-11-25 (A-5 review), I1): the card must be noticed. For its owner, in the Agent's own conversation, it counts
// as unread and moves the conversation up the list with a preview, as a message would; only while the site's switch is on (off, it is not drawn).
describe("the persona_fact card as unread", () => {
  const row = (name) => screen.getByText(name, { selector: ".list-col .row-name" }).closest(".row");
  const names = () => [...document.querySelectorAll(".list-col .row-name")].map((n) => n.textContent);
  const D = [wire(D1, 1, ANN, "在吗"), wire(D1, 2, ME_ID, "在")];
  async function openList(social) {
    const record = agentOf(AG1, { model: SITE_FREE });
    const mine = agentConv(A1, AG1, { lastSeq: 2, readSeq: 2, agent: { paused: false, deleted: false }, canSend: { ok: true } });
    return openApp({
      sync: () => ({ ...syncOf([mine, direct(D1, ANN, { lastSeq: 2, readSeq: 2 })], [...BASE, ...D], [...PRINCIPALS, agentPrincipal()]), social }),
      api: { listProviders: vi.fn(async () => ({ providers: [] })) },
      handlers: { agents: () => ({ agents: [record] }), agent: () => record, run: () => ({ run: null }), models: () => MODELS },
    });
  }
  // (Later than every message of the fixtures: `at(seq)` is minutes from one start.)
  const late = (m) => ({ ...m, createdAt: new Date(Date.parse(wire(D1, 50, ANN).createdAt)).toISOString() });

  it("a card that arrives counts 1 unread for the Agent's conversation, puts it first and previews as the service's sentence", async () => {
    const { transport } = await openList({ enabled: true });
    expect(names()[0]).toBe("小安");
    expect(row("小助手").querySelector(".badge")).toBeNull();
    await push(transport, { type: "message", message: late(fact(3)) });
    expect(names()[0]).toBe("小助手");
    expect(row("小助手").querySelector(".badge").textContent).toBe("1");
    expect(row("小助手").textContent).toContain("人格里有句话可能被说给别人");
  });

  it("another notice there still counts nothing; a `persona_fact` event without my `card` counts nothing", async () => {
    const { transport } = await openList({ enabled: true });
    await push(transport, { type: "message", message: late(fact(3, null)) });
    expect(row("小助手").querySelector(".badge")).toBeNull();
    expect(names()[0]).toBe("小安");
  });

  it("switch off: it is not drawn, so it counts nothing and moves nothing", async () => {
    const { transport } = await openList({ enabled: false });
    await push(transport, { type: "message", message: late(fact(3)) });
    expect(row("小助手").querySelector(".badge")).toBeNull();
    expect(names()[0]).toBe("小安");
    expect(row("小助手").textContent).not.toContain("人格里有句话可能被说给别人");
  });
});
