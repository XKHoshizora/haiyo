import XCTest
@testable import Haiyo

final class NavigationPolicyTests: XCTestCase {
    /// How the URL is asked for: a tap in the main frame, script in the main frame, a sub-frame, a new window (tapped
    /// or by script), or a download.
    private enum Kind { case main, mainScript, sub, newWindow, newWindowScript, download }

    private func route(_ string: String, _ kind: Kind) -> NavigationRoute {
        let request = NavigationRequest(
            url: URL(string: string)!,
            isMainFrame: kind != .sub,
            opensNewWindow: kind == .newWindow || kind == .newWindowScript,
            shouldDownload: kind == .download,
            userActivated: kind != .mainScript && kind != .newWindowScript
        )
        return NavigationPolicy.route(request, config: testConfig)
    }

    private func u(_ s: String) -> URL { URL(string: s)! }

    /// The whole table: which URL, asked for how, goes where.
    func testTheTable() {
        let chat = "https://test.haiyo.org/chat/1d6b0b8e-7f0e-4a44-9b44-0a4b3c2d1e0f"
        let rows: [(String, Kind, NavigationRoute)] = [
            // The site's own pages load in place.
            ("https://test.haiyo.org/", .main, .load),
            (chat, .main, .load),
            (chat, .mainScript, .load),
            ("https://TEST.haiyo.org:443/reset-password?token=x", .main, .load),
            ("https://test.haiyo.org/api/files/a", .sub, .load),
            ("about:blank", .sub, .load),
            ("about:srcdoc", .sub, .load),
            // A tapped link to one of the site's files does not replace the app: it opens in the sheet.
            ("https://test.haiyo.org/api/attachments/a1", .main, .sheet(u("https://test.haiyo.org/api/attachments/a1"))),
            ("https://test.haiyo.org/api/attachments/a1", .mainScript, .load),
            // Another site, or the own host on another scheme or port, opens in the Safari view.
            ("https://example.com/page", .main, .safari(u("https://example.com/page"))),
            ("http://test.haiyo.org/", .main, .safari(u("http://test.haiyo.org/"))),
            ("https://test.haiyo.org:8443/", .main, .safari(u("https://test.haiyo.org:8443/"))),
            ("https://evil.test.haiyo.org/", .main, .safari(u("https://evil.test.haiyo.org/"))),
            ("https://test.haiyo.org.evil.com/", .main, .safari(u("https://test.haiyo.org.evil.com/"))),
            // New windows: the site's files in the sheet; the app's own pages in the main view; other sites in Safari.
            ("https://test.haiyo.org/api/attachments/p/%E5%9B%BE.png", .newWindow, .sheet(u("https://test.haiyo.org/api/attachments/p/%E5%9B%BE.png"))),
            (chat, .newWindow, .openInApp(path: "/chat/1d6b0b8e-7f0e-4a44-9b44-0a4b3c2d1e0f")),
            ("https://test.haiyo.org/invite?code=X1#top", .newWindow, .openInApp(path: "/invite?code=X1#top")),
            ("https://test.haiyo.org", .newWindowScript, .openInApp(path: "/")),
            ("https://test.haiyo.org/apiary", .newWindow, .openInApp(path: "/apiary")),
            // The path as written decides what is a file: `%61pi` is not `api` (the service answers it with a 404).
            ("https://test.haiyo.org/%61pi/x", .newWindow, .openInApp(path: "/%61pi/x")),
            ("https://example.com/source", .newWindow, .safari(u("https://example.com/source"))),
            // Downloads: own files, own blobs and data URLs are downloaded; other sites' links open in the Safari view.
            ("https://test.haiyo.org/api/files/f/report.pdf", .download, .download),
            ("blob:https://test.haiyo.org/3c1f6c9e-0000-4000-8000-000000000000", .download, .download),
            ("data:text/plain;base64,aGk=", .download, .download),
            ("https://example.com/file.zip", .download, .safari(u("https://example.com/file.zip"))),
            ("blob:https://example.com/3c1f6c9e-0000-4000-8000-000000000000", .download, .refuse),
            // Mail, phone and SMS go to the system only from a tapped link, never from script.
            ("mailto:support@haiyo.org", .main, .system(u("mailto:support@haiyo.org"))),
            ("tel:+81000000000", .newWindow, .system(u("tel:+81000000000"))),
            ("sms:+81000000000", .sub, .system(u("sms:+81000000000"))),
            ("mailto:support@haiyo.org", .mainScript, .refuse),
            ("tel:+81000000000", .newWindowScript, .refuse),
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

    /// The sheet shows the site's files only. A page of the app — a link inside an attachment, a redirect to the
    /// sign-in page, a frame — never loads there: it opens in the main view, or (in a frame) not at all.
    func testTheSheetNeverShowsAnAppPage() {
        func sheet(_ string: String, main: Bool = true, tapped: Bool = true, newWindow: Bool = false, firstLoad: Bool = false) -> NavigationRoute {
            NavigationPolicy.route(NavigationRequest(url: URL(string: string)!, isMainFrame: main, opensNewWindow: newWindow,
                                                     shouldDownload: false, userActivated: tapped, inSheet: true,
                                                     sheetFirstLoad: firstLoad), config: testConfig)
        }
        let file = "https://test.haiyo.org/api/attachments/a1"
        XCTAssertEqual(sheet(file, tapped: false, firstLoad: true), .load, "the sheet's own file")
        XCTAssertEqual(sheet(file), .sheet(u(file)), "another file, tapped: shown in the sheet")
        XCTAssertEqual(sheet("https://test.haiyo.org/chat/x"), .openInApp(path: "/chat/x"), "a tapped link in a file")
        XCTAssertEqual(sheet("https://test.haiyo.org/login?next=%2Fapi%2Ffiles%2Fa", tapped: false, firstLoad: true),
                       .openInApp(path: "/login?next=%2Fapi%2Ffiles%2Fa"), "the sheet's load redirected to the sign-in page")
        XCTAssertEqual(sheet("https://test.haiyo.org/invite?code=X", tapped: false), .refuse,
                       "after the file is shown, nothing but a tap may steer the main view (a refresh, script)")
        XCTAssertEqual(sheet("https://test.haiyo.org/", newWindow: true), .openInApp(path: "/"))
        XCTAssertEqual(sheet("https://test.haiyo.org/", tapped: false, newWindow: true), .refuse, "window.open by script")
        XCTAssertEqual(sheet("https://test.haiyo.org/chat/x", main: false), .refuse, "an app page in a frame")
        XCTAssertEqual(sheet(file, main: false), .load, "a file in a frame")
        XCTAssertEqual(sheet("about:blank", main: false), .load)
        XCTAssertEqual(sheet("https://example.com/"), .safari(u("https://example.com/")))
    }
}

final class ResponsePolicyTests: XCTestCase {
    private func route(_ url: String, main: Bool = true, status: Int? = 200, renders: Bool = true, disposition: String? = nil) -> ResponseRoute {
        ResponsePolicy.route(
            NavigationResponseInfo(url: URL(string: url)!, isMainFrame: main, statusCode: status, canShowMIMEType: renders, contentDisposition: disposition),
            config: testConfig
        )
    }

    func testTheTable() {
        // A server error on the app's own page shows the cannot-connect screen (I3).
        XCTAssertEqual(route("https://test.haiyo.org/", status: 502), .fail)
        XCTAssertEqual(route("https://test.haiyo.org/chat/x", status: 500), .fail)
        XCTAssertEqual(route("https://test.haiyo.org/", status: 503, renders: false), .fail)
        // Not the main frame, not the own origin, or not a server error: shown as it is.
        XCTAssertEqual(route("https://test.haiyo.org/", main: false, status: 502), .allow)
        XCTAssertEqual(route("https://example.com/", status: 502), .allow)
        XCTAssertEqual(route("https://test.haiyo.org/", status: 404), .allow)
        XCTAssertEqual(route("https://test.haiyo.org/", status: nil), .allow)
        // Attachments are downloaded even when WebKit could render them (M12); what it cannot render is downloaded.
        XCTAssertEqual(route("https://test.haiyo.org/api/attachments/a", disposition: "attachment; filename=\"a.pdf\""), .download)
        XCTAssertEqual(route("https://test.haiyo.org/api/attachments/a", disposition: " Attachment"), .download)
        XCTAssertEqual(route("https://test.haiyo.org/api/attachments/a", disposition: "inline; filename=\"a.png\""), .allow)
        XCTAssertEqual(route("https://test.haiyo.org/api/attachments/a.zip", renders: false), .download)
    }
}
