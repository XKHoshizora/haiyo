import UIKit
import WebKit

/// Downloads (`<a download>`, attachments) go to a fresh temporary folder, then to the share sheet (保存到“文件”,
/// 存储图像, 隔空投送…). The folder is removed when the sheet closes, and swept at launch.
final class DownloadCoordinator: NSObject, WKDownloadDelegate {
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
        let sheet = UIActivityViewController(activityItems: [file], applicationActivities: nil)
        sheet.completionWithItemsHandler = { [weak sheet] activity, completed, _, error in
            // Never the activity (which app received the file) or the error's description (it can hold the path).
            ShellLog.note("share-sheet", ("completed", .flag(completed)), ("error", .error(error)))
            if Self.sheetIsClosing(activityChosen: activity != nil, completed: completed) {
                try? FileManager.default.removeItem(at: folder)
                return
            }
            // The chosen activity did not complete: cancelled, the sheet stays open; failed (存储图像 without Photos
            // access), the sheet closes. Look again once it has settled.
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak sheet] in
                if Self.sheetIsGone(sheet) { try? FileManager.default.removeItem(at: folder) }
            }
        }
        sheet.popoverPresentationController?.sourceView = presenter.view
        presenter.present(sheet, animated: true)
    }

    /// The share sheet calls back also when a chosen activity is cancelled and the sheet stays open (保存到“文件” →
    /// 取消): the file must stay for the next choice. It is removed when an activity completed or the sheet itself was
    /// dismissed (no activity); anything left over is swept at the next launch.
    static func sheetIsClosing(activityChosen: Bool, completed: Bool) -> Bool {
        completed || !activityChosen
    }

    /// After a chosen activity ended without completing: the sheet is no longer on screen (released, or out of its
    /// window), so nobody can choose again.
    static func sheetIsGone(_ sheet: UIViewController?) -> Bool {
        sheet?.viewIfLoaded?.window == nil
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
