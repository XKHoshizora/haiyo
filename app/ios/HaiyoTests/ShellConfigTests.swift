import XCTest
@testable import Haiyo

final class ShellConfigTests: XCTestCase {
    func testTheBuiltAppPointsAtTheAcceptanceSite() {
        // Unit tests run in the Debug build of the app: its Info.plist carries the build configuration's host.
        let config = ShellConfig.parse(info: Bundle.main.infoDictionary ?? [:])
        XCTAssertEqual(config?.host, "test.haiyo.org")
        XCTAssertEqual(config?.origin.absoluteString, "https://test.haiyo.org")
        XCTAssertEqual(config?.apnsEnvironment, "development")
        XCTAssertEqual(config?.channel, "acceptance")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String, "0.1.0")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String, "2")
        XCTAssertEqual(Bundle.main.bundleIdentifier, "org.haiyo.app")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String, "Haiyo")
        XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "ITSAppUsesNonExemptEncryption") as? Bool, false)
        for key in ["NSCameraUsageDescription", "NSMicrophoneUsageDescription", "NSPhotoLibraryAddUsageDescription"] {
            XCTAssertFalse((Bundle.main.object(forInfoDictionaryKey: key) as? String ?? "").isEmpty, key)
        }
        XCTAssertNotNil(Bundle.main.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
    }

    /// iPhone and iPad; on iPad every orientation and a resizable window; the iPhone stays portrait for now. Read from
    /// the built Info.plist as written (UIKit merges the `~ipad` keys on an iPad).
    func testTheAppRunsOnIPhoneAndOnIPadInAnyOrientation() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "Info", withExtension: "plist"))
        let info = try XCTUnwrap(PropertyListSerialization.propertyList(from: Data(contentsOf: url), format: nil) as? [String: Any])
        XCTAssertEqual(info["UIDeviceFamily"] as? [Int], [1, 2])
        XCTAssertEqual(Set(info["UISupportedInterfaceOrientations~ipad"] as? [String] ?? []), [
            "UIInterfaceOrientationPortrait", "UIInterfaceOrientationPortraitUpsideDown",
            "UIInterfaceOrientationLandscapeLeft", "UIInterfaceOrientationLandscapeRight",
        ])
        XCTAssertEqual(info["UISupportedInterfaceOrientations"] as? [String], ["UIInterfaceOrientationPortrait"])
        XCTAssertNil(info["UIRequiresFullScreen"], "deprecated; a full-screen-only iPad app is not what we ship")
        XCTAssertNotNil(info["UILaunchScreen"])
    }

    func testOnlyBareHostNamesAreAccepted() {
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "Test.Haiyo.org"])?.host, "test.haiyo.org")
        // The same rule as the "Check origin" build phase (M6): `_`, non-ASCII, single labels and edge hyphens fail too.
        for bad in ["", "https://test.haiyo.org", "test.haiyo.org/", "test.haiyo.org:443", " test.haiyo.org", "localhost",
                    "test..haiyo.org", ".haiyo.org", "haiyo.org.", "-x.org", "x-.org", "测试.org", "a b.org", "a_b.org",
                    String(repeating: "a", count: 64) + ".org"] {
            XCTAssertNil(ShellConfig.parse(info: ["HaiyoHost": bad]), bad)
        }
        XCTAssertNil(ShellConfig.parse(info: [:]))
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "x.org", "HaiyoApnsEnvironment": "production"])?.apnsEnvironment, "production")
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "x.org", "HaiyoApnsEnvironment": "other"])?.apnsEnvironment, "development")
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "x.org", "HaiyoChannel": "store"])?.channel, "store")
        XCTAssertEqual(ShellConfig.parse(info: ["HaiyoHost": "x.org"])?.channel, "acceptance")
        for good in ["test.haiyo.org", "haiyo.org", "a-b.c-d.example", "x1.y2"] {
            XCTAssertNotNil(ShellConfig.parse(info: ["HaiyoHost": good]), good)
        }
    }

    func testFilesAndSitePathsOfURLs() {
        XCTAssertTrue(testConfig.isOwnFile(URL(string: "https://test.haiyo.org/api/attachments/a")!))
        XCTAssertFalse(testConfig.isOwnFile(URL(string: "https://test.haiyo.org/apiary")!))
        XCTAssertFalse(testConfig.isOwnFile(URL(string: "https://example.com/api/attachments/a")!))
        XCTAssertEqual(testConfig.sitePath(of: URL(string: "https://test.haiyo.org/chat/a?b=1#c")!), "/chat/a?b=1#c")
        XCTAssertEqual(testConfig.sitePath(of: URL(string: "https://test.haiyo.org")!), "/")
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
        // APFS counts bytes: 200 CJK characters are 600 bytes of UTF-8 (review item 8).
        let long = String(repeating: "长", count: 200) + ".pdf"
        let safe = DownloadName.safe(long)
        XCTAssertLessThanOrEqual(safe.utf8.count, DownloadName.maxBytes)
        XCTAssertTrue(safe.hasSuffix(".pdf"))
        XCTAssertTrue(safe.hasPrefix("长长长"))
        let noExtension = String(repeating: "😀", count: 100)
        XCTAssertLessThanOrEqual(DownloadName.safe(noExtension).utf8.count, DownloadName.maxBytes)
        XCTAssertTrue(DownloadName.safe(noExtension).allSatisfy { $0 == "😀" }, "never cut inside a character")
    }

    /// Review item 8 on a real file system. APFS itself takes the 604-byte name (it counts characters, not bytes); the
    /// byte cap is for where a saved file goes next. The shortened name must be writable.
    func testALongChineseNameCanBeWritten() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let long = String(repeating: "长", count: 200) + ".pdf"
        let safe = folder.appendingPathComponent(DownloadName.safe(long))
        XCTAssertNoThrow(try Data("x".utf8).write(to: safe))
        XCTAssertTrue(FileManager.default.fileExists(atPath: safe.path))
    }
}
