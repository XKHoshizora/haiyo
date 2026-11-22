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
    static func safe(_ suggested: String) -> String {
        var name = suggested.replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: ":", with: "_")
        name = String(name.unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) })
        name = name.trimmingCharacters(in: .whitespaces)
        while name.hasPrefix(".") { name.removeFirst() }
        if name.count > 200 {
            let ext = (name as NSString).pathExtension
            let keep = 200 - (ext.isEmpty ? 0 : ext.count + 1)
            name = String(name.prefix(keep)) + (ext.isEmpty ? "" : ".\(ext)")
        }
        return name.isEmpty ? "download" : name
    }
}
