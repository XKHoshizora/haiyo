# 站点管理台（纸面设计，草稿）

日期：2026-11-23。状态：**草稿，只是纸面设计，没有代码**。设置清单是从 `app/service/src/config.ts` 和 `app/service/README.md` 的配置一节逐条整理的（全表见同目录 `2026-11-23-admin-console-settings-inventory.md`，179 项：59 个环境变量、JSON 变量里的 116 个字段、`apiKeyEnv` 间接点名的 4 个密钥变量）。产品上的取舍标了“待定”，等用户看过再定。

## 为什么做

现在站点的一切都靠部署时的环境变量：改一个每日免费点数、调一个限流、关掉注册，都要改 `.env` 再重启；发邀请、加点数、改档位要登服务器跑 `cli.ts`（`invite:create`、`credits:grant`、`tier:set`）。管理台把其中**安全、常改**的那一部分搬到网页上，有记录、能撤回；其余的继续只在环境变量里。

## 现状（决定设计的几条事实）

- 配置在启动时由 `loadConfig()` 解析一次（`server.ts:6`，`config.ts` 944–1079），之后不再读：没有监听、没有 SIGHUP、没有重新加载。返回的对象没有冻结，大部分代码在用的时候通过同一个对象引用去读。
- 约 20 个值在启动时被**拷进**长寿命的东西里：Fastify 选项与 HTTP 超时、数据库连接池、并发槽、worker、清理定时器、主动参与调度器、路由限流器、Better Auth、工具箱和网页搜索引擎、两个模块全局量。改这些必须重启（或专门重建那一块）。
- 11 组互相约束的检查只在启动时跑（S3 五个要么全有要么全无、`AGENT_MAX_CONCURRENT_OTHERS_RUNS ≤ AGENT_MAX_CONCURRENT_RUNS`、各种超时的先后、`MAIL_MODE=resend` 需要发件密钥和发件人……）；另有几处运行时才用到的组合根本没检查（如 `MEMORY.judgeShare × JUDGE.dailyLimit`）。网页上改值如果绕过这些检查，就能把站点配成下次启动不了的样子。
- 上游密钥从不进 JSON：`SITE_MODELS`、`JUDGE`、`TOOLS.web` 用 `apiKeyEnv` 点名另一个环境变量。**`TOOLS.web.apiKeyEnv` 目前不检查**它是不是服务自己的密钥（另两个查）；它要是能在网页上改，配合 `baseUrlProxy: true`，就能把 `DATABASE_URL` 或 `AUTH_SECRET` 当作 API 密钥发到任意 https 地址。
- 服务是单进程设计，但部署时新旧实例会短暂并存，两份配置可能同时在跑。
- 站点没有“管理员”这个概念（代码里的 owner 都是 Agent 的主人）。

## 谁是管理员

建议：**管理员名单只在环境变量里**，例如 `ADMIN_EMAILS`（逗号分隔，按注册邮箱）。网页上不能任命管理员，所以拿下一个管理员账号也不能再扩权；改名单要改部署。

- 只有名单里的账号能看到“设置 → 站点管理”，每个管理接口在服务端再查一次（不靠前端隐藏）。
- 写操作要求**最近登录过**（例如 15 分钟内输过密码，过了就要求重新输入），减少被盗会话的伤害。
- 待定：要不要以后加“只读管理员”（能看不能改）；要不要两人确认（一个人提交、另一个人批准）。第一版都不做。

## 设置怎么分、谁说了算

每一项设置归到下面四类之一（59 个环境变量的建议归类见文末附表）：

| 类别 | 例子 | 管理台里 |
|---|---|---|
| **只在环境变量** | 密钥、数据库地址、域名、端口、代理信任、HTTP 与数据库超时、管理员名单、任何“点名另一个变量”或“决定把带密钥的请求发到哪里”的字段 | 只显示“已设置 / 未设置”（密钥）或只读值，永远不能改 |
| **网页可改，立即生效** | 每日免费点数、各种每分钟次数与并发上限、链式调用上限、附件大小与配额、注册模式、网页搜索的每日预算 | 可改 |
| **网页可改，重启后生效** | Agent 运行超时、同时调用上游的槽数、在途运行数、限流倍数、清理间隔、站点时区 | 第一版只读，标“需要重启” |
| **构建选项** | `allowInsecureLocal`、`answerFloor` | 不出现（README：没有变量能打开它们） |

**优先级**（建议）：构建内置默认 < 管理台的值 < **环境变量里显式设置的值**。也就是说，环境变量一旦设了某项，这项在管理台上就显示为“由部署环境固定”、不能改；没设的，管理台的值生效；两边都没有，用代码默认值。

- 理由：出事时运维总能不碰数据库、只改环境变量就盖过一切；而且“这个值到底从哪来”每一项都能明确显示（环境变量 / 管理台 / 默认）。
- 代价：已经写在 `.env` 里的值，要先从 `.env` 删掉才能交给管理台管。上线管理台时需要一次清点（附表就是起点）。
- 待定：是否反过来（管理台优先、环境变量只当默认值）。

## 存储：修订（revision）而不是一条条改

- 表 `site_settings_revisions`：`id`、`created_at`、`created_by`、`reason`（必填）、`parent_id`、`values jsonb`（这一版管理台管理的**全部**键和值）、`status`（`active` / `superseded` / `invalid`）。任一时刻只有一条 `active`。
- 每次保存生成一条新修订（整份，不是差异），旧的变成 `superseded`。这样“当前是什么”永远是一条记录，回滚就是再激活一份旧的，审计就是修订列表本身。
- 值只存管理台允许管理的键；保存时拒绝任何“只在环境变量”的键。这类表里**永远不会有密钥**。

## 校验

把 `loadConfig` 拆成两步、两边共用：

1. 每个键的单项规则：直接复用 `envSchema` 里的 zod 定义（范围、枚举、JSON 结构）。
2. 交叉检查：把 951–1013 行那些命令式检查抽成一个纯函数 `checkConfig(config)`，启动时和保存时都调用。

保存前，服务端用“环境变量 + 这份新修订”合成**完整的**配置，跑完上面两步；任何一条不过，整份拒绝，逐项给出错误（哪个键、为什么、和哪个键冲突）。顺手补上现在的缺口：`TOOLS.web.apiKeyEnv` 也要过 `checkKeyVariable`（这一项本来就该只在环境变量里，但检查要补）。

## 生效

- **立即生效的那类**：把读配置的地方从“启动时拿到的对象引用”改成一个访问器 `currentConfig()`，换配置就是原子地换掉这个对象。只有“用的时候才读”的值能这样换，所以要先把每一项的“读的时机”标出来（全表的“When read”一列已经标了）。
- **需要重启的那类**：第一版不在网页上改。以后要改，就得给限流器、调度器这些写专门的重建逻辑，逐个做。
- **多实例**：保存后发一条 Postgres `NOTIFY site_settings`；每个实例 `LISTEN`，另外每 60 秒查一次当前修订号兜底。部署时新旧实例并存，最多各自晚一分钟对齐。
- 命令行（`cli.ts`）现在每条命令自己调一次 `loadConfig()`，也要改成读同一份“环境变量 + 当前修订”，否则 `credits:show` 之类会按旧值算。
- 页面上每项显示“当前生效值”和“来源”，保存后显示哪些已生效、哪些等重启。

## 审计

- 修订本身就是记录：谁、什么时候、为什么、改前改后（相邻两份修订的差异，界面上逐项展示）、请求编号、来源 IP。
- 只追加，不能在网页上删改；保存期限待定（建议永久，数据量很小）。
- 发邀请、加点数、改档位这些管理动作，搬进管理台时各自写一条同样形式的操作记录（`admin_actions`），和 CLI 共用一套记录，CLI 记操作者为“命令行”。

## 回滚

- “撤回到这一版”：选一份旧修订，系统先展示它和当前的差异，确认后**复制它生成一份新修订**（历史保持一条直线，不改旧记录），原因里自动写“回滚到 #id”。
- 启动时的保护：如果当前修订在新代码下校验不过（键改名、范围收紧），这一份标为 `invalid`，服务**不因此起不来**，退回“环境变量 + 默认值”运行，日志大声报错，管理台顶部显示横幅，等管理员处理。
- 读不到数据库时，用内存里最后一份有效配置继续跑；启动时读不到，就只用环境变量。

## 第一版做什么

1. `ADMIN_EMAILS` 管理员名单、“设置 → 站点管理”入口、服务端逐接口鉴权、写操作要求最近登录。
2. **只读总览**：全部设置的当前生效值和来源，密钥只显示是否已设置。光这一步就能回答“线上现在到底是什么配置”。
3. **一小组可改项**（都是“用的时候才读”的）：`FREE_DAILY_POINTS`、`REGISTRATION_MODE`、`AGENT_RUNS_PER_MINUTE` / `AGENT_OTHERS_RUNS_PER_MINUTE` / `AGENT_CALLER_RUNS_PER_MINUTE`、`AGENT_MAX_CONCURRENT_RUNS` / `AGENT_MAX_CONCURRENT_OTHERS_RUNS`、`AGENT_CHAIN_LIMIT`、`ATTACHMENT_MAX_BYTES` / `ATTACHMENT_QUOTA_BYTES`、`TOOLS.web.siteUsdPerDay`（网页搜索每天最多花多少美元；只许在非零值之间改，因为启动时按它是不是 0 决定建不建搜索引擎，改成 0 或从 0 改起要重启）。
4. 修订、校验（共用 `checkConfig`）、审计列表、回滚、启动保护。
5. 一个管理动作：发邀请（现在最常用的 CLI 命令）。

不做：需要重启的项、`SITE_MODELS` / `MEMORY` / `PROACTIVE` / `JUDGE` 这些大 JSON 的编辑（字段多、互相牵连，等第一版跑稳再拆成小表单）、只读管理员、两人确认、加点数和改档位的网页入口。

## 风险

1. **扩权**：管理员名单若能在网页上改，一个被盗账号就能拿下全站。对策：名单只在环境变量；写操作要求最近登录。
2. **借配置偷密钥**：任何“点名一个环境变量”或“决定请求发往哪里”的字段（`apiKeyEnv`、`baseUrl`、`baseUrlProxy`）一旦可改，就能把服务自己的密钥发出去。对策：这类字段永远只在环境变量；保存时按键名白名单拒绝其余；补上 `TOOLS.web.apiKeyEnv` 的检查。
3. **把站点改坏**：值本身合法、组合起来坏（超时先后、并发上下限）。对策：保存时跑完整的 `checkConfig`；回滚；启动保护。
4. **两个来源让人糊涂**：同一个键环境变量和管理台都有值。对策：环境变量优先并在页面上锁住、标明来源；上线前清点 `.env`。
5. **改了不生效**：有的代码在启动时拷走了值，换对象它看不到。对策：只开放“用的时候才读”的项；每项有测试证明保存后下一次请求就用新值。
6. **部署并存期两份配置**：对策：`NOTIFY` + 60 秒兜底；修订号写进日志，便于对照。
7. **审计里混进敏感数据**：对策：表里只存白名单里的非密钥键；原因字段提示不要写密钥。
8. **跨站请求伪造**：管理接口和现有接口同一套鉴权，另要求最近登录；只接受 JSON、不接受表单提交。

## 待定（请用户定）

- 优先级：环境变量优先（本文建议）还是管理台优先。
- 管理员按邮箱还是按账号名列；要不要只读管理员、两人确认。
- 第一版可改项的清单是否合适（尤其要不要先放进 `SITE_MODELS` 的开关和价格）。
- 审计保存多久。

## 附：59 个环境变量的建议归类

| 设置 | 读的时机 | 建议 |
|---|---|---|
| `DATABASE_URL`、`AUTH_SECRET`、`PROVIDER_KEY_SECRET` | 启动（及每次） | 只在环境变量（密钥；`PROVIDER_KEY_SECRET` 一改，已存的供应商密钥全部读不出） |
| `S3_ENDPOINT`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`、`BLOB_DIR` | 启动 | 只在环境变量（存储位置与密钥） |
| `RESEND_API_KEY`、`MAIL_MODE`、`MAIL_FROM`、`MAIL_REPLY_TO` | 启动 | 只在环境变量（发件身份与密钥） |
| `WEB_SEARCH_API_KEY`、`WEB_SEARCH_DEEPSEEK_API_KEY`，以及所有 `apiKeyEnv` 点名的变量 | 启动 / 每次调用 | 只在环境变量（密钥） |
| `APP_ORIGIN`、`PORT`、`HOST`、`WEB_DIST`、`TRUST_PROXY`、`CLIENT_IP_HEADER` | 启动 / 每次请求 | 只在环境变量（部署与安全边界） |
| `HTTP_CONNECTION_TIMEOUT_MS`、`HTTP_REQUEST_TIMEOUT_MS`、`HTTP_KEEP_ALIVE_TIMEOUT_MS`、`HTTP_BODY_TIMEOUT_MS`、`DB_STATEMENT_TIMEOUT_MS`、`DB_ACQUIRE_TIMEOUT_MS` | 启动 | 只在环境变量（先后关系是承重的） |
| `UPLOAD_IDLE_TIMEOUT_MS`、`UPLOAD_TOTAL_TIMEOUT_MS` | 每次请求 | 第一版只读（和 HTTP 超时有先后约束，而那些只在环境变量） |
| `FREE_DAILY_POINTS`、`REGISTRATION_MODE` | 每次请求 | **第一版可改** |
| `AGENT_RUNS_PER_MINUTE`、`AGENT_OTHERS_RUNS_PER_MINUTE`、`AGENT_CALLER_RUNS_PER_MINUTE`、`AGENT_MAX_CONCURRENT_RUNS`、`AGENT_MAX_CONCURRENT_OTHERS_RUNS`、`AGENT_CHAIN_LIMIT` | 每次请求 | **第一版可改**（交叉检查：OTHERS ≤ 总数） |
| `ATTACHMENT_MAX_BYTES`、`ATTACHMENT_QUOTA_BYTES` | 每次请求 | **第一版可改**（交叉检查：单个 ≤ 配额） |
| `AGENT_TIERS`、`AGENT_GROUP_CONTEXT_TOKENS`、`PROVIDER_DEFAULT_CONTEXT_TOKENS`、`PROVIDER_DEFAULT_MAX_OUTPUT_TOKENS`、`REASONING_ALLOWANCE_TOKENS`、`SEARCH_STATEMENT_TIMEOUT_MS` | 每次请求 | 以后可改（第一版只读） |
| `HOLDS`、`ALLOWANCE`、`WHISPERS`、`AGENTS` | 每次请求 | 以后可改（JSON，拆成小表单再说） |
| `SITE_MODELS` | 每次请求 | 以后可改其中的开关、显示名、价格；`baseUrl`、`apiKeyEnv` 只在环境变量 |
| `TOOLS` | 混合 | 第一版只开放 `web.siteUsdPerDay`（非零值之间）；`web.enabled` 启动时读，需要重启；`web.baseUrl`、`web.baseUrlProxy`、`web.apiKeyEnv` 只在环境变量 |
| `MEMORY`、`PROACTIVE` | 混合 | 以后（字段多、和 `JUDGE` 有运行时耦合） |
| `JUDGE` | 启动 | 需要重启；其中的 `url`、`apiKeyEnv` 只在环境变量 |
| `AGENT_RUN_TIMEOUT_MS`、`PROVIDER_MAX_CONCURRENT_CALLS`、`AGENT_MAX_RUNS_IN_FLIGHT`、`RATE_LIMIT_SCALE`、`MAIL_PER_ADDRESS_HOUR`、`SWEEP_INTERVAL_MINUTES`、`SITE_TIMEZONE` | 启动 | 需要重启，第一版只读 |

另：清点时发现的两处文档与代码不一致，可单独修——README 的服务密钥列表漏了 `RESEND_API_KEY`（代码 `SERVICE_SECRET_VARIABLES` 里有）；`PORT=""` 会被当成端口 0 接受，而 README 说“无效值会让服务起不来”。
