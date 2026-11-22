import OSLog
import UIKit
import WebKit

/// Downloads (`<a download>`, attachments) go to a fresh temporary folder, then to the share sheet (保存到“文件”,
/// 存储图像, 隔空投送…). The folder is removed when the sheet closes.
final class DownloadCoordinator: NSObject, WKDownloadDelegate {
    weak var presenter: UIViewController?
    private var destinations: [ObjectIdentifier: URL] = [:]

    static let root = FileManager.default.temporaryDirectory.appendingPathComponent("downloads", isDirectory: true)
    private static let log = Logger(subsystem: "org.haiyo.app", category: "downloads")

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
        sheet.completionWithItemsHandler = { activity, completed, _, error in
            Self.log.debug("share sheet closed: activity=\(activity?.rawValue ?? "none", privacy: .public) completed=\(completed) error=\(String(describing: error), privacy: .public)")
            try? FileManager.default.removeItem(at: folder)
        }
        sheet.popoverPresentationController?.sourceView = presenter.view
        Self.log.debug("presenting share sheet from \(String(describing: type(of: presenter)), privacy: .public)")
        presenter.present(sheet, animated: true)
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
