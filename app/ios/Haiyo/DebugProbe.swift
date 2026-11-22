#if DEBUG
import Network
import WebKit

/// Debug builds only (compiled out of Acceptance and Store): launch options to check, in the Simulator, what the web
/// side does not exercise yet. Everything it logs goes through `ShellLog` (flags and counts only).
///
/// - `-HaiyoDebugUnreachableOnce`: the first load goes through a closed local port (the Simulator has no airplane
///   mode); 重试 removes it.
/// - `-HaiyoDebugProbe`: probe links on top of the page (another site in a new window and in place, the app's own page
///   in a new window); a recorder for `haiyo:` events; `hello` and `badge.set` posted by the page itself; the
///   user-agent mark checked.
/// - `-HaiyoDebugC1`: the page asks `push.register`, and the shell reloads it before the answer comes, so the answer
///   must be refused when it is delivered.
enum DebugProbe {
    static let unreachableOnce = "-HaiyoDebugUnreachableOnce"
    static let probe = "-HaiyoDebugProbe"
    static let c1 = "-HaiyoDebugC1"

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
          for (const n of ["pause", "resume", "open"]) addEventListener("haiyo:" + n, () => window.__haiyoEvents.push(n));
          const box = document.createElement("div");
          box.id = "haiyo-probe";
          box.style.cssText = "position:fixed;left:50%;top:40%;transform:translateX(-50%);z-index:99999;display:flex;flex-direction:column;gap:10px";
          const link = (href, text, blank) => '<a href="' + href + '"' + (blank ? ' target="_blank"' : '') + ' style="padding:10px 14px;background:#fff;border-radius:10px">' + text + '</a>';
          box.innerHTML = link("https://www.apple.com/", "probe: other site, new window", true)
            + link("https://example.com/", "probe: other site, same window", false)
            + link(ownPage, "probe: own page, new window", true);
          document.body.appendChild(box);
        }
        const h = window.webkit.messageHandlers.haiyo;
        const hello = await h.postMessage({ name: "hello", args: { events: ["pause", "resume"] } });
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
