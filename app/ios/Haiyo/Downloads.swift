import UIKit
import WebKit

/// Downloads (`<a download>`, attachments) go to a fresh temporary folder, then to the share sheet (保存到“文件”,
/// 存储图像, 隔空投送…). The folder is removed once the sheet is gone and no activity still uses the file
/// (`ShareCleanup`), and swept at launch.
final class DownloadCoordinator: NSObject, WKDownloadDelegate, UIPopoverPresentationControllerDelegate {
    weak var presenter: UIViewController?
    private var destinations: [ObjectIdentifier: URL] = [:]

    static let root = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)

    func start(_ download: WKDownload) {
        download.delegate = self
    }

    func download(
        _ download: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
    ) {
        let folder = Self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            MainActor.assumeIsolated { completionHandler(nil) }
            return
        }
        let destination = folder.appendingPathComponent(DownloadName.safe(suggestedFilename))
        destinations[ObjectIdentifier(download)] = destination
        MainActor.assumeIsolated { completionHandler(destination) }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let file = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
        share(file)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        if let file = destinations.removeValue(forKey: ObjectIdentifier(download)) {
            try? FileManager.default.removeItem(at: file.deletingLastPathComponent())
        }
        guard let presenter = presenter?.topmost else { return }
        let alert = UIAlertController(title: "下载失败", message: "请稍后重试。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "好", style: .default))
        presenter.present(alert, animated: true)
    }

    private func share(_ file: URL) {
        let folder = file.deletingLastPathComponent()
        guard let presenter = presenter?.topmost else {
            try? FileManager.default.removeItem(at: folder)
            return
        }
        var cleanup = ShareCleanup()
        let remove = { try? FileManager.default.removeItem(at: folder) }
        let item = SharedFile(url: file)
        item.onRequested = { cleanup.activityStarted() }
        let sheet = ShareSheet(activityItems: [item], applicationActivities: nil)
        sheet.completionWithItemsHandler = { _, completed, _, error in
            // Never the activity (which app received the file) or the error's description (it can hold the path).
            ShellLog.note("share-sheet", ("completed", .flag(completed)), ("error", .error(error)))
            if cleanup.activityEnded() { remove() }
        }
        sheet.onGone = {
            if cleanup.sheetGone() { remove() }
        }
        // iPad: a popover needs an anchor. Where the link was is not known here, so the middle of the view, no arrow.
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = Self.centre(of: presenter.view.bounds)
            popover.permittedArrowDirections = []
            popover.delegate = self
        }
        presenter.present(sheet, animated: true)
    }

    #if DEBUG
    /// `-HaiyoDebugShare`: the share sheet with a small text file, as after a download (no sign-in needed).
    func shareForDebug() {
        let folder = Self.root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        let file = folder.appendingPathComponent("probe.txt")
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try Data("Haiyo share probe\n".utf8).write(to: file)
        } catch {
            return
        }
        share(file)
    }
    #endif

    /// The window was resized or rotated under the popover: keep it in the middle.
    func popoverPresentationController(
        _ popoverPresentationController: UIPopoverPresentationController,
        willRepositionPopoverTo rect: UnsafeMutablePointer<CGRect>,
        in view: AutoreleasingUnsafeMutablePointer<UIView>
    ) {
        rect.pointee = Self.centre(of: view.pointee.bounds)
    }

    static func centre(of bounds: CGRect) -> CGRect {
        CGRect(x: bounds.midX, y: bounds.midY, width: 0, height: 0)
    }
}

/// When a shared file may be removed: once the sheet is gone for good and no activity still uses the file — whichever
/// of the two comes last, never on a timer. An activity starts when the sheet asks for the file (`SharedFile`) and
/// ends with the sheet's completion callback; that callback also comes when a chosen activity is cancelled and the
/// sheet stays (保存到“文件” → 取消), and an activity can still be running after the sheet has closed (存储图像).
/// Anything left over (a callback that never came) is swept at the next launch.
struct ShareCleanup {
    private(set) var activityRunning = false
    private(set) var isSheetGone = false
    private(set) var removed = false

    mutating func activityStarted() {
        activityRunning = true
    }

    /// Returns true when the file should be removed now.
    mutating func activityEnded() -> Bool {
        activityRunning = false
        return removeIfDone()
    }

    /// Returns true when the file should be removed now.
    mutating func sheetGone() -> Bool {
        isSheetGone = true
        return removeIfDone()
    }

    private mutating func removeIfDone() -> Bool {
        guard isSheetGone, !activityRunning, !removed else { return false }
        removed = true
        return true
    }
}

/// The downloaded file as the share sheet's item: it tells when an activity asks for it.
final class SharedFile: NSObject, UIActivityItemSource {
    let url: URL
    var onRequested: (() -> Void)?

    init(url: URL) {
        self.url = url
    }

    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        url
    }

    func activityViewController(_ activityViewController: UIActivityViewController, itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        if Thread.isMainThread {
            onRequested?()
        } else {
            // Never block here on the main thread (it may be waiting for this item).
            let onRequested = onRequested
            DispatchQueue.main.async { onRequested?() }
        }
        return url
    }
}

/// The share sheet; it says when it has left the screen for good (dismissed, not covered by an activity's own view).
final class ShareSheet: UIActivityViewController {
    var onGone: (() -> Void)?

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        guard isBeingDismissed || presentingViewController == nil else { return }
        onGone?()
        onGone = nil
    }
}

extension UIViewController {
    /// The view controller currently on top (a sheet over the shell, or the shell itself).
    var topmost: UIViewController {
        var top = self
        while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
        return top
    }
}
