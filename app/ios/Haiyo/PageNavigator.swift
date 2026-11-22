import SafariServices
import UIKit
import WebKit

/// Navigation and window handling shared by the shell's web view and the sheet's: every URL goes through
/// `NavigationPolicy`, every response through `ResponsePolicy`, downloads go to the share sheet, other sites open in
/// the in-app Safari view, app pages asked for in a new window open in the main view.
final class PageNavigator: NSObject, WKNavigationDelegate, WKUIDelegate {
    enum Role { case shell, sheet }

    let config: ShellConfig
    let role: Role
    let downloads = DownloadCoordinator()
    weak var presenter: UIViewController? {
        didSet { downloads.presenter = presenter }
    }

    var onFinish: (() -> Void)?
    var onFailure: ((LoadFailure, URL?) -> Void)?
    var onCommit: (() -> Void)?
    /// An app page to open in the main view (the shell's `open(path:)`).
    var onOpenPath: ((String) -> Void)?
    /// The page's content process died (the shell decides when to reload).
    var onContentProcessTerminated: (() -> Void)?

    init(config: ShellConfig, role: Role) {
        self.config = config
        self.role = role
    }

    // MARK: Policy

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            MainActor.assumeIsolated { decisionHandler(.cancel) }
            return
        }
        let request = NavigationRequest(
            url: url,
            isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
            opensNewWindow: navigationAction.targetFrame == nil,
            shouldDownload: navigationAction.shouldPerformDownload,
            userActivated: navigationAction.navigationType == .linkActivated
        )
        let policy = perform(NavigationPolicy.route(request, config: config), in: webView)
        MainActor.assumeIsolated { decisionHandler(policy) }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
    ) {
        let http = navigationResponse.response as? HTTPURLResponse
        let info = NavigationResponseInfo(
            url: navigationResponse.response.url ?? URL(string: "about:blank")!,
            isMainFrame: navigationResponse.isForMainFrame,
            statusCode: http?.statusCode,
            canShowMIMEType: navigationResponse.canShowMIMEType,
            contentDisposition: http?.value(forHTTPHeaderField: "Content-Disposition")
        )
        let policy: WKNavigationResponsePolicy
        switch ResponsePolicy.route(info, config: config) {
        case .allow:
            policy = .allow
        case .download:
            policy = .download
        case .fail:
            ShellLog.note("main-document-failed", ("status", .count(info.statusCode ?? 0)))
            policy = .cancel
            onFailure?(.unreachable, info.url)
        }
        MainActor.assumeIsolated { decisionHandler(policy) }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        downloads.start(download)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        downloads.start(download)
    }

    /// `window.open` from script (a link with `target=_blank` arrives as a navigation action without a target frame).
    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            let request = NavigationRequest(
                url: url,
                isMainFrame: false,
                opensNewWindow: true,
                shouldDownload: false,
                userActivated: navigationAction.navigationType == .linkActivated
            )
            _ = perform(NavigationPolicy.route(request, config: config), in: webView)
        }
        return nil
    }

    /// Carries out a route; returns what WebKit should do with the original navigation.
    private func perform(_ route: NavigationRoute, in webView: WKWebView) -> WKNavigationActionPolicy {
        switch route {
        case .load:
            return .allow
        case .download:
            return .download
        case let .sheet(url):
            if role == .sheet {
                webView.load(URLRequest(url: url))
            } else if let presenter {
                SheetViewController.present(url: url, config: config, from: presenter.topmost, onOpenPath: onOpenPath)
            }
            return .cancel
        case let .openInApp(path):
            if role == .sheet {
                let open = onOpenPath
                presenter?.dismiss(animated: true) { open?(path) }
            } else {
                onOpenPath?(path)
            }
            return .cancel
        case let .safari(url):
            if let presenter {
                let safari = SFSafariViewController(url: url)
                safari.dismissButtonStyle = .close
                presenter.topmost.present(safari, animated: true)
            }
            return .cancel
        case let .system(url):
            UIApplication.shared.open(url)
            return .cancel
        case .refuse:
            return .cancel
        }
    }

    // MARK: Long-press menu

    /// WebKit's own menu for a long-pressed link previews it in a separate web view without the session (an app page
    /// shows the sign-in page), and its 打开链接 commits that preview into Safari, past `NavigationPolicy`. Without a
    /// preview, WebKit's 打开 is a click on the link and goes through the policy like a tap; the other actions
    /// (拷贝链接, 共享…) stay as WebKit suggests them.
    func webView(
        _ webView: WKWebView,
        contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo,
        completionHandler: @escaping @MainActor @Sendable (UIContextMenuConfiguration?) -> Void
    ) {
        let configuration = UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { suggested in
            UIMenu(children: suggested)
        }
        MainActor.assumeIsolated { completionHandler(configuration) }
    }

    // MARK: Progress

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        onCommit?()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        onFinish?()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        report(error)
    }

    private func report(_ error: Error) {
        let failure = LoadFailure.classify(error)
        guard failure != .ignore else { return }
        ShellLog.note("load-failed", ("error", .error(error)))
        let url = (error as NSError).userInfo[NSURLErrorFailingURLErrorKey] as? URL
        onFailure?(failure, url)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if let onContentProcessTerminated {
            onContentProcessTerminated()
        } else if webView.url != nil {
            webView.reload()
        }
    }
}
