# Review: iOS shell v0 (`origin/lane/mac-app-shell` 179bbcb, 551d3b5)

Scope: `app/ios/**` on that branch, against the native-layer section (§1.1, §1.2, §1.4, §1.5, §2) of
`docs/design/2026-11-24-store-app-draft.md` and `app/ios/README.md`. Read from source only (no Xcode here); everything
that needs WebKit or a device to settle is in the last section. Line numbers are on the branch.

Spec verdict: **❌ not yet compliant — two binding requirements unmet (C1 reply-time re-check, C2 private data in a
Release log line).** Everything else in the binding list holds (table below).
Quality verdict: **✅ small, well-factored, decisions kept as pure values with real-WebKit tests for the gate; approve
after C1, C2 and the Important items.** Critical 2, Important 6, Minor 16.

## Binding requirements

| Requirement | Status | Where |
|---|---|---|
| Bridge answers only the configured origin's main frame (sub-frames, other origins, http, ports, look-alike hosts, trailing dot, IDN) | ✅ strict equality on `WKFrameInfo.securityOrigin` (scheme, host, port) plus `isMainFrame`; any variant that is not byte-equal is refused | `OriginGate.swift:31-36`, `Bridge.swift:34-38` |
| … a main frame that navigated elsewhere | ✅ `frameInfo` is the snapshot of the posting document; and the main frame cannot commit another origin (policy routes it to Safari) | `NavigationPolicy.swift:46-49` |
| … re-checked when the reply is delivered | ❌ **C1** | `Bridge.swift:51` |
| No JavaScript evaluated in another origin's page | ✅ in substance (main frame can only hold own-origin documents); hardening M1 | `ShellViewController.swift:135-143` |
| No credential / cookie / token read, copied or logged by native | ✅ no cookie store access; data store shared by reference, not copied | — |
| Nothing private logged | ❌ **C2** (Release); Debug-only variant I6 | `Downloads.swift:59`, `ShellViewController.swift:224` |
| Push handling never shows message text | ✅ foreground presentation `[]`; only `c` (UUID) is read | `PushCenter.swift:73-91`, `BridgeMessage.swift:99-102` |
| Navigation only https; never file:/data:/javascript: from page input; URL schemes / universal links cannot load an arbitrary site | ✅ main frame own-https only; no `CFBundleURLTypes`; universal links and notification paths go through `isOwnOrigin` / `url(forPath:)` | `NavigationPolicy.swift:32-54`, `BridgeMessage.swift:89-102`, `ShellConfig.swift:48-69` |
| Downloads stay in a shell-owned temp folder, names sanitised, cleaned up | ✅ containment and naming; cleanup runs too early (I4, functional, not a leak) | `Downloads.swift:18-61`, `LoadFailure.swift:46-57`, `AppDelegate.swift:12` |
| Web security model not weakened | ✅ no `NSAppTransportSecurity` key, no user scripts, handler only in `.page`, popups blocked by default, `createWebViewWith` returns nil; App-Bound Domains considered and declined in plan §1.5 (M15) | `Info.plist`, `ShellViewController.swift:45-50` |
| System-style wording only on the offline screen | ✅ | `LoadFailure.swift:35-42`, `OfflineView.swift` |

## Critical

### C1. `push.register` replies without re-checking who is on the page when the answer arrives
`Bridge.swift:51` (`host.bridgePushRegister { result in reply(result, nil) }`), `PushCenter.swift:35-50` (`waiting`).
The gate runs once, at arrival (`Bridge.swift:35`). `push.register` is the one asynchronous request: the reply waits for
the permission dialog (as long as the person leaves it open) and then for APNs. Nothing checks the main frame again.
Sequence:
1. The own page posts `push.register`; the permission dialog appears.
2. The main frame commits a new document (a full own-origin navigation, a back-swipe, a reload after a content-process crash).
3. The person taps Allow; APNs answers; the token is handed to whatever `replyHandler` WebKit routes it to.
Practical exposure today is low and should be stated honestly: per WebKit's design the reply resolves the promise of
the document that posted (a destroyed document drops it; a back/forward-cached own page gets it later), and the policy
keeps the main frame on the own origin. It is still the stated contract, and the next async request in the plan
(`age.range`, §2) returns more sensitive data through the same path.
Needed: capture a main-frame generation at arrival (increment in `didCommit`), and at reply time require the same
generation and an own-origin `webView.url`; otherwise reply `forbidden`. Put the check in `Bridge.handle` (a
`currentPage: () -> (FrameSource, Int)` closure keeps it testable). Add a `BridgeHandlingTests` case with a host that
holds the completion while the page changes, and a WebKit case (post, load another document, complete).

### C2. A Release log line prints share-sheet errors and the receiving app, marked public
`Downloads.swift:59`:
`log.debug("share sheet closed: activity=\(activity?.rawValue …, privacy: .public) … error=\(String(describing: error), privacy: .public)")`.
Compiled into every build (no `#if DEBUG`).
- `String(describing: error)` prints the whole `userInfo`. A failed "保存到“文件”" or share-extension hand-off typically
  carries `NSURL` / `NSFilePath` = `…/tmp/downloads/<uuid>/<file name>`, so the user's file name (e.g. another member's
  `体检报告-张三.pdf`) is logged unredacted.
- `activity.rawValue` records which third-party app the person sent the file to.
Debug level is not persisted by default, but it is visible unredacted to anyone streaming the device's log (Console with
debug messages on, `log stream --level debug`) and lands in a sysdiagnose when debug persistence is on. The binding
rule names file names explicitly, so this is Critical regardless of level.
Needed: drop both log lines in `share(_:)` (they were development aids), or log only `completed` and
`(error as NSError?)?.domain` / `.code`, never the description or the activity.

## Important

### I1. Nothing stops an acceptance-site build from becoming the App Store build
`project.pbxproj:298, 329, 360`, scheme `ArchiveAction buildConfiguration = "Release"` (`Haiyo.xcscheme:85`).
- Release (the default Archive) = `test.haiyo.org` with production APNs, same bundle id `org.haiyo.app`, same version
  numbers. Store (`HAIYO_HOST = ""`) is reachable only with `-configuration Store`; no scheme uses it.
- In App Store Connect any processed TestFlight build can be added to an App Store version. The binary carries nothing
  that marks it as acceptance-only, and the "Check origin" phase passes for Release.
- Sequence: production host exists → owner archives from Xcode (Release) → uploads → "Add build" on the 1.0 version →
  the store app points at the acceptance site (and its data) for every user.
- The plan said the opposite mapping ("Debug 构建用测试站点，Release 构建用生产站点", §2 files table); README documents the
  new mapping, so this is a deliberate change whose guard is missing.
Needed (any one is enough, two is better): once the production host exists, make the scheme's Archive use Store and
name the TestFlight configuration "Acceptance"; have "Check origin" print `HaiyoHost` and fail an `ACTION=install`
(archive) of the acceptance configuration unless `HAIYO_ACCEPTANCE_UPLOAD=1`; add "`plutil -extract HaiyoHost raw` on
the archive" to the submission checklist in README and in plan §5.
The host itself is a single source of truth (build setting → Info.plist + entitlements → `ShellConfig`), with two small
leaks noted in M6.

### I2. A crashed web-content process is reloaded at once, even in the background, without limit
`PageNavigator.swift:132-134` (`webView.reload()`), `SceneDelegate.swift:40-46`.
iOS kills suspended WebContent processes routinely. The shell reloads immediately:
- In the background, the fresh page never received `haiyo:pause` (sent once at `sceneDidEnterBackground`). The web side
  (S9) connects its socket on load; S5 sends a push only when the session has **no** live socket. Sequence: app in
  background → WebContent jetsammed → reload → socket opens, app suspends → half-open socket on the server for 30–60 s
  (`hub.ts:29` heartbeat) → messages in that window get no push. This repeats with every background kill.
- A page that crashes its process deterministically (huge conversation, decoder bug) reloads forever: battery, data, and
  a flashing screen with no way out.
- An `open` event dispatched into the dead process (`ShellViewController.swift:142`, completion `nil`) is lost silently:
  a tapped notification lands on whatever URL the reload restores.
Needed: when the scene is not foreground-active, mark `needsReload` and reload on `sceneWillEnterForeground` (instead
of sending `resume` to a dead page); cap reloads (e.g. two within 60 s → the unreachable screen with 重试); send `open`
with a completion and fall back to `load(url)` on error. State the contract for S9 in README: "`pause`/`resume` are
hints; a page that loads while `document.visibilityState === "hidden"` must not open the socket."

### I3. A 5xx (or proxy error page) on the main document strands the person
`PageNavigator.swift:47-54` decides responses only by `canShowMIMEType`; `LoadFailure` sees only transport errors.
Sequence: a deploy or platform hiccup returns 502/503 for `/` at launch → `didFinish` fires → the cover lifts
(`ShellViewController.swift:97-108`) → the platform's raw error page fills the screen. The shell has no reload control,
no pull-to-refresh (by design, §1.4) and no address bar, so the only way out is to force-quit. The same happens after
`open(path:)` or 重试.
Needed: in `decidePolicyFor navigationResponse`, for the main frame on the own origin with status ≥ 500, `.cancel` and
show `.unreachable` (the existing system-style screen and 重试). Optionally treat 401/403 from an edge (not the app) the
same way.

### I4. The downloaded file is deleted on the first share-sheet callback, not when the sheet closes
`Downloads.swift:58-61`.
Since iOS 13 `completionWithItemsHandler` also fires when the chosen activity is cancelled or fails while the share
sheet stays on screen (`activityType` set, `completed == false`). Sequence: download → share sheet → 保存到“文件” →
Cancel → back on the share sheet → 隔空投送 or 存储图像 → the file is already gone (failure, or an empty send).
Needed: remove the folder only when `completed || activityType == nil` (the sheet itself was dismissed); the launch
sweep (`AppDelegate.swift:12`) still covers anything left. Confirm the callback pattern on a device (list item 7).

### I5. Every own-origin `_blank` opens a second full app in the sheet
`NavigationPolicy.swift:43-45`, `SheetViewController.swift`.
The sheet is meant for the image viewer's 原图 (plan §2.3). But `Markdown.jsx:37` and `cites.jsx:42` give every message
link `target="_blank"`, so a member posting `https://test.haiyo.org/chat/<id>` or an invite link gets the whole SPA
booted inside the sheet: same session cookie, its own WebSocket, no bridge, no `pause`.
Sequence: open such a link → the sheet shows the app → press Home with the sheet open → the sheet's socket stays live →
S5 sees a live socket for the session and skips pushes; meanwhile the person reads and acts in a second copy of the app
whose state the main page learns only by sync.
Needed: send only file URLs (`/api/attachments/…`, the path `ImageViewer.jsx:255` builds) to the sheet; route other
own-origin `_blank` URLs through `open(path:)` (event or load in the main web view).

### I6. The Debug build logs conversation ids at a persisted level
`ShellViewController.swift:224` (`log.notice("path=\(webView.url?.path …, privacy: .public)")`).
`.notice` is written to the log store; the path is `/chat/<uuid>`, `/agents/<id>`, etc. Debug builds run against the
acceptance site with real accounts. README says "the path (never the query or page content)", which reads as safe but
is exactly "URLs with ids". Debug-only, so Important rather than Critical.
Needed: log the route shape (UUID segments → `:id`) or mark the path `.private`.

## Minor

- **M1. Event delivery checks the URL, not the document.** `ShellViewController.swift:135-143`. `webView.url` is the
  provisional URL during a load; on a cold start `sceneWillEnterForeground` sends `resume` into the initial empty
  document. Harmless payloads today, but put the guard inside the script
  (`if (location.origin === "https://<host>") dispatchEvent(…)`). Also send `pause`/`resume` even when the offline
  overlay is up: after a failed full navigation the old page is still alive behind it, keeping its socket.
- **M2. `hello` differs from the plan, and `PushCenter.status` is dead code.** Plan §2 bridge: `hello → { shell, build,
  os, push }`; README/code: `{ bridge, shell, build, os, events }` (`ShellViewController.swift:164-173`).
  `PushCenter.swift:22-32` is never called. Either wire `push` into `hello` (S9 needs it to re-register silently on each
  launch without risking a prompt) or delete `status`, and make README the one contract.
- **M3. `age.range` / `AgeSignal.swift` (plan §2, §1.6 Texas SB 2420) are not built and README does not say so.** Fine for
  internal TestFlight; it is a store blocker and belongs in README's "still to do".
- **M4. `push.register` never settles if APNs never answers** (simulator, no network, missing entitlement):
  `PushCenter.swift:42-48`. Add a timeout (`{ error: "timeout" }`, ~30 s) and cap `waiting`.
- **M5. `badge.set` always replies `{ ok: true }`**, also when badge permission was never granted (v0: always);
  `PushCenter.swift:66-67` drops the error. Reply after the completion, or document "best effort".
- **M6. Host rule exists twice and the literal three times.** The "Check origin" script (`project.pbxproj:202`) accepts
  `localhost`, `_`, non-ASCII; `isBareHost` (`ShellConfig.swift:31-37`) rejects them → the build passes and the app
  `fatalError`s on launch. Use one regex in both. `HAIYO_HOST = test.haiyo.org` is repeated in Debug and Release
  (`:298`, `:329`); move to one project-level setting or an xcconfig, and add it to the domain-change checklist that
  today says "only APP_ORIGIN".
- **M7. `CURRENT_PROJECT_VERSION = 1` is a literal in six blocks** (`project.pbxproj:293…420`). The next upload is
  rejected until someone edits them all; pass it at archive time (`CURRENT_PROJECT_VERSION=$(date +%Y%m%d%H%M)`) or use
  `agvtool`.
- **M8. The cover has no exit if `didFinish` is late or never comes.** `ShellViewController.swift:97-108`. A slow
  sub-resource delays `load` for up to the request timeout; a first load redirected off-origin opens Safari, WebKit
  reports 102 (ignored), and after closing Safari the person faces a blank lavender screen with no 重试. Lift the cover a
  few seconds after the first commit, and show the unreachable screen if nothing commits in ~15 s.
- **M9. No automatic retry when the network returns.** Offline at launch requires tapping 重试; an `NWPathMonitor`
  (Network is already imported) can retry once the path is satisfied ("seamless over confirmation").
- **M10. Offline screen at large text sizes.** `OfflineView.swift:48` centres the stack with no top/bottom limits and
  no scroll view; at AX sizes the title and button clip off-screen. Retry button is ~42 pt tall (body line + 2×10);
  HIG minimum is 44.
- **M11. `mailto:` / `tel:` / `sms:` open from any frame without a user tap.** `PageNavigator.swift:99-101`. Page script
  can launch Mail/Messages repeatedly; accept only `navigationType == .linkActivated`.
- **M12. Renderable attachments marked `Content-Disposition: attachment` display inline.** `PageNavigator.swift:47-54`
  decides by MIME only. Low impact (the web uses `<a download>`); check the header too.
- **M13. Cold start from a notification.** `connectionOptions.notificationResponse` is ignored; the path arrives via the
  delegate and `pendingPath`, so the shell loads `/` and then the chat (two loads). `onOpenPath`'s `didSet` runs
  `shell.open` before `makeKeyAndVisible` (`SceneDelegate.swift:26`), which works only because assigning
  `rootViewController` loads the view (`webView` is an IUO). Take the path from `notificationResponse` into
  `initialPath`, like universal links.
- **M14. Icon.** The branch still has the plain placeholder; the uploaded build used local commit 89c217b, which is not
  on origin, so the TestFlight build cannot be rebuilt from the branch — push it. The owner's chosen
  `docs/brand/app-icon-temp-1024.png` is RGBA (colour type 6; all pixels opaque, checked): flatten to RGB before it goes
  into `AppIcon.appiconset` to stay clear of ITMS-90717.
- **M15. App-Bound Domains.** Declined in plan §1.5 for good reasons, but it is the one OS-enforced guarantee that
  message handlers and script injection work only on the listed host — exactly the bridge's rule — and the shell
  already sends every other host to Safari. Worth a measured try (WKAppBoundDomains = `$(HAIYO_HOST)` +
  `limitsNavigationsToAppBoundDomains` on both web views); record the outcome in README either way.
- **M16. `HaiyoApnsEnvironment` comes from the build configuration, not the signing profile.** A Release build run from
  Xcode on a device (development profile, sandbox token) reports `production`; the server would then mark a good token
  bad. Acceptable for now; note it for S5 (treat `BadDeviceToken` from one environment as "try the other once").

## The questions in the brief

**Configuration.** One source: `HAIYO_HOST` → `Info.plist HaiyoHost` and `applinks:$(HAIYO_HOST)` →
`ShellConfig.current`; the origin is always `https://<host>` on the default port; a missing or malformed host fails the
build (empty, `/`, `:`, space, `..`, leading/trailing dot) and, failing that, `fatalError`s at launch. Gaps: I1 (wrong
host can ship), M6 (rules and literal duplicated).

**The 25 tests.** Count matches (4 BridgeInWebView, 4 BridgeMessage, 3 BridgeHandling, 1 NavigationPolicy table,
4 OriginGate, 5 ShellConfig, 4 LinksAndFailures). The claim "origin gate with real WebKit frames" is true for the four
`BridgeInWebViewTests`: `loadHTMLString(baseURL:)` gives real documents with real security origins, the handler is the
real `Bridge` with its `WKScriptMessageHandlerWithReply` entry point, and the sub-frame case is a same-origin `srcdoc`
iframe (the hard case). Everything else is pure-value testing, which is fine for what it covers. Untested:
- the reply-time case (C1) — impossible to write today because the check does not exist;
- the WebKit → `NavigationRequest` mapping in `PageNavigator` (target frame nil for `_blank`, `shouldPerformDownload`,
  server redirects re-entering the policy, `window.open`); the table only tests the pure function. A WebKit test can
  click links in a `loadHTMLString` page with a recording presenter;
- real-frame variants of the look-alikes (trailing dot, `:8443`, punycode base URLs) and an opaque-origin document;
- `DownloadCoordinator` (destination, cleanup), `PushCenter` (token hex, waiting, pending path), `showFailure` /
  `retry`, content-process termination, `send` gating and the `open` fallback;
- Release/Store configuration values (only Debug's Info.plist is read).
`testAMainFrameThatNavigatedAwayIsRefused` replaces the document through the API; it shows the gate reads the current
document, not that an in-flight message is re-checked across a navigation.

**Process pool / data store.** Both web views use `WKWebsiteDataStore.default()` (persistent, shared by reference), so
the session cookie set by `Set-Cookie` survives relaunch and is the same in the sheet; `WKProcessPool` is irrelevant
since iOS 15. SFSafariViewController has its own jar (correct: other sites never see Haiyo's cookies, and the person is
not signed in there). Tests use `.nonPersistent()`. The "survives an app update" and ITP questions from plan §1.2 remain
device checks.

**Memory and lifecycle.** Strong references are clean (`Bridge.host` weak, navigator closures `[weak self]`, KVO
observation owned by the sheet). The weak spot is process termination (I2) and the pause/resume contract around it.
Contract as built: `pause` at `sceneDidEnterBackground`, `resume` at `sceneWillEnterForeground` (also on cold start),
`open` only if the page listed it in `hello` (reset on every main-frame commit; a back/forward-cache restore needs the
page to re-send `hello` on `pageshow`). Events are fire-and-forget: a page whose listener is not attached yet, or that
was reloaded in the background, never hears them. S9 should treat them as hints and use `visibilityState` as truth.

**Accessibility.** Offline screen: Dynamic Type on both labels, title is a header, symbol hidden, view modal and
announced with `.screenChanged`; gaps in M10. While the cover is up, VoiceOver can still reach the web view under it
(the cover is not modal) — harmless for a sub-second cover, worth `accessibilityElementsHidden` on the web view while
covered.

**iPad / landscape.** Deliberate: plan §2 "不做 iPad 版面、横屏" (with the iOS 27.2 side-inset bug as the reason),
README "iPhone only, portrait", `TARGETED_DEVICE_FAMILY = 1`, portrait-only Info.plist, Mac and Vision opted out.
App Review will still run it on an iPad in iPhone compatibility mode — device list item 23.

**Privacy manifest.** `NSPrivacyAccessedAPITypes` empty matches the code: no UserDefaults, file-timestamp, boot-time,
disk-space or keyboard APIs (`FileManager` create/remove and `ProcessInfo` arguments are not required-reason APIs).
Collected types (email, user id, device id = push token, messages, photos/videos, other content; linked, not tracking,
app functionality) match plan §4's App Privacy answers. Keys spelled correctly
(`…PhotosorVideos`, `…EmailsOrTextMessages`).

**Purpose strings.** Camera, microphone ("拍照或录像" needs it), photo-library-add present and non-empty (tested). The web
uses no geolocation, `getUserMedia`, speech recognition, WebAuthn or service workers (grep of `app/web/src`: none), so
no other keys are needed; `NSPhotoLibraryUsageDescription` correctly absent (PHPicker).

**App Review, mechanical.** Export compliance key ✓; privacy manifest bundled (synchronized group) ✓; launch screen ✓;
`UIApplicationSceneManifest` ✓; Info.plist and entitlements not copied as resources ✓; no "beta/测试" wording ✓; debug
hooks and `isInspectable` compiled out of Release ✓. Watch: build number (M7), icon alpha and placeholder (M14),
`aps-environment` is `development` in the file — Xcode's App Store export should rewrite it to `production`; confirm on
the uploaded build (item 14). Store-only blockers from the plan (age signal M3, AASA S1, account deletion S7) are
outside v0.

## Deviations from the plan (for the record)

1. Release = acceptance site, Store = production (plan: Release = production). Documented in README; guard missing (I1).
2. `hello` shape (M2); `age.range` absent (M3).
3. `sms:` added to the system schemes (plan: `mailto`, `tel`). Fine.
4. File split differs from the plan's eight files (NavigationPolicy, PageNavigator, OriginGate, BridgeMessage,
   LoadFailure, Downloads, SheetViewController added; Push.swift → PushCenter.swift, Config.swift → ShellConfig.swift). Fine.

## Cannot verify without a device — for the Mac session

1. C1: in Web Inspector on the shell, `postMessage({name:"push.register"})`, then `location.reload()` (or navigate) before
   tapping Allow; note where the reply lands. After the fix: expect `forbidden`/nothing.
2. Opaque origin: load an attachment URL (served with `CSP: sandbox`) in the **main** web view (Web Inspector:
   `location = "/api/attachments/<id>"`) and post `hello` → expect `forbidden`; log `frameInfo.securityOrigin` fields.
3. Real-frame look-alikes: `https://test.haiyo.org./` and `https://test.haiyo.org:443/` as main-frame loads → what the
   gate sees and what the policy does.
4. Server redirect: a main-frame request to an own URL that 30x's to another host (first load and mid-session) →
   `decidePolicyFor navigationAction` is called for the redirect, Safari opens, the cover/offline state is sane.
5. Pause/resume: with a listener added in Web Inspector, background/foreground the app; with the web side in place,
   confirm in the service log that the socket closes within ~1 s of Home and reopens on return.
6. I2: background the app, kill the `com.apple.WebKit.WebContent` process (Simulator: `kill` its pid); watch whether the
   shell reloads while backgrounded and whether a socket appears in the service log. Repeat the kill twice in 60 s.
7. I4: download a file → 保存到“文件” → Cancel → 隔空投送 / 存储图像; then check `tmp/downloads` is empty after the sheet
   closes and after relaunch.
8. A 200-character CJK file name (~600 bytes UTF-8) downloads and saves (Darwin name limits are byte-based in places).
9. C2/I6: `log stream --level debug --predicate 'subsystem == "org.haiyo.app"'` during a failing share in Release (no
   file names after the fix) and during navigation in Debug (no `/chat/<uuid>` after the fix).
10. Airplane mode at launch → 无法连接网络 → 重试 after re-enabling; mid-session airplane mode → no offline screen; a full
    own-origin navigation while offline → screen over the old page.
11. I3: make `/` return 502 (stop the acceptance service briefly or point Debug at a host that does) → what is shown.
12. Cold start from a notification: `xcrun simctl push booted org.haiyo.app payload.apns` with
    `{"aps":{"alert":{"title":"Haiyo","body":"你有新消息"}},"c":"<uuid>"}` with the app not running → lands on
    `/chat/<uuid>`; count the loads.
13. Universal links on device (TestFlight, after S1's AASA): cold start and while running; a link to another path on
    the same host with a query.
14. `codesign -d --entitlements :- Haiyo.app` on the uploaded build: `aps-environment` = `production`, associated domain
    = `applinks:test.haiyo.org`. Then `push.register` from Web Inspector on the TestFlight build → token, `env: "production"`.
15. `badge.set { n: 3 }` without notification permission → icon unchanged, reply still `ok` (M5).
16. Session: sign in, force-quit, relaunch; install a newer TestFlight build over it → still signed in; cookie
    `Max-Age`/expiry in Web Inspector (plan §1.2).
17. Edge-swipe back on the program-driven `pushState` entries (plan §1.4 list).
18. Long-press a message link: what the preview loads (own origin and external), and that "打开链接" goes through the
    policy (external → Safari view).
19. Long-press an image → 存储到“照片” → the add-only prompt, no crash; file input → 拍照或录像 → camera and microphone
    prompts, no crash.
20. Full-screen video in the portrait-only app: does it rotate; is that acceptable.
21. VoiceOver on the offline screen (focus lands on the title, 重试 reachable); AX5 text size (M10).
22. I5: open an own-origin chat link from a message → the sheet shows a second app; Home with the sheet open → does the
    service still see a socket for the session.
23. iPad in iPhone compatibility mode (App Review does this): launch, share sheet, sheet, Safari view.
24. `navigator.userAgent` ends with `Mobile/15E148 HaiyoApp/0.1.0`; `window.webkit.messageHandlers.haiyo` is undefined in
    the sheet.
25. Archive check before any submission: `plutil -extract HaiyoHost raw <archive>/Products/Applications/Haiyo.app/Info.plist`.
