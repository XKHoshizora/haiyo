import UIKit
import UserNotifications

/// Notification permission, the APNs token and the badge. Present but idle until the page calls `push.register`
/// (the service side does not exist yet). Taps on a notification open its conversation.
final class PushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCenter()

    /// Set by the scene once the shell exists; a tap that arrives before that waits in `pendingPath`.
    var onOpenPath: ((String) -> Void)? {
        didSet {
            if let path = pendingPath, let onOpenPath {
                pendingPath = nil
                onOpenPath(path)
            }
        }
    }
    private var pendingPath: String?
    /// The notification a cold start already opened (from the scene's connection options): its delegate call is
    /// not opened a second time.
    private var launchNotification: String?
    private var waiting: [(id: UUID, callback: ([String: Any]) -> Void)] = []

    func handledAtLaunch(_ identifier: String) {
        launchNotification = identifier
    }

    /// A tap that arrived before the shell existed, taken once.
    func takePendingPath() -> String? {
        defer { pendingPath = nil }
        return pendingPath
    }

    /// "granted", "denied" or "notDetermined".
    func status(completion: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let value: String
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: value = "granted"
            case .denied: value = "denied"
            default: value = "notDetermined"
            }
            DispatchQueue.main.async { completion(value) }
        }
    }

    /// At most this many `push.register` calls wait for APNs at once; more get `{ error: "busy" }`.
    static let maxWaiting = 4
    /// A token that has not come after this long is answered with `{ error: "timeout" }` (simulator, no network).
    static let tokenTimeout: TimeInterval = 30

    /// Asks for permission when needed, then for a token: `{ token, env }`, `{ denied: true }` or `{ error }`.
    /// Always answers exactly once.
    func register(environment: String, completion: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else {
                    completion(["denied": true])
                    return
                }
                guard self.waiting.count < Self.maxWaiting else {
                    completion(["error": "busy"])
                    return
                }
                let id = UUID()
                self.waiting.append((id, { result in
                    var result = result
                    if result["token"] != nil { result["env"] = environment }
                    completion(result)
                }))
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.tokenTimeout) { self.finish(["error": "timeout"], only: id) }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    func didRegister(deviceToken: Data) {
        finish(["token": deviceToken.map { String(format: "%02x", $0) }.joined()])
    }

    func didFailToRegister() {
        finish(["error": "registration_failed"])
    }

    /// Answers every waiting call, or only the one with `id`.
    private func finish(_ result: [String: Any], only id: UUID? = nil) {
        let done = waiting.filter { id == nil || $0.id == id }
        waiting.removeAll { id == nil || $0.id == id }
        done.forEach { $0.callback(result) }
    }

    /// Sets the badge; answers `{ ok: false }` when the system refuses (no badge permission yet).
    func setBadge(_ n: Int, completion: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().setBadgeCount(n) { error in
            DispatchQueue.main.async { completion(["ok": error == nil]) }
        }
    }

    // MARK: UNUserNotificationCenterDelegate

    /// In the foreground the open page already shows the message: no banner, no sound.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let identifier = response.notification.request.identifier
        if let path = LaunchLinks.path(forNotification: response.notification.request.content.userInfo) {
            DispatchQueue.main.async {
                if self.launchNotification == identifier {
                    self.launchNotification = nil
                    return
                }
                if let onOpenPath = self.onOpenPath { onOpenPath(path) } else { self.pendingPath = path }
            }
        }
        completionHandler()
    }
}
