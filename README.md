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

| 文件                                                                       | 作用                                                                 |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `scripts/remote-resources.mjs`                                             | 远程资源台账的读取与对账（台账 vs 源码实际获取点，差集非空即失败）   |
| `scripts/vendor-resources.mjs`                                             | 本地化资源的下载与校验（sha256 校验后原子落盘、幂等、落点忽略断言）  |
| `test/offline-acceptance.mjs`                                              | 断网验收关卡，8 条断言                                               |
| `test/vendor-scan.mjs`                                                     | 本地化资源的行为扫描（后门 + 特例判断），含受保护载荷解密            |
| `third-party/resources.json`                                               | 远程资源台账（唯一真源）                                             |
| `third-party/vendored/zhipu-official-plugin/**`                            | 随仓库分发的官方插件市场副本（清单 + 26 个插件包 + 图标，约 11 MiB） |
| `apps/zcode-cli/packages/adapters/src/plugins/official-vendored-assets.ts` | 官方 CDN URL → 本地副本的寻址原语                                    |

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

| 文件                                                        | 改动                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/zcode-cli/packages/cli/src/run.ts`                    | 接入 `doctor` 自检与 CLI 入口级 `.env` 统一加载                                      |
| `apps/zcode-cli/packages/cli/src/env.ts`                    | 抽出入口统一加载 `.env` 的实现（原先各命令各自加载）                                 |
| `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts`   | 让 `configure` 也先准备好内置与个人 Provider Config 的路径环境变量                   |
| `apps/zcode-cli/packages/cli/src/arguments.ts`              | 新增 `configure` 的 `--api-key` / `--provider`，Key 可从环境变量读取以免出现在命令行 |
| `apps/zcode-cli/packages/cli/src/doctor.ts`（分支新增）     | 新增「官方插件本地化」自检项，报出覆盖率；副本缺失或损坏时指名失败                   |
| `apps/zcode-cli/packages/shared-types/src/index.ts`         | 新增 `configure` 非交互写入所需字段                                                  |
| `packages/provider/src/model-selection-config.ts`           | 区分 registry 顺序兜底与「用户配置的模型已不可选」兜底，两种降级分开报告             |
| `apps/zcode-cli/packages/i18n/src/locales/{zh-CN,en-US}.ts` | 同步 CLI 帮助文案（新增 `configure`，订正 `doctor` 描述）                            |
| `.env.example`                                              | 改为 `ZCODE_VENDOR` 四字段驱动的厂商配置模板                                         |

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
