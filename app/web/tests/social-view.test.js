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

  it("keeps what my own Agent's reply could refer to of my notes (ring 1b), well formed only; never a group's, never someone else's Agent's — not even in the store", () => {
    const AGX = "00000000-0000-4000-8000-0000000000b7";
    const shownNotes = [{ kind: "owner", id: "n1", text: "爱吃辣" }, { kind: "self", id: "n2", text: null }, { kind: "hearsay", id: "n3", text: "x" }, { kind: "owner", text: "no id" }];
    const theirs = [{ kind: "owner", id: "n9", text: "别人的" }];
    const principals = [...PRINCIPALS, { ...agentPrincipal(AG1), ownerId: ME_ID }, { ...agentPrincipal(AGX, "other", "别人的 Agent"), ownerId: ANN }];
    const state = M.applySync(
      M.initial(),
      syncOf([social(), group(G1)], [wire(S1, 1, AG1, "他爱吃辣", { shownNotes }), wire(S1, 2, AGX, "嗨", { shownNotes: theirs }), wire(G1, 1, AG1, "群里", { shownNotes })], principals),
    );
    expect(state.messages[S1].find((m) => m.seq === 2)).not.toHaveProperty("shownNotes");
    const view = toView(state);
    expect(view.convs[S1].messages.map((m) => m.shownNotes)).toEqual([[{ kind: "owner", id: "n1", text: "爱吃辣" }, { kind: "self", id: "n2", text: null }], []]);
    expect(view.convs[G1].messages[0].shownNotes).toEqual([]);
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

describe("a blocked entry that is an Agent (`kind` on GET /api/social's blocked list)", () => {
  const BLOCKED_AGENT = { id: "00000000-0000-4000-8000-0000000000f1", handle: "kai.helper", displayName: "小帮手", avatarVersion: 0, kind: "agent" };
  const BLOCKED_PERSON = { id: ANN, handle: "ann", displayName: "小安", avatarVersion: 0 };
  const social = { friends: [], incoming: [], outgoing: [], blocked: [BLOCKED_PERSON, BLOCKED_AGENT], blockedBy: [] };

  it("is an Agent, listed under `agents` and never as a person; a person without `kind` stays a person; both are still blocks of mine", () => {
    const view = toView({ ...M.applySync(M.initial(), syncOf([], [], PRINCIPALS)), social });
    expect(view.agents[BLOCKED_AGENT.id]).toMatchObject({ kind: "agent", name: "小帮手", handle: "@kai.helper", mine: false });
    expect(view.people[BLOCKED_AGENT.id]).toBeUndefined();
    expect(view.people[ANN]).toMatchObject({ kind: "person", name: "小安" });
    expect(view.agents[ANN]).toBeUndefined();
    expect(view.blocks).toEqual([{ by: "me", target: ANN }, { by: "me", target: BLOCKED_AGENT.id }]);
  });
});

