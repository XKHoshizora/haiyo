// A social conversation (`agent_social`) in the view: its own type, never mapped as a group (plan T0.5 as built: the seam lane A's
// social chat stands on). With the site's switch off none exists, so every other conversation's view is what it was.
import { describe, expect, it } from "vitest";
import * as M from "../src/data/model.js";
import { toView } from "../src/data/viewmodel.js";
import { ANN, AG1, G1, ME_ID, PRINCIPALS, agentPrincipal, group, syncOf, wire } from "./fixtures.js";

const S1 = "00000000-0000-4000-8000-0000000000e1";

/** My side of a social conversation: I am the Agent's owner, an observer; ANN is the visitor and speaks. */
const social = (fields = {}) => ({
  id: S1,
  type: "agent_social",
  title: null,
  myRole: "observer",
  closed: false,
  canSend: { ok: true },
  social: { participants: [AG1, ANN], agents: [{ id: AG1, ownerId: ME_ID }] },
  members: [
    { id: ANN, role: "speaker", isCreator: false },
    { id: AG1, role: "speaker", isCreator: false },
    { id: ME_ID, role: "observer", isCreator: false },
  ],
  lastSeq: 2,
  readSeq: 2,
  unread: 0,
  ...fields,
});

function viewOf(conversations, messages = [], extra = (s) => s) {
  const principals = [...PRINCIPALS, { ...agentPrincipal(AG1), ownerId: ME_ID }];
  return toView(extra(M.applySync(M.initial(), syncOf(conversations, messages, principals))));
}

describe("the view of a social conversation", () => {
  it("is of its own type, keeps its participants and is not a group's", () => {
    const view = viewOf([social(), group(G1)]);
    expect(view.convs[S1]).toMatchObject({ type: "social", social: { participants: [AG1, ANN], agents: [{ id: AG1, ownerId: ME_ID }] }, myRole: "observer" });
    expect(view.convs[S1].avatar).toBeNull();
    expect(view.convs[S1].agentsTalking).toBe(false);
    // Nothing of a group's changes, and a group has no `social` key.
    expect(view.convs[G1].type).toBe("group");
    expect("social" in view.convs[G1]).toBe(false);
  });

  it("keeps the thinking of my own Agent's reply there, as a group does, and none of anyone else's", () => {
    const messages = [wire(S1, 1, AG1, "你好", { reasoning: "想了想", via: undefined }), wire(S1, 2, ANN, "嗨", { reasoning: "不该有" })];
    const shown = viewOf([social()], messages).convs[S1].messages;
    expect(shown.map((m) => m.reasoning)).toEqual(["想了想", null]);
  });

  it("shows the Agent's reply in progress, as a group member sees it", () => {
    const view = viewOf([social()], [], (s) => ({ ...s, groupRuns: { [S1]: { [AG1]: { state: "replying" } } } }));
    expect(view.convs[S1].agentRuns).toEqual([{ agentId: AG1, mine: false, kind: "replying" }]);
  });

  it("a conversation of another type has no social key, and the model keeps it only for this type", () => {
    const state = M.applySync(M.initial(), syncOf([social(), group(G1)], [], PRINCIPALS));
    expect(state.conversations[S1].social).toEqual({ participants: [AG1, ANN], agents: [{ id: AG1, ownerId: ME_ID }] });
    expect("social" in state.conversations[G1]).toBe(false);
  });
});
