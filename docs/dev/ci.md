# CI: what runs on GitHub for every push

The workflow is `.github/workflows/ci.yml` (named "Verify"). It runs on every push to any branch and on pull requests,
and a newer push to the same branch cancels the run that is still going. A push that only touches `docs/`,
`.superpowers/`, `*.md` files or `app/ios/` starts nothing. It needs no secret: the only outside value is the address of
a throwaway Postgres that each job starts for itself.

## The jobs (they run side by side)

| Job | What it does | Expected time |
| --- | --- | --- |
| service typecheck | `npm ci`, `npx tsc --noEmit` in `app/service` | about 1.5 min |
| service tests (shard 1/4 .. 4/4) | each shard has its own Postgres 18 and runs a quarter of the test files: `npx vitest run --shard=i/4` | see the first run's timings below |
| memory calibration check | `node scripts/calibrate-memory.mjs --check` | under 1 min |
| web lint, tests, build | `npm test` (lint, then unit tests) and `npm run build` in `app/web` | about 3 min |
| browser suite (Chromium) | the Playwright suite in `app/web/e2e`, against a service the suite starts itself | to be measured |
| browser suite (WebKit) | same suite in WebKit; only when started by hand | not on a push |
| old root project | the old project at the repository root, unchanged | about 2.5 min |

Why 4 shards: the service suite is about 3,500 tests that run one file after another against one database, 13 to 36
minutes on one machine. Four shards bring that to a quarter plus about a minute and a half of set-up each. More shards
would only add set-up. Shards are split by test file, not by how long a file takes, so one shard can run longer than
another. Raise the number in two places (`matrix.shard` and `--shard=${{ matrix.shard }}/4`) if one shard stays the
slowest by far.

The Postgres of each job is started with `docker run` (not a service container) so it can run without waiting for the
disk: the tests empty the tables after every test and this database is thrown away with the job. The version is 18,
the one the acceptance database runs (`docs/acceptance/batch1/README.md` says a dump restores on Postgres 18).

## How to read a failed run

1. Open the run in the Actions tab. The red job names tell which part failed (`service tests (shard 3/4)`, `browser suite`...).
2. At the top of the run page, the Summary shows one table per service shard: passed, failed, skipped, total, and the
   names of the failed tests with their file.
3. Open the job and its failing step for the full log. A skipped count above a handful is worth a look.
4. A failed browser run keeps its report: at the bottom of the run page, download `playwright-report-chromium`
   (open `index.html` in it; traces of failed tests are inside).

## Run the WebKit browser suite

Actions tab, "Verify", "Run workflow", tick "Also run the browser suite in WebKit". (The button exists once this
file is on the default branch.)

## Re-run one shard on your own machine

From `app/service`, with your usual `.env`:

    npx vitest run --shard=2/4

To run exactly what CI runs for a shard, use the same numbers (`i/4`). A shard run on its own needs a fresh test
database if a migration changed (see `lane-rules.md`, "Running the service suite in shards"). The whole suite split
over local databases: `node ../../scripts/dev/shard-tests.mjs -n 4 --tag <letters>`.
Web: `npm test` and `npm run build` in `app/web`. Browser suite: `npm run e2e` in `app/web`.
