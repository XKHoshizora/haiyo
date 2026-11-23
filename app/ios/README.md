# Haiyo for iOS (the shell)

A thin native shell: one full-screen `WKWebView` on the live https site, plus what the web cannot do on its own —
push (APNs), the icon badge, downloads to the share sheet, a cannot-connect screen, universal links, the permission
strings, and the window's shape the page cannot see (the iPhone Duo's fold, the iPad window controls). Swift and Apple
frameworks only; no packages. iPhone (portrait) and iPad (every orientation, resizable windows); iOS 26 and later, the
fold from iOS 27.1.

Design and the reasons behind it: `docs/design/2026-11-24-store-app-draft.md` (sections 1 and 2).

## Build and test

Xcode 27.2 (any Xcode with the iOS 26.2 SDK or later). Simulator builds need no Apple account.

```bash
cd app/ios
xcodebuild test -project Haiyo.xcodeproj -scheme Haiyo \
  -destination 'platform=iOS Simulator,name=iPhone 18 Pro' \
  -derivedDataPath ~/Desktop/Haiyo/cache/ios-derived
```

The unit tests run inside the Debug app (which does not load the site while tests run):

- `OriginGateTests`, `BridgeHandlingTests`, `BridgeInWebViewTests` — only the main frame of the shell's own origin
  may use the bridge; sub-frames, other origins, look-alike hosts (trailing dot, another port) and a main frame that
  navigated away get `forbidden` and cause nothing. An answer that comes after the page changed (a new document, or
  the origin left) is refused when it is delivered. `BridgeInWebViewTests` checks this with real WebKit frames
  (pages loaded from strings, no network).
- `NavigationPolicyTests`, `ResponsePolicyTests` — which URL goes where, and which responses are shown, downloaded
  or replaced by the cannot-connect screen (below).
- `BridgeMessageTests` — validation of every message and the event scripts.
- `ShellLogTests` — the logging rule (below).
- `LifecycleRulesTests` — when a downloaded file is removed (`ShareCleanup`); the bound on reloads after a
  content-process crash.
- `PageLayoutTests` — the fold and the corners as the page receives them, and when the window controls keep a page
  down; the samples are what UIKit reported on the iPhone Duo and iPad simulators.
- `ShellConfigTests`, `LinksAndFailuresTests` — the build configuration's host and channel, Info.plist keys, paths,
  universal links, notification payloads, load failures, download file names.

## Configurations: which site

The site is set by the build configuration and nowhere else: `HAIYO_HOST` is one line in `Config/Acceptance.xcconfig`
or `Config/Store.xcconfig`; it becomes the Info.plist key `HaiyoHost` and the associated domain; `ShellConfig` reads it;
the origin is always `https://<host>`. The version and the build number are one line each in `Config/Shared.xcconfig`
(raise `CURRENT_PROJECT_VERSION` for every upload).

| Configuration | Settings file | `HAIYO_CHANNEL` | APNs | Used for |
|---|---|---|---|---|
| Debug | `Acceptance.xcconfig` (`test.haiyo.org`) | acceptance | development | Xcode runs, unit tests |
| Acceptance | `Acceptance.xcconfig` (`test.haiyo.org`) | acceptance | production | internal TestFlight builds of the acceptance site |
| Store | `Store.xcconfig` (host empty) | store | production | the App Store build; the scheme's Archive builds this one |

The "Check origin" build phase checks the host with the same pattern as `ShellConfig.hostPattern` (keep them
identical) and prints the host it builds for.

**An acceptance build can never become the App Store build:**
1. The scheme's Archive uses Store, which does not build until the production host is set.
2. Archiving Acceptance fails unless `HAIYO_ACCEPTANCE_UPLOAD=1` is given on purpose.
3. Acceptance archives are uploaded with `ExportOptions-acceptance.plist` (`testFlightInternalTestingOnly`): App Store
   Connect will not let such a build go to external testers or into an App Store version.
4. Before any submission: `plutil -extract HaiyoHost raw <archive>/Products/Applications/Haiyo.app/Info.plist` must
   print the production host, and `HaiyoChannel` must be `store`.

## Navigation

| URL | Asked for | Goes to |
|---|---|---|
| the shell's own origin | main frame | loads in place |
| a file of the site (`/api/…`: attachment, original image) | new window, or a tapped link in the main frame | a sheet with its own web view, same cookies, no bridge |
| a page of the app (`/chat/…`, an invite) | new window (`target=_blank`, `window.open`); in the sheet, anything (a link in an attachment, a redirect to the sign-in page) | the main view (`haiyo:open`, or a load) — never a second copy of the app in the sheet; in a frame of the sheet, refused |
| another `http(s)` site | anything | the in-app Safari view (`SFSafariViewController`) |
| `<a download>`, `Content-Disposition: attachment`, types WebKit cannot show | — | `WKDownload` to a temporary folder, then the share sheet (on iPad a popover in the middle of the view, no arrow); the folder is removed once the sheet is gone for good and no activity still uses the file — whichever comes last, no timer — and at launch |
| `mailto:`, `tel:`, `sms:` | a link activation (not a load, redirect or form) | the system |
| anything else (`javascript:`, `file:`, other schemes) | — | refused |

What the `mailto:`/`tel:`/`sms:` rule rests on: WebKit reports a script's `element.click()` as a link activation too
(measured: both `linkActivated`; a tap carries `buttonNumber` 1, a script click 0). iOS has no public user-gesture flag
for navigations, and gating on `buttonNumber` would very likely also refuse VoiceOver and keyboard activation (not
measurable in the Simulator), so the shell does not. What holds instead: only the site's own scripts run (CSP
`script-src 'self'`); `tel:` asks before calling, `mailto:`/`sms:` open a draft the person sends; loads, redirects and
forms never reach the system.

A long-pressed link gets WebKit's menu without its preview (the preview loads the link in a separate web view without
the session, and committing it opens Safari past the rules above); 打开 is then a click on the link and follows the
table like a tap. The page's own long-press menus (an image's 保存图片) are the page's.

A failed load of the app's page — no network, an unreachable server, or a server error (5xx) on the main document —
shows the cannot-connect screen (无法连接网络 / 无法连接到 Haiyo, 重试); it retries by itself when the network comes
back. The cover over the page lifts at the latest 3 s after the first commit; if nothing commits within 15 s the
cannot-connect screen takes over. Once the page is up, a dropped network is the page's own business (it reconnects and
says so).

If iOS kills the page's content process, the shell reloads it only in the foreground (at the next return to the app if
it happened in the background), at most twice a minute; after that the cannot-connect screen.

## Bridge (version 1; later versions only add)

The page calls `window.webkit.messageHandlers.haiyo.postMessage({ name, args })`, which returns a promise:

| `name` | `args` | Reply |
|---|---|---|
| `hello` | `{ events?: ["pause", "resume", "open", "layout"] }` — the events the page handles | `{ bridge: 1, shell, build, os, push, events, layout }`; `push` is `granted`, `denied` or `notDetermined` (re-register silently when `granted`); `layout` as in `haiyo:layout` below, current at the reply |
| `push.register` | — | asks for notification permission if needed, then `{ token, env }`, `{ denied: true }` or `{ error }` (`timeout` after 30 s, `busy` with 4 waiting) |
| `badge.set` | `{ n }`, a whole number 0–99999 | `{ ok }`: `false` when the system refused (no badge permission yet) |

Refused messages reject with `forbidden` (not the shell's own origin, or not the main frame), `malformed` or `unknown`.
Every answer is checked again when it is delivered: if the main frame committed another document (or left the
origin) meanwhile, the answer is `forbidden` instead.

Events the shell dispatches on `window` (only to its own origin's page):

- `haiyo:pause` — the app went to the background (`sceneDidEnterBackground`).
- `haiyo:resume` — the app is coming back (`sceneWillEnterForeground`).
- `haiyo:open`, `detail: { path }` — a tapped notification, a universal link, or an app link opened from a message.
  If the page did not list `open` in `hello`, or the event cannot be delivered, the shell loads the URL itself.
- `haiyo:layout`, `detail: { fold, corner }` — only to a page that listed `layout`, when the value changes (after the
  geometry has held still for 0.15 s). CSS px of the layout viewport:
  - `fold`: `null`, or `{ axis: "vertical" | "horizontal", x, y, width, height }` — the iPhone Duo's fold while it is
    partly open, as a band to keep content out of (40 px wide on the simulator: 20 either side of the crease); `null`
    closed and fully open. `vertical` is book-style (left and right halves), `horizontal` laptop-style.
  - `corner`: `{ top, leading, trailing }` — room the corners need beyond `env(safe-area-inset-*)`: the iPad window
    controls in a window (measured 43 top / 66 leading), the rounded corners otherwise (Duo 16–18, iPad 10). Add it to
    whatever sits in a corner. `env()` itself is the plain safe area (measured equal on the Duo and on iPad).

  A page that has not listed `layout` gets no events; on iPad, while the window controls cover its top-leading corner,
  the shell keeps it below them (`obscuredContentInsets.top`, 53 pt in a window) and gives the room back as soon as the
  page lists `layout`.

Events are hints, not a guarantee: they are fire-and-forget, a page reloaded in the background never hears `pause`,
and the shell checks the page's origin inside the script. **A page that loads while `document.visibilityState` is
`"hidden"` must not open its socket**; it connects on `visibilitychange` / `resume`. A page restored from the
back/forward cache re-sends `hello` on `pageshow`.

The shell appends `HaiyoApp/<version>` to WebKit's own user-agent application name (`Mobile/15E148 HaiyoApp/0.1.0`).
It marks the shell; it is not an authorization.

## What the web side still has to do (not in this branch)

Requests for the web lanes (`docs/design/2026-11-24-store-app-draft.md`, S5, S6 and S9):

1. `app/web/src/shell.js` — detect the shell (`window.webkit?.messageHandlers?.haiyo` plus the UA mark), call `hello`
   with the events the page handles; `null` in a browser so every caller is a no-op.
2. Push — after sign-in in the shell, `push.register`, then `POST /api/push/devices` (S5); on sign-out
   `DELETE /api/push/devices/current` and `badge.set { n: 0 }`.
3. `data/sync.js` — on `haiyo:pause` close the socket without reconnecting; on `haiyo:resume` connect at once and
   repair the gap; add a connect timeout (an iOS 26 WebSocket can hang in CONNECTING after resume).
4. `haiyo:open` — hand the path to the address-as-truth navigation (`state/location.js`) instead of a reload.
5. Badge — `badge.set` whenever `unreadTotal` changes.
6. Layout — list `layout` in `hello`, start from `hello`'s `layout`, follow `haiyo:layout`: keep content out of `fold`
   (two panes, one each side), and add `corner` to the top-leading controls (audit 2.7.8: `data-fold`, `--fold-*`).

Until then the shell works without them: no events are handled, `open` falls back to loading the URL, and nothing asks
for notification permission.

## Logging

`ShellLog` is the only logger, and its rule is tested (`ShellLogTests`): nothing private reaches the log at any level —
no file names, no paths or URLs with ids, no query strings, no message text, no error descriptions (only
`domain/code`), no names of other apps. Routes are logged as shapes (`/chat/:id`).

## Still to do before the App Store

- `age.range` (Declared Age Range API, plan §1.6 / §2) is not built: a store blocker, not needed for internal
  TestFlight.
- iPad: App Store Connect then requires 13-inch iPad screenshots, and once a version with iPad is on the App Store,
  later versions cannot drop it (`docs/design/2026-11-24-ios-shell-ipad-duo-plan.md`). Ship iPad with or after the
  web's size-class layout and its handling of `layout`.
- App-Bound Domains (`WKAppBoundDomains` = the host, `limitsNavigationsToAppBoundDomains`): not enabled in v0. It
  would make the bridge's origin rule OS-enforced; it also changes how the WebKit tests load other origins, so it gets
  its own measured change.
- APNs environment: `HaiyoApnsEnvironment` comes from the build configuration, not the signing profile; a
  configuration run from Xcode with a development profile reports `production`. The service (S5) should treat
  `BadDeviceToken` from one environment as "try the other once".

## Debug-only launch options

Debug builds only (compiled out of Acceptance and Store):

- `-HaiyoDebugUnreachableOnce` — the first load goes through a closed local port, so the cannot-connect screen and
  重试 can be checked in the Simulator (which has no airplane mode); 重试 removes it.
- `-HaiyoDebugProbe` — three links on top of the page (another site in a new window and in place, the app's own page
  in a new window); a recorder for `haiyo:` events (logged on return to the foreground); `hello` and `badge.set`
  posted by the page itself; the user-agent mark checked.
- `-HaiyoDebugC1` — the page asks `push.register` and the shell reloads it before the answer comes: the log must show
  `bridge-reply delivered=no forbidden=yes`.
- `-HaiyoDebugLayout` — logs the window's geometry whenever it changes (`debug-layout-*`: the plain and corner-adapted
  safe areas, fold and occlusion regions, what the page sees as `env()`, its viewport and pointer media queries); with
  `-HaiyoDebugProbe` the probe page lists `layout` and every `haiyo:layout` it receives is logged (`debug-layout-event`).
  The probe also logs what WebKit reports for a tapped and a script-clicked `mailto:` (`debug-system-link`).
- `-HaiyoDebugShare` — once the first page is shown, the share sheet with a small text file, as after a download (the
  popover and the file's removal can be checked without signing in).
- The web view is inspectable from Safari's Develop menu; the route shape (`/chat/:id`) and whether WebKit can go
  back are logged through `ShellLog`.

Example: `xcrun simctl launch booted org.haiyo.app -HaiyoDebugUnreachableOnce`.

## Signing and upload

Automatic signing with the owner's team (`Config/Shared.xcconfig`). Internal TestFlight build of the acceptance site
(raise `CURRENT_PROJECT_VERSION` first):

```bash
cd app/ios
xcodebuild archive -project Haiyo.xcodeproj -scheme Haiyo -configuration Acceptance \
  -destination 'generic/platform=iOS' -archivePath ~/Desktop/Haiyo/cache/ios-archives/Haiyo.xcarchive \
  -allowProvisioningUpdates HAIYO_ACCEPTANCE_UPLOAD=1
xcodebuild -exportArchive -archivePath ~/Desktop/Haiyo/cache/ios-archives/Haiyo.xcarchive \
  -exportOptionsPlist ExportOptions-acceptance.plist -exportPath ~/Desktop/Haiyo/cache/ios-archives/export \
  -allowProvisioningUpdates
```

Xcode registers `org.haiyo.app` with Push Notifications and Associated Domains from `Support/Haiyo.entitlements`.
The App Store build is an Archive of the scheme (Store) once the production host is set; check it as in
"Configurations" above before submitting.

## Files

- `Haiyo/` — the app (a synchronized folder: every file in it is part of the target).
- `HaiyoTests/` — unit tests.
- `Support/Info.plist`, `Support/Haiyo.entitlements` — read through build settings, not copied into the bundle.
- `Haiyo/PrivacyInfo.xcprivacy` — no tracking; collected data types as in the App Privacy answers; no required-reason
  APIs (the shell stores nothing natively).
- `Haiyo/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` — a plain placeholder until the owner picks the icon.
