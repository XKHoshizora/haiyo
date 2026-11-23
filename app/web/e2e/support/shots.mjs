// Screenshots for the acceptance record (docs/acceptance/<batch>/shots/, batch2a unless a spec names another), taken only
// when E2E_SHOTS=1 (an ordinary run leaves the repository as it was). Every shot is of this run's own seeded people and
// Agents: generated names, fake keys.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { WEB_DIR } from "./env.mjs";

/** The batch whose record the shots go to when a spec names none. */
const DEFAULT_BATCH = "batch2a";
const dirOf = (batch) => path.resolve(WEB_DIR, "..", "..", "docs", "acceptance", batch, "shots");
const SIZES = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];

/** Whether this run takes the shots. */
export const shooting = process.env.E2E_SHOTS === "1";

/**
 * `<name>-desktop.png` (1440×900) and `<name>-mobile.png` (390×844) of the page as it is. `mobile()` puts the page in
 * the state the phone shot shows (e.g. back to a list), after the desktop one; `show` is scrolled into view in each.
 * `batch` names the record (docs/acceptance/<batch>/shots/; batch2a when not given). The viewport is restored afterwards.
 */
export async function capture(page, name, { mobile, show, batch = DEFAULT_BATCH } = {}) {
  if (!shooting) return;
  const dir = dirOf(batch);
  mkdirSync(dir, { recursive: true });
  const before = page.viewportSize();
  // What was just shown is marked read only after it has been on screen for a moment (READ_DELAY_MS in ChatView):
  // the shot waits for that, as a person would, so it does not show a moment-old unread count.
  await page.waitForTimeout(900);
  try {
    for (const [label, size] of SIZES) {
      await page.setViewportSize(size);
      if (label === "mobile" && mobile) await mobile();
      if (show) await show.scrollIntoViewIfNeeded();
      // A conversation shown at its newest message (a narrower page makes its list taller).
      if (!show) {
        await page.evaluate(() => {
          for (const list of document.querySelectorAll('[data-testid="message-list"]')) list.scrollTop = list.scrollHeight;
        });
      }
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(dir, `${name}-${label}.png`), animations: "disabled", caret: "hide" });
    }
  } finally {
    if (before) await page.setViewportSize(before);
  }
}

/** `capture` into the record of `batch` (e.g. "batch2c"): `captureIn("batch2c")(page, name, options)`. */
export const captureIn = (batch) => (page, name, options = {}) => capture(page, name, { ...options, batch });

const POLISH_DIR = path.resolve(WEB_DIR, "..", "..", "docs", "acceptance", "polish-2026-11-22", "shots");

/** One screenshot `<name>.png` of the page as it is, for the polish round's acceptance record (only with E2E_SHOTS=1). */
export async function polishShot(page, name, { clip } = {}) {
  if (!shooting) return;
  mkdirSync(POLISH_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(POLISH_DIR, `${name}.png`), animations: "disabled", caret: "hide", clip });
}

/** Lane socialb's shots (the use page and the Agent form), under .superpowers/sdd/2026-11-22-polish/socialb-shots/ of the checkout's top folder. */
const SOCIALB_DIR = path.resolve(WEB_DIR, "..", "..", "..", "..", ".superpowers", "sdd", "2026-11-22-polish", "socialb-shots");

/** One screenshot `<name>.png` of the page as it is for lane socialb's report (only with E2E_SHOTS=1). */
export async function socialbShot(page, name, { fullPage = false } = {}) {
  if (!shooting) return;
  mkdirSync(SOCIALB_DIR, { recursive: true });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(SOCIALB_DIR, `${name}.png`), animations: "disabled", caret: "hide", fullPage });
}

