import WebKit

/// What the bridge asks of the app. The shell's view controller implements it; tests use a fake.
protocol BridgeHost: AnyObject {
    func bridgeHello(events: Set<String>) -> [String: Any]
    func bridgePushRegister(completion: @escaping ([String: Any]) -> Void)
    func bridgeBadgeSet(_ n: Int)
}

/// The `haiyo` script message handler. Every message passes the origin gate first, then validation; a refused one
/// gets an error string back and has no effect.
final class Bridge: NSObject, WKScriptMessageHandlerWithReply {
    static let handlerName = "haiyo"

    let config: ShellConfig
    weak var host: BridgeHost?

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

    /// The whole decision, apart from WebKit: gate, validate, act, reply exactly once.
    func handle(source: FrameSource, body: Any, reply: @escaping (Any?, String?) -> Void) {
        guard OriginGate.allows(source, config: config) else {
            reply(nil, BridgeError.forbidden.rawValue)
            return
        }
        switch BridgeMessage.parse(body) {
        case let .failure(error):
            reply(nil, error.rawValue)
        case let .success(request):
            guard let host else {
                reply(nil, BridgeError.unknown.rawValue)
                return
            }
            switch request {
            case let .hello(events):
                reply(host.bridgeHello(events: events), nil)
            case .pushRegister:
                host.bridgePushRegister { result in reply(result, nil) }
            case let .badgeSet(n):
                host.bridgeBadgeSet(n)
                reply(["ok": true], nil)
            }
        }
    }
}
