import UIKit
import WebKit

/// A file of the site that asked for a new window (an attachment, the image viewer's 原图): shown in a sheet over the
/// shell, with the same cookies (the default data store) and no bridge. App pages never open here (`openInApp`).
final class SheetViewController: UIViewController {
    let config: ShellConfig
    let url: URL
    private let navigator: PageNavigator
    private var webView: WKWebView!
    private var titleObservation: NSKeyValueObservation?

    static func present(url: URL, config: ShellConfig, from presenter: UIViewController, onOpenPath: ((String) -> Void)?) {
        let sheet = SheetViewController(config: config, url: url)
        sheet.navigator.onOpenPath = onOpenPath
        let navigation = UINavigationController(rootViewController: sheet)
        navigation.modalPresentationStyle = .pageSheet
        presenter.present(navigation, animated: true)
    }

    init(config: ShellConfig, url: URL) {
        self.config = config
        self.url = url
        self.navigator = PageNavigator(config: config, role: .sheet)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    override func loadView() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.applicationNameForUserAgent = config.applicationName(appendingTo: configuration.applicationNameForUserAgent)
        configuration.allowsInlineMediaPlayback = true
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = navigator
        webView.uiDelegate = navigator
        webView.allowsBackForwardNavigationGestures = true
        #if DEBUG
        webView.isInspectable = true
        #endif
        self.webView = webView
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigator.presenter = self
        navigationItem.rightBarButtonItem = UIBarButtonItem(
            systemItem: .done,
            primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) }
        )
        #if DEBUG
        navigator.onFinish = { [weak self] in if let webView = self?.webView { DebugProbe.checkSheet(webView) } }
        #endif
        titleObservation = webView.observe(\.title, options: [.initial, .new]) { [weak self] webView, _ in
            self?.navigationItem.title = webView.title
        }
        webView.load(URLRequest(url: url))
    }
}
