# zcode-tui

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

ZCode 是 AI 编程工作台。

> **本仓库是精简分支：只保留 Agent CLI 与 TUI 及其依赖闭包。** 相对上游已移除桌面应用、浏览器界面、后端服务、发行包组装与远程资源准备。保留边界与逐一判定依据见 [docs/dependency-boundary.md](docs/dependency-boundary.md)。

| 入口      | 用途                                    | 开发命令                       |
| --------- | --------------------------------------- | ------------------------------ |
| Agent CLI | 在终端中使用 `zcode`，承载 Agent 运行时 | `pnpm --filter @zcode/cli dev` |
| TUI       | 终端内交互界面，由 Agent CLI 启动       | `pnpm --filter @zcode/cli dev` |

## 初始化

准备 Git、Node.js **>=22.13.0**（推荐 24.14.0）和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下命令均在仓库根目录执行。

> 下限 22.13.0 来自 `node:sqlite`：该模块在 Node 22.5.0 引入，22.13.0 起不再需要 `--experimental-sqlite`。Node 20/21 没有这个内置模块，启动即报 `ERR_UNKNOWN_BUILTIN_MODULE`，无法通过降低声明来兼容。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖，随后执行 `build:bootstrap` —— 即构建 `@zcode/cli` 及其全部 workspace 依赖。安装路径不包含 electron 等桌面端依赖。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

其他可单独执行的入口：

| 命令             | 用途                                     |
| ---------------- | ---------------------------------------- |
| `pnpm install`   | 安装依赖                                 |
| `pnpm build`     | 递归执行各 workspace 包的构建脚本        |
| `pnpm typecheck` | 对保留的根包执行 TypeScript 项目引用检查 |
| `pnpm lint`      | 运行根 linter                            |

## 开发与运行

### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口。TUI 需要交互式终端：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖，并运行构建产物
pnpm --filter "@zcode/cli..." build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

### 个人配置放在哪

**个人配置读 `~/.claude`，运行时数据留 `~/.zcode`。两者互不派生。**

| 内容                       | 位置                                |
| -------------------------- | ----------------------------------- |
| 个人 skill                 | `~/.claude/skills/<name>/SKILL.md`  |
| 全局指令                   | `~/.claude/CLAUDE.md`               |
| 个人命令                   | `~/.claude/commands/<name>.md`      |
| 用户级 MCP                 | `~/.claude.json` 的 `mcpServers`    |
| 项目级 MCP                 | `<仓库>/.mcp.json` 的 `mcpServers`  |
| 会话、凭据、厂商配置、日志 | `~/.zcode/`（继续留在此处，不迁移） |

个人 skill 会作为**一级斜杠命令**暴露 —— 输入 `/<skill-name>` 即可，无需 `/skill` 前缀。
`~/.claude` 不存在时首次运行会自动创建并写入一份说明文件；设
`ZCODE_NO_CONFIG_HOME_BOOTSTRAP=1` 可关闭。用 `zcode doctor` 可查看实际生效的配置家目录与各来源数量。

> 从旧版本升级：`~/.zcode/skills` 与 `~/.zcode/AGENTS.md` **已不再读取**。
> 迁移到上表对应位置后即可生效；`zcode doctor` 在检测到旧位置仍有 skill 时会给出提示。

## 仓库结构

| 目录                                           | 职责                                          |
| ---------------------------------------------- | --------------------------------------------- |
| `apps/zcode-cli`                               | Agent CLI、TUI、运行时与工具                  |
| `packages/shared`、`packages/model-option-map` | 共享协议和类型、模型选项映射                  |
| `packages/provider`、`packages/provider-node`  | Provider 公共能力与 Node 实现                 |
| `packages/zcode-cua`                           | Computer Use 接口占位包（本构建不提供该能力） |
| `scripts`、`config`、`third-party`             | 构建维护脚本、内置配置与第三方声明材料        |

相对上游本分支移除了以下目录：`packages/desktop`、`packages/web`、`packages/server`、`packages/ui`、`packages/client`、`packages/services`、`packages/rpc`、`packages/formal-proof`、`packages/zcode-server-cli`。

## 离线可用性

官方插件市场（清单、26 个插件包与图标，约 11 MiB）**随仓库分发**，位于 `third-party/vendored/zhipu-official-plugin/`。因此**断网环境也能列出并安装智谱的官方插件**——市场清单与插件包都从本地副本读取，不需要回源 CDN。

判定口径：**智谱自家的远程资源在本地留一份；第三方通用包（Node 运行时、上游源码包等）直接下载即可，不保留。** 台账 [third-party/resources.json](third-party/resources.json) 是唯一真源，两类都登记，只有前者随仓库分发。

| 目的                   | 命令                                       |
| ---------------------- | ------------------------------------------ |
| 校验本地副本完整       | `node scripts/vendor-resources.mjs verify` |
| 刷新本地副本           | `node scripts/vendor-resources.mjs fetch`  |
| 核对台账与实际引用一致 | `node scripts/remote-resources.mjs check`  |
| 断网验收               | `node test/offline-acceptance.mjs`         |

`zcode doctor` 会报出本地化覆盖率（`覆盖率 100%（26/26），断网可列出并安装`）；副本缺失或损坏时会直接失败并指名缺的是哪个插件。

> 注意：断网可用指的是**插件的列出与安装**。这些插件本身多为联网业务插件（金融数据、公司查询等），其业务数据来自第三方服务，不在随仓库分发的范围内。

## 本分支的改动

> 本仓库相对上游为精简分支（保留边界见 [docs/dependency-boundary.md](docs/dependency-boundary.md)）。在此之上，本分支另做了下列改动。**被修改的上游文件已在文件头标注 `Modified by ZCode:`**，逐条说明见下表。

### 新增文件（本分支原创）

| 文件                                                                       | 作用                                                                   |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `scripts/remote-resources.mjs`                                             | 远程资源台账的读取与对账（台账 vs 源码实际获取点，差集非空即失败）     |
| `scripts/vendor-resources.mjs`                                             | 本地化资源的下载与校验（sha256 校验后原子落盘、幂等、落点忽略断言）    |
| `test/offline-acceptance.mjs`                                              | 断网验收关卡，8 条断言                                                 |
| `test/vendor-scan.mjs`                                                     | 本地化资源的行为扫描（后门 + 特例判断），含受保护载荷解密              |
| `third-party/resources.json`                                               | 远程资源台账（唯一真源）                                               |
| `third-party/vendored/zhipu-official-plugin/**`                            | 随仓库分发的官方插件市场副本（清单 + 26 个插件包 + 图标，约 11 MiB）   |
| `apps/zcode-cli/packages/adapters/src/plugins/official-vendored-assets.ts` | 官方 CDN URL → 本地副本的寻址原语                                      |
| `test/zero-account-acceptance.mjs`                                         | 「零账号可用」验收关卡，10 条断言（见 pp8 一节）                       |
| `test/repro-pp10-skill-command.mts`                                        | 一级 skill 命令的复现关卡（见 pp10 一节）                              |
| `test/step0-gateway-necessity.md`                                          | 网关必需性判定的证据记录（前提闭合情况、两种状态实测结果、已接受取舍） |

### 修改的文件

**离线本地化**（`painpoints/done/pp2.md`）

| 文件                                                                   | 改动                                                                                       |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts`           | 插件包改为**本地优先**读取（仅改寻址，清单发布的 sha256 校验不变）；回源失败时给出指名诊断 |
| `apps/zcode-cli/packages/adapters/src/plugins/official-marketplace.ts` | 新增 `seedCdnPartitionFromVendoredSync`：用随仓库分发的清单为 CDN 分片播种                 |
| `apps/zcode-cli/packages/adapters/src/plugins/index.ts`                | 导出本地化资源的寻址原语                                                                   |
| `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`         | 写入内置分片后播种 CDN 分片，使首次启动断网也能列出官方插件                                |
| `scripts/clean.mjs`                                                    | 新增受保护根断言与清理后快照自检，避免误删随仓库分发的资源                                 |
| `.gitignore`                                                           | 排除第三方通用包的本地缓存落点，同时确保随仓库分发的本地化资源不被忽略                     |

**厂商配置与安装**（`painpoints/done/pp4.md`、`pp5.md`、`pp8.md`）

| 文件                                                        | 改动                                                                                                                                                                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/cli/src/run.ts`                    | 接入 `doctor` 自检与 CLI 入口级 `.env` 统一加载                                                                                                                                                                 |
| `apps/zcode-cli/packages/cli/src/env.ts`                    | 抽出入口统一加载 `.env` 的实现（原先各命令各自加载）                                                                                                                                                            |
| `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts`   | 让 `configure` 也先准备好内置与个人 Provider Config 的路径环境变量                                                                                                                                              |
| `apps/zcode-cli/packages/cli/src/arguments.ts`              | 新增 `configure` 的 `--api-key` / `--provider`，Key 可从环境变量读取以免出现在命令行                                                                                                                            |
| `apps/zcode-cli/packages/cli/src/doctor.ts`（分支新增）     | 新增「官方插件本地化」自检项，报出覆盖率；副本缺失或损坏时指名失败。另于 pp8 post-mortem 新增「默认模型指向已移除 Provider」的 WARN（**指名**该 Provider，而非让运行时只报 `Select a model before continuing`） |
| `apps/zcode-cli/packages/shared-types/src/index.ts`         | 新增 `configure` 非交互写入所需字段                                                                                                                                                                             |
| `packages/provider/src/model-selection-config.ts`           | 区分 registry 顺序兜底与「用户配置的模型已不可选」兜底，两种降级分开报告                                                                                                                                        |
| `apps/zcode-cli/packages/i18n/src/locales/{zh-CN,en-US}.ts` | 同步 CLI 帮助文案（新增 `configure`，订正 `doctor` 描述）                                                                                                                                                       |
| `.env.example`                                              | 改为 `ZCODE_VENDOR` 四字段驱动的厂商配置模板                                                                                                                                                                    |

**断开模型请求的平台网关改写**（`painpoints/pp8.md`）

模型请求原先会被改写为 ZCode 平台网关端点（`{endpoint}/api/v1/ultra[-zai]/anthropic/...`），由平台侧做套餐权益校验与内容安全校验。现改为**一律直连所配置厂商**。依据是 Step 0 实测：套餐 key 直连厂商端点可用，且用量元数据与经网关时一致 —— 见 [`test/step0-gateway-necessity.md`](test/step0-gateway-necessity.md)。

| 文件                                                                         | 改动                                                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts` | **删除**（原端点改写、fetch 包装与 `OFFICIAL_CODING_PLAN_GATEWAY_ROUTES` 路由表） |
| `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`              | 移除网关 fetch 包装；`createProviderTransportFetch` 改为纯直连出口；保留沿革注释  |
| `apps/zcode-cli/packages/adapters/src/model/index.ts`                        | 移除网关模块的 barrel 导出                                                        |
| `test/step0-gateway-necessity.md`（分支新增）                                | Step 0 判定证据记录（前提闭合情况、两种状态实测结果、已接受的取舍）               |

> **四处行为变化**：① 请求不再经 `zcode.z.ai` 中转，少一跳；② HTTP 代理规则（`httpProxy` / `noProxy`）改为按**厂商端点**判定（原先按网关地址判定）——企业网络用户可感知；③ 平台侧 `3007` 内容安全校验不再触发，相关错误路径退化为死代码（待清理）；④ **平台侧计费归属未经证实**，如需确证须向平台侧确认。
>
> **内置配置同步清理**：`config/provider/zcode-builtin.json` 中原有 **7 条指向 `zcode.z.ai` 的条目** —— 4 条 `providerRules`（`start-plan` / `off-peak` 平台套餐）与 3 条 `providerSiteRules`（按 `baseUrlMatch` 为这些端点注入模型能力），外加引用它们的 10 条 `builtinProviderModelRules` —— 已全部移除。`revision` 由 30 提升至 32：该字段是账号型 Provider 快照的重建判据（`process-provider-registry-runtime.ts`），**不 bump 则改动不生效**。
>
> ⚠️ **连带后果（已确认接受）**：`start-plan` 与 `off-peak` 两条平台套餐自此**不可用**，其代码路径变为**不可达但不报错**（约 68 个文件涉 off-peak，含闲时任务工具）。这是静默行为变化，**代码层全量清理尚未进行**。

**移除登录 / 鉴权 / 登出**（`painpoints/pp8.md`）

工具的账号概念整体移除。**保留 Coding Plan 的非登录配置路径**：套餐 key 由用户在套餐控制台取得后经 `zcode configure --api-key` 直接写入，全程无需登录。

**删除（11 个文件）**

| 文件                                                         | 作用                                              |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `bootstrap/src/auth-login.ts`                                | 登录编排（另见下方改名）                          |
| `bootstrap/src/auth-login-polling.ts`、`auth-login-abort.ts` | 授权轮询与中断                                    |
| `adapters/src/auth/cli-oauth.ts`                             | OAuth PKCE 客户端（内含 `zcode.z.ai` 硬编码副本） |
| `adapters/src/auth/coding-plan-api-key.ts`                   | OAuth 令牌 → 套餐 Key 兑换                        |
| `adapters/src/auth/bigmodel-oauth.ts`、`browser.ts`          | 登录专用（前者本就零调用）                        |
| `cli/src/login-command.ts`、`tui-auth.ts`                    | CLI 子命令与 TUI 登录包装                         |
| `command-center/login-flow.ts`                               | `/login` 选择器与结果格式化                       |

**改名 / 保留**

| 文件                                                                             | 改动                                                      |
| -------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `bootstrap/src/auth-login.ts` → `coding-plan-config.ts`                          | 仅保留**非登录**的 `configureCodingPlanApiKey` 链         |
| `cli/src/tui-auth.ts` → `tui-provider-config.ts`                                 | 仅保留 `configureApiKeyForTui`                            |
| `cli/src/tui-login-state.ts` → `tui-provider-setup-state.ts`                     | 门禁响应与可用模型判定                                    |
| `adapters/src/auth/{shared-credentials,credential-cipher,localhost-callback}.ts` | **保留** —— 与 MCP 服务器 OAuth 共用，删除会打断 MCP 登录 |

**修改**

| 文件                                                                                   | 改动                                                                         |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `packages/shared/src/zcode-slash-command-help.ts`                                      | 摘除 `login`/`logout` 条目；保留名门禁由其派生，故一并生效                   |
| `cli/src/command-center/{slash-commands,slash-command-types,create,types,history}.ts`  | 摘除解析分支、类型成员、`/login` 与 `/logout` handler、密钥入历史的抑制规则  |
| `cli/src/{run.ts,prompt-command.ts,arguments.ts,cli-types.ts,provider-runtime-env.ts}` | 摘除子命令、headless 路由、`--no-browser`、登录 DI 钩子                      |
| `cli/src/command-center/create.ts`                                                     | 无模型门禁判据由「未登录」改为「厂商未配置」                                 |
| `cli/src/tui-prompt-handler{,-queries}.ts`、`cli/src/tui-command.ts`                   | `loginRequired` → `providerSetupRequired` 传递与投影                         |
| `tui/src/{app,app-view,app-components,app-result,types}.tsx?`                          | 同上改名；`LoginRequiredPanel` → `ProviderSetupRequiredPanel`                |
| `tui/src/app-submit.ts`                                                                | 摘除已无法命中的 `/login` transcript 脱敏函数                                |
| `i18n/src/locales/{zh-CN,en-US}.ts`、`i18n/src/types.ts`                               | 摘除登录帮助行与 `loginSetup` 选择器；门禁文案改为指向 `.env` 与 `configure` |
| `bootstrap/src/app/standalone-account-provider-runtime.ts`                             | 错误信息原为 `is required for login`，改为指向内置 Provider 配置             |

> ⚠️ **上游同步注意**：本次删除横跨 `bootstrap` / `cli` / `adapters` / `i18n` / `tui` / `shared` 六个包。下次同步上游时，这些删除会与上游对同一批文件的修改大面积冲突；若「以上游为准」，登录会被静默恢复。`test/step0-gateway-necessity.md` 与后续验收关卡是唯一防线。
>
> ⚠️ **已知取舍**：移除 `/login` 后，TUI 内不再有任何配置厂商的入口（原 `/login *-api-key` 是唯一入口）。CLI 侧 `zcode configure --api-key` 不受影响，门禁文案已指向它。

**验收关卡**：本仓库**没有任何单元测试**，拆除后最容易的失效形态是「上游同步把登录或隐式回连重新引进来，而没有东西会失败」。因此新增 `test/zero-account-acceptance.mjs`（10 条断言）作为唯一防线，并接入 `pnpm run verify:pre-push`：

```bash
pnpm run test:zero-account     # 需要先 pnpm run build（该关卡不静默跳过）
```

断言覆盖（**10 条**）：命令面无 login/logout、`zcode login` 与 `/login` `/logout` 报未知命令、构建产物不含平台网关改写路径、**内置配置整份无任何 `zcode.z.ai` 引用**（递归扫描，同时覆盖 JSON 转义的 `zcode\.z\.ai` 写法；排除 `cdn-zcode.z.ai`）、仅凭 API Key 可完成**自建端点**与**套餐**两条分支的配置，且落盘无登录态键。

两条关键断言已验证**可失败**，不是空断言：向产物注入网关路径串 → 关卡 FAIL；向 `providerSiteRules` 注入 `baseUrlMatch` 残留 → 关卡 FAIL。

> ⚠️ **该关卡曾产生假绿**（post-mortem PM-1 / PM-2）：早期版本只扫 `providerConfigRules[*].config.api.baseUrl`，**不检查 `modelConfigRules`**，因此 3 处以 `baseUrlMatch` 形式残留的 `zcode.z.ai` 被放过、关卡报绿 —— 一个用来防「静默复发」的关卡自己产生了静默假绿。现改为递归扫描整份配置。
> **教训**：断言「某物不存在」时，必须同时覆盖**字面量与转义**两种写法，并证明该断言能被一次反例证伪。

**个人 skill 一级命令：大小写修复**（`painpoints/pp10.md`）

**现象**：输入 `/pain-decomposition` 报 `Unknown command: /pain-decomposition`，**而同一条报错里列出的可用命令却包含 `/pain-decomposition`** —— 报错自相矛盾：它一边说"不认识"，一边把它列为可用。

**根因**：一级 skill 命令的解析拿 `slashCommand.rawName` 去匹配 skill，而该值已被 `parseSlashCommand` **小写化**；skill 加载却是**大小写精确匹配**（adapters 的 `matchesSkillRequest` 用 `===`）。因此含大写的 skill 名（如 `no-useEffect`）永远匹配不上，径直落到「未知命令」分支 —— 尽管同一份 skill 清单已被用于生成那句报错里的可用列表。

| 文件                                                | 改动                                                                                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/cli/src/prompt-command.ts` | `resolveSkillCommandName` 改为回传 skill 的**规范名**（`findSkillEntry(...)?.name`）而非小写 `rawName`；移除随之冗余的 `isResolvableSkillName` |
| `test/repro-pp10-skill-command.mts`（分支新增）     | 复现关卡：用**真实**的 skill 发现与自定义命令加载器（输入列表与 TUI 建议逐字节一致），验证一级 skill 命令确实到达 app                          |
| `docs/plan-btw-side-question.md`                    | 计划文档更新                                                                                                                                   |

> `package.json` 与 `apps/zcode-cli/package.json` 亦有改动（`engines.node` 下限、`configure` 脚本等），但 **JSON 不支持注释**，无法在文件内标注 `Modified by ZCode:`——改动记录以本节为准。`pnpm-lock.yaml` 为生成物，同理不标注。

其余为本分支自身的文档（`README*`、`AGENTS.md`、`docs/`）。

### 随仓库分发的第三方内容（许可提示）

`third-party/vendored/zhipu-official-plugin/` 下的 26 个插件包**逐字节原样入库**（sha256 校验，未解包重打包），因此包内自带的许可原文完整保留。其中 **5 个插件包内含非智谱的第三方代码**：

| 插件               | 授权 | 版权方                                |
| ------------------ | ---- | ------------------------------------- |
| `gitlab`           | MIT  | GitLab Inc.、GitHub Inc.              |
| `obsidian`         | MIT  | Steph Ango (@kepano)、Axton Liu、Z.ai |
| `cloudbase-skills` | MIT  | TencentCloudBase                      |
| `mimosa`           | MIT  | Mimosa                                |
| `video2code`       | MIT  | Z.ai                                  |

这些许可原文随各自的 `plugin.zip` 一同分发；**尚未汇总进 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)**（该文件按完整仓库的依赖图生成，且生成链路当前存在既存故障）。如需完整汇总，见 `docs/plan-offline-vendoring.md` 的 Open Questions。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。

第三方声明生成与发行校验流程见 [third-party/README.md](third-party/README.md)。注意：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 `third-party/inventory.json` 目前仍按**完整仓库**的依赖生成，尚未随本次精简收敛，其中的组件清单会多于实际依赖。
