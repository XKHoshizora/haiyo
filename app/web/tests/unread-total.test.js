// What counts in the tab bar's number: only conversations that can still receive messages. "Deleted" is read from the conversation's own sync entry
// (its `agent.deleted`, or the hold the service sends), never from a later Agent record, so the total is the same at first paint and after the Agents load.
import { describe, expect, it } from "vitest";
import { quiet, unreadTotal } from "../src/state/selectors.js";

const conv = (id, unread, extra = {}) => ({ id, type: "agent", agentId: `a-${id}`, unread, ...extra });
const stateOf = (convs, agents = {}) => ({ order: convs.map((c) => c.id), convs: Object.fromEntries(convs.map((c) => [c.id, c])), agents });

describe("unreadTotal", () => {
  it("counts the live conversations and leaves out a deleted Agent's, from the sync entry alone (no Agent record is loaded)", () => {
    const state = stateOf([conv("live", 3), conv("gone", 15, { agent: { deleted: true } }), { id: "g", type: "group", unread: 2 }]);
    expect(quiet(state, state.convs.gone)).toBe(true);
    expect(quiet(state, state.convs.live)).toBe(false);
    expect(unreadTotal(state)).toBe(5);
  });

  it("the hold the service sends for a deleted Agent's conversation says the same", () => {
    const state = stateOf([conv("gone", 4, { hold: { kind: "agentDeleted" } }), conv("live", 1)]);
    expect(unreadTotal(state)).toBe(1);
  });

  it("is the same before and after the Agents' records load: a late record changes nothing", () => {
    const convs = [conv("live", 3), conv("gone", 15, { agent: { deleted: true } })];
    const first = unreadTotal(stateOf(convs));
    const later = unreadTotal(stateOf(convs, { "a-gone": { deleted: true }, "a-live": { deleted: false } }));
    expect(later).toBe(first);
  });

  it("a conversation whose entry does not say it is deleted is live even if an Agent record later says so — display follows the entry, so nothing flickers", () => {
    const state = stateOf([conv("x", 2)], { "a-x": { deleted: true } });
    expect(quiet(state, state.convs.x)).toBe(false);
    expect(unreadTotal(state)).toBe(2);
  });
});
