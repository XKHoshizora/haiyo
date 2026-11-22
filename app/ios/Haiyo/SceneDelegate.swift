import UIKit

final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var shell: ShellViewController?

    /// Unit tests run inside the app; they must not load the site.
    private var isRunningTests: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: windowScene)
        self.window = window
        guard !isRunningTests else {
            window.rootViewController = UIViewController()
            window.makeKeyAndVisible()
            return
        }
        let config = ShellConfig.current
        // The first page: a universal link, else a tapped notification (one load, not "/" and then the chat).
        let linked = connectionOptions.userActivities
            .first { $0.activityType == NSUserActivityTypeBrowsingWeb }?
            .webpageURL
            .flatMap { LaunchLinks.path(forUniversalLink: $0, config: config) }
        let notified = connectionOptions.notificationResponse.flatMap { response -> String? in
            PushCenter.shared.handledAtLaunch(response.notification.request.identifier)
            return LaunchLinks.path(forNotification: response.notification.request.content.userInfo)
        }
        let shell = ShellViewController(
            config: config,
            initialPath: linked ?? notified ?? PushCenter.shared.takePendingPath() ?? "/"
        )
        self.shell = shell
        window.rootViewController = shell
        window.makeKeyAndVisible()
        PushCenter.shared.onOpenPath = { [weak shell] path in shell?.open(path: path) }
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL,
              let shell,
              let path = LaunchLinks.path(forUniversalLink: url, config: shell.config) else { return }
        shell.open(path: path)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        shell?.appDidEnterBackground()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        shell?.appWillEnterForeground()
    }
}
