# Haiyo for iOS (the shell)

A thin native shell: one full-screen `WKWebView` on the live https site, plus what the web cannot do on its own —
push (APNs), the icon badge, downloads to the share sheet, a cannot-connect screen, universal links and the permission
strings. Swift and Apple frameworks only; no packages. iPhone only, portrait, iOS 26 and later.

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
  may use the bridge; sub-frames, other origins and a main frame that navigated away get `forbidden` and cause
  nothing. `BridgeInWebViewTests` checks this with real WebKit frames (pages loaded from strings, no network).
- `NavigationPolicyTests` — the table of which URL goes where (below).
- `BridgeMessageTests` — validation of every message and the event scripts.
- `ShellConfigTests`, `LinksAndFailuresTests` — the build configuration's host, Info.plist keys, paths, universal
  links, notification payloads, load failures, download file names.

## Configurations: which site

The site is set by the build configuration and nowhere else: the build setting `HAIYO_HOST` becomes the Info.plist key
`HaiyoHost`; `ShellConfig` reads it; the origin is always `https://<host>`.

| Configuration | `HAIYO_HOST` | APNs | Used for |
|---|---|---|---|
| Debug | `test.haiyo.org` | development | Xcode runs, unit tests |
| Release | `test.haiyo.org` | production | TestFlight builds of the acceptance site |
| Store | *(empty)* | production | the App Store build; set the production host first — until then the "Check origin" build phase stops the build |

## Navigation

| URL | Asked for | Goes to |
|---|---|---|
| the shell's own origin | main frame | loads in place |
| the shell's own origin | new window (`target=_blank`, `window.open`) | a sheet with its own web view, same cookies, no bridge |
| another `http(s)` site | anything | the in-app Safari view (`SFSafariViewController`) |
| `<a download>`, attachments | — | `WKDownload` to a temporary folder, then the share sheet; the folder is removed when the sheet closes (and at launch) |
| `mailto:`, `tel:`, `sms:` | — | the system |
| anything else (`javascript:`, `file:`, other schemes) | — | refused |

A failed first load shows the cannot-connect screen (无法连接网络 / 无法连接到 Haiyo, 重试). Once the page is up, a
dropped network is the page's own business (it reconnects and says so).

## Bridge (version 1; later versions only add)

The page calls `window.webkit.messageHandlers.haiyo.postMessage({ name, args })`, which returns a promise:

| `name` | `args` | Reply |
|---|---|---|
| `hello` | `{ events?: ["pause", "resume", "open"] }` — the events the page handles | `{ bridge: 1, shell, build, os, events }` |
| `push.register` | — | asks for notification permission if needed, then `{ token, env }`, `{ denied: true }` or `{ error }` |
| `badge.set` | `{ n }`, a whole number 0–99999 | `{ ok: true }` |

Refused messages reject with `forbidden` (not the shell's own origin, or not the main frame), `malformed` or `unknown`.

Events the shell dispatches on `window` (only to its own origin's page):

- `haiyo:pause` — the app went to the background (`sceneDidEnterBackground`).
- `haiyo:resume` — the app is coming back (`sceneWillEnterForeground`).
- `haiyo:open`, `detail: { path }` — a tapped notification or a universal link. If the page did not list `open` in
  `hello`, the shell loads the URL itself instead.

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

Until then the shell works without them: no events are handled, `open` falls back to loading the URL, and nothing asks
for notification permission.

## Debug-only launch options

Debug builds only (compiled out of Release and Store):

- `-HaiyoDebugUnreachableOnce` — the first load goes through a closed local port, so the cannot-connect screen and
  重试 can be checked in the Simulator (which has no airplane mode); 重试 removes it.
- `-HaiyoDebugProbeLinks` — two links to other sites on top of the page (new window, same window), to check that
  other hosts open in the in-app Safari view without posting anything.
- The web view is inspectable from Safari's Develop menu; the path (never the query or page content) and whether
  WebKit can go back are logged under the `org.haiyo.app` subsystem.

Example: `xcrun simctl launch booted org.haiyo.app -HaiyoDebugUnreachableOnce`.

## Signing and upload

Automatic signing with the owner's team; the team id is not in the project. Archive the Release configuration with
`DEVELOPMENT_TEAM=<team id>` and `-allowProvisioningUpdates` (Xcode registers `org.haiyo.app` with Push Notifications
and Associated Domains from `Support/Haiyo.entitlements`), then upload from the Organizer or with
`xcodebuild -exportArchive` (`method app-store-connect`, `destination upload`).

## Files

- `Haiyo/` — the app (a synchronized folder: every file in it is part of the target).
- `HaiyoTests/` — unit tests.
- `Support/Info.plist`, `Support/Haiyo.entitlements` — read through build settings, not copied into the bundle.
- `Haiyo/PrivacyInfo.xcprivacy` — no tracking; collected data types as in the App Privacy answers; no required-reason
  APIs (the shell stores nothing natively).
- `Haiyo/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png` — a plain placeholder until the owner picks the icon.
