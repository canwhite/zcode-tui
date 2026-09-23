# Plan: 一条命令安装 —— `make install` 后配置 env 即可用 zcode

> 让 `make install` 一条命令完成工具链准备、构建、全局暴露与配置校验，用户只需填项目根 `.env`，即可在终端直接输入 `zcode` 使用。

## 执行状态（2026-09-22 更新）

阶段 A~F 均已实现并通过验证。与原计划的偏差与遗留项：

| 项 | 结果 |
|----|------|
| 阶段 A（`.env` 统一加载 + doctor 自检） | 已完成。入口统一加载点在 `run.ts`；`doctor` 扩展为安装自检并返回非零退出码，保留 `--json` |
| 阶段 B（Makefile） | 已完成。`install` / `prune` / `clean` / `doctor` 四个 target，逻辑在 `scripts/install/` |
| 阶段 C（环境前置） | 已完成。Node 版本不符时**阻断安装**（实测本机 Node v22 被拦下） |
| 阶段 D（全局暴露） | 已完成。软链接落在 `~/.local/bin/zcode`（本机 `pnpm bin -g` 不可用，走了回落路径） |
| 阶段 E（配置生成） | 已完成。只追加缺失键；本机 `.env` 已存在，未覆盖任何已有值 |
| 阶段 F（自检收口） | 已完成。`make install` 结束自动自检，失败即非零退出码 |
| **新增** `zcode configure` | 计划外。用于非交互写入 Coding Plan Key 并预置默认模型（`GLM-5.3`），与 TUI 命令中心复用同一 bootstrap 入口 |
| **偏差**：`make prune` 未用 `--prod` | 计划第 20 条原写 `pnpm install --prod`，实测会一并移除 `esbuild`/`typescript` 等构建依赖，使 `make install` 与 `pnpm typecheck` 失效。改为白名单移除（`scripts/install/install.mjs` 的 `PRUNE_TARGETS`），可逆且影响面明确 |
| ~~遗留：`~/.local/bin` 不在用户 PATH~~ | **已补齐**：`make install` 现在会按 `$SHELL` 把 PATH 行写入 `~/.zshrc`（或 `~/.bashrc`），带标记注释、可幂等重跑、可撤销。幂等判定按「该目录是否已进 PATH」而非字面比较——否则用户自带的 `$HOME/.local/bin` 写法会被误判为不存在而重复追加。识别不出 shell（如 fish）时降级为打印指引，不猜文件 |
| **遗留**：`pnpm build`（根递归构建）失败 | 与本次改动无关：在干净基线上复现同样的 `@zcode/node-repl-host` 缺少 `@modelcontextprotocol/sdk` 错误。已在基线验证确认既存 |
| **遗留**：`.env` 仅从 cwd 向上查找 | 在项目根以外启动时 `.env` 不生效（`doctor` 会 WARN 提示）；这与「任意目录直接输入 zcode」的诉求仍有一处张力，见 Open Questions |

## Context

来源痛点拆解：[docs/painpoint-one-command-install.md](painpoint-one-command-install.md)（痛点 A~E，核心诉求"make install 之后所有的工作都做好"）。

本仓库是精简分支（只保留 CLI/TUI 及其依赖闭包，见 [plan-slim-cli-tui.md](plan-slim-cli-tui.md)），**当前仓库根目录没有 Makefile**，安装口令分散在 `mise.toml`、`pnpm bootstrap`（`scripts/bootstrap.mjs`）与 README 三处。

计划前已完成的源码核对（结论直接改写原痛点的优先级）：

| 结论 | 证据 |
|------|------|
| TUI 主路径**不读 `.env`** | `apps/qcode-cli/packages/cli/src/tui-command.ts:33` 直接用 `deps.env ?? process.env`，未调用 `loadCliDotenv` |
| 只有特定命令读 `.env` | `login-command.ts:21,94`、`prompt-command.ts:154`、`tui-auth.ts:16,41,77`、`run.ts:247`（仅 development 的 protocol server）、`run.ts:480`（注入 `loadDotenv` 回调） |
| `.env` 查找方式 | `apps/qcode-cli/packages/cli/src/env.ts:50` `findDotenv` 从 cwd 逐级向上；`override:false`（shell 环境变量优先） |
| `.env` **不是**构建期内联 | `apps/qcode-cli/packages/cli/scripts/build.mjs:232` 的 `define` 只注入 `__CLI_VERSION__`；`packages/shared/src/zcodeEndpoint.ts:10,27` 的 `__ZCODE_ENDPOINT_ENV__` 走运行时 |
| 端点缺失时**静默回落** | `packages/shared/src/zcodeEndpoint.ts:132` 回落到 `DEFAULT_ZCODE_ENDPOINT_ORIGIN`，用户无从察觉 |
| `zcode doctor` 过于单薄 | `apps/qcode-cli/packages/cli/src/run.ts:188` 只打印 version/process/node/platform/sea/packaging，**不校验配置是否可达** |
| `pnpm clean` 是"清空"不是"裁剪" | `scripts/clean.mjs` 删 `node_modules` 与 `dist` 全量 |
| `@zcode/cli` 的 `bin` 指向仓库内 dist | `apps/qcode-cli/packages/cli/package.json` → `"zcode": "./dist/zcode.cjs"`，仓库外不可见 |

本机实测环境（决定了计划里必须有降级路径）：

```
make      /usr/bin/make          ✅
git       /usr/bin/git           ✅
node      v22.23.2               ⚠️ 仓库 pin 24.14.0
pnpm      10.33.2 (nvm 下)       ✅ 版本符合，但来自 nvm 而非 mise
mise      MISSING                ⚠️ mise.toml 的 pin 机制不可用
pnpm bin -g  /Users/doing/Library/pnpm/bin   ⚠️ 该目录不在 PATH（`zcode not found` 的根因）
```

已确认的产品决策（来自痛点拆解第 9 章 + 本轮确认）：

1. 全局安装到 PATH；`prune` 与 `clean` 拆成两个 target；服务地址与密钥配在**项目根 `.env`**。
2. 配置生成**只追加缺失键，不覆盖**已存在的值。
3. 执行顺序：**先完成 `.env` 统一加载闭环，再进入 Phase 1 全量**（F-001 ~ F-005）。

## Goal

在一台只有 git + node 的机器上：

1. `make install` 退出码为 0，且**不需要任何人工干预**（手工步骤数 = 0）。
2. 安装结束后 `zcode` 在**任意 cwd** 下可直接执行（`command -v zcode` 有输出）。
3. 用户在**项目根 `.env`** 填入 base url 与 api key 后，`zcode` 能读到并解析出正确端点。
4. `zcode doctor` 能给出**安装自检结论**：任一核心项失败时输出"哪一项 / 期望什么 / 怎么修"并返回非零退出码。
5. `make prune` 裁剪后 `zcode` 仍可启动（成功率 100%）；`make clean` 后可重新 `make install` 成功。

## Plan

### 阶段 A（前置，独立可验证）：统一 `.env` 加载与 `doctor` 自检

> 先做这一段的原因：它才是"改 env 就能用"的真正阻塞点，且与安装方式正交。如果不先修，后面 F-003 把 `zcode` 装到全局后，用户在任何目录启动 TUI 依旧读不到 `.env`——痛点原封不动。

1. **确定唯一加载点与生效范围**。在 CLI 入口（`apps/qcode-cli/packages/cli/src/run.ts`）于解析出 `workingDirectory`（`run.ts:462` `resolveCliCwd`）之后、分发子命令之前，**统一加载一次** `.env`，使所有命令（含 `tui`）共享同一份已加载的 env。

2. **保留现有例外**。`run.ts:246` 的 `shouldLoadCliDotenvForProtocolServer` 明确不读 workspace `.env`（注释说明打包态 app-server 读用户 `.env` 会导致协议建立前直接退出）。该例外必须保留并显式注释原因，不能在"统一"中顺手抹掉。

3. **消除重复加载**。`login-command.ts`、`prompt-command.ts`、`tui-auth.ts` 内的 `loadCliDotenv` 调用点，在入口统一加载后改为复用已加载结果（或降级为幂等 no-op），避免二次解析与 `override:false` 语义下的重复 IO。

4. **保持优先级语义不变**。`override: false` 意味着 **shell 环境变量优先于 `.env`**。这是既有约定，`make install` 的文档与自检输出都要如实说明，不得反转。

5. **扩展 `zcode doctor` 为安装自检**（`run.ts:188` `runDoctor`）。新增检查项：
   - 工具链：Node / pnpm 实际版本 vs `ToolchainSpec` pin；
   - 命令可达性：`zcode` 是否可从 PATH 解析到、解析到哪个文件；
   - 配置加载：`.env` **是否被加载、路径、加载到的键名（只列键名，绝不打印值）**；
   - 端点解析：`resolveRuntimeZCodeEndpointOrigin` 的结果，以及**是否发生了静默回落**（回落即告警）；
   - 必需外部命令：`ToolchainSpec.requiredCommands` 齐备性；
   - 内置 Provider 配置可读性：`config/provider/zcode-builtin.json` 是否存在可解析。
   失败项汇总输出，退出码非 0；保留并扩展既有 `--json` 形态（`run.ts:211`）以便脚本消费。

6. **本阶段验收**：在项目根以外的一个目录（例如 `/tmp`）执行 `zcode`，`.env` **不会**被加载（符合 `findDotenv` 的向上查找语义）；在项目根执行 `zcode`，`.env` 被加载且 `doctor` 能报出路径与键名。这一对正反用例必须在阶段 B 之前先跑通。

### 阶段 B：Makefile 入口骨架

7. 新增仓库根 `Makefile`，提供 `install` / `prune` / `clean` / `doctor` 四个 target。**Makefile 只做编排，逻辑一律放 `scripts/` 下的 Node 脚本**——理由：既符合本仓库既有约定（`scripts/*.mjs` + `scripts/spawn-command.mjs` 的统一执行封装），又避免把逻辑写进 make 的 shell 方言。

8. 每个 target 的职责边界（不重叠、可单独执行）：
   - `make install` → 阶段 C → D → E → F，全链路；
   - `make prune` → 裁剪依赖 + 强制复跑自检（依赖阶段 F）；
   - `make clean` → 仅删产物目录（复用/扩展现有 `scripts/clean.mjs`，**不删源码、不动 git 状态**）；
   - `make doctor` → 直接透传到 `zcode doctor`。

9. 所有 target 必须**幂等**：重复执行不产生重复链接、重复写入、重复下载；失败即非零退出码。

### 阶段 C：环境前置（F-002 + F-008）

10. 建立 `ToolchainSpec` 的**单一来源**，由 `mise.toml` / `.nvmrc` / `package.json#engines` / `package.json#packageManager` 的实际取值导出（当前应当是 node `24.14.0` + pnpm `10.33.2` + `make`/`git`）。四处声明必须一致，不一致时以本脚本的校验结果报错为准。

11. 探测与降级：
    - `mise` 存在 → 走 `scripts/mise-run.mjs` 的既有路径；
    - `mise` 缺失（本机实测就缺失）→ **不中断**，改用 PATH 上的 node/pnpm，并在结束时报出版本差异；
    - 版本不匹配（本机实测 node v22.23.2 ≠ 24.14.0）→ 报出"期望 / 实际 / 补装命令"，**不静默继续构建**。

12. **缺失命令一次性收集**（F-008 的核心）：在预检阶段把所有缺失的必需命令收集齐，安装结束时统一给出补齐指令，而不是遇到第一个就中断。

### 阶段 D：构建与全局暴露（F-003）

13. 调用既有构建入口完成 CLI 构建（`scripts/bootstrap.mjs` 已封装为 `pnpm install` + `pnpm run build:bootstrap`），产出 `apps/qcode-cli/packages/cli/dist/zcode.cjs`。

14. **全局暴露方式**：把构建产物安装到全局 bin 目录，**不要**对 `@zcode/cli` 用 `pnpm link --global`——`@zcode/cli` 是 workspace 成员（`private: true`），链接会把整棵 workspace 依赖带进全局，与"只暴露一个可执行"的目标相悖。推荐做法是生成一个指向 dist 产物的启动器并放进全局 bin 目录。

15. **目标 bin 目录的确定与 PATH 检查**（本机实测即为失败点）：
    - 优先使用 `pnpm bin -g` 报告的目录，但**实测该命令在本机直接报错**（`/Users/doing/Library/pnpm/bin is not in PATH`），因此必须容错：该命令失败时回落到一个稳定的用户级目录（如 `~/.local/bin`）；
    - 若目标目录不在 PATH 中，**安装仍然成功**，但自检必须报出"该加哪一行 shell 配置"，并把这一项标为需要人工处理；
    - 目标目录不可写 → 报出路径与权限，给出替代目录选项，不静默失败。

16. 幂等与版本可见：重复执行覆盖既有链接（不产生重复条目）；`zcode --version` 能反映本次构建的版本。

### 阶段 E：配置生成与校验（F-004）

17. `make install` 在项目根生成 `.env`：
    - 不存在 → 从 `.env.example` 复制生成；
    - **已存在 → 只追加缺失的键，保留已有值与注释，绝不覆盖**（本机项目根 `.env` 已被用户创建，且经确认缺少 api key）；
    - 追加后明确列出"仍为空的必填键"，特别是 api key。

18. 校验内容（与阶段 A 的 `doctor` 复用同一实现，不写第二份逻辑）：`ZCODE_BASE_URL` 是否非空、api key 是否非空、这些键**是否真的被 CLI 加载到了**（用阶段 A 的加载结果验证，而不是只检查文件里有没有这一行——这正是痛点 D 的要害：`.env.example` 里 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 等键存在但为空，文件里有行 ≠ 配置生效）。

19. 安全约束（第 5.3 节）：api key 只进项目根 `.env`，`.gitignore` 已覆盖（`.gitignore:13` `.env`）；安装与自检日志**只列键名、绝不回显值**。

### 阶段 F：自检收口

20. `make install` 结束时自动执行一次完整自检，输出结论；失败则 `make install` 整体返回非零退出码（不允许"看似成功但 `zcode` 不可用"）。

21. 阶段 F 与阶段 A 的第 5 步是**同一份实现**，`make doctor` 只是显式入口，不做第二套。

### 执行顺序小结

```
A（env 统一加载 + doctor 自检）  ← 先做，独立可验证
  ↓
B（Makefile 骨架）→ C（环境前置）→ D（构建 + 全局暴露）→ E（配置生成）→ F（自检收口）
```

## Think — Debug Methodology

- **先读源码，不猜行为**。本计划已经推翻了两个"想当然"的假设（`.env` 会被 TUI 读取、`.env` 在构建期内联）。凡是涉及 CLI 启动链路的判断，一律回到 `apps/qcode-cli/packages/cli/src/` 读实现。
- **在框架边界立刻加日志**。CLI 的边界就是 `run.ts` 的入口分发处：`resolveCliCwd` 之后的 `workingDirectory`、`deps.env` 的实际内容（**只打键名与是否为空，绝不打值**）、`loadCliDotenv` 的返回（`loaded` / `path` / `keys` / `error`）——这正是 `env.ts:16` `DotenvLoadResult` 已有的字段，直接打即可。
- **上游优先定位**：`.env` 没生效时，第一反应不是看 `.env` 文件，而是看 `findDotenv` 的起点（cwd）与返回值；第二才看键名是否拼错。
- **用 `grep -r "\[DEBUG-INSTALL\]" scripts/ apps/qcode-cli/packages/cli/src/` 一把清掉所有临时日志**，统一使用 `[DEBUG-INSTALL]` 前缀。
- **绕过客户端直接验证服务端行为**：验证端点解析时，用 `zcode doctor --json` 读取解析结果，比在 TUI 里肉眼看设置页更可靠。
- **不信任 PATH**：`command -v zcode` 的结果与 `doctor` 自报的解析路径可能不一致（多份安装并存），以 `doctor` 的实际解析结果为准。

## Do — Verification Strategy

- **构建**：`pnpm --filter "@zcode/cli..." build` — 必须通过（这是 `make install` 内部调用的同一条链路）。根级 `pnpm run build` 作为补充。
- **静态分析 / 类型检查**：
  - `pnpm typecheck`（根，`tsc -b packages/provider packages/provider-node packages/shared`）；
  - `pnpm --filter @zcode/cli typecheck`（CLI 包自身的 `tsc --noEmit`）；
  - 两者都必须零错误。
- **Lint**：`pnpm lint` 与 `pnpm --filter @zcode/cli lint`，零错误。
- **运行时验证**（逐条给出可复现命令与期望结果）：
  1. `make install` → 退出码 0，且**全程零人工交互**；
  2. `command -v zcode` → 有输出（当前为 `zcode not found`，这是本计划要消掉的头号现象）；
  3. 在**项目根**执行 `zcode doctor` → 自检项全部通过，且报出 `.env` 的路径与键名；
  4. 在**项目根以外**（如 `/tmp`）执行 `zcode doctor` → `.env` 未被加载，符合向上查找语义；此用例证明加载点没有越界；
  5. 项目根 `zcode`（无参数）→ TUI 正常启动（需交互式终端）；
  6. `make prune` → 退出码 0，随后 `zcode doctor` 全部通过；
  7. `make clean` → 仅产物目录被清，`git status` 无源码改动；随后 `make install` 可再次成功；
  8. `make install` **重复执行两次** → 第二次仍退出码 0，且不产生重复的全局条目（`command -v zcode` 仍指向同一路径）。
- **逻辑正确性**（必须逐条走通的执行路径）：
  - `zcode` 无参数 → TUI 路径**能读到** `.env`（这是本次新引入的行为，最关键的一条）；
  - `zcode app-server` → protocol server 路径**仍然不读** workspace `.env`（保留例外，不能被"统一"误伤）；
  - `zcode login` / `zcode --prompt` → 读 `.env` 且**不重复加载**；
  - 环境变量 `ZCODE_BASE_URL` 与 `.env` 同时存在 → **以环境变量为准**（`override: false` 语义不变）；
  - `.env` 不存在 → 不报错、走默认端点，且 `doctor` 报出"未加载配置文件"；
  - `.env` 存在但 `ZCODE_BASE_URL` 为空 → `doctor` 明确告警"回落到默认端点"，而不是静默通过。
- **边界用例**：
  - 空数据：项目根无 `.env`；`.env` 为空文件；api key 为空串。
  - 权限：全局 bin 目录不可写。
  - 版本不匹配：把 Node 切到 v22 验证阶段 C 的报错文案（本机现成可用，无需构造）。
  - 重复执行：见上面第 8 条。

## Adjust — Rollback and Global Scan

- **回滚方案**：本计划的产物是"新增文件 + 少量既有文件改动"，回滚边界清晰。
  - 新增：`Makefile`、`scripts/` 下新增的安装脚本。
  - 修改：`run.ts`（入口统一加载 + `runDoctor` 扩展）、`login-command.ts` / `prompt-command.ts` / `tui-auth.ts`（去重复加载）。
  - 全局副作用：全局 bin 目录中的 `zcode` 启动器——**这是唯一仓库外的影响**，回滚时必须一并删除，否则会留下指向已删除产物的悬空命令。回滚前先记录该路径。
  - 阶段 A 独立于 B~F，若安装链路出问题可单独回滚 B~F 而保留 A（A 本身就是痛点的真正修复）。
- **全局扫描**（执行完成后必须回答"还有哪里存在同类问题"）：
  - `apps/qcode-cli/packages/cli/src/` 下是否还有**其他**直接使用 `deps.env ?? process.env` 而绕过加载点的入口？（阶段 A 第 1 步应先把这类位置列全，避免只修 TUI 那一处——这正是本仓库 AGENTS.md 强调的"避免多条写入路径"。）
  - 子包（`packages/bootstrap`、`packages/adapters`）中是否有各自的 `.env` 读取逻辑？若有，同样需要收敛到统一加载点。
  - `.env` 相关文档（README 第 61 行、`config/README.md`、`.env.example` 注释）是否需要同步更新，避免文档与实现再次分叉。
  - `scripts/check-workspace-freshness.mjs` 的"单一来源"写法可作为新脚本的风格基线，检查是否有同类基线检查应一并纳入 `make install`。
- **向后兼容**：`.env` 的加载语义（向上查找、`override: false`）保持不变，只是**生效范围扩大**到 TUI——这是行为变更，需要在 README 与 NOTICE 中明示，避免既有用户以为"我的 shell 变量一定优先"以外的其它假设被打破。

## Out of Scope

- **F-006 `make prune` 的实际裁剪口径**：按痛点拆解第 9 章，"多余的 npm 包"的判定标准（`devDependencies` 口径 vs 运行时 require 闭包口径）以及 `apps/qcode-cli/pnpm-workspace.yaml` 的 `supportedArchitectures` 跨平台可选依赖是否算冗余，**尚未确认**。本计划只落地 `prune` 的 target 与"裁剪后强制自检 + 失败回滚"的安全网，裁剪规则本身待单独确认后补。
- **F-009 离线 / 受限网络降级**、**F-010 卸载**：均为 P2，不在本轮。
- **Windows 支持**：`apps/qcode-cli/pnpm-workspace.yaml` 声明了 win32 架构，但 Makefile 在 Windows 上不可用。本计划按 Unix（macOS/Linux）设计，Windows 若要支持需另立方案。
- **修改 `@zcode/cli` 的 `bin` 声明或发布成 npm 包**：本仓库 `private: true`，不涉及发布链路。
- **`pnpm.overrides` / `patchedDependencies` 被新版本 pnpm 忽略的告警**：验证时已观察到该告警，属既存问题，**不在本计划范围内**，仅记录。
- **不引入新的第三方依赖**：本计划的所有逻辑都应用 Node 标准库与仓库既有脚本实现。

## Open Questions

- 阶段 A 第 1 步"统一加载点"的具体位置：放在 `run.ts` 入口分发前一次性加载，还是做成惰性初始化？前者简单但会对 `help` / `version` 这类纯展示命令也产生一次文件 IO；后者灵活但会重新引入"每条路径各自决定"的风险。**倾向前者**（简单、单一写入路径优先），执行时若发现 `help` 的性能可感再调整。
- `.env` 向上查找在全局安装后会**越过仓库根继续向上**吗？`findDotenv` 走到文件系统根才停止（`env.ts:52-71`）。从项目根启动没问题，但从仓库的**子目录**启动时，会先找到最近的 `.env`——若用户在家目录放了一份 `.env`，行为需要确认是否符合预期。
- "必需外部命令"（`ToolchainSpec.requiredCommands`）的清单边界：`make` 是入口自身依赖还是外部依赖？若目标是"make install 一条命令"，则 `make` 必须先存在，这会形成鸡生蛋问题——是否要额外提供一条不依赖 make 的引导命令（如 `node scripts/install.mjs`）作为兜底？
- `doctor` 的失败退出码：现在 `runDoctor` 恒返回 0（`run.ts:214`、`run.ts:228`）。改为非零会影响现有把 `zcode doctor` 当作纯信息查询的用法（例如本仓库 AGENTS.md 的 `architecture:check` 类脚本）。需要确认是否有下游依赖该退出码恒为 0。
- 阶段 D 的全局启动器形态：指向 `dist/zcode.cjs` 的软链 vs 一个 `exec node <path>` 的 wrapper 脚本。软链最轻，但当 dist 被 `make clean` 删除后会变成悬空链接；wrapper 脚本可以给出更友好的报错。执行时按"`make clean` 后 `zcode` 的报错是否可理解"这一条来定。

---

> Next step: 运行 `/pre-mortem docs/plan-one-command-install.md`，对阶段 A（`.env` 统一加载的行为变更）与阶段 D（唯一仓库外副作用：全局 bin）做失败模式扫描。
