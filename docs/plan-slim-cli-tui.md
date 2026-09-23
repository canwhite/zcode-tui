# Plan: 精简工作树 —— 只保留 CLI / TUI 及其依赖闭包

> 把 workspace 收敛到「CLI + TUI + 其最小依赖闭包」，物理删除桌面端 / Web / Server / 周边构建物，使从零安装不再触碰 electron，且 CLI/TUI 功能与基线完全一致。

来源痛点拆解：[`docs/painpoint-cli-tui-only.md`](painpoint-cli-tui-only.md)
覆盖 Feature：F-001、F-002、F-003、F-005、F-007（Phase 1 全部 P0）
基线提交：`2a35c8a`（分支 `slim-cli-tui`，6976 文件 / 1,033,883 行）
剔除机制：**物理删除目录** ｜ 上游基线：**本地提交即可，不追溯上游**

## Context

为什么现在做这件事：

- 直接触发点是安装被无关依赖堵死 —— electron 的 postinstall 需要从 GitHub 拉二进制，当前网络下 `connect ETIMEDOUT`，整个 `pnpm install` 失败，CLI/TUI 一步都走不到（见痛点 A）。
- 产品形态上不需要桌面端，但 CLI/TUI 与桌面端/Web/Server 被放在同一个 workspace 里，没有独立获取路径，导致每次都要付出完整工作台的安装与构建代价（痛点 B）。
- **目录级删除是不安全的**，这已经被侦察证实：`@zcode/cli` 的依赖清单里，`@zcode/shared` 与 `@zcode/provider-node` 位于**根 `packages/`**，而 `tui`/`core`/`adapters` 等在 `apps/qcode-cli/packages/`。也就是说「删掉根 packages/ 下的桌面端相关目录」不能靠直觉划分，边界必须先算出来（痛点 C）。这正是把 F-001 放在第一步的原因。

约束：

- 工具链版本以 `mise.toml` 为准（node 24.14.0 / pnpm 10.33.2）；本机 `mise` 未安装，需以同等环境变量手工对齐（已知 `ELECTRON_MIRROR` 影响 electron 拉取，删除桌面端后该变量将不再需要）。
- workspace 定义在 `pnpm-workspace.yaml`，共 4 条 glob；根的 `typecheck` 脚本**硬编码枚举了包路径**，是删除后最容易漏改的位置。

## Goal

结束状态（逐条可验证）：

1. `pnpm-workspace.yaml` 及其包含的所有 `package.json` 中，不再存在 `@zcode/desktop`、`@zcode/web`、`@zcode/server`、`@zcode/ui`、`@zcode/client`、`@zcode/zcode-cua`、`@zcode/server-cli`、`@zcode/formal-proof` 等剔除目标。
2. 干净环境下 `pnpm install` **不触发任何 electron 相关 postinstall**，且安装成功。
3. `pnpm typecheck` 零错误、`pnpm lint` 零错误。
4. `pnpm --filter @zcode/cli dev` 能启动 CLI 并进入 TUI，核心路径与基线行为一致。
5. 全仓 grep 剔除目标包名，命中数为 0（配置、脚本、文档中均无残留）。

## Plan

按执行顺序，每步一个可独立验证的单元。

### 1. 固化回滚锚点（已完成）

- 分支 `slim-cli-tui`，提交 `2a35c8a`，工作区干净。
- 该提交是本次全部删除动作的唯一回滚依据 —— **删除不可逆，后续每一步都依赖它**。

### 2. F-001 依赖边界测绘（边界已实测收敛 —— 见 Pre-Mortem Risk-01 / Risk-02 / Risk-17）

产出保留边界并写入 `docs/dependency-boundary.md`，**这是后续所有删除步骤的输入，不可跳过**。

- **保留集有两个独立来源，必须取并集**：
  1. **依赖图** —— 从 `@zcode/cli` 与 `@zcode/tui` 的 `dependencies` + `peerDependencies` 递归求解（实测已得 16 个包）。
  2. **源码注册表** —— `apps/qcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` 的 `OFFICIAL_PLUGIN_DEFINITIONS`：10 个官方插件通过 `rootCandidates` **在文件系统上探测目录**来加载，**不出现在任何依赖图中**。只按依赖图算保留集，必然误删插件包。
- **实测收敛后的边界规则**（直接采用，不再重新推断）：
  - `apps/qcode-cli/` 整棵子树（`packages/`、`tools/`、`dependencies/`）**全部保留**，不删任何内容；
  - 根 `packages/` **保留 5 个**：`shared`、`provider-node`、`provider`、`model-option-map`、`zcode-cua`；
  - 根 `packages/` **删除 9 个**：`client`、`desktop`、`formal-proof`、`rpc`、`server`、`services`、`ui`、`web`、`server-cli`。
- 产出中必须逐项核对 10 个官方插件的全部 `rootCandidates`（`android-emulator-plugin`、`browser-use-plugin`、`image-search-plugin`、`ios-simulator-plugin`、`node-repl-host`、`plugin-creator-plugin`、`restore-legacy-sessions-plugin`、`skill-creator-plugin`、`zcode-cua-plugin`、`zcode-guide-plugin`）在删除后仍可解析。
- 任何包在删除前执行反向引用扫描（`grep -rn "@zcode/<pkg>" --include=package.json .`），命中数 > 0 即不得删除。

### 3. 按清单物理删除（先叶子，后根）

- 删除顺序：先删无被依赖者的叶子包，再删其上游，避免中途出现悬空引用。
- **每删除一个包，必须同步清理以下 5 处引用**（漏一处就会在安装或类型检查阶段炸）：
  1. `pnpm-workspace.yaml` 的 4 条 glob（`packages/*`、`apps/qcode-cli`、`apps/qcode-cli/packages/*`、`apps/qcode-cli/tools/*`）
  2. 根 `package.json` 中引用该包的 script：`dev:web`、`dev:server`、`prepare:desktop-runtime`、`build:bootstrap`、`bundle:desktop`、`prepare:remote-assets`
  3. 根 `package.json` 的 `typecheck` —— **硬编码枚举**了 `packages/rpc`、`packages/provider`、`packages/provider-node`、`packages/shared`、`packages/services`、`packages/client`、`packages/server`、`packages/zcode-server-cli`、`packages/ui`、`packages/web`、`packages/desktop/tsconfig.host.json`
  4. `knip.json` 的 `workspaces` 条目（当前含 `packages/desktop`、`packages/server`、`packages/services`）
  5. 引用到被删包的脚本：`scripts/build-zcode.mjs`、`scripts/dev-desktop-env.mjs`、`scripts/dev-desktop-remote-prod.mjs`、`scripts/bootstrap.mjs`
- 每删完一个包立即跑一次 `pnpm typecheck` 与 `pnpm install`，不要攒到最后一次性验证 —— 一次性失败时无法定位是哪个包引入的。

### 4. F-005 收敛安装与构建入口

- 让 `pnpm bootstrap` 成为纯 CLI/TUI 路径：去掉对桌面端的 `prepare:desktop-runtime` 调用，`build:bootstrap` 的 `--filter` 收敛到保留侧。
- 顺带移除 `scripts/bootstrap.mjs:161` 的 `git submodule update --init --recursive apps/qcode-cli` —— `README.md` 已明确 `apps/qcode-cli` 是普通目录、非 submodule，该行是从 submodule 时代遗留的死代码（本次会话最初报错正是它；在空 index 的仓库里它会直接 `pathspec did not match` 中断整个 bootstrap）。
- 目标：`pnpm bootstrap` 全程不出现 electron / desktop / web / server 字样的构建步骤。

### 5. F-007 从零回归验证

- 删除 `node_modules` 与全部构建产物，从干净状态重跑完整链路（见下方 Do 章节的具体命令）。
- 逐条走查 CLI/TUI 核心路径，确认无功能损失。
- 对照基线行为：对同一条 CLI 命令，基线与精简后的输出应当一致。

### 6. 全局扫描收尾

- 全仓 grep 剔除目标包名，确认命中数为 0。
- 同步更新文档中的命令表：`README.md`、`README.en.md`、`AGENTS.md`、`CONTEXT.md` 里引用桌面端/Web 的命令需要删除或改写。
- 检查 `.gitignore` 中桌面端专属条目（`packages/desktop/...` 系列）是否还有保留价值。

## Think — Debug Methodology

执行期遇到问题时的定位方式：

- **边界处先打日志。** 依赖问题几乎都在 workspace 解析边界暴露：先在 `pnpm-workspace.yaml` 与各 `package.json` 的 `name` 字段确认「pnpm 认为存在哪些包」，再核对实际目录 —— 不要假设二者一致。
- **先读源码，不猜行为。** pnpm 的 workspace 解析与 git 的行为都以此为准。本次会话已经用一次性对照仓库验证过 `git submodule update <path>` 的真实语义（空 index 才会 `pathspec did not match`），同类疑问继续用最小复现解决，而不是反复重跑全量安装。
- **定位顺序：从报错反推，而不是从头扫。** `pnpm install` 失败 → 取出无法解析的包名 → 打开该包 `package.json` → 反查谁引用它 → 判断是「该保留而漏了」还是「该清除而没删干净」。这两类的修法完全相反。
- **grep 约定。** 残留引用统一用 `grep -rnE "@zcode/(desktop|web|server|ui|client)" --include=*.ts --include=*.tsx --include=*.json --include=*.mjs` 清点，逐步收敛到 0。
- **不要用「能装上」代替「装对了」。** electron 问题的表现是安装失败，但依赖污染的表现常常是**安装成功、运行时才崩** —— 所以运行验证不可省略。

## Do — Verification Strategy

声明完成前必须全绿的验证门：

- **安装**：干净状态（删 `node_modules`）下 `pnpm install` 通过；确认输出中**不存在 electron 及其 postinstall**。
- **构建**：`pnpm build:bootstrap`（第 4 步收敛后的版本）通过。
- **静态分析 / 类型检查**：`pnpm typecheck` 零错误；`pnpm lint` 零错误。
- **运行验证**：`pnpm --filter @zcode/cli dev` 启动 CLI 并进入 TUI；另跑一条非交互命令（如 `--version` 或等价子命令）确认退出码为 0。
- **逻辑正确性**，需逐条走查的执行路径：
  1. 正常路径：从零安装 → 构建 → 启动 CLI → 进入 TUI → 完成一次基本会话。
  2. 空/首次状态：无配置文件、无历史记录时启动 CLI，行为应与基线一致。
  3. 缺依赖路径：人为触发一个被剔除模块才会走的命令，确认是「明确报错」而非「静默崩溃」。
  4. 边界：确认 `.env` 相关加载行为未因删除而改变。

## Adjust — Rollback and Global Scan

- **回滚方案**：整体回滚 `git reset --hard 2a35c8a`；单模块回滚 `git checkout 2a35c8a -- <path>`。因为删除是物理的，**任何一步出问题都优先回滚到基线再重做，不要在残缺状态上继续打补丁**。
- **全局扫描**：每完成一个包的删除，立即确认「同类位置」是否也引用了它 —— 重点就是第 3 步列出的 5 处配置。不要只修 pnpm 报错指向的那一处；报错通常只暴露 5 处中的第一处。
- **一致性检查**：删除后必须复核「保留集的计算依据是否仍然成立」—— 若某包从 `devDependencies` 升格为 `dependencies`，保留集需要重算。
- **向后兼容**：文档命令表（README / README.en.md / AGENTS.md / CONTEXT.md）需要与新的脚本集合保持一致；第三方声明文件 `THIRD-PARTY-NOTICES.md` 本次**不动**，其收敛属于 Phase 3 的 F-008。

## Open Questions

- **Server 是否被 CLI/TUI 依赖？** 这决定 F-003 是「直接删除」还是「降级为可选依赖」。这是当前最大的单点不确定性，必须在第 2 步的边界测绘中给出确定答案。
- 动态引用（字符串拼接的模块加载、运行时插件发现）是静态解析的盲区，需要多少人工确认工作量尚不清楚。
- 「原原本本」的验收标准未定：保留侧要求**代码字节一致**还是**行为一致**？前者会显著压缩第 4 步可改动的空间。
- native-search 预编译二进制与 SEA / bytecode 产物是否位于 CLI 启动路径上，需在第 2 步一并确认。
- 根 `package.json` 的 `pnpm` 字段（`overrides` / `patchedDependencies`）已被 pnpm 10 忽略，`patches/` 下 3 个补丁当前**实际未生效**。是否在本次一并迁移到 `pnpm-workspace.yaml`，尚未决定。

## Out of Scope

- F-004（剔除周边构建物与资源准备）—— Phase 2。
- F-006（上游同步流程）—— Phase 2；本次不建立可重放的减法流程。
- F-008（许可与声明收敛）—— Phase 3。
- 不推送远端、不发布、不建 tag。
- 不追求安装体积 / 耗时的量化目标值 —— 那些指标属于 Phase 2 的度量工作。
- 不修改保留侧（CLI/TUI）的业务代码。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED by /pre-mortem — 新风险追加在下方；重跑时同名风险就地更新，不重复追加 -->

> **评分口径**：`Risk Score = Severity × Likelihood × (1 − Detectability)`，其中 **Detectability = 我们能在早期发现它的概率**（越高越早暴露、残余风险越低）。**Risk Score > 12 判定为 HIGH RISK。**
>
> 本文件中 Detectability 的取值口径与评分公式保持一致（技能原文括注的示例方向与公式相反，此处以公式为准）。

### [Risk-01] TUI「命令行版」入口本身是靠 Server + Web 组装出来的 —— ✅ 已验证并降级

**Severity**: 4 | **Likelihood**: 2 | **Detectability**: 0.50
**Risk Score**: 4.0（原 14.0，**已不再是 HIGH**）

**验证结论（实测，非推断）**：原假设**被证伪**。以 `@zcode/cli` 的 `dependencies` + `peerDependencies` 递归求解，闭包共 **16 个包**，其中**不包含 `@zcode/server`、`@zcode/web`、`@zcode/desktop`、`@zcode/ui`、`@zcode/client`、`@zcode/services`、`@zcode/rpc` 中的任何一个**。反向引用表进一步印证：`@zcode/server` 仅被 `@zcode/desktop` 引用，`@zcode/web` 与 `@zcode/desktop` 无任何常驻引用。CLI/TUI 与桌面端/Web/Server 之间是**干净的切割**。

README 中的「组装」指的是另一个入口 —— `pnpm dev:web`（由 `@zcode/server-cli` 承载），不是 `@zcode/cli`。用户原话「cli 和 tui」也正好对应 `@zcode/cli` 与 `@zcode/tui` 两个包名，指向明确。

**残余风险**：入口仍可能被误解为 README 的「命令行版」，产物是 `@zcode/cli` 而非组装包。**残余评分：4 × 2 × 0.5 = 4.0**

**Mitigation**:

- 在计划 Goal 中显式写明：目标入口是 `@zcode/cli`（`pnpm --filter @zcode/cli dev`）；`pnpm dev:web` 与 `@zcode/server-cli` 属于本次剔除范围。
- 增加一条独立验收：精简后该命令必须能启动，且与基线中同一命令的行为做对照。

### [Risk-02] 剔除边界与模块归属不一致：`@zcode/zcode-cua` 被 CLI 直接依赖 —— ✅ 已算清并降级

**Severity**: 3 | **Likelihood**: 2 | **Detectability**: 0.60
**Risk Score**: 2.4（原 13.0，**已不再是 HIGH**）

**验证结论（实测，非推断）**：边界已完整算出，不再依赖推断。`@zcode/cli` 的运行时闭包（16 个包）为：

| 所在位置                   | 保留包                                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `apps/qcode-cli/packages/` | cli、adapters、bootstrap、contracts、core、dynamic-workflow、dynamic-workflow-runtime、i18n、shared-types、telemetry、tui |
| 根 `packages/`             | **shared、provider-node、provider、model-option-map、zcode-cua**                                                          |

`@zcode/zcode-cua` 确实在闭包内（经 `@zcode/adapters` 引入），**必须保留**。同时实测其 `dependencies` 为空对象 `{}`，目录内全部为纯 JS（`broker-*.js`、`frame-contract.js`、`host-display-contract.js`、`index.js`）—— **零原生依赖、零桌面耦合**，保留它不会把桌面端拖回来。

**补充事实（后经核实）**：`packages/zcode-cua` 是一个**明示的占位包**。`README.md` 原文：_"API-compatible placeholder package for Computer Use. This build ships without Computer Use: every runtime surface ... reports **unavailable** and fails closed"_；`index.js` 的 `createComputerUseRuntime` 恒定返回 `isError: true` 与 "Computer Use is not available in this build."。`NOTICE.md` 亦主动声明「本仓库随附的 Computer Use 包为不可用占位实现」。

因此"保留"的语义必须修正为：**保留的是接口兼容性**（让 `adapters` / `core` / `node-repl-host` 的依赖解析与构建成立），**不是保留 Computer Use 能力** —— 源码版本来就不提供该能力，这与删除动作无关。这也解释了它为何是零依赖的纯 JS 包。

**残余风险**：人工按目录名或语义归类仍可能误判。**残余评分：3 × 2 × 0.4 = 2.4**

**Mitigation**:

- 保留集以本条表格为准，**不得按目录名或语义归类重新推断**。
- 任何包在删除前执行反向引用扫描（`grep -rn "@zcode/<pkg>" --include=package.json .`），命中数 > 0 即不得删除。

### [Risk-02] 剔除边界与模块归属不一致：`@zcode/zcode-cua` 被 CLI 直接依赖

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.35
**Risk Score**: 13.0 —— **HIGH**

**Failure Scenario**：`@zcode/zcode-cua` 位于根 `packages/zcode-cua`（`private: true`，不可从 registry 补齐），但被 `apps/qcode-cli/packages/{adapters,core,node-repl-host}/package.json` 以 `workspace:*` 直接依赖。若按「CUA 是桌面端能力，属于花里胡哨」的直觉把它划入剔除侧，`@zcode/cli` 的安装直接解析失败；若只删了目录却忘了某一条引用，则表现为**安装通过、运行时缺能力**。这个案例的意义不在于它本身，而在于它证明了「按目录或语义归类」必然出错。

**Mitigation**:

- 第 2 步的解析器必须从 `package.json` 的 `dependencies` / `peerDependencies` **实际字段**递归，禁止按目录名或语义归类推断。
- 把 `@zcode/zcode-cua` 作为**校验样本**写进第 2 步验收：解析结果必须把 `adapters` / `core` / `node-repl-host` 这三条边判为 `keep`；若解析器输出 `remove`，说明解析器有 bug，先修解析器。
- 任何包在删除前必须执行反向引用扫描（`grep -rn "@zcode/<pkg>" --include=package.json .`），命中数 > 0 即不得删除。
- 「CLI 自带的 CUA 能力是否算用户所说的花里胡哨」与用户直觉冲突，需显式确认后才能决定去留。

### [Risk-03] 删除会让所有静态门禁「自动变绿」——假绿取代真验证

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.30
**Risk Score**: 11.2

**Failure Scenario**：根 `typecheck` 脚本**硬编码枚举**了包路径（含 `packages/server`、`packages/web`、`packages/ui`、`packages/desktop/tsconfig.host.json`），`knip.json` 的 `workspaces` 也按包列举（含 `packages/desktop`、`packages/server`、`packages/services`）。删除模块后，这些门禁**不是报错，而是失去了检查对象** —— `typecheck` 少检查几个包、`knip` 少分析几个包，输出依然是"绿"的。于是「全绿」被当成删除成功的证据，实际上门禁的覆盖面已经被无声地削弱了。六个月后回看，会发现没有任何一次验证真正证明过保留侧是完整的。

**Mitigation**:

- 每删一个包后，除 `pnpm typecheck` 外必须跑一条**能真正失败**的验证：启停 CLI 一次。静态门禁只能证明"没有明显错误"，不能证明"功能还在"。
- **删除前先记录基线门禁输出**（typecheck 覆盖的包列表与结果），删除后逐项对照差异，而不是只看绿不绿。
- 显式更新全部四处门禁输入：`package.json` 的 `typecheck` 枚举、`knip.json` 的 `workspaces`、`architecture-policy.yaml`、`.architecture-baseline.json`。
- 在验证清单里记录「本次门禁实际覆盖了哪些包」，作为覆盖面无损的证据。

### [Risk-04] 双层嵌套 workspace：只修一层 lock，表现为时好时坏

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.35
**Risk Score**: 10.4

**Failure Scenario**：仓库是两层 workspace —— 根 `pnpm-workspace.yaml`（4 条 glob，显式包含 `apps/qcode-cli`）+ 根 `pnpm-lock.yaml`，以及 `apps/qcode-cli/pnpm-workspace.yaml`（`packages/*`、`tools/*`）+ `apps/qcode-cli/pnpm-lock.yaml`（版本 0.16.9）。而子层的 lock 里 `@zcode/shared` 解析为 `link:../../../../packages/shared`，**跨出了子 workspace 回指根目录**。删除根包后若只修了根 lock，在 `apps/qcode-cli` 目录下安装仍会指向已删路径。典型症状是「根目录装得动、子目录装不动」或反过来的间歇性失败，且报错信息不会指向真正的原因。

**Mitigation**:

- 两层配置与 lock 必须**成对更新**：根 `pnpm-workspace.yaml` + `pnpm-lock.yaml`，以及 `apps/qcode-cli/pnpm-workspace.yaml` + `apps/qcode-cli/pnpm-lock.yaml`。
- 验证必须**在两个目录各跑一次**：仓库根与 `apps/qcode-cli`，两者都要安装成功。
- 删除步骤的完成判据里加上「子 workspace 的 lock 中不再出现指向被删路径的 `link:`」。

### [Risk-05] 没有 CI，本机成为唯一验证环境

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.35
**Risk Score**: 10.4

**Failure Scenario**：仓库内不存在 `.github/` 等 CI 配置（`.gitignore` 中引用的 `scripts/ci/ci-repo-hygiene.mjs` 实际不存在），全部验证只能在本机人工执行一次。而本机环境与项目要求本就有偏差：`mise.toml` 要求 node 24.14.0，本机长期跑的是 22.23.2，且 `mise` 未安装；`ELECTRON_MIRROR` 也依赖手工注入。于是「在我机器上能跑」成了唯一的证据，而这个证据不可复现、不可传递。

**Mitigation**:

- 在验证清单里**显式写出环境前置**（node 24.14.0 / pnpm 10.33.2 / 必要的环境变量），使任何人可照着复现。
- 验证一律**不复用旧 `node_modules`**，每次都从删除后重装，避免本机残留掩盖问题。
- 记录「本机与 `mise.toml` 的偏差项」作为已知条件，而不是当作隐性前提。

### [Risk-06] 依赖闭包不收敛时，接受「删不干净」的妥协，产出半成品

**Severity**: 5 | **Likelihood**: 3 | **Detectability**: 0.40
**Risk Score**: 9.0

**Failure Scenario**：根包全部 `private` 且互相交织（`services` → `provider`、`provider-node`、`rpc`、`shared`、`zcode-cua`；`client` → `rpc`、`services`、`shared`）。若 TUI/Core 的深层依赖把 `services` 拉进闭包，保留集就会超出「CLI + TUI」的直觉预期。此时最可能发生的事不是停下来重新决策，而是「反正已经删了一半，剩下的先留着」—— 最终交付一个既不是完整工作台、也不是纯净 CLI 的中间态，两个目标都没达成。

**Mitigation**:

- 第 2 步产出清单时，若保留集超出预期范围，**必须停下来与用户确认「部分保留」是否可接受**，确认后才能进入删除步骤。
- 严禁「先删了再说」：`pending` 状态的包一律不删，直到人工给出判定。
- 在清单里显式列出保留集并给出规模，超出预设即触发复核，而不是默默接受。

### [Risk-07] 「核心路径」回归靠手工走查，无法重复 → 精简分支悄悄腐化

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.40
**Risk Score**: 9.6

**Failure Scenario**：第 5 步的回归验证依赖人工走查「核心路径」，没有可重复执行的清单。第一次可能认真做了；一旦后续有人再动 workspace 配置，没人愿意重跑一遍靠记忆支撑的走查。半年后，某个被剔除模块对应的功能悄悄失效，而没有任何一次验证覆盖到它 —— 这正是「六个月内失败」的最常见形态：不是一次大爆炸，而是逐渐没人再验证。

**Mitigation**:

- 第 5 步必须产出一份**可复制的验证清单**（命令 + 期望输出），落到 `docs/` 下，任何人在任何时候照抄即可复现。
- 不要求自动化，但要求「不依赖记忆」：每条验证都写成可直接粘贴执行的命令。
- 清单需覆盖的不只是成功路径，还包括第 3 步列出的边界情形（空状态、缺依赖路径）。

### [Risk-08] 删除决策没有留档，六个月内无人能说清为什么删了某个包

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.30
**Risk Score**: 8.4

**Failure Scenario**：物理删除后，仓库里只剩「没有这个目录」这个事实，理由随之消失。六个月内当有人问「`packages/services` 为什么没了，我们不需要它吗」，没有任何记录可查。结果要么凭猜测重新引入，要么把已经确认过不必要的东西重新装回来，把精简成果一点点侵蚀掉。

**Mitigation**:

- 每删一个包，在 `docs/dependency-boundary.md` 记录：包名、删除理由、判定依据（引用扫描结果）、以及**恢复命令**（`git checkout 2a35c8a -- <path>`）。
- 该记录与三态清单同源，删除动作与记录必须同步发生，不得事后补。

### [Risk-09] 边界漂移：CLI 本身自带浏览器与 CUA 能力，与「花里胡哨」的直觉冲突

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.30
**Risk Score**: 8.4

**Failure Scenario**：用户的诉求是「不要那么花里胡哨」，但 `@zcode/cli` 本身依赖 `playwright-core@1.59.1`（硬依赖）与 `browser-use-plugin`，`adapters`/`core`/`node-repl-host` 又依赖 `@zcode/zcode-cua`。也就是说「浏览器自动化」「电脑操作」这些看起来很像"花里胡哨"的能力，其实是 CLI 的原生组成部分。若按直觉把它们一并剔除，CLI 会失去核心能力；而如果保留，用户又会觉得"没删干净"。

**Mitigation**:

- 动手前把用户选定的剔除范围**落到包名级别**的显式清单，任何超出清单的删除需二次确认。
- 明确区分「workspace 包」（本次剔除对象）与「外部依赖」（不在剔除范围），`playwright-core` 属于后者。
- 把 `@zcode/zcode-cua`、`browser-use-plugin`、`playwright-core` 三者的去留单独提交用户拍板，不并入批量删除。

### [Risk-10] 删除不可逆，而基线只存在于本地单个 `.git`

**Severity**: 5 | **Likelihood**: 2 | **Detectability**: 0.20
**Risk Score**: 8.0

**Failure Scenario**：物理删除是本计划选定的机制，`2a35c8a` 是唯一的回滚依据。该提交没有远端副本，也没有第二个备份。磁盘故障、`.git` 损坏或误操作（例如一次 `git gc` 之下的对象丢失）都会让基线消失，届时**没有任何方式能恢复被删的模块**。值得注意的是，本次会话中已经观察到该仓库的 `.git/index` 会莫名被清空（至今未定位原因），这说明该仓库的 git 状态存在未被解释的异常，不能默认它一定可靠。

**Mitigation**:

- 在仓库**之外**再留一份基线副本：`git bundle create ../zcode-baseline.bundle slim-cli-tui`。
- **每个删除步骤单独提交一次**，把回滚粒度降到单步，而不是只能整体回滚到基线。
- 若 `.git/index` 再次出现被清空的异常，**先解决该异常再继续删除**，不要在 git 状态存疑时做不可逆操作。

### [Risk-11] `node_modules` 残留造成「删干净了」的假象

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.50
**Risk Score**: 8.0

**Failure Scenario**：pnpm 不会自动清理已被移出 workspace 的包在 `node_modules` 中的残留（更不用说本仓库是两层 workspace，`apps/qcode-cli/node_modules` 是独立的一份）。删除目录后直接在本机跑验证，可能因为残留链接仍在而一切正常；等到在干净环境重新安装时才失败。这类"本机永远绿、别人永远红"的差异最难排查。

**Mitigation**:

- 第 5 步的「从零」必须是**真从零**：删除根与 `apps/qcode-cli` 两处的 `node_modules` 及构建产物后再安装。
- 每删除一个包后，同步清理其对应的 `node_modules` 残留，避免累积。
- 把「干净环境安装成功」而非「本机安装成功」作为判据。

### [Risk-12] 目标漂移：一直在删包，从没真正把 CLI/TUI 用起来

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.30
**Risk Score**: 8.4

**Failure Scenario**：用户的真实目标是「在终端用上 ZCode」，但 Phase 1 的全部交付物都是"删除"与"清单"。删除工作天然可以无限延长（总还能再删一点），而可用性并不随之提升。六个月后回看，提交历史里全是 `chore: remove ...`，却没有任何一次提交证明过 CLI 真的被用起来过。

**Mitigation**:

- 为 Phase 1 设定一个**可用性判据作为收尾条件**：能用 `pnpm --filter @zcode/cli dev` 进入 TUI 并完成一次会话。
- 删除工作以该判据达成为终点，不因「还能再删一点」而延长。
- 把该判据写在验证清单的首行，作为全流程的锚。

### [Risk-13] 文档命令表与现实脱节，后续操作者凭记忆跑已失效的命令

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.40
**Risk Score**: 7.2

**Failure Scenario**：`README.md` / `README.en.md` / `AGENTS.md` / `CONTEXT.md` 里有多处引用 `pnpm dev:web`、`pnpm dev:desktop`、`pnpm prepare:remote-assets` 等命令。删除脚本后文档未同步，后来者照着文档执行会得到「命令不存在」，进而怀疑是环境问题而非文档过期，浪费大量时间在错误的排查方向上。

**Mitigation**:

- 第 6 步把四份文档的命令表同步为删除后真实存在的脚本集合。
- 文档同步作为第 6 步的完成判据之一，与残留引用扫描同等对待。

### [Risk-14] 补丁有效性判断错误 —— ✅ 已实测更正

**Severity**: 3 | **Likelihood**: 2 | **Detectability**: 0.60
**Risk Score**: 2.4（原 6.3，且原判断方向错误）

**更正说明（实测，2026-09-22）**：本条原先据 pnpm 的 WARN 信息断言「根 `package.json` 的 `pnpm` 字段已被 pnpm 10 忽略，`patches/` 下 3 个补丁当前未生效」。该判断**错误**。证据：

1. `pnpm-lock.yaml` 第 11 行存在 `patchedDependencies:` 段 —— 补丁被解析并写入了锁文件；
2. 删除 `packages/desktop` 后重跑 `pnpm install`，pnpm 直接报 `ERR_PNPM_UNUSED_PATCH: The following patches were not used: @arms/rum-electron@0.0.3`。**若补丁真被忽略，不可能触发这个错误。**

**结论：补丁是生效的。** 那条 WARN 具有误导性，不能据此推断补丁失效。

**Failure Scenario**：据「补丁未生效」的错误判断做决策，会系统性地误判保留侧行为 —— 例如认为「反正补丁没生效，删了也不影响」，或把「让补丁生效」当成一项并不存在的工作去排期。

**Mitigation**:

- **保留侧仍依赖的补丁必须保留**：`@ai-sdk/openai-compatible@2.0.60`、`@ai-sdk/anthropic@3.0.81` 的目标包由 `apps/qcode-cli/packages/adapters` 使用（保留侧），**已保留**，补丁继续生效。
- **只被删除侧使用的补丁必须一并移除**，否则 `pnpm install` 会以 `ERR_PNPM_UNUSED_PATCH` 失败。`@arms/rum-electron@0.0.3` 的目标包仅被 `packages/desktop` 使用（9 个 desktop 源文件 + 根声明），**已移除其声明与补丁文件**。
- 教训：包管理器的 WARN 文本不构成行为证据，判断有效性要看**锁文件的真实结构**与**失败时的行为**。

### [Risk-15] 基线提交已含 `.env.development` / `.env.production`，未来推送远端即泄露

**Severity**: 4 | **Likelihood**: 2 | **Detectability**: 0.25
**Risk Score**: 6.0

**Failure Scenario**：`.gitignore` 只忽略 `.env`、`.env.local`、`.env.*.local`，**不覆盖 `.env.development` 与 `.env.production`**，二者已随基线 `2a35c8a` 进入版本历史（当前为单行 89 字节、未命中常见密钥特征，风险低）。但该提交已进入历史，一旦将来推送到任何远端，清理成本远高于现在。

**Mitigation**:

- 立即在 `.gitignore` 中补充 `.env.development` / `.env.production`（保留 `.env.example` 入库）。
- 明确记录：若将来要推送远端，**必须先处理这段历史**（改写提交或改用全新仓库），不能直接 push。

### [Risk-16] 第三方声明与实际依赖脱节，被推迟后再也没做

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.30
**Risk Score**: 8.4

**Failure Scenario**：`THIRD-PARTY-NOTICES.md`（约 1.9MB）按当前完整依赖生成。本计划把声明收敛明确划给 Phase 3 的 F-008，但 Phase 2/3 没有排期保障。删除大量模块后，声明文件会长期包含已不存在的组件，形成事实上的合规偏差 —— 而且因为"反正不是现在要做的"，没有任何触发机制会让它被重新提起。

**Mitigation**:

- 第 2 步清单中增加一列：该包是否出现在 `THIRD-PARTY-NOTICES.md` 中，删除时同步标记。
- 把这些标记作为 Phase 3 F-008 的**显式输入**落到 `docs/`，避免依赖记忆传递。
- 在计划中保留指向 F-008 的链接，使其不会被静默遗忘。

---

### [Risk-17] 保留集 ≠ 静态依赖闭包：官方插件由源码注册表驱动（第 2 轮新发现）

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.30
**Risk Score**: 14.0 —— **HIGH（原始分）**
**残余 Risk Score**: 5.0 —— **降级后**

**Failure Scenario**：`apps/qcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts` 中的 `OFFICIAL_PLUGIN_DEFINITIONS` 定义了 **10 个官方插件**（node-repl-host、computer-use、browser-use、android-emulator、image-search、ios-simulator、restore-legacy-sessions、plugin-creator、skill-creator、zcode-guide），每个通过 **`rootCandidates` 在文件系统上探测目录**来定位，**而不是通过依赖解析**。因此 `browser-use-plugin`、`node-repl-host` 这类插件包**不出现在任何 `package.json` 的依赖里**。

任何"按依赖图算保留集"的做法都会把它们判为可删。按静态闭包删除后：安装成功、类型检查全绿、CLI 能正常启动 —— 但插件在运行时加载失败或静默缺失。用户拿到的是一个「看起来完全正常」却已经不再原原本本的 CLI。**这是本计划最核心的失败形态：所有门禁都是绿的，交付物却是错的。**

**验证结论**：插件加载的权威来源已定位（源码注册表 `rootCandidates`），保留边界不再依赖推断。`apps/qcode-cli/packages/` 下另有 `superpowers-plugin`、`debug`、`swift-bridge`、`tools/prompt-trajectory`、`tools/typescript` 等同样不在任何依赖图中的包，均属于同一类盲区。

**Mitigation**:

- **保留边界改为不依赖依赖图的规则**：`apps/qcode-cli/` 整棵子树（`packages/`、`tools/`、`dependencies/`）**一律不删**；删除动作只针对根 `packages/` 下的包。
- 删除清单由此收敛为根 `packages/` 的 **9 个包**：`client`、`desktop`、`formal-proof`、`rpc`、`server`、`services`、`ui`、`web`、`server-cli`。
- 保留清单为根 `packages/` 的 **5 个包**：`shared`、`provider-node`、`provider`、`model-option-map`、`zcode-cua`。
- 删除后逐项核对 `OFFICIAL_PLUGIN_DEFINITIONS` 的全部 `rootCandidates`，确认每一个仍可解析。
- 在 F-001 的产出中把「插件注册表」与「依赖图」**并列为保留集的两个独立来源**，缺一不可。

**残余风险**：规则已显式且不再依赖推断，误删概率大幅下降；但插件加载失败的可观测性仍偏弱（静态门禁看不到）。**残余评分：5 × 2 × 0.5 = 5.0**

### [Risk-18] 10 个官方插件中有 8 个不在仓库内，靠外部 CDN 交付

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.40
**Risk Score**: 5.4

**Failure Scenario**：`rootCandidates` 列出的 10 个插件目录中，仓库内实际只存在 `browser-use-plugin` 与 `node-repl-host` 两个；其余 8 个（`android-emulator-plugin`、`image-search-plugin`、`ios-simulator-plugin`、`plugin-creator-plugin`、`restore-legacy-sessions-plugin`、`skill-creator-plugin`、`zcode-cua-plugin`、`zcode-guide-plugin`）由 `https://cdn-zcode.z.ai/zcode/official-plugin/assets` 提供。精简后 CLI 的插件能力仍依赖外部 CDN 可达性 —— 「离线可用」在原设计里就不成立。风险在于：一旦 CDN 不可达，问题表现会被误判为"删除造成的损坏"，从而在错误的方向上排查。

**Mitigation**:

- 在验证清单中明确区分「仓库内提供」与「CDN 提供」的能力，避免把 CDN 不可达误判为删除造成的损坏。
- 若用户要求离线可用，该需求独立于本计划，需单独立项，不并入 Phase 1。

---

**Pre-mortem 收敛结果（第 3 轮，实测驱动）**：共识别 **18 项**风险，全部附 Mitigation。

| 轮次    | 动作                                            | 结果                                                                                                                                          |
| ------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 第 1 轮 | 生成 16 项，识别 2 项 HIGH（Risk-01、Risk-02）  | 均为"前提错误"型，非执行失误                                                                                                                  |
| 第 2 轮 | **实测验证** Risk-01 / Risk-02，并重新扫描      | 两项 HIGH 被证据消解：Risk-01 假设**证伪**（14.0 → 4.0）；Risk-02 边界**已算清**（13.0 → 2.4）；新增 1 项 HIGH（Risk-17，官方插件盲区，14.0） |
| 第 3 轮 | 为 Risk-17 给出实测支撑的保留边界规则，重新扫描 | 残余降至 5.0；**未再发现新的 HIGH RISK**                                                                                                      |

**核心结论：保留边界不能用依赖图算出来。** Risk-17 是本轮唯一的新 HIGH，它同时解释了为什么前两项 HIGH 的 Mitigation 不够——它们都建立在「依赖图 = 全部真相」这个隐含假设上。真实情况是保留集有**两个独立来源**：

1. **依赖图**（`package.json` 的 `dependencies` / `peerDependencies` 递归闭包）
2. **源码注册表**（`OFFICIAL_PLUGIN_DEFINITIONS` 的 `rootCandidates` 文件系统探测）

两者取并集后，边界收敛成一条极简且可验证的规则 —— **`apps/qcode-cli/` 整棵子树全保留；只从根 `packages/` 删 9 个包、留 5 个包**。这也是本计划第 2 步应当交付的边界结论（而非「三态清单」那种模糊产物，因为它已被实测收敛为确定解）。

> Next step: 执行计划第 2 步 —— 以本条结论为保留边界（`apps/qcode-cli/` 全保留 + 根 `packages/` 留 5 删 9），产出 `docs/dependency-boundary.md`；其中必须逐项核对 10 个官方插件的 `rootCandidates` 仍可解析。删除动作从根 `packages/` 的 9 个包开始。
