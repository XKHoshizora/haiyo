# Review round 3: iPad and iPhone Duo (`origin/lane/mac-app-shell` 77047cb, 9b7d133, bad4505)

Scope: the round's diff (`ios-shell-r3.diff`), read against full files on the branch, the plan
`docs/design/2026-11-24-ios-shell-ipad-duo-plan.md` (with its "As built" section), the rules of rounds 1 and 2
(`docs/reviews/2026-11-24-ios-shell-review.md`, `ios-shell-review.md`), and the service's attachment and web-client
routes where the sheet rule depends on them. Read only; nothing was built (Windows). Line numbers are on the branch.
Tests: 52 test functions (42 before; +6 `PageLayoutTests`, +1 each in `BridgeTests`, `NavigationPolicyTests`,
`ShellConfigTests`, `ShellLogTests`).

**Verdict: CHANGES REQUIRED.** Critical 0, Important 2, Minor 11. The security boundary holds (table below). The two
Important items are both iPad-only and small to fix: the stopgap for pages that don't handle `layout` never turns on
before iPadOS 27.1, and the iPad web views run in WebKit's desktop content mode, which is not what the shell documents.

## What holds

| Question | Result | Where |
|---|---|---|
| Who may send `hello` (and so switch the fallback off) | Only the main frame of a document on the shell's own origin: `OriginGate` + `host.bridgePage.isOwnOrigin` at arrival; the sheet's web view has no message handler; sub-frames are refused | `Bridge.swift:50`, `SheetViewController.swift:32-36` |
| Who receives `haiyo:layout` | Only the main frame, and only if `webView.url` is own; the script itself compares `location.origin`; only after a `hello` that listed `layout`; the sheet and Safari view never | `ShellViewController.swift:263-272, 305-316`, `BridgeMessage.swift:79-95` |
| A redirect to another origin | The main frame cannot commit one (every main-frame action, redirects included, goes through the policy → Safari view) | `NavigationPolicy.swift:57-64` |
| Validation | No new inbound message; `hello.events` is still ≤ 16 strings intersected with `knownEvents`; layout detail is outbound, integers and `null`, serialised by `JSONSerialization` | `BridgeMessage.swift:37-40` |
| Old web builds | Unchanged: a page that does not list `layout` gets the same `events` echo; the reply gains one key (`layout`). The only behaviour change is the intended fallback inset in iPad windows | `ShellViewController.swift:324-341` |
| `#available` | Every use of `reservedRegions` / `UIView.ReservedRegion` is inside `#available(iOS 27.1, *)`; `LayoutSample` stores plain `CGRect`s; on 26.x/27.0 fold is `nil`, no crash | `PageLayout.swift:144-147`, `DebugProbe.swift` (`reportLayoutIfChanged`) |
| `updateConstraints()` loop | None: it only reads and calls back, then `super` last; `setNeedsUpdateConstraints` comes only from a size change in `layoutSubviews` and from `safeAreaInsetsDidChange`; setting `obscuredContentInsets` on the sibling web view does not touch the observer. The web view exists before the observer is added | `PageLayout.swift:117-134`, `ShellViewController.swift:87-98` |
| Settle | One `DispatchWorkItem`, cancelled and replaced on every sample, `[weak self]`; applies the latest sample, so the last state wins; no event during a continuous drag | `ShellViewController.swift:295-301` |
| Units and coordinates | The observer is pinned exactly like the web view, so its coordinates are the web view's; `(pt − obscured) / pageZoom`, with the obscured inset subtracted once (only in `LayoutGeometry.layout`); fold `null` when inactive (default options = active only) | `PageLayout.swift:58-77, 136-149` |
| Share file | Fresh UUID folder per download; removed on every normal path; launch sweep for the rest; nothing but `completed` + error domain/code logged | `Downloads.swift:23-31, 50-77, 113-139`, `AppDelegate.swift:12` |
| Sheet never shows an app page | Main frame: own, not a file → `openInApp`; sub-frame: own files only; `openInApp` → `open(path:)` → `url(forPath:)` (leading `/`, no `//`, `\`, controls, spaces; own origin) | `NavigationPolicy.swift:57-69`, `ShellConfig.swift:83-89` |
| Universal settings | `TARGETED_DEVICE_FAMILY = 1,2` once (the app target no longer overrides it); `~ipad` orientations all four (needed for multitasking: ITMS-90474); `UIRequiresFullScreen` absent; `UILaunchScreen` colour fits every size; one scene; minimum window 320 × 480 | `Shared.xcconfig:9-11`, `Info.plist`, `SceneDelegate.swift:15` |

## Important

### R3-I1. The stopgap for unaware pages never turns on before iPadOS 27.1, though iPad window controls exist since 26.0
`PageLayout.swift:83-98` (`windowControlsTop`), `:144-147` (`occlusions` only under `#available(iOS 27.1, *)`),
`ShellViewController.swift:305-311`.

The stopgap (`obscuredContentInsets.top`, 53 pt in a window) is meant for pages that do not handle `layout`. As built, it
triggers only when an occlusion region is in the top-leading corner. Occlusion regions come from `reservedRegions`,
which is iOS 27.1+. On iPadOS 26.0–27.0, `occlusions` is always `[]`, so `windowControlsTop` returns 0. The deployment
target is 26.0, and the iPadOS 26 window controls are the very thing this stopgap exists for (plan §4, WWDC25 282).

Scenario: build 3 on internal TestFlight. An iPad on 26.x is put in a window, and today's web build does not list
`layout`. The window controls then sit on the rail's first item and on the chat header's back button. No inset is
applied. Corner-adapted insets do exist on 26.0, and the plan's original rule used them.

The change from the plan to the occlusion test had a measured reason: the Duo's rounded corners also produce a corner
extra. That reason is about the Duo, not about iPads below 27.1.

Fix:
- Gate the stopgap on the iPad idiom. Add `isPad` to `LayoutSample`, from `traitCollection.userInterfaceIdiom`.
- When no regions are available, fall back to the plan's rule: `cornerVertical.top > safe.top`. Measured values: iPad
  full screen 0, window 53.
- Keep the occlusion test where regions exist.

The idiom gate also means no iPhone occlusion can ever push an unaware page down. That covers the Duo's inner camera,
which per the plan is "active only while in use" and whose position is not measured. Add a "no regions" iPad window
sample and a phone-idiom sample to `PageLayoutTests`.

Scope, stated honestly: this matters while pages do not handle `layout`. That is today's web, during internal
TestFlight, and on the App Store too if iPad ships before the web lane's item 6.

### R3-I2. iPad web views use WebKit's desktop content mode, unlike everything the shell documents
`ShellViewController.swift:63-66`, `SheetViewController.swift:32-35`: no `defaultWebpagePreferences.preferredContentMode`,
so WebKit picks `.recommended`.

On iPad, `.recommended` means desktop-class browsing in a regular-width view: a Macintosh user agent instead of the iPad
one. This has been known since iOS 13 for apps built with the iOS 13 SDK or later, on every iPad except the mini (Apple
Developer Forums 122189; "iOS 13以降 iPadのUserAgentに注意 (WKWebView)", Qiita). Consequences:
- README "`Mobile/15E148 HaiyoApp/0.1.0`" (`README.md:134`) and the probe's `navigator.userAgent.endsWith(mark)`
  (`DebugProbe.swift`, `addProbe`) are false on a full-screen iPad. The web lane's detection is documented as "the
  bridge plus the UA mark" (README "Requests for the web lanes" 1), so it will break on iPad if it trusts the mark.
- Desktop-mode viewport rules apply. The plan's measurements cover only the 13-inch (1032 pt, wider than a desktop
  minimum layout width) and a 402-pt window. The portrait iPads the plan cares about (744–834 pt, plan:35) are not
  measured. If WebKit lays the page out at a desktop minimum width and scales it down there, then 1 CSS px ≠ 1 pt. The
  `fold`/`corner` conversion divides only by `pageZoom` and would then be wrong, and the "one pane at a time in
  portrait" premise of plan §1 would not hold.

Fix:
- Set `configuration.defaultWebpagePreferences.preferredContentMode = .mobile` on both web views, so the page gets the
  iPad mobile UA with the mark, and `width=device-width` means the window width on every iPad. The web lane's size-class
  rule is width-based, so nothing is lost.
- Add a README line saying so.
- Extend the probe to log `innerWidth` against the view width.

To verify before fixing (one simulator run): iPad mini and iPad Air 11-inch, portrait, full screen. Check the probe's UA
flag, `innerWidth` (expect 744 / 820), and `visualViewport.scale` (expect 1). If both pass in `.recommended`, record that
in README instead.

## Minor

- **R3-1. `hello` answers with `layout` even when the page did not list it, and those values double the stopgap.**
  `ShellViewController.swift:324-339`. For a page that did not list `layout`, the shell holds the page 53 pt down.
  Yet `layout` is still in the reply, with `corner.top` 43 (the obscured inset is subtracted only from the fold). A
  page that reads `hello.layout` without listing `layout` adds 43 on top of 53. Include `layout` only when
  `events.contains("layout")`. Alternatively, report `corner.top` 0 while the shell holds the page down, and say which
  in README:102.
- **R3-2. R2-6 is now wider: `hello` switches the stopgap off at arrival, not at delivery.** `ShellViewController.swift:325-326`
  (`pageEvents = events; applyLayout(sendingEvent: false)`), `:330` (`sentLayout`). In the cross-process ordering window
  of R2-6, a new page can inherit the old page's `layout`. The new page then loses the inset under the window controls
  until its next commit. Record `pageEvents` and clear the stopgap from `Bridge.deliver`'s success path, for example a
  `bridgeHelloDelivered(events:)` host call. Same narrow window as before, so this stays Minor.
- **R3-3. In the sheet, any own-origin app page goes to the main view, tapped or not.** `NavigationPolicy.swift:62`
  sends own non-file main-frame navigations to `openInApp` (deliberately, for the sign-in redirect).
  - Today this is safe only because the service renders nothing but images inline: `sniff.ts:3` allows PNG/JPEG/WebP/GIF
    inline; everything else is served as `attachment` with `CSP: sandbox; default-src 'none'` (`routes.ts:30-31, 71-79`)
    and becomes a download. So no file in the sheet has links, script or meta refresh, and only the service's own
    redirects reach this rule.
  - If an inline type with links is ever added (PDF is the likely one), a file could drive the main view to any app
    path (an invite page, a GET with effects) without a tap.
  - Write the dependency into README "Navigation". Optionally, send to `openInApp` only `userActivated` navigations and
    redirects of the sheet's first load, and refuse the rest.
- **R3-4. R2-1's second half is still open: `isOwnFile` checks the decoded path.** `ShellConfig.swift:58-60` (`url.path`).
  A new-window link to `https://<host>/%61pi/x` counts as a file and opens in the sheet. The service most likely answers
  a JSON 404, because the `web.ts` wildcard handler decides on the first decoded segment (`=== "api"`). So it is not a
  second app today, but the shell should not depend on that. Use `url.path(percentEncoded: true)` and add the row to
  `NavigationPolicyTests`. One check settles the server side: `curl -sI https://test.haiyo.org/%61pi/x`.
- **R3-5. On the off-main path, the "activity started" mark is deferred, so the folder can go while an activity still
  reads it.** `Downloads.swift:154-163`.
  - When the share sheet asks for the item on a background thread, `itemForActivityType` returns the URL at once, so the
    activity can start reading. `activityStarted()` is only queued to main.
  - On iPad, picking an activity dismisses the popover. If its `viewDidDisappear` (`sheetGone()`) runs before the queued
    mark, `ShareCleanup` sees no activity and removes the folder.
  - Make the mark synchronous: a lock-protected flag or counter on `SharedFile` that `ShareCleanup` reads. Device
    check 35 shows whether it bites.
  - The other direction (`activityStarted` arriving after the final callback) only leaves the folder until the next
    launch, which is fine.
- **R3-6. Geometry edges.** `PageLayout.swift:60-70`.
  - `axis` comes from the band clipped to the bounds. A vertical fold that only partly overlaps the view could come out
    `horizontal`. Take the aspect from the unclipped frame.
  - `Int(CGFloat)` traps on NaN or ±∞. UIKit should never report such values, but one `isFinite` guard on the rects
    and insets turns a crash into "no fold".
- **R3-7. README's toolchain line is now wrong.** `README.md:13`: "any Xcode with the iOS 26.2 SDK or later".
  `UIView.ReservedRegion` and `reservedRegions(kind:)` are not in that SDK, and `#available` does not help at compile
  time. Write "Xcode 27.1 or later (iOS 27.1 SDK)".
- **R3-8. The Store configuration is universal by inheritance, with no guard on a one-way choice.** `Shared.xcconfig:9-11`.
  The plan and README say iPad should ship with or after the web's size-class rule, and once a version with iPad is on
  the App Store it can never be dropped. Nothing in the build enforces the first part. The pattern already exists for
  the acceptance guard: in "Check origin", refuse `ACTION=install` with `HAIYO_CHANNEL=store` and family `2` unless
  `HAIYO_IPAD_RELEASE=1` is given on purpose. Or keep `TARGETED_DEVICE_FAMILY = 1` in `Store.xcconfig` until the owner
  says go. The owner decides.
- **R3-9. The build-number test restates the constant.** `ShellConfigTests.swift:13` (`"3"`). Every upload edits two
  files (bad4505 did). Assert that it is a positive integer instead.
- **R3-10. The layout state machine has no test.** `ShellViewController.swift:163-173, 217-228, 295-341`. That covers
  re-applying the stopgap on every commit, clearing it on `hello`, not re-sending an unchanged value, `hello` marking
  the value as sent, and the crash reset. All of it lives in the view controller. Extract a small pure
  `LayoutState` (commit / hello / sample / crash → obscured top, event or none) and test those transitions, as was done
  for `ShareCleanup` and `CrashReloadBudget`.
- **R3-11. Docs drift (trivial).**
  - Fold width: README:119 and the fixture say 40 px at x 456; the plan's measurement says x 455, w 41 (plan:160).
  - The cannot-connect screen: plan §2 (plan:52) still says `.horizontal`; the code uses `.vertical`, which the as-built
    note does record.
  - The Duo corner values: the fixtures use 17/2, the table 18/3. The fractional `rounded(.up)` path of `corner` is
    not tested.

Still open from round 2 and not claimed by this round: R2-4 (`ShellLog` keys are `String`), R2-5 (residual paths around
the acceptance guard).

## The eight points in the brief

1. **Bridge boundary.** Holds (table above). The sheet, sub-frames and other origins can neither receive `layout` nor
   send `hello`. Gaps: R3-2 (arrival rather than delivery) and R3-1 (reply contents).
2. **Geometry.**
   - Units, coordinate space, the single subtraction, fold `null` when open or closed, settle, rotation: correct by
     reading.
   - Page scale: the conversion assumes page scale 1. That is broken by R3-I2 on some iPads, and by pinch zoom, which
     `index.html` allows (no `maximum-scale`). State in README that the values describe the unzoomed layout viewport.
   - RTL: `windowControlsTop` uses the app's layout direction. The app has no RTL localisation, so under an Arabic or
     Hebrew system language it stays LTR, while the system may draw the window controls top-right. Unmeasured (device
     check 40). The R3-I1 `.pad` path that does not look at sides would remove the question.
   - Negative or NaN values: see R3-6.
3. **`updateConstraints()`.** No loop, no early call, `#available` correct.
   - The 26.x/27.0 behaviour is safe but makes the stopgap inert (R3-I1).
   - Not verifiable here: whether UIKit re-runs `updateConstraints` when only the corner adaptation changes (no size or
     safe-area change).
4. **Stopgap inset.** It does not stick:
   - every main-frame commit, including reloads and back/forward, re-applies it until the new page's `hello`;
   - a content-process death resets `pageEvents`, and the reload's commit re-applies it;
   - the offline screen is native and has its own guide.
   It doubles only via R3-1 or, if WebKit does not subtract the inset from `env(safe-area-inset-top)`, by 10 pt (device
   check 31). It is inert before 27.1 (R3-I1).
5. **ShareCleanup.**
   - Every normal path removes the folder: dismissed, completed, failed, cancelled then closed, activity outliving the
     sheet.
   - Killed or crashed mid-share: the launch sweep (`AppDelegate.swift:12`). A share sheet covered full-screen and then
     dismissed together with its cover never reports "gone", so its folder stays until the next launch, which is the
     safe direction.
   - Removal under a running activity: possible only via R3-5.
   - No sharing between downloads (UUID folders); no file names logged.
6. **Sheet rule.** No crafted attachment can make the main view open anything today: the service renders only images
   inline (R3-3). `openInApp` paths are validated by `url(forPath:)`. The decoded-path gap is R3-4.
7. **Universal settings.** Correct for TestFlight (table above). App Store implications are in plan §1 and README "Still
   to do"; the missing guard is R3-8; the build-number test is R3-9. `SUPPORTS_MAC_DESIGNED_FOR_IPHONE_IPAD = NO` and
   `SUPPORTS_XR_… = NO` do not set App Store Connect availability (owner item 42).
8. **Tests.**
   - Real logic is tested:
     - `PageLayoutTests`: measured samples, zoom, obscured offset, fractional fold, off-view region, RTL;
     - `NavigationPolicyTests`: the sheet table;
     - `LifecycleRulesTests`: the `ShareCleanup` orderings, including cancel-then-second-activity;
     - the Info.plist test reads the built file raw, so the `~ipad` key is seen.
   - Restated constants: the build number (R3-9) and `centre(of:)` (midX/midY).
   - Untested, and testable without a device: the view controller's layout state machine (R3-10), a no-regions sample
     (R3-I1), a clipped division, the corner's fractional rounding.
   - Device only: everything in the list below.

## Cannot verify without a Mac

1. That it builds with Xcode 27.2 and all 52 tests pass. Note that an iOS 26.2 SDK cannot build it (R3-7).
2. `updateConstraints` re-runs on reserved-region changes, and on corner-adaptation changes without a size or safe-area
   change.
3. Whether WebKit subtracts `obscuredContentInsets` from `env(safe-area-inset-*)`, and what is drawn in the 53-pt band.
4. On iPad: the thread of `itemForActivityType` and its order relative to the popover's `viewDidDisappear` (R3-5).
5. The content mode and UA on iPad, `innerWidth` on portrait iPads (R3-I2).
6. iPadOS 26.x in a window (R3-I1); this needs an iPadOS 26 simulator runtime.
7. Setting the popover's `delegate` on a `UIActivityViewController` leaves its own dismissal and completion intact.

## Device checklist (continues the earlier list, 1–29)

30. iPad, iPadOS 27.2, full screen:
    - no band at the top;
    - all four orientations;
    - no reload while rotating (the cover never flashes).
31. iPad in a window:
    - the page's top-leading control sits below the window controls;
    - what fills the 53-pt band;
    - `env(safe-area-inset-top)` in Web Inspector is 0 with the stopgap on (not 10);
    - drag-resize: no flicker storm, the inset settles about 0.2 s after release;
    - the window cannot be made smaller than 320 × 480.
32. The same on iPadOS 26.x or 27.0 (R3-I1). Today, expect the controls over the page.
33. iPad mini and iPad Air 11-inch, portrait, full screen: `navigator.userAgent` and `innerWidth` (R3-I2); text not
    shrunk.
34. Split halves, thirds, quarters, Slide Over: the page adapts; with `-HaiyoDebugLayout`, the corner values make sense.
35. Share on iPad:
    - download an attachment; the popover is centred with no arrow; rotate or resize with it open, and it stays centred;
    - 保存到“文件”, 存储图像 and 隔空投送 from the popover each succeed (R3-5);
    - afterwards `tmp/downloads` is empty.
36. Share, iPhone and iPad:
    - 保存到“文件” → 取消 → another activity → done;
    - background the app with the sheet open, kill it, relaunch → the folder is swept.
37. The cannot-connect screen in an iPad window (重试 below the controls, full width) and on the Duo when closed (clear of
    the status column).
38. iPhone Duo, when available, with `-HaiyoDebugProbe -HaiyoDebugLayout`:
    - closed, half-open book, half-open laptop, open;
    - fold `null` when closed and when open, no stray fold while closing;
    - with the inner camera in use (FaceTime picture-in-picture), an unaware page is not pushed down.
39. iPad with a hardware keyboard and trackpad: typing, ⌘ shortcuts pass through to the page, hover states, the four
    pointer media queries.
40. Arabic or Hebrew system language, iPad window: which side the window controls are on, and whether the page is kept
    below them.
41. A page that handles `layout` (the probe page) reloaded from Web Inspector in an iPad window: is the 53 → 0 jump
    visible (no cover on reload)?
42. Owner, App Store Connect, before any App Store submission:
    - decide on iPad (one way, R3-8);
    - 13-inch iPad screenshots;
    - the availability settings for Apple silicon Macs and Apple Vision Pro. Those are set in App Store Connect, not by
      the build settings.
43. Sheet with an expired session: open an attachment; the sheet closes and the main view shows the sign-in page, with
    no stuck sheet.
