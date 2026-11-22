// Browser end-to-end suite: `npm run e2e` (local mode) or with E2E_BASE_URL (remote mode); see app/web/README.md.
import { defineConfig, devices } from "@playwright/test";
import { BASE_URL, REMOTE } from "./support/env.mjs";

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.mjs$/,
  outputDir: "test-results",
  // One shared service process: one worker, tests in file order; every test creates its own people.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  forbidOnly: Boolean(process.env.CI),
  reporter: [["list"], ["html", { outputFolder: "playwright-report", open: "never" }]],
  globalSetup: "./global-setup.mjs",
  // Remote mode runs the specs tagged @remote (registration there is rate limited for real: 10 a minute per
  // address); E2E_REMOTE_ALL=1 runs every spec (the restart spec skips itself). `--grep` only narrows this.
  grep: REMOTE && process.env.E2E_REMOTE_ALL !== "1" ? /@remote/ : undefined,
  use: {
    ...devices["Desktop Chrome"],
    baseURL: BASE_URL,
    viewport: { width: 1280, height: 860 },
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "off",
  },
  // E2E_WEBKIT=1 runs the same specs in WebKit (desktop Safari's engine; `npx playwright install webkit` once — nothing is downloaded by the suite):
  // it selects the word under a right-click before `contextmenu` and paints the first frame differently, which Chromium does not.
  projects: process.env.E2E_WEBKIT ? [{ name: "webkit", use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 860 } } }] : undefined,
});
