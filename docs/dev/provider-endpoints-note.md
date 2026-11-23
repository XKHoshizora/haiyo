# Design note: several endpoints per provider (not built)

Today a provider has one protocol and one base URL; the model list may come from a sibling address on the same origin
(`listing-siblings.json`), found by the service and never stored. A full design, as Cherry Studio has, would add:

- a stored list of endpoints per provider, each with its own protocol, base URL and key header (and a migration);
- a model's listing endpoint and chat endpoint stored together, so the honest "this model may not be served at the chat
  address" hint goes away, and a model can be chosen at the endpoint that serves it;
- gateway routing by model to its endpoint;
- test connection per endpoint, and a page to manage them.

Decision for later; the discovery in the README ("Model providers", `models/list`) covers only the listing half.
