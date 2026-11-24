# CI: what runs on GitHub for every push

The workflow is `.github/workflows/ci.yml` (named "Verify"). It runs on every push to any branch and on pull requests,
and a newer push to the same branch cancels the run that is still going. A push that only touches `docs/`,
`.superpowers/`, `*.md` files or `app/ios/` starts nothing. It needs no secret: the only outside value is the address of
a throwaway Postgres that each job starts for itself.

## The jobs (they run side by side)

| Job | What it does | Expected time |
| --- | --- | --- |
| service typecheck | `npm ci`, `npx tsc --noEmit` in `app/service` | about 1.5 min |
| service tests (shard 1/6 .. 6/6) | each shard has its own Postgres 18 and runs a sixth of the test files: `npx vitest run --shard=i/6` | 4 to 7 min each |
| memory calibration check | `node scripts/calibrate-memory.mjs --check` | under 1 min |
| web lint, tests, build | `npm test` (lint, then unit tests) and `npm run build` in `app/web` | about 3 min |
| browser suite (Chromium, parts 1/4 .. 4/4) | a quarter of the Playwright spec files in `app/web/e2e` per part (`--shard=i/4`), each against its own Postgres and a service the suite starts itself | 4 to 6 min each |
| browser suite (WebKit) | same suite in WebKit; only when started by hand | not on a push |
| old root project | the old project at the repository root, unchanged | about 2.5 min |

Why 6 service shards: the service suite is about 3,500 tests that run one file after another against one database, 13 to 36
minutes on one machine. The first run with 4 shards took 4 to 9 minutes per shard (shards are split by test file, not by
how long a file takes, so they are uneven); 6 keeps the slowest near 6 minutes. More shards only add about a minute and a
half of set-up each. To change the number, edit `matrix.shard` and `--shard=${{ matrix.shard }}/6` in the `service` job.
The browser suite is split the same way in 4 parts.

The Postgres of each job is started with `docker run` (not a service container) so it can run without waiting for the
disk: the tests empty the tables after every test and this database is thrown away with the job. The version is 18,
the one the acceptance database runs (`docs/acceptance/batch1/README.md` says a dump restores on Postgres 18).

## How to read a failed run

1. Open the run in the Actions tab. The red job names tell which part failed (`service tests (shard 3/4)`, `browser suite`...).
2. At the top of the run page, the Summary shows one table per service shard: passed, failed, skipped, total, and the
   names of the failed tests with their file.
3. Open the job and its failing step for the full log. A skipped count above a handful is worth a look.
4. A failed browser run keeps its report: at the bottom of the run page, download `playwright-report-chromium-<part>`
   (open `index.html` in it; traces of failed tests are inside).

## Run the WebKit browser suite

Actions tab, "Verify", "Run workflow", tick "Also run the browser suite in WebKit". (The button exists once this
file is on the default branch.)

## The daily model catalogue update

Once a day the list of models the service knows about (which can see pictures, think, use tools…) is refreshed from
the public models.dev catalogue. It is made of two files:

- **The job** — `.github/workflows/catalog-update.yml`, on the development branch. It checks out the development
  branch, downloads the catalogue and rewrites `app/service/src/providers/model-catalog.json` (and
  `provider-catalog.json`). If nothing changed, it stops. If something changed, it runs the service type check and the
  tests that read the catalogue, and only when they pass commits the new files to the development branch, with a
  message saying which models were added, removed or changed. If the download looks broken (the list shrank by more
  than a fifth, many models lost what they could do, one whole ability vanished or appeared everywhere), it refuses,
  the run is red, and nothing is committed.
- **The trigger** — `docs/dev/catalog-update-trigger.master.yml`. A dozen lines: run every day at 03:17 UTC (and from
  a button), allow writing to the repository, call the job at the development branch. It is kept under `docs/` so that
  it does nothing where it is.

**What the owner approves, once: one file on `master`.** GitHub only runs schedules (and only shows the Run button)
for workflow files on the default branch. To switch the daily update on, copy
`docs/dev/catalog-update-trigger.master.yml` to `master` as `.github/workflows/catalog-update-trigger.yml` — that file
and nothing else. From then on the steps, the guards and the list of tests are changed on the development branch like
any other code (the copy that is tested is the copy that runs); `master` is not touched again for them.

**When the development branch changes**: the branch is named in the trigger only, on two adjacent lines (after `@` in
`uses:`, and as `branch:`) — GitHub accepts no variable after `@`, so it cannot be one line. Change both to the new
name, in the copy on `master` and in the copy under `docs/dev/` (a test checks the two lines agree). The job's file
names no branch. The new branch must contain the job's file.

**Running it by hand.** Once the trigger is on `master`: Actions tab, "Model catalogue update", "Run workflow" (or
`gh workflow run catalog-update-trigger.yml`). That is the only button: the job has none of its own, on purpose — once
its file reaches `master` through an ordinary merge, a button there would run it on `master` and commit a snapshot
straight to it. Until the trigger is on `master`, run the update locally, from `app/service` on the development branch
(Postgres running, as for any service test):

    npm run catalog:update -- --guard
    npx tsc --noEmit
    npx vitest run tests/model-catalog.test.ts tests/provider-catalog.test.ts tests/provider-hints.test.ts tests/providers.test.ts tests/models-route.test.ts tests/build.test.ts

and, if the checks pass, commit the three files it wrote under `src/providers/` (`model-catalog.json`,
`provider-catalog.json`, `model-catalog.README.md`) to the development branch. If the first command says the snapshot
is unchanged apart from the date in `model-catalog.README.md`, there is nothing to commit: put that file back
(`git checkout -- src/providers/model-catalog.README.md`).

**After the trigger is on `master`**, a later merge of `master` into the development branch brings
`.github/workflows/catalog-update-trigger.yml` along. That is expected and harmless (GitHub runs a schedule only from
the default branch). A test allows exactly that file there, as long as it is the same text as the copy under
`docs/dev/`; any other workflow file that runs on a schedule or calls the job fails the test.

**Who looks at a red run.** Nobody is paged: a failed run shows red in the Actions tab and GitHub mails whoever last
edited the trigger (for scheduled runs). A red run is always safe — nothing was committed — and has one of three
causes: models.dev was unreachable three times in a row (tomorrow's run fixes itself); the guard refused the download
(look at the run's log: it says which number moved; if the catalogue really changed that much, run it by hand without
`--guard` and commit); or a test failed because the catalogue changed something a test relies on (fix the test on the
development branch). Until someone does, the snapshot simply stays as it is.

**Limits worth knowing** (GitHub's rules, checked against its documentation for reusable workflows):

- `uses:` takes no variable or expression, and inside the called job GitHub's own "current branch" is the caller's
  (`master`), not the development branch — which is why the trigger passes `branch`.
- Permissions pass from the trigger down to the job and can only stay the same or shrink there: the trigger must grant
  `contents: write`, and no secret needs to be passed. If the repository or organisation forbids workflows to write,
  or the development branch gets protection rules, the push is refused and the run is red.
- Calling the job "at the development branch" means whatever that branch contains at that moment runs with the right
  to push to the repository — the same people who can push to the development branch already decide what its code is.
  The token is not on disk while packages are installed and tests run, and only the last step names it. That keeps
  it from being read by those steps; it does not stop them from leaving something on the same machine that the last
  step then runs (a git hook, a line in the git settings or in the runner's environment files), and the two GitHub
  actions receive the token anyway. The packages installed are exactly the lock file's. A real wall would be a second
  job that receives only the three files; not built, because nothing here runs code from outside the branch.
- The guard counts per ability, and two abilities are on few models (video out on about 10, audio out on about 20):
  three or four of those retired upstream in one day refuse the whole update. Expect that red run now and then; the
  answer is the one above (run it by hand without `--guard`, look at the summary, commit).
- A commit the job pushes does not start "Verify" (GitHub does not start workflows from a workflow's own push); the
  next ordinary push does. The job itself has run the type check and the six test files.
- On a public repository GitHub switches a schedule off after 60 days without any repository activity.
- The actions (`actions/checkout@v4`, `actions/setup-node@v4`) and the Postgres image are pinned by major version, as
  in `ci.yml`, not by commit hash.

Details: `app/service/README.md`, "Model providers", The daily catalogue update.

## Re-run one shard on your own machine

From `app/service`, with your usual `.env`:

    npx vitest run --shard=2/6

To run exactly what CI runs for a shard, use the same numbers (`i/6`). A shard run on its own needs a fresh test
database if a migration changed (see `lane-rules.md`, "Running the service suite in shards"). The whole suite split
over local databases: `node ../../scripts/dev/shard-tests.mjs -n 4 --tag <letters>`.
Web: `npm test` and `npm run build` in `app/web`. Browser suite: `npm run e2e` in `app/web`.
