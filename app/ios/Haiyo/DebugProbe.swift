#if DEBUG
import Network
import UIKit
import WebKit

/// Debug builds only (compiled out of Acceptance and Store): launch options to check, in the Simulator, what the web
/// side does not exercise yet. Everything it logs goes through `ShellLog` (flags and counts only).
///
/// - `-HaiyoDebugUnreachableOnce`: the first load goes through a closed local port (the Simulator has no airplane
///   mode); 重试 removes it.
/// - `-HaiyoDebugProbe`: probe links on top of the page (another site in a new window and in place, the app's own page
///   in a new window, a `mailto:` link; the same `mailto:` is also clicked by script two seconds later); a recorder for
///   `haiyo:` events, the page handling `layout`; `hello` and `badge.set` posted by the page itself; the user-agent mark
///   checked.
/// - `-HaiyoDebugC1`: the page asks `push.register`, and the shell reloads it before the answer comes, so the answer
///   must be refused when it is delivered.
/// - `-HaiyoDebugShare`: once the first page is shown, the share sheet with a small text file, as after a download.
/// - `-HaiyoDebugLayout`: whenever the geometry changes, logs the numbers the iPad and Duo layout rests on — the plain
///   and the corner-adapted safe area, the fold and camera regions, and what the page sees (`env(safe-area-inset-*)`,
///   its viewport, the pointer media queries). Numbers and flags only.
enum DebugProbe {
    static let unreachableOnce = "-HaiyoDebugUnreachableOnce"
    static let probe = "-HaiyoDebugProbe"
    static let c1 = "-HaiyoDebugC1"
    static let layout = "-HaiyoDebugLayout"
    static let share = "-HaiyoDebugShare"
    private static var shared = false

    /// True once, after the first page, when `-HaiyoDebugShare` is given.
    static var shareNow: Bool {
        guard has(share), !shared else { return false }
        shared = true
        return true
    }

    private static func has(_ option: String) -> Bool { ProcessInfo.processInfo.arguments.contains(option) }
    private static var c1Started = false

    static func applyBeforeFirstLoad(to webView: WKWebView) {
        guard has(unreachableOnce) else { return }
        let closedPort = NWEndpoint.hostPort(host: "127.0.0.1", port: 9)
        webView.configuration.websiteDataStore.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: closedPort)]
    }

    static func clear(from webView: WKWebView) {
        webView.configuration.websiteDataStore.proxyConfigurations = []
    }

    static func logReply(_ value: Any?, _ error: String?) {
        ShellLog.note("bridge-reply", ("delivered", .flag(error == nil)), ("forbidden", .flag(error == BridgeError.forbidden.rawValue)))
    }

    static func pageShown(_ webView: WKWebView, config: ShellConfig) {
        if has(probe) { addProbe(to: webView, config: config) }
        if has(c1), !c1Started {
            c1Started = true
            webView.evaluateJavaScript("window.webkit.messageHandlers.haiyo.postMessage({ name: \"push.register\" }); true", completionHandler: nil)
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                ShellLog.note("debug-c1-reload")
                webView.reload()
            }
        }
    }

    private static func addProbe(to webView: WKWebView, config: ShellConfig) {
        let own = config.origin.absoluteString + "/"
        let mark = config.applicationName(appendingTo: "Mobile/15E148")
        let body = """
        if (!document.getElementById("haiyo-probe")) {
          window.__haiyoEvents = [];
          window.__haiyoLayouts = [];
          for (const n of ["pause", "resume", "open"]) addEventListener("haiyo:" + n, () => window.__haiyoEvents.push(n));
          addEventListener("haiyo:layout", e => window.__haiyoLayouts.push(e.detail));
          const box = document.createElement("div");
          box.id = "haiyo-probe";
          box.style.cssText = "position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:10px";
          const link = (href, text, blank) => '<a href="' + href + '"' + (blank ? ' target="_blank"' : '') + ' style="padding:10px 14px;background:#fff;border-radius:10px">' + text + '</a>';
          box.innerHTML = link("https://www.apple.com/", "probe: other site, new window", true)
            + link("https://example.com/", "probe: other site, same window", false)
            + link(ownPage, "probe: own page, new window", true)
            + link("mailto:probe@example.com", "probe: mailto, tap", false);
          document.body.appendChild(box);
          const scripted = document.createElement("a");
          scripted.href = "mailto:probe-script@example.com";
          setTimeout(() => scripted.click(), 2000);
        }
        const h = window.webkit.messageHandlers.haiyo;
        const hello = await h.postMessage({ name: "hello", args: { events: ["pause", "resume", "layout"] } });
        window.__haiyoLayouts.push(Object.assign({ hello: true }, hello.layout));
        const badge = await h.postMessage({ name: "badge.set", args: { n: 3 } });
        return [hello.bridge === 1 && ["granted", "denied", "notDetermined"].includes(hello.push),
                badge.ok === true,
                navigator.userAgent.endsWith(mark)];
        """
        webView.callAsyncJavaScript(body, arguments: ["ownPage": own, "mark": mark], in: nil, in: .page) { result in
            guard case let .success(value) = result, let flags = value as? [Bool], flags.count == 3 else {
                ShellLog.note("debug-probe", ("ran", .flag(false)))
                return
            }
            ShellLog.note("debug-probe", ("hello", .flag(flags[0])), ("badgeSet", .flag(flags[1])), ("userAgentMark", .flag(flags[2])))
        }
    }

    /// The `haiyo:` events the page received so far, as counts.
    static func reportEvents(of webView: WKWebView) {
        guard has(probe) else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
            let script = "(window.__haiyoEvents || []).reduce((c, n) => (c[n] = (c[n] || 0) + 1, c), {})"
            webView.evaluateJavaScript(script) { value, _ in
                let counts = value as? [String: Int] ?? [:]
                ShellLog.note("debug-events", ("pause", .count(counts["pause"] ?? 0)), ("resume", .count(counts["resume"] ?? 0)), ("open", .count(counts["open"] ?? 0)))
            }
        }
    }

    /// Logs the route shape (ids replaced, no query) and whether WebKit has an entry to go back to.
    static func observeHistory(of webView: WKWebView) -> [NSKeyValueObservation] {
        let report: (WKWebView) -> Void = { webView in
            ShellLog.note(
                "history",
                ("route", .route(webView.url?.path ?? "/")),
                ("canGoBack", .flag(webView.canGoBack)),
                ("back", .count(webView.backForwardList.backList.count))
            )
        }
        return [
            webView.observe(\.url, options: [.new]) { webView, _ in report(webView) },
            webView.observe(\.canGoBack, options: [.new]) { webView, _ in report(webView) },
        ]
    }

    /// What WebKit reports for a `mailto:`, `tel:` or `sms:` navigation (a tap and a script's click look alike?).
    static func logSystemLink(_ action: WKNavigationAction) {
        ShellLog.note("debug-system-link", ("type", .count(action.navigationType.rawValue)),
                      ("button", .count(Int(action.buttonNumber.rawValue))),
                      ("modifiers", .count(Int(action.modifierFlags.rawValue))),
                      ("mainFrame", .flag(action.targetFrame?.isMainFrame ?? false)))
    }

    // MARK: Layout

    private static var layoutTimer: Timer?
    private static var lastLayout = ""
    private static var layoutEventsSeen = 0

    /// Checks the geometry every second (the fold has no notification) and logs it when it changed.
    static func watchLayout(of view: UIView, webView: WKWebView) {
        guard has(layout), layoutTimer == nil else { return }
        layoutTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak view, weak webView] _ in
            MainActor.assumeIsolated {
                guard let view, let webView else { return }
                reportLayoutIfChanged(view, webView: webView)
            }
        }
    }

    private static func n(_ x: CGFloat) -> ShellLog.Field { .count(Int(x.rounded())) }

    private static func reportLayoutIfChanged(_ view: UIView, webView: WKWebView) {
        let safe = view.safeAreaInsets
        let horizontal = view.edgeInsets(for: .safeArea(cornerAdaptation: .horizontal))
        let vertical = view.edgeInsets(for: .safeArea(cornerAdaptation: .vertical))
        var regions: [(String, Bool, CGRect, UIEdgeInsets)] = []
        if #available(iOS 27.1, *) {
            for (name, kind) in [("division", UIView.ReservedRegion.Kind.division), ("occlusion", .occlusion)] {
                for region in webView.reservedRegions(kind: kind, options: [.includeInactive]) {
                    regions.append((name, region.isActive, region.frame, region.margins))
                }
            }
        }
        reportPage(webView)
        if has(probe) { reportLayoutEvents(webView) }
        let signature = "\(view.bounds) \(safe) \(horizontal) \(vertical) \(regions.map { "\($0.0)\($0.1)\($0.2)\($0.3)" })"
        guard signature != lastLayout else { return }
        lastLayout = signature
        ShellLog.note("debug-layout-view", ("w", n(view.bounds.width)), ("h", n(view.bounds.height)),
                      ("zoom100", .count(Int((webView.pageZoom * 100).rounded()))),
                      ("obscuredTop", n(webView.obscuredContentInsets.top)))
        for (name, i) in [("safe", safe), ("cornerH", horizontal), ("cornerV", vertical)] {
            ShellLog.note("debug-layout-insets", (name, .flag(true)), ("t", n(i.top)), ("l", n(i.left)), ("b", n(i.bottom)), ("r", n(i.right)))
        }
        if regions.isEmpty { ShellLog.note("debug-layout-region", ("count", .count(0))) }
        for (name, active, frame, margins) in regions {
            ShellLog.note("debug-layout-region", (name, .flag(true)), ("active", .flag(active)),
                          ("x", n(frame.minX)), ("y", n(frame.minY)), ("w", n(frame.width)), ("h", n(frame.height)),
                          ("mt", n(margins.top)), ("ml", n(margins.left)), ("mb", n(margins.bottom)), ("mr", n(margins.right)))
        }
    }

    private static var lastPage = ""

    /// `haiyo:layout` details the probe page received (the first one is the `hello` reply's `layout`).
    private static func reportLayoutEvents(_ webView: WKWebView) {
        let script = """
        const all = window.__haiyoLayouts || [];
        return all.map(d => [d.hello ? 1 : 0, d.fold ? 1 : 0, d.fold && d.fold.axis === "vertical" ? 1 : 0,
                             d.fold ? d.fold.x : -1, d.fold ? d.fold.y : -1, d.fold ? d.fold.width : -1, d.fold ? d.fold.height : -1,
                             d.corner.top, d.corner.leading, d.corner.trailing]);
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            guard case let .success(value) = result, let rows = value as? [[Int]], rows.count > layoutEventsSeen else { return }
            for v in rows[layoutEventsSeen...] where v.count == 10 {
                ShellLog.note("debug-layout-event", ("hello", .flag(v[0] == 1)), ("fold", .flag(v[1] == 1)), ("vertical", .flag(v[2] == 1)),
                              ("x", .count(v[3])), ("y", .count(v[4])), ("w", .count(v[5])), ("h", .count(v[6])),
                              ("cornerTop", .count(v[7])), ("cornerLeading", .count(v[8])), ("cornerTrailing", .count(v[9])))
            }
            layoutEventsSeen = rows.count
        }
    }

    /// What the page sees; logged when it changed (WebKit passes a new safe area a moment after a resize).
    private static func reportPage(_ webView: WKWebView) {
        let script = """
        const px = v => Math.round(parseFloat(v) || 0);
        const d = document.createElement("div");
        d.style.setProperty("position", "absolute");
        d.style.setProperty("visibility", "hidden");
        d.style.setProperty("padding-top", "env(safe-area-inset-top, 7px)");
        d.style.setProperty("padding-left", "env(safe-area-inset-left, 7px)");
        d.style.setProperty("padding-bottom", "env(safe-area-inset-bottom, 7px)");
        d.style.setProperty("padding-right", "env(safe-area-inset-right, 7px)");
        document.body.appendChild(d);
        const c = getComputedStyle(d);
        const pad = [c.paddingTop, c.paddingLeft, c.paddingBottom, c.paddingRight].map(px);
        const specified = d.style.getPropertyValue("padding-right") ? 1 : 0;
        d.remove();
        const q = s => matchMedia(s).matches ? 1 : 0;
        const top = document.querySelector(".app");
        const t = top ? getComputedStyle(top) : null;
        const topPad = t ? [t.paddingTop, t.paddingLeft, t.paddingBottom, t.paddingRight].map(px) : [-1, -1, -1, -1];
        return pad.concat([innerWidth, innerHeight, q("(pointer: fine)"), q("(pointer: coarse)"), q("(hover: hover)"),
                           q("(any-pointer: fine)"), q("(any-hover: hover)")], topPad, [specified]);
        """
        webView.callAsyncJavaScript(script, arguments: [:], in: nil, in: .page) { result in
            guard case let .success(value) = result, let v = value as? [Int], v.count == 16 else {
                ShellLog.note("debug-layout-page", ("ran", .flag(false)))
                return
            }
            let text = v.map(String.init).joined(separator: ",")
            guard text != lastPage else { return }
            lastPage = text
            ShellLog.note("debug-layout-page", ("envT", .count(v[0])), ("envL", .count(v[1])), ("envB", .count(v[2])), ("envR", .count(v[3])),
                          ("innerW", .count(v[4])), ("innerH", .count(v[5])), ("pointerFine", .count(v[6])), ("pointerCoarse", .count(v[7])),
                          ("hover", .count(v[8])), ("anyPointerFine", .count(v[9])), ("anyHover", .count(v[10])),
                          ("appT", .count(v[11])), ("appL", .count(v[12])), ("appB", .count(v[13])), ("appR", .count(v[14])),
                          ("specified", .count(v[15])))
        }
    }

    /// The sheet's page must not see the bridge.
    static func checkSheet(_ webView: WKWebView) {
        let script = "!!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.haiyo)"
        webView.evaluateJavaScript(script) { value, error in
            guard error == nil, let visible = value as? Bool else {
                ShellLog.note("debug-sheet", ("checked", .flag(false)), ("error", .error(error)))
                return
            }
            ShellLog.note("debug-sheet", ("checked", .flag(true)), ("bridgeVisible", .flag(visible)))
        }
    }
}
#endif
