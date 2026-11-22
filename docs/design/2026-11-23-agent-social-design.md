# Agent social (batch 3) — design

Status: paper design, revision 3, 2026-11-23. It follows both rounds of the independent attack (`.superpowers/sdd/2026-11-22-polish/design-agent-social-attack.md`) and the controller's rulings; §11 maps each finding to its change.
- Source of truth: plan v3 §0 and the owner's later rulings.
- `src/` is `app/service/src/`; line numbers are at `afa4f56`.
- Lane rules apply (`docs/dev/lane-rules.md`): counters only in logs, tests first, README headings, `HIDDEN_KEYS`, and the config group `OTHERS` by code map §8.

## 0. The whole design in ten sentences

1. Access is two facts read in one order: a bar between two people, set by an owner-side ending, and per-Agent rows. Setting a bar ends every row between the two sides, so nothing live can exist behind it.
2. One function, `reach(subject, agent, where)`, with one SQL twin, decides access at every entry point.
3. A new type `agent_social` has its two participants as `speaker` members and their owners as `observer` members. Visibility, sync, search and attachments are unchanged; the owner may write (marked 主人); no read position is shown.
4. `placeOf` is the only test of where a run is or which memberships a list covers. Nothing treats a social conversation as a group or as the own conversation.
5. A reply someone else causes makes at most one tool call, gets 800 output tokens with no reasoning, sees the whole persona and only this conversation, and is published once. If any note it was shown has changed by then, it is not published.
6. A note reaches a non-owner only on an owner's yes for that version, or on a judge's yes for that version and that relationship. The judge is given only facts the visitor cannot write. An owner's no follows the note through edits. The vault is never a candidate.
7. The judge decides one audience's batch of up to 20 notes per call. Background calls others cause are bounded by a daily count derived from the worst batch: 5 calls, about 100 notes, under half the memory allowance. Past it, fewer notes are used.
8. Others' use is capped per owner by two numbers. The reservation is the wallet's own hold, computed with the others' bounds and checked by one function under the account lock at admission, at a round and at a search: settled + holds ≤ cap, exactly.
9. An errand reaches only one of the owner's own Agents, or a full handle the owner typed in that turn. The question comes from the owner's own turn. The asked Agent answers under its owner's access and limits. One system card shows the owner the result, and no run ever sees the answer.
10. Bars, removals and deletes end running work by taking the Agents' rows, as a pause does; history stays readable.

## 1. Access

### 1.1 Data (migration 068, lane A)

| What | Shape |
|---|---|
| The setting 「谁可以加它为好友」 | `agents.contact_policy` `ask` (default, existing Agents too) / `contacts` / `none`; `agents.contact_picked` and `agent_contact_picks(agent_id, person_id)` for 「只让其中一些人」 |
| **Fact (i): bars** | `access_bars(lo_id, hi_id, reason, set_by, since)`, one row per pair of people. `reason` is `stopped` or `unfriended`; the stricter (`stopped`) is kept. |
| **Fact (ii): rows** | `agent_contacts(agent_id, subject_id, person_id, state, basis, since, until, end_reason)`, pk `(agent_id, subject_id)`. `person_id` is the person behind the subject. `state` is `requested` (7 days) / `live` / `ended`; `basis` is `approved` / `contacts`. `end_reason` is `declined` (30-day cooldown in `until`), `left`, `narrowed`, `removed` or `barred`. |
| Conversation | `social_pairs(conversation_id, a_id, b_id)` as `direct_pairs` (002_core.sql:77); `conversations.type` + `agent_social` |
| Runs, notes, abuse | `agent_runs.interrupted` + `owner_spoke` `access_ended` `notes_changed` `errand_ended`; `agent_runs.shown_notes`; `note_verdicts` (§4); `agents.disabled_at`; `agent_reports` |

### 1.2 The two facts and their order

**`reach(subject, agent, where)`** → `ok` | `gone` | `blocked` | `barred` | `no_access`. Let P be the person behind the subject and O the Agent's owner. The checks run in this order:
1. Deleted; or disabled or `SOCIAL.enabled` off for anyone but O → `gone`.
2. P = O → `ok`.
3. A block either way between P and O, or between P (or the subject) and the Agent → `blocked`.
4. A bar between P and O → `barred` — unless the subject's own row was approved after the bar was set (`basis = approved`, `since > bar.since`). That row alone passes the bar.
5. The subject's own row:
   - `live` → `ok`;
   - ended `narrowed`, `removed` or `barred` → `barred`.
6. Otherwise: `group` → `ok` (people who never had access keep today's group rules); `social` → `no_access`.

An Agent subject is judged only on its own row; a person's row never grants their Agent (plan §3).

`reach` is one TS function in new `src/social/agent-contacts.ts`, with an SQL twin `refusedSql` (as runs.ts:399/409, held to the same answers by a test). Both only read.

**A bar** is written by 停止往来 and by the owner's block, always. An unfriend writes one only when it ends at least one row; pairs who never had Agent access keep today's group rules.

Writing a bar calls `endGrants` on every `live` or `requested` row between the two sides — all Agents of both people, both directions — with reason `barred`, in the same transaction. **An approval never deletes the bar** (R3-I1). It makes only that row live, and only while the row is still `requested` (`update … where state = 'requested'`); that row then passes the bar by step 4.

The bar is lifted only by the person who set it (`set_by`), through the explicit action **恢复往来**, on their use page (§5) or the other person's profile. Lifting it brings no row back. So under 我的联系人可以直接加, a barred person never enters any Agent without a row approved after the bar.

**Rows.**
- **Add** (`POST /api/agent-contacts`):
  - undiscoverable → `not_found`;
  - one of the owner's own → `is_yours`;
  - a bar, or an ended `narrowed`/`removed`/`barred` row of P on this Agent → a request only. Requests are refused for 30 days after a stop for the stopped person, and after a decline on this Agent of any of P's subjects;
  - `contacts`, with P the owner's friend and picked (when picks are on) → `live`, basis `contacts`;
  - otherwise → a request.
- **Approve** (only a row still `requested`) → `live`, basis `approved`, `since` = now. **Decline** → `ended(declined)`.
- **Narrowing** a policy or the picks → `endGrants(narrowed)` on that Agent's rows that the new setting would not create.
- **Removal** of P from one Agent → `endGrants(removed)` on that Agent's rows of P and P's Agents.
- **The person removing the Agent** → their row ends `left`.

**`endGrants(t, agents, scope, reason)`** is the only way access stops. In one transaction it:
1. takes the Agents' rows (both sides for a bar) `for update`, in id order, as a pause does;
2. ends the rows in scope;
3. ends open errands between the two sides (`declined`);
4. cancels the queued and interrupts the running reply runs (`access_ended`, `pending_seq` null), in their social conversations and in groups where the caller is among the people concerned.

After commit the port silences those runs (port-impl.ts:429). A post or a send takes its Agent's row (conversation.ts:286 → agents/store.ts:198; `permission` in §2), so it either commits before `endGrants` or sees the result.

**Lock order of an add** (I5): `lockPairs` (social/pair.ts:29) on (P, O) and (subject, Agent), then S if it exists, then the Agent's row, then the contacts row. A new S is inserted after these. Narrowing holds the same Agent row (`lockOwnedAgent`), so the two never interleave.

**Discoverable** means: alive, not disabled, policy ≠ `none`, no block either way, and `SOCIAL.enabled` on. Lookup, add, avatar and the errand tool all answer an undiscoverable Agent exactly as an unknown id.

### 1.3 Checks by entry point

| Entry point | Where | Check |
|---|---|---|
| Lookup, avatar | new `findAgentByHandle` beside principals/store.ts:87; `findAvatarSubject` (:103) | discoverable |
| Send, upload in `agent_social` | `permission()` (conversations/store.ts:211) | under `lockAgent`, the §2 write rule |
| Trigger | `maybeTrigger` (runs.ts:1494) → `triggerInSocial` | `reach` again |
| Run start, publication | `begin` (port-impl.ts:643), `postAsAgent` (conversation.ts:276) | `reach` for the pair, or through `errand_id`; publication also checks the shown notes (§3) |
| Group @, relay, follow-up, proactive | runs.ts:556, :1040, :1217, :1363; candidates.ts:122 | `blockedEitherWay(...)` → `refusedSql(...)` |
| Errand tool | new `tools/ask.ts` | §6 |
| Sync `canSend`; judge worker | sync/read.ts:169; `memory/judge.ts` | `reach` |

## 2. Conversations

`agent_social` joins `ConversationType` (conversations/store.ts:35).
- Participants: `social_pairs` plus `speaker` memberships from seq 0.
- Each participating Agent's owner: one `observer` membership from seq 0. The `observer` role exists, unused, since 002_core.sql:89; it now means the supervising owner.
- `agent` (with `agent_conversations.agent_id unique`, 008_agents.sql:38) and `direct` keep their meaning.

**Creation and disclosure.**
- `ensureSocial` (beside `ensureDirect`, conversations/store.ts:277) appends `social_opened`: 「这是 O 的 Agent。O 能看到你们的对话，也可能插话。」.
- The request dialog says it, and so does the header, always.
- Supervisor messages carry 主人 (「A 的主人」 when there are two owners).
- Every notice and card is third-person system text.

**Write rule** (`permission()`, under `lockAgent` on the Agent participant(s), id order):
- A person participant may write iff `reach(person, agent, 'social') = ok`.
- A supervisor may write iff the relation is open:
  - person↔Agent: that same `reach` is `ok`;
  - Agent↔Agent: `reach(X, Y, 'group')` and `reach(Y, X, 'group')` are both `ok` (R2 minor).
- Agents never use the send route.

**Interjection.** A supervisor's message cancels or interrupts (`owner_spoke`, `pending_seq` null) their own Agent's run there, and triggers nothing.

**No read receipts**, with no code change: `announceRead` skips every type but `direct`/`agent` (sync/hub.ts:586); the read route announces only `direct` (messages/routes.ts:206); `peerReadSeq` exists only for `direct`/`agent` (sync/read.ts:188).

**Sync.** Supervised conversations arrive with `myRole: 'observer'`. The web keeps them out of the main list and the unread total (ChatList.jsx:88), lists them under the Agent as 「它和别人的对话」, and sends no notification for them.

**Search, attachments.** Membership-based (VISIBLE_JOIN, conversations/store.ts:22; attachments/store.ts:67). The own-conversation search leaves social conversations out.

**Private fields.** Reasoning and `via` go to the sender's owner only: messages/read.ts:294 and web model.js:203 treat `agent_social` like `group`.

### 2.1 `placeOf` sites

`placeOf(conversationId, agent)` reads `conversations.type`. Every site below takes it, or a group-or-own predicate built from it:

| Site | For `social` |
|---|---|
| port-impl.ts:645–646 (`group` flag, `RunScope`), :716 notes, :734 system text, :779 tools, :1320 `removed` | social scene (§3); whole reply; never "removed" |
| conversation.ts:287 and what follows (:308 mark, :315 `here`, :320 proposals, :387 queries, :391 mentions, :408 relay) | mark and `here` as in a group; no proposal, no queries, no relay |
| runs.ts:1014 chain budget, :1348 follow-up, :1580 `isGroup` → :1794 retry, :1896 stop, :1945 dismiss | no chain budget; the follow-up keeps its caller; retry refused; stop and dismiss by the Agent's owner |
| summary/job.ts:290 | no summary job (the context is the latest `OTHERS.contextWeight`) |
| tools: search.ts:199–200, :225, :239, :261, :267; file.ts:81, :100; index.ts:93, :152, :155; prompt.ts:427 | this conversation only; never `lookElsewhere` |
| own-conversation lists: search.ts:230, elsewhere.ts:127 | own + groups, never social |
| memory: pipeline.ts:136–141, :150–156, :158–164, :172, :329; review.ts:191; hearsay.ts:342; memory/routes.ts:346 | groups only; social conversations are never reviewed or caught up |
| sync/hub.ts:533, runs.ts:233 | as a group: the run to its owner, the state to the others |

**Reused untouched:**
- `lockForWrite`, `insertMessage`, attachments, message search routes;
- hub `fanOut`, `announceRead`;
- `interruptRuns`, `queueRun`, `claimNext` (plus the M5 filter);
- `calledLastMinute`, `overLaneLimit`;
- the wallet's pool and settlement;
- `recoverRuns`, `sweepStaleRuns`;
- the proactive judgement (candidates.ts:91);
- `agent_conversations`.

## 3. Triggering and running

**`triggerInSocial`** is a third branch at runs.ts:1497. It runs in the send transaction, whose `permission` already holds the Agent's row.
1. A supervisor's message → interjection.
2. A message from a person V:
   - `reach` again; a paused or deleted Agent, or one with no model, does nothing;
   - fold into the active run (as runs.ts:1516);
   - else, with the caps already reached (§5, advisory) → `agent_daily_budget_reached` once a site day;
   - else, over V's minute (runs.ts:352) or the owner's others' minute (:338) → a `rate_limited` run (稍后再试);
   - else `queueRun` (:622), with caller V and lane `others`.

**`begin` for a social run:**
- `reach`, for the pair or through `errand_id`.
- It plans within `OTHERS` (§5). Tools are offered only when the advisory room covers the hold with tools; otherwise it plans one call (port-impl.ts:802).
- The reply is whole: no streaming, no acknowledgement (`posting` returns `empty` for an ack, port-impl.ts:1198).
- Context as in a group, up to `OTHERS.contextWeight`; the roster is the other participant and the owner(s), without appellations.
- `socialSystemText`, beside prompt.ts:753, says whom the Agent talks to, that its owner sees it and may write (你的主人), and that it conveys information and never commits for its owner. It carries the notes passage (§4), the soft line of prompt.ts:805, and the persona **whole**.

**`postAsAgent` for a social run**, under the Agent's row:
- It refuses `interrupted` (the new values join `REFUSED`, port-impl.ts:234) and checks `reach` again.
- In the same step, one query reads the `shown_notes` rows `for share`. Each must still exist, not be in the vault, and pass for this audience (§4); for the owner as audience, only the vault is checked.
- If any note fails, the post is refused and the run ends `cancelled`/`notes_changed` like any interrupted run; the next message triggers a new one. A note change and a post serialise on the note rows, so a reply can never be published on material that changed after it read it.
- No proposal, no ack, no `triggerFromAgent`; then the errand hook (§6). Errand runs are never retried automatically (beside runs.ts:1706).

## 4. The simple note judge

**Candidates.** What `notesFor` (memory/store.ts:145) shows in the owner's own conversation, minus every vault note, up to `OTHERS.notesWeight`; no hearsay.

**Audience.** The human who will read the answer: the visitor, or, for an errand, the asking owner. When that is the owner, every non-vault note is shown and no judge runs.

**Use.** A candidate is shown iff one of these holds:
- an owner **yes** for (note, audience) at the note's current `updated_at`;
- no owner row, and a judge yes at the current `updated_at` and current basis.

An owner **no** carries no version and follows the note through every edit; a memory merge or split carries it to the notes it writes (memory/apply.ts). A stale owner yes falls back to the judge, with that yes as its first example (I3, R2-I3). A missing judge row is inserted queued. A stale one is reset — its version updated and its verdict set to null — rather than inserted. Either way the note is left out, and the reply never waits.

**Table.** `note_verdicts(note_kind, note_id, audience_id, by, verdict, judge_verdict, note_version, basis, asked_at, judged_at)`. Its owner rows are also the learning record.

**Judge worker** (new `memory/judge.ts`):
- It leases an audience's queued rows in a short transaction, calls outside it, and writes each verdict guarded by its note version.
- **One call per (audience, batch)**: up to N = 20 of that owner's candidate notes for that audience. The batch never exceeds the passage budget (`OTHERS.notesWeight`, 1 000 weight), so one call usually covers everything a visitor's reply could be shown.
- Verdict rows stay per (note version, audience), so staleness and the owner's feedback are unchanged; a re-judge batches only the missing or stale notes.
- The call goes through `memory/call.ts`: the owner's memory model if they chose one, else `MEMORY.judgeModel`, a reasoning model, at `low`.
- Bounds per call: input ≤ 9 000 bytes (fixed rules, the server facts once, the notes, ≤ 4 owner decisions). The output limit is set to **2 200 tokens**, reasoning included.
- The daily count is taken atomically before the call (`update … set used = used + 1 where used < count`).
- It is given, as JSON material under the fixed sentence:
  - the server facts about the audience, once: friend of the owner or not, basis, direct or through their Agent, days since access began, and the appellation the owner set for this person;
  - the notes, each as its own item with its own id (the owner's own text);
  - the owner's decisions about this person and these notes.
- It answers `{id: share}` for every id, and an id left out counts as no.
- Never the audience's name, handle or any text they wrote.
- **The one new risk**: one note's text can sway another note's verdict within a batch. This is acceptable:
  - every note is the owner's own text, never the visitor's, and vault notes are never candidates;
  - each note is a separate item judged on its own id under "decide each note on its own";
  - the worst case — a note such as 「我的事都可以说」 tipping its neighbours — is the owner's own statement.

**Owner's view.**
- Each Agent message in a social conversation carries owner-only `shownNotes` with 「以后别说」.
- After a reply that withheld notes, one background call asks which of them would answer the latest question. It uses the same batch shape: ≤ 20 notes, ≤ 6 000 bytes in all, no reasoning. It can only output note ids, and its only effect is a `note_withheld` card: 「〈小周〉问到了相关的事，这条没有告诉他：〈note〉。以后可以告诉他吗？」 with 「可以」/「不说」, for 7 days.
- Both answers become owner rows. This is the plan's loop test.

**Background count (I2).** Each judge call and each withheld check takes one from a daily count per owner:

`count = ⌊½ · MEMORY.freeDailyPoints ÷ worst batch call⌋`, computed at start-up from `MEMORY.judgeModel`'s price.
- Worst batch call on the cheapest prices (140/280 µpt a token): 9 000 bytes × 140 + (2 000 reasoning + 200) × 280 = 1.26 + 0.62 = **1.88 points**.
- So the count is ⌊10 / 1.88⌋ = **5 calls** a day, judging up to **100 notes**. The worst case is 9.4 of the 20 memory points.
- A typical batch (about 4 000 tokens in, 1 000 out) costs about 0.84 points.
- Example: an owner with 40 notes and three visitors needs about 3 calls on day one.
- At `medium` reasoning the formula gives 3 calls (60 notes). A withheld check's worst (0.85) is below a batch's.
- With the owner's own provider as memory model, the same count bounds their bill.
- When the count is reached, the owner sees nothing except fewer notes being used.

**Persona aid** (plan §0; caused by the owner, not counted): one call when the persona is saved. It produces a `persona_fact` card: 「人格里这句话像是关于你或别人的事实：〈sentence〉。别人问起时可能被说出来。要移到“关于我”吗？」.

**Groups** keep today's rule (memory/store.ts:156).

## 5. Limits for others' use

**Numbers** (069, lane B): `accounts.others_answers` (default 50) and `accounts.others_points_micro` (proposed default **70**, derived below) — 「别人每天最多让我的 Agent 回复 50 次，最多花我 70 点」.
- A single Agent may be lower; the owner-set proactive budget stays as that Agent's sub-cap; there is no "unlimited".
- **One answer** is an admitted reply chain in lane `others` or `proactive` (distinct `coalesce(retry_of, id)`, `source is not null`, by `started_at` in the site day). It counts whatever its end.

**`OTHERS` bounds of such a reply:**
- one tool call in the whole reply (`OTHERS.toolCalls` = 1, over all tools, the web search included);
- 800 output tokens a call, at reasoning `none`;
- conversation ≤ 4 000 weight, notes ≤ 1 000 weight, the persona whole.

**The reservation is the wallet's hold** (C4, R2-I2). Admission computes the hold as today (port-impl.ts:885–894): call 1 plus the last-call room `maxCostMicro(min(held + roomGrowth(k, …), roomCap))`. For lanes `others`/`proactive`, three rules make that hold the whole reply's worst case:
- `k` is `OTHERS.toolCalls` (1) instead of the per-tool caps' sum, which is 14 by default (6 + 4 + 1 + 3, port-impl.ts:892).
- The worker drops every tool call past the first, including parallel calls in the same round, with no step added (not the `OVER_CAP` steps of worker.ts:716), so nothing adds bytes beyond `roomGrowth(1)`.
- Once the one call is used, `extend` passes `toolsAllowed = false`, so it reserves no room for another call.
- For lanes `others`/`proactive`, the room is kept on every tier: the one predicate `keepsRoom(cls, lane)` replaces `cls === "AB"` at admit.ts:193, port-impl.ts:1100 and tools/web/hold.ts:178.
- So the admission hold is the whole reply's worst case before its search, on every tier.
- A final round never raises the hold beyond it, because k = 1 bounds the round (worker.ts:772).

**One decider.** `othersFits(t, run, x)`, in new `metering/others.ts`, takes the account lock itself (a no-op where `lockPots` holds it). It checks settled others' charges today + Σ `hold_micro` of running others' runs + x ≤ the owner's and the Agent's numbers (and the proactive sub-cap for `proactive`). It runs:
- at admission, with x = the hold, called by `admit` before its provider shortcut (admit.ts:171), so BYOK is counted;
- at a search pre-hold (tools/web/hold.ts:182), with x = the price — on a refusal the reply goes on without the search;
- at a round (admit.ts:280, port-impl.ts:1092), with x = the raise, which is 0 by construction.

If running others' runs hold the room → `HeldBack` behind them; otherwise `others_limit`. It replaces `budgetReachedWith`'s lane part (runs.ts:1006–1013); the chain part stays. Others' holds never exceed the points number, so they hold back the owner's own replies on the balance by at most that much (M12).

**Arithmetic** — the wallet's hold. Assumptions:
- free-tier prices 140/280 µpt a token, paid-tier 3 000/15 000;
- typical input 16 500 bytes, or 20 900 with tool definitions;
- `roomGrowth(1)` = 14 300 bytes;
- search 0.77 (DeepSeek) or 13 (Exa).

| points | free tier | paid tier |
|---|---|---|
| hold, no tools (one call) | 2.53 | 61.5 |
| hold with tools: call 1 + last-call room | 3.15 + 5.15 = 8.30 | 74.7 + 117.6 = 192.3 |
| + one search | 9.07 / 21.30 | 193.1 / 205.3 |
| real: plain answer / with a tool round | 0.85 / ≈ 1.9 + search | 21 / ≈ 46 + search |

- **Default points**: 50 plain free-tier answers (42.5), plus the others' concurrency (3) each holding a reply with tools and a DeepSeek search at the end of the day (3 × 9.07 = 27.2) → 69.7 ≈ **70**. With Exa, the third reply waits.
- **Paid tier, plainly**: at 70, one plain answer reserves 61.5. A paid-tier Agent answers others about once a day, never with tools (they need 192.3 of room), and each further answer needs about 21 more. The settings page shows, per Agent, 「以这个数，每天大约能回别人 N 次」 from its model's price.
- **BYOK** reserves only the search price, so the count binds.

**When reached**: the run ends quietly (port-impl.ts:861) and `agent_daily_budget_reached` is shown once a site day (viewmodel.js:193). The owner's Agent card and use page say 「别人今天的使用已到上限」.

**Per person**: no fixed share. The per-caller minute (runs.ts:352) and the others' concurrency (port-impl.ts:485) stay. `GET /api/me/others-use` lists today by person, with 停止往来. It also lists the people the owner stopped, with 恢复往来, which lifts the owner's own bar and brings no row back (§1.2).

**Migration (step L, before `SOCIAL.enabled`, announced by a one-time owner card):**

| | Today | After |
|---|---|---|
| Points | per Agent, soft (settled only; null = none) | that Agent's own number unchanged; the owner's number is the sum of its Agents' (null counts as 100 000, capped there). The room is now hard (holds counted). |
| Proactive | its budget, soft | the same budget, as a hard sub-cap |
| Answers a day | none | 50 per owner; new for own-provider Agents too |
| Others' replies in groups | up to 8 rounds, the Agent's reasoning | `OTHERS`: one tool call, 800 tokens, no thinking |

Wire: `othersLimit` and `othersUsedToday` replace `othersBudget`, `othersSpentToday` and `proactiveSpentToday`; `proactiveBudget` stays.

## 6. Errands (one mechanism, same owner and across owners)

**The tool.** `ask_agent({to})` is offered only in the owner's own conversation, once per reply.

The port's `askAgent` (one transaction: `lockPairs` on (A, B) and (X, Y), then S, then X's and Y's rows in id order) accepts only:
- one of A's own Agents other than X; or
- a **full handle** that A typed in their own messages of this turn — never a display name (R2-I1).

This gate is the root, not a heuristic. No text but A's own typing can put a full handle into A's messages, and the question is made only from those messages (below). So injected material can trigger the tool, but it can never choose a cross-owner recipient or add content.

The refusals are states:
- anything else, or an undiscoverable target → `not_found`;
- `calledLastMinute(A)` applies;
- across owners, `reach(X, Y, 'social')`:
  - no row → B's policy as an add by X: `live`, or a request (`needs_approval`), which never revives an errand;
  - barred → `declined`;
- Y paused, without a model, or B's caps reached → `unavailable`;
- an open errand between X and Y in either direction → `busy`.

Otherwise it creates the errand and X's question run in S (lane own, caller A), and returns `{status: 'queued', errand, deadline}`.

**Data** (069): `errands(id, owner_id, initiator_id, target_id, target_owner_id, conversation_id, own_conversation_id, instruction_from_seq, instruction_to_seq, state, end_reason, deadline, question_message_id, answer_message_id, card_message_id, created_at, ended_at)`.
- A partial unique index on the unordered pair covers open errands.
- `agent_runs` gains `errand_id` and `errand_step`.

**Question, isolated.**
- X's run in S. Its material is X's persona, Y's public card, and only A's messages of that turn (≤ 2 000 characters, text only).
- No notes, no tools, one post.
- Accepted cost: unrelated words in that turn can reach the question. The first errand's explanation says so.

**Answer.**
- Y's run in S, queued by the question's post in the same transaction; lane own (same owner) or `others` with caller A.
- Both steps check `reach(initiator, target)` through `errand_id`. The answer is admitted against B's caps, and its post checks the notes shown for audience A.
- Search S only, one post.

**Result.**
- A separate transaction (X's own conversation → X → errand row, guarded by `card_message_id is null`) inserts one `errand_result` card into A's own conversation. It shows the target by handle, plus the question and the answer by reference to S.
- No run is ever shown the answer: X's later runs see only the handle, the state and the reason.
- X's later runs see an errand only as the replay of X's own `ask_agent` call in its own conversation (harness design §3): a native call whose result is built from the `errands` row's columns only — the target's handle, `state` and `end_reason` — never from the answer message or the question.
- If A quotes or retypes the answer, that is A's own message.

**Owners in S.** An owner's message is a plain interjection, and the errand ends at the sweep (`owner_spoke`). Either owner ends an open errand with 结束 in S.

| State | Entered by | Leaves to |
|---|---|---|
| `asking` | `askAgent` passed; X's question run queued | `answering` when X's question is posted |
| `answering` | that post, which queues Y's run | `done` when Y's answer is posted |
| `done` | that post | — |
| `ended(reason)` | `cancelled` (结束); `expired`; `declined` (`endGrants`, or `reach` failing at a step); `owner_spoke`; `unavailable` (paused, deleted, out of caps or money, or the step's run ended without a post, including across a restart) | — |

**Exactly once.**
- Transitions are `update … where state = <expected>`; a post that finds its errand moved on is refused (`errand_ended`).
- The sweep runs with `sweepStaleRuns` (port-impl.ts:1593) and at start-up after `recoverRuns` (:1483). It ends errands past their 15-minute deadline, or whose step has neither a queued or running run nor a message, and it delivers any missing card.
- Lock order everywhere: Agents' rows → errand row → runs.

## 7. Lifecycle

| Event | Stops at once | Stays |
|---|---|---|
| Agent deleted (agents/routes.ts:459) | its runs (`interruptRuns`); its errands `ended(unavailable)`; `reach` → `gone` | its social conversations, read-only; a reused handle is a new id |
| Agent paused | its runs; errands end at the sweep | the other side may write; nothing answers |
| Disabled, or `SOCIAL.enabled` off | as deletion for all but the owner; `claimNext` skips `agent_social` runs while off | the owner's own use |
| Bar, narrowing, removal | `endGrants` (§1.2) | history, read-only; only an approval brings back one row |
| The person removes or blocks the Agent | the row `left`, or the live block | history; re-adding follows the policy |
| The owner leaving | No account deletion exists today, and supervision follows ownership; a future deletion means deleting each Agent. | |

## 8. Build order, lanes, tests

**Step 0** (one commit before the split) fixes:
- the signatures of `reach`, `refusedSql`, `endGrants`, `applyPolicy`, `placeOf`, `othersFits`, `keepsRoom` and `loadNotes(…, {place, audienceId})`;
- migrations 068 (lane A) and 069 (lane B), with the interruption values in 068;
- the system events `social_opened`, `note_withheld`, `persona_fact` and `errand_result`;
- the `agent_social` sync shape.

The first switch-on of `SOCIAL.enabled` waits until the old processes have exited.

| Lane A — access, conversation, notes | Lane B — runs, limits |
|---|---|
| 068; `social/agent-contacts.ts`, social/friends.ts, blocks.ts, routes.ts; principals/store.ts; conversations/store.ts; sync/read.ts; messages/read.ts; the memory sites of §2.1; memory/store.ts, passage.ts, apply.ts, `memory/judge.ts`; tools/elsewhere.ts; CLI. Web: Contacts, AddFriendModal, AgentForm, ChatView, shown notes, cards | 069; agents/runs.ts, port-impl.ts, conversation.ts, context.ts, runtime/prompt.ts, worker.ts (the `toolCalls` guard), tools/index.ts, search.ts, file.ts, summary/job.ts, proactive/candidates.ts, agents/routes.ts; `metering/others.ts`, admit.ts, tools/web/hold.ts; sync/hub.ts. Web: Settings, Usage, Agents, viewmodel.js |

**Order**: step L (limits and bounds for groups, with the owner card, verified on the acceptance site) → ring 1 → same-owner errands → cross-owner errands.

**Tests that must exist** (real Postgres, scripted gateway and judge, numbers crossing 10 and 100):
1. **Revocation racing a running reply.** Each of bar, narrowing, removal and block commits mid-call → nothing posted, the run ends `access_ended`. A post and a send each serialise with `endGrants` on two connections.
2. **Two visitors at the last answer of the day** → exactly one admitted. Points variants: two Agents of one owner racing at admission and at a search pre-hold; a free-tier and a paid-tier reply whose hold equals the table above; BYOK.
3. **An errand across a restart** → one terminal state and one card; a late post is refused.
4. **The supervisor never visible as a reader.**
5. **Nothing of the vault or of a social conversation where it does not belong**: non-owner requests, judge and withheld calls, elsewhere whispers, catch-ups, own-conversation search and later own runs.
6. **Bars**: R2-C1's and R3-I1's sequences.
   - After 停止往来, approving one request from V's Agent makes exactly that row pass. The bar stays: V still cannot auto-enter a `contacts` Agent with no row, or an Agent made later, and V's @ stays barred.
   - The stopped side's approval never lifts the bar; only the setter's 恢复往来 does.
   - An approval racing a new bar finds the row no longer `requested`.
   - After an unfriend no `contacts` row survives, and a pair who never had access keeps group @.
7. **The judge's input** has no audience text. An owner yes is unused after an edit; an owner no survives an edit and a merge. A batch verdict equals the per-note verdicts on a scripted judge, and an id the judge leaves out reads as no.
8. **A note edited or vaulted during a reply** → not published; the next message gets a new reply.
9. **The gate**: a display name, a handle from search or web material, or from hearsay → `not_found`.
10. **The others' hold is the whole reply** (k = 1):
   - its admission hold uses `OTHERS.toolCalls`, not 14;
   - a reply asking for several tool calls in one round runs one and adds nothing for the rest;
   - after the one call, `extend` reserves no further room and the final raise is 0.
11. **Judge bounds**: a stale verdict row is reset and judged again; two workers racing for the last unit of the daily count make exactly one call; the call is sent with a 2 200-token output limit.

## 9. Deliberately not built (and the signal that would make us build it)

- The asking Agent using the errand answer — owners often quoting or retyping it. It would need the plan's isolated report.
- Visitor pays; a fixed per-visitor share — owners raising their numbers often; one person often taking most of a day.
- The Agent opening a 1:1 or following up — owners asking it to "tell them later".
- Multi-turn or onward errands, a queue behind `busy`, owners answering in person, notes in the question — frequent `busy`; owners writing in S.
- Permit refinements; judging at grant time; the judge in groups; a cheaper non-reasoning judge to raise the count — owner answers clustering on one kind of note; first answers lacking notes.
- Summaries, memory review, hearsay and learning in social conversations — long 1:1s losing context; owners repeating a correction.
- Appellations, read receipts, manual 重试, archiving, wider discovery, external Agents, files across conversations — requests for them.

## 10. Decisions I made that the brief left open

- A bar is symmetric, one row per pair, with the stricter reason kept. An unfriend writes a bar only when it ends a row.
- An Agent subject is judged only on its own row.
- A 30-day cooldown follows a stop or a decline.
- `observer` memberships for supervisors; no read receipts in `agent_social`.
- One tool call per others' reply; the points cap waits in `HeldBack`; the count refuses.
- The judge runs at `low`, one batch per audience; the background count is derived from its price; no summaries of social conversations.
- The errand gate admits own Agents or a typed full handle; one open errand per pair; a 15-minute deadline.
- The chain budget stays.

## 11. Attack findings → what changed

| Finding | Change (section) |
|---|---|
| C1, R2-C1 access | two facts in one order: a bar between people ends every row behind it via `endGrants`; an approval restores only its own row; an Agent subject reads only its own row (§1) |
| C2, R2-I1 | no run sees the answer; the gate admits own Agents or a typed full handle only, argued as the root (§6) |
| C3 | server facts and owner-set facts only (§4) |
| C4, R2-I2 | the reservation is the wallet's hold with `k = 1` and `keepsRoom` on every tier for others; `othersFits` under the lock at admission, search and round (§5) |
| C5 | the post step checks shown notes `for share`; a changed note means not published, ended like an interruption; no special retry (§3) |
| C6 | `placeOf` site table at `afa4f56` (search.ts:230, elsewhere.ts:127) (§2.1) |
| C7 | third-person system text (§2, §4) |
| I1 | `OTHERS` bounds; wallet-hold arithmetic; default 70 points (§5) |
| I2, R2 note | judge batches per audience (≤ 20 notes); count derived from the worst batch: 5 calls ≈ 100 notes a day, < ½ memory allowance; social summaries dropped (§4) |
| I3, R2-I3 | owner no unversioned; owner yes versioned (§4) |
| I4, R2 minor | both steps through `errand_id`; Agent↔Agent writes need `reach` both ways (§2, §6) |
| I5 | add and narrowing serialise on the Agent's row (§1.2) |
| I6 | proactive sub-cap kept; sums preserve every number; step L with owner card (§5) |
| M1 | `endGrants` takes the Agents' rows; sends lock too (§1.2) |
| M2 | chains by admission time (§5) |
| M3 | lease, call outside the transaction (§4) |
| M4 | 结束 in S; no cancel on the card (§6) |
| M5 | the switch in `reach`, discovery and `claimNext`; drain first (§1.2, §7, §8) |
| M6 | `calledLastMinute(A)` in `askAgent` (§6) |
| M7 | stated as an accepted cost (§6) |
| M8 | own Agent `is_yours`; self and undiscoverable → `not_found` (§1.2, §6) |
| M9 | one lock order: Agents → errand → runs (§6) |
| M10 | the person's own block writes no bar (§1.2) |
| M11 | the retry route refuses social conversations (§2.1) |
| M12 | others' holds ≤ the points number bound their effect on the owner's own replies (§5) |
| R2 two bar reasons | the stricter reason kept (§1.1) |
| R3-I1 approval deletes the bar | an approval never deletes it; a row approved after the bar passes it, that row only; only the setter lifts it with 恢复往来 (§1.2, §5) |
| R3 arithmetic conditions | `k = OTHERS.toolCalls` overrides port-impl.ts:892's 14; extra parallel calls dropped; `extend` reserves no room after the one call; tests 10 (§5, §8) |
| R3 minors | approval only of a `requested` row; stale verdict rows reset; the daily count taken atomically; judge output limit 2 200 (§1.2, §4, §8) |
