import XCTest
@testable import Haiyo

final class OriginGateTests: XCTestCase {
    private func source(main: Bool = true, scheme: String = "https", host: String = "test.haiyo.org", port: Int = 0) -> FrameSource {
        FrameSource(isMainFrame: main, scheme: scheme, host: host, port: port)
    }

    func testTheMainFrameOfTheOwnOriginIsAllowed() {
        XCTAssertTrue(OriginGate.allows(source(), config: testConfig))
        XCTAssertTrue(OriginGate.allows(source(port: 443), config: testConfig))
        XCTAssertTrue(OriginGate.allows(source(scheme: "HTTPS", host: "Test.Haiyo.ORG"), config: testConfig))
    }

    func testASubFrameIsRefusedEvenOnTheOwnOrigin() {
        XCTAssertFalse(OriginGate.allows(source(main: false), config: testConfig))
    }

    func testAMainFrameThatNavigatedToAnotherOriginIsRefused() {
        for host in ["example.com", "evil.test.haiyo.org", "test.haiyo.org.evil.com", "haiyo.org", "test-haiyo.org", ""] {
            XCTAssertFalse(OriginGate.allows(source(host: host), config: testConfig), host)
        }
    }

    func testOtherSchemesAndPortsAreRefused() {
        XCTAssertFalse(OriginGate.allows(source(scheme: "http"), config: testConfig))
        XCTAssertFalse(OriginGate.allows(source(scheme: "file", host: ""), config: testConfig))
        XCTAssertFalse(OriginGate.allows(source(scheme: "about", host: ""), config: testConfig))
        XCTAssertFalse(OriginGate.allows(source(port: 8443), config: testConfig))
        XCTAssertFalse(OriginGate.allows(source(port: 80), config: testConfig))
    }
}
