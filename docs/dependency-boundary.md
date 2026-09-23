# 依赖边界清单（F-001 产出）

> 本文件是 `docs/plan-slim-cli-tui.md` 第 2 步的产出，**是后续所有物理删除动作的唯一依据**。
> 基线：`2a35c8a`（分支 `slim-cli-tui`）｜仓库外副本：`~/zcode-baseline-<date>.bundle`
> 生成方式：实测（依赖图递归 + 源码注册表核对 + 反向引用扫描），非推断。

## 0. 一句话结论

**保留边界无法用依赖图算出来。** 保留集有**两个独立来源**，必须取并集：

1. **依赖图** —— `package.json` 的 `dependencies` / `peerDependencies` 递归闭包
2. **源码注册表** —— `apps/qcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_PLUGIN_DEFINITIONS`，插件通过 `rootCandidates` **在文件系统上探测目录**加载，**不出现在任何依赖图中**

只按依赖图算，必然误删插件包（安装成功、类型检查全绿、CLI 正常启动，但插件静默缺失）。

## 1. 边界规则（直接采用，不再重新推断）

| 范围                                                                 | 动作                                                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/qcode-cli/` 整棵子树（`packages/`、`tools/`、`dependencies/`） | **全部保留**，不删任何内容                                                                  |
| 根 `packages/` 保留 5 个                                             | `shared`、`provider-node`、`provider`、`model-option-map`、`zcode-cua`                      |
| 根 `packages/` 删除 9 个                                             | `client`、`desktop`、`formal-proof`、`rpc`、`server`、`services`、`ui`、`web`、`server-cli` |

> **关于 `formal-proof`**：反向引用扫描发现保留侧 `@zcode/bootstrap` 声明了对它的 devDependency，判定为历史残留，**结论仍是删除**，但必须连带清理那条悬空依赖 —— 完整依据见 §4，清理动作见 §6 第 5 项。

## 2. 保留集（`@zcode/cli` 运行时闭包，16 个包）

以 `@zcode/cli` 的 `dependencies` + `peerDependencies` 递归求解所得。

| 所在位置                   | 包                                                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/qcode-cli/packages/` | `cli`、`adapters`、`bootstrap`、`contracts`、`core`、`dynamic-workflow`、`dynamic-workflow-runtime`、`i18n`、`shared-types`、`telemetry`、`tui` |
| 根 `packages/`             | `shared`、`provider-node`、`provider`、`model-option-map`、`zcode-cua`                                                                          |

**`apps/qcode-cli/` 下另有若干不在此闭包内、但必须保留的包**（同属插件/工具盲区，见 §5）：
`browser-use-plugin`、`node-repl-host`、`superpowers-plugin`、`swift-bridge`、`debug`、`tools/prompt-trajectory`、`tools/typescript`、`dependencies/native-search`。

> **`@zcode/zcode-cua` 的重要说明**：它是**明示的占位包**（`README.md`：_"API-compatible placeholder package for Computer Use. This build ships without Computer Use"_；`index.js` 恒返回 `isError: true`）。保留它保留的是**接口兼容性**，**不是 Computer Use 能力** —— 源码版本来就不提供该能力，与删除动作无关。这也解释了它为何 `dependencies` 为空、目录内全是纯 JS。

## 3. 删除集（根 `packages/` 9 个包）

| 目录                        | 包名                  | 反向引用情况                             | 恢复命令                                            |
| --------------------------- | --------------------- | ---------------------------------------- | --------------------------------------------------- |
| `packages/client`           | `@zcode/client`       | 仅被删除侧引用（desktop / server / web） | `git checkout 2a35c8a -- packages/client`           |
| `packages/desktop`          | `@zcode/desktop`      | 无常驻引用                               | `git checkout 2a35c8a -- packages/desktop`          |
| `packages/formal-proof`     | `@zcode/formal-proof` | **保留侧 1 处 devDependency**（见 §4）   | `git checkout 2a35c8a -- packages/formal-proof`     |
| `packages/rpc`              | `@zcode/rpc`          | 仅被删除侧引用                           | `git checkout 2a35c8a -- packages/rpc`              |
| `packages/server`           | `@zcode/server`       | 仅被 `@zcode/desktop` 引用               | `git checkout 2a35c8a -- packages/server`           |
| `packages/services`         | `@zcode/services`     | 仅被删除侧引用                           | `git checkout 2a35c8a -- packages/services`         |
| `packages/ui`               | `@zcode/ui`           | 仅被 desktop / web 引用                  | `git checkout 2a35c8a -- packages/ui`               |
| `packages/web`              | `@zcode/web`          | 无常驻引用                               | `git checkout 2a35c8a -- packages/web`              |
| `packages/zcode-server-cli` | `@zcode/server-cli`   | 无常驻引用                               | `git checkout 2a35c8a -- packages/zcode-server-cli` |

整体回滚：`git reset --hard 2a35c8a`，或从 `~/zcode-baseline-<date>.bundle` 恢复。

## 4. 反向引用扫描结果（删除前实测）

扫描范围：全部 workspace 包的 `dependencies` / `peerDependencies` / `optionalDependencies` / **`devDependencies`**。

- 命中总数：17 处
- 其中 **16 处位于删除侧内部**（删除侧互相引用，可安全整体移除）
- **1 处位于保留侧 —— 必须处理**：

```
❌ @zcode/bootstrap [apps/qcode-cli/packages/bootstrap] devDependencies -> @zcode/formal-proof
```

**处理判定**：删除 `packages/formal-proof`，并**同步移除 `apps/qcode-cli/packages/bootstrap/package.json:42` 的这条 devDependency**。依据：

1. `@zcode/bootstrap` **没有 test 脚本、没有测试目录**（`package.json` 仅有 `build` / `clean` / `typecheck` / `lint` / `lint:fix`；目录仅 `src`、`package.json`、`tsconfig.json`）
2. `@zcode/bootstrap` 源码实际 import 的来源包为：`adapters`、`contracts`、`core`、`dynamic-workflow`、`dynamic-workflow-runtime`、`provider`、`provider-node`、`shared`、`telemetry` —— **不含 `formal-proof`**
3. 注释中声称的黄金测试 `formal-proof-consistency` **在整个仓库中不存在**（仅出现在两处注释：`packages/formal-proof/src/model.ts:485`、`bootstrap/src/zcode-protocol-v4/projection-state.ts:116`）
4. `packages/formal-proof` 本身是独立的 d3 可视化页面（`index.html` + `vite`，已被 lint ignore），与 CLI/TUI 无运行时关系

**结论：该 devDependency 是历史残留。** 不移除它会因解析不到 `workspace:*` 而直接导致 `pnpm install` 失败。

> **附带发现（不在本计划范围内，仅记录）**：`zcode-protocol-v4/projection-state.ts` 的注释称裁决表「黄金测试 `formal-proof-consistency` 背书」，但该测试从未落地。这条注释目前是**声明的保障与实际不存在之间的缺口**，属于保留侧代码，本次不修改。

## 5. 官方插件核对清单（第二个保留集来源）

来源：`apps/qcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_PLUGIN_DEFINITIONS`，每个插件通过 `rootCandidates` 探测目录。删除后必须逐项核对仍可解析。

| 插件                             | 仓库内是否存在                                  | 说明                                                          |
| -------------------------------- | ----------------------------------------------- | ------------------------------------------------------------- |
| `browser-use-plugin`             | ✅ `apps/qcode-cli/packages/browser-use-plugin` | 在本次保留范围内                                              |
| `node-repl-host`                 | ✅ `apps/qcode-cli/packages/node-repl-host`     | 在本次保留范围内，Browser Use 与 Computer Use 共用的 MCP 宿主 |
| `android-emulator-plugin`        | ❌ 仓库内不存在                                 | 由远程资产提供                                                |
| `image-search-plugin`            | ❌ 仓库内不存在                                 | 由远程资产提供                                                |
| `ios-simulator-plugin`           | ❌ 仓库内不存在                                 | 由远程资产提供                                                |
| `plugin-creator-plugin`          | ❌ 仓库内不存在                                 | 由远程资产提供                                                |
| `restore-legacy-sessions-plugin` | ❌ 仓库内不存在                                 | 由远程资产提供                                                |
| `skill-creator-plugin`           | ❌ 仓库内不存在                                 | 由远程资产提供                                                |
| `zcode-cua-plugin`               | ❌ 仓库内不存在                                 | 由远程资产提供；与占位包 `packages/zcode-cua` 是两回事        |
| `zcode-guide-plugin`             | ❌ 仓库内不存在                                 | 由远程资产提供                                                |

远程资产地址：`OFFICIAL_PLUGIN_ASSETS_BASE_URL = https://cdn-zcode.z.ai/zcode/official-plugin/assets`

> **判定**：8/10 插件不在仓库内，**本次删除动作与它们无关** —— 删或不删，这 8 个插件的可用性都取决于远程资产可达性。因此本计划范围内**不存在**因删除而导致插件不可用的情况。

## 6. 删除时必须同步清理的引用点

删除 9 个包时，以下位置若不同步更新会直接导致安装或门禁失败：

| #   | 位置                                                                                            | 具体条目                                                                                                                                                                                                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `pnpm-workspace.yaml`                                                                           | `packages/*` glob 会自动覆盖，无需改；但需确认没有逐个列举                                                                                                                                                                                                                                                  |
| 2   | 根 `package.json` scripts                                                                       | `dev:web`、`dev:server`、`prepare:desktop-runtime`、`build:bootstrap`、`bundle:desktop`、`prepare:remote-assets`                                                                                                                                                                                            |
| 3   | 根 `package.json` `typecheck`                                                                   | **硬编码枚举**：`packages/rpc`、`packages/provider`、`packages/provider-node`、`packages/shared`、`packages/services`、`packages/client`、`packages/server`、`packages/zcode-server-cli`、`packages/ui`、`packages/web`、`packages/desktop/tsconfig.host.json`                                              |
| 4   | `knip.json`                                                                                     | `workspaces` 中的 `packages/desktop`、`packages/server`、`packages/services`                                                                                                                                                                                                                                |
| 5   | `apps/qcode-cli/packages/bootstrap/package.json:42`                                             | `"@zcode/formal-proof": "workspace:*"`（§4）                                                                                                                                                                                                                                                                |
| 6   | `scripts/bootstrap.mjs:152`                                                                     | `["@zcode/rpc", "@zcode/web", "@zcode/formal-proof"]`                                                                                                                                                                                                                                                       |
| 7   | `scripts/build-zcode.mjs`、`scripts/dev-desktop-env.mjs`、`scripts/dev-desktop-remote-prod.mjs` | 引用桌面端/服务端的路径与包名                                                                                                                                                                                                                                                                               |
| 8   | `.oxlintrc.json:62`                                                                             | `ignorePatterns` 中的 `packages/formal-proof`                                                                                                                                                                                                                                                               |
| 9   | `architecture-policy.yaml:52-53`                                                                | `id: formal-proof` 条目                                                                                                                                                                                                                                                                                     |
| 10  | `third-party/inventory.json`                                                                    | **4862 / 18182 条**（27%）指向已删包。**本阶段不处理** —— 该文件为生成物（`.gitattributes` 标 `linguist-generated`），由 `scripts/generate-third-party-notices.mjs` / `third-party-notices.mjs` / `licenses.mjs` 消费，收敛属于 **Phase 3 的 F-008**。此处保留原样并在 Phase 3 重新生成，避免手改生成文件。 |
| 11  | `.gitignore`                                                                                    | `packages/desktop/**` 系列条目                                                                                                                                                                                                                                                                              |
| 12  | 两份 lockfile                                                                                   | 根 `pnpm-lock.yaml` + `apps/qcode-cli/pnpm-lock.yaml`（后者含 `link:` 指向根包）                                                                                                                                                                                                                            |
| 13  | 文档                                                                                            | `README.md`、`README.en.md`、`AGENTS.md`、`CONTEXT.md` 的命令表                                                                                                                                                                                                                                             |

## 7. 删除前的校验方法（可重复执行）

```bash
# 反向引用扫描：任何"保留侧"引用删除目标即为冲突
node /tmp/refscan.mjs

# 残留引用清点（删除后应归零）
grep -rnE "@zcode/(desktop|web|server|ui|client|services|rpc|server-cli|formal-proof)" \
  --include=*.ts --include=*.tsx --include=*.json --include=*.mjs --include=*.yaml \
  . --exclude-dir=node_modules
```

## 8.5 删除执行结果与残留引用（2026-09-22 实测）

**执行结果**：提交 `3d2dc20` 删除 9 个根包及其引用，`packages/` 仅剩 5 个保留包；后续提交收敛 `build:bootstrap` 并同步文档。

**验证证据**：

- `pnpm install`（含从零重建）通过，lockfile 中 electron 与已删包 **0 命中**，`node_modules/electron` 不存在；
- `pnpm typecheck` exit=0、`pnpm lint` exit=0（6 条既有 warning，位于未改动的 `packages/shared/src/validation.ts`）；
- 从零链路：`git clean -xfd` → `pnpm bootstrap`（exit 0，构建全量保留集）→ `node apps/qcode-cli/packages/cli/dist/zcode.cjs --version` → **`0.16.9`**。

**`pnpm knip` 仍为 exit 1（既有失败，非本次引入）**：它报告 `packages/shared`、`apps/qcode-cli/packages/contracts` 中的若干未使用导出。判定依据 —— `zcodeTaskGoalStatusSchema`、`taskStreamMirrorTargetSchema`、`WorkflowStrategySchema` 等**在基线提交中就没有任何消费者**，说明 knip 在精简前即为失败状态。本次删包额外产生了少量孤儿导出（例如 `credentialKeySchema` 的唯一消费者 `packages/services/src/credential/credentialService.ts` 已随之删除）。清理这些导出属于**修改保留侧业务代码**，不在本计划范围内。knip 不参与 `bootstrap` / `build` / `typecheck` / `lint` / `verify:pre-push` 任一环节，不阻塞 CLI 可用性。

**执行中发现并修复的既有缺口**：`build:bootstrap` 原为 `pnpm -r --filter "./packages/*" build`，**只覆盖根包**，不构建 `apps/qcode-cli` 子树 —— 而 `@zcode/contracts` 等的 `main` 指向 `dist/`，且 apps/qcode-cli 下**没有任何包带 `prepare` 脚本**，因此 `pnpm bootstrap` 之后 CLI 启动会 `ERR_MODULE_NOT_FOUND`。已改为 `pnpm --filter "@zcode/cli..." build`（`@zcode/cli...` 恰好覆盖全部 16 个保留包）。

**仍存在的残留引用（已评估，未处理）**：

| 位置                                                                                                        | 性质                                                               | 处置理由                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| `README.md` / `README.en.md` 第 80 行                                                                       | **有意保留**                                                       | 显式记录本分支移除了哪些目录                  |
| `THIRD-PARTY-NOTICES.md`、`third-party/inventory.json`                                                      | 生成物，4862/18182 条指向已删包                                    | F-008（Phase 3）重新生成，不手改生成文件      |
| `DESIGN.md:364,513`                                                                                         | UI 设计规范引用 `packages/ui/...`                                  | UI 已移除，规范整体不适用；是否删除属产品决策 |
| `NOTICE.md:30`                                                                                              | 链接指向已删的 `packages/zcode-server-cli/src/server-core/http.ts` | 属合规声明，收敛归 F-008                      |
| `.agents/skills/feature-boundary-planner/references/*`（`source-discovery.md`、`zcode-feature-graph.yaml`） | 面向完整仓库的功能-源码映射                                        | 该技能大半不再适用；是否保留属用户决策        |
| `.agents/skills/dep-refs/SKILL.md:34`                                                                       | 帮助文本示例引用 `packages/services`                               | 纯示例文本，无功能影响                        |

**结论**：计划 Goal #5「grep 命中数为 0」**未完全达成** —— 代码与配置层面已归零，剩余命中全部位于文档与技能参考材料，且多数需要产品决策（是否保留 UI/desktop 相关的说明与技能），不适合在本次执行中单方面删除。

## 8.6 Post-Mortem 补充（2026-09-22）

上一轮执行只对 `packages/...` 与 `@zcode/...` 两种模式做了全仓扫描，**命令名模式（`dev:desktop` / `dev:web` / `build:zcode` 等）仅在 4 份文档内查过**。本轮补齐该维度后发现的真实问题：

**已修复**：

| #   | 位置                            | 问题                                                                                                                                                                                          | 修复                                                                                           |
| --- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | `mise.toml`                     | `[tasks.dev]` / `[tasks.dev-desktop-prod]` / `[tasks.dev-web]` 指向已删命令，执行必失败；`[env] ELECTRON_MIRROR` 已无意义                                                                     | 三个任务中 `dev` 改为指向 `pnpm --filter @zcode/cli dev`，其余两个删除；移除 `ELECTRON_MIRROR` |
| 2   | `.vscode/`                      | `launch.json`、`tasks.json`、`start-electron.mjs`、`tsup-watch.mjs`、`vite-dev.mjs` 全部是 Electron 调试配置                                                                                  | 删除 5 个文件，保留 `extensions.json` / `settings.json`                                        |
| 3   | `.env.example`                  | 4 个变量在保留侧**无任何消费者**：`ZCODE_CDN_BASE_URL`、`ZCODE_CONVERSATION_SHARE_WEB_URL`、`ZCODE_REMOTE_ASSET_CDN_BASE_URL`（值指向 `.../electron/releases/3.14.0`）、`ZCODE_DIST_BASE_URL` | 移除这 4 项；其余 8 项经核实均有真实消费者                                                     |
| 4   | `.dockerignore`                 | `!packages/web/dist` 两行 + 4 条 `packages/desktop/*` 条目                                                                                                                                    | 移除                                                                                           |
| 5   | `docs/know-everything-zcode.md` | 格式不合规（**基线即已失败**）                                                                                                                                                                | 应用 oxfmt                                                                                     |
| 6   | 本次新建/改写的 6 个文件        | 格式不合规，导致 `pnpm fmt:check` 失败                                                                                                                                                        | 应用 oxfmt                                                                                     |

**验证为误报（不要"修"）**：

| 位置                                | 初看像问题                                                      | 实际                                                                                                                                                             |
| ----------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/qcode-cli/skills-lock.json:7` | `skillPath: "packages/web/src/content/SKILL.md"` 像指向已删路径 | 该字段是 **`anomalyco/opentui` 这个远端 GitHub 仓库内的路径**（同条目 `source`/`sourceType` 已声明），**不是本仓库路径**。按 grep 结果去改会把正确的锁文件改坏。 |
| `.architecture-baseline.json`       | 疑为以被删模块为基线                                            | 内容为 `{"version":1,"violations":[]}` 空基线，无引用                                                                                                            |
| `scripts/bootstrap.mjs` 的 3 处命中 | 像残留引用                                                      | 均为本次新增的**说明性注释**（记录移除了什么），属有意保留                                                                                                       |

**已核实通过、此前未运行的门禁**：`pnpm architecture:check --changed` exit=0（violations: 0）—— 它是 `verify:pre-push` 的后半段，上一轮只跑了 lint，未跑它。

**记录但未处理（需产品决策）**：

| 位置                                                                            | 说明                                                                                                                                              |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package.json` 的 `build:desktop-agent:bytecode`、`doctor:macos-release`        | 服务桌面端/发布流程的入口，未引用已删路径故不报错，但已无实际用途                                                                                 |
| `apps/qcode-cli/packages/cli` 的 `build:desktop-agent` + `turbo.json` 同名 task | 位于保留边界内（`apps/qcode-cli` 整棵子树不动），其消费方 `packages/desktop` 已删                                                                 |
| `scripts/native-search-tools-config.mjs` 默认 `outputDir`                       | 默认值指向 `packages/desktop/bundled-tools`，仅在调用方不传 `outputDir` 时生效                                                                    |
| `scripts/package-native-search-tools.mjs`                                       | `createRequire(repoRoot/packages/desktop/package.json)` 作为 `yazl` 解析基准；`createRequire` 不校验路径存在，故仅在走到 Windows zip 分支时才暴露 |
| `painpoints/*.md`                                                               | 4 个文件格式不合规，导致 `pnpm fmt:check` 仍为 exit 1。**属用户个人笔记，未改动**                                                                 |

**补充验证（TUI 路径）**：本环境无 TTY，无法渲染交互界面，但拿到三条直接证据说明 TUI 代码路径完好：

| 命令                                                        | 结果                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `node apps/qcode-cli/packages/cli/dist/zcode.cjs --version` | `0.16.9`，exit 0（管道 / 重定向到文件 / 直接输出三种 stdout 形态结果一致）                                                |
| `pnpm --filter @zcode/cli dev --help`                       | 输出 `zcode 0.0.0` 与完整 Usage，exit 0                                                                                   |
| `pnpm --filter @zcode/cli dev`（无 TTY）                    | 输出 **`TUI requires an interactive terminal.`** 后退出 1 —— 说明 CLI 已启动、已走到 TUI 启动路径、并正确拒绝了非交互环境 |

**调用形式注意（易踩坑）**：`pnpm --filter @zcode/cli dev -- <arg>` **不成立** —— pnpm 会把 `--` 原样传给脚本，CLI 收到 `["--", "<arg>"]`，进而把 `<arg>` 当作子命令并报 `Unknown command: <arg>`。正确形式是 **`pnpm --filter @zcode/cli dev <arg>`**（不加 `--`）。

## 8. 已知盲区（依赖图看不到、但已纳入保留范围）

以下包不出现在任何依赖图中，且**不在** `OFFICIAL_PLUGIN_DEFINITIONS` 里，但属于 `apps/qcode-cli/` 子树，按 §1 规则整体保留：

`superpowers-plugin`、`swift-bridge`、`debug`、`tools/prompt-trajectory`、`tools/typescript`、`dependencies/native-search`（18 个原生搜索归档 + SHA256SUMS）。

**这正是 §1 采用「整棵子树保留」这种粗粒度规则、而不去逐个判定的原因** —— 逐包判定的收益是少删几个小包，代价是漏删导致运行时静默缺能力。
