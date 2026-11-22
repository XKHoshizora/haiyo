# How mature AI products define credits/points, price them, and give them away free

Read 2026-11-22. Legend: **[P]** = read on the vendor's own page on that date (WebFetch); **[S]** = vendor page seen only through a search-result summary; **[3P]** = third-party, not primary; **[inf]** = my arithmetic or inference. Anything not marked is "not verified". Many vendor pages (Poe help centre, Genspark pricing, Manus pricing, Perplexity Pro, Claude Pro article, Character.AI, Coze, Doubao, Tongyi) returned 403/404/login walls or JS-less shells, so those rows are thinner than asked.

## 1. Comparison table

| Product | Unit | Dollar-denominated? | Implied value of 1 unit | Free allowance | At zero | Expiry / rollover |
|---|---|---|---|---|---|---|
| OpenRouter [P] | credit = US$1 | Yes | $1 (+5.5% fee on purchase, min $0.80; no markup on inference) | Free models only: 50 req/day (1,000/day after $10 bought), 20/min | Free models blocked if balance negative | Terms reserve right to expire after 1 year |
| Anthropic usage credits (Claude) [P] | Bought "usage credits" billed at API rates | Effectively yes (standard API rates) | API list price | none (plan limits instead) | Requests switch from plan limits to credits if enabled | Bought on/after 7 Dec 2026 expire in 12 months |
| Cursor [P] | Included pool "$20 of frontier model usage at API prices" (Jun 2025); current page: pooled "AI usage", weekly refresh, third-party models billed at API list | Pool was dollars; current tiers shown as multiples (4x, 15x, 50x of Plus $8) | Pro: $20 pool = $20 | Free tier: "limited" requests, no numbers | Top-offs or wait for weekly refresh; spend caps | Weekly refresh |
| Replit [P] | Dollar credits; Core $20/mo incl. $20 credit, Pro $100 incl. $100 | Yes | $1 | "Free Mode" allowance for chat; one-time free checkpoints | Confirm before any paid action; top-ups | Pro credits roll over 2 months |
| Lovable [P] | Credit (build/chat/cloud/AI, unified balance) | Abstract in UI, but docs state rate per plan | Pro $25/100 = $0.25; Business $50/100 = $0.50 [inf from price page; rate stated in docs] | 5 build credits/day, max 30/month; 20 Cloud credits/month | Stops | Daily credits expire same day; monthly roll over 1 month; top-ups last 12 months |
| Manus [P help article] | Credit (LLM tokens + VM + 3rd-party APIs) | Abstract | $20 Pro = 4,000 credits, so $0.005 [inf from the article's example] | Daily refresh credits, capped 1,500/month, only on "lite" model | Balance may go negative; no new tasks at <=0 | Monthly: no rollover; add-on: 1 year; free credits never expire |
| Genspark [P] | Credit | Abstract | Plus $24.99 (monthly) or $19.99 (annual) for 10,000 = $0.0025 / $0.0020 [inf] | 100/day until a lifetime cap, then refill stops | Upgrade prompt; no add-on price listed | Not stated for normal renewals |
| Poe [P plan page, JP¥] | Compute point | Abstract | 660k pts/mo = JP¥2,500 (JP¥0.0038/pt) [inf]. 3P says US$19.99 for 660k (cut from 1M in Jul 2026) = $0.00003/pt, not verified | Free tier: daily points, number not found; entry paid tier "10 thousand per day" | Not stated on the page | Help text via search: no rollover unless plan says |
| Monica [P] | "Advanced credit" + query counts | Abstract, but top-up price published | 4,000 credits = $10 so $0.0025; 12,000 = $30; 40,000 = $100 (flat) | Free: 40 basic queries/day, 0 advanced | Frequency drops (100/day) for Max/Ultra after quota | Monthly reset, 1st of month |
| Notion AI [P] | Notion credit (agents/workers/heavy models) | Abstract, price published | $10 per 1,000 monthly = $0.01; $13 per 1,000 annual = $0.013 | Each seat has "Standard" credits, amount not listed | Not stated | Monthly credits reset; annual last to renewal |
| Zapier [P] | Task | Abstract | 750 tasks $19.99 (annual) = $0.0267; 2,000 = $0.0245; 10,000 $129 = $0.0129; 100,000 $489 = $0.0049 [inf] | 100 tasks/month | Pay-per-task overage at 2.5x (monthly) / 1.25x (annual) the base rate, capped at 3x plan | Not stated |
| Perplexity [S] | Count of "Pro Searches" / research queries | No units, counts | n/a | Free: 3 Pro Searches/day, 1 research query/month | Falls back to standard search | Pro: "weekly limits (average use)", no numbers |
| Claude consumer [S] | None; usage measured by work done, 5-hour and weekly limits | No | n/a | Not verified | Wait for reset or buy usage credits | Fixed reset time |
| ChatGPT Plus [P] | None; "message caps" | No | $20/mo flat | Not verified | Caps, no numbers published | n/a |
| Kimi [S] | Quota pool as % of balance, deducted by tokens | No (percent shown) | n/a | Monthly pool; chat on K2.6 reportedly free, versions disagree | Not verified | Monthly reset, unused lost |
| Windsurf/Devin [P] | Daily/weekly "usage allowance"; extra usage "at API pricing" | Quota, API-priced overflow | API price | "light quota" | Buy extra usage | Daily/weekly refresh |
| Coze, Character.AI, 豆包, 通义, DeepSeek chat | not verified (primary pages unreadable) | | | | | |

## 2. Per-product notes

**OpenRouter** (https://openrouter.ai/docs/faq and https://openrouter.ai/pricing, read 2026-11-22). Fact: credits are dollar-denominated; fee only at purchase (5.5% Standard, 8% Business); inference at provider list, "no markup"; BYOK free up to $25,000/month list-price then 5% of list cost. Free models 20/min and 50/day, 1,000/day once $10 bought. Terms reserve the right to expire credits after 1 year. Mark-up on usage: 0%; effective mark-up 5.5% via purchase fee [inf]. Per-action cost visible: not verified. Lesson [inf]: the closest precedent to your current placeholder; a transparent fee at top-up instead of a hidden multiplier.

**Cursor** (https://cursor.com/blog/june-2025-pricing, https://cursor.com/pricing, read 2026-11-22). Fact: June 2025 replaced request limits on Pro with "$20 of frontier model usage at API prices", plus unlimited Auto/Tab and at-cost extra usage. Stated reason: tasks vary up to roughly 10x in cost, so per-request pricing did not fit. Backlash: unclear communication, "unlimited" understood wrongly, surprise charges; Cursor apologised, said "rate limits" was a confusing term for what is a credit pool, and offered refunds for unexpected usage 16 Jun - 4 Jul. The old model (from search summary of 2024 docs, [S]): 500 fast requests/month, unlimited slow, premium models counted at a multiplier (exact multipliers not verified). Current pricing page (read today) shows Plus $8, Premium $30, Super $100, Ultra $200 with 4x/15x/50x usage multiples of Plus, weekly refresh, third-party models at API list price, remaining usage shown in settings. Inference: even the dollar pool was later hidden behind relative multiples, which gives the vendor freedom to change cost-per-point without a visible price change.

**Replit** (https://replit.com/pricing, https://docs.replit.com/billing/ai-billing, https://replit.com/blog/effort-based-pricing-recap, read 2026-11-22). Fact: plans include dollar credits ($20 Core, $100 Pro); agent work billed by effort per checkpoint (before: flat $0.25/checkpoint; after: from $0.06 to over $1 per checkpoint); third-party APIs billed at provider public rate; cost shown by hovering over a checkpoint; budget limits and alerts; asks for confirmation before paid action. Recap blog admits the rollout "did not meet our standards", power users hit harder (long contexts), chat cost was folded into the next checkpoint, a billing error on 11 Jul 2025 inflated charges for ~6% of paying users; remedy: efficiency gains passed on, $10 credit to affected users, guardrails. Press (The Register, 2025-09-18, [S]) covered new complaints at Agent 3. Lesson: variable price per action is accepted only if the user sees the cost before or immediately after, and if questions cost visibly less than changes.

**Lovable** (https://lovable.dev/pricing, https://docs.lovable.dev/introduction/plans-and-credits, read 2026-11-22). Fact: one credit balance for build, chat, hosting and in-app AI; "illustrative" costs (colour change about 0.5, authentication about 1.2, landing page with images about 2.0, plan-mode message 1); cost per message shown under "Credits used", with a "Free" badge when the daily allowance paid; owners can set limits and alerts; long runs pause at a threshold (default 20 credits). Docs state conversion rate per plan: Pro $0.25 per credit, Business $0.50. Free: 5 daily build credits capped at 30/month; daily credits do not roll over. Note: the unit is small integer scale (about 1 action = 1 credit) with fractional costs; no published reason found for the scale.

**Manus** (https://help.manus.im/en/articles/11711097-what-are-the-rules-for-credits-consumption-in-manus, read 2026-11-22; pricing page unreadable). Fact: credits cover LLM tokens, VMs and third-party APIs, charged during active processing; failed tasks due to Manus issues refunded; $20 Pro includes 4,000 monthly credits (example in article) so $0.005/credit [inf]; free users get daily credits capped at 1,500/month, usable only with the lite model; order of use event, daily, monthly, add-on, free; the balance may go negative on the last action and blocks new tasks until positive; add-on packs valid one year. Mark-up vs upstream cannot be computed from public data (task cost is not tied to tokens).

**Genspark** (https://www.genspark.ai/helpcenter/membership-plans, read 2026-11-22). Fact: Free 100 credits/day up to a lifetime limit; Plus from 10,000/month at $24.99 ($19.99 annual); Pro from 125,000/month at $249.99; Team 10,000/seat. Implied $0.0025 (monthly Plus), $0.0020 (annual), Pro $0.002 [inf]. No add-on price on the page. Per-action rates: not verified. Third-party pages disagree on 100 vs 200 free credits/day; the vendor's page says 100.

**Poe** (https://poe.com/subscription_plans, read 2026-11-22; help centre 403). Fact: tiers listed in points ("10 thousand per day", 660k, 1.65M, 3.3M, 8.25M per month); page shows JP¥ prices (JP¥2,500/month for 660k); no add-on price or expiry on that page; each bot shows its own point cost (search summary of help centre, [S]), either fixed or variable on tokens. [3P] reports a July 2026 cut from 1,000,000 to 660,000 points at the same $19.99 price: a "same price, fewer points" change is exactly the backlash risk of an abstract unit [inf]. Whether the free daily number is 3,000: not verified.

**Monica** (https://monica.im/help/FAQs/rules_for_using_advanced_queries, read 2026-11-22). Fact: two currencies (query counts plus "advanced credits"); packs 4,000 for $10, 12,000 for $30, 40,000 for $100 (flat $0.0025); chat costs per 1K tokens of context from 0.2 (GPT-4o mini) to 40 (Claude 4 Opus), GPT-4o 2, o3 20; images 3 (SDXL) to 65 credits (SD 3.5), 10 (GPT Image 1), 30 (DALL-E 3); agent tasks about 138 (deep research), 187 (slides), 150 (browser operator); video 25 to 1,600. Free: 40 basic queries/day. Spread of 200x between cheapest and dearest model. Mark-up: at $0.0025/credit the cheapest model is $0.0005 per 1K tokens = $0.50/1M; if upstream GPT-4o mini input was about $0.15/1M and output $0.60/1M (my memory, not verified today), the mark-up is about 1x-3x; Opus at 40 credits = $100/1M vs $15 input / $75 output (memory, not verified) = 1.3x-6.7x [inf, indicative only].

**Notion AI** (https://www.notion.com/help/what-are-notion-credits, read 2026-11-22). Fact: $10 per 1,000 monthly credits; $13 per 1,000 annual; Business/Enterprise only; monthly credits reset, annual last until renewal; free credits used first, then monthly, then annual. Per-action rates not on that page.

**Zapier** (https://zapier.com/pricing, read 2026-11-22). Non-AI precedent: a task is the unit; price per task falls 5x with volume ($0.027 to $0.005); free 100 tasks/month; overage 2.5x base (monthly) and "stops at 3x your subscription". Sensible for your case: a hard ceiling on overage.

**Perplexity** (https://www.perplexity.ai/help-center/en/articles/11187416-which-perplexity-subscription-plan-is-right-for-you, read 2026-11-22). Fact: counts, not credits: Free 3 Pro Searches/day, 1 research query/month; Pro/Max "weekly limits (average use)" with no figure. Older pages said 5/day (search summary) so the free number has been cut over time.

**Claude / ChatGPT consumer** (https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans read; the Pro usage article was 404 so limits come from search summaries of support.claude.com/en/articles/9797557 and 8325606 [S]; https://help.openai.com/en/articles/6950777 read). Claude: five-hour plus weekly limits, usage depends on message length, files, model, tools; progress bars in Settings > Usage; overflow into pay-as-you-go credits at standard API rates; new credits expire after 12 months. ChatGPT Plus: $20/month, "message caps" without numbers.

**Kimi** (https://www.kimi.com/zh-cn/help/membership/membership-overview, [S] only). Search summary: monthly shared quota pool deducted by tokens, shown as percent; example from the help text: a simple slide deck 1-2%, a deep research 5-10% of the free pool; unused quota expires monthly; versions of the page disagree on whether chat consumes quota; the company compensated members with 25% of monthly quota after rate limiting in Oct 2026 (news summary). Not read directly.

**Windsurf** redirected to https://devin.ai/pricing (read): Free "light quota", Pro $20, Max $200, daily/weekly refreshing allowance, extra usage "at API pricing"; no credit counts any more. Earlier Windsurf credit-based plan: not verified.

**DeepSeek API** (https://api-docs.deepseek.com/quick_start/pricing, read): deepseek-flash $0.15 in (miss) / $0.60 out per 1M off-peak, double at peak; v4-pro $0.66 / $1.98 off-peak. Useful as a cost floor: at $0.001/point, 1M flash output tokens = 600 points off-peak, so even the 100 free points buy about 160k flash output tokens [inf]. (The chat apps' free limits for DeepSeek/豆包/通义: not verified.)

## 3. Synthesis

### (a) Models in use, for a product where other group members spend the owner's balance

1. **Dollar-denominated balance** (OpenRouter, Replit, Anthropic usage credits, Cursor's 2025 pool; Windsurf's "API pricing" overflow). Pro: nothing to explain, no conversion table, price changes upstream are passed through, no backlash about "points shrinking", easy to compare to a bill. Con: tiny per-action amounts ($0.013 per search) look strange; owners see money leaving, which makes them stingy about letting others spend; "fractions of a cent" display is awkward. Fits shared balances best because the owner sets an explicit cap in money.
2. **Abstract credits with a price list** (Manus, Genspark, Lovable, Monica, Poe, Notion, Zapier tasks). Pro: vendor can re-rate costs, bundle odd costs, and hide margin; per-action price list is easy to show ("search = 5"). Con: the exchange rate hides the margin so the first reduction in points per dollar becomes the backlash (Poe 1M to 660k, per 3P); users must learn a unit; a group owner cannot judge "is 300 a lot?" without a rate. Monica, Notion and Lovable publish the rate anyway, which suggests abstract units rarely stay opaque.
3. **Request/message counts with multipliers** (Cursor before Jun 2025, Perplexity Pro searches, Monica query counts). Pro: intuitive for chat. Con: cost per request varies roughly 10x (Cursor's stated reason for leaving), so either cheap users subsidise heavy ones or the multiplier table grows; Cursor's change shows this model collapses under agentic usage. Poor fit for a shared pool where one member could trigger long runs.
4. **Flat caps without units** (ChatGPT, Claude, Kimi %, Perplexity weekly). Pro: simplest; vendor keeps full freedom. Con: opaque and unpredictable ("it depends"), no way for an owner to allocate a share to others; Claude/Kimi add a percent bar, and Claude bridges to dollar credits at API rates once the cap is hit, so the shift is usually cap first, dollar-priced overflow second.

### (b) Mark-ups where computable
- Pass-through plus visible fee: OpenRouter 5.5% (8% Business), 5% BYOK above $25k.
- Cursor, Replit, Claude credits, Windsurf overflow: "API price" (0% markup claimed; included pools are bundled at about 1:1).
- Monica: flat $0.0025 per credit; indicative mark-up 1x-7x over upstream per token [inf, upstream prices from memory].
- Lovable $0.25-$0.50 per credit, Manus $0.005, Genspark $0.002-$0.0025, Zapier $0.005-$0.027 per task: not computable against upstream cost; public data does not give tokens per action.
- Notion $0.01-$0.013 per credit.
Conclusion: apart from aggregators and dev tools that sell "at API price", consumer/agent products do not publish a cost-based mark-up; where it can be inferred it is above pure pass-through. Your pure pass-through 1 point = $0.001 matches the OpenRouter/Cursor-pool end of the market, with the difference that you carry the whole margin problem yourself unless you add a purchase fee.

### (c) Free allowance in dollars
- Yours: 100 pts/day = $0.10/day = about $3/month (at upstream cost).
- Lovable: 5 credits/day (30/month cap) = $1.25/day, $7.50/month at the Pro rate of $0.25 (nominal value, not cost) [inf]. Cost to Lovable unknown.
- Manus: up to 1,500 credits/month = $7.50/month at Pro rate $0.005, but only on the lite model [inf].
- Genspark: 100 credits/day = $0.25/day at $0.0025, but limited by a lifetime cap [inf].
- Notion/Zapier: Zapier 100 tasks/month = about $2.70 at the lowest paid rate.
- Perplexity free: 3 Pro Searches/day; OpenRouter: free models only (cost to vendor zero or sponsored).
- Monica: 40 basic queries/day, nothing advanced.
Typical range for free tiers that give real model access: roughly $0.10-$1.25/day nominal; most give less in real cost because they route free users to cheap models or cap lifetime/monthly. Daily resets that do not roll over (Lovable, Poe) are the norm for the free tier; monthly pools for paid.

### (d) Number scale and showing costs
Consumer-facing credits cluster around two scales: about 1 action = 0.2-5 units (Lovable, Replit's old $0.25 checkpoint, Cursor requests, Perplexity searches, Zapier tasks, Notion agent credits at $0.01) and thousands-of-units-per-dollar (Poe at 30,000+ per dollar, Monica 400 per dollar, Genspark 400-500 per dollar, Manus 200 per dollar). No source published why they picked either scale; this is a gap. My inference: the large scale lets vendors price cheap actions as whole numbers; the small scale reads naturally to non-technical users. Your $0.001 point is in between (1,000 per dollar), and a 13-point search is a whole number, which is acceptable; the risk is only that "100 free points" feels tiny (a message may cost 5-50). On display: Lovable shows credits used per message and a "Free" badge; Replit shows checkpoint cost on hover and asks confirmation before paid work; Cursor commits to "advance notice and clearer documentation" after its backlash; Claude and Cursor show progress bars. Sources consistently pair a rate with a visible after-the-fact cost and with owner-set limits/alerts (Lovable per member/project/workspace; Replit budgets; Claude monthly spend limit).

### (e) Common mistakes and triggers
1. Changing the exchange rate silently: Poe "same price, fewer points" [3P]; Kimi's Oct 2026 compensation after throttling (news summary). Trigger: points shrink or limits vary with load.
2. Calling a limited pool "unlimited" (Cursor, Jun 2025) and renaming a credit pool "rate limit".
3. Variable per-action price with no preview (Replit effort pricing: $0.06 to over $1 vs flat $0.25; chat folded into next checkpoint; a bug overcharged about 6% of paying users).
4. Free allowance reduced over time (Perplexity 5 to 3 Pro searches/day; Genspark lifetime cap; Manus lite-only daily credits), which turns free users into critics.
5. Unclear expiry: Anthropic now states a 12-month expiry; Lovable/Manus publish rollover rules in detail.
6. Overage without ceiling: Zapier's 3x-of-plan cap is the explicit counter-example; Manus allows negative balance by one action.
Recommendation (inference, owner decides): keep dollar-denominated points (or show "pts" with the dollar rate in the help text), publish a per-action list including search, show the cost of each reply after it ran, put a per-member cap set by the owner, make the free grant daily and non-rolling, and give notice before changing any rate.

## 4. Not verified
- Poe: current free daily points; add-on point price; official USD plan price (page showed JP¥); the 1,000,000 to 660,000 cut (3P only); points expiry.
- Manus: pricing page, daily free credit amount, add-on pack prices, per-action price list.
- Genspark: price of extra credits; per-action rates; rollover on normal renewal.
- Cursor: current free-tier numbers; old per-model request multipliers; whether the current pricing page I read reflects a later restructuring (page content could not be cross-checked).
- Windsurf's own credit scheme (page now redirects to Devin).
- Perplexity: Pro price and Pro query numbers; the Perplexity Pro help article.
- Claude and ChatGPT: any message/limit numbers; free-plan numbers; Claude's Pro-usage article 404.
- Kimi: read only through search summaries; 豆包, 通义, DeepSeek chat app free limits: not read.
- Character.AI/Talkie, Coze/Dify, Sider, v0, Bolt: only third-party or no data; not used.
- Notion: free Standard/Select credit amounts and per-model credit rates.
- Upstream model prices used for Monica's mark-up estimate come from memory, not from a page read today.
- Per-action price visibility for OpenRouter, Poe (beyond search-summary), Genspark, Manus.
- Reasons vendors chose their number scale: no published reasoning found for any of them.
