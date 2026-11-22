# Deploying Agent Family (one container: service + web client)

The image holds the service (`app/service`) and the built web client (`app/web`), which the service serves
from the same origin (`WEB_DIST`, see `app/service/README.md`, Deployment). Postgres is not part of it.

## Build

The build context is the **repository root**, not this directory:

```
docker build -f app/deploy/Dockerfile -t agent-family .
```

`app/deploy/Dockerfile.dockerignore` (BuildKit picks it up next to the Dockerfile and prefers it to the root
`.dockerignore`, which belongs to the old app) lets only `app/web` and `app/service` into the context, minus
`node_modules`, `.env*`, `dist`, `app/service/data` and the tests. `spikes/`, `prototype-v2/`, `.git`, `.claude`
and `.superpowers` never enter.

Stages: (1) `app/web`: `npm ci && npm run build`; (2) `app/service`: `npm ci && npm run build`; (3) the
runtime image on `node:24-slim`: `npm ci --omit=dev` for the service, `dist/`, `migrations/`, and the web
build at `/app/web` (`WEB_DIST=/app/web`). It runs as the unprivileged `node` user.

## Run

```
docker run --rm -p 3000:3000 --env-file agent-family.env agent-family
```

On start the container runs the migrations (`node dist/cli.js migrate`, safe to repeat) and then the server
(`node dist/server.js`); a failed migration stops the container before anything is served. `PORT` (default
3000) is honoured; the server listens on all interfaces. `HEALTHCHECK` calls `GET /api/health` (it also
touches the database) on the `PORT` the container runs with.

Other commands run in the same image, e.g. the first invitation, the mail outbox, the attachment sweep:

```
docker exec <container> node dist/cli.js invite:create --ttl-hours 72
docker exec <container> node dist/cli.js inbox:list --to someone@example.com
docker exec <container> node dist/cli.js mail:status            # mails per day: queued / sent / failed / expired / retries (counts only)
docker exec <container> node dist/cli.js attachments:sweep      # by hand only; the server sweeps by itself
docker exec <container> node dist/cli.js memory:stats --days 7  # the memory feature's counters (counts only), days as columns
```

## Environment

Required: `DATABASE_URL`, `APP_ORIGIN`, `AUTH_SECRET`, `PROVIDER_KEY_SECRET`. An invalid value stops the service at
start-up with a message naming the variable. Values in the right column are for the acceptance environment.

| Variable | Meaning | Acceptance value |
| --- | --- | --- |
| `DATABASE_URL` | Postgres connection string. Needs the extensions `citext`, `pgcrypto`, `pg_trgm`. | the acceptance database |
| `APP_ORIGIN` | The public origin users type, no path (`https://…`). Used for the Origin check, cookies (`Secure` when https), mail links, HSTS (https only). | the public https URL |
| `AUTH_SECRET` | Signs sessions and tokens; at least 32 characters; keep it stable (changing it signs everyone out). | a long random string |
| `PROVIDER_KEY_SECRET` | Encrypts the API keys people save for their own model providers; at least 32 characters. **Back it up with the database**: a database restored without it (or with another value) cannot open those keys — each provider then fails until its owner saves the key again. Keep it stable. | a long random string, other than `AUTH_SECRET` |
| `SITE_MODELS` | The models the site offers (JSON array; see `app/service/README.md`, Configuration). Each names in `apiKeyEnv` another variable that holds its upstream key — set that variable too; it may not be `DATABASE_URL`, `AUTH_SECRET`, `PROVIDER_KEY_SECRET`, `S3_ACCESS_KEY_ID` or `S3_SECRET_ACCESS_KEY` (start-up fails naming the model). Two models may share one. Default: none. | the acceptance models, each with its key variable |
| `JUDGE` | The judgement model that lets an Agent whose owner turned 主动参与群聊 on reply in a group without being @-mentioned (JSON; see `app/service/README.md`, Proactive replies). Shape: `{"model":"<model name>","channels":[{"url":"https://judge.example.com/v1/judge","apiKeyEnv":"JUDGE_KEY"},{"url":"https://judge-relay.example.com/v1/judge","apiKeyEnv":"JUDGE_RELAY_KEY"}],"timeoutMs":4000,"dailyLimit":20000}` — one or two channels, tried in order, each `url` the endpoint itself (kept exactly as given); each `apiKeyEnv` names another variable that holds that channel's key — set it too (not one of the service's own secret variables; start-up fails naming it). `timeoutMs` 500–30000 (default 4000), `dailyLimit` judgements a site day, 1–10000000 (default 20000). Unset: no Agent replies unasked, the setting is refused and the web client does not show it. The judgements cost the site, never a user. | the judgement model, two channels (official and relay), each with its key variable |
| `PROACTIVE` | Tunings of those replies, JSON, every field optional (`debounceMs`, `transcriptMessages`, `transcriptChars`, `base`, `surchargeStep`, `surchargeMax`, `surchargeHalfLifeS`, `surchargeHalfMessages`, `quietSmall`, `quietBig`, `cap`, `fuse`, `perGroupHour`, `perSenderHour` — judgements an hour at most about one group and about one sender's messages, so no account can use up `dailyLimit`, default 600 and 300; defaults and ranges in `app/service/README.md`, Proactive replies). Unset: the calibrated defaults. | unset (defaults) |
| `TOOLS` | What bounds an Agent's tools in one reply, JSON, every field optional: `enabled` (default `true`; `false`: no reply is offered any tool), `maxRounds` (8), `maxPoints` (whole points one reply may spend before it must answer, 20), `searchPerReply` (6), `filePerReply` (4), `timePerReply` (1), `resultMaxWeight` (3000), `runTimeoutMs` (how long a reply with tools may take in all, 300000 ms; the stale-run sweep waits twice the longer of this and `AGENT_RUN_TIMEOUT_MS`, and a minute). Ranges in `app/service/README.md`, Configuration. Unset: the defaults. | unset (defaults) |
| `HOLDS` | What one owner's open holds may add up to, JSON, every field optional: `maxOpenShare` (an admission rule: the share of what is left of the free allowance or of the balance that the owner's running calls, a starting reply's own hold included, may hold against it before that reply waits, queued; 0.01–1, default 1). Unset: the default. | unset (default) |
| `ALLOWANCE` | When an owner is reminded of the day's free allowance, JSON, every field optional: `warnAt` (the share of it used at which they are told, once a day; above 0 and below 1, default 0.8). Unset: the default. | unset (default) |
| `AGENTS` | How a reply that failed for a passing reason (the model service unavailable — 5xx, 408, 429, a network failure or timeout — or the service restarted mid-reply) is tried again by the system, JSON, every field optional: `autoRetryDelaysMs` (the waits before each retry of one original call, in ms; at most 2, each 0–600 000; never later than 10 minutes after the original call; default `[20000, 120000]`; `[]` turns it off). Unset: the default. | unset (default) |
| `WHISPERS` | How long whispers stay open, JSON, every field optional: `elsewhereTtlHours` (a found-elsewhere whisper — "not here, but I have it elsewhere" — expires this many hours after it was made; whole hours 1–168, default 24; other kinds stay open 7 days). Unset: the default. | unset (default) |
| `FREE_DAILY_POINTS`, `SITE_TIMEZONE` | The free daily allowance of site-model use in whole points (default 200), and the time zone whose midnight starts a new day of it (default `Asia/Shanghai`). | `FREE_DAILY_POINTS` `100` (the default, 200, is not used); `SITE_TIMEZONE` the default |
| `AGENT_TIERS` | JSON: how many Agents each account tier may own; must contain `free`. Default `{"free":20}`. | default |
| `HOST` | The address the server listens on (default `0.0.0.0`, every interface). | default |
| `PORT` | Listening port. Image default `3000`. | what the platform routes to (often injected) |
| `WEB_DIST` | Directory of the web build. Image default `/app/web`; leave it. Unset serves only the API. | `/app/web` |
| `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID` | The iOS app at Apple: the Team ID (10 capitals and digits) and the bundle id (e.g. `org.haiyo.app`). Both set: `/.well-known/apple-app-site-association` is served (universal links), and they are the push token's issuer and topic. Unset or malformed: that path is a JSON 404 (malformed: also a start-up WARN line naming it; the service starts anyway). See `app/service/README.md`, Deployment, Universal links. | the owner's Team ID and the app's bundle id, once the app exists |
| `APNS_KEY_ID`, `APNS_KEY_P8` | Pushes to the iOS app (APNs): the key's Key ID, and a **secret**, the `.p8` key file's text (paste it with its line breaks, or on one line with `\n`); never logged, never named as a site model key. With the two above, all four set: pushes are sent; any missing or malformed (a bad paste): none are, everything else works, and one start-up WARN line names the missing and malformed variables (never a value) — the service always starts. The owner sets these; nobody else sees the key. See `app/service/README.md`, Push notifications. | the owner's APNs key |
| `CLIENT_IP_HEADER` | Header your proxy sets to the real client address, replacing any client value. Rate limits count per address; without it every request looks like the proxy. | `x-real-ip` |
| `TRUST_PROXY` | Alternative to the above: the proxies' addresses/CIDRs whose `X-Forwarded-For` is read. Never `true` or a number (refused). | unset |
| `REGISTRATION_MODE` | `invite` (an invite code is required) or `open`. | `invite` |
| `MAIL_MODE` | `outbox` (default): mail is only written to the `mail_outbox` table and read with `inbox:list`; nothing is sent. `resend`: every mail is still written to `mail_outbox` first, then delivered through Resend (https://resend.com, HTTP API) by a sender inside the service: retried with growing waits (1, 4, 10, then every 15 minutes) on network errors, 429, 5xx and a refused key, until the mail's own expiry (the time its link stops working: 1 hour for a password reset, 24 hours for a verification and for the notice that someone tried to register an address); failed at once on any other answer that cannot succeed. A row remembers at queue time whether it is to be delivered: rows written in `outbox` mode are never sent, whatever mode runs later. Survives restarts. `resend` needs the next variables; start-up fails naming the one that is missing. Delivery never holds up a request. See "Changing the sending domain" below. | `resend` once the sending domain is verified at the provider |
| `RESEND_API_KEY` | A **secret**: the provider API key (sending access is enough). Required when `MAIL_MODE` is `resend`; never logged, never stored in the database, never named as a site model key. | the key of the acceptance account |
| `MAIL_FROM` | The sender of every mail, e.g. `Haiyo <no-reply@notify.example.org>` (an example: use an address on your own verified sending domain). Required when `MAIL_MODE` is `resend`; no address is built into the service. | an address on the verified sending domain |
| `MAIL_REPLY_TO` | Optional: where a reader's reply goes. Unset: no reply-to is asked for. | unset |
| `MAIL_PER_ADDRESS_HOUR` | At most this many mails of one kind (verification, reset, registration notice) are delivered to one address in an hour, whichever IPs ask (1 to 1000, default 5). Over it the mail is still written to the outbox but marked `capped` and not sent; the person who asked gets the same answer as always. Only in `resend` mode has it an effect. | default |
| `BLOB_DIR` | Where avatars and attachments live when `S3_*` is not set. Image default `/data/blobs` (mount a volume there or it is lost with the container; the container runs as the unprivileged `node` user, uid 1000, so a bind-mounted host directory must be writable by uid 1000, e.g. `chown 1000:1000 <dir>`). | unused if S3 is set |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | S3-compatible object storage; all five or none. | all five (container disks are not durable) |
| `RATE_LIMIT_SCALE` | Multiplier on every rate limit. | `1` |
| `SWEEP_INTERVAL_MINUTES` | Minutes between the server's own sweeps of unsent uploads and abandoned blobs (first run a minute after start). `0` disables; at most `1440`. No cron needed. | `15` (default) |
| `ATTACHMENT_MAX_BYTES` | Largest single file one upload may carry, in bytes (1 MiB to 5 GiB, at most `ATTACHMENT_QUOTA_BYTES`). A reverse proxy in front must allow bodies this large and not buffer them. | `1073741824` (default, 1 GiB) |
| `ATTACHMENT_QUOTA_BYTES` | Attachment bytes one user may store. | `21474836480` (default, 20 GiB) |
| `UPLOAD_IDLE_TIMEOUT_MS`, `UPLOAD_TOTAL_TIMEOUT_MS` | An upload is cut off after this long without body bytes (default 45000) / in all (default 3600000, 60 minutes). | defaults |
| `HTTP_BODY_TIMEOUT_MS` | A request with a body must have arrived whole within this long (default 30000); an upload is released from it once it is admitted and then follows the upload deadlines. | default |
| `HTTP_CONNECTION_TIMEOUT_MS`, `HTTP_REQUEST_TIMEOUT_MS`, `HTTP_KEEP_ALIVE_TIMEOUT_MS` | Server-wide socket idle (120000), whole request (upload total + 60000), keep-alive idle (72000). Must exceed the upload deadlines; the socket idle must also be at least 20000 (a persona draft answers 10 s before it: its deadline is `AGENT_RUN_TIMEOUT_MS`, at most the socket idle less 10 s). Keep the proxy's idle timeout above the keep-alive value. | defaults |
| `DB_STATEMENT_TIMEOUT_MS`, `DB_ACQUIRE_TIMEOUT_MS`, `SEARCH_STATEMENT_TIMEOUT_MS` | Database limits: statement (30000), wait for a pool connection (10000), one search (3000). Past them: 503 `busy`. | defaults |
| `AGENT_MAX_CONCURRENT_RUNS`, `AGENT_MAX_CONCURRENT_OTHERS_RUNS`, `AGENT_RUNS_PER_MINUTE`, `AGENT_OTHERS_RUNS_PER_MINUTE`, `AGENT_CALLER_RUNS_PER_MINUTE`, `AGENT_RUN_TIMEOUT_MS` | Model calls per person: running at once, replies and persona drafts together — further replies wait, a further draft is refused; a draft and a reply that start at the same moment may briefly run one over (1–100, default 4); of those, at most this many for replies other people called for, the rest kept for the owner's own (1–100, default 3; more than the first and the service refuses to start, so setting only the first below 3 is refused too); replies an owner started a minute that they called for themselves (1–10000, default 20); replies an owner's Agents started a minute that others called for, all together (1–10000, default 20); calls one person may make a minute on other people's Agents (1–10000, default 5; over it the call starts nothing and only a log line records it); how long a call may take, in ms (1000–3600000, default 120000) — a reply first reads its attachments, which may take that long too, then calls the model, so one reply can take up to about twice the value; a run still `running` after twice the value and a minute, with no instance working on it, is released by the stale-run sweep. | defaults |
| `PROVIDER_DEFAULT_CONTEXT_TOKENS`, `PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS` | A provider model's context when its owner gives none (1000–2000000, default 16000) and the output limit of every call to a provider model at reasoning `none` (1–1000000, default 2048; a level adds its thinking allowance, below); the first must be larger than the second. | defaults |
| `REASONING_ALLOWANCE_TOKENS` | The thinking allowance of each reasoning level, JSON (`low`..`max`, tokens 0–200 000 each; a level left out keeps its default). At any level but `none` a call may produce this many tokens more than its reply limit (upstreams count thinking inside the output limit), at most half of what the model's context leaves beside the reply limit; the points held for a site-model call cover it, and the conversation the model is shown is that much shorter. Default `{"low":2000,"medium":6000,"high":12000,"xhigh":24000,"max":48000}`. | default |
| `PROVIDER_MAX_CONCURRENT_CALLS` | Calls to model providers and site models in flight at once in the whole service (1–1000, default 64); one more is refused as `provider_unavailable`. | default |
| `AGENT_MAX_RUNS_IN_FLIGHT` | Agent replies the service runs at once, all users together (1–64, default 16); further ones wait queued. Memory: each reply holds up to 20 MiB of attachments, in up to about five copies at its peak (the bytes, their base64 text, the request body with that text, and its encoded bytes), so the worst case is this × 20 MiB × 5 — about 1.6 GiB at the default; size the container for it or lower the value. | default |
| `AGENT_CHAIN_LIMIT` | In a group, once its last this many messages that are not notices were all sent by Agents, an Agent's message calls no other Agent until a person writes, and the group is told once (2–500, default 30). The owners' per-minute, concurrency and points limits, each Agent's `chainBudget` and any member's halt brake Agent-to-Agent talk too. | default |
| `AGENT_GROUP_CONTEXT_TOKENS` | The most a reply in a group is shown of the group: this many tokens of its latest 80 messages, files included, by the service's estimate (a token per character, 1 500 an image, 300 per KB of PDF; a provider may bill an image or a PDF at more), plus the system text (2000–200000, default 12000). The Agent's owner pays for what it is shown; an Agent's own conversation is limited by its model's context alone. | default |

## Must hold

- **One replica.** Realtime delivery and several limits live in one process's memory; a second instance
  would not see the first one's sockets (see `app/service/README.md`, Sync and realtime). No cluster mode.
  A deploy that starts the new container while the old one still runs posts and charges nothing twice: the new one's
  start-up ends the old one's Agent replies in progress (they fail retryable, the owner retries), and when the old
  one's model call finishes it posts and charges nothing more (`app/service/README.md`, Agents and runs, Recovery).
  When the old container is stopped (`SIGTERM`), it ends the Agent replies and persona drafts it is still working on
  itself — abandoned, failed and retryable, nothing charged — within 5 s, then exits (Agents and runs, Shutdown); give
  it at least that long before it is killed. Only a container killed before that (or whose database stopped answering)
  leaves a reply `running`; the running container's stale-run sweep then releases it (failed, retryable) within about
  twice `AGENT_RUN_TIMEOUT_MS` and two minutes (6 minutes with the default). Until then that Agent shows "replying" and
  answers nothing more, the reply takes one of its owner's `AGENT_MAX_CONCURRENT_RUNS` slots and, if it was admitted,
  its hold still counts against the owner's points. Keep the overlap short.
- **TLS terminates at the proxy** in front; the service speaks plain HTTP on `PORT` and must be reachable
  only through that proxy (otherwise a client could forge `CLIENT_IP_HEADER`). The proxy must pass WebSocket
  upgrades on `/api/ws`.
- **Same origin.** Users reach both the pages and `/api` at `APP_ORIGIN`; the Content-Security-Policy of the
  pages allows nothing else.
- The server sweeps unsent uploads itself (`SWEEP_INTERVAL_MINUTES`); `attachments:sweep` is only for running it by hand. Back up the database (and the bucket), and keep `PROVIDER_KEY_SECRET` with the backups.

## Backup and restore

Two things hold all state: the Postgres database and the attachment store (the bucket, or `BLOB_DIR`); a third
must travel with them: `PROVIDER_KEY_SECRET`, which the providers' saved keys in the database are encrypted under.

- Database: `pg_dump -Fc -d <db> -f af.dump`, restore into an empty database with
  `pg_restore --no-owner -d <newdb> af.dump` (the dump carries the three extensions).
- Attachments: copy every object to the new bucket under the same key (or copy `BLOB_DIR`).
- Start the service against the restored pair with the **same `AUTH_SECRET`** and **the same `PROVIDER_KEY_SECRET`**
  (without it the providers' saved keys cannot be opened) and the new `APP_ORIGIN`.

Take the database dump first and the objects second: an object without a row is swept later, a row without an
object is a broken attachment. Rehearsed on the acceptance environment on 2026-11-16
(`docs/acceptance/batch1/README.md`); nothing is scheduled yet.

## Changing the sending domain

`APP_ORIGIN` is the address people open the site at; the domain mail is sent from is a separate thing, and changing either leaves the other alone. When the **sending** domain changes (a new domain, or a new sub-domain such as `notify.`):

1. At the mail provider, add the new domain and publish the DNS records it shows you (SPF and DKIM at least; a DMARC record is advised), then wait until it reads as verified. Mail from an unverified domain is refused (a 4xx, so the mail is marked `failed`, not retried).
2. Set `MAIL_FROM` (and `MAIL_REPLY_TO` if you use one) to addresses on the new domain, and restart the service. Nothing else in the service names a domain.
3. Mail already waiting is sent from the new address after the restart (a mail past its own expiry ends `expired` instead).

If the **site** address changes, change `APP_ORIGIN` (links in mail follow it) and see the move notes above; `MAIL_FROM` need not change.

What the service shows of the mail: `docker exec <container> node dist/cli.js mail:status` prints, per day for the last 7 days, how many mails were queued, sent, failed, expired and capped (over the per-address cap), and how many retries there were, and how many rows were written in `outbox` mode and are never to be sent (in `outbox` mode every row stays `queued` and that number is all there is; the table is read with `inbox:list`). Everything is counted from `mail_outbox`; nothing is written to the memory counters. If the provider refuses the key or the sending domain (401/403) the sender pauses itself (one error line in the log, one probe every 5 minutes) and `mail:status` prints a warning line; fix `RESEND_API_KEY`, `MAIL_FROM` or the domain at the provider and the waiting mail goes out by itself.

## Not covered here

The image is built for real by Railway on every deploy of the acceptance environment; it has not been built
with a local `docker build` (the development machine has no Docker).
