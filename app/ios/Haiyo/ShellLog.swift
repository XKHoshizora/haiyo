import Foundation
import OSLog

/// The shell's only logger. The rule: nothing private reaches the log at any level — no file names, no paths or URLs
/// that carry ids, no query strings, no message text, no error descriptions (they can hold file paths), no names of
/// other apps. Callers can only pass the safe values below; free text from outside never gets in.
enum ShellLog {
    private static let logger = Logger(subsystem: "org.haiyo.app", category: "shell")

    /// What may be logged.
    enum Field: Equatable {
        case count(Int)
        case flag(Bool)
        /// An error as its domain and code only (`NSURLErrorDomain/-1009`), never its description or user info.
        case error(Error?)
        /// A site path as its route shape: known route words kept, every other segment `:id`, no query or fragment.
        case route(String)

        static func == (a: Field, b: Field) -> Bool { a.rendered == b.rendered }

        var rendered: String {
            switch self {
            case let .count(n): return String(n)
            case let .flag(b): return b ? "yes" : "no"
            case let .error(e): return ShellLog.errorSummary(e)
            case let .route(path): return ShellLog.routeShape(path)
            }
        }
    }

    /// The segments a route shape may keep: the app's own route words (`state/location.js`) and the API's.
    static let routeWords: Set<String> = [
        "api", "chat", "info", "contacts", "agents", "agent", "settings", "reset-password", "verify", "invite",
        "login", "register", "attachments", "avatars", "files", "new", "edit", "me", "groups", "group",
    ]

    /// "/chat/1d6b…/info?x=1#y" → "/chat/:id/info". Anything that is not a known route word becomes `:id`.
    static func routeShape(_ path: String) -> String {
        let bare = path.split(separator: "?", maxSplits: 1).first.map(String.init) ?? ""
        let noFragment = bare.split(separator: "#", maxSplits: 1).first.map(String.init) ?? ""
        let segments = noFragment.split(separator: "/", omittingEmptySubsequences: true)
        guard !segments.isEmpty else { return "/" }
        return "/" + segments.map { routeWords.contains(String($0)) ? String($0) : ":id" }.joined(separator: "/")
    }

    static func errorSummary(_ error: Error?) -> String {
        guard let error else { return "none" }
        let e = error as NSError
        return "\(e.domain)/\(e.code)"
    }

    /// The line as it is logged: the event name, then `key=value` pairs in the given order.
    static func line(_ event: StaticString, _ fields: [(String, Field)]) -> String {
        ([event.description] + fields.map { "\($0.0)=\($0.1.rendered)" }).joined(separator: " ")
    }

    /// Logs at the default (persisted) level. Keys are code-defined; values are only `Field`s.
    static func note(_ event: StaticString, _ fields: (String, Field)...) {
        let text = line(event, fields)
        logger.notice("\(text, privacy: .public)")
    }
}
