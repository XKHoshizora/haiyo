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
    /// I4: the shared file goes once the sheet is gone and no activity uses it — in whichever order the two come,
    /// with no timer.
    func testTheSharedFileStaysWhileTheSheetOrAnActivityStillNeedsIt() {
        // Dismissed without choosing anything.
        var plain = ShareCleanup()
        XCTAssertFalse(plain.activityEnded(), "the callback can come while the sheet is still closing")
        XCTAssertTrue(plain.sheetGone())

        // 保存到“文件” → 取消: back on the sheet, the file stays for the next choice; then the sheet is closed.
        var cancelled = ShareCleanup()
        cancelled.activityStarted()
        XCTAssertFalse(cancelled.activityEnded(), "the sheet is still open")
        XCTAssertTrue(cancelled.sheetGone())

        // 存储图像: the sheet closes as soon as it is chosen, the save ends later.
        var saving = ShareCleanup()
        saving.activityStarted()
        XCTAssertFalse(saving.sheetGone(), "the activity still reads the file")
        XCTAssertTrue(saving.activityEnded())

        // A failed activity (存储图像 without Photos access): the callback first, then the sheet closes.
        var failed = ShareCleanup()
        failed.activityStarted()
        XCTAssertFalse(failed.activityEnded())
        XCTAssertTrue(failed.sheetGone())

        // A cancel, then another activity that outlives the sheet: the earlier callback does not count.
        var second = ShareCleanup()
        second.activityStarted()
        XCTAssertFalse(second.activityEnded())
        second.activityStarted()
        XCTAssertFalse(second.sheetGone(), "the second activity is still running")
        XCTAssertTrue(second.activityEnded())
        XCTAssertFalse(second.activityEnded(), "removed once")
    }

    /// The share sheet's item tells when an activity asks for the file.
    @MainActor
    func testTheSharedItemReportsWhenAnActivityAsksForTheFile() {
        let file = URL(fileURLWithPath: "/tmp/x.png")
        let item = SharedFile(url: file)
        var asked = 0
        item.onRequested = { asked += 1 }
        let sheet = UIActivityViewController(activityItems: [], applicationActivities: nil)
        XCTAssertEqual(item.activityViewControllerPlaceholderItem(sheet) as? URL, file)
        XCTAssertEqual(asked, 0, "the placeholder is not a use of the file")
        XCTAssertEqual(item.activityViewController(sheet, itemForActivityType: .copyToPasteboard) as? URL, file)
        XCTAssertEqual(asked, 1)
    }

    /// iPad: the share popover sits in the middle of the view, with no arrow.
    func testTheSharePopoverIsAnchoredInTheMiddle() {
        XCTAssertEqual(DownloadCoordinator.centre(of: CGRect(x: 0, y: 0, width: 402, height: 675)),
                       CGRect(x: 201, y: 337.5, width: 0, height: 0))
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
