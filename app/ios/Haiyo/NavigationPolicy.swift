import Foundation

/// What the shell does with a URL the page wants to open.
enum NavigationRoute: Equatable {
    /// Let this web view load it here.
    case load
    /// Hand it to `WKDownload`, then the share sheet.
    case download
    /// A same-origin page asked for a new window: show it in the sheet.
    case sheet(URL)
    /// Another web site: the in-app Safari view.
    case safari(URL)
    /// `mailto:`, `tel:`, `sms:`: the system.
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
}

enum NavigationPolicy {
    static let systemSchemes: Set<String> = ["mailto", "tel", "sms"]

    static func route(_ request: NavigationRequest, config: ShellConfig) -> NavigationRoute {
        let url = request.url
        let scheme = url.scheme?.lowercased() ?? ""
        let own = config.isOwnOrigin(url)
        let web = scheme == "https" || scheme == "http"

        if request.shouldDownload {
            if own || config.isOwnBlob(url) || scheme == "data" { return .download }
            return web ? .safari(url) : .refuse
        }
        if systemSchemes.contains(scheme) { return .system(url) }
        if request.opensNewWindow {
            if own { return .sheet(url) }
            return web ? .safari(url) : .refuse
        }
        if request.isMainFrame {
            if own { return .load }
            return web ? .safari(url) : .refuse
        }
        // A sub-frame: only the site's own pages and blank documents.
        if own || url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" { return .load }
        return .refuse
    }
}
