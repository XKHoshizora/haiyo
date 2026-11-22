import WebKit

/// Who sent a bridge message, as plain values taken from `WKScriptMessage.frameInfo` so the rule can be tested.
struct FrameSource: Equatable {
    let isMainFrame: Bool
    let scheme: String
    let host: String
    /// 0 is the scheme's default port (the convention of `WKSecurityOrigin`).
    let port: Int

    init(isMainFrame: Bool, scheme: String, host: String, port: Int) {
        self.isMainFrame = isMainFrame
        self.scheme = scheme
        self.host = host
        self.port = port
    }

    init(_ frame: WKFrameInfo) {
        self.init(
            isMainFrame: frame.isMainFrame,
            scheme: frame.securityOrigin.protocol,
            host: frame.securityOrigin.host,
            port: frame.securityOrigin.port
        )
    }
}

/// The only rule for the bridge: the main frame of a page on the shell's own origin. Sub-frames (even same-origin
/// ones) and a main frame showing any other origin are refused, whatever the message says.
enum OriginGate {
    static func allows(_ source: FrameSource, config: ShellConfig) -> Bool {
        source.isMainFrame
            && source.scheme.lowercased() == "https"
            && source.host.lowercased() == config.host
            && (source.port == 0 || source.port == 443)
    }
}
