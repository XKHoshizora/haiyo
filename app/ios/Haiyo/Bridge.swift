import WebKit

/// The page the shell's main web view shows: a generation that changes on every main-frame commit (and when the
/// content process dies), and whether that page is on the shell's own origin.
struct BridgePage: Equatable {
    let generation: Int
    let isOwnOrigin: Bool
}

/// What the bridge asks of the app. The shell's view controller implements it; tests use a fake. Every request
/// answers through its completion, at once or later; the bridge decides whether that answer may still be delivered.
protocol BridgeHost: AnyObject {
    var bridgePage: BridgePage { get }
    func bridgeHello(events: Set<String>, completion: @escaping ([String: Any]) -> Void)
    /// The `hello` answer reached the page that asked (it is still the page shown): only now does that page handle
    /// `events`. Not called when the answer was refused at delivery.
    func bridgeHelloDelivered(events: Set<String>)
    func bridgePushRegister(completion: @escaping ([String: Any]) -> Void)
    func bridgeBadgeSet(_ n: Int, completion: @escaping ([String: Any]) -> Void)
}

/// The `haiyo` script message handler. A message passes the origin gate when it arrives; its answer passes the gate
/// again when it is delivered (`deliver`). Refused messages and answers get `forbidden` and have no effect.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "haiyo"

    let config: ShellConfig
    weak var host: BridgeHost?
    /// Tests only: sees every reply exactly as it is handed to WebKit.
    var replyObserver: ((Any?, String?) -> Void)?

    init(config: ShellConfig, host: BridgeHost?) {
        self.config = config
        self.host = host
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        handle(source: FrameSource(message.frameInfo), body: message.body) { value, error in
            MainActor.assumeIsolated { replyHandler(value, error) }
        }
    }

    /// The whole decision, apart from WebKit: gate, validate, act; the answer goes through `deliver`, exactly once.
    func handle(source: FrameSource, body: Any, reply: @escaping (Any?, String?) -> Void) {
        let send: (Any?, String?) -> Void = { [self] value, error in
            replyObserver?(value, error)
            reply(value, error)
        }
        guard OriginGate.allows(source, config: config), let host, host.bridgePage.isOwnOrigin else {
            send(nil, BridgeError.forbidden.rawValue)
            return
        }
        let request: BridgeRequest
        switch BridgeMessage.parse(body) {
        case let .failure(error):
            send(nil, error.rawValue)
            return
        case let .success(parsed):
            request = parsed
        }
        let arrival = host.bridgePage
        var answered = false
        let answer: ([String: Any], (() -> Void)?) -> Void = { [self] value, delivered in
            guard !answered else { return }
            answered = true
            deliver(value, askedBy: arrival, send: send, delivered: delivered)
        }
        switch request {
        case let .hello(events):
            host.bridgeHello(events: events) { [weak host] value in
                answer(value) { host?.bridgeHelloDelivered(events: events) }
            }
        case .pushRegister: host.bridgePushRegister { answer($0, nil) }
        case let .badgeSet(n): host.bridgeBadgeSet(n) { answer($0, nil) }
        }
    }

    /// Every answer passes here, also the ones that come at once: it is delivered only if the page that asked is still
    /// the page shown (same generation, still the shell's own origin); otherwise `forbidden`. `delivered` runs only
    /// when it went out.
    private func deliver(_ value: [String: Any], askedBy arrival: BridgePage, send: (Any?, String?) -> Void, delivered: (() -> Void)?) {
        guard let host, host.bridgePage == arrival, arrival.isOwnOrigin else {
            send(nil, BridgeError.forbidden.rawValue)
            return
        }
        send(value, nil)
        delivered?()
    }
}
