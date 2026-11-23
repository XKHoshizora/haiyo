# Review round 4 (scoped): the round-3 fixes and Proposal A (`origin/lane/mac-app-shell`, bad4505..f76c93b)

Scope: 80ef86d, 0df73d1, f37186f, f76c93b. Read from the branch with `git show` against the diff
(`ios-shell-r3fix.diff`), the round-3 review and the earlier rounds' rules. Read only: nothing was built or run
(Windows), so every "measured" value below is the author's and is repeated in the device checklist. Line numbers are on
the branch at f76c93b.

**Verdict: APPROVE.** Critical 0, Important 0, Minor 9. Both Important items of round 3 and all 11 minors are fixed in
the code. The bridge boundary is unchanged: `hello` still passes the origin gate at arrival and again at delivery, and
the new `bridgeHelloDelivered` runs only on the delivered path. The minors below are hardening and wording; none blocks
internal TestFlight.

## 1. Round-3 findings

| Item | Status | Where (branch) | Note |
|---|---|---|---|
| R3-I1 stopgap inert before 27.1 | Fixed | `PageLayout.swift:95-100` (rule), `:51`, `:209` (`isPad` from the observer's trait idiom), `:129-131` | iPad only; `cornerVertical.top > safe.top` → `cornerVertical.top`. No reserved region is read for it, so it works from 26.0. The occlusion test is gone from the app (only `DebugProbe.swift:165` still logs occlusions, inside the debug build). See M1 for the one fragile spot |
| R3-I2 desktop content mode on iPad | Fixed | `PageNavigator.swift:210-218` (`WebViews.configuration`), used at `ShellViewController.swift:62` and `SheetViewController.swift:32` | One shared configuration; `.mobile` on both. The delegate implements the policy callback without the preferences parameter, so nothing overrides the default per navigation |
| R3-1 `layout` in `hello` when not listed | Fixed | `ShellViewController.swift:328-333` | Only when `events.contains("layout")` |
| R3-2 `hello` takes effect at arrival | Fixed | `Bridge.swift:74-76, 85-92`; `ShellViewController.swift:316-341` | `pageEvents` and the stopgap change only in `bridgeHelloDelivered`, which `deliver` calls after `send(value, nil)`; the refused path calls nothing |
| R3-3 sheet sends any own page to the main view | Fixed (the optional rule was taken) | `NavigationPolicy.swift:57` (new window), `:68-70` (main frame); `PageNavigator.swift:26, 54, 173` | See 2d, M2, M3 |
| R3-4 `isOwnFile` on the decoded path | Fixed | `ShellConfig.swift:55-58`; row in `NavigationPolicyTests` | See M7 for where such a link goes now |
| R3-5 deferred "activity started" mark | Fixed | `Downloads.swift:113-145` (locked class), `:161-164` (mark before the URL is returned) | See 2g, M5 |
| R3-6 fold axis, non-finite values | Fixed | `PageLayout.swift:61-76` (axis from the unclipped frame at `:73`), `:59`, `:65`, `:79`, `:98`, `:102-108` | See M8 (finite but huge) |
| R3-7 README toolchain line | Fixed | `README.md` "Build and test" | Xcode 27.1 or later |
| R3-8 no guard on the Store iPad choice | Fixed | `project.pbxproj:216` ("Check origin"), README "Configurations" | See 2f, M6 |
| R3-9 build-number test restates the constant | Fixed | `ShellConfigTests.swift:14-16` | Positive integer |
| R3-10 layout state machine untested | Fixed | `PageLayout.swift:113-166` (`LayoutState`), `LayoutStateTests` (6 tests) | The view controller only applies outputs (`ShellViewController.swift:162, 216, 295, 303-308, 340`) |
| R3-11 docs drift | Fixed | README `haiyo:layout` (x 455, width 41), plan §2 row (`.vertical`), `testFractionalCornersRoundUp` | |

Still open from round 2 and not claimed here: R2-4, R2-5.

## 2. The seven points of attention

### a. The stopgap by the corner rule alone

By reading, with the author's measurements taken as given (full screen 0 in both orientations; window 53 on 27.2, 75
on 27.0):

| State | Result |
|---|---|
| iPad full screen, portrait and landscape | 0, as long as UIKit reports `cornerVertical.top == safe.top` exactly (M1) |
| iPad window, Split View tile, Slide Over, Stage Manager, external display | The rule is the same in all of them: inset = `cornerVertical.top` when a top corner needs room. Only "a window" is measured; the rest are device checks 46 |
| Controls on the trailing side (RTL system language) | Covered: the rule reads only `top`, no side. This closes the round-3 RTL question for the stopgap |
| Rotation or resize mid-load | A commit applies the last settled sample; the new sample replaces it 0.15 s after the geometry stops. Last state wins |
| Page later sends `hello` with `layout` | `helloDelivered` sets `pageHandlesLayout`, `obscuredTop` becomes 0, and `apply` writes the inset only when it differs (`ShellViewController.swift:304`). It clears once. A second `hello` with `layout` changes nothing; a second `hello` without it puts the inset back, which is right |
| Reload, back/forward | Every main-frame commit calls `pageChanged()`: inset back until the new document's `hello` is delivered |
| Back/forward cache | The restored page runs no script by itself. Until it re-sends `hello` on `pageshow` (README already asks for this) it is held 53 pt down while still applying its own `corner.top`. Web-side rule, unchanged by this round; check 47 |
| Content process terminated | `pageChanged()` at once (`:216`), then again at the reload's commit. No stale "handles layout" |
| Before the first sample | `sample == nil` → 0; the first settle comes ~0.15 s after the first layout, well before a page is shown |
| iPhone, every state | `guard sample.isPad` first (`PageLayout.swift:96`): always 0. `LayoutState.obscuredTop` has no other source |
| iPhone Duo, inner display | 0 if its idiom is `.phone` on both displays. That is the expectation for a device named iPhone and the tests assume it (`isPad` defaults to false), but the code cannot prove it: check 48 |

Two things outside the table. If the app is ever made available on Apple silicon Macs ("Designed for iPad"), its idiom
there is `.pad` and the rule is unmeasured; the build settings say no, App Store Connect availability is owner item 42.
And whether UIKit re-runs `updateConstraints()` when only the corner adaptation changes (a window moved, not resized)
was already unverifiable in round 3; it now matters on 26.x/27.0 too, since no reserved region is read there (check 46).

### b. `LayoutState` transitions

No sequence found that leaves a stale inset, or sends a duplicate or drops an event:

- `settled`: stores the sample; an event only if the page handles `layout` and the value differs from `sent`.
- `pageChanged`: clears `pageHandlesLayout` and `sent`; no event; inset from the current sample.
- `helloDelivered`: `sent = replied`, then `output()` compares with the current value. If the window changed between
  the reply and its delivery the page gets one correcting event; otherwise none.
- `hello` before any sample: the reply carries zeros, `sent` is zeros, and the first settle sends the real value once.
- Two `hello`s from one page: the second finds `sent == current`; no duplicate.

One observation, not a defect: `helloLayout` (`ShellViewController.swift:19, 331, 340`) is a slot in the view
controller between building the reply and its delivery. It is correct only because `completion(reply)` →
`deliver` → `bridgeHelloDelivered` run synchronously in one main-queue turn. See M9.

### c. Events take effect on delivery

A `hello` answer is refused only when `host.bridgePage` differs from the one at arrival: the generation changed (a
commit, or the content process died) or the page left the origin. In each case a new document follows and sends its
own `hello`, so the page that is shown recovers. The refused page gets `forbidden`, and the shell keeps "no events"
plus the stopgap, which is the safe state.

The one case with no automatic recovery is the R2-6 ordering window (the new document's `hello` arrives before the
shell hears `didCommit`). Before this round the shell recorded the events and the commit then wiped them silently.
Now the page gets `forbidden`, which it can see. Nothing in README tells the page to send `hello` again after
`forbidden`; one sentence there would close it (folded into M2's doc edit list as a suggestion, not counted).

Same-document navigations (`pushState`, `#fragment`) must not bump the generation. `didCommit` is not expected for
them, but that is WebKit behaviour I cannot run here: check 47.

### d. The sheet's "first load" allowance

"First load" is: `role == .sheet && !hasCommitted` (`PageNavigator.swift:54`), where `hasCommitted` becomes true at the
sheet web view's first `didCommit` (`:173`) and never goes back.

A crafted attachment cannot use it. Content runs only after its document has committed, and at that point the flag is
already true; so a meta refresh, `location =`, a form or script in an HTML, SVG or PDF file is `userActivated == false`,
`sheetFirstLoad == false` → `.refuse`. Before the commit, the only main-frame navigation actions are the sheet's own
request and the server's redirects of it. A redirect target is chosen by the service, not by the file. A link to an
own redirecting `/api/…` URL gives an attacker nothing they do not already have: a plain `target=_blank` link to the
app path goes to the main view by the pre-existing rule, and both need the person's tap in the chat. A first load that
becomes a download never commits, but then the sheet has no document that could navigate.

`window.open` from the sheet: `createWebViewWith` passes `inSheet` and the default `sheetFirstLoad: false`
(`PageNavigator.swift:103-110`), so an app page is refused unless WebKit reports a link activation.

What the rule does not stop is the other half: `userActivated` is `navigationType == .linkActivated`, and README
itself records that a script's `element.click()` is reported the same way. A scripted inline type could still open any
own path in the main view. Today no such type is shown inline (images only), so this is wording, not a hole: M2.

### e. Proposal A: `ApnsEnvironment`

- **Locating the XML** (`PushCenter.swift:25-31`): first `<?xml`, then the first `</plist>` after it, and the slice goes
  to `PropertyListSerialization`. Apple's profiles are DER with the plist as one contiguous octet string, the CMS
  header before it holds no such bytes, and inside the plist every string is XML-escaped and the certificates are
  base64, so neither marker can appear early. A BER-chunked payload would split the plist and fail to parse.
- **Several `aps-environment`**: not a string search. The value is read as `plist["Entitlements"]["aps-environment"]`
  from the parsed dictionary, so other occurrences (a profile name, a comment) do not count.
- **Malformed, truncated, huge, other encoding**: every failure is `nil` → "production". No bound on the size, but the
  file is the app's own sealed resource (covered by the code signature, read-only on the device), not outside input.
- **Which value is safe**: "production" is the right fallback.
  - Wrongly "production" on a development-signed build: the service sends a sandbox token to the production host,
    Apple answers `BadDeviceToken`, the service drops it. Cost: that developer's phone gets no pushes. Nobody else.
  - Wrongly "sandbox" on a distribution-signed build (TestFlight, App Store): the same refusal on the sandbox host,
    and every tester or customer on that build gets no pushes. This is the expensive mistake, and the code can reach
    "sandbox" only through a successfully parsed `development` or the simulator.
- **Mapping**: development profile → sandbox; App Store/TestFlight, ad hoc and enterprise profiles (all `production`)
  and no profile → production; a profile without the entitlement → production (no token can come anyway).
- **Cost and thread**: `static let current` is initialised once, lazily and thread-safely, on the main thread at the
  first `push.register` (`ShellViewController.swift:344`). One read of a file of some tens of kB, just before a system
  prompt: cheap enough.
- **Logging**: nothing of the profile is logged. Nothing at all is logged, also when a profile exists and cannot be
  read: M4.
- **Leftovers**: `HAIYO_APNS_ENV`, `HaiyoApnsEnvironment` and `apnsEnvironment` are gone from the branch (grep), from
  `Info.plist` and from the build phase.

### f. The Store/iPad build-phase guard

- `ACTION=install` is what both Xcode's Product → Archive and `xcodebuild archive` set, so both are refused. The phase
  has `alwaysOutOfDate = 1` and runs on every build.
- It never touches the Acceptance/TestFlight build: the test is `HAIYO_CHANNEL = store` only, and it comes after the
  acceptance guard.
- `TARGETED_DEVICE_FAMILY = 1` in `Store.xcconfig` does take effect: the app target no longer sets the family in the
  project file (the three `1,2` entries at `project.pbxproj:388, 403, 418` are the test target's).
- Ways past it by accident: M6.

### g. `ShareCleanup` under the lock

All three entry points take the one `NSLock`; `removeIfDone` is only called with it held; the three flags are never
read outside it; `removed` makes the answer "remove now" come at most once. `@unchecked Sendable` is justified by the
lock. `SharedFile` holds only `let`s. No deadlock: nothing is called out while the lock is held.

What the lock does not cover is the gap between the decision and the removal: M5.

## 3. New findings

### Critical
None.

### Important
None.

### Minor

- **M1. The corner rule compares two fractional values with a strict `>`; any difference, however small, pushes the page
  down by the whole top inset.** `PageLayout.swift:97-99`.
  Scenario: a real iPad (or a model not among the three simulators measured) reports `cornerVertical.top` 32.3 against
  `safe.top` 32 in full screen. The tests' own comment says corner-adapted insets are fractional (17.3 on the Duo).
  Every unaware page on that iPad is then held 32 pt down in full screen. README states the premise and asks for a
  check on the first real iPad, so this is known; a margin would make it robust instead of measured. The measured
  extras fall into two groups: rounded corners 6–18 pt, window controls 43 pt. Requiring `top - safe.top` of, say,
  24 pt or more separates them and also absorbs rounding. If the simple rule stays, keep check 44 as a gate before
  any iPad build goes beyond internal testers.
- **M2. README says more than the sheet rule gives.** `README.md` "Navigation" ("a tapped link in it opens the app page
  in the main view, and nothing else in it can"), against `NavigationPolicy.swift:30-32` and `:69`.
  A script's `element.click()` is reported as a link activation (the same README, two paragraphs down). An inline type
  that runs script (HTML, SVG) could open any own path in the main view without a tap; the rule only stops refreshes,
  `location` changes, forms and `window.open`. Say so, and name the real dependency: the service must never show a
  scriptable type inline. While editing, add that a page whose `hello` is rejected with `forbidden` should send it
  again (2c).
- **M3. In the sheet, a tapped file link whose load is redirected to the sign-in page does nothing.**
  `PageNavigator.swift:124-125` (`webView.load` for `.sheet` inside the sheet), `NavigationPolicy.swift:68-70`.
  Scenario: an inline type with links exists (the future PDF case), the sheet has been open past the session's end,
  the person taps a link to another attachment. The shell starts a fresh load; the service redirects to `/login`; that
  is neither a link activation nor the first load, so it is refused and the sheet stays as it was, with no message.
  Not reachable today (images have no links). Either accept and note it, or treat a load the shell itself starts in
  the sheet like the first one — but only if the old document cannot navigate in that window, which needs care.
- **M4. An unreadable profile is silent.** `PushCenter.swift:15-21`.
  Scenario: a future Xcode writes the profile differently (chunked payload, another container). Every
  development-signed build then says "production", its tokens are refused, and nothing in the log points at the
  cause. Log one line when a profile file exists but gives no dictionary, as flags only (`ShellLog.note("apns-profile",
  ("present", .flag(true)), ("parsed", .flag(false)))`), never its content. Add a truncated case to the test
  (`<?xml` without `</plist>`).
- **M5. `ShareCleanup` decides under the lock, but the folder is removed after it is released, and a late
  `activityStarted()` cannot be told that the file is gone.** `Downloads.swift:57, 63-66, 120-122`.
  Scenario (iPad): the popover's `viewDidDisappear` runs on the main thread, `sheetGone()` returns true; before
  `remove()` runs, the sheet asks for the item on its background thread, `activityStarted()` sets the flag and the URL
  is returned; then the folder is removed and the activity reads nothing. The same result, without any race, if UIKit
  asks for the item only after the popover has disappeared. Round 3's fix makes the mark synchronous, which closes the
  ordering it described; this is what is left. Hardening: run the removal inside the lock (pass the closure to
  `sheetGone`/`activityEnded`), and let `activityStarted()` return false once `removed` is set so `SharedFile` returns
  no item. Check 35 still decides whether it ever happens.
- **M6. Ways around the Store/iPad guard.** `project.pbxproj:216`.
  - Only `ACTION=install` is tested. A Store build made with `xcodebuild build` for a device and packaged by hand is
    not refused. Same residual as R2-5 for the acceptance guard.
  - From Xcode's UI the opt-in can only be given by writing `HAIYO_IPAD_RELEASE = 1` into an xcconfig (or by starting
    Xcode from a shell that exports it). Once committed it stays on, and the guard is off for good without anyone
    deciding again. README should say: pass it on the `xcodebuild archive` command line only.
  - `case ",$TARGETED_DEVICE_FAMILY,"` matches `1,2` but not `1, 2`. Xcode writes it without spaces; strip spaces
    first to be sure.
- **M7. `/%61pi/x` is now an app page, so a link to it puts the service's raw answer in the main view.**
  `ShellConfig.swift:55-58`, `NavigationPolicy.swift:58, 71`, `ResponsePolicy` (`NavigationPolicy.swift:100`: only
  status ≥ 500 fails).
  Scenario: someone posts `https://<host>/%61pi/x` in a chat. A tap goes to `openInApp` (new window) or loads in
  place. If the page does not handle `open`, or the link is same-window, the main view loads it and shows whatever the
  service answers (README says a 404; not verified here), with no control except the back swipe. Before this round it
  opened in the sheet, which has a 完成 button. Harmless and recoverable, and plain `/api/missing` behaves as before.
  Possible follow-up outside this round: an own main-frame 4xx that is not HTML shows the cannot-connect screen.
- **M8. `isFinite` does not bound the size.** `PageLayout.swift:67-70, 80`. `Int(CGFloat)` also traps on finite values
  beyond `Int` (a rect at 1e300, or a division by a `pageZoom` near zero). UIKit will not report such values; clamping
  before the conversion would make "never crashes" literally true. Trivial.
- **M9. `helloLayout` lives outside the tested state.** `ShellViewController.swift:19, 329-333, 340`. The value the
  reply carried is parked in the view controller and picked up at delivery. It works because delivery is synchronous
  after the reply is built; a later change that delays delivery would pair a delivery with another `hello`'s layout.
  Carry it with the answer instead (for example in the `delivered` closure). Trivial.

## 4. Tests

Exercise real logic:
- `LayoutStateTests` (6): stopgap on and off, no event for an unchanged value, the correcting event at delivery, start
  over after a commit or crash, the Duo never held down, no geometry yet.
- `testHelloTakesEffectOnlyWhenItsAnswerIsDelivered`: a held `hello` answered after the generation changed gives
  `forbidden` and no `bridgeHelloDelivered`.
- `testTheSheetNeverShowsAnAppPage`: the first-load row, the refused refresh/script row, script `window.open`.
- `testTheApnsEnvironmentComesFromTheSignedProfile`: a synthetic envelope (binary bytes around an XML plist) through
  the real parser; all five outcomes plus "not a profile".
- `testTheSharedItemMarksTheActivityBeforeHandingOutTheFile`: the mark taken off the main thread, then the cleanup
  order.
- `testAPartlyVisibleFoldKeepsItsDirection`, `testNonFiniteValuesGiveNothing`, `testFractionalCornersRoundUp`.

Restate rather than test:
- The landscape case in `testOnlyIPadWindowControlsKeepAnUnawarePageDown` changes only `bounds`, which
  `windowControlsTop` never reads. It documents the measured premise; it cannot fail on its own.
- `testBothWebViewsAreMobile` asserts the configured constant. Fine as a guard against removal; the effect (the user
  agent) is device check 52.

Not covered, testable without a device: the `hasCommitted` wiring in `PageNavigator` (what makes "first load" true
and false); a truncated profile (M4); a margin case for M1 if a threshold is adopted. Not testable in the unit tests:
the build-phase script, a real provisioning profile, the view controller's wiring of `LayoutState`.

Cannot be verified without a Mac (added to round 3's list):
8. That the branch builds and all tests pass with Xcode 27.2. One point to look at: `testTheSharedItemMarks…` calls a
   `UIActivityItemSource` method from a global queue; if the SDK marks that protocol main-actor, check that this
   compiles without an isolation diagnostic in the project's Swift 5 mode.
9. That `Data.range` finds the plist in a real `embedded.mobileprovision` from this team (development and App Store).
10. That the "Check origin" phase behaves as read for Archive from Xcode's UI and from `xcodebuild`.

## 5. Device checklist (continues 1–43)

44. Full-screen iPad, every model at hand and the first real one, portrait and landscape, with `-HaiyoDebugLayout`:
    `cornerVertical.top` equals `safe.top` exactly (look at the fractions), and an unaware page has no band at the top
    (M1). Also with the system's menu bar pulled down in full screen.
45. iPadOS 26.x and 27.0, in a window, today's web build (no `layout`): the page's top-leading control is below the
    window controls; the inset is the logged `cornerVertical.top` (expected 53 mid-screen, 75 at the top of the screen
    on 27.0). Replaces the "expect the controls over the page" of check 32.
46. Split View tiles (halves, thirds), Slide Over, Stage Manager, an external display: the inset is present whenever
    controls are in a top corner and absent otherwise. Move a window without resizing it (mid-screen ↔ top of the
    screen): does the inset follow (53 ↔ 75), on 27.2 and on 26.x/27.0?
47. A page that handles `layout` (the probe page) in an iPad window:
    - on load the inset goes 53 → 0 once, and `debug-layout-event` shows no duplicate;
    - reload; back and forward (including a back/forward-cache restore: the page re-sends `hello` on `pageshow`);
    - an in-page `#fragment` link and a `pushState` route change: the page keeps its events and the inset stays 0;
    - end the web content process: the inset returns, the reload's `hello` clears it once.
48. iPhone Duo, closed and open, with `-HaiyoDebugLayout`: the idiom is phone on both displays and
    `obscuredContentInsets.top` is 0 in every posture for a page that does not list `layout`.
49. `push.register`, on devices:
    - Debug and Acceptance run from Xcode on a phone: `env` is `sandbox`, and the token is accepted by
      `api.sandbox.push.apple.com`;
    - the Acceptance build from internal TestFlight: `env` is `production`, accepted by `api.push.apple.com`;
    - in both, the first call shows no hitch before the prompt;
    - when a Store build exists: `env` is `production` on an App Store install (no embedded profile).
50. Sheet: with an expired session, open an attachment → the sign-in page in the main view (check 43). A redirecting
    own `/api/…` link from a chat message behaves as a plain link to its target.
51. Build guard, on the Mac:
    - Archive of Store from Xcode's UI and with `xcodebuild archive`: both stop with the iPad message (after
      `HAIYO_HOST` is set);
    - with `HAIYO_IPAD_RELEASE=1` on the command line, and separately with `TARGETED_DEVICE_FAMILY = 1` in
      `Store.xcconfig`: both pass;
    - the Acceptance archive with `HAIYO_ACCEPTANCE_UPLOAD=1`: unaffected.
52. iPad mini and iPad Air 11-inch, portrait and landscape, full screen and in a window: the user agent says iPad and
    ends with `HaiyoApp/<version>`, `innerWidth` equals the view width, page scale 1 — in the main view and in the
    sheet. Replaces the open question of check 33.
53. A link to `https://<host>/%61pi/x` in a chat message: what the main view shows, and that the back swipe returns
    to the chat (M7).

Checks 30–43 of round 3 stand, except 32 and 33 as replaced above.
