import Foundation

/// A request from the page, after validation. Bridge version 1; later versions only add.
enum BridgeRequest: Equatable {
    /// The page introduces itself and names the events it handles (a subset of `BridgeMessage.knownEvents`).
    case hello(events: Set<String>)
    /// Ask for notification permission and an APNs token.
    case pushRegister
    /// Set the app icon badge.
    case badgeSet(Int)
}

/// The error string a refused message gets back (the page's promise rejects with it).
enum BridgeError: String, Error, Equatable {
    /// Not the main frame of a page on the shell's own origin.
    case forbidden
    /// Not `{ name: string, args?: object }`, or arguments of the wrong type.
    case malformed
    /// A name this shell does not know.
    case unknown
}

enum BridgeMessage {
    static let knownEvents: Set<String> = ["pause", "resume", "open"]
    static let maxBadge = 99_999

    /// Validates the body of `window.webkit.messageHandlers.haiyo.postMessage({ name, args })`.
    static func parse(_ body: Any) -> Result<BridgeRequest, BridgeError> {
        guard let message = body as? [String: Any], let name = message["name"] as? String else { return .failure(.malformed) }
        let args: [String: Any]
        switch message["args"] {
        case nil, is NSNull: args = [:]
        case let object as [String: Any]: args = object
        default: return .failure(.malformed)
        }
        switch name {
        case "hello":
            guard let raw = args["events"] else { return .success(.hello(events: [])) }
            guard let list = raw as? [String], list.count <= 16 else { return .failure(.malformed) }
            return .success(.hello(events: Set(list).intersection(knownEvents)))
        case "push.register":
            return .success(.pushRegister)
        case "badge.set":
            guard let n = integer(args["n"]), (0...maxBadge).contains(n) else { return .failure(.malformed) }
            return .success(.badgeSet(n))
        default:
            return .failure(.unknown)
        }
    }

    /// A JavaScript number that is a whole number (not a boolean, which also arrives as NSNumber).
    static func integer(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let d = number.doubleValue
        guard d.isFinite, d.rounded() == d, abs(d) < 1e9 else { return nil }
        return Int(d)
    }
}

/// An event the shell sends to the page, as `window.dispatchEvent(new CustomEvent("haiyo:<name>", { detail }))`.
enum BridgeEvent: Equatable {
    case pause
    case resume
    case open(path: String)

    var name: String {
        switch self {
        case .pause: return "pause"
        case .resume: return "resume"
        case .open: return "open"
        }
    }

    /// The script that dispatches it, only in a document on `origin`; it evaluates to `true` when dispatched. The
    /// origin and the detail are JSON, so nothing in a path can become code.
    func script(origin: URL) -> String {
        var detail = "null"
        if case let .open(path) = self,
           let data = try? JSONSerialization.data(withJSONObject: ["path": path]),
           let json = String(data: data, encoding: .utf8) {
            detail = json
        }
        let expected = Self.json(origin.absoluteString)
        return "(function () { if (location.origin !== \(expected)) return false; "
            + "window.dispatchEvent(new CustomEvent(\"haiyo:\(name)\", { detail: \(detail) })); return true; })()"
    }

    private static func json(_ string: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [string]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        return String(array.dropFirst().dropLast())
    }
}

/// Paths the shell opens for a universal link or a notification.
enum LaunchLinks {
    /// The site path of a universal link on the shell's own origin, or nil.
    static func path(forUniversalLink url: URL, config: ShellConfig) -> String? {
        guard config.isOwnOrigin(url), var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = nil
        components.host = nil
        components.port = nil
        let path = components.string ?? ""
        return config.url(forPath: path.isEmpty ? "/" : path) == nil ? nil : (path.isEmpty ? "/" : path)
    }

    /// The conversation a notification points at (`"c": "<uuid>"` in its payload) as "/chat/<uuid>", or nil.
    static func path(forNotification userInfo: [AnyHashable: Any]) -> String? {
        guard let id = userInfo["c"] as? String, let uuid = UUID(uuidString: id) else { return nil }
        return "/chat/\(uuid.uuidString.lowercased())"
    }
}
