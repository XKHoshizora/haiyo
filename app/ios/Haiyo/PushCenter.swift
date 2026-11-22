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
    private var waiting: [([String: Any]) -> Void] = []

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

    /// Asks for permission when needed, then for a token: `{ token, env }`, `{ denied: true }` or `{ error }`.
    func register(environment: String, completion: @escaping ([String: Any]) -> Void) {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            DispatchQueue.main.async {
                guard granted else {
                    completion(["denied": true])
                    return
                }
                self.waiting.append { result in
                    var result = result
                    if result["token"] != nil { result["env"] = environment }
                    completion(result)
                }
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

    private func finish(_ result: [String: Any]) {
        let callbacks = waiting
        waiting.removeAll()
        callbacks.forEach { $0(result) }
    }

    func setBadge(_ n: Int) {
        UNUserNotificationCenter.current().setBadgeCount(n) { _ in }
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
        if let path = LaunchLinks.path(forNotification: response.notification.request.content.userInfo) {
            DispatchQueue.main.async {
                if let onOpenPath = self.onOpenPath { onOpenPath(path) } else { self.pendingPath = path }
            }
        }
        completionHandler()
    }
}
