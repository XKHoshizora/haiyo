import XCTest
@testable import Haiyo

final class NavigationPolicyTests: XCTestCase {
    private enum Kind { case main, sub, newWindow, download }

    private func route(_ string: String, _ kind: Kind) -> NavigationRoute {
        let request = NavigationRequest(
            url: URL(string: string)!,
            isMainFrame: kind != .sub,
            opensNewWindow: kind == .newWindow,
            shouldDownload: kind == .download
        )
        return NavigationPolicy.route(request, config: testConfig)
    }

    private func u(_ s: String) -> URL { URL(string: s)! }

    /// The whole table: which URL, asked for how, goes where.
    func testTheTable() {
        let rows: [(String, Kind, NavigationRoute)] = [
            // The site's own pages load in place.
            ("https://test.haiyo.org/", .main, .load),
            ("https://test.haiyo.org/chat/1d6b0b8e-7f0e-4a44-9b44-0a4b3c2d1e0f", .main, .load),
            ("https://TEST.haiyo.org:443/reset-password?token=x", .main, .load),
            ("https://test.haiyo.org/api/files/a", .sub, .load),
            ("about:blank", .sub, .load),
            ("about:srcdoc", .sub, .load),
            // Another site, or the own host on another scheme or port, opens in the Safari view.
            ("https://example.com/page", .main, .safari(u("https://example.com/page"))),
            ("http://test.haiyo.org/", .main, .safari(u("http://test.haiyo.org/"))),
            ("https://test.haiyo.org:8443/", .main, .safari(u("https://test.haiyo.org:8443/"))),
            ("https://evil.test.haiyo.org/", .main, .safari(u("https://evil.test.haiyo.org/"))),
            ("https://test.haiyo.org.evil.com/", .main, .safari(u("https://test.haiyo.org.evil.com/"))),
            // New windows: the own origin in the sheet, other sites in the Safari view.
            ("https://test.haiyo.org/api/files/p/%E5%9B%BE.png", .newWindow, .sheet(u("https://test.haiyo.org/api/files/p/%E5%9B%BE.png"))),
            ("https://example.com/source", .newWindow, .safari(u("https://example.com/source"))),
            // Downloads: own files, own blobs and data URLs are downloaded; other sites' links open in the Safari view.
            ("https://test.haiyo.org/api/files/f/report.pdf", .download, .download),
            ("blob:https://test.haiyo.org/3c1f6c9e-0000-4000-8000-000000000000", .download, .download),
            ("data:text/plain;base64,aGk=", .download, .download),
            ("https://example.com/file.zip", .download, .safari(u("https://example.com/file.zip"))),
            ("blob:https://example.com/3c1f6c9e-0000-4000-8000-000000000000", .download, .refuse),
            // Mail, phone and SMS go to the system, from any frame.
            ("mailto:support@haiyo.org", .main, .system(u("mailto:support@haiyo.org"))),
            ("tel:+81000000000", .newWindow, .system(u("tel:+81000000000"))),
            ("sms:+81000000000", .sub, .system(u("sms:+81000000000"))),
            // Everything else is refused.
            ("javascript:alert(1)", .main, .refuse),
            ("file:///etc/hosts", .main, .refuse),
            ("data:text/html,<p>x</p>", .main, .refuse),
            ("blob:https://test.haiyo.org/3c1f6c9e-0000-4000-8000-000000000000", .main, .refuse),
            ("itms-apps://apps.apple.com/app/id1", .main, .refuse),
            ("https://example.com/frame", .sub, .refuse),
            ("ftp://example.com/x", .newWindow, .refuse),
        ]
        for (url, kind, expected) in rows {
            XCTAssertEqual(route(url, kind), expected, "\(url) as \(kind)")
        }
    }
}
