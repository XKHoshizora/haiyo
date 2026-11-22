# Haiyo service: runtime settings inventory

Sources: `app/service/src/config.ts` (1079 lines, read in full) and `app/service/README.md` "## Configuration (`src/config.ts`)" (lines 64-221), plus the README tables for `JUDGE` (4030-4048), `PROACTIVE` (4054-4068) and `MEMORY` (4076-4103). Call sites were grepped only to fill the "when read" column. No `.env` file was opened.

Legend for "when read":
- **startup**: used once while the process starts, to build something long-lived (Fastify server options, the pg pool, a timer, a slot pool, a closure registered with a route, a module-level variable). Changing it needs a restart, or a rebuild of that component.
- **per request**: read from the shared `Config` object (`deps.config`, held by reference) each time it is used (a request, a run, a job, a timer being re-armed). The object is never replaced or re-read, so today these also change only on restart. They are the ones that could follow a live store without restructuring.
- **reloadable**: no setting is reloadable today. Nothing re-parses the environment after `loadConfig()`.

Ranges are as validated in code. `wholeNumber(d, min, max)` (config.ts 650-657) accepts 1-10 decimal digits only, and empty means the default. `z.coerce.number()` fields accept anything `Number()` parses (`"1e4"`, `" 30 "`), and an empty string becomes 0. `positive(d, max)` (155) is an integer from 1 to max. `probability(d)` (154) is a number from 0 to 1. Every JSON variable uses `z.strictObject`, so an unknown key is refused at startup.

## 1. Settings table (179 rows: 59 environment variables + 116 fields inside the JSON variables + 4 key variables named indirectly)

| Setting | Type and allowed range/values | Default | What it controls | Secret? | When read | Category | config.ts line |
|---|---|---|---|---|---|---|---|
| `DATABASE_URL` | string, min length 1; required | none (required) | Postgres connection string for the app pool and the CLI | yes | startup (pool, app.ts:298). cli.ts:22 also reads `process.env.DATABASE_URL` directly | infrastructure | 660 |
| `APP_ORIGIN` | `z.url()`; required | none (required) | The site's origin: CSRF `Origin` check, WS origin check, Better Auth baseURL and trustedOrigins, HSTS, mail links | no | startup (app.ts:380, ws.ts:51, auth.ts:235-238, web.ts:84) + per request (register.ts:89,98) | infrastructure | 661 |
| `AUTH_SECRET` | string, min length 32; required | none (required) | Better Auth signing secret (sessions, verification JWTs) | yes | startup (betterAuth, auth.ts:237) + per request (verifyJWT, auth.ts:521) | security/crypto | 662 |
| `PROVIDER_KEY_SECRET` | string, min length 32; required | none (required) | Key for encrypting users' provider API keys at rest | yes | startup (route closure, providers/routes.ts:182) + per call (resolve.ts:145) | security/crypto | 663-664 |
| `SITE_MODELS` | JSON array of strict site-model objects (fields below); unique `id`s | `[]` | The models the site offers, with their upstreams and prices | no (keys sit in the variables `apiKeyEnv` names) | per request (resolve, claim query port-impl.ts:498-499, memory model) | models/providers | 666 (schema 91-108; checks 963-980, 988-989) |
| `SITE_MODELS[].id` | string 1-64; unique across entries | required | The model's id (Agents store it) | no | per request | models/providers | 92, 988-989 |
| `SITE_MODELS[].label` | string 1-100 | required | Display name | no | per request | models/providers | 93 |
| `SITE_MODELS[].tier` | `free` \| `paid` | required | Whether it draws on the free allowance or only the balance | no | per request | metering/points/pricing | 94 |
| `SITE_MODELS[].protocol` | `openai_chat` \| `openai_responses` \| `anthropic` \| `gemini` | required | Wire protocol of the upstream | no | per request | models/providers | 95 |
| `SITE_MODELS[].baseUrl` | `z.url()`; no `?`/`#`; https, no credentials, plain host (`normaliseBaseUrl`); normalised in place | required | The upstream address | no | per request | models/providers | 96, 963-973 |
| `SITE_MODELS[].apiKeyEnv` | env-var name `^[A-Za-z_][A-Za-z0-9_]*$`; not one of `SERVICE_SECRET_VARIABLES` (case ignored); the named variable must be set and non-empty | required | Which variable holds the upstream key | no (it is only a name) | startup check + per call | models/providers | 89, 97, 616-622, 980 |
| `SITE_MODELS[].model` | string, min length 1 | required | Upstream model name | no | per request | models/providers | 98 |
| `SITE_MODELS[].inputMicroPerToken` | int >= 0 | required | Price per input token, in micro-points | no | per request | metering/points/pricing | 99 |
| `SITE_MODELS[].outputMicroPerToken` | int >= 0 | required | Price per output token, in micro-points | no | per request | metering/points/pricing | 100 |
| `SITE_MODELS[].maxOutputTokens` | int > 0 | required | The reply's output limit | no | per request | models/providers | 101 |
| `SITE_MODELS[].contextTokens` | int > 0, and > `maxOutputTokens` | required | Context window | no | per request | models/providers | 102, 974-978 |
| `SITE_MODELS[].vision` | boolean | required | Accepts images | no | per request | models/providers | 103 |
| `SITE_MODELS[].pdf` | boolean | required | Accepts PDFs | no | per request | models/providers | 104 |
| `SITE_MODELS[].reasoning` | array of `none`\|`low`\|`medium`\|`high`\|`xhigh`\|`max` | required (may be `[]`) | Reasoning levels an Agent may pick | no | per request | models/providers | 41, 105 |
| `SITE_MODELS[].thinkingSwitch` | boolean, optional | absent = false | Chat Completions only: send `thinking: {type}` to an upstream that thinks unless told not to | no | per request | models/providers | 79, 106 |
| `SITE_MODELS[].tools` | boolean | `true` | Whether its replies may be offered tools | no | per request | models/providers | 107 |
| `FREE_DAILY_POINTS` | `^[0-9]{1,12}$` whole points (0-999 999 999 999); stored as bigint micro-points (x 1 000 000) | `200` | Free daily allowance of site-model use | no | per request (admission, settle, reminders, account route, claim query) | metering/points/pricing | 668-671 |
| `SITE_TIMEZONE` | IANA name accepted by `Intl.DateTimeFormat` | `Asia/Shanghai` | Whose midnight starts a site day (allowance, judge counts, fuses) | no | startup (configureStats app.ts:464; DeepSeek engine app.ts:258) + per request | metering/points/pricing | 673-682 |
| `AGENT_TIERS` | JSON object tier -> int >= 0 (no max); must contain `free` | `{"free":20}` | Agents an account may own, per account tier | no | per request (store.ts:234) | limits/rate | 684-687 |
| `AGENT_MAX_CONCURRENT_RUNS` | whole number 1-100 | `4` | Model calls one owner may have running at once (replies, drafts, memory calls) | no | per request (claim port-impl.ts:496, owner-call.ts:133, memory/call.ts:205) | limits/rate | 689 |
| `AGENT_MAX_CONCURRENT_OTHERS_RUNS` | whole number 1-100; <= `AGENT_MAX_CONCURRENT_RUNS` | `3` | Of those, places for replies someone else called for | no | per request (claim port-impl.ts:497) | limits/rate | 691, 958-962 |
| `AGENT_RUNS_PER_MINUTE` | whole number 1-10 000 | `20` | Replies an owner may start per minute in their own lane (not scaled) | no | per request (runs.ts:340) | limits/rate | 693 |
| `AGENT_OTHERS_RUNS_PER_MINUTE` | whole number 1-10 000 | `20` | Replies an owner's Agents may start per minute for others/proactive, together | no | per request (runs.ts:340) | limits/rate | 695 |
| `AGENT_CALLER_RUNS_PER_MINUTE` | whole number 1-10 000 | `5` | Calls one person may make per minute on other people's Agents | no | per request (runs.ts:846) | limits/rate | 697 |
| `AGENT_RUN_TIMEOUT_MS` | whole number 1 000-3 600 000 | `120000` | Deadline of a reply/draft/memory call (and of reading its attachments) | no | startup (worker app.ts:525) + per call (port-impl.ts:827, memory/call.ts:223, `draftDeadlineMs` 928-930) | agents | 699 |
| `PROVIDER_DEFAULT_CONTEXT_TOKENS` | whole number 1 000-2 000 000; > `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` | `16000` | Context of a provider model whose owner gives none | no | per request | models/providers | 701, 990-994 |
| `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` | whole number 1-1 000 000 | `2048` | Output limit of every provider-model call | no | per request | models/providers | 703 |
| `REASONING_ALLOWANCE_TOKENS` | JSON strict object `{low,medium,high,xhigh,max}`, each optional | see fields | Thinking tokens added to the output limit per reasoning level | no | per request (resolve.ts:130,158) | models/providers | 705 (schema 591-609, defaults 53) |
| `REASONING_ALLOWANCE_TOKENS.low` | int 0-200 000 | `2000` | Allowance at `low` | no | per request | models/providers | 595, 53 |
| `REASONING_ALLOWANCE_TOKENS.medium` | int 0-200 000 | `6000` | Allowance at `medium` | no | per request | models/providers | 596, 53 |
| `REASONING_ALLOWANCE_TOKENS.high` | int 0-200 000 | `12000` | Allowance at `high` | no | per request | models/providers | 597, 53 |
| `REASONING_ALLOWANCE_TOKENS.xhigh` | int 0-200 000 | `24000` | Allowance at `xhigh` | no | per request | models/providers | 598, 53 |
| `REASONING_ALLOWANCE_TOKENS.max` | int 0-200 000 | `48000` | Allowance at `max` | no | per request | models/providers | 599, 53 |
| `PROVIDER_MAX_CONCURRENT_CALLS` | whole number 1-1 000 | `64` | Provider and site-model calls in flight in the whole service | no | startup (createSlots app.ts:293) | limits/rate | 707 |
| `AGENT_MAX_RUNS_IN_FLIGHT` | whole number 1-64 | `16` | Replies the worker runs at once, all owners together | no | startup (worker app.ts:526) | limits/rate | 709 |
| `AGENT_CHAIN_LIMIT` | whole number 2-500 | `30` | After this many Agent-only messages in a group, Agent messages call no Agent | no | per request (runs.ts:1237) | agents | 711 |
| `AGENT_GROUP_CONTEXT_TOKENS` | whole number 2 000-200 000 | `12000` | Most group history (tokens) a reply in a group is shown | no | per request (port-impl.ts:758) | agents | 713 |
| `JUDGE` | JSON strict object or `null`; unset/empty = null | `null` (no proactive replies) | The judgement model for unprompted replies and memory checks | no (keys sit in named variables) | startup (createJudge app.ts:309; scheduler built only if set app.ts:440-460) | models/providers | 715 (schema 120-133; checks 981-987) |
| `JUDGE.model` | string 1-200 | required | Model name sent with every judgement | no | startup (client) | models/providers | 121 |
| `JUDGE.channels` | array of 1-2 strict `{url, apiKeyEnv}` | required | Endpoints tried in order | no | startup (client) | models/providers | 122-130 |
| `JUDGE.channels[].url` | `z.url()`; no `?`/`#`; https/no-credentials rule; kept exactly as given | required | The endpoint POSTed to | no | startup (client) | models/providers | 125, 983-985 |
| `JUDGE.channels[].apiKeyEnv` | env-var name; not a service secret; the named variable must be set | required | Which variable holds the channel key | no (it is only a name) | startup check + per call | models/providers | 126, 986 |
| `JUDGE.timeoutMs` | int 500-30 000 | `4000` | How long one channel may take | no | startup (guardedFetch in createJudge, judge/client.ts) | models/providers | 131 |
| `JUDGE.dailyLimit` | int 1-10 000 000 | `20000` | Judgements per site day, at most | no | per request (decide.ts:82,120; memory/sort.ts:93) | limits/rate | 132 |
| `PROACTIVE` | JSON strict object, every field optional | all defaults | Proactive-reply tunings | no | mixed (see fields); used only when `JUDGE` is set | agents | 717 (schema 161-176) |
| `PROACTIVE.debounceMs` | int 1-60 000 | `3000` | Quiet time after a message before the group is judged | no | startup (scheduler app.ts:457) | agents | 162 |
| `PROACTIVE.transcriptMessages` | int 1-100 | `15` | Group messages the judge is shown | no | per request (decide.ts) | agents | 163 |
| `PROACTIVE.transcriptChars` | int 1-5 000 | `300` | Characters of each shown message | no | per request | agents | 164 |
| `PROACTIVE.base.less` | number 0-1 | `0.8` | Starting threshold, level `less` | no | per request | agents | 165 |
| `PROACTIVE.base.normal` | number 0-1 | `0.65` | Starting threshold, level `normal` | no | per request | agents | 165 |
| `PROACTIVE.base.more` | number 0-1 | `0.5` | Starting threshold, level `more` | no | per request | agents | 165 |
| `PROACTIVE.surchargeStep` | number 0-1 | `0.1` | What each proactive reply adds to the Agent's threshold in that group | no | per request | agents | 166 |
| `PROACTIVE.surchargeMax` | number 0-1 | `0.25` | Most the surcharge reaches | no | per request | agents | 167 |
| `PROACTIVE.surchargeHalfLifeS` | int 1-86 400 | `120` | Surcharge halves every this many seconds | no | per request | agents | 168 |
| `PROACTIVE.surchargeHalfMessages` | int 1-1 000 | `4` | ...or every this many others' messages | no | per request | agents | 169 |
| `PROACTIVE.quietBig.at` | number 0-1 | `0.8` | Sure-quiet answer line (also posts `agent_quieted`) | no | per request | agents | 170 |
| `PROACTIVE.quietBig.raise` | number 0-1 | `0.33` | Threshold raise for a sure-quiet answer | no | per request | agents | 170 |
| `PROACTIVE.quietBig.halfLifeS` | int 1-604 800 | `3600` | Half-life of that raise | no | per request | agents | 170 |
| `PROACTIVE.quietSmall.at` | number 0-1 | `0.3` | Mild-quiet answer line (also the hush rule's line) | no | per request | agents | 171 |
| `PROACTIVE.quietSmall.raise` | number 0-1 | `0.15` | Threshold raise for a mild-quiet answer | no | per request | agents | 171 |
| `PROACTIVE.quietSmall.halfLifeS` | int 1-604 800 | `600` | Half-life of that raise | no | per request | agents | 171 |
| `PROACTIVE.cap` | number 0-1 | `0.98` | Highest a threshold goes | no | per request | agents | 172 |
| `PROACTIVE.fuse.perSeconds` | int 1-3 600 | `10` | At most one proactive reply per Agent and group within this many seconds | no | per request | limits/rate | 173 |
| `PROACTIVE.fuse.perHour` | int 1-100 000 | `30` | ...and this many within an hour | no | per request | limits/rate | 173 |
| `PROACTIVE.perGroupHour` | int 1-100 000 | `600` | Judgements per group per hour, at most (in-process count) | no | startup (scheduler app.ts:458) | limits/rate | 174 |
| `PROACTIVE.perSenderHour` | int 1-100 000 | `300` | Judgements about one sender's messages per hour (in-process count) | no | startup (scheduler app.ts:459) | limits/rate | 175 |
| `MEMORY` | JSON strict object, every field optional; legacy `reviewMessageChars` read as `reviewMessageWeight` | all defaults | Agent memory tunings | no | mixed (see fields) | agents | 719 (schema 539-589; alias 532-537) |
| `MEMORY.model` | string 1-200 or `null` | `null` (cheapest free-tier site model) | Site model the background memory calls use | no | per request (memory/call.ts:32) | models/providers | 540 |
| `MEMORY.roomOwner` | int 1-3 000 (DB guard 9000 chars, migration 039) | `2000` | Size limit (weight) of notes about the owner | no | per request | agents | 542 |
| `MEMORY.roomSelf` | int 1-3 000 | `3000` | Size limit of the Agent's own notes | no | per request | agents | 543 |
| `MEMORY.roomHearsay` | int 1-3 000 | `2000` | Size limit of hearsay notes | no | per request | agents | 544 |
| `MEMORY.modelEntryMax` | int 1-200 | `200` | Longest model-written entry (weight) | no | startup (`setModelEntryMax`, module global, app.ts:289) | agents | 545 |
| `MEMORY.quietMs` | int 1-86 400 000 | `600000` | Quiet before reviewing the owner's own conversation | no | per request (timer armed, reviewer.ts:282) | agents | 546 |
| `MEMORY.maxReplies` | int 1-1 000 | `8` | ...or after this many replies | no | per request | agents | 547 |
| `MEMORY.groupQuietMs` | int 1-86 400 000 | `120000` | Quiet before acting on a group's flags | no | per request (reviewer.ts:292) | agents | 548 |
| `MEMORY.groupMaxWaitMs` | int 1-86 400 000 | `900000` | Longest wait after the first flagged message | no | per request (reviewer.ts:302) | agents | 549 |
| `MEMORY.reviewMessages` | int 1-500 | `40` | Messages a review shows | no | per request | agents | 550 |
| `MEMORY.reviewMessageWeight` | int 1-20 000 | `500` | Weight each reviewed message is cut to | no | per request | agents | 551 |
| `MEMORY.reviewMaxOutputTokens` | int 1-100 000 | `2000` | Max answer of a review/hearsay call/dream | no | per request | agents | 552 |
| `MEMORY.shareAt` | number 0-1 | `0.6` | Judge threshold: out of the vault | no | per request | agents | 553 |
| `MEMORY.sameAt` | number 0-1 | `0.8` | Judge threshold: same note (duplicate) | no | per request | agents | 554 |
| `MEMORY.hearsayAt` | number 0-1 | `0.65` | Judge threshold: hearsay worth flagging | no | per request | agents | 555 |
| `MEMORY.ownAt` | number 0-1 | `0.6` | Judge threshold: owner's remark worth flagging | no | per request | agents | 556 |
| `MEMORY.flaggedMax` | int 1-500 | `20` | Flagged messages reviewed together | no | per request | agents | 557 |
| `MEMORY.flaggedContext` | int 0-50 | `3` | Context messages per flagged message | no | per request | agents | 558 |
| `MEMORY.hearsayPerHour` | int 1-1 000 | `4` | Paid hearsay calls per Agent and group per rolling hour (in-process count) | no | per request (hearsay.ts:418) | limits/rate | 559 |
| `MEMORY.catchUpLines` | int 1-10 000 | `200` | Most recent lines caught up per group | no | per request | agents | 560 |
| `MEMORY.catchUpDays` | int 1-365 | `30` | Oldest lines caught up, in days | no | per request | agents | 561 |
| `MEMORY.hearsayNewAt` | number 0-1 | `0.7` | Pre-check: below it, no hearsay call | no | per request | agents | 562 |
| `MEMORY.hearsayAbuseAt` | number 0-1 | `0.6` | Pre-check: at or above it, flooding/probing | no | per request | agents | 563 |
| `MEMORY.hearsayMuteMs` | int 1-31 536 000 000 | `21600000` | How long a flooding speaker is not listened to | no | per request (hearsay.ts:439) | agents | 564 |
| `MEMORY.hearsayMute` | `off` \| `observe` \| `on` | `observe` | What a flooding verdict does | no | per request | agents | 565 |
| `MEMORY.listenShare` | number 0-1 | `0.5` | Share of `JUDGE.dailyLimit` after which listen-only judgements stop | no | per request (decide.ts:121) | limits/rate | 566 |
| `MEMORY.dreamSweepMs` | int 1-86 400 000 | `900000` | How often the dream sweep looks for owners | no | per request (re-read each re-arm, reviewer.ts:234) | agents | 567 |
| `MEMORY.dreamIdleMs` | int 1-604 800 000 | `10800000` | Owner idle time before a dream | no | per request | agents | 568 |
| `MEMORY.dreamEveryMs` | int 1-2 592 000 000 | `72000000` | Least time between dreams/naps | no | per request | agents | 569 |
| `MEMORY.napAt` | number 0-1 | `0.8` | Room fill share that triggers a nap | no | per request | agents | 570 |
| `MEMORY.faithfulAt` | number 0-1 | `0.6` | Judge certainty needed to apply a dream's merge/rewrite/split | no | per request | agents | 571 |
| `MEMORY.judgePerOwnerDay` | int 1-1 000 000 | `300` | Memory judgements per owner per site day | no | per request | limits/rate | 572 |
| `MEMORY.judgeShare` | number 0-1 | `0.5` | Share of `JUDGE.dailyLimit` memory may use | no | per request (memory/sort.ts:93) | limits/rate | 573 |
| `MEMORY.explicitAt` | number 0-1 and > 0 | `0.7` | Certainty that the owner asked to forget, for a `remove` to apply at once | no | per request | agents | 575 |
| `MEMORY.mergeAuto` | `off` \| `on` | `on` | Whether a review's `merge` op joins notes verbatim | no | per request | agents | 577 |
| `MEMORY.roomNotes` | int 1-100 000 | `150` | Max notes per room | no | per request | agents | 578 |
| `MEMORY.passageShare` | number > 0 and <= 1 | `0.25` | Max share of context the notes passage takes | no | per request | agents | 579 |
| `MEMORY.freeDailyPoints` | int 0-1 000 000 (whole points) | `20` | Site-paid memory allowance per owner per site day | no | per request | metering/points/pricing | 580 |
| `MEMORY.changesSweepMs` | int 0 or 60 000-86 400 000 | `3600000` | Timer for the memory-change and whisper sweep (0: none) | no | startup (timer app.ts:401-407) | agents | 582 |
| `MEMORY.summaryMaxWeight` | int 1-2 000 (DB guard 256 KiB, migration 059) | `1000` | Max weight of a rolling summary | no | per request | agents | 584 |
| `MEMORY.summaryMinFoldWeight` | int 1-100 000, optional | `floor(summaryMaxWeight / 2)` = 500 | Least weight that triggers a fold | no | per request | agents | 586, 589 |
| `MEMORY.summaryMinIntervalMs` | int 0-86 400 000 | `600000` | Least time between a pair's summaries | no | per request (summary/job.ts:448) | agents | 588 |
| `TOOLS` | JSON strict object, every field optional | all defaults | Bounds of a reply's tools, plus web search | no | mixed (see fields) | agents | 721 (schema 336-346) |
| `TOOLS.enabled` | boolean | `true` | Site switch for all tools | no | per request (port-impl.ts:780) | agents | 337 |
| `TOOLS.maxRounds` | int 1-50 | `8` | Tool rounds per reply | no | per request (worker.ts:573) | agents | 338 |
| `TOOLS.maxPoints` | int 1-100 000 (whole points) | `20` | Points a reply's later tool rounds may spend | no | per request (port-impl.ts:1106) | metering/points/pricing | 339 |
| `TOOLS.searchPerReply` | int 1-1 000 | `6` | Message-search tool calls per reply | no | startup (destructured in createToolbox, tools/index.ts:144) | agents | 340 |
| `TOOLS.filePerReply` | int 1-1 000 | `4` | File tool calls per reply | no | startup (tools/index.ts:144) | agents | 341 |
| `TOOLS.timePerReply` | int 1-1 000 | `1` | Clock tool calls per reply | no | startup (tools/index.ts:144) | agents | 342 |
| `TOOLS.resultMaxWeight` | int 1-100 000 | `3000` | Max weight of one tool result | no | per request | agents | 343 |
| `TOOLS.runTimeoutMs` | int 1 000-3 600 000 | `300000` | Total deadline of a reply that offers tools | no | per request (worker.ts:553; stale sweep port-impl.ts:1573) | agents | 344 |
| `TOOLS.web.enabled` | boolean | `false` | Site switch for web search | no | startup (`webEngineOf` app.ts:245, 349) | web search | 291 |
| `TOOLS.web.engine` | `exa_search` \| `deepseek_messages` | `exa_search` | Which engine adapter is used | no | startup | web search | 292 |
| `TOOLS.web.baseUrl` | `z.url()` starting `https://`, optional; host must be the engine's own unless `baseUrlProxy` | by engine: `https://api.exa.ai` / `https://api.deepseek.com` | Engine address | no | startup (app.ts:256) | web search | 293-296, 311-316, 322, 278-279 |
| `TOOLS.web.baseUrlProxy` | boolean | `false` | Allows a host other than the engine's own (a proxy) | no | startup (validation only; not in the output object) | web search | 297, 313 |
| `TOOLS.web.apiKeyEnv` | env-var name, optional. NOT checked against `SERVICE_SECRET_VARIABLES` and not required to be set | by engine: `WEB_SEARCH_API_KEY` / `WEB_SEARCH_DEEPSEEK_API_KEY` | Which variable holds the engine key | no (it is only a name) | startup (key read once, app.ts:251) | web search | 298, 323, 278-279 |
| `TOOLS.web.model` | string 1-200 | `deepseek-flash` | DeepSeek model (deepseek only) | no | startup | web search | 299 |
| `TOOLS.web.exaType` | `auto` \| `lite` \| `fast` | `auto` | Exa search type (exa only) | no | startup | web search | 300 |
| `TOOLS.web.pointsMicroPerSearch` | int 0-1 000 000 000 000, optional | by engine: `13000000` / `770350` | Fixed charge per search, in micro-points | no | per request (hold.ts:175; models/routes.ts:66) | metering/points/pricing | 301, 326, 278-279 |
| `TOOLS.web.perReply` | int 1-20 | `3` | Web searches per reply | no | per request (offer, tools/index.ts:156) | web search | 302 |
| `TOOLS.web.costMicroUsdPerSearch` | int 1-1 000 000 000, optional | by engine: `13000` / `2000` | Site's estimated cost per search, for the money fuse | no | per request (hold.ts:191) | web search | 303, 328, 278-279 |
| `TOOLS.web.siteUsdPerDay` | number 0-1 000 000 | `20` | The site's daily USD fuse for searches (0: search not offered) | no | startup (0 check app.ts:247) + per request (hold.ts:58) | web search | 304 |
| `TOOLS.web.maxAtOnce` | int 1-100 | `4` | Engine calls in flight in the service | no | startup (slots, tools/index.ts:147) | limits/rate | 305 |
| `TOOLS.web.timeoutMs` | int 1 000-120 000 | `15000` | Deadline of one engine call | no | startup (engine, app.ts:256) | web search | 306 |
| `TOOLS.web.maxResults` | int 1-20 | `6` | Results handed to the model per search | no | startup (engine) + per request (tool.ts) | web search | 307 |
| `HOLDS` | JSON strict object | `{maxOpenShare:1}` | Admission rule for open holds | no | per request | metering/points/pricing | 723 (schema 363-365) |
| `HOLDS.maxOpenShare` | number 0.01-1 | `1` | Share of a source's remainder the open holds may add up to | no | per request (admit.ts:220) | metering/points/pricing | 364 |
| `ALLOWANCE` | JSON strict object | `{warnAt:0.8}` | Low-allowance reminder | no | per request | metering/points/pricing | 725 (schema 373-375) |
| `ALLOWANCE.warnAt` | number > 0 and < 1 | `0.8` | Share used at which the owner is told, once a day | no | per request (reminders.ts:80) | metering/points/pricing | 374 |
| `WHISPERS` | JSON strict object | `{elsewhereTtlHours:24}` | Whisper lifetimes | no | per request | other | 727 (schema 386-388) |
| `WHISPERS.elsewhereTtlHours` | int 1-168 | `24` | Hours a `found_elsewhere` whisper stays open | no | per request (sweep app.ts:219; runs/port-impl) | other | 387 |
| `AGENTS` | JSON strict object | `{autoRetryDelaysMs:[20000,120000]}` | Automatic retry of failed replies | no | per request | agents | 729 (schema 400-402) |
| `AGENTS.autoRetryDelaysMs` | array of at most 2 ints, each 0-600 000; `[]` = off | `[20000, 120000]` | Waits before each automatic retry | no | per request (runs.ts:1679) | agents | 401 |
| `BLOB_DIR` | string, min length 1 | `./data/blobs` | Filesystem blob store directory (unused when S3 is set) | no | startup (createBlobStore, blob.ts:112) | attachments | 730 |
| `WEB_DIST` | optional string (empty = unset); resolved to an absolute path; must contain `index.html` | unset (no web files served) | Built web client directory to serve | no | startup (registerWebClient, web.ts:74) | infrastructure | 732, 1045 |
| `PORT` | `z.coerce.number()` int 0-65 535 | `3000` | Listen port | no | startup (server.ts:16) | infrastructure | 733 |
| `HOST` | IPv4/IPv6 address or `localhost` | `0.0.0.0` | Bind address | no | startup (server.ts:16) | infrastructure | 735-737 |
| `S3_ENDPOINT` | optional string; all five S3 vars together or none | unset | S3 endpoint (with all five set, S3 replaces BLOB_DIR) | no | startup (blob store) | attachments | 738, 951-957 |
| `S3_REGION` | optional string; all or none | unset | S3 region | no | startup | attachments | 739, 951-957 |
| `S3_BUCKET` | optional string; all or none | unset | S3 bucket | no | startup | attachments | 740, 951-957 |
| `S3_ACCESS_KEY_ID` | optional string; all or none | unset | S3 access key id (listed in SERVICE_SECRET_VARIABLES) | yes | startup | attachments | 741, 56, 951-957 |
| `S3_SECRET_ACCESS_KEY` | optional string; all or none | unset | S3 secret | yes | startup | attachments | 742, 56, 951-957 |
| `REGISTRATION_MODE` | `invite` \| `open` | `invite` | Whether sign-up needs an invite | no | per request (register.ts:67) | auth/accounts | 743 |
| `MAIL_MODE` | `outbox` \| `resend` | `outbox` | Write mail only to `mail_outbox`, or also deliver through Resend | no | startup (mail sender app.ts:559; mailPolicy in createAuth auth.ts:230) + per request (register.ts:89) | email | 745 |
| `RESEND_API_KEY` | optional string; required when `MAIL_MODE=resend`; ignored otherwise | unset | Resend API key | yes | startup (mailSettings 933-942 -> mail sender) | email | 747, 935 |
| `MAIL_FROM` | optional string, one line; required when `resend` | unset | Sender of every mail | no | startup | email | 749, 936-940 |
| `MAIL_REPLY_TO` | optional string, one line | unset | Reply-To address | no | startup | email | 751, 938-940 |
| `MAIL_PER_ADDRESS_HOUR` | whole number 1-1 000 | `5` | Mails of one kind delivered to one address per hour | no | startup (auth.ts:230) + per request (register.ts:89) | email | 753 |
| `CLIENT_IP_HEADER` | optional header name (HTTP token characters only: letters, digits and the punctuation in the regex at line 758), lower-cased | unset | Header the proxy sets to the client address | no | per request (limits.ts:20) | security/crypto | 755-761 |
| `TRUST_PROXY` | unset/empty/`false`/`0` -> trust none; else comma list of IPs/CIDRs; `true` and hop counts refused | unset (`false`) | Which proxies' X-Forwarded-For Fastify reads | no | startup (Fastify option app.ts:323) | security/crypto | 763-770 (parser 10-37) |
| `RATE_LIMIT_SCALE` | `z.coerce.number()` > 0 (fractions allowed) | `1` | Multiplier on every route rate limit (tests raise it) | no | startup (limiters built at route registration: app.ts:423,573; limits.ts:56) | limits/rate | 772 |
| `ATTACHMENT_MAX_BYTES` | whole number 1 048 576-5 368 709 120; <= quota | `1073741824` (1 GiB) | Largest single upload | no | per request (attachments/routes.ts:279,307) | attachments | 774, 995-999 |
| `ATTACHMENT_QUOTA_BYTES` | `z.coerce.number()` int > 0 (no max) | `21474836480` (20 GiB) | Attachment bytes one principal may store | no | per request (attachments/routes.ts:272,293) | attachments | 776 |
| `UPLOAD_IDLE_TIMEOUT_MS` | coerce int > 0; < `HTTP_CONNECTION_TIMEOUT_MS` | `45000` | Upload cut off after this long without body bytes | no | per request (attachments/routes.ts:264) | attachments | 778, 1002-1004 |
| `UPLOAD_TOTAL_TIMEOUT_MS` | coerce int > 0; < effective `HTTP_REQUEST_TIMEOUT_MS` | `3600000` | Upload cut off after this long in all | no | per request (routes.ts:264; sweeper pending.ts:20) | attachments | 780, 1005-1007 |
| `HTTP_CONNECTION_TIMEOUT_MS` | coerce int > 0; > upload idle; >= 20 000 | `120000` | Fastify `connectionTimeout` (socket idle); also bounds persona drafts | no | startup (app.ts:328) + per request (`draftDeadlineMs`) | infrastructure | 782, 1002-1013 |
| `HTTP_REQUEST_TIMEOUT_MS` | optional -> `Number()` -> int > 0; > upload total | `UPLOAD_TOTAL_TIMEOUT_MS + 60000` (3 660 000) | Fastify `requestTimeout` | no | startup (app.ts:329) | infrastructure | 784-786, 1001, 1005 |
| `HTTP_KEEP_ALIVE_TIMEOUT_MS` | coerce int > 0 | `72000` | Fastify `keepAliveTimeout` | no | startup (app.ts:330) | infrastructure | 788 |
| `HTTP_BODY_TIMEOUT_MS` | coerce int > 0 | `30000` | Body must arrive whole this long after the head | no | startup (registerBodyDeadline app.ts:389) | infrastructure | 790 |
| `DB_STATEMENT_TIMEOUT_MS` | coerce int > 0 | `30000` | Postgres `statement_timeout` on every pool connection (app and CLI) | no | startup (pool app.ts:298, cli.ts:109) | infrastructure | 792 |
| `DB_ACQUIRE_TIMEOUT_MS` | coerce int > 0 | `10000` | Wait for a pool connection before 503 | no | startup (pool) | infrastructure | 794 |
| `SWEEP_INTERVAL_MINUTES` | `^[0-9]{1,4}$`, at most 1 440; 0 = off | `15` | Attachment sweep interval (also reminders, whisper expiry, search-day sweep) | no | startup (startSweeper app.ts:398-404) | attachments | 796-800 |
| `SEARCH_STATEMENT_TIMEOUT_MS` | coerce int > 0 | `3000` | `statement_timeout` inside each search | no | per request (messages/routes.ts:155; tools/search.ts:175) | infrastructure | 802 |
| *variable named by `SITE_MODELS[].apiKeyEnv`* | any name not in SERVICE_SECRET_VARIABLES; must be set and non-empty at startup | none | Upstream key of that site model | yes | startup presence check (620-621) + value read from `process.env` at every call (resolve.ts:43) | models/providers | 616-622, 980 |
| *variable named by `JUDGE.channels[].apiKeyEnv`* | same rule | none | Key of that judge channel | yes | startup presence check + value read per attempt (judge/client.ts:107,125) | models/providers | 616-622, 986 |
| `WEB_SEARCH_API_KEY` | default name of `TOOLS.web.apiKeyEnv` for `exa_search`; unset -> search not offered (warning) | unset | Exa key | yes | startup (read once, app.ts:251) | web search | 278 |
| `WEB_SEARCH_DEEPSEEK_API_KEY` | default name for `deepseek_messages`; same | unset | DeepSeek search key | yes | startup (app.ts:251) | web search | 279 |

## 2. Notes

### (a) Settings cross-validated against each other
Start-up throws on the first failure. These checks live only in `loadConfig`.
1. `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` must all be set or all be unset (951-957). With all five set, S3 replaces `BLOB_DIR` (1048-1058; blob.ts:112).
2. `AGENT_MAX_CONCURRENT_OTHERS_RUNS` <= `AGENT_MAX_CONCURRENT_RUNS` (958-962). Setting only RUNS below 3 therefore fails.
3. For each `SITE_MODELS` entry: `baseUrl` has no `?`/`#` and passes `normaliseBaseUrl` (it is normalised in place, 963-973), and `contextTokens` > `maxOutputTokens` (974-978).
4. Each `SITE_MODELS[].apiKeyEnv` and each `JUDGE.channels[].apiKeyEnv` must not be one of `SERVICE_SECRET_VARIABLES` (56: DATABASE_URL, AUTH_SECRET, PROVIDER_KEY_SECRET, S3_SECRET_ACCESS_KEY, S3_ACCESS_KEY_ID, RESEND_API_KEY; case ignored), and the variable it names must be set and non-empty (616-622, 980, 986). `TOOLS.web.apiKeyEnv` gets neither check.
5. `JUDGE.channels[].url`: no `?`/`#` and passes the https rule. It is kept as given, not normalised (981-985).
6. `SITE_MODELS[].id` must be unique (988-989).
7. `PROVIDER_DEFAULT_CONTEXT_TOKENS` > `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` (990-994).
8. `ATTACHMENT_MAX_BYTES` <= `ATTACHMENT_QUOTA_BYTES` (995-999).
9. Timeouts:
   - effective `HTTP_REQUEST_TIMEOUT_MS` (default `UPLOAD_TOTAL_TIMEOUT_MS + 60000`, 1001) > `UPLOAD_TOTAL_TIMEOUT_MS` (1005-1007)
   - `HTTP_CONNECTION_TIMEOUT_MS` > `UPLOAD_IDLE_TIMEOUT_MS` (1002-1004)
   - `HTTP_CONNECTION_TIMEOUT_MS - 10000` >= 10000, so it is at least 20 000 (1009-1013; constants 919-921)
   - the persona-draft deadline is `min(AGENT_RUN_TIMEOUT_MS, HTTP_CONNECTION_TIMEOUT_MS - 10000)` (928-930)
10. `MAIL_MODE=resend` requires `RESEND_API_KEY` and `MAIL_FROM`. `MAIL_FROM` and `MAIL_REPLY_TO` must be one line. In `outbox` mode all three are ignored (933-942).
11. `TOOLS.web`:
    - `baseUrl`'s host must be the engine's default host unless `baseUrlProxy` is true (311-316)
    - `baseUrl`, `apiKeyEnv`, `pointsMicroPerSearch` and `costMicroUsdPerSearch` default from `engine` through `WEB_ENGINE_DEFAULTS` (277-280, 317-333)
    - the removed keys `perOwnerPerDay` and `sitePerDay` are refused (283-287, 308-309)
12. `MEMORY.summaryMinFoldWeight` defaults to `floor(summaryMaxWeight/2)` (589). There is no check that it is <= `summaryMaxWeight`.
13. Couplings used at run time but not validated:
    - `MEMORY.judgeShare` x `JUDGE.dailyLimit` (memory/sort.ts:93) and `MEMORY.listenShare` x `JUDGE.dailyLimit` (decide.ts:121)
    - the stale-run threshold is `2 x max(AGENT_RUN_TIMEOUT_MS, TOOLS.runTimeoutMs) + 60000` (port-impl.ts:1573-1574)
    - the summary claim lasts `AGENT_RUN_TIMEOUT_MS + 60000` (summary/job.ts:107)
    - an upload is abandoned after `UPLOAD_TOTAL_TIMEOUT_MS` + grace (pending.ts:20)
    - `PROACTIVE` is used only when `JUDGE` is set
    - web search is silently off when `siteUsdPerDay = 0` or its key variable is empty (app.ts:247-254)
    - nothing checks PROACTIVE orderings such as `quietSmall.at` < `quietBig.at` or `surchargeMax` vs `cap`

### (b) What the README says must stay in the environment, or is dangerous to change
- `PROVIDER_KEY_SECRET` is required. Changing it makes every stored provider key unreadable: calls become `provider_rejected` until owners save their keys again. Keep it with the database backups (README 67-69, 1678-1683).
- Upstream keys never go into the JSON. `SITE_MODELS`, `JUDGE` and `TOOLS.web` name another variable through `apiKeyEnv` "so the JSON carries no secret" (74-77, 137-139, 4038-4040). That variable must not be one of the service's own secrets (76-77). `RESEND_API_KEY` is "a secret" (164); config.ts 746 adds that it is never logged and never put in a payload or an error.
- `AGENT_MAX_RUNS_IN_FLIGHT`: the worst case is about this x 20 MiB x 5 copies, roughly 1.6 GiB at the default. Lower it on a small container (112-114).
- The ordering of the HTTP timeouts is load-bearing: connection >= 20 s, and the server-wide timeouts must be longer than the upload deadlines (179-184). `DB_STATEMENT_TIMEOUT_MS` also applies to the CLI's pool (185-188). `SWEEP_INTERVAL_MINUTES` <= 1440 because a longer delay overflows Node's timers (config.ts 795).
- `answerFloor` and `allowInsecureLocal` are build options. "No variable can turn it on" (allowInsecureLocal), and only tests change them (194-200). They must not become settings.
- `JUDGE` removed: an Agent left proactive stays proactive but inert (4048). `MEMORY.changesSweepMs = 0` also stops whisper expiry (4097).
- Some caps are tied to database guards: `MEMORY.room*` <= 3000 (migration 039) and `summaryMaxWeight` <= 2000 (migration 059) (README 4077, 4102; config.ts 541, 583).
- The service is one process by design. State is per process: the proactive scheduler and its per-group/per-sender counts, the hearsay hour counts (a restart resets them, 1261), and the timers. A deploy may briefly overlap old and new instances (3943), so two configurations can be live at once.

### (c) README versus code mismatches
- `SERVICE_SECRET_VARIABLES` in code includes `RESEND_API_KEY` (56). The README's lists name only five (76-77, and the JUDGE section 4039-4040).
- `TOOLS.web.apiKeyEnv` is not checked against `SERVICE_SECRET_VARIABLES` and is not required to be set: only `SITE_MODELS` and `JUDGE` call `checkKeyVariable` (980, 986). The README does not say either way.
- `SITE_MODELS[].reasoning`: the README says "levels from low..max", but code also accepts `none` (41, 105).
- Defaults and ranges the README config section leaves out:
  - `BLOB_DIR` default `./data/blobs` (730)
  - `PORT` 0-65535, default 3000 (733)
  - `RATE_LIMIT_SCALE` > 0, fractions allowed (772)
  - `MAIL_PER_ADDRESS_HOUR` 1-1000 (753)
  - the `TOOLS.web` ranges: `pointsMicroPerSearch` 0-1e12, `costMicroUsdPerSearch` 1-1e9, `siteUsdPerDay` 0-1e6, `maxAtOnce` 1-100 (301-305)
  - `ATTACHMENT_QUOTA_BYTES` has no upper bound (776)
- The README says "an invalid value stops the service" (192). But for `z.coerce` fields an empty string becomes 0: `PORT=""` is accepted as port 0 (an OS-chosen port), and the others fail `.positive()`.
- Read outside config.ts:
  - `NODE_ENV` and `VITEST` turn the logger off (app.ts:316-322)
  - `TEST_DATABASE_URL` is used by tests (README 196)
  - most CLI commands read `DATABASE_URL` straight from `process.env` (cli.ts:22)
  - the web-search key is read in app.ts:251, and site-model and judge keys in resolve.ts:43 and judge/client.ts:125
  - `dotenv` loads `.env` into `process.env` first (server.ts:1,5; cli.ts:1,15)
- Removed or renamed keys:
  - `MEMORY.reviewMessageChars` is still read as an alias (532-537)
  - `TOOLS.web.perOwnerPerDay` and `sitePerDay` are refused explicitly (308-309)
  - `MEMORY.summaryMinMessages` and `mergeAuto: "observe"` (README 4095, 4100) are refused only by strictness
- Hard-coded values that are not settings:
  - pool size 10 (README 190)
  - 8 proactive decisions in flight (README 216; scheduler `MAX_DECISIONS_AT_ONCE`)
  - `DRAFT_SOCKET_MARGIN_MS` and `MIN_DRAFT_DEADLINE_MS` = 10 000 (919-921)
  - logger level `info` (app.ts:318-322)
  - whispers 7 days, the memory-change record 30 days
- No observability settings exist in config.ts.

### (d) How config is loaded and frozen
`server.ts` calls `loadDotenv` (line 5) and then `loadConfig()` once (line 6), and passes the result to `buildApp({ config })` (line 7). `buildApp` uses `overrides.config ?? loadConfig()` (app.ts:287). The CLI calls `loadConfig()` per command (cli.ts:108, 147, 180).

`loadConfig` (config.ts 944-1079) works in three steps:
1. One `envSchema.safeParse(env)` (945). Every schema issue is joined into one `Invalid configuration` error (946-949). JSON variables are parsed inside it by `jsonVariable` (625-642).
2. Imperative cross-checks, each throwing on the first failure (951-1013).
3. A plain `Config` object is returned (1014-1078).

The object is not frozen. Only `DEFAULT_TOOLS` (349) and `DEFAULT_WHISPERS` (405) are `Object.freeze`d, and `SITE_MODELS[].baseUrl` is even mutated in place (973). Nothing re-reads or re-parses the configuration after start: there is no watcher, no SIGHUP handler and no reload path.

Values reach the code in two ways:
- **Copied at startup** into long-lived things:
  - Fastify options (app.ts:323-330), the pg pool (298), slots (293), the worker (525-526)
  - the sweep timers (398-407) and the proactive scheduler (457-459)
  - route limiters (423, 573), the Better Auth instance (auth.ts:230-238), the toolbox (tools/index.ts:144-147) and the web engine (app.ts:240-258)
  - module globals (`setModelEntryMax` app.ts:289, `configureStats` app.ts:464)
- **Read through the shared object reference** at use time: everything else.

The only values looked up again later are the upstream keys named by `apiKeyEnv` (`process.env[...]` at each call: resolve.ts:43, judge/client.ts:125). `process.env` is not refreshed in a running process, so those are effectively fixed at start too.
