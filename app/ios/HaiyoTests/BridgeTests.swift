import XCTest
@testable import Haiyo

/// A host that records what the bridge asked of it. `holdPush` keeps the `push.register` completion so a test can
/// change the page before answering; `page` is what the bridge sees as the page shown.
final class FakeHost: BridgeHost {
    var page = BridgePage(generation: 1, isOwnOrigin: true)
    var hellos: [Set<String>] = []
    var pushRegistrations = 0
    var badges: [Int] = []
    var holdPush = false
    var heldPush: (([String: Any]) -> Void)?

    var bridgePage: BridgePage { page }

    func bridgeHello(events: Set<String>, completion: @escaping ([String: Any]) -> Void) {
        hellos.append(events)
        completion(["bridge": 1, "events": events.sorted(), "push": "notDetermined"])
    }

    func bridgePushRegister(completion: @escaping ([String: Any]) -> Void) {
        pushRegistrations += 1
        if holdPush { heldPush = completion } else { completion(["denied": true]) }
    }

    func bridgeBadgeSet(_ n: Int, completion: @escaping ([String: Any]) -> Void) {
        badges.append(n)
        completion(["ok": true])
    }

    var touched: Bool { !hellos.isEmpty || pushRegistrations > 0 || !badges.isEmpty }
}

final class BridgeMessageTests: XCTestCase {
    func testValidRequests() {
        XCTAssertEqual(try BridgeMessage.parse(["name": "hello"]).get(), .hello(events: []))
        XCTAssertEqual(try BridgeMessage.parse(["name": "hello", "args": NSNull()]).get(), .hello(events: []))
        XCTAssertEqual(
            try BridgeMessage.parse(["name": "hello", "args": ["events": ["open", "pause", "resume", "other"]]]).get(),
            .hello(events: ["open", "pause", "resume"])
        )
        XCTAssertEqual(try BridgeMessage.parse(["name": "push.register"]).get(), .pushRegister)
        XCTAssertEqual(try BridgeMessage.parse(["name": "badge.set", "args": ["n": NSNumber(value: 0)]]).get(), .badgeSet(0))
        XCTAssertEqual(try BridgeMessage.parse(["name": "badge.set", "args": ["n": NSNumber(value: 12.0)]]).get(), .badgeSet(12))
        XCTAssertEqual(try BridgeMessage.parse(["name": "badge.set", "args": ["n": NSNumber(value: 99_999)]]).get(), .badgeSet(99_999))
    }

    func testMalformedBodies() {
        let bodies: [Any] = [
            "hello",
            NSNumber(value: 1),
            ["args": [:] as [String: Any]],
            ["name": NSNumber(value: 1)],
            ["name": "hello", "args": "x"],
            ["name": "hello", "args": [1, 2]],
            ["name": "hello", "args": ["events": "open"]],
            ["name": "hello", "args": ["events": Array(repeating: "open", count: 17)]],
            ["name": "badge.set"],
            ["name": "badge.set", "args": ["n": "3"]],
            ["name": "badge.set", "args": ["n": NSNumber(value: true)]],
            ["name": "badge.set", "args": ["n": NSNumber(value: 1.5)]],
            ["name": "badge.set", "args": ["n": NSNumber(value: -1)]],
            ["name": "badge.set", "args": ["n": NSNumber(value: 100_000)]],
            ["name": "badge.set", "args": ["n": NSNumber(value: Double.infinity)]],
            ["name": "badge.set", "args": ["n": NSNumber(value: Double.nan)]],
        ]
        for body in bodies {
            guard case .failure(.malformed) = BridgeMessage.parse(body) else {
                return XCTFail("not refused as malformed: \(body)")
            }
        }
    }

    func testUnknownNames() {
        for name in ["", "Hello", "push", "badge.clear", "eval", "push.register "] {
            guard case .failure(.unknown) = BridgeMessage.parse(["name": name]) else {
                return XCTFail("not refused as unknown: \(name)")
            }
        }
    }

    func testEventScriptsCheckTheOriginAndCarryTheirDetailAsJSON() {
        let pause = BridgeEvent.pause.script(origin: testConfig.origin)
        XCTAssertEqual(
            pause,
            "(function () { if (location.origin !== \"https:\\/\\/test.haiyo.org\") return false; "
                + "window.dispatchEvent(new CustomEvent(\"haiyo:pause\", { detail: null })); return true; })()"
        )
        let open = BridgeEvent.open(path: "/chat/x\"</script><script>alert(1)//").script(origin: testConfig.origin)
        XCTAssertTrue(open.contains("{ detail: {\"path\":\"\\/chat\\/x\\\"<\\/script>"), open)
        XCTAssertFalse(open.contains("\"</script>"))
    }

    /// `layout` is an event a page can ask for; its detail is the layout as JSON, keys sorted, `fold` null when none.
    func testTheLayoutEvent() {
        XCTAssertEqual(try BridgeMessage.parse(["name": "hello", "args": ["events": ["layout", "resume"]]]).get(),
                       .hello(events: ["layout", "resume"]))
        let none = BridgeEvent.layout(PageLayout()).script(origin: testConfig.origin)
        XCTAssertTrue(none.contains("new CustomEvent(\"haiyo:layout\", { detail: {\"corner\":{\"leading\":0,\"top\":0,\"trailing\":0},\"fold\":null} })"), none)
        let folded = PageLayout(fold: .init(axis: .vertical, x: 456, y: 0, width: 40, height: 669), corner: .init(top: 16, leading: 16, trailing: 0))
        let script = BridgeEvent.layout(folded).script(origin: testConfig.origin)
        XCTAssertTrue(script.hasPrefix("(function () { if (location.origin !== \"https:\\/\\/test.haiyo.org\") return false; "), script)
        XCTAssertTrue(script.contains("\"fold\":{\"axis\":\"vertical\",\"height\":669,\"width\":40,\"x\":456,\"y\":0}"), script)
    }
}

final class BridgeHandlingTests: XCTestCase {
    private let own = FrameSource(isMainFrame: true, scheme: "https", host: "test.haiyo.org", port: 0)

    /// Sends one message and returns every reply the bridge gave (it must be exactly one, eventually).
    private func send(_ body: Any, from source: FrameSource, host: FakeHost, bridge: Bridge? = nil) -> [(Any?, String?)] {
        let bridge = bridge ?? Bridge(config: testConfig, host: host)
        var replies: [(Any?, String?)] = []
        bridge.handle(source: source, body: body) { value, error in replies.append((value, error)) }
        return replies
    }

    private func only(_ replies: [(Any?, String?)]) -> (Any?, String?) {
        XCTAssertEqual(replies.count, 1, "the bridge must reply exactly once")
        return replies.first ?? (nil, nil)
    }

    func testOtherOriginsAndSubFramesAreIgnored() {
        let refused = [
            FrameSource(isMainFrame: false, scheme: "https", host: "test.haiyo.org", port: 0),
            FrameSource(isMainFrame: true, scheme: "https", host: "example.com", port: 0),
            FrameSource(isMainFrame: false, scheme: "https", host: "example.com", port: 0),
            FrameSource(isMainFrame: true, scheme: "http", host: "test.haiyo.org", port: 0),
        ]
        for source in refused {
            for body in [["name": "hello"], ["name": "push.register"], ["name": "badge.set", "args": ["n": NSNumber(value: 3)]]] as [[String: Any]] {
                let host = FakeHost()
                let (value, error) = only(send(body, from: source, host: host))
                XCTAssertNil(value)
                XCTAssertEqual(error, "forbidden")
                XCTAssertFalse(host.touched, "a refused message had an effect: \(source) \(body)")
            }
        }
    }

    func testAPageNotOnTheOwnOriginIsRefusedAtArrival() {
        let host = FakeHost()
        host.page = BridgePage(generation: 1, isOwnOrigin: false)
        XCTAssertEqual(only(send(["name": "badge.set", "args": ["n": NSNumber(value: 1)]], from: own, host: host)).1, "forbidden")
        XCTAssertFalse(host.touched)
    }

    func testTheOwnPageIsServed() {
        let host = FakeHost()
        let (hello, helloError) = only(send(["name": "hello", "args": ["events": ["open"]]], from: own, host: host))
        XCTAssertNil(helloError)
        XCTAssertEqual((hello as? [String: Any])?["events"] as? [String], ["open"])
        XCTAssertEqual(host.hellos, [["open"]])

        let (badge, badgeError) = only(send(["name": "badge.set", "args": ["n": NSNumber(value: 4)]], from: own, host: host))
        XCTAssertNil(badgeError)
        XCTAssertEqual((badge as? [String: Any])?["ok"] as? Bool, true)
        XCTAssertEqual(host.badges, [4])

        let (push, pushError) = only(send(["name": "push.register"], from: own, host: host))
        XCTAssertNil(pushError)
        XCTAssertEqual((push as? [String: Any])?["denied"] as? Bool, true)
        XCTAssertEqual(host.pushRegistrations, 1)
    }

    func testInvalidMessagesFromTheOwnPageHaveNoEffect() {
        let host = FakeHost()
        XCTAssertEqual(only(send(["name": "badge.set", "args": ["n": "9"]], from: own, host: host)).1, "malformed")
        XCTAssertEqual(only(send(["name": "exec"], from: own, host: host)).1, "unknown")
        XCTAssertFalse(host.touched)
    }

    /// C1: an answer that comes after the page changed is not delivered.
    func testALateAnswerIsRecheckedWhenItIsDelivered() {
        for change in ["new document", "left the origin"] {
            let host = FakeHost()
            host.holdPush = true
            var replies: [(Any?, String?)] = []
            let bridge = Bridge(config: testConfig, host: host)
            bridge.handle(source: own, body: ["name": "push.register"]) { value, error in replies.append((value, error)) }
            XCTAssertTrue(replies.isEmpty, "nothing is answered before the token comes")
            host.page = change == "new document"
                ? BridgePage(generation: 2, isOwnOrigin: true)
                : BridgePage(generation: 1, isOwnOrigin: false)
            host.heldPush?(["token": "abc", "env": "production"])
            XCTAssertEqual(replies.count, 1, change)
            XCTAssertNil(replies.first?.0, "\(change): the token must not be delivered")
            XCTAssertEqual(replies.first?.1, "forbidden", change)
        }
    }

    func testALateAnswerToTheSamePageIsDeliveredOnce() {
        let host = FakeHost()
        host.holdPush = true
        var replies: [(Any?, String?)] = []
        let bridge = Bridge(config: testConfig, host: host)
        bridge.handle(source: own, body: ["name": "push.register"]) { value, error in replies.append((value, error)) }
        host.heldPush?(["token": "abc", "env": "production"])
        host.heldPush?(["token": "again"])
        XCTAssertEqual(replies.count, 1)
        XCTAssertEqual((replies.first?.0 as? [String: Any])?["token"] as? String, "abc")
    }
}
