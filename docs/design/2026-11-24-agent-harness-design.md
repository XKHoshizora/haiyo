# Agent harness — design

Status: paper design, revision 3, 2026-11-24.
- It follows both rounds of the attack (`.superpowers/sdd/2026-11-22-polish/design-harness-attack.md`), the replay bench (`.claude/harness/`), and the controller's rulings. §10 maps each finding to its change.
- `src/` is `app/service/src/`. Line numbers are at `dc54dc1`, which includes prompt2.
- Weight is `metering/tokens.ts` `weight`.

## 0. The whole design in ten sentences

1. Step 1 changes one thing: in the owner's own conversation, for a plan that offers tools, an earlier reply that searched returns in the provider's own form. That is its acknowledgement, its native calls, a placeholder result for each call, then its answer.
2. A reply is replayed only if it ended with a posted answer. Its trace is exactly the tool rounds whose results were in the request that produced that answer.
3. A placeholder holds only stored facts: the query, the date, and the sites (hosts, never titles). A refused call shows no query at all, only the tool's own sentence saying why nothing came back.
4. Nothing of this reaches a group, social, the summary, the memory review, search or the wire. The facts have exactly one reader: the same Agent's later runs in the same own conversation.
5. A call to a tool that this request does not offer is never replayed. Such a reply returns as today's text.
6. Requests without tools are byte-identical to today, proven by the sha256 pins. So is any call that sends no tools: the gateway lowers the replay to today's text.
7. A 400 on a request carrying a replay is retried once without it, for that call only. It is counted, and it never touches the tools-refused logic.
8. One function turns every part into the text it weighs. The plan, the admission hold and the worker's holds all call it, so the money code changes only by calling it.
9. Groups, social, titles, stored results, `assemble(run, place)`, the rights table and `outcome()` wait, each with its signal (§8).
10. The decision is made by an extended bench through the production path, with every bar measured against today in the same run, plus one live run of 15 questions as a cascade check.

## 1. Verdict on today's harness

**Yes, it is under-designed.** There is no model of the request and none of a stored turn. Step 1 fixes the second gap where the failure was measured.

| | What | Where |
|---|---|---|
| Sound | The context plan is pure functions; untrusted text arrives as material; this run's rounds are native; citations come only from numbers the run handed out | runtime/context.ts `ContextPlan` (239); prompt.ts `notesPassage` (424); gateway.ts `stepMessages` (484); refs.ts `takeCites` (302) |
| **Wrong (measured)** | A past reply returns as text only. "我查一下。" is followed directly by "根据搜索结果…", and refused calls are not even counted | context.ts `loadPage` (445, text at 457); lookups.ts:9; runtime/context.ts `build` (358); worker.ts:740 |
| Wrong | The request is four separate suffixes; `withoutTools` misses the summary | port-impl.ts 734–747, 815; context.ts:622; worker.ts:628 |
| Wrong | Place is a boolean recomputed at each site | port-impl.ts:645; conversation.ts:290 |
| Weak | Each reader of a stored reply re-derives it from the text; output endings are scattered cases | context.ts:457; job.ts `lineText` (246); review.ts:156; worker.ts `conclude` (425) |

## 2. The model of a request

**The system text** is as prompt2 ships it, and step 1 does not change it.
- own: identity, date, *capability*, proposal rules or onboarding, memory sentence, persona, notes, greeting, summary.
- group: identity, date, *capability*, group name, scene, unasked passage, roster ≤ 30, other Agents ≤ 20, notes, secrets, persona, told material, summary.

*Capability* is {`REPLY_LANGUAGE` (prompt.ts:37, not for an unasked reply), the tools passage, `HOW_TOLD` (593)}. Without tools it is replaced by `NO_TOOLS` or `TOLD_NO_TOOLS`.

**Variants of a plan that offers tools:**

| Variant | What it sends |
|---|---|
| with tools | everything; the replay is lowered natively |
| final | the same, plus `FINAL_LINE` and `toolChoice: none` |
| without tools / plain | a tool-less run's system text, and the replay lowered to today's text |

A replan (too small for tools, the greeting turn) is a new plan, not a variant.

**Bounds.**
- One call carries at most the model's window less its output limit.
- History: own is the window's budget (context.ts:599–601), group is 12 000 and 80 messages, as today.
- Notes ≤ 25 % of the input room; summary ≤ 1 195; tool definitions about 1 660 planned; rounds ≤ 8, each result ≤ 3 000.
- The replay sits inside history (§3).

**Assembly order (I11).**
1. The system text, which does not depend on the replay.
2. The reservation (port-impl.ts:792–799).
3. The budget.
4. History newest first. A reply and its replay are one unit, kept or dropped together.

Whether tools are offered depends only on the newest message (`holdsNewest`, port-impl.ts:795, 801). So a replay can only push older history out; it never removes the tools. On an 8 k model, fewer old searched turns fit, about 104 weight more each (about 156 tokens planned at the tool ratio), and the reply keeps its tools.

**Target shape, not step 1.** `assemble(run, place)` and `PLACES[placeOf(…)]` (notes, summary, tools, replay, stream, acknowledgement, proposal per place) land with the social lane.

Social is more than a row there:
- `ask_agent` joins the own row;
- the errand question gets its material block;
- the social endings join §4;
- X's `ask_agent` call is replayed in its own conversation, with its result read from the `errands` row.

The social design needs one sentence. It goes in `docs/design/2026-11-23-agent-social-design.md`, §6 "Errands", subsection **Result**, after the bullet "No run is ever shown the answer…":

> X's later runs see an errand only as the replay of X's own `ask_agent` call in its own conversation (harness design §3): a native call whose result is built from the `errands` row's columns only — the target's handle, `state` and `end_reason` — never from the answer message or the question.

## 3. A stored reply and how it returns

**What is stored, and where.** One new body key, `toolCalls`, only on replies in the Agent's own conversation (`own`, conversation.ts:290). It is written in the same insert as the reply.
- **What decides it.** `toolReply` notes, for each request it builds, how many steps that request carried: 0 for the plain call.
- **When it is written.** Only when the reply ends as an answer: the round finished (complete, or cut at the output limit) and `conclude` posts with status `done` (worker.ts:469). `conclude` then passes the calls of exactly the steps the answering request carried.
- **When it is not written.** A run stopped, timed out, or refused by `extend` after a tool round and before an answer stores none, and neither does the plain call.
- **What each entry is**, for `search_web`, `search_messages` and `current_time`:
  - `{name, round, input, outcome: "ok", found?, pages?}`;
  - `input` is cleaned and cut to 60 weight after escaping (`{}` for `current_time`);
  - `pages` are the `webSources` numbers this call handed out.
- **A call answered with an error** (the guard's `private` or `length`, money, busy, no results, a failure) is stored as `{name, round, outcome: "refused", error}`, **with no input at all**. `error` is the tool's own sentence: web/words.ts or the search tool's, ≤ 51 weight, and never query text. A call the loop answered itself (a repeat, one over its tool's cap, a garbled one) is stored as `UNUSABLE` ("这个请求无法执行。"): the loop's notes speak of that reply's own rounds, one in the imperative (fix round 1, review M4).
- **At most the tools' caps.** A reply keeps its calls only when there were at most the step-1 tools' per-reply caps summed (`TOOLS.web.perReply` + `searchPerReply` + `timePerReply`: 3 + 6 + 1 = 10 at the defaults). One that made more — a model looping past its caps, whose refused calls count against no cap — keeps none and returns as its text: all or nothing, as the trace is exact (§9). The read side holds to the same count.
- **Who reads it.** `toWire` picks its keys one by one (messages/read.ts:243–254), so `toolCalls` never reaches the wire. It is also never read by search, sync, the summary, the review or any group or social run.

**When a reply is replayed.** All of these must hold:
- the plan offers tools (`run.refs` in `loadContext`);
- the reply has visible text and `toolCalls`;
- every call in its answering rounds is to `search_web`, `search_messages` or `current_time`;
- each of those tools is offered in this request.

Otherwise the reply returns as today's text. That covers:
- a reply that read a file (per-run file numbers);
- a reply whose web search is turned off now;
- every reply stored before step 1.

**The layout, round by round** (R2-m4). Each round is one assistant turn holding every call of that round, the first round's turn opening with the acknowledgement's text. Then comes one tool turn holding all its results. The answer text follows the last round.
```
assistant  [我查一下今天上海的天气。, tool-call search_web {"query":"上海 今天 天气"}]
tool       [{"note":"那次的结果已不在这里，那次回答以外的细节要重新搜索","sites":["tianqi.com","foreca.net","fengxian.gov.cn"],"date":"2026-11-22"}]
assistant  [今天（11月22日，周日）上海多云为主……]
```

**Placeholders.** These are the only things shown; each is at most 72 weight, built by construction. Their wording was changed in fix round 1, from the live bench (haiku, 12 turns): the first ("这次搜索的结果当时已经给你看过，系统没有保留原文。") was read as "that search did not contain it", and a detail the answer had not given was not searched again (fu_search 11 of 20); and an old refusal's `这次回复` was taken for the present reply ("这次回复还不能再联网搜索"). Now a search's result says its results are not here and a detail beyond that answer needs a new search; a refusal says it was that reply's alone.

| Call | Input shown | Result shown |
|---|---|---|
| web, ok | its stored query | `{note: "那次的结果已不在这里，那次回答以外的细节要重新搜索", sites, date}`: up to 3 sites, cited first. A host keeps whole labels from the right while it is ≤ 30 characters. 59 typical, 72 worst |
| messages, ok | its stored input | `{note: "那次的结果已不在这里，那次回答以外的细节要重新查找", found, date}` (≤ 40) |
| time | `{}` | `{note: "当时给过你那时的时间。", date}` (22) |
| refused (any reason) | `{"query":""}`: a redacted argument. It fits the schema, so an imitation is refused by the tool's length rule and is never "garbled" | `{error, note: "只限那次回复", date}`: the tool's own sentence, e.g. "这次回复不能再联网搜索了；之后的回复可以照常再试。" (25), or `WEB_QUERY_PRIVATE` (51), scoped to that reply. 71 worst |

**Bounds.**
- One call (call plus result) as `partText` weighs it — its id and name included, which the wire carries too — is ≤ 172 weight, ≤ 516 bytes (a web search with a 60-weight query and 3 sites of 30 characters); a messages search ≤ 144, a refusal ≤ 119, the clock 65.
- One reply keeps at most the per-reply caps of these tools (web 3 + messages 6 + clock 1 = 10 calls; more and it keeps none), so ≤ 3·172 + 6·144 + 119 = 1 499 ≤ 1 600 weight at the default caps.
- Typical: one web call, about 104 weight, about 310 bytes (the bench fixtures: 80–111).

**Other rules.**
- Inputs and errors pass `RunRefs.plant` like entry text (R2-m3).
- Ids are deterministic in the protocol's style, made from (message id, index). `withChatFields` (594) skips them when it pairs reasoning with this run's rounds.
- Replayed turns carry no provider metadata.

**Private words (C1).**
- A web query stored as `ok` has passed `guardQuery` (text.ts:98–119). It shares no 6-character CJK run, 7-digit run or 3-word run with the notes and hearsay that run was shown, except runs the owner typed in this conversation, and those are in its history anyway.
- A refused query is not stored.
- `search_messages` inputs are not guarded and can hold the owner's words, vault included: the own conversation is shown everything (store.ts:145–157). They are replayed only into that same conversation, where the lane rule already allows search words to be shown (lane-rules.md:24).
- When the owner vaults a note, nothing changes: vault notes are shown in the own conversation.
- When the owner deletes a note or turns memory off, the note leaves the system text. Stored inputs stay with their message, exactly as the Agent's earlier reply text and the owner's own messages do, and leave with it (or with a new topic).
- They reach no one else, because `toolCalls` has one reader.

**The gateway.**
- `ModelCall.messages` turns may hold tool-call parts and `tool` turns.
- `toModelMessages` (451) lowers them with `stepMessages`' builders when tools are sent.
- When no tools are sent, it drops them and merges the assistant parts, which gives today's bytes.
- **A 400 or 422 on a request carrying a replay** (I1), before anything came back, is retried once for that call with the replay lowered. That lowered request is today's request, and gets today's handling, including today's tools-refusal retry. Nothing is remembered in `Refusals`, `toolsRefused` is not set from it, and nothing is marked tools-off. One counter is logged: `replay_lowered`, by protocol, counts only. A broken builder therefore shows up as a rising counter, not as silence.

**Verified.** anthropic (haiku) and openai_chat (deepseek-chat) were run live, with thinking off. openai_responses and gemini were checked on the wire only; Gemini 3 gets the SDK's sentinel when its id matches `gemini-`, and is covered by the counter otherwise.

**Holds (R2-I3).** One function, `partText(part)`, gives:
- a text part's text;
- `JSON.stringify({id, name, input})` for a call;
- `JSON.stringify({id, name, output})` for a result.

It replaces the text-only `flatMap` at port-impl.ts:873 (admission) and worker.ts:561 (the `texts` that `extend`'s holds and the plain call's hold use). The plan's `partTokens` (runtime/context.ts:109) and `minimalTokens` use it, at `TOOL_TEXT_FACTOR` for tool parts.

The arithmetic is unchanged; only its inputs grow. Admission is still `holdTokens([system, ...texts], context, output)` + definitions + `TOOL_PREAMBLE_TOKENS` + fixed, and `holdTokens` still counts UTF-8 bytes up to the window. Each replayed reply adds its bytes: about 260 typical, ≤ 4 800 worst, capped by the window as before.

`admitRun`, `extend`, `maxCostMicro` and the settlement are untouched. A test holds that the hold is at least the UTF-8 bytes of every string the wire carries — texts, ids, names, arguments, results, the tools' words — with 10 replayed replies, on every protocol. (Not the body's JSON keys and punctuation: no tokenizer reads them as text, and a hold never bounded them even without a replay. A provider's template adds a few tokens per message; CJK at 3 bytes a character and `partText`'s own punctuation are the slack for it.)

**What a tool-less request sees.** No replay: today's request, byte for byte (`reply-history.test.ts:175`, `:189`, `:251–289`). A model without tools still reads "我查一下。根据搜索结果…". We accept this, and keep it measured in §8.

**Other readers.** They are unchanged:
- the memory review's basis rule (review.ts:89–90: the Agent's lines "绝不能当作依据") keeps a confession from becoming a note unless the owner affirms it;
- the summary keeps today's text.

**The forms (fix round 2: measured arms, not yet chosen).** The re-bench after round 1 (haiku with thinking low) showed two failures of this placeholder that the first bench's classifier did not count. Re-scored with the bench's new rule 2b, the merged form H has 38 confessions of a hosts-only kind with thinking and 16 without; A has 0 in both. The model takes "sites and a date" for all the search returned ("搜索只返回了网站名和日期，没有返回任何网页正文…"). Second, replayed Chinese acknowledgements in a turn that ends in a call act as a template for the reply being written: on ja3, H answers in Japanese 10 of 20 times, A 20 of 20. So the form is a switch, `TOOLS.replayForm`, read in config.ts alone and `H` by default. Each form is built by the service's own code (`replay.ts` `withReplay`), and the bench's arms call it:

| Form | What changes from H | A web search's result | Bound |
|---|---|---|---|
| H | — | `{note, sites, date}` | 72 |
| H2 | the result says, as data, how many results came back then, that their text is not kept here, and that the answer was written from them; the count and `text_kept_here` come before `sites`, so the sites are not read as the whole result | `{"results_returned_then":3,"text_kept_here":false,"note":"那次回答是根据这些结果写的；原文没有保存在这里，回答以外的细节要重新搜索","sites":[…],"date":"2026-11-22"}`; a messages search `{"messages_found_then":n,"text_kept_here":false,"note":"回答以外的细节要重新查找","date":…}` | 100 |
| H3 | H2, and the acknowledgement goes after the results, at the head of the answer's turn: `[call] > [result] > [ack, answer]` | as H2 | 100 |
| D | H3, and the 2 most recent replayed replies that stored an excerpt show it: per page (at most 3) the site, the title (≤ 20 weight) and the snippet (≤ 40) the tool handed the model, under `TOOL_MATERIAL`; older replies as H3 | `{"about":TOOL_MATERIAL,"results_returned_then":3,"excerpts":[{"site","title","snippet"},…],"note":"这里只留了摘录，那次回答是根据完整结果写的；回答以外的细节要重新搜索","date":…}` | 340 |

- **H3 moves the acknowledgement rather than dropping it.** Dropping it loses what the Agent said. Moving it keeps the request without tools byte for byte the request before step 1 (A's turn is already `[ack, answer]`), and it removes the shape "text, then a call" from history. The live call is still asked to say so first. That shape is what the model copied.
- **D stores** the excerpt at post time, beside `toolCalls`, in the own conversation only and only while `D` is set (`storedToolCalls`, `form`). It has the same one reader. The read side checks the caps (`toolCallsOf`).
- **D's injection exposure is stated, not hidden.** D shows web text again: about 180 weight per call, in the 2 most recent replies, inside a tool result and under the material sentence the live result uses. It is cleaned and stripped of token-shaped strings when stored. A planted instruction in a title or snippet is therefore seen twice more than in H.
- **Per reply**, one web call: H 102–111, H2/H3 129–139, D 214 (one page) to 295 (two pages), as `partText` weighs it (bench fixtures, 12 turns). The worst case per reply at the default caps grows with the result bound: H2 ≤ 1 600, D ≤ 2 300 for the 2 real replies (tests/replay-forms.test.ts).
- **The bench** (`.claude/harness/bench.mts`) runs A, H, H2, H3 and D in one run, each form against A, with two new bars: wrong language on ja1, ja3, en1 and en3 (≤ A + 2 each, which is `lang ok` ≥ A − 2 when every answer has text), and hosts-only confessions (≤ A + 2). The confessions bar counts the hosts-only kind too. The form is chosen from that run, with thinking off and low, on haiku and deepseek.

## 4. Output handling, as one state description

**States**: planned → round *k* → acknowledged (at most once per question) → tools → final or plain → ended.

The keep step is prompt2's `kept`, and it applies to acknowledgements.

| The run ended with | Stored | Status | After |
|---|---|---|---|
| An answer with visible text | the reply; in its own conversation also `toolCalls` of its answering rounds | `done` (`truncated` flag) | follow-up of what was noted (runs.ts:1623) |
| Only run tokens | as written, citing nothing | `done` | the same |
| Nothing visible: empty, whitespace, an unrun last-round call, a content filter, an unfinished block; in a group also reasoning only, or the mark or labels | nothing; an acknowledgement already posted stays as text | `failed provider_unavailable`, kind `nothing` | 重试; no automatic retry |
| `thinking_exhausted` | nothing | failed | as today |
| Upstream failure: passing, or after progress | nothing | failed, transient, or failed | automatic retry (runs.ts:1675), or 重试 |
| Tools refused, first round | that round's text | by the rows above | the model is marked tools off |
| 400 with a replay | — | retried once lowered, counted | |
| Later round 400 or 422 | the plain answer, **no `toolCalls`** | by the rows above | |
| Stop, time out, `extend` stop or busy | what was said (`stopped` / cut), **no `toolCalls`** | stopped / `ended_elsewhere` / `busy` | follow-up rules |
| Pause, delete, shutdown | nothing | cancelled / released | recovery |

The social endings (`access_ended`, `owner_spoke`, `notes_changed`, `errand_ended`) join when social ships.

**I3, after the narrowing.** In the own conversation, the only answers the harness empties are an empty one and one inside an unfinished block. The split code `nothing_kept` waits in §8, with its instrument.

## 5. What we take from each reference

| Source | We take | We do not take |
|---|---|---|
| Codex article and source (Apache-2.0, cf3ff15) | Later turns re-send the earlier `function_call` and `function_call_output` items; outputs are truncated in live history | Full outputs; a synthetic "aborted" output. We do not replay a call that never fed an answer |
| Anthropic, *Effective context engineering* | Tool-result clearing: the call stays, and an old result becomes a placeholder | Recent results kept raw (variant D, §8) |
| Anthropic, *Effective harnesses for long-running agents* | The harness, not the model, keeps the facts the next window needs | Progress files, initializer agent |
| OpenCode (MIT, ee5fe34) `toLLMMessages` | One function lowers stored parts to native calls and results; calls that never ran are dropped; provider metadata only for the same model | Stored full outputs |

Nobody writes calls as text in the assistant's voice. Bench B was imitated 11/160 and 10/160 of the time; on DeepSeek the imitation was written instead of calling.

## 6. Migration

| Step | Change | Shippable because |
|---|---|---|
| **1** | Own-conversation native replay: the worker's `toolCalls` (§3), `loadPage`, `ContextPlan` replay units and `build`, the gateway's lowering and replay ids, the `withChatFields` skip, the 400 retry with its counter, `partText` in plan and holds; tests; the extended bench; the live run | Tool-less requests and every no-tools call are byte-identical; no system text, wire shape, table or migration changes |
| 2 | `withoutTools` carries the summary (port-impl.ts:815) | Only the no-tools variants of tool plans |
| Later | Group and social replay, `assemble`, `PLACES`, `outcome()` | With the social lane, on their signals |

**Existing messages** have no `toolCalls`, so they return as today. The live run uses a new conversation.

## 7. Tests, and the measurement that decides

**Tests** (scripted gateway; they assert the `ModelCall` and the SDK messages):
1. A searched own reply returns as [acknowledgement + call] > [result] > [answer]. The prompt2 own-conversation `it.fails` tests (`reply-history.test.ts:115`, `:134`) flip; the group spec (`:152`) stays `it.fails`.
2. A refused search returns as `{"query":""}` and `{error}`. The refused query appears in no part of any later request. A vaulted or deleted note appears in no later request.
3. Stop, time out, `extend` stop or busy after a tool round, and the plain answer: no `toolCalls`, no replay.
4. A tool not offered now (web off), or a file call: the reply returns as today's text.
5. All four protocols: replay parts only when tools are sent; a no-tools call has A's bytes.
6. The pins at `:175`, `:189` and `:251–289` stay unchanged.
7. A 400 with a replay: one lowered retry, counted. `Refusals` is unchanged and nothing is marked tools-off.
8. The hold ≥ the UTF-8 bytes of every string the wire carries, with 10 replayed replies, on every protocol. The plan, admission and the worker's holds use `partText` (each reverted to text only turns a test red).
9. `toolCalls` never appears on the wire, in search, in a group or social request, the summary or review input, or a log line.
10. Bounds, including a 253-character host; a reply and its replay kept or dropped as one unit.

**The extended bench.** It is `.claude/harness`, rebuilt to go through `ContextPlan.build` and `toModelMessages` (R2-m1). Its own-conversation history has 12 turns:
- zh1–zh4;
- a refused search, then a top-up;
- 2 plain turns;
- a Japanese and an English searched turn;
- 2 more searched turns.

It runs arms A (today) and C-hosts (step 1), on the 8 probes plus "after the refusal". That is 20 samples each, n = 180 per arm per model, on haiku (thinking `none` and `low`) and deepseek-chat (switch off and on). It counts raw output before keep, and a person reviews every classifier hit.

**Bars**: each compares C with A in the same run. The pass probability is computed at the measured rates of the 4-turn bench, n = 180.

| Bar | Basis (4-turn bench, per 160: A → C) | Correct build passes with |
|---|---|---|
| Confessions: C ≤ A/3 + 3 | haiku 25 → 1; deepseek 0 → 0 | > 0.99 (haiku: about 6 sd; deepseek: P(C ≥ 4) ≈ 0.003) |
| Offers instead of searching: C ≤ A/2 + 4 | 32 → 8; 29 → 9 | > 0.99 (3.3 sd and 2.6 sd) |
| Imitation (call-, record- or result-shaped text), after review: C ≤ A + 3 | 0 → 0; 0 → 0 (B: 11, 10) | ≈ 0.98 at a true rate of 0.5 %; B-like behaviour fails by > 4 sd |
| Fresh facts with no call, on ja1, en1, en3, fu_search and after-refusal only: C ≤ A + 3 | haiku 0 → 0; deepseek 11 → 0 | ≈ 0.98 |
| The fresh-search follow-up calls: C ≥ max(A − 2, 16) of 20 | 20 → 20; 11 → 20 | ≈ 0.98 |
| "你从哪查到的" names an earlier site: C ≥ max(A + 8, 16) of 20 | 0 → 20; 4 → 20 (measured with titles, so this bar is what tests hosts-only) | > 0.99 if hosts keep it |

- A single failed bar is re-run once with fresh samples, and counts only if it fails twice. A correct build then passes all bars on both models with probability ≈ 0.99.
- "After the refusal", language and cost are **reported, not bars**: no data supports a margin yet. Cost is checked deterministically by test 8 and §3's bounds.

**Live** (`.claude/live-web.mjs`, haiku, a new conversation, once) is a cascade check, not statistics. It passes if:
- at most 1 confession;
- no reply that offers instead of searching is followed by another such reply;
- ≥ 12 of the 14 questions other than zh5 are searched (zh5 is often answered from knowledge: C searched it in 3/20).

Before the script deletes its Agent, it reads the Agent's notes: none about fabricating or not searching. At C's rates a correct build passes with ≈ 0.93. Today's evidence fails it: 4 offers in a row, and 8/15 searched.

**Language (side finding).** After a Chinese history, ja3's acknowledgement was in Chinese in every arm (haiku lang-ok A 7, B 0, C 3 of 20). The confound is the bench persona's 「用主人的语言回答」 against `REPLY_LANGUAGE`, plus four Chinese 「我查一下…」 in the history. The extended bench adds a persona without that clause.
- If the acknowledgement follows the question there, it is the persona's matter, left to the owner.
- If not, the harness's candidate fix, measured first, is moving `REPLY_LANGUAGE` last in the system text.

Step 1 does not wait for this.

## 8. Deliberately not built

| What | Its signal, and the instrument |
|---|---|
| Replay in groups, and later in social | The same failure measured in a group: bench arms A and C on a group scene, where A confesses or offers as it does in the own conversation |
| Page titles in the placeholder | Owners asking what a page said, and the Agent searching again or inventing: a bench detail probe ("那页写了什么"), hosts-only against titles, with three injection kinds |
| Stored real results for recent replies (D) | In the bench, D saves ≥ 5/20 fresh searches on detail follow-ups against C, nothing else worse, at ≤ +15 % cost |
| Replaying `read_file` | Confessions about files, in a bench file probe |
| Replay for tool-less plans (the model switch) | Bench A-without-tools after tool replies: confessions above 2/180 |
| `nothing_kept` as its own code (I3) | The bench, applying keep offline: emptied answers above 1 % |
| An answer from the plain call keeps a bare acknowledgement (R2-m2) | `tool_rounds`' `plain` count above 2 % of tool replies |
| Tool facts in the review or summary | A fabrication note in the live run's notes check |
| `assemble`, `PLACES`, `outcome()`, an own-history cap | With the social lane; the cap as its own product ruling |

## 9. Decisions I made that were open

- The step-1 tools are `search_web`, `search_messages` and `current_time`. A reply with any other call returns as today's text.
- No cap on calls per reply beyond the tools' own per-reply caps: a reply with more calls than they sum to keeps none (fix round 1). The trace is exact, not a prefix.
- Refused calls are redacted as `{"query":""}`, an argument that fits the schema, and show the tool's own sentence.
- Wire fields stay as today. The replay reads only `toolCalls`, plus `webSources` for the hosts.
- Live is one run as a cascade check; the statistics are in the bench.

## 10. Attack finding → what changed

| Finding | Change |
|---|---|
| R1 Q1 / I1 / I2: the text record | Gone; native call plus placeholder, as bench C |
| R1 C1 / R2-C1: tool-less requests; a refused private query | Tool-less requests byte-identical. Own only. A refused input is never stored and is replayed redacted. Vault, delete and memory-off are stated (§3) |
| R1 I3 (patched) | Own conversation: only empty and unfinished-block answers remain; split code in §8 |
| R1 I4 / R2-I2: a trace of unseen rounds | `toolCalls` holds only the answering request's steps; stop, time-out, `extend` and plain store none |
| R1 I5: the bound | Hosts only; ≤ 72 per result, ≤ 172 per call as `partText` weighs it, ≤ 1 600 per reply (at most the caps' calls kept), by construction |
| R1 I6 / R2-I5: titles | Titles removed. Persistence is now ≤ 3 hosts of ≤ 30 characters per call inside a tool result, bounded by the tool caps |
| R1 I7 / I8 / I10 / I11 | As revision 2; I11's order stands, with the holds fixed below |
| R1 I9 | The one sentence for the social design, with its file and section (§2) |
| R2-I1: a replay 400 could switch tools off | One lowered retry per call, never remembered, never tools-off, counted; only offered tools are replayed |
| R2-I3: holds | `partText` in the plan, admission and the worker |
| R2-I4: the group asker line | No group replay in step 1 |
| R2-I6: the bars | Relative to A in the same run, with stated margins and pass probability; unsupported bars dropped; live is a cascade check |
| R2-m1 – m4 | Bench through the production path; plain-answer count in §8; inputs planted; per-round layout |
