# 上架应用：建造计划（iOS 壳，加载线上站点）

日期：2026-11-23。状态：**建造计划，仍是纸面：没有代码，没装任何东西，没登录任何账号**。前一版是草稿（e51e84a，同一文件），这版按主人的决定、架构裁定和独立评审改写。

- 外部事实都带出处（文末 R / T / L），资料核对于 2026-11-23。审核指南按页面显示的 “Last Updated: October 16, 2026”，开发者协议（DPLA）按 “last updated October 29, 2026”。
- 本地事实在 lane/integ-mobile 57534f3 上核对，外键数是在本机 e2e 库（同一提交迁移出来的）里查的。
- 没核实的标 **未核实**；我的推断标 **推断**；产品取舍标 **待定**（第 8 节）。

## 主人已定（2026-11-23）

- 先做网页壳；原生或 RN 等反馈再说。不维护两套要互相兼容的版本。
- 第一次试用要从 App Store 上架的应用装。
- 第一版不卖点数。
- 只给 18 岁以上。
- 名字 “Haiyo”；图标先用临时的，从主人之前挑过的里选（留了位置，见第 2 节）。
- 个人开发者账号，卖家显示主人的法定姓名。
- 店面：日本、美国和其他非欧盟地区；不含中国大陆；欧盟等查清个人的“交易者”公开要求再说（第 6 节）。
- 联系地址 support@haiyo.org（收信已验证）。
- 审核要求的东西全部补上。

## 架构裁定：壳加载线上站点

壳打开网页端的 https 源，不打包网页。和浏览器同源，所以：
- cookie 会话、要 cookie 才能看的图片、websocket、发布新版，都和网页端完全一样；
- 不要 bearer 登录，不改 CORS / `trustedOrigins`，没有媒体密钥，也没有新旧版本兼容期。

原生层只加：推送（APNs，推送里不带内容）、角标、分享 / 保存、断网页、通用链接、权限用途说明。

退路：如果审核坚持，以后再改成打包。

## 结论先说

1. **壳用纯 WKWebView（Swift，只用系统框架，不用 Capacitor）。** Capacitor 自己的文档说 `server.url` 不是给生产用的，它的桥对任何加载进来的页面都开放，而我们要的下载、角标它本来就没有（第 1.1 节）。纯壳不加任何依赖，这台 Mac 也不用再装东西。
2. 原生层 8 个 Swift 文件，壳 + 测试约 **5 个 agent-日**（第 2 节）。
3. 服务端和网页分 9 道，合计约 **17.5 个 agent-日**；其中 5 道现在就能和 Agent 社交、harness 并行，4 道要协调或排队（第 3 节）。
4. 加上整合与验收约 2 个 agent-日，**总计约 24.5 个 agent-日**；三道并行时大约 9–10 天能交给主人走提交（第 7 节）。
5. 新查到、必须做的两件：
   - **德州 SB 2420 已经生效**：2026-06-04 第五巡回法院暂停了禁令，最高法院 2026-07-06 拒绝撤销暂停；18+ 的应用也要用苹果的 Declared Age Range API（第 1.6 节）。所以建议最低 **iOS 26**（**待定**）。
   - **欧盟以外也要声明交易者身份**：苹果说不在欧盟发行也要声明；只在欧盟外发行可以声明“非交易者”（第 6 节）。

## 0. 评审意见怎么处理的

| 评审说的 | 处理 | 在哪 |
|---|---|---|
| “加载线上站点有 2.5.2 风险 / 打包能避开 2.5.19”没有依据 | 同意，撤回；DPLA 3.3.1(B) 允许，2.5.19 两种都会碰到 | 1.6 |
| “4.7 很可能覆盖用户建的 Agent”是解读 | 同意；按 1.2 提交 | 1.6 |
| 漏了 2.2、3.2.2(v) | 补上 | 1.6、第 4 节、第 8 节第 6 条 |
| 漏了撤回同意 | 补上（5.1.1(ii) 原文要求） | S3 |
| 漏了麦克风、存相册的用途说明 | 补上；麦克风是“拍照或录像”要的 | 1.4、第 2 节 |
| 漏了出口加密标记、隐私清单 | 补上 | 第 2、4 节 |
| 漏了欧盟交易者声明、德州年龄法 | 补上；德州法已生效 | 第 6 节、1.6、S9 |
| 举报要复用社交设计的 `agent_reports` | 照做，只建一次 | S4 |
| 删除账号：28 个限制外键加社交表 | 在本机 e2e 库里数过，确实是 28 个，清单见 S7 | S7 |
| 推送：暂停时关 socket，按设备记会话 | 照做；现有心跳 30 秒（`hub.ts:29`），不关的话死连接要 30–60 秒才清掉 | S5、S9 |
| 角标要服务端未读数 | 照做；现在只有浏览器里算 | S6 |
| `web.ts` 对 AASA 路径返回 index.html | 核对属实（以 `.` 开头的段被拒，再回落到网页） | S1 |

## 1. 路线：核实过的事实

### 1.1 壳用什么：Capacitor 还是纯 WKWebView → 纯 WKWebView

Capacitor（现行 8.6.2，2026-11-12；9.0.0-rc.0 已出）[T1]：
- 自己的配置文档对 `server.url` 和 `allowNavigation` 都写着 “This is not intended for use in production.”[T1]。维护者 2021 年在讨论区说不建议在生产里用，可能被拒 [T3]。
- 桥在远程页面上**能用**，而且**对谁都开放**（读 8.6.2 的 iOS 源码得出，文档没写）[T2]：
  - `native-bridge.js` 和每个插件的代理在文档开始时注入，只注入主框架，不分来源；
  - `bridge` 消息处理不检查 `frameInfo` / `securityOrigin`，9 的主分支也一样。
  - 所以壳能加载的任何页面都能调全部插件，来源检查要自己补。
- 我们要的几样它本来就缺 [T2][T4]：
  - 核心不处理下载（没有 `WKDownload`）；
  - 官方插件里没有设角标的调用；
  - Share 插件只收 `file://`，还得加 Filesystem 插件先写文件；
  - `target=_blank` 一律交给 Safari，同源的也是；
  - 出错页对任何失败都显示，不分错误码；
  - 还得在包里放一个占位的 `index.html`，否则启动报错。
- 推送插件要在 AppDelegate 里自己转发令牌 [T4]。
- Capacitor 在苹果的“常用第三方 SDK”名单上，要带隐私清单和签名 [R12]。
- 用 `server.url` 上架的应用：只有讨论区里的自述，**未核实** [T3]。Ionic 2025-02-11 宣布停止向新客户卖商业产品（Appflow 用到 2027-12-31）[T5]。

纯 WKWebView（只用苹果框架）——每样要的东西都有现成的系统接口 [T7][T8][T9][T10][T11][T12][T13]：

| 要做的 | 系统接口 | 最低 iOS |
|---|---|---|
| 网页 → 原生的桥 | `WKScriptMessageHandlerWithReply`（`.page` 世界）；用 `frameInfo.isMainFrame` 和 `securityOrigin` 只认自己的源 | 14 |
| 推送登记、点通知进会话 | `registerForRemoteNotifications`、`UNUserNotificationCenterDelegate` 的 `didReceive` | 10 |
| 角标 | `UNUserNotificationCenter.setBadgeCount`（`applicationIconBadgeNumber` 在 17 已弃用） | 16 |
| `<a download>` 和附件响应 | `shouldPerformDownload` → `.download`，`WKDownloadDelegate` 定存放位置，再弹 `UIActivityViewController` | 14.5 |
| 新窗口、外站 | `WKUIDelegate.createWebViewWith`；外站用 `SFSafariViewController` | 9 |
| 通用链接 | `scene(_:willConnectTo:)`（冷启动）、`scene(_:continue:)`（运行中） | 13 |
| 连不上 | `didFailProvisionalNavigation` 看 `NSURLErrorDomain` 码（-1009 等），忽略 -999 和 WebKit 102（下载引起）；进程崩了用 `webViewWebContentProcessDidTerminate` 重载 | 9 |
| 告诉网页“我是壳” | `applicationNameForUserAgent`（见 1.5） | 9 |

Hotwire Native（37signals 的 HEY、Basecamp 就是网页壳）可以作先例，但它绑定 Turbo：页面没有 `window.Turbo` 就报错并在 30 秒后判为加载失败，不适合我们的 React 单页应用 [T6]。

结论：
- 这么窄的范围，纯 WKWebView 更简单：**不加任何依赖**，不碰 npm、SPM、CocoaPods，这台 Mac 只用已有的 Xcode 27.2。
- Capacitor 的长处（跨平台插件接口、打包本地网页）我们用不上，缺的那几样也还得自己写。
- 什么时候改主意：很快要做 Android、并且想两端共用一套插件接口时。

### 1.2 登录 cookie 在壳里能不能一直留着

结论：能。和 Safari 里一样，会话照我们自己的规则过期；有少量“cookie 丢了”的报告，丢了就是重新登录，不会出错。

- 默认的数据存储（`WKWebsiteDataStore.default()`）会把数据持久写到磁盘 [T16]。iOS 15 起 `WKProcessPool` 不再起作用，不用管它 [T16]。
- 跟踪防护（ITP）在 iOS 14 起对所有 WKWebView 应用默认打开 [T14]。但它“7 天删存储”的规则：
  - 只影响脚本写的 cookie（`document.cookie`）和脚本写的存储；**服务端用 Set-Cookie 种下的 httpOnly cookie 不受影响** [T17]。我们的会话 cookie 就是这种。
  - 原生应用里怎么算“使用天数”，WebKit 没说（**未核实**）。我们的网页不靠 localStorage 保存登录，所以影响不到登录。
- 两种服务端 cookie 的 7 天上限，同源的站点一般碰不到：
  - 来自第三方 IP 的响应 [T18]：页面和接口是同一台主机，IP 相同。
  - CNAME 伪装 [T17]：iOS 27.2 之前，如果主机名 CNAME 到另一个可注册域名，**顶层导航的响应**种的 cookie 也可能被限成 7 天，27.2 修了。我们是用 fetch 登录，不是表单跳转。
  - 生产域名是不是 CNAME 到托管商的域名，这里没查（**未核实**）。真机验收时登录后在 Web 检查器里看一眼 cookie 的过期时间。
- 会话本身：7 天（`auth.ts:20`），Better Auth 默认每天用一次就续期（`updateAge` 默认 86400 秒，本地 1.7.25 的代码里看到的）。所以每周至少打开一次的人一直保持登录，超过 7 天没开的要重新登录。网页端今天也是这样。
- 已知的丢 cookie 报告（苹果论坛，都没有定论）[T19]：
  - 用 `setCookie` 写入后很快被杀进程，cookie 没落盘。苹果工程师说完成回调不保证已写到磁盘，iOS 26 SDK 也没有刷盘的接口。我们不用原生去写 cookie。
  - iOS 18.5–26.0 上，没过期的、服务端种的第一方 cookie 用了 1–4 周后被删，原因不明，苹果请报 bug。
  - 社区的经验：一定写 Expires 或 Max-Age。Better Auth 1.7.25 种会话 cookie 时带 Max-Age（等于 `expiresIn`，见它的 `dist/cookies/index.mjs:49`），符合这条。
  - Safari 27.3 beta 修了 `Expires` 用 `Date.prototype.toString()` 格式时被当成会话 cookie 的问题。用 Max-Age 或 RFC 1123 的日期就没事。
- 应用更新时：苹果的老技术说明保证 Documents 和 Library（不含 Caches）在更新时保留 [T16]；WebKit 把 cookie 存在哪个目录，苹果没写明（**未核实**），真机上要验：装新版本以后还在登录状态。

### 1.3 4.2（最低功能）在实际审核里

条文 [R1]：
- 4.2：应用要有超出“重新包装的网站”的功能、内容和界面；
- 4.2.2：不能主要是网页剪辑、内容聚合或链接合集。

苹果自己的说法：把网站塞进 iOS 应用，做不成好应用 [R3]。

实际案例 [R4]：
- 苹果的拒信模板（论坛转引，2018–2020）：光靠推送、定位、分享这几样，体验还不够。**光有推送不够。**
- Ionic 论坛 2020-12：一个应用因“内容大多链到 Safari”被拒两次。第三次通过前做了这些：去掉外链；界面更像原生，内容更多；改进离线；在审核备注里讲清用途。
- Reddit（日期**未核实**）：被 4.2.2 拒后，在备注里列出原生功能就改判了。

代做网页壳的厂商（都是**厂商说法**）[R5]：
- 建议：原生导航、断网页、深链、和真实事件挂钩的推送、写清楚的备注。
- 要去掉网站的痕迹：站点页眉页脚、cookie 横幅、“下载我们的应用”横幅、跳 Safari 的外链。
- Capgo 认为打包本地网页比指向线上站点更稳。

对我们：
- 网页端本来就是应用式界面：手机上有底部标签栏，没有站点页眉页脚，没有 cookie 横幅，没有“装应用”的提示（grep 过：没有 manifest、`beforeinstallprompt`、`standalone`）。
- 外链只有引用和消息里的链接（`WebSources.jsx:37`、`cites.jsx:42`、`Markdown.jsx:37`）。壳里用应用内的 Safari 视图打开，不把人带出应用。
- 能拿出来给审核看的原生能力：
  - 推送，点开直达会话；
  - 角标；
  - 通用链接；
  - 保存、分享；
  - 断网页；
  - 选照片、文件；
  - 年龄信号（1.6）。
- 审核备注要逐条写出这些，演示账号里要有内容（第 4 节）。
- 能不能过**没有保证**。被 4.2 拒了，就先补原生能力和备注再提交；真不行才走退路（打包）。

### 1.4 手机版面在 WKWebView 里

我们的版面：`.app` 是 `100dvh`、`overflow: hidden`，各列自己滚动；安全区用 `env(safe-area-inset-*)`（`styles.css:78–80`）；视口 meta 已有 `viewport-fit=cover`；图片查看器用 `visualViewport`（`ui/visualViewport.js`）。

| 项 | 事实 | 我们怎么做 |
|---|---|---|
| 边缘右滑返回 | `allowsBackForwardNavigationGestures` 默认关。2022 年起，WebKit 在后退 / 前进时跳过**不是用户操作时**用 `pushState` 加的历史项；在 iOS 16 上回应的 WebKit 工程师说这是有意的新行为 [T20] | 打开。我们的 `pushState` 在 `state/appHistory.js:106`，大多由点按触发；程序自己跳转（不是点按触发）的那几处，右滑会跳过，验收单上逐个试。有报告说 iOS 17.5.1 起右滑偶尔跳回第一页（**未核实**） |
| 下拉刷新 | WebKit 自 Safari 16 支持 `overscroll-behavior`；应用自己设的 `bounces` 不会被它覆盖 [T21]。内层滚动容器和 `UIRefreshControl` 怎么配合，**未核实** | **不做下拉刷新**：外层页面本来不滚；消息靠 socket 实时到；连不上有断网页和“重试”。外层回弹**保持系统默认**：v0 在模拟器上实测，关掉 `bounces` 以后键盘弹出时输入框被键盘挡住，Safari 和保持默认的壳都会把它推到键盘上方（2026-11-23） |
| 安全区 | `viewport-fit=cover` 就是把 WKScrollView 的 `contentInsetAdjustmentBehavior` 设成 never [T22]。没有浏览器工具栏，底部只剩主屏指示条那一条 | 照现有 CSS 就行。已知 bug：WKWebView 里 `env()` 的值要过一会儿才有（2018 年起未修）[T22]，所以启动画面盖到 `didFinish` 之后再揭开。iOS 27.2 真机丢左右边距的报告（**未核实**）：第一版只做竖屏 |
| 键盘 | 和 Safari 一样：布局视口不变，`visualViewport` 跟着变 [T23]。`interactive-widget` 只在 Safari 27.3 beta 里有，正式版没有 [T23]。表单上方那条“上一项 / 下一项 / 完成”没有公开接口可以去掉 [T23] | 照现有网页做法，不靠 `interactive-widget`。那条栏保留。iOS 26.0 有收起键盘后视口变小的 bug，26.1 修了 [T23] |
| 选照片、选文件 | iOS 的菜单（WebKit 源码）[T24]：总有“照片图库”（系统的照片选择器，不用相册权限）和“选取文件”；有相机时再加一项：只收图片是“拍照”，不限类型（我们的“选择文件”）是“拍照或录像” | 要写相机和**麦克风**两条用途说明：“拍照或录像”缺了麦克风说明会崩（苹果技术支持 2020 年的回答）[T24]。不要相册读取权限 |
| 存到相册 | 分享面板里的“存储图像”要 `NSPhotoLibraryAddUsageDescription`；没写的话，有报告说会崩，也有报告说这一项不出现 [T24] | 写上 |
| 进后台 | WebKit 在场景**进入后台**时把页面设为隐藏，只是变成非活跃（拉下控制中心）不算 [T25]。被系统杀掉时 `pagehide` 不触发，这是设计如此。挂起后 socket 是被关掉还是半开着，**未核实**。iOS 26 有一个未修的 bug：恢复后新建的 WebSocket 一直卡在连接中 [T25] | 原生在 `sceneDidEnterBackground` 发 `haiyo:pause`，网页关 socket；在 `sceneWillEnterForeground` 发 `haiyo:resume`，立刻重连。`sync.js` 现在没有“连接超时”，S9 加一个（比如 10 秒没连上就放弃重来） |

### 1.5 网页怎么知道自己在壳里（不分两套代码）

- 壳设置 `applicationNameForUserAgent`，在默认值后面追加 `HaiyoApp/<版本>`。iOS 的默认值是 `Mobile/15E148`，直接设会把它替换掉，所以要追加 [T13]。这个标记只用来认壳，不能当权限依据（可以伪造）。
- 壳只在自己的源上挂消息处理器 `haiyo`。网页用 `window.webkit?.messageHandlers?.haiyo` 判断，这和 Capacitor 自己判断平台的办法一样 [T2][T13]。
- 网页端只加一个模块 `app/web/src/shell.js`：
  - 在浏览器里 `shell` 是 `null`，每个调用都什么也不做；
  - 在壳里，它把“登记推送、设角标、收暂停 / 恢复事件”交给原生。
  - 同一份构建、同一套路由。只有用到这几样能力的地方问一句 `shell`。
- 没有“添加到主屏幕”的提示要藏（见 1.3）。
- 不开 App-Bound Domains：开了以后，不在名单上的域名禁止注入脚本和使用消息处理器，导航也会被限制；不开则保持 iOS 14 以前的行为 [T14]。我们只有一个源，用不上。

### 1.6 审核条款：按评审改正以后

指南页 “Last Updated: October 16, 2026” [R1]，DPLA “last updated October 29, 2026” [R2]。

| 条 | 现在的写法（转述） | 对我们 |
|---|---|---|
| 2.5.2 + DPLA 3.3.1(B) | 2.5.2 不许下载代码来增加或改变功能；DPLA 3.3.1(B) 允许下载解释执行的代码，只要不改变应用的主要用途、不绕过安全机制、不做应用商店。现行 DPLA 不再点名 WebKit | **初稿说“加载线上站点有 2.5.2 风险”没有依据，撤回。** 加载自己的站点、用途不变，属于 3.3.1(B) 允许的情况（**推断**，苹果没对网页壳单独表态） |
| 2.5.19（2026-10-16 新增） | 不许有隐藏的、休眠的或没写明的功能 | 打包的应用用服务端开关打开新功能，一样会碰到（评审说得对）。我们的规矩见第 3 节 S9 后面的“上线规矩” |
| 1.2 | 现在写明也适用于 AI 内容创作类应用；四样：过滤、举报并及时处理、拉黑、公开联系方式。2026-02-06 起随机 / 匿名聊天也算；2026-10-16 起加了未经同意的私密影像（含 AI 生成），收到通知不改按违规处理 | **按 1.2 提交**：Agent 是用户自己写设定、自己选模型的用户内容 |
| 4.7 | 管的是“不嵌在二进制里的软件”，点名 chatbots；4.7.4 要目录和通用链接，4.7.5 要按年龄限制 | 用户建的 Agent 算不算 4.7 的 chatbot，是解读，苹果没有定义（**未核实**）。按 1.2 提交，不按 4.7 做目录；4.7.3 的“每次同意”用 5.1.2(i) 的同意来覆盖 |
| 2.2、2.1 | 演示版、测试版、试用版不该上 App Store；2.1 不许有占位文字和临时内容 | 应用里和商店资料里都不出现“内测 / 测试版 / beta / 试用”（明令禁止这个词**未核实**，按保守做） |
| 3.2.2(v) | 不能任意限制谁能用这个应用（比如按地区或运营商） | 邀请制算不算“任意限制”**未核实**。对策：审核备注说明邀请制是防滥用；给演示账号。要不要在应用里开放注册**待定**（第 8 节） |
| 5.1.1(i) | 隐私政策要写清收集什么、怎么用、第三方受同等保护、保存多久、怎么删，以及用户怎样撤回同意、要求删除 | S2 的隐私政策照这个写 |
| 5.1.1(ii) | 要有容易找到、容易看懂的撤回同意的办法 | **撤回同意要做**（S3） |
| 5.1.1(v) | 能注册就要能在应用里删除账号；只停用不行；网页流程要直接链到删除页 [R8] | S7 |
| 5.1.2(i)（2025-11-13 起） | 个人数据给第三方（包括第三方 AI）要先讲清楚、先拿到明确许可 | S3 |
| 4.5.4 | 推送不能是使用的前提；推送里不放敏感信息；营销推送要单独同意并能退订 | 推送只写“你有新消息”，不发营销推送 |
| 2.1(a) | 要给演示账号，并且后端要开着；内置演示模式要苹果事先同意 | S8 用真账号，不做演示模式 |

年龄（18+ 也要做）：
- **德州 SB 2420 已生效** [L5]：
  - 2025-12-23 地区法院发了禁令，苹果暂停了相关功能；
  - 2026-06-04 第五巡回法院批准在上诉期间暂停禁令；
  - 2026-07-06 最高法院拒绝撤销这个暂停（25A1390）；
  - 苹果说 2026-06-04 起新的德州 Apple 账号受此约束。
  - 上诉的实体判决**未核实**。
- 其他州 [L6][L7][L8][L9]：
  - 犹他：开发者义务推迟到 2027-05-06（HB 498）；苹果 2026-02-24 的通知还写着 2026-05-06。
  - 路易斯安那：原法被 2026 年的 HB 977 取代，2027-07-01 生效；苹果写的 2026-07-01 已过时。
  - 加州 AB 1043：2027-01-01 起，应用下载并启动时要向系统要年龄信号。
- 苹果对 18+ 应用的说法 [L4]：
  - 法律要求的地方，18+ 应用也要用 Declared Age Range API；
  - 年龄限制由开发者自己负责；
  - 要用 iOS 26.2 SDK / Xcode 26.2 以上构建（本机 Xcode 27.2 满足）。
- 年龄分级 [R9]：苹果要求把 AI 聊天功能考虑进分级。2026-11-16 起新增 “Dating and Relationships” 描述项（含提供性或恋爱内容的虚拟伴侣），选了就至少 18+；所有应用要在 2027-01-12 前答完。
- COPPA [L10]：只管面向 13 岁以下的服务，或者确实知道收集了这个年龄的人的数据。成人应用不在其内；但如果年龄信号显示未满 13 岁，就算“确实知道”了（**推断**）。
- 2026-02-24 起，18+ 应用在澳大利亚、巴西、新加坡对没确认成年的用户不可下载 [R9]。

## 2. 原生层：范围很小

放在仓库的 `app/ios/`，Swift + UIKit（场景式应用），**只用苹果框架，不加任何包**。只做 iPhone，只做竖屏。

### 文件

| 文件 | 做什么 |
|---|---|
| `Haiyo.xcodeproj` | 工程文件，手写，用 `xcodebuild … -sdk iphonesimulator build` 验证 |
| `Haiyo/Config.swift` | 站点源：Debug 构建用测试站点，Release 构建用生产站点；壳的版本号 |
| `Haiyo/AppDelegate.swift` | 推送令牌回调、通知代理 |
| `Haiyo/SceneDelegate.swift` | 窗口；通用链接（冷启动和运行中）；进后台、回前台 |
| `Haiyo/ShellViewController.swift` | WKWebView 本体：导航规则、新窗口、下载 → 分享面板 |
| `Haiyo/Bridge.swift` | `haiyo` 消息处理器：只认自己源上的主框架 |
| `Haiyo/Push.swift` | 推送权限、登记、令牌转十六进制、环境（sandbox / production） |
| `Haiyo/AgeSignal.swift` | Declared Age Range API（iOS 26） |
| `Haiyo/OfflineView.swift` | 原生断网页，带“重试” |
| `Info.plist`、`PrivacyInfo.xcprivacy`、`Haiyo.entitlements` | 见下 |
| `Assets.xcassets` | **AppIcon 一张 1024 的位置留给临时图标**；背景色和网页一致 |
| `HaiyoTests/` | 纯逻辑的单元测试：来源检查、推送和链接到站内路径的换算、错误码归类、UA 字符串 |

### 桥（第 1 版；以后只加不改）

网页调原生（有回复）：
- `hello` → `{ shell, build, os, push }`（`push` 是 granted / denied / notDetermined）
- `push.register` → 必要时请求权限 → `{ token, env }` 或 `{ denied: true }`
- `badge.set { n }`
- `age.range` → `{ range: "adult" | "minor" | "declined" | "unavailable" }`

原生通知网页（在 `window` 上派发事件）：
- `haiyo:pause`、`haiyo:resume`
- `haiyo:open { path }`（点了推送，或者运行中打开了通用链接）

每条消息先查：是主框架，而且 `securityOrigin` 是自己的源；不是就丢掉 [T7]。

### 行为

1. **启动**：加载站点源，冷启动带来的通用链接或推送路径直接拼上。启动画面一直盖着，到 `didFinish` 之后再揭开（1.4 的安全区 bug）。
2. **导航**：
   - 同源在原处打开；
   - 别的 http(s) 用应用内的 `SFSafariViewController`；
   - `mailto:`、`tel:` 交给系统。
3. **新窗口**（`target=_blank`）：
   - 同源的（图片查看器的“原图”，`ImageViewer.jsx:255`）在一个底部弹出的第二个 WKWebView 里打开，用同一个数据存储，cookie 通用，带“关闭”；
   - 外站用 `SFSafariViewController`。
4. **下载**：`<a download>`（`FileCard.jsx:92`、`messageActions.js` 的 `save`，都是同源地址，不是 `blob:`）→ `WKDownload` 存到临时目录 → 弹分享面板（存到“文件”、存储图像、隔空投送……）→ 用完删掉。
5. **推送**：
   - 登录后由网页调 `push.register` 才请求权限，不在第一次打开时就要；
   - 应用在前台时不弹横幅（socket 已经送到）；
   - 点了通知 → `haiyo:open { path: "/chat/<会话 id>" }`。
6. **进后台 / 回前台**：
   - `sceneDidEnterBackground` → `haiyo:pause`；
   - `sceneWillEnterForeground` → `haiyo:resume`；
   - 只是变成非活跃（拉下控制中心）不算。
7. **连不上**：`didFailProvisionalNavigation` 遇到网络类错误码就显示断网页；网页进程崩了就重载（1.1 的表）。页面已经打开以后网络断了，由网页自己的“重新连接中”处理（`sync.js`）。
8. **手势与滚动**（1.4）：打开边缘右滑返回；外层回弹保持默认（关掉会让键盘挡住输入框）；不做下拉刷新。
9. **年龄信号**：iOS 26 的 Declared Age Range API，结果经桥交给网页（S9）。
10. **用户代理**：在默认值后追加 `HaiyoApp/<版本>`（1.5）。

### Info.plist、权利、隐私清单

- 用途说明 [R15][T24]：
  - `NSCameraUsageDescription`：发照片时拍照；
  - `NSMicrophoneUsageDescription`：发文件时录像（“拍照或录像”）；
  - `NSPhotoLibraryAddUsageDescription`：把图片存到相册。
  - 不要 `NSPhotoLibraryUsageDescription`：系统的照片选择器不用这个权限。
- `ITSAppUsesNonExemptEncryption = NO`（第 4 节）。
- 权利文件：`aps-environment`；`com.apple.developer.associated-domains = applinks:<站点主机>`。这两项要主人的 Team ID 才能签名，模拟器构建不需要。
- `PrivacyInfo.xcprivacy`：
  - `NSPrivacyTracking = false`；
  - 收集的数据类型和 App Privacy 的答案一致；
  - 壳在原生侧不存东西（不用 UserDefaults），“需要声明理由的 API”一栏是空的。如果以后用了 UserDefaults，就声明理由 CA92.1 [R12]。

### 不做（第一版）

- 推送正文解密（Notification Service Extension）；
- 分享扩展、小组件；
- iPad 版面、横屏；
- Android；
- 应用内购买；
- 离线读历史。

### 能在这台 Mac 上验到哪一步

- 模拟器构建不需要签名，也不需要 Apple 账号。
- 推送点开可以用 `xcrun simctl push` 加一个负载文件模拟。
- 模拟器能不能拿到真的 APNs 令牌**未核实**；通用链接要真域名上的 AASA 加上带 Team ID 签名的权利文件。这两样、年龄信号，都留到主人的内部 TestFlight 在真机上验。
- 估算：**5 agent-日**：
  - 工程、WebView、导航：1；
  - 桥、推送、角标：1；
  - 下载、分享、新窗口：1；
  - 通用链接、断网页、年龄信号：1；
  - 测试、模拟器验收、plist 和隐私清单：1。

## 3. 服务端与网页：分道

规矩照旧（`docs/dev/lane-rules.md`）：先写测试；不加新依赖；不删库；不在日志里记消息正文；每道一个分支；每道都在 `app/service/README.md` 写明。

### 一览

| 道 | 做什么 | 依赖 | 和 Agent 社交 / harness 能否并行 | agent-日 |
|---|---|---|---|---|
| S1 通用链接文件 | `/.well-known/apple-app-site-association` | 无 | **能**（只动 `web.ts`） | 0.5 |
| S2 条款、隐私、联系；注册时同意和 18+ 声明 | 三个公开页；记版本 | 主人认可文本 | **能**（`register.ts`、`Settings.jsx`、新页面） | 1.5 |
| S3 第三方 AI 同意与撤回 | 记同意、能撤回、撤回后的处理 | S2（同一个同意流程）；主人定口径 | **要协调**：把某人的发言排除出 Agent 上下文要动 `agents/context.ts` 和记忆，是 harness 的地方 | 2.5 |
| S4 举报与过滤 | 复用社交设计的 `agent_reports`；词表过滤 | 社交设计的举报表 | **要协调**：表只建一次，谁先做谁照社交设计建 | 2.5 |
| S5 推送设备与 APNs 发送 | `push_devices`、发送器、按会话判断 | 无（角标数等 S6，先发不带数的） | **能**（新文件；只在 `hub.ts` 的 `onMessages` 挂一处） | 3 |
| S6 服务端未读数（角标） | 和网页同一规则的未读总数 | 社交道 3(a)（它要改未读） | **排在社交道 3(a) 之后**，或者并进那一道 | 1 |
| S7 删除账号 | 28 个限制外键、社交新表、磁盘上的文件 | 钱包道和社交道的表都合进来以后 | **最后做**；守卫测试可以先放 | 3.5 |
| S8 演示账号 | 生产环境给审核用的账号 | S2、S3（演示账号也走同意） | **能** | 1 |
| S9 网页里的壳适配 | 认壳、登记推送、暂停时关 socket、角标、年龄信号、设置里的新入口 | S5 的接口；各入口跟各自的道 | **能** | 2 |

合计 17.5 agent-日。现在就能开工的：S1、S2、S5、S8、S9 和原生壳（第 2 节）。

### S1 通用链接文件（0.5）

- 现状：`web.ts` 的 `segmentsOf` 遇到以 `.` 开头的段就返回 null；最后一段又没有扩展名，于是回落成 `index.html`。所以 `/.well-known/apple-app-site-association` 现在返回的是网页。
- 做法：在通配路由之前单独注册一条 `GET /.well-known/apple-app-site-association`。
  - 内容由配置 `APPLE_APP_ID`（`<Team ID>.<bundle id>`，不是密钥）生成；
  - `content-type: application/json`；不重定向；没配就返回 JSON 404。
  - 路径：`/chat/*`、`/reset-password*`；排除 `/api/*`。验证邮箱的链接先到 `/api/auth/verify-email`（在排除之列），照旧用浏览器打开。
- 苹果经自己的 CDN 去取这个文件 [T11]。
- 测试：返回 JSON 而不是 HTML；没配时 404；HEAD 也对。

### S2 条款、隐私、联系；注册时同意和 18+（1.5）

- 网页：`/terms`、`/privacy`、`/contact` 三个公开路由，不登录也能打开（审核和商店资料要链到这里）。
  - 文本我们起草，主人认可；这不是法律意见。
  - 语言：中文加英文；日文**待定**。
- 隐私政策照 5.1.1(i) 写：
  - 收集什么、用来做什么；
  - 交给谁：模型供应商，包括站点模型和成员自己的供应商；
  - 保存多久、怎么删、怎么撤回同意；
  - 联系 support@haiyo.org。
- 服务端：`register.ts` 收 `termsVersion` 和 `adult: true`（自报已满 18 岁），新迁移记下 `terms_version`、`terms_accepted_at`、`adult_declared_at`。
  - 老用户下次登录时弹一次，必须同意才能继续；`GET /api/me` 带出所需的版本号。
- 联系页写 support@haiyo.org 和举报的处理承诺（时限**待定**）。

### S3 第三方 AI 同意与撤回（2.5）

- 现状：
  - 模型选择处写了“你与它的对话内容……会发送给所选模型的服务商”（`ModelPicker.jsx:22`）；
  - 但群里**别人**的发言也会进 Agent 的上下文，这一点没有告诉他们。
- 记录：每人一条 `ai_consent`（版本、同意时间、撤回时间）。
- 什么时候问：
  - 第一次和任何 Agent 说话前；
  - 第一次进入有 Agent 的群时；
  - 已经在这种群里的老用户，下次打开时问一次。
  - 说明里写：消息会交给哪类模型供应商；群里别人的 Agent 也会读到你的发言。
- 撤回：设置 → 隐私 → 撤回 AI 数据同意。撤回之后怎么办是主人的口径（**待定**）。建议：
  - 你的发言不再进入任何 Agent 的上下文和记忆处理；
  - 你不能再叫 Agent；
  - 再次同意后恢复。
- 这要动 `agents/context.ts` 和记忆处理，和 harness 的工作重叠，要排在它后面或者由它来评审。

### S4 举报与过滤（2.5）

- 举报：复用 Agent 社交设计的 `agent_reports`，表和接口只做一套。
  - 设计在工作分支的 `docs/design/2026-11-23-agent-social-design.md`。这台 Mac 上没有这份文件，下面按评审的转述写。
  - 举报对象要能覆盖消息、人、Agent、群；社交设计里没有的，在那张表上补，不另建表。
- 入口：
  - 消息长按菜单（`messageActions.js`）；
  - 成员资料页、Agent 资料页、群信息页。
- 处理：
  - 放进站点管理台（分支 lane/mac-admin-design 的管理台草稿）；管理台出来之前，先用命令行列出和处理。
  - 新举报发信到 support@haiyo.org。信里只放举报编号和链接，不放消息正文。
  - 承诺时限（例如 24 小时）**待定**。
- 过滤（1.2 要求“有办法过滤”）：
  - 最小版是一个可配置的词表，人发消息时和 Agent 输出发出前各过一次；
  - 命中就拦下并告诉发送的人，只计数，不记正文；
  - 具体策略**待定**。
- 拉黑已有（`blocks` 表、`BlockModal.jsx`）。推送要跳过被拉黑的人发来的消息（S5）。

### S5 推送设备与 APNs 发送（3）

- 新表 `push_devices`：
  - `id`；
  - `principal_id`（→ principals，删除时级联）；
  - `session_id`（→ Better Auth 的 `session`，删除时级联：退出登录或会话结束，设备就跟着没了）；
  - `token`（唯一）、`env`（sandbox / production）、`app_version`；
  - `created_at`、`last_seen_at`、`disabled_at`。
- 接口：
  - `POST /api/push/devices { token, env, appVersion }`：绑定到当前会话；按令牌 upsert，换账号或换会话就改绑。
  - `DELETE /api/push/devices/current`。
- 发给谁：在 `hub.ts:389` 的 `onMessages`，消息存好以后——
  - 每个人类成员，发送者自己除外；
  - 和发送者之间有拉黑（任一方向）的跳过；
  - 不计入未读的跳过（系统消息、Agent 的确认）；
  - 这个人的每台设备：**它的会话在 `bySession`（`hub.ts:141`）里没有活着的 socket**，就发。
- 为什么按会话：同一个人桌面浏览器开着、手机应用在后台时，手机也要收到推送。按“这个人在不在线”判断就会漏掉（评审指出的）。
- 壳暂停时网页主动关掉自己的 socket（S9），服务端立刻知道它没了。不这样做，挂起的应用的 socket 会“看起来还活着”一段时间，推送就被跳过（评审指出的）。现有心跳每 30 秒一次（`hub.ts:29`），不回应的连接要到下一次心跳才清掉，也就是 30–60 秒。
- 发送：
  - `node:http2` 连 `api.push.apple.com`（开发构建用 sandbox）；ES256 JWT 用 `node:crypto` 签，20–60 分钟换一次 [T15]。**不加依赖。**
  - 头：`apns-topic`（bundle id）、`apns-push-type: alert`、`apns-collapse-id`（会话 id）、`apns-priority: 10`。
  - 回 410 或 `BadDeviceToken`，就写 `disabled_at`。
- 内容（不带正文，不带发送人）：
  ```json
  { "aps": { "alert": { "title": "Haiyo", "body": "你有新消息" }, "badge": 3, "sound": "default", "thread-id": "<会话 id>" }, "c": "<会话 id>" }
  ```
- 配置：`APNS_KEY_P8`（或文件路径）、`APNS_KEY_ID`、`APNS_TEAM_ID`、`APNS_TOPIC`。只放在部署环境里，由主人放（第 5 节）。没配就不发，别的照常。
- 测试：测试里起一个本地 HTTP/2 假 APNs，用测试时生成的密钥签名。不碰真密钥。

### S6 服务端未读数（角标）（1）

- 现状：未读只在浏览器里算（`model.js:229` 的 `countsAsUnread`，`selectors.js` 的 `unreadTotal`，`AppShell.jsx:30`）。服务端没有。
- 做法：`unreadTotal(principalId)`，规则和网页一样：
  - `memberships.read_seq`（`002_core.sql:92`）之后的消息；
  - 不是系统消息，不是确认；
  - 有发送者，并且不是自己。
- 一条规则写在两处，就用一份共同的用例表，网页测试和服务端测试都读它，免得两边走样。
- 社交道 3(a) 要改同步和未读，所以 S6 排在它后面，或者干脆并进去。
- 应用开着时，网页用自己算出的数经桥设角标（S9），所以读完消息角标就清了；推送里带的是服务端的数。

### S7 删除账号（3.5）

- 本机 e2e 库：指向 `principals` 的外键有 28 个是限制删除的（另有 16 个级联，2 个置空）；还有 `principals.auth_user_id → "user"` 也是限制删除。按用途分：
  - 登录：`accounts.principal_id`、`principals.auth_user_id`；
  - 社交：`friendships.a_id / b_id`、`friend_requests.from_id / to_id`、`blocks.blocker_id / blocked_id`、`direct_pairs.a_id / b_id`；
  - 群和消息：`conversations.creator_id`、`memberships.principal_id`、`messages.sender_id`、`attachments.uploader_id`、`invites.used_by`、`reserved_handles.principal_id`；
  - Agent：`principals.owner_id`（自己的 Agent）、`agents.(kind, principal_id)`、`agent_conversations.agent_id / owner_id`、`agent_runs.agent_id / owner_id`、`persona_proposals.agent_id`；
  - 钱和用量：`balance_ledger.owner_id`、`free_usage.owner_id`、`memory_usage.owner_id`、`usage_records.agent_id / owner_id`、`providers.owner_id`。
- 再加上社交设计新加的表，以及磁盘上的文件（附件、头像）。
- 要主人定（**待定**）：
  - 群里发过的消息：删掉，还是保留并显示成“已注销用户”？苹果要求删掉相关数据 [R8]。
  - 账本：为了对账要不要留下匿名的记录？
- 做法：`POST /api/account/delete { password }`，一个事务：
  - 结束会话和 socket（`hub.endSession`）；
  - 删推送设备、自己的供应商和密钥、自己的 Agent（含记忆和运行记录）；
  - 删好友、好友请求、拉黑、私聊配对；
  - 退出所有群：自己建的群转给最早的成员，空群删掉；
  - 消息按主人的决定处理；
  - 删主体和 Better Auth 的用户行；
  - 事务提交以后删文件，再发确认信。
- 守卫测试：查 `pg_constraint`，列出所有指向 `principals` 的外键，有一个没在删除代码的清单里，测试就失败。以后的道加新表，就不会悄悄弄坏删除。
- 网页：设置 → 账号 → 删除账号（输密码、明确确认）。浏览器和壳是同一个页面，满足 5.1.1(v) “网页流程要直接链到删除页”。
- 排在最后：钱包道和社交道的表合进来以后。

### S8 演示账号（1）

- 命令 `demo:seed`，主人在生产环境上跑：
  - 一个审核用账号，密码随机生成，只在主人的终端里显示一次；
  - 已经同意条款和 AI 数据，已声明 18+；
  - 一个演示群，两位演示成员，一个用站点模型、有每日额度的 Agent；
  - 几条合成的消息和图片，不用任何真实用户的数据。
- `demo:reset`：每次提交审核前恢复原样。
- “不能过期”（苹果的要求）：会话 7 天（`auth.ts:20`），过期了重新登录就行，账号本身不过期。

### S9 网页里的壳适配（2）

- `app/web/src/shell.js`（1.5）。
- 推送：
  - 在壳里登录以后调 `push.register`，再 `POST /api/push/devices`；
  - 退出登录时 `DELETE`，并把角标清零。
  - 不在第一次打开时就要推送权限。
- socket：`data/sync.js` 现在不管页面可见性。
  - 收到 `haiyo:pause` 就正常关掉 socket，不重连；
  - 收到 `haiyo:resume` 就立刻连上，走现有的重连流程（`/api/sync` 补缺口）。
  - 浏览器里不会有这两个事件，行为不变。
  - 加一个连接超时（比如 10 秒没连上就放弃重来）：iOS 26 上恢复后新建的 WebSocket 可能一直卡在连接中（1.4）。
- 角标：`unreadTotal` 一变就调 `badge.set`。
- 跳转：`haiyo:open { path }` 交给现有的地址导航（`state/location.js`），不整页重载。
- 年龄信号：在壳里注册或第一次登录时调 `age.range`，把结果交给服务端（`POST /api/me/age-signal`）。
  - 未满 18：拒绝，并说明原因；
  - 用户不肯给或系统给不出：怎么处理**待定**（法律对这种情况的要求**未核实**）。
- 设置里的新入口来自 S2、S3、S4、S7，浏览器和壳一样。
- socket 上限：每人 5 个（`hub.ts:27`），壳算一个，不用改。

**上线规矩（为 2.5.19）**（**推断**，**待定**主人同意）：
- 新功能照常发到站点；
- 每一批用户看得见的新功能，都写进下一版 App Store 构建的“新内容”和审核备注。壳本身可以不变，只升版本号；
- 不做只给审核看的开关，也不对审核隐藏功能。

## 4. 商店侧清单

都在 App Store Connect 里填，主人确认后由主人提交（第 5 节）。条款号按指南页 “Last Updated: October 16, 2026”。

| 项 | 填什么 | 出处 |
|---|---|---|
| 名称、副标题 | 名称 “Haiyo”（2–30 字符）；副标题 ≤ 30 字符，**待定**；不出现 “beta / 测试版 / 内测 / 试用”（2.2；元数据里禁用这个词苹果没写明，按保守做） | [R1][R13] |
| 隐私政策 URL、支持 URL | `https://<站点>/privacy`、`https://<站点>/contact`（支持页要有真实联系方式：support@haiyo.org） | [R13] |
| App Privacy（隐私标签） | 收集：邮箱；用户内容（“文字消息”含非短信消息、照片、其他内容即文件）；标识符（用户 ID；推送令牌是否算 “设备 ID” 苹果没写明，按算处理）；诊断：不收就不填。都“与身份关联”，都**不用于追踪**。网页里收集的也要申报 | [R10] |
| 年龄分级 | 如实答 “用户生成内容”“消息与聊天”；没有专门的 AI 聊天问题，苹果要求把 AI 助手和聊天功能考虑进去；选 “Override to Higher Age Rating” → 18+（条款里写了 18+ 就必须这样选）；2026-11-16 上线的新描述项要在 2027-01-12 前答完 | [R9] |
| 出口合规 | Info.plist 写 `ITSAppUsesNonExemptEncryption = NO`（只用系统 HTTPS，属豁免）；不用上传文件 | [R11] |
| 隐私清单 | 壳里放 `PrivacyInfo.xcprivacy`：声明 UserDefaults（理由 CA92.1）等实际用到的“需声明理由的 API”；不追踪；不用第三方 SDK 就没有 SDK 清单的问题 | [R12] |
| 用途说明 | 见第 2 节的 Info.plist 键；缺了会崩，也会被拒（ITMS-90683） | [R15] |
| 审核信息 | 联系人姓名、邮箱、带国家码的电话；演示账号（不能过期）；备注（≤ 4000 字节，见下）；后端要一直开着（2.1(a)） | [R1][R13] |
| 店面 | 日本、美国、其他非欧盟；不含中国大陆、不含欧盟（第 6 节）。注意：18+ 应用在澳大利亚、巴西、新加坡对未确认成年的用户不可下载（2026-02-24 起） | [R9] |
| 价格 | 免费；第一版没有内购 | |

### 审核备注（草稿，主人改）

- Haiyo 是群聊应用：人和自己建的 AI 助手（Agent）在同一个对话里聊。
- 注册是邀请制；演示账号已备好，里面有一个演示群、两位演示成员、一个演示 Agent。
- 原生功能：新消息推送（点开直达会话）、角标、通用链接、保存/分享图片和文件、断网页、照片和文件选取。
- 用户内容与 AI：举报（长按消息 → 举报；成员资料页 → 举报）、拉黑、过滤、联系方式 support@haiyo.org；与 AI 共享数据前会征得同意，可在设置里撤回。
- 删除账号：设置 → 账号 → 删除账号。
- 仅限 18 岁以上。

## 5. 只有主人能做的事（按顺序）

前三步不急：模拟器构建不用签名，壳和服务端可以先做完。

1. **开发者账号**：确认个人会员有效、开了双重认证；在账号里接受最新的协议（DPLA 2026-10-29 版）[R2][L15]。
   - 卖家名就是法定姓名，不能用别名；改 Apple 账号上的名字不会改卖家名 [L15]。
   - 以后要转成组织：由账号持有人申请，要是组织的创办人，并且有 D-U-N-S 号码 [L15]。
2. **Bundle ID**：建议 `org.haiyo.app`（**待定**）。在开发者网站登记 App ID，勾选 Push Notifications 和 Associated Domains；也可以在第 3 步后交给 Xcode 自动处理。
3. **在这台 Mac 的 Xcode 里登录 Apple ID**（Xcode → Settings → Accounts）。真机运行、归档、上传都要；我不登录。
4. **APNs 密钥**：在开发者网站的 Keys 里建一个 .p8 密钥，记下 Key ID 和 Team ID。
   - 密钥由主人自己放进生产和测试站点的部署环境（S5 的四个变量）；
   - 我不看、不建、不传。
5. **App Store Connect 建应用记录**：名称 Haiyo、主要语言、bundle ID、SKU。
6. **定图标**（另一个会话会把候选做成图标大小给主人看）。
7. **认可文本**：条款、隐私政策、联系页、审核备注，以及第 4 节的隐私标签、年龄分级（选 18+）、出口合规答案。
8. **演示账号**：在生产环境跑 `demo:seed`；把账号、密码和联系电话（带国家码）填进审核信息。
9. **交易者身份**：提交时声明为**非交易者**（只在欧盟以外发行，第 6 节）。只有账号持有人或管理员能填。
10. **店面**：勾选日本、美国和其他非欧盟地区；去掉中国大陆和全部欧盟国家。
11. **内部 TestFlight**：在自己的 iPhone 上装，照第 7 节的验收单试一遍（推送、链接、保存、断网、年龄）。
    - 内部测试员最多 100 人，苹果的说明里没写要审核；外部测试最多 10,000 人，第一个构建要过 TestFlight 审核；构建 90 天后失效 [R14]。
12. **提交审核**；通过后手动发布。
13. （以后）上欧盟：照第 6 节改成交易者并通过核验。

## 6. 欧盟：个人开发者要公开什么

苹果的 DSA 说明 [L1][L2][L3]：
- **不在欧盟发行也要声明身份**；只在欧盟外发行的，苹果说这不算在 App Store 上“作为交易者”。所以现在声明非交易者是一致的。
- 2025-02-17 起，没有声明身份的应用从欧盟店面下架，补齐并核验后才恢复。
- “交易者”（DSA 第 3(f) 条）：为自己的生意、行业、手艺或职业而行事的人。
  - 苹果给的判断因素：有没有收入（内购、付费、广告），商业做法，增值税登记，是否以职业身份行事。
  - 自己判断，苹果建议问法律顾问。
  - **推断**：以后要卖点数，就是商业意图，那时应按交易者处理。
- 声明为交易者的**个人**要提供，并在 **27 个欧盟店面的产品页上公开**：
  - 地址（**可以是邮政信箱**）；
  - 电话；
  - 邮箱。
  - DSA 第 30(7) 条要求公开姓名、地址、电话、邮箱、商业登记（如有）和自我证明。
  - 另外要给付款账户信息，并证明遵守欧盟法律（这两样不公开）。
- 核验：
  - 邮箱和电话用验证码；收不到码的电话可以申请人工核验。
  - 地址要一份近期的文件，写着你的名字和地址；用邮政信箱等其他地址，还要证明你和它的关系（收据、账单）。
  - 苹果接不接受虚拟办公室地址，没有个人名下商业文件时能交什么，**未核实**。
- 以后能改：每个应用的身份可以改；实体地址要改得联系苹果。
- 声明为非交易者：不公开联系方式；欧盟用户会看到提示，说消费者保护权利不适用于和你订立的合同。
- 组织账号会自动在欧盟产品页上显示 D-U-N-S 登记的地址，而不是个人地址 [L15]。
- 欧盟以外：没找到哪里会公开个人开发者的地址。韩国的公开规则只针对设在韩国的开发者 [L15]。全部非欧盟店面都核一遍**未做**。

给主人的结论：上欧盟就要公开一个能收信的地址（邮政信箱也行）、一个电话和一个邮箱；卖点数之后基本上就得这样做。

### 日本（顺带查到的，和上架无关但相关）

- 移动软件竞争法（2025-12-18 全面施行）的义务落在苹果和谷歌身上，对普通开发者没查到义务 [L11]。
- **电气通信事业法**：总务省的手册说，给日本用户提供聊天，即使服务器在海外，也算“媒介他人的通信”，要登记或申报（届出）。[L12]
  - 前提是“经营”，也就是为了营利反复提供；免费的不算，但作为营利事业一部分的免费服务也可能算。
  - 个人按住址申报；海外的经营者要通过在日本的代理人申报。
  - 用户只和 AI 聊不算媒介（**推断**）。
  - 2023-06-16 起的“外部传送规则”也覆盖消息服务。通过 SDK 把用户数据传给第三方，要事先告知、取得同意，或者提供退出办法。
  - **网页端现在就已经面向日本用户，这件事和上不上架无关，请主人自己或找律师判断。**
- 特定商取引法：只管卖东西（通信贩卖）。现在不卖就不适用（**推断**）。以后卖点数时要公开姓名、实际营业地址和电话：只有邮政信箱不行；可以写“请求时立即提供”，但要真能做到 [L13]。
- AI 推进法（2025 年第 53 号）：第 7 条要求用 AI 的事业者配合国家的措施；所依据的指南是自愿性质的 [L14]。

## 7. 估算（agent-日）与验收

| 块 | agent-日 |
|---|---|
| 原生壳 N（第 2 节） | 5 |
| S1–S9（第 3 节） | 17.5 |
| 整合与验收 Q | 2 |
| **合计** | **24.5** |

- 并行：三条道同时开时，不算等社交道和 harness 的时间，大约 9–10 天能交给主人走第 5 节。
  - 第一波（现在就能开）：N、S1 + S2、S5、S9；
  - 第二波：S3、S4、S6，分别跟 harness 和社交道协调；
  - 最后：S7，然后 Q。
- 不算在内：苹果审核的等待时间；主人第 5 节各步的时间；被拒以后的返工。
- Q 的内容：
  - 合成一个整合分支；
  - 网页测试、服务端测试、e2e（Chromium 和 WebKit 各跑一遍）；
  - 模拟器验收单：第 2 节每一条行为都要过；
  - 推送点开用 `xcrun simctl push` 模拟（不需要真密钥）；
  - 真机才能验的（真 APNs、通用链接、年龄信号）留到主人的内部 TestFlight。

## 8. 还要主人定的事

1. **最低 iOS**：建议 26。
   - 年龄信号 API 从 26 起才有；
   - 2026-06 的统计里 iOS 26 占 79%[T26]；
   - 更旧的设备照样能用网页。
   - 另一个选项是 18，那么 18–25 上的年龄信号怎么处理还要另查。
2. **群里的历史消息**：账号删除时删掉，还是保留并显示成“已注销用户”（S7）？
3. **第三方 AI 同意的口径**：一次性同意还是按群同意；撤回后怎么处理（S3）？
4. **推送文案**：只写“你有新消息”（建议），还是显示群名或发送人？
5. **举报**：谁处理，承诺多久内处理（S4）？
6. **注册**：应用里也保持邀请制（审核用演示账号，备注里说明），还是开放？与 3.2.2(v) 的关系**未核实**。
7. **年龄信号给不出时**怎么办（S9）？
8. **上线规矩**（S9 末尾）同不同意？
9. **Bundle ID**：`org.haiyo.app` 行不行（第 5 节第 2 步）？
10. **日本电气通信事业法的申报**：要不要找律师确认（第 6 节）？
11. **条款和隐私政策的语言**：中文加英文，要不要日文（S2）？

## 出处

访问日期都是 2026-11-23。苹果的帮助和文档页面没有日期。

苹果审核与商店（R）：
- [R1] 审核指南（Last Updated: October 16, 2026）：https://developer.apple.com/app-store/review/guidelines/ 。相关新闻：https://developer.apple.com/news/?id=ey6d8onl （5.1.2(i)、4.7，2025-11-13）、https://developer.apple.com/news/?id=d75yllv4 、https://developer.apple.com/news/?id=a233fmpw 、https://developer.apple.com/news/?id=vvzx6cul （1.2 的更新）、https://developer.apple.com/news/?id=92th7e5i
- [R2] 开发者协议（last updated October 29, 2026）：https://developer.apple.com/support/terms/apple-developer-program-license-agreement/
- [R3] https://developer.apple.com/distribute/app-review/
- [R4] 4.2 案例：https://forum.ionicframework.com/t/200908 、https://forum.bubble.io/t/ios-app-rejected-by-apple/63734 、https://developer.apple.com/forums/thread/108931 （有机器人验证页，只看到搜索摘要）、https://www.reddit.com/r/iosdev/comments/1r19n4y
- [R5] 厂商说法：https://appsubmitter.io/app-rejection-guides/app-store-guideline-4-2-minimum-functionality/ 、https://www.mobiloud.com/blog/app-store-review-guidelines-webview-wrapper 、https://capgo.app/blog/how-to-pass-app-store-review-2026/
- [R8] 删除账号：https://developer.apple.com/support/offering-account-deletion-in-your-app/
- [R9] 年龄分级：https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions 、https://developer.apple.com/help/app-store-connect/manage-app-information/set-an-app-age-rating 、https://developer.apple.com/news/?id=ks775ehf 、https://developer.apple.com/news/?id=tlur8uvi 、https://developer.apple.com/news/?id=yxkh08us 、https://developer.apple.com/news/?id=f5zj08ey
- [R10] 隐私标签：https://developer.apple.com/app-store/app-privacy-details/ 、https://developer.apple.com/app-store/user-privacy-and-data-use/ 、https://developer.apple.com/help/app-store-connect/manage-app-information/manage-app-privacy
- [R11] 出口合规：https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance 、https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption 、https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations
- [R12] 隐私清单：https://developer.apple.com/documentation/bundleresources/privacy-manifest-files 、https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api 、https://developer.apple.com/support/third-party-SDK-requirements/
- [R13] 应用信息与 SDK 要求：https://developer.apple.com/help/app-store-connect/reference/app-information/app-information 、https://developer.apple.com/help/app-store-connect/reference/app-information/platform-version-information 、https://developer.apple.com/news/?id=ueeok6yw
- [R14] TestFlight：https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview 、https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers 、https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers
- [R15] 用途说明：https://developer.apple.com/documentation/uikit/requesting-access-to-protected-resources

技术（T）：
- [T1] Capacitor 配置与发布：https://capacitorjs.com/docs/config 、https://raw.githubusercontent.com/ionic-team/capacitor/8.6.2/cli/src/declarations.ts 、https://api.github.com/repos/ionic-team/capacitor/releases
- [T2] Capacitor 8.6.2 iOS 源码：https://github.com/ionic-team/capacitor/blob/8.6.2/ios/Capacitor/Capacitor/JSExport.swift 、…/WebViewDelegationHandler.swift 、…/CAPBridgeViewController.swift 、…/assets/native-bridge.js ；主分支 https://github.com/ionic-team/capacitor/blob/main/ios/Sources/Capacitor/WebViewDelegationHandler.swift
- [T3] https://github.com/ionic-team/capacitor/discussions/4080
- [T4] https://github.com/ionic-team/capacitor-plugins （push-notifications、share、app 的说明）、https://github.com/ionic-team/capacitor-filesystem
- [T5] https://ionic.io/blog/?p=6282
- [T6] https://github.com/hotwired/hotwire-native-ios 、https://dev.37signals.com/announcing-hotwire-native/ 、https://dev.37signals.com/announcing-strada/ 、https://dev.37signals.com/speeding-up-mobile-development-with-turbo
- [T7] 桥：https://developer.apple.com/documentation/webkit/wkscriptmessagehandlerwithreply 、https://developer.apple.com/documentation/webkit/wkframeinfo/securityorigin
- [T8] 推送与角标：https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/setbadgecount(_:withcompletionhandler:) 、https://developer.apple.com/documentation/uikit/uiapplication/registerforremotenotifications()
- [T9] 下载：https://developer.apple.com/documentation/webkit/wkdownload 、https://developer.apple.com/documentation/webkit/wknavigationaction/shouldperformdownload
- [T10] 新窗口：https://developer.apple.com/documentation/webkit/wkuidelegate 、https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller
- [T11] 通用链接：https://developer.apple.com/documentation/xcode/supporting-universal-links-in-your-app 、https://developer.apple.com/documentation/xcode/supporting-associated-domains
- [T12] 错误码：https://github.com/swiftlang/swift-corelibs-foundation/blob/main/Sources/Foundation/NSURLError.swift 、https://github.com/WebKit/WebKit/blob/main/Source/WebKit/Shared/API/c/WKErrorRef.h
- [T13] 用户代理：https://developer.apple.com/documentation/webkit/wkwebviewconfiguration/applicationnameforuseragent 、https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/WKWebViewConfiguration.mm
- [T14] https://webkit.org/blog/10882/app-bound-domains/
- [T15] APNs：https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns 、https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification
- [T16] 数据存储：https://developer.apple.com/documentation/webkit/wkwebsitedatastore/default() 、https://developer.apple.com/documentation/webkit/wkprocesspool 、https://developer.apple.com/library/archive/technotes/tn2285/_index.html
- [T17] 跟踪防护：https://webkit.org/blog/8613/intelligent-tracking-prevention-2-1/ 、https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ 、https://webkit.org/blog/11338/cname-cloaking-and-web-privacy/ 、https://developer.apple.com/documentation/safari-release-notes/safari-27_2-release-notes 、https://developer.apple.com/forums/thread/651138
- [T18] https://bugs.webkit.org/show_bug.cgi?id=246477
- [T19] cookie 丢失：https://developer.apple.com/forums/thread/832538 、https://developer.apple.com/forums/thread/805375 、https://developer.apple.com/forums/thread/745912 、https://developer.apple.com/documentation/safari-release-notes/safari-27_3-release-notes
- [T20] 右滑返回：https://bugs.webkit.org/show_bug.cgi?id=241885 、https://bugs.webkit.org/show_bug.cgi?id=241932 、https://bugs.webkit.org/show_bug.cgi?id=248303 、https://developer.apple.com/forums/thread/766975
- [T21] 回弹与下拉：https://developer.apple.com/documentation/safari-release-notes/safari-16-release-notes 、https://github.com/WebKit/WebKit/pull/2794 、https://bugs.webkit.org/show_bug.cgi?id=309439 、https://bugs.webkit.org/show_bug.cgi?id=275947
- [T22] 安全区：https://webkit.org/blog/7929/designing-websites-for-iphone-x/ 、https://go.mail-archive.com/webkit-changes@lists.webkit.org/msg239448.html 、https://bugs.webkit.org/show_bug.cgi?id=191872 、https://developer.apple.com/forums/thread/853762
- [T23] 键盘：https://developer.apple.com/documentation/safari-release-notes/safari-13-release-notes 、https://bugs.webkit.org/show_bug.cgi?id=259770 、https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/API/Cocoa/_WKFormInputSession.h 、https://bugs.webkit.org/show_bug.cgi?id=301857 、https://developer.apple.com/forums/thread/800125 、https://developer.apple.com/forums/thread/802159
- [T24] 选文件与相册：https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ios/forms/WKFileUploadPanel.mm 、https://developer.apple.com/documentation/avfoundation/requesting-authorization-to-capture-and-save-media 、https://developer.apple.com/forums/thread/134250 、https://developer.apple.com/documentation/photokit/delivering-an-enhanced-privacy-experience-in-your-photos-app 、https://developer.apple.com/documentation/bundleresources/information-property-list/nsphotolibraryaddusagedescription 、https://www.caseyliss.com/2022/2/9/saving-to-photo-library-via-sharesheet
- [T25] 进后台：https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/ApplicationStateTracker.mm 、https://bugs.webkit.org/show_bug.cgi?id=199854 、https://developer.apple.com/forums/thread/716118 、https://bugs.webkit.org/show_bug.cgi?id=228296 、https://bugs.webkit.org/show_bug.cgi?id=308073
- [T26] 系统占比：https://developer.apple.com/support/app-store/

法律（L）：
- [L1] 欧盟交易者：https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-european-union-digital-services-act-trader-requirements 、https://developer.apple.com/support/apps-in-the-eu/
- [L2] https://developer.apple.com/news/?id=einwn76m
- [L3] DSA 原文：https://eur-lex.europa.eu/legal-content/EN/TXT/HTML/?uri=CELEX:32022R2065
- [L4] 苹果的年龄保障：https://developer.apple.com/support/age-assurance 、https://developer.apple.com/news/?id=8jzbigf4 、https://developer.apple.com/news/?id=sg176nne 、https://developer.apple.com/news/?id=2ezb6jhj
- [L5] 德州：https://law.justia.com/cases/federal/appellate-courts/ca5/25-51073/25-51073-2026-06-04.html 、https://www.supremecourt.gov/docket/docketfiles/html/public/25a1390.html 、https://ccianet.org/litigation/ccia-v-paxton-w-d-tex/
- [L6] 犹他 HB 498：https://le.utah.gov/~2026/bills/static/HB0498.html
- [L7] 路易斯安那：https://www.legis.la.gov/legis/ViewDocument.aspx?d=1486866
- [L8] 加州 AB 1043：https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202520260AB1043
- [L9] 二手综述：https://www.privacyworld.blog/2026/11/app-store-age-verification-laws-your-questions-answered-updated/
- [L10] COPPA：https://www.ftc.gov/business-guidance/resources/complying-coppa-frequently-asked-questions
- [L11] 日本移动软件竞争法：https://www.jftc.go.jp/msca 、https://developer.apple.com/support/app-distribution-in-japan/ 、https://developer.apple.com/news/?id=074b3wzz
- [L12] 电气通信事业法：https://www.soumu.go.jp/main_content/000477428.pdf 、https://www.soumu.go.jp/main_content/001084452.pdf 、https://www.soumu.go.jp/main_sosiki/joho_tsusin/d_syohi/gaibusoushin_kiritsu.html
- [L13] 特定商取引法：https://www.no-trouble.caa.go.jp/what/mailorder/advertising.html 、https://www.no-trouble.caa.go.jp/qa/advertising.html
- [L14] AI 推进法：https://laws.e-gov.go.jp/law/507AC0000000053 、https://www8.cao.go.jp/cstp/ai/ai_guideline/ai_guideline.html
- [L15] 开发者账号：https://developer.apple.com/help/account/membership/program-enrollment/ 、https://developer.apple.com/programs/enroll/ 、https://developer.apple.com/help/account/membership/updating-your-account-information/ 、https://developer.apple.com/help/app-store-connect/manage-compliance-information/manage-korea-compliance-information/
