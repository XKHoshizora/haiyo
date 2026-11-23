import WebKit
import XCTest
@testable import Haiyo

/// The bridge with real WebKit frames: pages are loaded from strings with a base URL (no network), and each one posts
/// to the `haiyo` handler. Only the main frame of the own origin gets an answer, and only while it is still the page
/// shown; everything else is refused.
@MainActor
final class BridgeInWebViewTests: XCTestCase {
    private var host: WebPageHost!
    private var bridge: Bridge!
    private var webView: WKWebView!
    private var loader: Loader!
    private var delivered: [(Any?, String?)] = []

    override func setUp() async throws {
        host = WebPageHost()
        bridge = Bridge(config: testConfig, host: host)
        delivered = []
        bridge.replyObserver = { [unowned self] value, error in delivered.append((value, error)) }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.handlerName)
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 320, height: 480), configuration: configuration)
        host.webView = webView
        loader = Loader(host: host)
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

    /// Posts without waiting; the outcome lands in `window.__r` when the promise settles.
    private func postAndRemember(_ body: String) async throws {
        _ = try await webView.evaluateJavaScript("""
        window.__r = null;
        window.webkit.messageHandlers.haiyo.postMessage(\(body))
          .then(r => { window.__r = "ok:" + JSON.stringify(r); }, e => { window.__r = "err:" + e.message; });
        true
        """)
    }

    private func remembered() async throws -> String? {
        for _ in 0..<50 {
            if let value = try await webView.evaluateJavaScript("window.__r") as? String { return value }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        return nil
    }

    func testTheOwnOriginMainFrameIsAnswered() async throws {
        try await load("<p>own</p>", base: "https://test.haiyo.org/chat")
        let reply = await postFromMainFrame(#"{ name: "hello", args: { events: ["open"] } }"#)
        XCTAssertTrue(reply.hasPrefix("ok:"), reply)
        XCTAssertEqual(host.fake.hellos, [["open"]])
    }

    func testAnotherOriginIsRefused() async throws {
        try await load("<p>other</p>", base: "https://example.com/")
        let reply = await postFromMainFrame(#"{ name: "badge.set", args: { n: 3 } }"#)
        XCTAssertEqual(reply, "err:forbidden")
        XCTAssertFalse(host.fake.touched)
    }

    func testLookAlikeOriginsAreRefused() async throws {
        for base in ["https://test.haiyo.org./", "https://test.haiyo.org:8443/", "https://xn--test-haiyo-org.example/"] {
            try await load("<p>look-alike</p>", base: base)
            let reply = await postFromMainFrame(#"{ name: "badge.set", args: { n: 2 } }"#)
            XCTAssertEqual(reply, "err:forbidden", base)
        }
        XCTAssertFalse(host.fake.touched)
    }

    func testAnOpaqueOriginIsRefused() async throws {
        try await loader.load("<p>no origin</p>", base: nil, in: webView)
        let reply = await postFromMainFrame(#"{ name: "hello" }"#)
        XCTAssertEqual(reply, "err:forbidden")
        XCTAssertFalse(host.fake.touched)
    }

    func testAMainFrameThatNavigatedAwayIsRefused() async throws {
        try await load("<p>own</p>", base: "https://test.haiyo.org/")
        let before = await postFromMainFrame(#"{ name: "hello" }"#)
        XCTAssertTrue(before.hasPrefix("ok:"), before)
        try await load("<p>elsewhere</p>", base: "https://test.haiyo.org.evil.com/")
        let after = await postFromMainFrame(#"{ name: "badge.set", args: { n: 5 } }"#)
        XCTAssertEqual(after, "err:forbidden")
        XCTAssertEqual(host.fake.badges, [])
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
        XCTAssertEqual(host.fake.badges, [])
    }

    /// C1 with a real navigation: the page that asked is gone when the token comes; the answer is refused.
    func testAnAnswerAfterANewDocumentIsRefused() async throws {
        host.fake.holdPush = true
        try await load("<p>asks</p>", base: "https://test.haiyo.org/")
        try await postAndRemember(#"{ name: "push.register" }"#)
        for _ in 0..<50 where host.fake.heldPush == nil { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertNotNil(host.fake.heldPush, "the request reached the host")
        try await load("<p>another document</p>", base: "https://test.haiyo.org/chat")
        host.fake.heldPush?(["token": "abc", "env": "production"])
        XCTAssertEqual(delivered.count, 1)
        XCTAssertNil(delivered.first?.0, "the token must not be delivered")
        XCTAssertEqual(delivered.first?.1, "forbidden")
    }

    /// C1 in a live document: when the page generation changes under it, the page's promise rejects.
    func testAnAnswerAfterTheGenerationChangedRejectsInThePage() async throws {
        host.fake.holdPush = true
        try await load("<p>asks</p>", base: "https://test.haiyo.org/")
        try await postAndRemember(#"{ name: "push.register" }"#)
        for _ in 0..<50 where host.fake.heldPush == nil { try await Task.sleep(nanoseconds: 50_000_000) }
        host.generation += 1
        host.fake.heldPush?(["token": "abc", "env": "production"])
        let outcome = try await remembered()
        XCTAssertEqual(outcome, "err:forbidden")
    }

    func testAnAnswerToTheSamePageArrives() async throws {
        host.fake.holdPush = true
        try await load("<p>asks</p>", base: "https://test.haiyo.org/")
        try await postAndRemember(#"{ name: "push.register" }"#)
        for _ in 0..<50 where host.fake.heldPush == nil { try await Task.sleep(nanoseconds: 50_000_000) }
        host.fake.heldPush?(["token": "abc", "env": "production"])
        let outcome = try await remembered() ?? "nil"
        XCTAssertTrue(outcome.hasPrefix("ok:"), outcome)
        XCTAssertTrue(outcome.contains("\"token\":\"abc\""), outcome)
    }
}

/// The page as the bridge sees it, from a real web view: the generation counts main-frame commits.
@MainActor
final class WebPageHost: BridgeHost {
    let fake = FakeHost()
    weak var webView: WKWebView?
    var generation = 0

    var bridgePage: BridgePage {
        BridgePage(generation: generation, isOwnOrigin: webView?.url.map(testConfig.isOwnOrigin) ?? false)
    }

    func bridgeHello(events: Set<String>, completion: @escaping ([String: Any]) -> Void) {
        fake.bridgeHello(events: events, completion: completion)
    }

    func bridgeHelloDelivered(events: Set<String>) {
        fake.bridgeHelloDelivered(events: events)
    }

    func bridgePushRegister(completion: @escaping ([String: Any]) -> Void) {
        fake.bridgePushRegister(completion: completion)
    }

    func bridgeBadgeSet(_ n: Int, completion: @escaping ([String: Any]) -> Void) {
        fake.bridgeBadgeSet(n, completion: completion)
    }
}

/// Waits for a string load to finish and counts commits for the host.
@MainActor
private final class Loader: NSObject, WKNavigationDelegate {
    private let host: WebPageHost
    private var continuation: CheckedContinuation<Void, Error>?

    init(host: WebPageHost) { self.host = host }

    func load(_ html: String, base: URL?, in webView: WKWebView) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            continuation = c
            webView.loadHTMLString(html, baseURL: base)
        }
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        host.generation += 1
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
