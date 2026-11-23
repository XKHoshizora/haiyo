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
    /// WebKit reports a link activation (`WKNavigationType.linkActivated`), as opposed to a load, a redirect or a form.
    /// A script's `element.click()` is reported the same way, so this is not proof of a tap (README "Navigation").
    var userActivated: Bool = true
    /// The request comes from the sheet's web view (a file of the site), not the shell's.
    var inSheet: Bool = false
    /// In the sheet: its own load has not committed yet, so this is that load or one of its redirects (an expired
    /// session redirects a file to the sign-in page).
    var sheetFirstLoad: Bool = false
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
            if own, request.inSheet, !request.userActivated { return .refuse }
            if own { return .openInApp(path: config.sitePath(of: url)) }
            return web ? .safari(url) : .refuse
        }
        if request.isMainFrame {
            // A tapped link to a file must not replace the app with the raw file.
            if file, request.userActivated { return .sheet(url) }
            // The sheet shows files only: a page of the app opens in the main view, never as a second copy of the app in
            // the sheet — when the person activated a link, or when the sheet's own load is redirected (the sign-in
            // page). Anything else a file could start (a refresh, script) is refused: today the service shows only
            // images inline, and this keeps a future inline type from steering the main view (README "Navigation").
            if own, request.inSheet, !file {
                return request.userActivated || request.sheetFirstLoad ? .openInApp(path: config.sitePath(of: url)) : .refuse
            }
            if own { return .load }
            return web ? .safari(url) : .refuse
        }
        // A sub-frame: only the site's own pages (in the sheet only its files) and blank documents.
        if own, !request.inSheet || file { return .load }
        if url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" { return .load }
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
