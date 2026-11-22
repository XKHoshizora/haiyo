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
        if isRunningTests {
            window.rootViewController = UIViewController()
        } else {
            let config = ShellConfig.current
            let linked = connectionOptions.userActivities
                .first { $0.activityType == NSUserActivityTypeBrowsingWeb }?
                .webpageURL
                .flatMap { LaunchLinks.path(forUniversalLink: $0, config: config) }
            let shell = ShellViewController(config: config, initialPath: linked ?? "/")
            self.shell = shell
            window.rootViewController = shell
            PushCenter.shared.onOpenPath = { [weak shell] path in shell?.open(path: path) }
        }
        self.window = window
        window.makeKeyAndVisible()
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        guard userActivity.activityType == NSUserActivityTypeBrowsingWeb,
              let url = userActivity.webpageURL,
              let shell,
              let path = LaunchLinks.path(forUniversalLink: url, config: shell.config) else { return }
        shell.open(path: path)
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        shell?.send(.pause)
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        shell?.send(.resume)
    }
}
