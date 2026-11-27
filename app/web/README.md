# Agent Family web client

React 19 + Vite. Talks to `app/service` over same-origin `/api` (cookie session) and one WebSocket.

## Develop

1. Start the service with `APP_ORIGIN=http://127.0.0.1:5273` (its default `.env` value must match, otherwise every
   POST/PUT/PATCH/DELETE and the WebSocket upgrade are refused with 403): `npm run dev` in `app/service`
   (listens on `127.0.0.1:8787`).
2. `npm install` then `npm run dev` here. Vite serves `http://127.0.0.1:5273` (port is fixed, `strictPort`) and proxies
   `/api`, WebSocket included, to the service with the Host and Origin headers unchanged.

## The socket's connect timeout

A WebSocket that has not opened 15 s after it was made (`src/api/socket.js` `CONNECT_MS`) is given up and tried again with the usual back-off:
an iOS WebSocket can hang in CONNECTING after the app came back. A network whose upgrade always takes longer than 15 s never connects.

## Browsers

The bundle needs **Chrome or Edge 111, Firefox 114, Safari or iOS Safari 16.4** or later: the build's target
(`vite.config.mjs` `build.target`, stated there; Vite 8's own default today). The hard floor comes from the code: the
mention address pattern (`src/data/mentions.js`, `ADDRESS_PATTERN`) and the Markdown worker's GFM autolinks use a
RegExp lookbehind, which Safari and iOS have only from 16.4 (Chrome 62, Firefox 78). In an older browser the main
bundle does not even parse: the page stays blank. Raising the target is a decision; lowering it needs those patterns
written without lookbehind first.

## Test and build

- `npm test` runs ESLint and vitest (`tests/`).
- `npm run build` writes `dist/` (git-ignored).
- `npm run e2e` runs the browser end-to-end suite (`e2e/`, Playwright, Chromium; not part of `npm test`). Needs
  Playwright's Chromium once per machine: `npx playwright install chromium`.

## End-to-end suite (`e2e/`)

Each spec creates its own people (one browser context each, random e-mails, handles and passwords), so the specs
run in any order; one worker, because they share one service. Every page is watched for CSP violations, uncaught
errors and the XSS probe (`support/fixtures.mjs`).

**Local mode** (default). Global setup builds this client and the service (`npm run build` in both;
`E2E_SKIP_BUILD=1` reuses the last builds), runs the migrations on the database `af_e2e` (server, role and password of
`TEST_DATABASE_URL`, from the environment or `app/service/.env`, with the name replaced; `E2E_DATABASE` names another,
lower case, ending in `_e2e`, at most 63 bytes, created when it does not exist — with its own `E2E_PORT`, a second run
beside another; unset, nothing changes) and empties every table but
`pgmigrations`. **An existing database of that name is migrated and emptied, whatever it holds**: the suffix is the only
guard, so never point `E2E_DATABASE` at a database you want to keep. The suite then starts the model stub (`support/model-stub.mjs`: a local stand-in for a model service on 127.0.0.1,
speaking OpenAI Chat Completions and Anthropic Messages, streamed, scripted by the specs) and the judgement stub
(`support/judge-stub.mjs`: a local stand-in for the judgement model of proactive replies, answering by fixed rules on the
message judged — 川菜 picks the first Agent, 别插话 asks it to be quiet, anything else picks nobody — and recording what it
was asked), then starts one service on
`http://127.0.0.1:8911` (`E2E_PORT`, bound with `HOST=127.0.0.1`, so it is not reachable from the network) that serves
`dist/` with a random `AUTH_SECRET`, a fixed fake `PROVIDER_KEY_SECRET`, a temporary `BLOB_DIR`, `RATE_LIMIT_SCALE=1000`,
`SWEEP_INTERVAL_MINUTES=0`, `FREE_DAILY_POINTS=1`, two site models (one free, one paid) that are the model stub, and the
judgement stub as its judgement model (`E2E_JUDGE`, so `proactiveAvailable` is true; `PROACTIVE={"debounceMs":300}`). That service
is the test-only entry `app/service/tests/helpers/e2e-server.ts`, run with `tsx` (`NODE_ENV=test`, and only on a
database named `…_e2e`): the production entry (`dist/server.js`) cannot call a plain-http loopback address, by design.
Invites, mail and points come from the service CLI (`invite:create`, `inbox:list`, `credits:grant`). The restart spec
stops and starts that process, and the specs script the model stub and read the judgement stub, through a control endpoint
of the runner (127.0.0.1, random port and token). Teardown stops the service and the stubs and deletes the temporary directory; a service left by a
crashed run is stopped by the next run. `E2E_SHOTS=1` also saves the acceptance screenshots
(`docs/acceptance/batch2a/shots/`, 1440×900 and 390×844) of this run's own seeded data. The service log is
`e2e/test-results/service.log`; failures keep traces and screenshots in `e2e/test-results/`, the HTML report is in
`e2e/playwright-report/` (`npx playwright show-report e2e/playwright-report`). All of these are git-ignored. `e2e/agents-group.spec.mjs` covers an owner's Agent in a group (add, @-call, one whole reply charged to its owner, what other members never receive), Agents calling each other with 让 Agent 停下 and the chain limit, a failed reply, leaving, removal and deletion, then message times, the two-step provider form, a model's 高级 panel and the paced reveal; with `E2E_SHOTS=1` its screenshots go to `docs/acceptance/batch2c/shots/`. Its chain-limit test restarts the service with `AGENT_CHAIN_LIMIT=3` through the runner's control endpoint (`restartService({…})` in `e2e/support/control.mjs`, and `restartService({})` back to the normal configuration; only the local suite can). `e2e/agents-proactive.spec.mjs` covers proactive replies: an owner turns 主动参与群聊 on in the Agent form, a member's message without @ gets the Agent's reply on both pages, the owner's model line under it ends ` · 主动回复` while the member sees no line and receives no word of it, 别插话 brings the `agent_quieted` notice, and chit-chat gets no reply; no other spec turns the switch on, so no other spec's group messages are judged; the judgement stub also answers the memory feature's questions (`agents-memory.spec.mjs`) and, with the Agent social switch on (`social.spec.mjs`, `social-web.spec.mjs`), the persona aid's one question per sentence of a persona (a sentence holding `PERSONA_FACT_MARK`, 住在, is a fact: `support/judge-stub.mjs`). `e2e/mentions.spec.mjs` covers mentions picked from the @ list in Chromium: each tag the composer draws lies on its own characters within 1.5 px (one line, wrapped, split across a wrap, after CJK, Latin and emoji, scrolled in a tall box, at 375 px and at device scale factors 1.25 and 1.5), Backspace, a click and a script-placed caret against a tag, the browser's own undo and redo, an IME composition (Chrome's, through the DevTools protocol) next to a tag and inside one (also with 发送 tapped before it is committed), what is stored and called when sent and what both browsers show, a person named 「Jarvis Lee」, and a URL with `/@name` in an Agent's reply; with `E2E_SHOTS=1` its screenshots (`mentions-*.png`) go to `docs/acceptance/batch2-tools/shots/`. `e2e/support/db.mjs` is the local suite's direct database helper (refused unless the database is `af_e2e`): `backdateMessage(conversationId, seq, days)` moves a message into the past, for what no person can do in the app.

**Remote mode.** `E2E_BASE_URL=https://… E2E_INVITE_CMD="…" E2E_INBOX_CMD="… {email}" npm run e2e` starts nothing
and talks to that origin. The invite code is the last line of `E2E_INVITE_CMD`'s output that is a 20-character code;
`E2E_INBOX_CMD` must print what `inbox:list --to <email>` prints, `{email}` being replaced by a generated
`…@example.test` address. Example for the container: `E2E_INVITE_CMD="docker exec af node dist/cli.js invite:create"`,
`E2E_INBOX_CMD="docker exec af node dist/cli.js inbox:list --to {email}"`. Only the specs tagged `@remote` run
(§7.1, §7.2: the real registration limit is 10 a minute per address); `E2E_REMOTE_ALL=1` runs all of them, and the
restart spec and the specs that need the model stub (Agents, providers, Markdown) skip themselves.

## Layout

- `src/api/http.js` - `request`, `ApiError`, `setUnauthenticatedHandler`.
- `src/api/routes.js` - one function per service endpoint, plus attachment/avatar URL builders and `socketUrl`.
- `src/api/socket.js` - ticket → WebSocket, ping every 25 s, `onEvent` / `onClose(code)`.
- `src/data/model.js` - the client's copy of the service's data as pure functions (seq rule, catch-up, optimistic sends).
- `src/data/sync.js` - first load, push buffering, gap repair, reconnect with backoff (1 s → 30 s).
- `src/data/actions.js` - async actions (send, retry, read, older history, social and group routes).
- `src/data/viewmodel.js` - model → the prototype's state shape (signed-in user under the alias id `"me"`).
- `src/data/store.jsx` - `createDataLayer()`, store provider and `useStore()` → `{state, dispatch, actions, start, stop, onSignedOut}`.
  Nothing talks to the service until `start()`.
- `src/auth/` - account screens (`screens.jsx`), the session gate (`AuthRoot.jsx`: one `GET /api/me` at start, runs the data layer while
  signed in, stops it on sign-out / 401 / close 4001), the path router (`router.js`), field rules, error-code texts.
- `src/App.jsx` - the sign-in gate and the lazy application (`src/AppShell.jsx`: rail, lists, chat; its own chunk, so the account screens never download it).
- `src/state/` - UI reducer (navigation, toast) and selectors; `src/pages/`, `src/ui/` - the approved prototype UI.
- Agents' messages (only theirs) as safe Markdown, never parsed on the page's main thread:
  `src/ui/markdownWorker.js` runs the whole pipeline (`src/ui/markdownPipeline.js` `renderToTree`: the raw-text checks of
  `src/ui/markdownLimits.js`, micromark/remark, KaTeX, highlighting, the allow-list of `src/ui/markdownRules.js`, caps of
  600 table cells and 3 000 elements per text) in a module worker; `src/ui/markdownClient.js` sends one text at a time
  and ends the worker when an answer is 250 ms late (the text is then plain with a note, and remembered for the tab by a
  digest: `src/ui/slowTexts.jsx`); `src/ui/markdownTree.js` checks every tree that comes back; `src/ui/Markdown.jsx` (its
  own chunk, with KaTeX's styles) turns it into React elements. `src/ui/AgentText.jsx` shows the plain text until the
  tree has come; `src/ui/markdownView.jsx` renders only texts near the visible part of a conversation, within 30 000
  elements per conversation, and turns texts rich at most 3 000 elements per animation frame (also when the tree was
  already kept: a conversation opened again). No raw HTML, http(s) links only, images as links, nothing fetched; maths
  is `$$…$$` only. A link's content is one plain text, always followed by one space and its real host in ASCII brackets
  (`文档 (docs.example)`); bidirectional controls are removed from everything shown. A reply being written keeps and
  shows its first 20 000 characters
  (`src/data/model.js` `STREAM_CHARS`). The chat list's preview of an Agent's message has its Markdown markers taken
  out by `src/ui/markdownPreview.js` (no library).

- Brand marks (`src/assets/model-brands/*.svg`, lobe-icons, MIT: their source and licence are beside them): the app's one
  set, bundled with the page (no mark is fetched from another site), shown before a model's name everywhere — the model
  picker (`src/pages/ModelSelect.jsx`), the Agent list and page, the line under a reply, the provider pages — by
  `src/ui/ModelBrand.jsx` (`src/ui/LabLogo.jsx` is it under its old name), the brand read from the model's name by
  `src/ui/modelBrands.js` `brandOf`; a colour file as an `<img>`, a single-colour one as a mask in the text's colour, never
  inlined; no brand: a generic chip. `node scripts/check-logos.mjs` re-checks every file.
