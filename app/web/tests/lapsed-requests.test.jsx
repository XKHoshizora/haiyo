// @vitest-environment jsdom
// A request this page holds that runs out (on the page's one clock) is asked about once: the social fetch a `social` push makes. The
// service lists open requests only, so its answer takes the request off every page by itself — the card offers 添加好友 again, an Agent's
// request row goes. Once per request and deadline: when the service still lists it (this clock runs ahead of the service's) nothing is asked
// again on the following ticks; several that run out together are one fetch; nothing is asked while the connection is not live.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, within } from "@testing-library/react";
import { lapsedRequests } from "../src/state/social.js";
import { ME } from "../src/data/identities.js";
import { AG1, ANN, BO, D1, PRINCIPALS, agentPrincipal, direct, emptySocial, syncOf, wire } from "./fixtures.js";
import { CY, DORA, NOW, PEOPLE, click, elapse, flush, goContacts, inMain, installBrowser, openApp, request, rowNames } from "./harness.jsx";

beforeEach(installBrowser);
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const H = 3_600_000;
const at = (ms) => new Date(NOW + ms).toISOString();
const baseSync = () => syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早")]);
const socialWith = (over = {}) => ({ ...emptySocial(), friends: [PEOPLE[ANN]], ...over });
const fetches = (transport, what = "social") => transport.log.filter((x) => x === what).length;
const openRow = async (name) => click(screen.getByText(name, { selector: ".list-col .row-name" }));
const contactsBadge = () =>
  within(screen.getByRole("navigation", { name: "主导航" })).getByRole("button", { name: /^通讯录/ }).querySelector(".badge")?.textContent ?? null;

describe("lapsedRequests", () => {
  it("names each held request past its deadline with its deadline: friend requests both ways, the requests on my Agents, my own asks", () => {
    const state = {
      relations: {
        [`p1|${ME}`]: { status: "incoming", requestId: "r1", expiresAt: at(-1) },
        [`${ME}|p2`]: { status: "pending", requestId: "r2", expiresAt: at(0) },
        [`p3|${ME}`]: { status: "incoming", requestId: "r3", expiresAt: at(1) },
        [`${ME}|p4`]: { status: "established" },
      },
      social: { enabled: true },
      agentContacts: {
        waiting: [
          { agentId: "ag1", subject: { id: "p5" }, until: at(-H) },
          { agentId: "ag1", subject: { id: "p6" }, until: at(H) },
        ],
        mine: [
          { agentId: "x1", state: "requested", until: at(-1) },
          { agentId: "x2", state: "live", until: null },
          { agentId: "x3", state: "requested", until: at(H) },
        ],
      },
    };
    expect(lapsedRequests(state, NOW)).toEqual([`friend:r1:${at(-1)}`, `friend:r2:${at(0)}`, `waiting:ag1:p5:${at(-H)}`, `asked:x1:${at(-1)}`]);
    expect(lapsedRequests({ ...state, social: { enabled: false } }, NOW)).toEqual([`friend:r1:${at(-1)}`, `friend:r2:${at(0)}`]);
  });
});

describe("a request that runs out while held", () => {
  it("is asked about once; the answer without it takes the row away, and its card offers 添加好友 again", async () => {
    const { env, transport } = await openApp({ sync: baseSync, social: socialWith({ incoming: [request("r1", PEOPLE[BO], { expiresAt: at(90_000) })] }) });
    await goContacts();
    await openRow("阿波");
    expect(inMain().getByRole("button", { name: "同意" })).toBeTruthy();
    const before = fetches(transport);
    // (The service lists open requests only: once it has run out, its answer has no such request.)
    env.social = socialWith();
    await elapse(60_000);
    expect(fetches(transport)).toBe(before);
    await elapse(60_000);
    await flush();
    expect(fetches(transport)).toBe(before + 1);
    expect(rowNames()).not.toContain("阿波");
    expect(inMain().getByRole("button", { name: "添加好友" })).toBeTruthy();
    expect(inMain().queryByRole("button", { name: "同意" })).toBeNull();
    expect(contactsBadge()).toBeNull();
    await elapse(5 * 60_000);
    expect(fetches(transport)).toBe(before + 1);
  });

  it("an outgoing one the same way: its card offers 添加好友 again", async () => {
    const { env, transport } = await openApp({ sync: baseSync, social: socialWith({ friends: [], outgoing: [request("r2", PEOPLE[ANN], { expiresAt: at(90_000) })] }) });
    await goContacts();
    await openRow("小安");
    expect(inMain().getByRole("button", { name: "撤回" })).toBeTruthy();
    const before = fetches(transport);
    env.social = socialWith({ friends: [] });
    await elapse(2 * 60_000);
    await flush();
    expect(fetches(transport)).toBe(before + 1);
    expect(inMain().getByRole("button", { name: "添加好友" })).toBeTruthy();
  });

  it("this clock ahead of the service's: the answer still lists it, it stays as it reads (已过期, nothing to press), and nothing is asked again on the following ticks", async () => {
    const { transport } = await openApp({ sync: baseSync, social: socialWith({ incoming: [request("r1", PEOPLE[BO], { expiresAt: at(90_000) })] }) });
    await goContacts();
    await openRow("阿波");
    const before = fetches(transport);
    await elapse(2 * 60_000);
    await flush();
    expect(fetches(transport)).toBe(before + 1);
    expect(inMain().queryByRole("button", { name: "同意" })).toBeNull();
    expect(document.querySelector(".main-col .rel-rows .tag").textContent).toBe("已过期");
    await elapse(10 * 60_000);
    expect(fetches(transport)).toBe(before + 1);
  });

  it("several that run out on the same tick are one fetch", async () => {
    const { env, transport } = await openApp({
      sync: baseSync,
      social: socialWith({ incoming: [request("r1", PEOPLE[BO], { expiresAt: at(70_000) }), request("r3", PEOPLE[CY], { expiresAt: at(80_000) })], outgoing: [request("r2", PEOPLE[DORA], { expiresAt: at(100_000) })] }),
    });
    const before = fetches(transport);
    env.social = socialWith();
    await elapse(2 * 60_000);
    await flush();
    expect(fetches(transport)).toBe(before + 1);
    await goContacts();
    expect(rowNames()).toEqual(["小安"]);
  });

  it("nothing is asked while the connection is not live (a reconnect fetches anyway)", async () => {
    const { transport } = await openApp({ sync: baseSync, social: socialWith({ incoming: [request("r1", PEOPLE[BO], { expiresAt: at(90_000) })] }) });
    const before = fetches(transport);
    transport.autoOpen = false;
    transport.socket.drop(1006);
    await flush();
    await elapse(2 * 60_000);
    expect(fetches(transport)).toBe(before);
  });

  it("a request on my Agent: the row under 「别人想添加我的 Agent」 goes the same way, with one fetch", async () => {
    let contacts = { mine: [], waiting: [{ agentId: AG1, subject: { id: BO, handle: "bo", displayName: "阿波", avatarVersion: 0, kind: "human" }, since: at(-H), until: at(90_000) }] };
    const { transport } = await openApp({
      sync: () => ({ ...syncOf([direct(D1, ANN, { lastSeq: 1, readSeq: 1 })], [wire(D1, 1, ANN, "早")], [...PRINCIPALS, { ...agentPrincipal(AG1), ownerId: PRINCIPALS[0].id }]), social: { enabled: true } }),
      social: socialWith(),
      handlers: { agentContacts: () => contacts },
    });
    await goContacts();
    expect(screen.getByText("别人想添加我的 Agent")).toBeTruthy();
    const before = fetches(transport, "agent-contacts");
    contacts = { mine: [], waiting: [] };
    await elapse(2 * 60_000);
    await flush();
    expect(fetches(transport, "agent-contacts")).toBe(before + 1);
    expect(screen.queryByText("别人想添加我的 Agent")).toBeNull();
    await elapse(5 * 60_000);
    expect(fetches(transport, "agent-contacts")).toBe(before + 1);
  });
});
