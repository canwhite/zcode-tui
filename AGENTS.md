> **仓库范围**：本仓库是精简分支，只保留 Agent CLI 与 TUI 及其依赖闭包。桌面应用、Web、后端服务、共享 UI 与发行包组装均已移除。保留边界见 `docs/dependency-boundary.md`。下文凡涉及已移除模块的条目均不适用。

## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 命令与仓库结构

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行：

| 用途             | 命令                                       |
| ---------------- | ------------------------------------------ |
| 类型检查         | `pnpm typecheck`                           |
| Lint             | `pnpm lint` / `pnpm lint:fix`              |
| 格式检查         | `pnpm fmt:check`                           |
| CLI / TUI 开发   | `pnpm --filter @qcode/cli dev`             |
| 提交前检查       | `pnpm verify:pre-push`（Lint 与架构检查）  |
| 架构检查         | `pnpm architecture:check --changed`        |
| 模块阅读包       | `pnpm architecture:context <module-id>`    |
| 未使用依赖与导出 | `pnpm knip`                                |
| 导出引用查询     | `pnpm dep:refs --list-exports <file>`      |
| 资源台账对账     | `node scripts/remote-resources.mjs check`  |
| 本地副本校验     | `node scripts/vendor-resources.mjs verify` |
| 刷新本地副本     | `node scripts/vendor-resources.mjs fetch`  |
| 断网验收         | `node test/offline-acceptance.mjs`         |
| 本地化资源扫描   | `node test/vendor-scan.mjs`                |

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

### 本地化资源（`third-party/vendored/`）

官方插件市场（清单 + 26 个插件包 + 图标，约 11 MiB）随仓库分发，使断网环境仍可列出并安装智谱插件。台账 `third-party/resources.json` 是**唯一真源**：资源范围按归属方划分——**智谱自家的远程资源在本地留一份，第三方通用包直接下载即可、不保留**（Node 运行时、上游源码包因此不入库）。

改这块时注意：

- **落点不得落进任何 `.gitignore`**。`apps/qcode-cli/.gitignore` 有一条裸 `vendor` 规则，`apps/qcode-cli/**/vendor*` 会被**静默忽略**——本地一切正常，克隆到断网机器才全线失败。入库前跑 `vendor-resources.mjs assert`。
- **改 `@qcode/bootstrap` 必须单独重建它**。`@qcode/cli` 打包时解析的是 bootstrap 的 `dist` 而非源码；只重建 adapters 与 cli 会让改动"没进产物却也不报错"。
- **`@qcode/contracts` 的 `exports` 指向 `.ts` 源码**，只有打包器能解析，因此这条链路无法用 node/tsx 直接单测，验证要走真实产物（`pnpm --filter @qcode/cli build` 后用 `QCODE_STORAGE_DIR` 隔离跑 CLI）。
- 排障：`QCODE_DEBUG_VENDOR=1` 会打印本地副本根的解析过程；`QCODE_VENDORED_ASSETS_ROOT` 可显式指定副本位置。`qcode doctor` 会报出本地化覆盖率。

- `apps/qcode-cli`：Agent CLI、TUI 与运行时；其 `packages/`、`tools/`、`dependencies/` 整棵子树均在保留边界内。
- `packages/shared`、`packages/model-option-map`：共享协议与类型、模型选项映射。
- `packages/provider`、`packages/provider-node`：Provider 公共能力与 Node 实现。
- `packages/qcode-cua`：Computer Use 接口占位包；本构建不提供该能力，调用会返回不可用。
- `docs/dependency-boundary.md`：保留 / 剔除边界及判定依据。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止跨域导入实现细节及循环依赖。

## 进程、协议与远程控制

- CLI 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/qcode-protocol/index.ts`，提供严格类型与运行时校验。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission。
- 保留 owner/lease 与 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
