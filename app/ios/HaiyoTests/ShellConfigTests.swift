import XCTest
@testable import Haiyo

final class ShellConfigTests: XCTestCase {
    func testTheBuiltAppPointsAtTheAcceptanceSite() {
        // Unit tests run in the Debug build of the app: its Info.plist carries the build configuration's host.
        let config = ShellConfig.parse(info: Bundle.main.infoDictionary ?? [:])
        XCTAssertEqual(config?.host, "test.haiyo.org")
        XCTAssertEqual(config?.origin.absoluteString, "https://test.haiyo.org")
        XCTAssertEqual(config?.apnsEnvironment, "development")
        XCTAssertEqual(Bundle.main.bundleIdentifier, "org.haiyo.app")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String, "Haiyo")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "ITSAppUsesNonExemptEncryption") as? Bool, false)
        for key in ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryAddUsageDescription"] {
            XCTAssertFalse((Bundle.main.object(forInfoDictionaryKey: key) as? String ?? "").isEmpty, key)
        }
        XCTAssertNotNil(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
    }

    func testOnlyBareHostNamesAreAccepted() {
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "Test.Haiyo.org"])?.host, "test.haiyo.org")
        for bad in ["", "https://test.haiyo.org", "test.haiyo.org/", "test.haiyo.org:443", " test.haiyo.org", "localhost",
                    "test..haiyo.org", ".haiyo.org", "haiyo.org.", "-x.org", "测试.org", "a b.org"] {
            XCTAssertNil(ShellConfig.parse(info: ["HaiyoHost": bad]), bad)
        }
        XCTAssertNil(ShellConfig.parse(info: [:]))
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "x.org", "HaiyoApnsEnvironment": "production"])?.apnsEnvironment, "production")
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "x.org", "HaiyoApnsEnvironment": "other"])?.apnsEnvironment, "development")
    }

    func testSitePaths() {
        XCTAssertEqual(testConfig.url(forPath: "/")?.absoluteString, "https://test.haiyo.org/")
        XCTAssertEqual(testConfig.url(forPath: "/chat/abc?x=1#y")?.absoluteString, "https://test.haiyo.org/chat/abc?x=1#y")
        for bad in ["", "chat", "//evil.com/x", "/\\evil.com", "https://evil.com/", "/a b", "/a\nb"] {
            XCTAssertNil(testConfig.url(forPath: bad), bad)
        }
    }

    func testOwnOriginAndBlobs() {
        XCTAssertTrue(testConfig.isOwnOrigin(URL(string: "https://test.haiyo.org/x")!))
        XCTAssertFalse(testConfig.isOwnOrigin(URL(string: "https://user@test.haiyo.org/x")!))
        XCTAssertTrue(testConfig.isOwnBlob(URL(string: "blob:https://test.haiyo.org/1234")!))
        XCTAssertFalse(testConfig.isOwnBlob(URL(string: "blob:https://example.com/1234")!))
        XCTAssertFalse(testConfig.isOwnBlob(URL(string: "https://test.haiyo.org/1234")!))
    }

    func testTheUserAgentMarkIsAppended() {
        XCTAssertEqual(testConfig.applicationName(appendingTo: "Mobile/15E148"), "Mobile/15E148 HaiyoApp/0.1.0")
        XCTAssertEqual(testConfig.applicationName(appendingTo: nil), "HaiyoApp/0.1.0")
        XCTAssertEqual(testConfig.applicationName(appendingTo: ""), "HaiyoApp/0.1.0")
    }
}

final class LinksAndFailuresTests: XCTestCase {
    func testUniversalLinks() {
        XCTAssertEqual(LaunchLinks.path(forUniversalLink: URL(string: "https://test.haiyo.org/chat/a?b=1")!, config: testConfig), "/chat/a?b=1")
        XCTAssertEqual(LaunchLinks.path(forUniversalLink: URL(string: "https://test.haiyo.org")!, config: testConfig), "/")
        XCTAssertNil(LaunchLinks.path(forUniversalLink: URL(string: "https://example.com/chat/a")!, config: testConfig))
        XCTAssertNil(LaunchLinks.path(forUniversalLink: URL(string: "http://test.haiyo.org/chat/a")!, config: testConfig))
    }

    func testNotificationPaths() {
        let id = "1D6B0B8E-7F0E-4A44-9B44-0A4B3C2D1E0F"
        XCTAssertEqual(LaunchLinks.path(forNotification: ["c": id]), "/chat/1d6b0b8e-7f0e-4a44-9b44-0a4b3c2d1e0f")
        XCTAssertNil(LaunchLinks.path(forNotification: ["c": "../settings"]))
        XCTAssertNil(LaunchLinks.path(forNotification: ["c": 5]))
        XCTAssertNil(LaunchLinks.path(forNotification: [:]))
    }

    func testLoadFailures() {
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet), .offline)
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorNetworkConnectionLost), .offline)
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorDataNotAllowed), .offline)
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorTimedOut), .unreachable)
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorCannotFindHost), .unreachable)
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorCannotConnectToHost), .unreachable)
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorSecureConnectionFailed), .unreachable)
        XCTAssertEqual(LoadFailure.classify(domain: NSURLErrorDomain, code: NSURLErrorCancelled), .ignore)
        XCTAssertEqual(LoadFailure.classify(domain: "WebKitErrorDomain", code: 102), .ignore)
        XCTAssertEqual(LoadFailure.classify(domain: "kCFErrorDomainCFNetwork", code: 310), .unreachable)
    }

    func testDownloadNames() {
        XCTAssertEqual(DownloadName.safe("报告.pdf"), "报告.pdf")
        XCTAssertEqual(DownloadName.safe("../../etc/passwd"), "_.._etc_passwd")
        XCTAssertEqual(DownloadName.safe(".hidden"), "hidden")
        XCTAssertEqual(DownloadName.safe("a:b\u{0}c.txt"), "a_bc.txt")
        XCTAssertEqual(DownloadName.safe("   "), "download")
        let long = String(repeating: "长", count: 300) + ".png"
        XCTAssertEqual(DownloadName.safe(long).count, 200)
        XCTAssertTrue(DownloadName.safe(long).hasSuffix(".png"))
    }
}
