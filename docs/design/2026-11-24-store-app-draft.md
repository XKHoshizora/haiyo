# 上架应用：iOS 先行（纸面设计，草稿）

日期：2026-11-24（资料核对于 2026-11-22）。状态：**草稿，只是纸面设计，没有代码，没装任何东西，没登录任何账号**。主人已定：第一批试用的人要从 App Store 装；主人有开发者账号。

- 每条外部事实后面给了出处，出处汇总在文末。苹果审核指南页面当时显示 “Last Updated: October 16, 2026”，文中条款号都按这一版。
- 没核实的标“未核实”。产品上的取舍标“待定”，等主人定。
- 本地事实在 lane/integ-mobile（91459b8 / 57534f3）上核对。

## 结论先说

1. **走网页壳（Capacitor；现行是 8，9 的正式版预计 11 月底，开工时已发布就直接用 9，最低 iOS 16）**，第一版**只做 iOS**，**网页打包进应用**（下文 a1），再加几样原生能力：推送、角标、相册选图、保存/分享文件、通用链接、断网页。
2. **第一版不在应用里卖点数**：没有购买入口，点数照旧由站点发放。等要卖时再接苹果内购（IAP）。
3. 上架前服务端必须补的：
   - 举报，内容过滤，公开的联系方式（拉黑已有）；
   - 应用内删除账号；
   - 第三方 AI 的数据同意；
   - 条款与隐私政策页；
   - 推送设备登记与 APNs 发送；
   - 通用链接文件；
   - 跨源登录（bearer 令牌）；
   - 给审核用的演示账号。

   清单见第 3 节。
4. **店面先不含中国大陆**：上中国区要 ICP 备案，AI 聊天还要生成式 AI 备案号（第 4 节第 5 条）。
5. 粗估（一个熟练开发者）：**壳约 2–3 周，服务端补齐约 3–4 周**，合计 5–7 周可以第一次提交审核。RN 重写或原生要按月算（第 2 节）。

## 1. 同类产品怎么发

| 产品 | 做法 | 证据与出处 | 可信度 |
|---|---|---|---|
| ChatGPT | 原生（Swift/SwiftUI，Kotlin/Compose）；应用内 “Apps” 是沙箱 iframe 里的网页 | 招聘要求 [P1][P2]；Apps SDK 报道 [P3]（2025-10-08） | 招聘是间接证据；iframe 是二手 |
| Claude | 原生（Swift/SwiftUI/UIKit，Kotlin/Compose） | Anthropic 招聘 [P4][P5] | Android 一手；iOS 转载 |
| Perplexity | iOS 原生（Swift/SwiftUI/ObjC） | 招聘 [P6] | 间接；Android 未核实 |
| Character.AI | React Native（Expo） | Expo 团队成员的帖子 [P7]（2024-08-03） | 二手 |
| Discord | React Native，部分原生组件 | 官方工程博客 [P8]（2025-03-05） | 一手 |
| Microsoft Teams / Copilot | 原生应用里嵌 React Native | 采访 [P9]（2024-04-11） | 二手 |
| Mattermost、Rocket.Chat | React Native | 官方仓库 [P10][P11] | 一手 |
| Zulip | Flutter（替换了 RN；旧 RN 应用的消息列表是 WebView） | 官方博客 [P12]（2025-06-17） | 一手 |
| Slack | 原生（iOS 全 Swift，Android 九成 Kotlin），明确没选 RN/Flutter | 工程博客 [P13]（约 2021，较旧） | 一手但旧 |
| Telegram | 原生；“小程序”是 WebView 里的网页 | 仓库 [P14][P15]；文档 [P16] | 一手 |
| Signal | 原生（Swift 97.9%，Kotlin 76.3%） | 仓库语言统计 [P17][P18]（2026-10） | 一手 |
| Element X | 原生（SwiftUI / Compose），共用 Rust SDK | 官方博客 [P19] | 一手 |
| HEY / Basecamp | Hotwire Native：原生导航 + WKWebView 里的网页界面 | 37signals 博客 [P20][P21] | 一手 |
| 微信小程序 | WebView 渲染层 + 独立 JS 引擎 | 论文 [P22] | 二手 |
| Gemini、DeepSeek、豆包、Kimi、Poe、WhatsApp、LINE | — | 没找到可靠出处 | **未核实** |

规律：
- AI 公司（OpenAI、Anthropic、Perplexity）和重速度、端到端加密的通讯软件（Signal、Telegram、Slack、Element）用原生。
- 以 JS/React 为主的公司用 RN（Discord、微软、Character.AI、Mattermost、Rocket.Chat）。
- 纯网页套壳的聊天应用很少见，网页通常只占一部分界面（Hotwire、小程序、ChatGPT 的 iframe 应用）。

对我们的含义：网页壳能过审，前提是有原生的骨架和能力，不能只是把网站装进去（4.2）。

## 2. 三条路

现状（决定比较结果的几条）：
- 网页端是 React 19.3.1 + Vite 8.3.8，非测试代码约 2.2 万行：界面 49 个 `.jsx` 约 1.16 万行，数据/状态/接口约 1 万行；样式一个文件，构建后约 60 KB。
- 所有请求是同源相对路径加 `credentials: "same-origin"`（`api/http.js:56`、`:88`）；socket 是先 `POST /api/ws-ticket` 再连 `/api/ws`。
- 登录是 Better Auth，只有邮箱 + 密码。会话 cookie 是 httpOnly、SameSite=Lax，`trustedOrigins = [APP_ORIGIN]`，没开 bearer 插件。
- `index.html` 已有 `viewport-fit=cover`；没有 manifest，没有 service worker。

### (a) 网页壳：Capacitor 或同类

Capacitor：
- 当前 8.x（8.6.2，2026-11-12），MIT。要求 iOS 15、Android 7、Xcode 26+、Node 22+ [T1][T2]。
- 9.0 在 rc（iOS 16、Android 8 / minSdk 26、Xcode 27+、Node 24+），预计 11 月底正式版 [T3]。
- 8.x 起新的 iOS 工程默认用 Swift Package Manager，CocoaPods 可选；CocoaPods Trunk 2026-12-02 起只读 [T1]。

同类：
- Tauri 2 移动端（WKWebView）；
- Hotwire Native（服务端渲染 HTML 配原生导航，和我们这种前端单页应用合不合适**未核实**）[T1]；
- 也可以自己写一个最小 WKWebView 壳（不加依赖，但推送、文件这些桥要自己写）。

两种装法：

| | a1：网页打包进应用（推荐） | a2：应用打开线上网站（`server.url`） |
|---|---|---|
| 页面来源 | 应用里的 `capacitor://localhost` | 线上站点 |
| Capacitor 的说法 | 正常用法 | `server.url` 等**“not intended for use in production”** [T4] |
| 登录 | cookie 变成第三方，iOS 默认挡掉（iOS 14 起）[T5][T6] → 改用 bearer 令牌 | 同源，cookie 照常，服务端几乎不用改 |
| 审核 | 审的版本就是用户用的版本，不违反 2.5.2（不能下载代码来改功能），也不违反 2.5.19（不能对审核藏功能） | 网页随时变，审核员看到的和以后用户看到的可能不同：有 2.5.2 / 2.5.19 风险，也更像“重新包装的网站”（4.2） |
| 断网 | 壳和界面都在本地，能显示自己的断网页 | 断网就白屏或出系统错误页，要另做 |
| 更新 | 改界面要重新提交（审核通常一两天，**未核实**） | 改网站立刻生效 |
| 服务端改动 | 跨源：bearer、CORS、trustedOrigins、socket 的 Origin 检查、网页里的接口基址 | 很少 |

建议：正式版用 a1。a2 只适合给自己人在 TestFlight 内部测试（内部测试不用审核，外部测试要过 TestFlight 审核 [R13]）时快速试壳。

各项：

- **工作量**：壳加原生能力约 2–3 周；服务端补齐约 3–4 周（第 3 节）。这两块可以并行。
- **复用**：网页几乎全部复用，包括界面、数据层和 socket。要改的是：
  - 接口基址；
  - 带 bearer 头；
  - 下载与保存；
  - 选图；
  - 推送注册；
  - 切回前台重连（已有指数退避重连，`data/sync.js:84`，只需在 App 的 resume 事件上立刻触发一次）。
- **推送**：
  - `@capacitor/push-notifications` 在 iOS 给原始 APNs 令牌，在 Android 给 FCM 令牌；不支持 iOS 静默推送 [T7]。
  - 服务端用 .p8 密钥签 ES256 JWT 直连 APNs，令牌每 20–60 分钟换一次 [T8]。
  - 推送内容不超过 4 KB，不放敏感内容；要显示解密后的正文，就得加 Notification Service Extension，并带 `mutable-content: 1`，处理时间约 30 秒 [T9][T10]。
  - 4.5.4：推送不能是使用的前提，不能带敏感个人信息，营销推送要单独同意并能退订 [R10]。
- **后台 socket**：
  - 进后台约 5 秒后应用被挂起，挂起后不跑代码，连接可能被系统收回 [T11][T12]。
  - 静默推送优先级低，每小时最多两三条 [T13]，不能靠它保持在线。
  - 做法：后台一律靠可见推送；回前台立刻重连，并走现有的 `/api/sync` 补缺口 [T14]。
- **深链 / 通用链接**：
  - 服务端放 `https://<域名>/.well-known/apple-app-site-association`：不带扩展名，有效 HTTPS，不能重定向；iOS 14 起经苹果 CDN 取 [T15]。
  - 应用用 App 插件的 `appUrlOpen` / `getLaunchUrl` 接住，转成站内地址 [T14]。
  - 我们的地址已经是“地址即状态”（`/chat/<id>`、`/chat/<id>/info`，`state/location.js:48–57`），接起来简单。
  - 邮件里的链接：重设密码是 `<站点>/reset-password?token=…`（`auth.ts:279`），可以直接做成通用链接；验证邮箱的链接先到服务端 `/api/auth/verify-email` 验证、再跳到 `/verify`（`register.ts:98`）。这个链接不能整个交给应用，跳转后会不会回到应用要实测（**待定**）。
- **选文件 / 相册**：
  - 现有 `<input type=file accept="image/*" multiple>`（`pages/Composer.jsx:335`）在 WKWebView 里能用，但系统一定会给“拍照”选项。所以必须在 Info.plist 写相机用途说明，否则点了会崩 [T16]。
  - 也可以换 Camera 插件的 `chooseFromGallery`（8.1 起支持多选）[T17]。
  - **下载 / 保存**：Capacitor 8 核心不处理 WKDownload，`blob:` 下载链接也不支持 [T18]。我们的 `<a download>`（`ui/FileCard.jsx:92`、`ui/ImageViewer.jsx:252`、`pages/messageActions.js:38`）在 a1 下是跨源链接，会被交给系统浏览器打开 [T19]。要做成“取文件 → 存到 Filesystem → 弹 Share 面板”[T20]。
- **登录与会话 cookie**：
  - a1 下 cookie 属于第三方，被 WebKit 挡 [T5][T6]。
  - 苹果的 App-Bound Domains（最多 10 个域名）能缓解，但会限制导航，Capacitor 也要专门配置 [T5][T21]。
  - 更稳的是 Better Auth 的 bearer 插件：登录响应头带 `set-auth-token`，之后请求带 `Authorization: Bearer`；官方说只在 cookie 用不了的地方用 [T22]。
  - Better Auth 没有官方 Capacitor 指南（**未核实**）。第三方指南的做法正是 bearer 加上把 `capacitor://localhost` 放进 `trustedOrigins` [T23]。
  - 令牌存在 Keychain（需要一个安全存储插件，**未选型**），不要存 localStorage。
- **卖点数（IAP）**：
  - 3.1.1：在应用里解锁功能、卖虚拟货币必须用 IAP；IAP 买到的点数**不能过期**，可恢复的购买要能恢复 [R2]。
  - 3.1.3(b)：在别的平台或网站买到的东西可以在应用里用，**前提是这些东西也能在应用里用 IAP 买** [R14]。
  - 地区例外：
    - 美国 2025-05-01 起可以放外链按钮，不需要额外资格 [R3]；
    - 欧盟 2026-10-01 起统一条款 [R3]；
    - 日本自 iOS 26.2 起可用自己的支付或外链 [R3]；
    - 中国大陆只能用 IAP [R3]。
  - 我们现在完全没有支付：点数只靠 CLI `credits:grant` 发放，代码里没有购买；余额也没看到过期逻辑（grep 未见）。所以第一版不卖就不碰 3.1；以后要卖，IAP 买到的点数要和每日免费额度分开记，并且永不过期。
- **审核规则：UGC 与 AI 聊天**：
  - 1.2 要求四样：过滤不良内容的办法、举报及时处理、拉黑、公开联系方式 [R4]。
  - 4.7 明确覆盖 “chatbots”（不在应用二进制里的软件）[R14]。我们用户自建的 Agent 很可能算在内，那就还要满足：
    - 4.7.1 隐私、过滤 / 举报 / 拉黑，数字商品走 3.1；
    - 4.7.3 每次把数据给某个具体软件前都要用户明确同意；
    - 4.7.4 提供目录，并配通用链接；
    - 4.7.5 标出超过分级的内容，并按年龄限制 [R14]。
  - 5.1.2(i)：把个人数据给第三方（包括第三方 AI）要事先说明，并取得明确许可（2025-11-13 起）[R5]。
  - AI 陪伴类涉及恋爱或性内容 → “Dating and Relationships” 描述 → 18+ [R5][R9]。
  - 2.1：有登录就要给审核演示账号，后端要开着 [R14]。
  - 2.5.19（2026-10-16 新增）：不能对审核藏功能 [R5]。
- **最低系统**：
  - Capacitor 8 是 iOS 15；9 是 iOS 16 [T2][T3]。
  - 苹果 2026-06-07 的统计：全部 iPhone 里 iOS 26 占 79%，iOS 18 占 14%，更早的占 7% [T24]。
  - 建议 iOS 16 起（跟 Capacitor 9 一致，少测一个大版本）。
  - 提交要求：2026-04-28 起要用 iOS 26 SDK / Xcode 26；2027 年 4 月起要 iOS 27 SDK / Xcode 27 [R11]。本机已是 Xcode 27.2。

### (b) React Native 重写

- **工作量**：界面全部重写（约 1.16 万行 JSX 加样式，DOM/CSS 不能直接用），粗估 3–5 个月；Android 基本同时得到。
- **复用**：
  - RN 有 fetch、XHR、WebSocket，所以接口、同步、状态和部分 hooks 可以搬（推断）[T25]。
  - 编辑器（@ 提及、输入法处理）、图片查看器、气泡菜单这些我们花力气最多的交互都要重写。
  - Expo 的 DOM 组件可以把个别网页组件放进 webview 里过渡 [T26]。
- **推送**：原生推送模块（具体库**未核实**），服务端同 (a)。
- **后台 socket**：同 (a)，受同样的 iOS 挂起规则约束。
- **深链**：RN / Expo 有路由支持（**未核实**细节），服务端文件同 (a)。
- **选文件 / 相册**：用原生选择器模块（**未核实**具体库）。
- **登录**：RN 文档说 fetch 带 cookie 不稳定；Better Auth 的 Expo 客户端把 cookie 存进 SecureStore [T27]。服务端改动比 a1 少一些。
- **IAP、审核规则**：同 (a)，与技术路线无关。
- **最低系统**：Expo SDK 58（RN 0.88）要 iOS 16.4+、Android 7+ [T25]。

### (c) 原生（Swift/SwiftUI + Kotlin/Compose）

- **工作量**：iOS 粗估 4–6 个月；Android 再来一遍。
- **复用**：只复用服务端接口和协议文档（`app/service/README.md` 的客户端约定）。
- **推送、后台**：原生最顺，Notification Service Extension 也最好做；后台规则同 (a)。
- **深链、选图、下载**：系统 API 直接用。
- **登录**：原生请求自己管 cookie 或令牌，没有第三方 cookie 问题。
- **IAP、审核规则**：同 (a)。
- **最低系统**：自己选。用新版 SwiftUI 的话一般 iOS 17 起（**待定**）。

### 对比

| | (a1) 网页壳，打包 | (b) RN 重写 | (c) 原生 |
|---|---|---|---|
| 到第一次提交 | 5–7 周 | 4–6 个月 | iOS 5–7 个月 |
| 网页复用 | 几乎全部 | 数据层 | 无 |
| 推送 | 插件 + 服务端 APNs | 模块 + 服务端 | 系统 + 服务端 |
| 后台 | 挂起，靠推送 | 同左 | 同左 |
| 深链 | 插件 + AASA | 路由 + AASA | 系统 + AASA |
| 文件 / 相册 | 要补下载 / 保存 | 模块 | 系统 |
| 登录 | 改 bearer | cookie 存储或 bearer | 自管 |
| 4.2 风险 | 中（靠原生能力撑） | 低 | 低 |
| 两套界面 | 否 | 否 | 是（网页 + 原生） |
| 最低 iOS | 15 / 16 | 16.4 | 自定 |

## 3. 推荐：能过审的最简单第一版

### 应用里有什么

- Capacitor 壳，网页打包进去（a1），iOS 16 起，只上 iPhone（iPad 是否单独适配**待定**）。
- 原生能力：
  - 推送：新消息通知，点开进对应会话；角标显示未读数。
  - 通用链接：`/chat/*` 和 `/reset-password`（验证邮箱链接见第 2 节）。
  - 保存 / 分享：图片和文件走分享面板。
  - 相册选图。
  - 断网页：壳自己画，带“重试”。
  - 回前台立刻重连并补同步。
- 外链在系统浏览器里打开（Capacitor 默认就是这样 [T19]）。
- 设置里新增：删除账号、举报入口（消息长按菜单、成员资料页）、条款 / 隐私 / 联系方式、推送开关。
- 首次使用：同意条款与隐私政策，以及**第三方 AI 数据同意**（产品口径待定，见第 4 节）。
- 不做：
  - 应用内购买；
  - Android；
  - 通知正文解密（NSE）；
  - 离线读历史；
  - 小组件、分享扩展。

### 审核风险与对策

| 风险 | 条款 | 对策 |
|---|---|---|
| 像“重新包装的网站” | 4.2 / 4.2.2 [R1][R14] | 推送、通用链接、原生保存 / 分享、角标、断网页；界面本来就是应用式的，不是网站 |
| 缺 UGC 四件套 | 1.2 [R4]、4.7.1 [R14] | 举报 + 拉黑（已有）+ 过滤 + 联系方式，见下 |
| 没有应用内删除账号 | 5.1.1(v) [R6][R14] | 设置里“删除账号”，见下 |
| 数据给第三方 AI 没同意 | 5.1.2(i) [R5]、4.7.3 [R14] | 首次同意 + 群里有 Agent 时提示 |
| 审核员进不去（邀请制） | 2.1 [R14] | 审核备注里给演示账号；生产库里放一个准备好的演示群 |
| 审的和用的不一样 | 2.5.2 / 2.5.19 [R5][R8] | a1 打包；网页大改随新版本提交 |
| 年龄分级答错 | 2.3.6、分级定义 [R9] | 如实答 UGC、消息、AI 聊天；2027-01-12 前按新问题重答 |

### 服务端要加的东西（精确清单）

每项都要先写测试，并照现有习惯在 `app/service/README.md` 写明。

1. **推送设备**
   - 新表 `push_devices`：`id`、`user_id`、`platform`（`ios` / `android`）、`token`（唯一）、`env`（`sandbox` / `production`）、`app_version`、`created_at`、`last_seen_at`、`disabled_at`。
   - `POST /api/push/devices` `{ platform, token, env, appVersion }`：按令牌 upsert，换了账号就改归属。应用每次启动都重新登记，因为令牌会变（恢复备份、换机、重装）[T8]。
   - `DELETE /api/push/devices/:token`，退出登录时也一并删。
2. **APNs 发送**
   - 环境变量：
     - `APNS_KEY_P8`（或文件路径）、`APNS_KEY_ID`、`APNS_TEAM_ID`（各 10 位）、`APNS_TOPIC`（= bundle id）、`APNS_ENV`。
     - 都只放在部署环境里，不进 JSON 配置。
   - 发送方式：ES256 JWT 用 `node:crypto` 签，每 20–60 分钟换新 [T8]；HTTP/2 用 `node:http2`。**不加新依赖。**
   - APNs 回 410（令牌失效）就标 `disabled_at`。
   - 何时发（**待定**，建议）：收件人这台设备没有活着的 socket 时，才发“新消息”。Agent 的回复算不算也待定。
   - 静音的会话不发（静音功能现状待查）；拉黑的人发来的不发。
   - 内容（不带正文、不带发送人）：
     ```json
     { "aps": { "alert": { "title": "Haiyo", "body": "你有新消息" }, "badge": 3, "sound": "default", "thread-id": "<会话 id>" }, "c": "<会话 id>" }
     ```
     请求头 `apns-collapse-id` 设为会话 id，同一会话的多条合成一条。
   - 显示群名或发送人要主人定（第 4 节）；要显示正文，就上 NSE 加密方案（以后）。
3. **应用内删除账号**（5.1.1(v)）
   - `POST /api/account/delete`，要求重新输入密码。
   - 删：用户、会话、推送设备、自己的供应商与密钥、自己的 Agent 及其记忆、上传的文件。
   - 群里发过的消息：苹果说明里要求用户的内容也删 [R6]。具体是删除还是改成“已注销用户”**待定**，要对照原文再定。
   - 网页端同样提供（以后上 Google Play 时，商店要求应用内和网页都能删 [R16]）。
4. **举报**
   - 新表 `reports`：`id`、`reporter_id`、`target_type`（`message` / `user` / `agent` / `conversation`）、`target_id`、`reason`、`note`、`created_at`、`handled_at`、`handled_by`、`outcome`。
   - `POST /api/reports`；管理侧的列表与处理放进站点管理台（见分支 lane/mac-admin-design 上的 `docs/design/2026-11-23-admin-console-draft.md`）。
   - 公开承诺处理时限（**待定**，例如 24 小时）。
5. **内容过滤**（1.2 / 4.7.1 要求有“办法”）
   - 最小版：发送时和 Agent 输出时过一个可配置的词表，命中就拦下或打码，并记一条。
   - 以后可接审核模型。
   - 具体做法**待定**。
6. **拉黑**（已有）：确认被拉黑的人发来的消息不推送；Agent 在群里对拉黑关系怎么处理（**待查**）。
7. **条款、隐私政策、联系方式**
   - 站点上的静态页 `/terms`、`/privacy`、`/contact`。
   - 注册时同意并记下版本（`users.terms_version`、`terms_accepted_at`）；条款改版时再次请求同意。
8. **第三方 AI 数据同意**（5.1.2(i)、4.7.3）
   - 记录每个用户的同意：`ai_consent_at`、`ai_consent_version`。
   - 第一次和 Agent 说话前，或进入有 Agent 的群前，弹出说明：消息会发给哪家模型供应商，以及群里其他人的 Agent 也会读到你的发言。
   - Agent 编辑页已经写了数据会交给模型供应商，但群里**别人**的发言同样会进上下文，这一点现在没有告知。
   - 不同意的人怎么办**待定**。
9. **跨源登录**（只 a1 需要）
   - 开 Better Auth bearer 插件 [T22]。
   - `trustedOrigins` 加 `capacitor://localhost`。
   - `/api/*` 对这个来源开 CORS（允许 `Authorization`）。
   - `POST /api/ws-ticket` 接受 bearer；`/api/ws` 的 Origin 检查放行这个来源。
   - 网页加构建变量（例如 `VITE_API_BASE`），浏览器里仍走同源。
10. **通用链接文件**
    - `GET /.well-known/apple-app-site-association`，内容例：
      ```json
      { "applinks": { "details": [ { "appIDs": ["<TEAMID>.<bundle id>"], "components": [ { "/": "/chat/*" }, { "/": "/reset-password*" }, { "/": "/api/*", "exclude": true } ] } ] } }
      ```
    - 不能重定向。Content-Type 用 `application/json`（苹果没写明，**未核实**）[T15]。
    - 以后上 Android 再加 `/.well-known/assetlinks.json`（`application/json`，Play 签名证书的 SHA-256 指纹）[T28]。
11. **版本门槛**：`GET /api/app-config` → `{ minVersion, latestVersion, notice }`。旧版本应用提示更新，避免服务端改协议后旧壳坏掉。
12. **演示账号**：生产环境一个审核专用账号，带一个有 Agent 的演示群和几张图片；不能用真实用户的数据。
13. **以后：IAP**
    - App Store Server API 加 Server Notifications v2 验单、发点数（**未核实**接口细节）。
    - IAP 点数和每日免费额度分开记账，永不过期 [R2]。

## 4. 要主人决定的事

1. **开发者账号**：个人还是组织？商店里“卖家”显示谁？谁的 Apple ID 登进这台 Mac 的 Xcode（登录要主人自己做，我不登）？
2. **密钥与证书**：
   - APNs 的 .p8 密钥由主人在开发者网站创建、自己保管，放进部署环境变量。
   - 分发证书由 Xcode 用主人账号自动管理。
   - 我不建任何证书或密钥。
3. **Bundle ID**：反向域名，例如 `<主人的域名倒写>.haiyo`。一旦用了就改不了（**未核实**能否改，按改不了准备）。
4. **应用名、中文名、图标**：未定。商店名称长度有上限（**未核实**具体字数）。
5. **店面**：建议先不含中国大陆。上中国区要：
   - ICP 备案号，并和 App Store Connect 信息一致 [R12]；
   - AI 聊天要网信办的模型 / 算法备案号（或第三方模型方的授权）；
   - AI 内容分发要安全评估报告；
   - 已上架的应用要在 2027-01-31 前补齐 [R12]。
6. **试用渠道**：
   - TestFlight 外部测试：最多 10,000 人，要过 TestFlight 审核，构建 90 天过期 [R13]。
   - 直接上架：只给邀请码的人能注册。
   - 两者都“从苹果装”，选哪个？
7. **注册方式**：应用里沿用邀请制（`REGISTRATION_MODE=invite`，默认）还是开放？邀请制时，审核要用演示账号（2.1）。
8. **隐私标签**（App Privacy）：
   - 我们收集：邮箱、用户内容（消息、图片、文件）、用户 ID、推送令牌；诊断数据要看是否加崩溃统计。
   - 都不用于追踪。
   - 第三方：模型供应商。
   - 需要主人确认措辞 [R10]。
9. **年龄分级**：
   - 要答：UGC、消息与聊天、AI 聊天。
   - 允不允许 Agent 做恋爱 / 陪伴？允许就是 18+ [R9]。
   - 新问题要在 2027-01-12 前答完 [R9]。
10. **第三方 AI 同意的口径**：一次性同意还是按群同意？不同意的人在有 Agent 的群里，发言是否从 Agent 的上下文里排除？
11. **举报**：谁处理？多久内处理？公开的联系邮箱是哪个？
12. **删除账号**：群里的历史消息删掉还是匿名？
13. **推送文案**：只写“你有新消息”，还是显示群名或发送人（隐私与好用之间取舍）？
14. **Android 什么时候做**：本机还没有 Java、Android Studio、Android SDK（第 5 节）。
15. **什么时候卖点数、在哪卖**：应用内 IAP 要抽成 [R3]；美国可外链；3.1.3(b) 要求网站上卖的东西在应用里也能用 IAP 买 [R14]。

## 5. 这台 Mac 还要装什么（只列，不装）

已有，都在 `~/Desktop/Haiyo` 之外，是之前就装好的：
- macOS 27.2.1；
- Xcode 27.2（`/Applications/Xcode.app`），iOS 模拟器 18.2、27.0、27.2。够 Capacitor 8（Xcode 26+）和 9（Xcode 27+）[T2][T3]。
- Homebrew，以及 CocoaPods（`/opt/homebrew/bin/pod`）。Capacitor 8 起默认 SPM，用不上 CocoaPods [T1]。
- Node v26.13.1。够 Capacitor 8（22+）和 9（24+）。

要的话需要另装或另做：

| 东西 | 放哪 | 何时需要 | 备注 |
|---|---|---|---|
| 主人的 Apple ID 登入 Xcode | Xcode 设置 → Accounts | 真机运行、归档、上传 | 账号操作，主人自己做 |
| 真机运行组件（如果 Xcode 提示要下载设备支持文件） | Xcode 管理的系统位置 | 接真 iPhone 时 | 视真机 iOS 版本而定，**未核实**是否需要 |
| Capacitor 的 npm 包 | 仓库 `node_modules`（在文件夹内） | 开工时 | 属于**新依赖**，要按规矩先批：`@capacitor/core`、`@capacitor/cli`、`@capacitor/ios`、`@capacitor/app`、`@capacitor/push-notifications`、`@capacitor/share`、`@capacitor/filesystem`；可选 `@capacitor/camera`；外加一个 Keychain 存储插件（未选型） |
| JDK | 系统或 Android Studio 自带 | Android 时 | 本机没有 Java |
| Android Studio | `/Applications` | Android 时 | Capacitor 8 要 2025.2.1+，9 要 2026.1.4+ [T2][T3] |
| Android SDK（API 36） | 默认 `~/Library/Android/sdk`；也可以设 `ANDROID_HOME` 放进 `~/Desktop/Haiyo` | Android 时 | Play 2026-08-31 起要求目标 API 36 [R17] |

上传到 App Store Connect 用 Xcode 的 Organizer 就行，不用另装工具。

## 出处

访问日期都是 2026-11-22。

苹果审核与商店（R）：
- [R1] 4.2 最低功能：https://developer.apple.com/app-store/review/guidelines/#minimum-functionality
- [R2] 3.1.1 内购：https://developer.apple.com/app-store/review/guidelines/#in-app-purchase
- [R3] 外部购买与各地区条款：
  - 美国：https://developer.apple.com/news/?id=9txfddzf
  - 3.1.1(a) 改写：https://developer.apple.com/news/?id=92th7e5i
  - 第九巡回法院：https://law.justia.com/cases/federal/appellate-courts/ca9/25-2935/25-2935-2025-12-11.html
  - 欧盟：https://developer.apple.com/support/dma-and-apps-in-the-eu/ 、https://developer.apple.com/news/?id=gmws0jgp
  - 日本：https://developer.apple.com/support/app-distribution-in-japan/ 、https://developer.apple.com/news/?id=074b3wzz
  - 中国大陆佣金：https://developer.apple.com/news/?id=dadukodv
- [R4] 1.2 用户生成内容：https://developer.apple.com/app-store/review/guidelines/#user-generated-content；更新见 https://developer.apple.com/news/?id=d75yllv4 、https://developer.apple.com/news/?id=a233fmpw 、https://developer.apple.com/news/?id=vvzx6cul
- [R5] 5.1.2(i) 第三方 AI：https://developer.apple.com/news/?id=ey6d8onl；2.5.19 等：https://developer.apple.com/app-store/review/guidelines/
- [R6] 账号删除：https://developer.apple.com/help/app-review/guideline-reference/5-1-1-account-deletion
- [R7] 4.8 登录服务：https://developer.apple.com/app-store/review/guidelines/#login-services。我们只有自己的邮箱 + 密码，不需要“通过 Apple 登录”。
- [R8] 2.5.2：https://developer.apple.com/app-store/review/guidelines/#software-requirements
- [R9] 年龄分级：
  - https://developer.apple.com/help/app-store-connect/reference/app-information/age-ratings-values-and-definitions/
  - https://developer.apple.com/news/?id=ks775ehf
  - https://developer.apple.com/news/?id=tlur8uvi
  - https://developer.apple.com/news/?id=yxkh08us
- [R10] 隐私标签与推送：
  - https://developer.apple.com/app-store/app-privacy-details/
  - https://developer.apple.com/support/third-party-SDK-requirements/
  - https://developer.apple.com/documentation/bundleresources/describing-use-of-required-reason-api
  - 4.5.4
- [R11] SDK 要求：https://developer.apple.com/news/?id=ueeok6yw 、https://developer.apple.com/news/?id=k1mtkt1k
- [R12] 中国大陆合规：
  - https://developer.apple.com/help/app-store-connect/reference/app-information/app-and-compliance-information
  - https://developer.apple.com/help/app-store-connect/manage-compliance-information/view-china-mainland-compliance-information
  - https://www.gov.cn/zhengce/zhengceku/202308/content_6897341.htm
  - https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm
  - https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
- [R13] TestFlight：https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers
- [R14] 指南原文（2026-11-22 现场核对 2.1、3.1.3(b)、4.2、4.7–4.7.5、5.1.1(v)、1.2 的措辞）：https://developer.apple.com/app-store/review/guidelines/

Google Play（R）：
- [R15] 用户生成内容与 AI 内容：https://support.google.com/googleplay/android-developer/answer/9876937 、https://support.google.com/googleplay/android-developer/answer/13985936
- [R16] 账号删除：https://support.google.com/googleplay/android-developer/answer/13327111
- [R17] 目标 API：https://support.google.com/googleplay/android-developer/answer/11926878
- Play 结算：https://support.google.com/googleplay/android-developer/answer/9858738 、https://support.google.com/googleplay/android-developer/answer/15582165

技术（T）：
- [T1] Capacitor 支持政策与发布：https://capacitorjs.com/docs/main/reference/support-policy 、https://github.com/ionic-team/capacitor/releases
- [T2] Capacitor 8 要求：https://capacitorjs.com/docs/updating/8-0
- [T3] Capacitor 9 要求：https://capacitorjs.com/docs/next/updating/9-0
- [T4] `server.url` 不用于生产：https://capacitorjs.com/docs/config
- [T5] Cookie 与 App-Bound Domains：https://capacitorjs.com/docs/apis/cookies
- [T6] WebKit 跟踪防护：https://webkit.org/tracking-prevention/
- [T7] 推送插件：https://capacitorjs.com/docs/apis/push-notifications
- [T8] APNs 令牌认证与注册：
  - https://developer.apple.com/documentation/usernotifications/establishing-a-token-based-connection-to-apns
  - https://developer.apple.com/documentation/usernotifications/registering-your-app-with-apns
- [T9] 推送内容：https://developer.apple.com/documentation/usernotifications/generating-a-remote-notification
- [T10] Notification Service Extension：https://developer.apple.com/documentation/usernotifications/modifying-content-in-newly-delivered-notifications
- [T11] 后台时间：https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time
- [T12] 挂起后的网络连接：TN2277
- [T13] 静默推送：https://developer.apple.com/documentation/usernotifications/pushing-background-updates-to-your-app
- [T14] App 插件与深链：https://capacitorjs.com/docs/apis/app 、https://capacitorjs.com/docs/guides/deep-links
- [T15] 通用链接：https://developer.apple.com/documentation/xcode/supporting-associated-domains
- [T16] 文件选择要相机说明：https://bugs.webkit.org/show_bug.cgi?id=236981
- [T17] Camera 插件：https://capacitorjs.com/docs/apis/camera
- [T18] 下载：Capacitor PR #5498、issue #5478；https://bugs.webkit.org/show_bug.cgi?id=216918
- [T19] 跨源导航交给系统浏览器：Capacitor 8.x `WebViewDelegationHandler.swift`
- [T20] Share 与 HTTP / File Transfer：https://capacitorjs.com/docs/apis/share 、https://capacitorjs.com/docs/apis/http
- [T21] App-Bound Domains：https://webkit.org/blog/10882/app-bound-domains/
- [T22] Better Auth bearer：https://www.better-auth.com/docs/plugins/bearer
- [T23] 第三方指南：https://capgo.app/blog/how-to-use-better-auth-in-capacitor-apps/
- [T24] 系统占比：https://developer.apple.com/support/app-store/
- [T25] Expo SDK 58：https://docs.expo.dev/versions/latest 、https://expo.dev/changelog/sdk-58
- [T26] Expo DOM 组件：https://docs.expo.dev/guides/dom-components/
- [T27] Better Auth 与 Expo：https://www.better-auth.com/docs/integrations/expo
- [T28] Android App Links：https://developer.android.com/training/app-links/configure-assetlinks

产品（P）：
- [P1] https://openai.com/careers/android-engineer-chatgpt-library-team-seattle/
- [P2] https://openai.com/careers/ios-engineer-applied-foundations-san-francisco/
- [P3] https://thenewstack.io/openai-launches-apps-sdk-for-chatgpt-a-new-app-platform/
- [P4] https://job-boards.greenhouse.io/anthropic/jobs/4899511008
- [P5] https://builtinseattle.com/job/ios-engineer-product/7262965
- [P6] https://jobs.ashbyhq.com/perplexity/fcb4cc78-d4bd-4489-8756-7d39e755ac76
- [P7] https://x.com/Baconbrix/status/1819625244967285017
- [P8] https://discord.com/blog/supercharging-discord-mobile-our-journey-to-a-faster-app
- [P9] https://devclass.com/development/2024/04/11/react-native-and-why-microsoft-uses-it-for-its-own-cross-platform-development/1631749
- [P10] https://github.com/mattermost/mattermost-mobile
- [P11] https://github.com/RocketChat/Rocket.Chat.ReactNative
- [P12] https://blog.zulip.com/2025/06/17/flutter-mobile-app-launched/
- [P13] https://slack.engineering/stabilize-modularize-modernize-scaling-slacks-mobile-codebases/
- [P14] https://github.com/TelegramMessenger/Telegram-iOS
- [P15] https://github.com/TelegramMessenger/Telegram-Android
- [P16] https://core.telegram.org/bots/webapps
- [P17] https://github.com/signalapp/Signal-iOS
- [P18] https://github.com/signalapp/Signal-Android
- [P19] https://element.io/blog/element-x-experience-the-future-of-element/
- [P20] https://dev.37signals.com/speeding-up-mobile-development-with-turbo/
- [P21] https://dev.37signals.com/announcing-hotwire-native/
- [P22] https://arxiv.org/html/2611.13965v1
- 未找到关联：豆包与 Lynx，https://lynxjs.org/blog/lynx-unlock-native-for-more.html
