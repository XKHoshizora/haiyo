import { describe, expect, it } from "vitest";
import * as M from "../src/data/model.js";
import { ANN, BO, D1, G1, ME_ID, direct, group, notice, range, syncOf, wire } from "./fixtures.js";

const seqs = (state, id) => (state.messages[id] || []).map((m) => m.seq);

function loaded() {
  return M.applySync(
    M.initial(),
    syncOf(
      [direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2, peerReadSeq: 2 }), group(G1, { lastSeq: 5, readSeq: 5 })],
      [...range(D1, 1, 3), ...range(G1, 4, 5, [BO])],
    ),
  );
}

describe("applySync", () => {
  it("loads conversations at their lastSeq, messages ascending by seq, and principals", () => {
    const s = loaded();
    expect(s.synced).toBe(true);
    expect(s.me.id).toBe(ME_ID);
    expect(s.conversations[D1]).toMatchObject({ type: "direct", position: 3, lastSeq: 3, readSeq: 1, unread: 2, peerReadSeq: 2, creatorId: null, peerId: ANN });
    expect(s.conversations[G1]).toMatchObject({ type: "group", position: 5, creatorId: ME_ID, peerId: null });
    expect(seqs(s, D1)).toEqual([1, 2, 3]);
    expect(seqs(s, G1)).toEqual([4, 5]);
    expect(Object.keys(s.principals).sort()).toEqual([ME_ID, ANN, BO].sort());
  });

  it("ignores a creatorId on a direct chat and tolerates a missing createdAt", () => {
    const s = M.applySync(M.initial(), syncOf([direct(D1, ANN, { creatorId: ANN, createdAt: "2026-11-16T01:00:00.000Z" }), group(G1)]));
    expect(s.conversations[D1].creatorId).toBeNull();
    expect(s.conversations[D1].createdAt).toBe("2026-11-16T01:00:00.000Z");
    expect(s.conversations[G1].createdAt).toBeNull();
  });

  it("keeps a group's avatar version, and nothing of it for a group without one, a direct chat or a bad number", () => {
    const s = M.applySync(
      M.initial(),
      syncOf([direct(D1, ANN, { avatarVersion: 4 }), group(G1, { avatarVersion: 7 }), group("00000000-0000-4000-8000-0000000000c4", { avatarVersion: -1 }), group("00000000-0000-4000-8000-0000000000c5")]),
    );
    expect(s.conversations[G1].avatarVersion).toBe(7);
    expect(s.conversations[D1].avatarVersion).toBeNull();
    expect(s.conversations["00000000-0000-4000-8000-0000000000c4"].avatarVersion).toBeNull();
    expect(s.conversations["00000000-0000-4000-8000-0000000000c5"].avatarVersion).toBeNull();
  });

  it("knows whether older history may exist from the size of the window", () => {
    const full = M.applySync(M.initial(), syncOf([direct(D1, ANN, { lastSeq: 40 })], range(D1, 11, 40)));
    expect(full.conversations[D1].hasOlder).toBe(true);
    const short = M.applySync(M.initial(), syncOf([direct(D1, ANN, { lastSeq: 40 })], range(D1, 31, 40)));
    expect(short.conversations[D1].hasOlder).toBe(false);
  });

  it("on a later sync merges a contiguous window and takes read markers and unread from the server", () => {
    let s = loaded();
    s = M.applyMessage(s, wire(D1, 4, ANN)).state;
    const again = M.applySync(s, syncOf([direct(D1, ANN, { lastSeq: 6, readSeq: 6, unread: 0, peerReadSeq: 5 })], range(D1, 1, 6)));
    expect(seqs(again, D1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(again.conversations[D1]).toMatchObject({ position: 6, readSeq: 6, unread: 0, peerReadSeq: 5 });
    expect(again.conversations[G1]).toBeUndefined();
    expect(again.messages[G1]).toBeUndefined();
  });

  it("keeps a conversation's messages in seq order by number whatever their digits (F6): older pages across 100 and 10, pushes after them", () => {
    let s = M.applySync(M.initial(), syncOf([direct(D1, ANN, { lastSeq: 105 })], range(D1, 101, 105)));
    s = M.applyOlder(s, D1, { messages: range(D1, 95, 100), nextBefore: 95 });
    s = M.applyOlder(s, D1, { messages: range(D1, 8, 94), nextBefore: 8 });
    s = M.applyOlder(s, D1, { messages: range(D1, 1, 7), nextBefore: null });
    s = M.applyMessage(s, wire(D1, 106, ANN)).state;
    expect(seqs(s, D1)).toEqual(Array.from({ length: 106 }, (_, i) => i + 1));
    expect(s.conversations[D1]).toMatchObject({ hasOlder: false });
  });

  it("replaces held messages when the new window does not join up with them (no hole is kept)", () => {
    let s = M.applySync(M.initial(), syncOf([direct(D1, ANN, { lastSeq: 3 })], range(D1, 1, 3)));
    s = M.applySync(s, syncOf([direct(D1, ANN, { lastSeq: 100 })], range(D1, 71, 100)));
    expect(seqs(s, D1)).toEqual(range(D1, 71, 100).map((m) => m.seq));
    expect(s.conversations[D1]).toMatchObject({ position: 100, hasOlder: true });
  });

  it("drops drafts and unsent messages that belong to another account", () => {
    let s = loaded();
    s = M.setDraft(s, D1, "half a sentence");
    s = M.markSending(s, { clientTxn: "t1", conversationId: D1, text: "hi", at: 0 });
    s = M.resetKeepingDrafts(s);
    const same = M.applySync(s, syncOf([direct(D1, ANN)]));
    expect(same.drafts[D1]).toBe("half a sentence");
    expect(same.pending.t1.status).toBe("failed");
    const other = M.applySync(s, { ...syncOf([direct(D1, ANN)]), me: { id: BO, handle: "bo", displayName: "阿波", email: "b@x.test" } });
    expect(other.drafts).toEqual({});
    expect(other.pending).toEqual({});
  });

});


describe("applyMessage: the seq rule", () => {
  it("ignores seq <= position", () => {
    const s = loaded();
    const r = M.applyMessage(s, wire(D1, 3, ANN, "again"));
    expect(r.state).toBe(s);
    expect(r.gap).toBeUndefined();
  });

  it("appends seq = position + 1, advances and counts it unread when it is from someone else", () => {
    const s = loaded();
    const r = M.applyMessage(s, wire(D1, 4, ANN));
    expect(seqs(r.state, D1)).toEqual([1, 2, 3, 4]);
    expect(r.state.conversations[D1]).toMatchObject({ position: 4, lastSeq: 4, unread: 3 });
    const mine = M.applyMessage(r.state, wire(D1, 5, ME_ID));
    expect(mine.state.conversations[D1].unread).toBe(3);
    const sys = M.applyMessage(mine.state, notice(D1, 6, "通知", { event: "unblocked", actorId: ANN, principalId: ME_ID }));
    expect(sys.state.conversations[D1]).toMatchObject({ position: 6, unread: 3 });
  });

  it("a message pushed again with the refusal the service sent is applied, whoever sent it — also one whose sender this client knows nothing of yet (T2 fix 2, R5)", () => {
    const STRANGER = "00000000-0000-4000-8000-0000000000e9";
    let s = M.applySync(M.initial(), syncOf([group(G1, { lastSeq: 5, readSeq: 5 })], range(G1, 4, 5, [BO])));
    s = M.applyMessage(s, wire(G1, 6, STRANGER, "@annbot 帮人问一下")).state;
    expect(s.principals[STRANGER]).toBeUndefined();
    const refused = [{ agentId: ANN, reason: "others_limit" }];
    s = M.applyMessage(s, wire(G1, 6, STRANGER, "@annbot 帮人问一下", { refused })).state;
    expect(s.messages[G1].find((m) => m.seq === 6).refused).toEqual(refused);
  });

  it("reports a gap for seq > position + 1 and does not append out of order", () => {

    const s = loaded();
    const r = M.applyMessage(s, wire(D1, 6, ANN));
    expect(r.gap).toEqual({ conversationId: D1, from: 3 });
    expect(r.state).toBe(s);
  });

  it("reports a message for an unknown conversation", () => {
    const s = loaded();
    const r = M.applyMessage(s, wire("00000000-0000-4000-8000-0000000000ff", 1, ANN));
    expect(r.unknown).toBe("00000000-0000-4000-8000-0000000000ff");
    expect(r.state).toBe(s);
  });
});

describe("applyCatchup and applyGone", () => {
  it("appends each conversation's continuation and drops the gone ones", () => {
    const s = loaded();
    const r = M.applyCatchup(s, { messages: [wire(D1, 4, ANN), wire(D1, 5, ANN)], gone: [G1], more: false });
    expect(seqs(r.state, D1)).toEqual([1, 2, 3, 4, 5]);
    expect(r.state.conversations[D1].position).toBe(5);
    expect(r.state.conversations[G1]).toBeUndefined();
  });

  it("a continuation that starts later (removed and added again while away) drops the earlier stay", () => {
    const s = loaded();
    const r = M.applyCatchup(s, { messages: [notice(G1, 9, "某人邀请Mei加入了群聊", { event: "member_joined", actorId: ANN, principalId: ME_ID }), wire(G1, 10, ANN)], gone: [], more: false });
    expect(seqs(r.state, G1)).toEqual([9, 10]);
    expect(r.state.conversations[G1]).toMatchObject({ position: 10, hasOlder: false });
  });

  it("a continuation that starts in a later stay settles the earlier stay's reads and sends", () => {
    let s = M.markReading(loaded(), D1, 3);
    s = M.markSending(s, { clientTxn: "t1", conversationId: D1, text: "hi", at: 0 });
    s = M.markSending(s, { clientTxn: "t2", conversationId: D1, text: "ho", at: 1 });
    s = M.markFailed(s, "t2", { code: "network_error", reason: null });
    s = M.markSending(s, { clientTxn: "t3", conversationId: G1, text: "elsewhere", at: 2 });
    s = M.applyCatchup(s, { messages: [notice(D1, 9, "小安邀请Mei加入了群聊", { event: "member_joined", actorId: ANN, principalId: ME_ID }), wire(D1, 10, ANN)], gone: [], more: false }).state;
    expect(s.conversations[D1]).toMatchObject({ readsInFlight: 0, readSeq: 1, serverReadSeq: 1, position: 10 });
    expect(s.pending.t1).toMatchObject({ clientTxn: "t1", status: "failed", error: { code: "stale" } });
    expect(s.pending.t2).toMatchObject({ status: "failed", error: { code: "network_error" } });
    expect(s.pending.t3.status).toBe("sending");
    const synced = M.applySync(s, syncOf([direct(D1, ANN, { lastSeq: 10, readSeq: 1, unread: 1 })], [wire(D1, 10, ANN)]));
    expect(synced.conversations[D1]).toMatchObject({ readSeq: 1, unread: 1, readsInFlight: 0 });
  });

  it("a window shorter than SYNC_WINDOW is all that is visible: it replaces what is held", () => {
    let s = loaded();
    s = M.applySync(s, syncOf([group(G1, { lastSeq: 12 })], range(G1, 11, 12)));
    expect(seqs(s, G1)).toEqual([11, 12]);
    expect(s.conversations[G1]).toMatchObject({ position: 12, hasOlder: false });
  });

  it("gone removes the conversation, its messages, unsent messages and draft; repeating it changes nothing", () => {
    let s = loaded();
    s = M.markSending(s, { clientTxn: "t1", conversationId: G1, text: "x", at: 0 });
    s = M.setDraft(s, G1, "draft");
    const once = M.applyGone(s, G1);
    expect(once.conversations[G1]).toBeUndefined();
    expect(once.messages[G1]).toBeUndefined();
    expect(once.pending.t1).toBeUndefined();
    expect(once.drafts[G1]).toBeUndefined();
    expect(M.applyGone(once, G1)).toBe(once);
  });
});

describe("optimistic sends", () => {
  it("marks sending, then sent: the pending entry becomes the server message", () => {
    let s = M.markSending(loaded(), { clientTxn: "t1", conversationId: D1, text: "hi", at: 1000 });
    expect(s.pending.t1).toMatchObject({ status: "sending", conversationId: D1, text: "hi", afterSeq: 3 });
    s = M.markSent(s, "t1", wire(D1, 4, ME_ID, "hi"));
    expect(s.pending.t1).toBeUndefined();
    expect(seqs(s, D1)).toEqual([1, 2, 3, 4]);
    expect(s.messages[D1][3].clientTxn).toBe("t1");
    expect(s.conversations[D1].position).toBe(4);
    // the push of the same message that arrives afterwards is a duplicate
    expect(M.applyMessage(s, wire(D1, 4, ME_ID, "hi")).state).toBe(s);
  });

  it("no duplicate when the push arrives before the HTTP response", () => {
    let s = M.markSending(loaded(), { clientTxn: "t1", conversationId: D1, text: "hi", at: 1000 });
    s = M.applyMessage(s, wire(D1, 4, ME_ID, "hi")).state;
    s = M.markSent(s, "t1", wire(D1, 4, ME_ID, "hi"));
    expect(seqs(s, D1)).toEqual([1, 2, 3, 4]);
    expect(s.pending).toEqual({});
    expect(s.messages[D1][3].clientTxn).toBe("t1");
  });

  it("a refusal pushed before the send's answer is kept when the answer arrives: lines are merged by Agent, never taken away", () => {
    const AG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
    const AG_B = "aaaaaaaa-0000-4000-8000-00000000000b";
    let s = M.markSending(loaded(), { clientTxn: "t1", conversationId: D1, text: "hi", at: 1000 });
    // The message is pushed to me again with a refusal found as a reply was admitted, before the send's (older) answer comes back.
    s = M.applyMessage(s, wire(D1, 4, ME_ID, "hi")).state;
    s = M.applyMessage(s, wire(D1, 4, ME_ID, "hi", { refused: [{ agentId: AG_A, reason: "others_limit" }] })).state;
    expect(s.messages[D1][3].refused).toEqual([{ agentId: AG_A, reason: "others_limit" }]);
    s = M.markSent(s, "t1", wire(D1, 4, ME_ID, "hi"));
    expect(s.messages[D1][3].refused).toEqual([{ agentId: AG_A, reason: "others_limit" }]);
    expect(s.messages[D1][3].clientTxn).toBe("t1");
    // An answer naming another Agent adds to what is held; one naming the same keeps one line for it.
    s = M.markSent(s, "t1", wire(D1, 4, ME_ID, "hi", { refused: [{ agentId: AG_B, reason: "too_often" }, { agentId: AG_A, reason: "others_limit" }] }));
    expect(s.messages[D1][3].refused).toEqual([
      { agentId: AG_A, reason: "others_limit" },
      { agentId: AG_B, reason: "too_often" },
    ]);
  });

  it("a sent message beyond a gap is held without advancing the position; catch-up then fills in once", () => {
    let s = M.markSending(loaded(), { clientTxn: "t1", conversationId: D1, text: "hi", at: 1000 });
    s = M.markSent(s, "t1", wire(D1, 6, ME_ID, "hi"));
    expect(s.conversations[D1].position).toBe(3);
    expect(seqs(s, D1)).toEqual([1, 2, 3, 6]);
    s = M.applyCatchup(s, { messages: [wire(D1, 4, ANN), wire(D1, 5, ANN), wire(D1, 6, ME_ID, "hi")], gone: [], more: false }).state;
    expect(seqs(s, D1)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(s.conversations[D1].position).toBe(6);
    expect(s.messages[D1][5].clientTxn).toBe("t1");
  });

  it("marks failed with the error and keeps the clientTxn; sending again keeps it too", () => {
    let s = M.markSending(loaded(), { clientTxn: "t1", conversationId: D1, text: "hi", at: 1000 });
    s = M.markFailed(s, "t1", { code: "network_error", reason: null });
    expect(s.pending.t1).toMatchObject({ clientTxn: "t1", status: "failed", error: { code: "network_error", reason: null } });
    s = M.markSending(s, { clientTxn: "t1", conversationId: D1, text: "hi", at: 5000 });
    expect(s.pending.t1).toMatchObject({ clientTxn: "t1", status: "sending", error: null, afterSeq: 3, at: 1000 });
  });

  it("setCanSend records the service's refusal", () => {
    const s = M.setCanSend(loaded(), D1, { ok: false, reason: "blocked" });
    expect(s.conversations[D1].canSend).toEqual({ ok: false, reason: "blocked" });
  });
});

describe("read markers", () => {
  it("setRead only moves forward and recomputes unread", () => {
    let s = loaded();
    s = M.setRead(s, D1, 2);
    expect(s.conversations[D1]).toMatchObject({ readSeq: 2, unread: 1 });
    expect(M.setRead(s, D1, 1)).toBe(s);
    s = M.setRead(s, D1, 3);
    expect(s.conversations[D1]).toMatchObject({ readSeq: 3, unread: 0 });
  });

  it("a read in flight shows at once; if it fails the marker goes back to what the service confirmed", () => {
    let s = M.markReading(loaded(), D1, 3);
    expect(s.conversations[D1]).toMatchObject({ readSeq: 3, unread: 0, readsInFlight: 1 });
    s = M.markReadDone(s, D1, null);
    expect(s.conversations[D1]).toMatchObject({ readSeq: 1, serverReadSeq: 1, unread: 2, readsInFlight: 0 });
  });

  it("a confirmed answer moves the service's marker; a later failure goes back only that far", () => {
    let s = M.markReading(loaded(), D1, 2);
    s = M.markReading(s, D1, 3);
    s = M.markReadDone(s, D1, 2);
    expect(s.conversations[D1]).toMatchObject({ readSeq: 3, serverReadSeq: 2, readsInFlight: 1 });
    s = M.markReadDone(s, D1, null);
    expect(s.conversations[D1]).toMatchObject({ readSeq: 2, serverReadSeq: 2, unread: 1, readsInFlight: 0 });
  });

  it("a sync keeps a local read marker only while its request is in flight", () => {
    const server = syncOf([direct(D1, ANN, { lastSeq: 3, readSeq: 1, unread: 2 })], range(D1, 1, 3));
    const reading = M.markReading(loaded(), D1, 3);
    expect(M.applySync(reading, server).conversations[D1]).toMatchObject({ readSeq: 3, unread: 0, serverReadSeq: 1, readsInFlight: 1 });
    const failed = M.markReadDone(reading, D1, null);
    expect(M.applySync(failed, server).conversations[D1]).toMatchObject({ readSeq: 1, unread: 2 });
  });

  it("setPeerRead is max(current, seq)", () => {
    let s = M.setPeerRead(loaded(), D1, 3);
    expect(s.conversations[D1].peerReadSeq).toBe(3);
    expect(M.setPeerRead(s, D1, 1)).toBe(s);
  });
});

describe("other updates", () => {
  it("applyOlder prepends a page and records whether more is left", () => {
    let s = M.applySync(M.initial(), syncOf([direct(D1, ANN, { lastSeq: 40 })], range(D1, 11, 40)));
    s = M.applyOlder(s, D1, { messages: range(D1, 1, 10), nextBefore: null });
    expect(seqs(s, D1)).toEqual(range(D1, 1, 40).map((m) => m.seq));
    expect(s.conversations[D1].hasOlder).toBe(false);
  });

  it("applyOlder adds the principals the page names (a map by id), so a sender who left is known", () => {
    const GONE = "00000000-0000-4000-8000-0000000000a9";
    let s = M.applySync(M.initial(), syncOf([group(G1, { lastSeq: 40 })], range(G1, 11, 40)));
    const departed = { id: GONE, handle: "gone", displayName: "走了的人", kind: "human" };
    s = M.applyOlder(s, G1, { messages: [wire(G1, 10, GONE)], nextBefore: 10, principals: { [GONE]: departed } });
    expect(s.principals[GONE]).toEqual(departed);
    expect(s.principals[ANN]).toMatchObject({ displayName: "小安" });
    // absent or malformed: nothing changes
    const before = s.principals;
    expect(M.applyOlder(s, G1, { messages: [], nextBefore: null }).principals).toBe(before);
    expect(M.applyPrincipals(s, { x: { id: 7 } }).principals).toBe(before);
    expect(M.applyPrincipals(s, [departed]).principals[GONE]).toEqual(departed);
  });

  it("applyConversation refreshes metadata but keeps position and unread", () => {
    let s = loaded();
    s = M.applyConversation(s, group(G1, { title: "新名字", lastSeq: 9, unread: 7, members: [{ id: ME_ID, role: "speaker", isCreator: false }, { id: ANN, role: "speaker", isCreator: true }], creatorId: ANN }));
    expect(s.conversations[G1]).toMatchObject({ title: "新名字", creatorId: ANN, position: 5, unread: 0, lastSeq: 9 });
    expect(s.conversations[G1].members.map((m) => m.id)).toEqual([ME_ID, ANN]);
  });

  it("resetKeepingDrafts clears everything from the server and keeps drafts and unsent messages", () => {
    let s = loaded();
    s = M.setDraft(s, D1, "draft");
    s = M.markSending(s, { clientTxn: "t1", conversationId: D1, text: "hi", at: 0 });
    s = M.applySocial(s, { friends: [], incoming: [], outgoing: [], blocked: [], blockedBy: [] });
    const r = M.resetKeepingDrafts(s);
    expect(r).toMatchObject({ me: null, synced: false, conversations: {}, messages: {}, principals: {}, social: null, owner: ME_ID });
    expect(r.drafts).toEqual({ [D1]: "draft" });
    expect(r.pending.t1.status).toBe("failed");
  });

  it("every departure starts a new stay: gone, dropped by a sync, or a continuation that starts later", () => {
    let s = loaded();
    expect(M.stayOf(s, G1)).toBe(0);
    s = M.applyGone(s, G1);
    expect(M.stayOf(s, G1)).toBe(1);
    expect(M.stayOf(M.applyGone(s, G1), G1)).toBe(1);
    s = M.applySync(s, syncOf([direct(D1, ANN, { lastSeq: 3 })], range(D1, 1, 3)));
    expect(M.stayOf(s, D1)).toBe(0);
    s = M.applySync(s, syncOf([]));
    expect(M.stayOf(s, D1)).toBe(1);
    const jumped = M.applyCatchup(loaded(), { messages: [notice(G1, 9, "某人邀请Mei加入了群聊", { event: "member_joined", actorId: ANN, principalId: ME_ID })], gone: [], more: false });
    expect(M.stayOf(jumped.state, G1)).toBe(1);
    expect(M.stayOf(M.applyCatchup(loaded(), { messages: [wire(G1, 6, ANN)], gone: [], more: false }).state, G1)).toBe(0);
  });

  it("positionsOf lists the held positions of the given conversations", () => {
    expect(M.positionsOf(loaded(), [D1, G1, "x"])).toEqual({ [D1]: 3, [G1]: 5 });
  });
});
