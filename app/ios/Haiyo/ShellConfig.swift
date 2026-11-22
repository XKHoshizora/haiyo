import Foundation

/// Where the shell points and what it says about itself.
///
/// The site is chosen by the build configuration only: `HAIYO_HOST` (project build settings) becomes the Info.plist key
/// `HaiyoHost`, and every other type asks this one. The origin is always `https://<host>` on the default port.
struct ShellConfig: Equatable {
    let host: String
    let version: String
    let build: String
    /// The APNs environment a token from this build belongs to: "development" or "production".
    let apnsEnvironment: String

    var origin: URL { URL(string: "https://\(host)")! }

    /// Reads the values from an Info.plist dictionary; nil when `HaiyoHost` is missing or not a bare host name.
    static func parse(info: [String: Any]) -> ShellConfig? {
        guard let raw = info["HaiyoHost"] as? String else { return nil }
        let host = raw.lowercased()
        guard isBareHost(host) else { return nil }
        let env = (info["HaiyoApnsEnvironment"] as? String) == "production" ? "production" : "development"
        return ShellConfig(
            host: host,
            version: info["CFBundleShortVersionString"] as? String ?? "0",
            build: info["CFBundleVersion"] as? String ?? "0",
            apnsEnvironment: env
        )
    }

    /// A DNS host name with at least one dot: letters, digits, `-` and `.` only (no scheme, port, path or spaces).
    static func isBareHost(_ s: String) -> Bool {
        guard !s.isEmpty, s.count <= 253, s.contains("."), !s.contains(".."),
              !s.hasPrefix("."), !s.hasSuffix("."), !s.hasPrefix("-") else { return false }
        let allowed = Set("abcdefghijklmnopqrstuvwxyz0123456789.-")
        return s.allSatisfy { allowed.contains($0) }
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
