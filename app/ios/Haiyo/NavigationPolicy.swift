import Foundation

/// What the shell does with a URL the page wants to open.
enum NavigationRoute: Equatable {
    /// Let this web view load it here.
    case load
    /// Hand it to `WKDownload`, then the share sheet.
    case download
    /// A file of the site (`/api/…`: an attachment, an original image) asked for a new window: show it in the sheet.
    case sheet(URL)
    /// A page of the app itself (`/chat/…`, an invite) asked for a new window: open it in the main view
    /// (`haiyo:open`, or a load), never as a second copy of the app.
    case openInApp(path: String)
    /// Another web site: the in-app Safari view.
    case safari(URL)
    /// `mailto:`, `tel:`, `sms:` from a tapped link: the system.
    case system(URL)
    /// Anything else is not opened.
    case refuse
}

struct NavigationRequest: Equatable {
    let url: URL
    /// The target frame is the main frame (false for a sub-frame; ignored when `opensNewWindow`).
    let isMainFrame: Bool
    /// `target=_blank` / `window.open` (no target frame).
    let opensNewWindow: Bool
    /// WebKit says this navigation should become a download (`<a download>`).
    let shouldDownload: Bool
    /// The person tapped a link (`WKNavigationType.linkActivated`), as opposed to script or a redirect.
    var userActivated: Bool = true
}

enum NavigationPolicy {
    static let systemSchemes: Set<String> = ["mailto", "tel", "sms"]

    static func route(_ request: NavigationRequest, config: ShellConfig) -> NavigationRoute {
        let url = request.url
        let scheme = url.scheme?.lowercased() ?? ""
        let own = config.isOwnOrigin(url)
        let file = config.isOwnFile(url)
        let web = scheme == "https" || scheme == "http"

        if request.shouldDownload {
            if own || config.isOwnBlob(url) || scheme == "data" { return .download }
            return web ? .safari(url) : .refuse
        }
        if systemSchemes.contains(scheme) { return request.userActivated ? .system(url) : .refuse }
        if request.opensNewWindow {
            if file { return .sheet(url) }
            if own { return .openInApp(path: config.sitePath(of: url)) }
            return web ? .safari(url) : .refuse
        }
        if request.isMainFrame {
            // A tapped link to a file must not replace the app with the raw file.
            if file, request.userActivated { return .sheet(url) }
            if own { return .load }
            return web ? .safari(url) : .refuse
        }
        // A sub-frame: only the site's own pages and blank documents.
        if own || url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" { return .load }
        return .refuse
    }
}

/// What the shell does with a response before the page shows it.
enum ResponseRoute: Equatable {
    case allow
    case download
    /// The app's own page answered with a server error: show the cannot-connect screen (with 重试) instead of a raw
    /// error page the person cannot leave.
    case fail
}

struct NavigationResponseInfo: Equatable {
    let url: URL
    let isMainFrame: Bool
    let statusCode: Int?
    let canShowMIMEType: Bool
    let contentDisposition: String?
}

enum ResponsePolicy {
    static func route(_ response: NavigationResponseInfo, config: ShellConfig) -> ResponseRoute {
        if response.isMainFrame, config.isOwnOrigin(response.url), let status = response.statusCode, status >= 500 {
            return .fail
        }
        let disposition = response.contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased() ?? ""
        if disposition.hasPrefix("attachment") { return .download }
        return response.canShowMIMEType ? .allow : .download
    }
}
