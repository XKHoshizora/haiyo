import Foundation

/// Where the shell points and what it says about itself.
///
/// The site is chosen by the build configuration only: `HAIYO_HOST` (project build settings) becomes the Info.plist key
/// `HaiyoHost`, and every other type asks this one. The origin is always `https://<host>` on the default port.
struct ShellConfig: Equatable {
    let host: String
    let version: String
    let build: String
    /// "acceptance" (Debug, Acceptance: the test site, internal TestFlight only) or "store".
    var channel: String = "acceptance"

    var origin: URL { URL(string: "https://\(host)")! }

    /// Reads the values from an Info.plist dictionary; nil when `HaiyoHost` is missing or not a bare host name.
    static func parse(info: [String: Any]) -> ShellConfig? {
        guard let raw = info["HaiyoHost"] as? String else { return nil }
        let host = raw.lowercased()
        guard isBareHost(host) else { return nil }
        return ShellConfig(
            host: host,
            version: info["CFBundleShortVersionString"] as? String ?? "0",
            build: info["CFBundleVersion"] as? String ?? "0",
            channel: (info["HaiyoChannel"] as? String) == "store" ? "store" : "acceptance"
        )
    }

    /// The host rule, also used by the "Check origin" build phase (keep the two identical): lower-case DNS labels of
    /// letters, digits and inner hyphens, at least two of them; no scheme, port, path, spaces, `_` or non-ASCII.
    static let hostPattern = "^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?([.][a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$"

    static func isBareHost(_ s: String) -> Bool {
        guard s.utf8.count <= 253, let regex = try? NSRegularExpression(pattern: hostPattern) else { return false }
        return regex.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    /// The configuration of the running app. A build whose configuration does not set `HAIYO_HOST` stops at the
    /// "Check origin" build phase; this is the second line of defence.
    static let current: ShellConfig = {
        guard let config = parse(info: Bundle.main.infoDictionary ?? [:]) else {
            fatalError("Info.plist HaiyoHost is missing or not a bare host name: set HAIYO_HOST for this build configuration")
        }
        return config
    }()

    /// True for `https://<host>` on the default port (any path). Nothing else is the shell's own origin.
    func isOwnOrigin(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", url.host?.lowercased() == host, url.user == nil else { return false }
        return url.port == nil || url.port == 443
    }

    /// A file the site serves (`/api/…`: attachments, original images, avatars), as opposed to a page of the app. The
    /// path as written: `/%61pi/x` is not a file (the service answers it with a 404, not a file).
    func isOwnFile(_ url: URL) -> Bool {
        let path = url.path(percentEncoded: true)
        return isOwnOrigin(url) && (path == "/api" || path.hasPrefix("/api/"))
    }

    /// The path, query and fragment of a URL ("/chat/abc?x=1#y"), for `url(forPath:)` and `haiyo:open`.
    func sitePath(of url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return "/" }
        components.scheme = nil
        components.host = nil
        components.port = nil
        components.user = nil
        components.password = nil
        let path = components.string ?? ""
        return path.isEmpty ? "/" : path
    }

    /// True for a `blob:` URL created by a page on the shell's own origin (`blob:https://<host>/<uuid>`).
    func isOwnBlob(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "blob" else { return false }
        let inner = String(url.absoluteString.dropFirst("blob:".count))
        guard let innerURL = URL(string: inner) else { return false }
        return isOwnOrigin(innerURL)
    }

    /// The URL of a site path ("/chat/abc?x=1"), or nil when `path` is not a plain absolute path on this origin.
    func url(forPath path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\"),
              !path.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) || $0 == " " }),
              let url = URL(string: path, relativeTo: origin)?.absoluteURL,
              isOwnOrigin(url) else { return nil }
        return url
    }

    /// WebKit's own application name with `HaiyoApp/<version>` after it. On iOS WebKit's value is "Mobile/15E148";
    /// setting `applicationNameForUserAgent` replaces it, so it is kept and the mark is appended.
    func applicationName(appendingTo base: String?) -> String {
        let mark = "HaiyoApp/\(version)"
        guard let base, !base.isEmpty else { return mark }
        return "\(base) \(mark)"
    }
}
