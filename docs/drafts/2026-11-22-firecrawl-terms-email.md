# Draft email to Firecrawl (for the owner to send; not sent)

Status: Firecrawl is now the FALLBACK for web search (first version uses model vendors' own search). Send only if we decide to add it. Fill in the bracketed parts. Their contact address should be taken from their site at the time of sending; I did not verify one.

---

Subject: Commercial use and storage of results in a hosted chat product — terms question

Hello,

I am building Haiyo, a hosted chat product in which people and AI agents talk in private chats and groups. We are evaluating the Firecrawl hosted API (search, and later scrape) as the web lookup tool for those agents, and would like to confirm that our use fits your terms before we build on it.

How we would use it:
- Our server calls your API when an agent decides it needs current information. End users never receive an API key and never call you directly.
- The agent's answer is shown in the conversation with links to the source pages (URL, page title, site name).
- Expected volume at the start: [under 2,000] searches per day, on a paid plan.

Questions:
1. Is this use (results shown to our end users inside a paid, hosted product) permitted under the standard plans, or does it need a separate agreement?
2. Storage: may we store, as part of the chat history, (a) the URL, title and site name of sources, and (b) short snippets or the agent's answer written from the results? If there is a time limit or a caching restriction, what is it?
3. May search results be passed to third-party language models (OpenAI, Anthropic, DeepSeek) to write the answer?
4. Is there any restriction on end users located in [mainland China / Japan], or on queries in Chinese and Japanese?
5. Rate limits and concurrency on the plan that fits the volume above, and what happens when the limit is reached.
6. Do you keep the queries we send, for how long, and are they used for training or shared with others? Is zero data retention available on a standard plan?

Thank you,
[Name]
[Haiyo — haiyo.org]
