// Agent social, the lists and the reads behind the social chat (plan A12a): a conversation I only watch as my Agent's owner is out of the main
// list, the unread filter and the total (it is in the Agent's 「别人」 tab); a visitor's own are ordinary rows; the disclosure, the supervision
// line and the 主人 label come from the membership roles alone; the composer's reason is said by the service's code.
import { describe, expect, it } from "vitest";
import * as M from "../src/data/model.js";
import { ME } from "../src/data/identities.js";
import { toView } from "../src/data/viewmodel.js";
import { convSubtitle, convTitle, listedConvs, publishBlock, unreadTotal } from "../src/state/selectors.js";
import { disclosureOf, haveAgentAccess, isObserved, supervisionText, supervisorLabel } from "../src/state/social.js";
import { ANN, AG1, BO, ME_ID, PRINCIPALS, agentPrincipal, group, syncOf, wire } from "./fixtures.js";

const AGB = "00000000-0000-4000-8000-0000000000b2"; // an Agent of BO's
const sid = (n) => `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`;

/** A conversation I watch: my Agent AG1 with the visitor ANN. */
const watched = (n, fields = {}) => ({
  id: sid(n),
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
  lastSeq: 3,
  readSeq: 0,
  unread: 3,
  ...fields,
});
/** A conversation I speak in: BO's Agent AGB, watched by BO. */
const visiting = (n, fields = {}) => ({
  id: sid(n),
  type: "agent_social",
  title: null,
  myRole: "speaker",
  closed: false,
  canSend: { ok: true },
  social: { participants: [ME_ID, AGB], agents: [{ id: AGB, ownerId: BO }] },
  members: [
    { id: ME_ID, role: "speaker", isCreator: false },
    { id: AGB, role: "speaker", isCreator: false },
    { id: BO, role: "observer", isCreator: false },
  ],
  lastSeq: 2,
  readSeq: 0,
  unread: 2,
  ...fields,
});

const PEOPLE = [...PRINCIPALS, { ...agentPrincipal(AG1), ownerId: ME_ID }, { ...agentPrincipal(AGB), ownerId: BO, displayName: "小帮手", handle: "bo.helper" }];
function view(conversations, messages = [], social = { enabled: true }) {
  const sync = { ...syncOf(conversations, messages, PEOPLE), social };
  return { ...toView(M.applySync(M.initial(), sync)), agentContacts: null };
}

describe("the main list and the unread total", () => {
  it("a conversation I watch is out of the list and the total, even with 3 unread; one I speak in is an ordinary row", () => {
    const state = view([watched(1), visiting(2), group("00000000-0000-4000-8000-0000000000c1")]);
    expect(isObserved(state.convs[sid(1)])).toBe(true);
    expect(listedConvs(state).map((c) => c.id)).toEqual(expect.not.arrayContaining([sid(1)]));
    expect(listedConvs(state).map((c) => c.id)).toContain(sid(2));
    expect(unreadTotal(state)).toBe(2 + (state.convs["00000000-0000-4000-8000-0000000000c1"].unread || 0));
  });

  it("105 conversations I watch stay out of the list and the total, and the ordinary ones are all in it", () => {
    const watching = Array.from({ length: 105 }, (_, i) => watched(10 + i, { unread: 7 }));
    const mine = Array.from({ length: 12 }, (_, i) => visiting(200 + i, { unread: 1 }));
    const state = view([...watching, ...mine]);
    expect(Object.keys(state.convs)).toHaveLength(117);
    expect(listedConvs(state)).toHaveLength(12);
    expect(listedConvs(state).every((c) => !isObserved(c))).toBe(true);
    expect(unreadTotal(state)).toBe(12);
  });
});

describe("the names, the disclosure, the supervision line and the 主人 label", () => {
  it("a visitor reads the disclosure with the owner's name; the title is the Agent's", () => {
    const state = view([visiting(1)]);
    const conv = state.convs[sid(1)];
    expect(convTitle(state, conv)).toBe("小帮手");
    expect(convSubtitle(state, conv)).toBe("Agent 对话");
    expect(disclosureOf(state, conv)).toBe("这是阿波的 Agent。阿波能看到你们的对话，也可能插话。");
  });

  it("the owner who watches reads the supervision line, never the disclosure", () => {
    const state = view([watched(1)]);
    const conv = state.convs[sid(1)];
    expect(supervisionText(state, conv)).toBe("你在旁观小助手和小安的对话。你发言时，对方会看到你是主人。");
    expect(convTitle(state, conv)).toBe("小助手和小安");
    expect(disclosureOf(state, conv)).toBe("");
  });

  it("two owners: the disclosure joins their names with 、, and each is labelled 「{A}的主人」", () => {
    const two = {
      ...visiting(1),
      myRole: "speaker",
      social: { participants: [ME_ID, AGB], agents: [{ id: AG1, ownerId: ANN }, { id: AGB, ownerId: BO }] },
      members: [
        { id: ME_ID, role: "speaker", isCreator: false },
        { id: AGB, role: "speaker", isCreator: false },
        { id: ANN, role: "observer", isCreator: false },
        { id: BO, role: "observer", isCreator: false },
      ],
    };
    const state = view([two]);
    const conv = state.convs[sid(1)];
    expect(disclosureOf(state, conv)).toBe("这是小安、阿波的 Agent。小安、阿波能看到你们的对话，也可能插话。");
    expect(supervisorLabel(state, conv, BO)).toBe("小帮手的主人");
    expect(supervisorLabel(state, conv, ANN)).toBe("小助手的主人");
    expect(supervisorLabel(state, conv, ME)).toBeNull();
  });

  it("only the membership role makes 主人: a speaker named 「主人」 gets none, the observer does, whatever either is called", () => {
    const named = [...PEOPLE.filter((p) => p.id !== ANN), { ...PRINCIPALS.find((p) => p.id === ANN), displayName: "主人" }];
    const sync = { ...syncOf([watched(1)], [wire(sid(1), 1, ANN, "你好"), wire(sid(1), 2, ME_ID, "我在")], named), social: { enabled: true } };
    const state = toView(M.applySync(M.initial(), sync));
    const conv = state.convs[sid(1)];
    expect(supervisorLabel(state, conv, ANN)).toBeNull();
    expect(supervisorLabel(state, conv, ME)).toBe("主人");
    expect(supervisorLabel(state, conv, AG1)).toBeNull();
  });
});

describe("the composer's reason, by the service's code", () => {
  const blockOf = (reason, conv = visiting(1)) => {
    const state = view([{ ...conv, canSend: { ok: false, reason } }]);
    return publishBlock(state, state.convs[conv.id])?.text;
  };
  it("says the reason once for each code, and nothing when sending is allowed", () => {
    expect(blockOf("no_access")).toBe("你已不能再和它聊天。");
    expect(blockOf("agent_unavailable")).toBe("这个 Agent 现在不可用。");
    // (A block of someone else's, or none I can see: the same sentence as a stop. My own block of the Agent says what to do.)
    expect(blockOf("blocked")).toBe("你已不能再和它聊天。");
    expect(blockOf("agent_deleted")).toBe("这个 Agent 已删除，聊天记录仍可查看。");
    expect(blockOf("no_access", watched(2))).toBe("这段对话已结束，不能再发送消息。");
    expect(blockOf("blocked", watched(2))).toBe("这段对话已结束，不能再发送消息。");
    const open = view([visiting(1)]);
    expect(publishBlock(open, open.convs[sid(1)])).toBeNull();
  });
  it("my own block of the Agent says so and what ends it", () => {
    const state = { ...view([{ ...visiting(1), canSend: { ok: false, reason: "blocked" } }]), blocks: [{ by: ME, target: AGB }] };
    expect(publishBlock(state, state.convs[sid(1)]).text).toBe("你拉黑了它。解除拉黑后才能再聊。");
  });
  it("never names whose stop or block it was: the same sentence whatever ended it", () => {
    const state = view([visiting(1, { canSend: { ok: false, reason: "no_access" } })]);
    const text = publishBlock(state, state.convs[sid(1)]).text;
    expect(text).not.toMatch(/停止|拉黑|对方/);
  });
});

describe("whether we have Agent access between us", () => {
  it("a social conversation with the person (or their Agent), or a request of theirs that waits, counts; a stranger and the switch off do not", () => {
    const state = view([visiting(1), watched(2)]);
    expect(haveAgentAccess(state, BO)).toBe(true);
    expect(haveAgentAccess(state, ANN)).toBe(true);
    expect(haveAgentAccess(state, "00000000-0000-4000-8000-0000000000ff")).toBe(false);
    const waiting = { ...view([]), agentContacts: { mine: [], waiting: [{ agentId: AG1, subject: { id: BO, displayName: "阿波", handle: "bo", kind: "human" }, since: "x", until: "y" }] } };
    expect(haveAgentAccess(waiting, BO)).toBe(true);
    expect(haveAgentAccess(view([visiting(1)], [], { enabled: false }), BO)).toBe(false);
  });
});
