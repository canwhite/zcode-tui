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

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下命令均在仓库根目录执行。

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

## 仓库结构

| 目录                                           | 职责                                          |
| ---------------------------------------------- | --------------------------------------------- |
| `apps/zcode-cli`                               | Agent CLI、TUI、运行时与工具                  |
| `packages/shared`、`packages/model-option-map` | 共享协议和类型、模型选项映射                  |
| `packages/provider`、`packages/provider-node`  | Provider 公共能力与 Node 实现                 |
| `packages/zcode-cua`                           | Computer Use 接口占位包（本构建不提供该能力） |
| `scripts`、`config`、`third-party`             | 构建维护脚本、内置配置与第三方声明材料        |

相对上游本分支移除了以下目录：`packages/desktop`、`packages/web`、`packages/server`、`packages/ui`、`packages/client`、`packages/services`、`packages/rpc`、`packages/formal-proof`、`packages/zcode-server-cli`。

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。

第三方声明生成与发行校验流程见 [third-party/README.md](third-party/README.md)。注意：[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 `third-party/inventory.json` 目前仍按**完整仓库**的依赖生成，尚未随本次精简收敛，其中的组件清单会多于实际依赖。
