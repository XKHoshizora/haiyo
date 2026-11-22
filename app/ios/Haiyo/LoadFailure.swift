import Foundation

/// How a failed page load is shown.
enum LoadFailure: Equatable {
    /// Not a failure the person should see (a cancelled load, a navigation that became a download).
    case ignore
    /// The device has no usable network.
    case offline
    /// There is a network, but the site cannot be reached (timeout, DNS, TLS, refused connection, proxy).
    case unreachable

    static func classify(domain: String, code: Int) -> LoadFailure {
        if domain == NSURLErrorDomain {
            switch code {
            case NSURLErrorCancelled:
                return .ignore
            case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorDataNotAllowed,
                 NSURLErrorInternationalRoamingOff, NSURLErrorCallIsActive:
                return .offline
            default:
                return .unreachable
            }
        }
        // WebKit's "Frame load interrupted" (102): the navigation was turned into a download or cancelled by policy.
        if domain == "WebKitErrorDomain", code == 102 || code == 101 { return .ignore }
        return .unreachable
    }

    static func classify(_ error: Error) -> LoadFailure {
        let e = error as NSError
        return classify(domain: e.domain, code: e.code)
    }

    /// System-style wording for the cannot-connect screen.
    var title: String {
        self == .offline ? "无法连接网络" : "无法连接到 Haiyo"
    }

    var message: String {
        self == .offline ? "请检查网络连接，然后重试。" : "暂时无法连接到服务器，请稍后重试。"
    }
}

/// A file name that is safe as the last path component of a temporary file.
enum DownloadName {
    /// Bytes of UTF-8, not characters (a CJK character takes 3). APFS itself takes 255 characters, but where a saved
    /// file goes next (a file provider, an SMB share, an exFAT drive) the limit can be 255 bytes; keep a margin.
    static let maxBytes = 240

    static func safe(_ suggested: String) -> String {
        var name = suggested.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        name = String(name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        name = name.trimmingCharacters(in: .whitespaces)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.utf8.count > maxBytes {
            var ext = (name as NSString).pathExtension
            if ext.utf8.count > 16 { ext = "" }
            let suffix = ext.isEmpty ? "" : ".\(ext)"
            var stem = ext.isEmpty ? name : String(name.dropLast(suffix.count))
            // Cut whole characters (never inside a UTF-8 sequence) until the name fits.
            while stem.utf8.count + suffix.utf8.count > maxBytes { stem.removeLast() }
            name = stem + suffix
        }
        return name.isEmpty ? "download" : name
    }
}
