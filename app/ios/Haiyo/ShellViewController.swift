import Network
import OSLog
import UIKit
import WebKit

/// The whole app: one full-screen web view on the shell's origin, the bridge, a cover until the first page has
/// painted, and the cannot-connect screen.
final class ShellViewController: UIViewController, BridgeHost {
    let config: ShellConfig
    private let initialPath: String
    private let navigator: PageNavigator
    private var bridge: Bridge?
    private(set) var webView: WKWebView!
    private let cover = UIView()
    private let offline = OfflineView()
    /// Events the page said it handles (`hello`); `open` falls back to loading the URL when the page does not.
    private var pageEvents: Set<String> = []
    private var retryURL: URL?
    #if DEBUG
    private var debugObservations: [NSKeyValueObservation] = []
    #endif

    init(config: ShellConfig, initialPath: String) {
        self.config = config
        self.initialPath = initialPath
        self.navigator = PageNavigator(config: config, role: .shell)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override var preferredStatusBarStyle: UIStatusBarStyle { .darkContent }

    override func loadView() {
        let background = UIColor(named: "LaunchBackground") ?? .systemBackground
        let root = UIView()
        root.backgroundColor = background

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = config.applicationName(appendingTo: configuration.applicationNameForUserAgent)
        configuration.allowsInlineMediaPlayback = true
        let bridge = Bridge(config: config, host: self)
        configuration.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: Bridge.handlerName)
        self.bridge = bridge

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = navigator
        webView.uiDelegate = navigator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.isOpaque = false
        webView.backgroundColor = background
        #if DEBUG
        webView.isInspectable = true
        #endif
        self.webView = webView

        cover.backgroundColor = background
        offline.isHidden = true
        offline.onRetry = { [weak self] in self?.retry() }

        for v in [webView, cover, offline] as [UIView] {
            v.translatesAutoresizingMaskIntoConstraints = false
            root.addSubview(v)
            NSLayoutConstraint.activate([
                v.topAnchor.constraint(equalTo: root.topAnchor),
                v.bottomAnchor.constraint(equalTo: root.bottomAnchor),
                v.leadingAnchor.constraint(equalTo: root.leadingAnchor),
                v.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            ])
        }
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigator.presenter = self
        navigator.onCommit = { [weak self] in self?.pageEvents = [] }
        navigator.onFinish = { [weak self] in self?.pageShown() }
        navigator.onFailure = { [weak self] failure, url in self?.showFailure(failure, url: url) }
        #if DEBUG
        DebugHooks.applyBeforeFirstLoad(to: webView)
        debugObservations = DebugHooks.observeHistory(of: webView)
        #endif
        load(config.url(forPath: initialPath) ?? config.origin)
    }

    // MARK: Loading

    private func load(_ url: URL) {
        retryURL = url
        webView.load(URLRequest(url: url))
    }

    private func pageShown() {
        #if DEBUG
        DebugHooks.addProbeLinks(to: webView)
        #endif
        offline.isHidden = true
        guard !cover.isHidden else { return }
        // env(safe-area-inset-*) can arrive a moment after load in WKWebView: keep the cover a little longer.
        UIView.animate(withDuration: 0.2, delay: 0.15, options: [.beginFromCurrentState]) {
            self.cover.alpha = 0
        } completion: { _ in
            self.cover.isHidden = true
        }
    }

    private func showFailure(_ failure: LoadFailure, url: URL?) {
        // Once the page is up, a dropped network is the page's own business (it reconnects and shows its status).
        if let current = webView.url, config.isOwnOrigin(current), cover.isHidden, offline.isHidden, webView.isLoading == false {
            return
        }
        if let url, config.isOwnOrigin(url) { retryURL = url }
        offline.show(failure)
        offline.isHidden = false
        UIAccessibility.post(notification: .screenChanged, argument: offline)
    }

    private func retry() {
        #if DEBUG
        DebugHooks.clear(from: webView)
        #endif
        offline.isHidden = true
        cover.isHidden = false
        cover.alpha = 1
        load(retryURL ?? config.origin)
    }

    // MARK: Events and links

    /// True when the page in the web view is the site's own (the only page that may hear the shell's events).
    private var showsOwnPage: Bool {
        guard let url = webView.url else { return false }
        return config.isOwnOrigin(url) && offline.isHidden
    }

    func send(_ event: BridgeEvent) {
        guard showsOwnPage else { return }
        webView.evaluateJavaScript(event.script, in: nil, in: .page, completionHandler: nil)
    }

    /// A universal link or a tapped notification: the page navigates itself when it handles `open`, otherwise the
    /// shell loads the URL.
    func open(path: String) {
        guard let url = config.url(forPath: path) else { return }
        dismissSheets()
        if showsOwnPage, pageEvents.contains("open") {
            send(.open(path: path))
        } else {
            offline.isHidden = true
            load(url)
        }
    }

    private func dismissSheets() {
        if presentedViewController != nil { dismiss(animated: false) }
    }

    // MARK: BridgeHost

    func bridgeHello(events: Set<String>) -> [String: Any] {
        pageEvents = events
        return [
            "bridge": 1,
            "shell": config.version,
            "build": config.build,
            "os": UIDevice.current.systemVersion,
            "events": events.sorted(),
        ]
    }

    func bridgePushRegister(completion: @escaping ([String: Any]) -> Void) {
        PushCenter.shared.register(environment: config.apnsEnvironment, completion: completion)
    }

    func bridgeBadgeSet(_ n: Int) {
        PushCenter.shared.setBadge(n)
    }
}

#if DEBUG
/// Debug builds only: `-HaiyoDebugUnreachableOnce` sends the first load through a closed local port, so the
/// cannot-connect screen and 重试 can be checked in the Simulator (which has no airplane mode). 重试 removes it.
enum DebugHooks {
    static let unreachableOnce = "-HaiyoDebugUnreachableOnce"

    static func applyBeforeFirstLoad(to webView: WKWebView) {
        guard ProcessInfo.processInfo.arguments.contains(unreachableOnce) else { return }
        let closedPort = NWEndpoint.hostPort(host: "127.0.0.1", port: 9)
        webView.configuration.websiteDataStore.proxyConfigurations = [ProxyConfiguration(httpCONNECTProxy: closedPort)]
    }

    static func clear(from webView: WKWebView) {
        webView.configuration.websiteDataStore.proxyConfigurations = []
    }

    static let probeLinks = "-HaiyoDebugProbeLinks"

    /// `-HaiyoDebugProbeLinks`: two fixed links to other sites on top of the page (one opening a new window, one in
    /// place), so the Simulator can check that other hosts open in the in-app Safari view without posting anything.
    static func addProbeLinks(to webView: WKWebView) {
        guard ProcessInfo.processInfo.arguments.contains(probeLinks) else { return }
        let script = """
        if (!document.getElementById("haiyo-probe")) {
          const box = document.createElement("div");
          box.id = "haiyo-probe";
          box.style.cssText = "position:fixed;left:50%;top:45%;transform:translateX(-50%);z-index:99999;display:flex;gap:12px";
          box.innerHTML = '<a href="https://www.apple.com/" target="_blank" style="padding:10px 14px;background:#fff;border-radius:10px">probe: new window</a>'
            + '<a href="https://example.com/" style="padding:10px 14px;background:#fff;border-radius:10px">probe: same window</a>';
          document.body.appendChild(box);
        }
        """
        webView.evaluateJavaScript(script, completionHandler: nil)
    }

    private static let log = Logger(subsystem: "org.haiyo.app", category: "history")

    /// Logs the path (never the query or anything on the page) and whether WebKit has an entry to go back to.
    static func observeHistory(of webView: WKWebView) -> [NSKeyValueObservation] {
        let report: (WKWebView) -> Void = { webView in
            log.notice("path=\(webView.url?.path ?? "-", privacy: .public) canGoBack=\(webView.canGoBack) back=\(webView.backForwardList.backList.count)")
        }
        return [
            webView.observe(\.url, options: [.new]) { webView, _ in report(webView) },
            webView.observe(\.canGoBack, options: [.new]) { webView, _ in report(webView) },
        ]
    }
}
#endif
