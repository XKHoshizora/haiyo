import WebKit
import XCTest
@testable import Haiyo

/// The gate with real WebKit frames: pages are loaded from strings with a base URL (no network), and each one posts
/// to the `haiyo` handler. Only the main frame of the own origin gets an answer; everything else is refused.
@MainActor
final class BridgeInWebViewTests: XCTestCase {
    private var host: FakeHost!
    private var bridge: Bridge!
    private var webView: WKWebView!
    private var loader: Loader!

    override func setUp() async throws {
        host = FakeHost()
        bridge = Bridge(config: testConfig, host: host)
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.handlerName)
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
        loader = Loader()
        webView.navigationDelegate = loader
    }

    override func tearDown() async throws {
        webView.configuration.userContentController.removeAllScriptMessageHandlers()
        webView = nil
    }

    private func load(_ html: String, base: String) async throws {
        try await loader.load(html, base: URL(string: base)!, in: webView)
    }

    /// Posts from the main frame and returns the reply, or the error string the promise rejected with.
    private func postFromMainFrame(_ body: String) async -> String {
        let script = """
        try { const r = await window.webkit.messageHandlers.haiyo.postMessage(\(body)); return "ok:" + JSON.stringify(r); }
        catch (e) { return "err:" + (e && e.message ? e.message : String(e)); }
        """
        do {
            let value = try await webView.callAsyncJavaScript(script, contentWorld: .page)
            return value as? String ?? "nothing"
        } catch {
            return "js-failed: \(error)"
        }
    }

    func testTheOwnOriginMainFrameIsAnswered() async throws {
        try await load("<p>own</p>", base: "https://test.haiyo.org/chat")
        let reply = await postFromMainFrame(#"{ name: "hello", args: { events: ["open"] } }"#)
        XCTAssertTrue(reply.hasPrefix("ok:"), reply)
        XCTAssertEqual(host.hellos, [["open"]])
    }

    func testAnotherOriginIsRefused() async throws {
        try await load("<p>other</p>", base: "https://example.com/")
        let reply = await postFromMainFrame(#"{ name: "badge.set", args: { n: 3 } }"#)
        XCTAssertEqual(reply, "err:forbidden")
        XCTAssertFalse(host.touched)
    }

    func testAMainFrameThatNavigatedAwayIsRefused() async throws {
        try await load("<p>own</p>", base: "https://test.haiyo.org/")
        let before = await postFromMainFrame(#"{ name: "hello" }"#)
        XCTAssertTrue(before.hasPrefix("ok:"), before)
        try await load("<p>elsewhere</p>", base: "https://test.haiyo.org.evil.com/")
        let after = await postFromMainFrame(#"{ name: "badge.set", args: { n: 5 } }"#)
        XCTAssertEqual(after, "err:forbidden")
        XCTAssertEqual(host.badges, [])
    }

    func testASubFrameOfTheOwnOriginIsRefused() async throws {
        let child = """
        <script>
        window.webkit.messageHandlers.haiyo.postMessage({ name: "badge.set", args: { n: 7 } })
          .then(r => parent.postMessage("ok", "*"), e => parent.postMessage("err:" + e.message, "*"));
        </script>
        """
        let page = """
        <script>window.__sub = null; addEventListener("message", e => { window.__sub = e.data; });</script>
        <iframe srcdoc="\(child.replacingOccurrences(of: "\"", with: "&quot;"))"></iframe>
        """
        try await load(page, base: "https://test.haiyo.org/")
        var result: String?
        for _ in 0..<50 where result == nil {
            try await Task.sleep(nanoseconds: 100_000_000)
            result = try await webView.evaluateJavaScript("window.__sub") as? String
        }
        XCTAssertEqual(result, "err:forbidden")
        XCTAssertEqual(host.badges, [])
    }
}

/// Waits for a string load to finish.
@MainActor
private final class Loader: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?

    func load(_ html: String, base: URL, in webView: WKWebView) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            continuation = c
            webView.loadHTMLString(html, baseURL: base)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        continuation?.resume()
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        continuation?.resume(throwing: error)
        continuation = nil
    }
}
