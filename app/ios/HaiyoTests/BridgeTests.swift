import XCTest
@testable import Haiyo

/// A host that records what the bridge asked of it.
final class FakeHost: BridgeHost {
    var hellos: [Set<String>] = []
    var pushRegistrations = 0
    var badges: [Int] = []

    func bridgeHello(events: Set<String>) -> [String: Any] {
        hellos.append(events)
        return ["bridge": 1, "events": events.sorted()]
    }

    func bridgePushRegister(completion: @escaping ([String: Any]) -> Void) {
        pushRegistrations += 1
        completion(["denied": true])
    }

    func bridgeBadgeSet(_ n: Int) {
        badges.append(n)
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

    func testEventScriptsCarryTheirDetailAsJSON() {
        XCTAssertEqual(BridgeEvent.pause.script, "window.dispatchEvent(new CustomEvent(\"haiyo:pause\", { detail: null }));")
        let script = BridgeEvent.open(path: "/chat/x\"</script><script>alert(1)//").script
        XCTAssertTrue(script.hasPrefix("window.dispatchEvent(new CustomEvent(\"haiyo:open\", { detail: {\"path\":\"\\/chat\\/x\\\"<\\/script>"), script)
        XCTAssertFalse(script.contains("\"</script>"))
    }
}

final class BridgeHandlingTests: XCTestCase {
    private let own = FrameSource(isMainFrame: true, scheme: "https", host: "test.haiyo.org", port: 0)

    private func send(_ body: Any, from source: FrameSource, host: FakeHost) -> (Any?, String?) {
        let bridge = Bridge(config: testConfig, host: host)
        var replies: [(Any?, String?)] = []
        bridge.handle(source: source, body: body) { value, error in replies.append((value, error)) }
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
                let (value, error) = send(body, from: source, host: host)
                XCTAssertNil(value)
                XCTAssertEqual(error, "forbidden")
                XCTAssertFalse(host.touched, "a refused message had an effect: \(source) \(body)")
            }
        }
    }

    func testTheOwnPageIsServed() {
        let host = FakeHost()
        let (hello, helloError) = send(["name": "hello", "args": ["events": ["open"]]], from: own, host: host)
        XCTAssertNil(helloError)
        XCTAssertEqual((hello as? [String: Any])?["events"] as? [String], ["open"])
        XCTAssertEqual(host.hellos, [["open"]])

        let (badge, badgeError) = send(["name": "badge.set", "args": ["n": NSNumber(value: 4)]], from: own, host: host)
        XCTAssertNil(badgeError)
        XCTAssertEqual((badge as? [String: Any])?["ok"] as? Bool, true)
        XCTAssertEqual(host.badges, [4])

        let (push, pushError) = send(["name": "push.register"], from: own, host: host)
        XCTAssertNil(pushError)
        XCTAssertEqual((push as? [String: Any])?["denied"] as? Bool, true)
        XCTAssertEqual(host.pushRegistrations, 1)
    }

    func testInvalidMessagesFromTheOwnPageHaveNoEffect() {
        let host = FakeHost()
        XCTAssertEqual(send(["name": "badge.set", "args": ["n": "9"]], from: own, host: host).1, "malformed")
        XCTAssertEqual(send(["name": "exec"], from: own, host: host).1, "unknown")
        XCTAssertFalse(host.touched)
    }
}
