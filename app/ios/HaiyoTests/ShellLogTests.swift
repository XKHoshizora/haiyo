import UIKit
import XCTest
@testable import Haiyo

/// The logging rule (C2, I6): nothing private reaches the log. These are the only values a log line can carry.
final class ShellLogTests: XCTestCase {
    func testRoutesKeepOnlyRouteWords() {
        XCTAssertEqual(ShellLog.routeShape("/chat/1d6b0b8e-7f0e-4a44-9b44-0a4b3c2d1e0f"), "/chat/:id")
        XCTAssertEqual(ShellLog.routeShape("/chat/1d6b0b8e-7f0e-4a44-9b44-0a4b3c2d1e0f/info?x=1#y"), "/chat/:id/info")
        XCTAssertEqual(ShellLog.routeShape("/api/attachments/42/体检报告-张三.pdf"), "/api/attachments/:id/:id")
        XCTAssertEqual(ShellLog.routeShape("/reset-password?token=secret"), "/reset-password")
        XCTAssertEqual(ShellLog.routeShape("/u/alice"), "/:id/:id")
        XCTAssertEqual(ShellLog.routeShape(""), "/")
        XCTAssertEqual(ShellLog.routeShape("/"), "/")
    }

    func testErrorsAreOnlyDomainAndCode() {
        let path = "/private/var/mobile/tmp/downloads/ABC/体检报告-张三.pdf"
        let error = NSError(domain: NSCocoaErrorDomain, code: 4, userInfo: [
            NSFilePathErrorKey: path,
            NSURLErrorKey: URL(fileURLWithPath: path),
            NSLocalizedDescriptionKey: "“体检报告-张三.pdf” couldn’t be moved",
        ])
        let line = ShellLog.line("share-sheet", [("completed", .flag(false)), ("error", .error(error))])
        XCTAssertEqual(line, "share-sheet completed=no error=NSCocoaErrorDomain/4")
        XCTAssertFalse(line.contains("体检报告"))
        XCTAssertFalse(line.contains("/private"))
        XCTAssertEqual(ShellLog.errorSummary(nil), "none")
    }

    func testFieldsRender() {
        XCTAssertEqual(ShellLog.line("history", [("route", .route("/chat/abc")), ("back", .count(2)), ("canGoBack", .flag(true))]),
                       "history route=/chat/:id back=2 canGoBack=yes")
    }
}

final class LifecycleRulesTests: XCTestCase {
    /// I4: a cancelled activity leaves the share sheet open, so the file stays; it goes when the sheet closes.
    func testTheDownloadedFileStaysWhileTheShareSheetIsOpen() {
        XCTAssertFalse(DownloadCoordinator.sheetIsClosing(activityChosen: true, completed: false))
        XCTAssertTrue(DownloadCoordinator.sheetIsClosing(activityChosen: true, completed: true))
        XCTAssertTrue(DownloadCoordinator.sheetIsClosing(activityChosen: false, completed: false))
    }

    /// A chosen activity that failed (存储图像 without Photos access) closes the sheet: then the file goes too.
    @MainActor
    func testTheFileGoesWhenTheSheetIsNoLongerOnScreen() {
        XCTAssertTrue(DownloadCoordinator.sheetIsGone(nil), "released")
        XCTAssertTrue(DownloadCoordinator.sheetIsGone(UIViewController()), "not in a window")
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 100, height: 100))
        let shown = UIViewController()
        window.rootViewController = shown
        window.isHidden = false
        XCTAssertFalse(DownloadCoordinator.sheetIsGone(shown), "still on screen")
        window.isHidden = true
    }

    /// I2: at most two reloads after a crash within a minute; the third ends on the cannot-connect screen.
    func testCrashReloadsAreBounded() {
        var budget = CrashReloadBudget()
        let t0 = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(budget.allow(at: t0))
        XCTAssertTrue(budget.allow(at: t0.addingTimeInterval(10)))
        XCTAssertFalse(budget.allow(at: t0.addingTimeInterval(20)))
        XCTAssertTrue(budget.allow(at: t0.addingTimeInterval(75)), "the window moves on")
    }
}
