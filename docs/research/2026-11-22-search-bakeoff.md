# Provider-side web search: zh / ja / en bake-off (2026-11-22)

Run by `.claude/search/bakeoff.mjs` (controller tool, untracked; raw answers in `.claude/search/bakeoff-out.json`). 15 questions (5 Chinese, 5 Japanese, 5 English: weather, this week's news, a price, a local recommendation, a rule or schedule). Each provider got the same system line with today's date and its own built-in search tool. One run each; no repeats, so latency figures are single samples.

| | DeepSeek `deepseek-flash` + `deepseek_web_search` | Claude `claude-haiku-5-5` + `web_search` (via CanalAPI `/v1/messages`) | OpenAI `gpt-5-mini` (reasoning low) + `web_search` (Responses) |
|---|---|---|---|
| Worked | 15/15 | 15/15 | 15/15 |
| Time to full answer | 1.8–3.6 s (median 2.1) | 3.6–7.9 s (median 5.2) | 5.5–21.7 s (median 14.8) |
| Searches per answer | 1 | 1 (2 once) | 1 (2–3 on two) |
| Input tokens per answer | 0.3k–12.6k (median 5.6k) | 13k–16k (34k once) | 4.7k–17k (median 8.8k) |
| Answers carrying source links | 15/15 | 13/15 | 11/15 |
| Extra fee per search (vendor price pages, read 2026-11-21) | none since 2026-11-18, tokens only | $10 per 1,000 | $10 per 1,000 |
| Answered in the user's language | 14/15 (Osaka weather asked in Japanese was answered in Chinese) | 15/15 (one Chinese answer quoted an English fragment) | 15/15 |

## What the answers show
- Agreement on checkable facts was high: tax deduction (3000 / 1500), lottery sale dates (11-24 to 12-25), USD/CNY (about 6.67), Bitcoin (about 60k), Osaka and Shanghai weather all matched across the three.
- Disagreements: Node.js latest version (26.13.0 vs 26.13.1 — Claude noticed the later security release, the other two did not); the latest F1 race (three different answers; DeepSeek said its sources conflict, Claude named an older race, OpenAI named a winner with one source). Not verified by me which is right.
- Without today's date in the prompt DeepSeek answered a weather question with a July date (first probe). With the date line it was current in all 15. The product must always pass the date.
- Claude was the most careful (says when sources disagree or are old). DeepSeek the fastest and the cheapest by a wide margin, with the most links. OpenAI the slowest; its answers often end by offering more help.
- CanalAPI passes Claude's server tools through on `/v1/messages`; on `/v1/chat/completions` the tool is silently ignored (the model answers that it cannot look things up).

## Rough cost per searched answer (my arithmetic, not a bill)
- DeepSeek: about 6k input tokens at $0.15–0.30 per million = roughly $0.001–0.002.
- Claude / OpenAI: $0.01 search fee each, plus 9k–15k input tokens at the model's price. Roughly ten times DeepSeek or more.

## What this means for the design
- The three tools have three different shapes (blocks, citations, usage). The gateway already speaks per-provider dialects, so the tool can be offered as "the model's own search" where the Agent's model has one, behind one internal interface (`searchWeb`) that returns text + sources + count of searches for charging.
- An Agent whose model has no built-in search (or is reached through a relay that drops server tools) needs a fallback: either a self-run tool (Firecrawl / another vendor) or "no search for this model". That is the open product question, not a blocker for the first version.
- Sources must be stored beside the message like citations are today (vendor terms: OpenAI and Anthropic both require visible source links).
