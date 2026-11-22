import Network
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
    /// Changes on every main-frame commit and when the content process dies: a bridge answer is delivered only to the
    /// page generation that asked (`Bridge.deliver`).
    private var pageGeneration = 0
    /// Scene state as the scene delegate reports it (a cold start counts as foreground).
    private var isForeground = true
    /// The content process died while the app was in the background: reload when it comes back.
    private var needsReload = false
    private var crashReloads = CrashReloadBudget()
    private var coverTimers: [DispatchWorkItem] = []
    /// The last URL of the site's own page, also routes the page set with `pushState`: after a content-process crash
    /// WebKit only knows the last full load, and the reload should return to the same chat.
    private var lastPageURL: URL?
    private var urlObservation: NSKeyValueObservation?
    /// Between a crash and its reload the URL WebKit reports is stale; `lastPageURL` is kept as it was.
    private var crashReloadPending = false
    private let pathMonitor = NWPathMonitor()
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

    deinit { pathMonitor.cancel() }

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
        navigator.onCommit = { [weak self] in self?.pageCommitted() }
        navigator.onFinish = { [weak self] in self?.pageShown() }
        navigator.onFailure = { [weak self] failure, url in self?.showFailure(failure, url: url) }
        navigator.onOpenPath = { [weak self] path in self?.open(path: path) }
        navigator.onContentProcessTerminated = { [weak self] in self?.contentProcessTerminated() }
        pathMonitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            DispatchQueue.main.async { self?.networkReturned() }
        }
        pathMonitor.start(queue: .global(qos: .utility))
        urlObservation = webView.observe(\.url, options: [.new]) { [weak self] webView, _ in
            guard let self, !self.crashReloadPending, let url = webView.url, self.config.isOwnOrigin(url) else { return }
            self.lastPageURL = url
        }
        #if DEBUG
        DebugProbe.applyBeforeFirstLoad(to: webView)
        debugObservations = DebugProbe.observeHistory(of: webView)
        bridge?.replyObserver = DebugProbe.logReply
        #endif
        load(config.url(forPath: initialPath) ?? config.origin)
    }

    // MARK: Loading

    private func load(_ url: URL) {
        retryURL = url
        showCover()
        webView.load(URLRequest(url: url))
    }

    /// The cover hides the page until it has painted. It can never stay: it lifts a few seconds after the first commit
    /// even if `didFinish` is late, and if nothing commits at all the cannot-connect screen takes over.
    private func showCover() {
        coverTimers.forEach { $0.cancel() }
        cover.isHidden = false
        cover.alpha = 1
        webView.accessibilityElementsHidden = true
        let unreachable = DispatchWorkItem { [weak self] in
            guard let self, !self.cover.isHidden else { return }
            self.showFailure(.unreachable, url: self.retryURL)
        }
        coverTimers = [unreachable]
        DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: unreachable)
    }

    private func liftCover(after delay: TimeInterval) {
        coverTimers.forEach { $0.cancel() }
        coverTimers = []
        guard !cover.isHidden else { return }
        webView.accessibilityElementsHidden = false
        UIView.animate(withDuration: 0.2, delay: delay, options: [.beginFromCurrentState]) {
            self.cover.alpha = 0
        } completion: { _ in
            self.cover.isHidden = true
        }
    }

    private func pageCommitted() {
        pageGeneration += 1
        pageEvents = []
        guard !cover.isHidden else { return }
        coverTimers.forEach { $0.cancel() }
        let lift = DispatchWorkItem { [weak self] in self?.liftCover(after: 0) }
        coverTimers = [lift]
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: lift)
    }

    private func pageShown() {
        #if DEBUG
        DebugProbe.pageShown(webView, config: config)
        #endif
        offline.isHidden = true
        // env(safe-area-inset-*) can arrive a moment after load in WKWebView: keep the cover a little longer.
        liftCover(after: 0.15)
    }

    /// `force`: the page is gone (its process kept crashing), so the screen shows even though the URL looks fine.
    private func showFailure(_ failure: LoadFailure, url: URL?, force: Bool = false) {
        // Once the page is up, a dropped network is the page's own business (it reconnects and shows its status).
        if !force, let current = webView.url, config.isOwnOrigin(current), cover.isHidden, offline.isHidden, webView.isLoading == false {
            return
        }
        coverTimers.forEach { $0.cancel() }
        coverTimers = []
        if let url, config.isOwnOrigin(url) { retryURL = url }
        offline.show(failure)
        offline.isHidden = false
        UIAccessibility.post(notification: .screenChanged, argument: offline)
    }

    private func retry() {
        #if DEBUG
        DebugProbe.clear(from: webView)
        #endif
        offline.isHidden = true
        load(retryURL ?? config.origin)
    }

    /// The cannot-connect screen is up and the network is back: try once more by itself.
    private func networkReturned() {
        guard !offline.isHidden, isForeground else { return }
        retry()
    }

    // MARK: Content process

    /// iOS kills the page's process (often while the app is in the background). Reload only in the foreground, and
    /// at most twice a minute; a page that keeps crashing ends on the cannot-connect screen.
    private func contentProcessTerminated() {
        crashReloadPending = true
        pageGeneration += 1
        pageEvents = []
        ShellLog.note("content-process-terminated", ("foreground", .flag(isForeground)))
        guard isForeground else {
            needsReload = true
            return
        }
        reloadAfterCrash()
    }

    private func reloadAfterCrash() {
        needsReload = false
        guard crashReloads.allow(at: Date()) else {
            crashReloadPending = false
            showFailure(.unreachable, url: lastPageURL ?? retryURL, force: true)
            return
        }
        crashReloadPending = false
        load(lastPageURL ?? retryURL ?? config.origin)
    }

    // MARK: Scene lifecycle and events

    func appDidEnterBackground() {
        isForeground = false
        send(.pause)
    }

    func appWillEnterForeground() {
        isForeground = true
        if needsReload {
            reloadAfterCrash()
        } else {
            send(.resume)
        }
        #if DEBUG
        DebugProbe.reportEvents(of: webView)
        #endif
    }

    /// Sends an event to the page if it is the site's own. The script checks the origin itself as well, so a document
    /// that changed under the URL never hears it. `pause`/`resume` also go out behind the cannot-connect screen (the
    /// old page may still be alive there). `fallback` runs when the event could not be delivered.
    func send(_ event: BridgeEvent, fallback: (() -> Void)? = nil) {
        guard let url = webView.url, config.isOwnOrigin(url) else {
            fallback?()
            return
        }
        webView.evaluateJavaScript(event.script(origin: config.origin), in: nil, in: .page) { result in
            if case let .success(value) = result, value as? Bool == true { return }
            fallback?()
        }
    }

    /// A universal link, a tapped notification or an app link opened from a message: the page navigates itself when
    /// it handles `open`, otherwise (or if the event does not arrive) the shell loads the URL.
    func open(path: String) {
        guard let url = config.url(forPath: path) else { return }
        dismissSheets()
        if offline.isHidden, pageEvents.contains("open") {
            send(.open(path: path), fallback: { [weak self] in self?.load(url) })
        } else {
            offline.isHidden = true
            load(url)
        }
    }

    private func dismissSheets() {
        if presentedViewController != nil { dismiss(animated: false) }
    }

    // MARK: BridgeHost

    var bridgePage: BridgePage {
        BridgePage(generation: pageGeneration, isOwnOrigin: webView.url.map(config.isOwnOrigin) ?? false)
    }

    func bridgeHello(events: Set<String>, completion: @escaping ([String: Any]) -> Void) {
        pageEvents = events
        PushCenter.shared.status { [config] push in
            completion([
                "bridge": 1,
                "shell": config.version,
                "build": config.build,
                "os": UIDevice.current.systemVersion,
                "push": push,
                "events": events.sorted(),
            ])
        }
    }

    func bridgePushRegister(completion: @escaping ([String: Any]) -> Void) {
        PushCenter.shared.register(environment: config.apnsEnvironment, completion: completion)
    }

    func bridgeBadgeSet(_ n: Int, completion: @escaping ([String: Any]) -> Void) {
        PushCenter.shared.setBadge(n, completion: completion)
    }
}

/// At most `limit` reloads after a content-process crash within `window` seconds.
struct CrashReloadBudget {
    var limit = 2
    var window: TimeInterval = 60
    private(set) var recent: [Date] = []

    mutating func allow(at now: Date) -> Bool {
        recent = recent.filter { now.timeIntervalSince($0) < window }
        guard recent.count < limit else { return false }
        recent.append(now)
        return true
    }
}
