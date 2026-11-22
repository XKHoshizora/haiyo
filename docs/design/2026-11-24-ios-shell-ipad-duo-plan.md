# iOS shell on iPad and iPhone Duo — plan

2026-11-24 · `app/ios` on `lane/mac-app-shell` · plan only: nothing here is built until the owner says go.

Input: `docs/reviews/2026-11-24-web-quality-and-device-audit.md` Part 2 (on `lane/integ-ui2`), whose Duo facts come from
the simulator measurements of this shell (iOS 27.2: outer 466×678 pt, inner 951×669 pt, no reloads across postures).

## Summary

1. Make the app universal (iPhone + iPad), all four orientations on iPad, resizable windows; iPhone stays portrait until
   the web has its compact-height layout. Ship it with or after the web's size-class rule.
2. Native surfaces: the cannot-connect screen moves to the corner-adapted safe area; the share sheet gets a real
   popover anchor on iPad; the rest are system views that already adapt.
3. The fold: UIKit's `reservedRegions(kind: .division)` (iOS 27.1) gives it in view points; the shell reports it to the
   page as `fold` in a new `haiyo:layout` event (and in `hello`), in CSS px of the web view, `null` when there is none.
4. iPad window controls: not part of the plain safe area; UIKit's corner-adapted layout region measures them. The shell
   sends the extra corner inset in the same event; until the page handles it, the shell keeps the page below them.
5. Keyboard and pointer: pass everything through; the web has no ⌘F or ⌘N today, so the shell adds no commands yet;
   hover already works in WKWebView. Measure what the pointer media queries report on iPad.

## 1. Device families, orientations, window sizes

| Setting | Today | Change |
|---|---|---|
| `TARGETED_DEVICE_FAMILY` | `1` per target (`project.pbxproj:324, 352, 380`, tests too) | `1,2`, once, in `Config/Shared.xcconfig` (tests inherit) |
| `UISupportedInterfaceOrientations~ipad` | absent (iPad falls back to portrait only) | all four |
| `UISupportedInterfaceOrientations` (iPhone) | portrait | unchanged for now (audit 2.8.4; the Duo's inner display ignores the lock anyway — measured) |
| `UIRequiresFullScreen` | absent | stays absent (deprecated; iOS 27 resizes regardless — Apple TN3192) |
| `UIApplicationSupportsMultipleScenes` | false | stays false for the first iPad release |
| `LSRequiresIPhoneOS` | true | stays (it means "an iOS app", not "iPhone only") |
| `UILaunchScreen` (a colour) | present | stays: a plain colour fits every size (TN3208) |
| Minimum window | none | `windowScene.sizeRestrictions?.minimumSize` = 320 × 480 pt, the page's own floor (`body { min-width: 320px }`); Apple asks for a minimum with `UISceneSizeRestrictions` (Multitasking on iPad, Mac, and Apple Vision Pro) |
| Web view | pinned to all edges, `contentInsetAdjustmentBehavior = .never` (`ShellViewController.swift:69, 82-88`) | unchanged: the page already honours asymmetric insets (measured on the Duo) and WebKit relayouts on resize without a reload (measured) |

Why with the web's size-class rule: without it iPad portrait (744–834 pt) shows one pane at a time (audit 2.3, 2.6).
Internal TestFlight can carry the universal build earlier for testing.

**For the owner — App Store Connect (nothing is changed in his account by this plan):**
- iPad screenshots become required: the 13-inch display, 2064×2752 or 2048×2732 px (portrait) or the landscape
  equivalents, 1 to 10 of them — "Required if app runs on iPad" (App Store Connect Help, Screenshot specifications).
- Adding iPad is one-way once a version with it is on the App Store: a later upload without iPad is rejected with
  "This bundle does not support one or more of the devices supported by the previous app version" (error 409; Apple
  Developer Forums thread 852260, Oct 2026). Internal TestFlight builds are not that previous version.
- App Review then tests the real iPad app (full screen and windowed) instead of the iPhone app in compatibility mode.
- Nothing else changes: app record, privacy answers, age rating, price, the internal group.

## 2. Native surfaces and safe areas

| Surface | Today | Plan |
|---|---|---|
| Web view, cover | full bleed; the page insets itself | unchanged |
| Cannot-connect screen (`OfflineView.swift:57-60`) | top/bottom on the safe area, leading/trailing on the view edges — reaches the Duo's status column (measured) | pin all four edges of the scroll view to `layoutGuide(for: .safeArea(cornerAdaptation: .horizontal))`: the safe area plus the corners (iPad window controls, the Duo's corners) |
| Share sheet (`Downloads.swift:69-70`) | `sourceView` set, no `sourceRect`: on iPad the popover points at the view's origin — the top-leading corner, under the window controls. Not a crash (that needs no anchor at all) | anchor at the centre of the view with `permittedArrowDirections = []` (we do not know where the link was), and re-anchor on size change |
| File sheet (`SheetViewController`, `.pageSheet`) | its web view uses automatic insets | unchanged: UIKit sheets adapt to the fold and present their bars vertically on the outer display (Preparing your app for iPhone Duo) — check the 完成 button there |
| In-app Safari view, alert, link menu, file-input pickers | system views | unchanged; check each in the test matrix |

## 3. The fold

What UIKit gives (iOS 27.1, `UIKit.framework/Headers/UIViewReservedRegion.h`, `UIView.h:762-769`; Apple
documentation "UIView.ReservedRegion" and "reservedRegions(kind:options:)"):

- `view.reservedRegions(kind: .division)` returns the regions that split the view — the Duo's fold — as `frame` (view
  coordinates, points, margins already included), `margins`, `isActive`. Only active ones by default; a division is
  active only while the device is partly open ("When iPhone Duo is fully open, the division is inactive").
- Direction: compare the frame's width and height (book fold = vertical, laptop fold = horizontal).
- Change tracking: "UIKit tracks the regions you read in `updateConstraints()` and runs it again when the regions
  change." There is no notification.
- `.occlusion` regions are the cameras; the outer camera is inside the safe area's status column already, the inner one
  is active only while in use — not reported in v1.
- WebKit gives the page nothing: the Viewport Segments and Device Posture APIs are behind flags in Safari 27.1 and
  cannot be enabled in WKWebView; CSS safe-area insets do not include the fold; Apple recommends the host pass the
  geometry (audit 2.1: webkit.org Safari 27.1 post, Apple forum thread 848036).

Observer: a hidden `LayoutObserverView` pinned to the web view's frame (so its coordinates are the web view's), whose
`updateConstraints()` reads `reservedRegions(kind: .division)` under `#available(iOS 27.1, *)` (the deployment target is
26.0), and whose `layoutSubviews()` calls `setNeedsUpdateConstraints()` when its size changes. Results are compared with
the last one sent and coalesced to one send per run loop turn (the hinge animates).

Units: CSS px of the web view's layout viewport, origin at its top-left. With `viewport-fit=cover`,
`width=device-width`, `pageZoom` 1 and no obscured insets, 1 CSS px = 1 pt; the conversion divides by
`webView.pageZoom` anyway and subtracts `obscuredContentInsets` (see 4) so it stays right if either changes.

**Event** (bridge version stays 1 — additive):

```
haiyo:layout   detail: {
  fold:   null | { axis: "vertical" | "horizontal", x, y, width, height },   // CSS px, integers covering the region
  corner: { top, leading, trailing }                                         // CSS px, see 4; zeros when nothing intrudes
}
```

- Sent only when the value changes, and only when the page listed `"layout"` in `hello`. A page on a device without a
  fold that is never windowed never receives it.
- `hello`'s reply gains `layout` with the current value, so a page that loads or reloads while folded starts right
  (events alone would be missed).
- `fold` becomes `null` (one event) when the device opens fully or closes.
- Origin gate: as for every event, `send(_:)` (`ShellViewController.swift:250`) evaluates in the main frame only after
  checking `webView.url` is the shell's origin, and the script itself compares `location.origin` before dispatching;
  `hello` goes through the bridge's origin and page-generation check. The sheet and the Safari view never receive it.
- Not sensitive: it says "foldable device, folded" and where; no identifiers.
- Web side (not in this plan): audit 2.7.8 — `data-fold`, `--fold-start`, `--fold-gap`.

Tests: the geometry → detail conversion is a pure function (rect, bounds, zoom, insets → detail) with unit tests;
the event script joins `BridgeMessageTests`; on the Duo simulator, `-HaiyoDebugProbe` records `haiyo:layout` while the
hinge goes closed → half-open → open → half-open laptop-style.

## 4. iPadOS window controls

- iPadOS 26 gives windowed scenes a window control at the top-leading corner; system bars arrange around it, and custom
  UI should "use a layout guide that accounts for the window control" — `layoutGuide(for: .margins(cornerAdaptation:
  .horizontal))` (WWDC25 session 282 "Make your UIKit app more flexible", 12:21–13:04; HIG Windows).
- The plain safe area does not describe corners: `safeAreaInsets` and `safeAreaLayoutGuide` "come from safeAreaInsets
  unchanged" — ask for `.safeArea(cornerAdaptation: .horizontal)` (iOS 26; `UIViewLayoutRegion.h`; Apple's
  app-resizability guidance, corner intrusions). A Flutter report on the open Duo shows a top inset of 0 with the corner
  still in the way (flutter/flutter#170461). So CSS `env(safe-area-inset-*)`, which WebKit takes from the web view's safe
  area, very probably does not include the window controls — the first measurement of the build confirms it.
- Plan: `corner` in the event above = `directionalEdgeInsets(for: .safeArea(cornerAdaptation: .horizontal))` minus
  `directionalEdgeInsets(for: .safeArea())`, per edge — the extra room the corners need (leading/trailing), and the same
  with `.vertical` for `top`. The page adds them to its top-leading padding (the chat header's back button, the rail's
  first item). Yes, the page should receive it as an inset: only the page knows which of its controls sit in the corner.
- Until the page lists `"layout"`: when the vertical corner extra is non-zero, the shell sets
  `webView.obscuredContentInsets.top` to it (iOS 26: "Edge insets … which shrink the bounds of the layout viewport",
  `WKWebView.h:718-731`) so the page starts below the controls; it clears it once the page handles the event.

## 5. Keyboard and pointer on iPad

- Keys reach the page as ordinary key events; the shell intercepts nothing. `isFindInteractionEnabled` stays off (⌘F
  would open the system find bar instead of the app's search).
- The web has no ⌘F or ⌘N today (`git grep metaKey/ctrlKey` in `app/web/src` on `lane/integ-ui2`: only guards that
  skip modified keys), so the shell provides no key commands now. When the web adds them, the shell can add
  `UIKeyCommand`s — listed in the iPadOS menu bar and the ⌘-hold overlay — that send `haiyo:command { name }` for names
  the page lists in `hello` (`search`, `new-chat`). ⌘W is the system's (one scene).
- Pointer: WKWebView already gives the page hover and mouse events from a trackpad or mouse; native buttons (重试) get
  the pointer effect from `UIButton.Configuration`. To measure in the iPad simulator with pointer input: what
  `pointer`, `hover`, `any-pointer` and `any-hover` report — feeds the web's 2.5 changes.

## Build order (after the owner's go)

0. Measure, no commit: a universal build by command-line override on the iPad simulator — `env(safe-area-inset-*)` vs
   the corner-adapted insets, windowed and full screen; the division frame on the Duo half-open; pointer media queries.
1. Families, orientations, minimum size, cannot-connect screen, share popover, README. Tests first where code is pure.
2. `haiyo:layout` (fold + corner) and `hello.layout`, with unit tests and the probe; the `obscuredContentInsets` fallback.
3. Simulator matrix (audit 2.8.8): Duo closed / open / half-open book and laptop / rotated; iPad mini and 13" both
   orientations, windowed halves, thirds, quarters, Slide Over; then an internal TestFlight build with the owner's yes.

## Sources (read 2026-11-23)

- iOS 27.2 SDK headers: `UIKit/UIViewReservedRegion.h`, `UIKit/UIView.h` (ReservedRegion, LayoutRegions),
  `UIKit/UIViewLayoutRegion.h`, `WebKit/WKWebView.h`; `UIKit.swiftinterface` for the Swift names.
- Apple: UIView.ReservedRegion — https://developer.apple.com/documentation/uikit/uiview/reservedregion ;
  reservedRegions(kind:options:) — https://developer.apple.com/documentation/uikit/uiview/reservedregions(kind:options:) ;
  Preparing your app for iPhone Duo — https://developer.apple.com/documentation/technologyoverviews/preparing-your-app-for-iphone-duo ;
  Multitasking on iPad, Mac, and Apple Vision Pro — https://developer.apple.com/documentation/uikit/multitasking-on-ipad-mac-and-apple-vision-pro ;
  WWDC25 282 Make your UIKit app more flexible — https://developer.apple.com/videos/play/wwdc2025/282/ ;
  Screenshot specifications — https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications ;
  Developer Forums 852260 (removing iPad support, error 409) — https://developer.apple.com/forums/thread/852260
- flutter/flutter#170461 (window controls and the Duo's corner) — https://github.com/flutter/flutter/issues/170461
- The audit's sources for WebKit and the forum answer on WKWebView (848036).
