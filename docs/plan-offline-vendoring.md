# Plan: 把 zcode 做成不依赖公网的独立个体（Phase 1 MVP）

> 让 `make install` 到 `zcode` 启动的全链路在断网下可完成，并产出一份能证明"依赖了什么、扫过什么"的台账与扫描报告。

## Context

本计划是 `docs/painpoint-offline-vendoring.md` 第 7 章 **Phase 1（F-001 ~ F-005）** 的实现方案。该文档的痛点分析、词性拆解、指标与数据结构定义**是本计划的直接输入**，字段口径一律以它为准，本文不重复推导。

为什么是现在：该文档实测出四类远程获取点（`nodejs.org` 的 SEA 基座、`codeload.github.com` / `sourceware.org` 的上游源码包、`cdn-zcode.z.ai` 的插件资产、`api.github.com` 的插件安装），并确认**下载落点与被清理/被忽略的目录重叠**。其中最有说服力的一条证据来自代码本身：

```
apps/zcode-cli/packages/cli/scripts/build-sea.mjs:63
const nodeCache = resolve(dist, "sea-node-cache");
```

Node 运行时缓存在 `dist/sea-node-cache` 之下。**注意：pre-mortem 已实测修正过这里的初判**——`apps/zcode-cli/packages/cli/dist` 是被 `apps/zcode-cli/.gitignore:1` 的 `dist/` 忽略的（不是根 `.gitignore`），而 `scripts/clean.mjs` 只遍历仓库根与根 `packages/*`，**并不会删到 `apps/` 下的 `dist`**。所以真实现状是 **"被忽略、但不被清理"**，比"会被清理"更糟：它既进不了仓库，又会残留在磁盘上冒充一份可用的缓存——而缓存键不含版本，一旦构建所用的 Node 版本变化，残留的旧版本归档就会被安静地当成新鲜资源。这正是"随仓库上传、清理时不清理、不在 git ignore 里"三条诉求要解决的问题。

已确认的决策前提（本轮已与你对齐）：

| 项 | 决定 |
|---|---|
| 覆盖范围 | Phase 1 全量（F-001 ~ F-005），不含 F-006 / F-007 |
| 平台范围 | **全部 6 个 SEA target**（darwin / linux / win × arm64 / x64） |
| 扫描基线 | 本轮本地化的资源 **+** 已发现的残留（`.env.bak-*`、失效 `.gitignore` 规则、`prepare-prebuilds.sh` 死入口） |
| npm 边界 | npm 注册表**豁免**，只登记不本地化 |

约束：

- 仓库已有一处完成的正确形态可对齐——`apps/zcode-cli/dependencies/native-search/`（19 个预编译包入库 + `SHA256SUMS` + 全离线）。本计划**不另起一套**，落点与校验方式向它看齐。
- `scripts/clean.mjs` 目前按**目录名**匹配 `node_modules` / `dist`，不具备"显式保留"的表达能力。
- 本仓库是精简分支，`AGENTS.md` 要求改动后跑 `pnpm typecheck` 与 `pnpm lint` 并报告真实结果。

## Goal

完成后应能同时成立：

1. **断网可构建**：屏蔽全部非 npm 出网后，从零 `pnpm bootstrap` 成功。
2. **资源可入库**：全部远程资源进入 Git 跟踪，`git check-ignore` 对本地副本路径**零命中**。
3. **清理后存活**：`make clean` 后台账逐条仍存在，清理后可直接再次构建。
4. **可审计**：存在一份台账，且"台账 vs 全仓实际引用"的差集为空；台账中缺 sha256 的条目数为 0。
5. **扫过一遍**：对本轮资源与三条已知残留产出扫描报告，无未处置的 `high` 发现。

## Plan

### Step 0 — 基线与回滚锚点

1. 跑 `node scripts/check-workspace-freshness.mjs`，确认基线不是旧的（`AGENTS.md` 明确要求开工前执行）。
2. **先确认工作区的未提交改动归属（阻断项，见 Pre-Mortem R4）**。当前 `git status` 显示 `scripts/install/toolchain.mjs`、`apps/zcode-cli/packages/cli/src/doctor.ts`、`package.json`、`apps/zcode-cli/package.json`、`packages/provider/src/model-selection-config.ts`、`README*.md` 均已修改未提交，且 `main` 领先 `origin/main` 2 个提交——**这些正是本计划要改的区域**。先与用户确认是"提交、保留、还是放弃"，未确认前不动手。
3. 记录基线数字作为对账依据：`.git` 体积、跟踪文件数、`git rev-parse HEAD`。
4. 建仓库外备份（对齐 `docs/dependency-boundary.md` 既有做法）：`git bundle create ~/zcode-baseline-<date>.bundle --all`。**注意：工作区不干净时这份 bundle 不含未提交改动**，故它只能作为已提交历史的回滚锚点，不能作为"完整基线"。
5. 起一个特性分支，从**已提交的 HEAD** 切出，不携带他人未提交改动；不直接在 `main` 上做。
6. **明确本计划的验证门全部为人工执行**（无 CI、husky 未安装，见 Pre-Mortem R5）。不存在"忘了跑也会被拦"的兜底。

### Step 1 — F-001 建立资源台账（含体积 Go/No-Go 关卡）

1. **枚举**：对全仓（`scripts/`、`packages/`、`apps/`、`config/`、根配置）扫描远程引用点，来源包括但不限于 `https?://` 字面量、`fetch(` / `curl` / `git clone`、`.npmrc` registry、`mise.toml` 工具链。输出候选清单，**先不判重、不下结论**。
2. **定义结构**：按痛点文档 §3.2 的 `RemoteResource` 落一份机器可读台账。落点建议 `third-party/resources.json`（与既有 `third-party/*/sources.json` 同类、同目录、已被 `.gitattributes` 覆盖为 `-text`，且确认过**不在任何忽略规则下**）。
3. **填充**：逐条补 `id` / `kind` / `url` / `sha256` / `vendored_path` / `scope(build|runtime)` / `platforms` / `size_bytes` / `consumers`。已被本地化的既有资源（`dependencies/native-search/` 的 19 个包、许可原文、`config/provider/zcode-builtin.json`）**一并登记并标记为"已就绪"**，不重复下载。
4. **差集校验（见 Pre-Mortem R6——这是静默假通过的高危点）**：写一个校验入口，把"台账声明的资源"与"实际引用"取差集。**必须由两条独立路径产出并互相对账**：
   - 路径 A：扫源码中的获取点，覆盖**非字面量**形态——`new URL(x, base)` 拼接（`sea-targets.mjs:66` 即此形态）、`fetch(` / `curl` / `git clone` / registry 配置。
   - 路径 B：从台账反推，逐条追问"这条的消费者在哪、以什么方式消费"。

   两路都为空才算通过。并做**反向测试**：人为插入一个未登记的获取点 → 校验器必须失败；人为从台账删一条 → 校验器必须失败。**校验器若不能失败，就没有证明力。** 白名单（npm registry、用户配置的 LLM 端点）单独人工复核。

5. **本地化 Node 版本的前置收敛（阻断项，见 Pre-Mortem R1，必须早于 Step 2.5）**：`build-sea.mjs:301` 用 `process.versions.node` 决定下载哪一版，**没有任何 pin**。先把版本改为显式 pin 的单一真源，并收敛 `.nvmrc`(24) / `mise.toml`(24.14.0) / `package.json` `engines`(>=22.13.0) 三方不一致。**这一步不做，Step 2.5 下载的东西可能从一开始就是错的。**

6. **体积预算门（决策点，先于任何下载）**：按台账算出实测体积。**已实测的基线数据（Node 24.14.0，对 `nodejs.org` HEAD 实测）**，可直接用于判断：

   | 产物 | 实测体积 | 相对阈值 |
   |---|---|---|
   | `win-x64/node.exe` | 87.1 MiB | ⚠️ 距 100MB 硬限仅 13 MiB |
   | `win-arm64/node.exe` | 76.7 MiB | ⚠️ 远超 50MB 告警线 |
   | `darwin-x64.tar.gz` | 49.8 MiB | ⚠️ 紧贴 50MB 告警线 |
   | `darwin-arm64.tar.gz` | 48.7 MiB | ⚠️ 紧贴 50MB 告警线 |
   | `linux-x64.tar.xz` | 29.6 MiB | 尚可 |
   | `linux-arm64.tar.xz` | 28.6 MiB | 尚可 |
   | **合计** | **320.6 MiB** | 对照当前 `.git` 仅 37 MiB |

   检查两件事：**单文件最大值**（不只是总量——`win-x64` 已达硬限的 87%，任何一次 Node 大版本升级都可能越界）与**总量**。托管方需确认（`.dockerignore` 里出现 `.gitlab`，GitHub 为 100MB 硬限 / 50MB 起警告）。

   > 若越界：**停止并回到用户处决策**，选项是「接受 LFS」「缩减平台集合」「改走可选镜像」。不要自行降级平台集合——平台范围是你已明确指定的。

### Step 2 — F-002 本地化与受保护目录

1. **定受保护根**：建议 `third-party/vendored/`。**落点以断言为准，不以美观或先例为准**（见 Pre-Mortem R3）：把候选路径逐个跑 `git check-ignore`，命中即淘汰。
   > **已知陷阱**：`apps/zcode-cli/.gitignore` 最后一行是一条**裸 `vendor`** 规则。若落点选在 `apps/zcode-cli/**/vendor*` 形态（例如为了对齐 `dependencies/native-search/` 先例而建 `dependencies/vendor/`），资源会**静默不入库**——`git status` 不显示，本地一切正常，克隆到断网机器才全线失败。
2. **实现下载器**：输入台账条目，输出落盘文件。必须做到——sha256 校验后才落盘、写临时文件再原子 rename（避免半成品冒充完整文件）、**幂等**（已存在且 sha256 匹配即跳过，不发网络请求）。
3. **落盘断言（脚本化，非一次性人工核对）**：入库前对每个 `vendored_path` 跑 `git check-ignore`，命中即失败。**必须覆盖全部 6 个 `.gitignore`**（根、`.husky/_`、`apps/zcode-cli`、`browser-use-plugin`、`dynamic-workflow`、`debug`），而不是只查根目录那个——这正是 R3 能成立的直接原因。最终判据用 **`git ls-files` 是否包含该文件**（"是否被跟踪"），而不是"是否被忽略"：`git add` 之后再跑一次，确认条目数与台账一致。
4. **清理边界**：让 `scripts/clean.mjs` 具备"显式保留"的表达能力。当前它按名字匹配 `node_modules` / `dist`，建议引入一份 keep 白名单并断言 `assertSafeTarget` 不落在受保护根之下；同时补一条清理后自检（台账逐条断言存在）。
5. **落地 6 平台资源**：Node 运行时归档 + native-search 源码包（8 个上游项目）。
   > **配对项（见 Pre-Mortem 中风险）**：`sea-node-download.mjs:90` 在下载产物**之前**先取 `SHASUMS256.txt`。若只本地化归档而漏了校验清单，断网构建会失败在"下载 SHASUMS"这一步，现象是"资源明明在本地却仍说下载失败"，极易误判成网络封锁或缓存根的问题。**把 `SHASUMS256.txt` 作为独立台账条目登记**（`kind: checksum-manifest`），否则 Step 1.4 的差集校验看不见它。
6. **对账**：入库后复算实际体积（总量 **与单文件最大值**），与 Step 1.6 的预算逐项对账，偏差需解释。

### Step 3 — F-003 本地优先解析

1. **SEA Node 运行时**：让下载步在断网时能命中本地副本。两种候选形态，执行时按改动面选择其一——
   - (a) 把 `nodeCache` 根从 `dist/sea-node-cache` 改指向受保护目录；
   - (b) 保持 `dist/sea-node-cache` 为可重建缓存，从受保护目录**播种**。

   > 注意：`--node-binary <target>=/abs/path/node` 要求的是**已解压的二进制**，不是归档。若走这条路，仓库要存的是解压后产物（体积显著更大），因此**优先 (a)/(b)**。

   > **只改寻址，不改产物写出（见 Pre-Mortem 中风险）**：`build-sea.mjs` 里以 `dist` 为基准的步骤还有 `stageNodeNotices(dist, ...)`、`seaAssetStagingForTarget()`、`seaBlobForTarget()`——这些是**产物输出**，不是缓存。把缓存根与产物根混为一谈会表现为产物缺失或 LICENSE 未随包分发。优先选 (b) 播种方案，对本风险的暴露面最小。
   > **前置检查**：改动前 grep 确认没有其他消费方按字面路径引用 `dist/sea-node-cache`。
   > **必须真跑一次**：改动后执行 `pnpm build:sea`（至少宿主平台），确认产物生成且 LICENSE 随包分发。本仓库磁盘上没有 `sea-node-cache`，说明这条路径**从未被实际执行过**，类型检查无法替代。

2. **native-search 源码构建**：`pnpm build:native-search` 目前经 `native-search-tools-process.mjs:65` 的 `curl -L` 取包，是唯一硬依赖公网、且无离线退路的构建步骤。改为从本地源码包解包，去掉 curl。**校验必须保留**——脚本已有 sha256 比对，不要因为改成读本地就跳过它。
3. **扫其余直连**：逐个确认构建/安装链路里没有残留的直连获取（登记在台账里的 `consumers` 即为此用）。
4. **缺失时行为**：本地副本缺失必须**指名资源 id 与缺失平台**后失败，不静默回源、不静默跳过。这是"相对独立的个体"能否被信任的关键——静默回源会让断网问题推迟到交付现场才暴露。

### Step 4 — F-004 断网验收关卡

1. **造断网**：提供一种可重复的"封锁全部非 npm 出网"的方式（代理黑洞或等价手段）。
2. **封锁有效性自检（见 Pre-Mortem R10，先做再验收）**：确认一个已知非 npm 域名**确实不可达**，同时 `registry.npmjs.org` **确实可达**。两个断言都成立才开始验收——只做前者会得到假失败（把 npm 一起封了，去修一个不存在的问题），只做后者会得到假通过（没真封住）。
3. **从零验证**：**先清到干净状态**（清 `dist`、清受保护目录外的全部缓存），记录起跑时的 `git status`，再 `pnpm bootstrap` → 构建 → `zcode doctor` → 启动 TUI。用缓存残余换来的"成功"是本关卡最可能的失效形态。
4. **清理后验证**：`make clean` 后再走一遍，确认资源存活。
5. **连续两次通过**才算达标（单次通过可能是缓存命中造成的假象）。
6. **在完整克隆上执行**：日常开发允许只拉宿主平台，但**交付验收必须在完整克隆上跑**（见 Pre-Mortem R9）——否则断网关卡会从"每次交付都跑"退化为发布前补一次。

### Step 5 — F-005 扫描（后门 + 特例判断）

1. **扫描本轮资源**：对全部本地化产物做两类检查——① **后门**：隐蔽行为、超出声明用途的代码、异常出网；② **特例判断**：绕过通用逻辑的分支、硬编码白名单、旁路 if-else。
2. **扫描已知残留三条**：
   - `.env.bak-before-vendor-migration`（**被 Git 跟踪且含 `BIGMODEL_API_KEY`**）；
   - `.gitignore` 中引用已删除脚本的规则（`scripts/ci/ci-repo-hygiene.mjs`、`scripts/cua-helper-sea-base.mjs`）与无引用的忽略项（`bundled-resources/`、`mock-cdn/`）；
   - `scripts/prepare-prebuilds.sh` 指向不存在的 `.mjs`（该入口无条件失败）。
3. **区分有意/无意特例**：`patches/@ai-sdk__*.patch` 对 Anthropic 协议加 `video/*` content block 是**有意为之**且带注释，扫描结论必须把它与无意的残留特例分开，不得混为一类。
4. **产出报告**：每条发现附证据（文件 + 行号 + 原文片段）与 `severity`。**覆盖不全不得出"通过"结论**——报告需显式列出未覆盖项。
5. **处置**：`high` 发现逐条处置或明确记录为"已知且接受"，未处置的 `high` 阻断交付。
6. **记录既存的合规链路损坏（见 Pre-Mortem R6，必须显式声明）**：实测 `node scripts/licenses.mjs notices` **以退出码 1 失败**（`Stale npm notice override: victory-vendor@37.3.6`），且 `third-party/copied-components.json` 的 16 个 `roots` 中有 **9 个已随精简分支被删**——即使修掉 override，下一层 `stat()` 仍会失败。因此：
   - **本计划不得声称"合规已覆盖"**，也不得把"重新生成 notices"列为可用缓解——它当前不可用。
   - 本地化新增二进制**会增加分发义务**：Node 运行时内含 V8 / OpenSSL / libuv / ICU / zlib 等组件，而当前 `third-party/runtime/sources.json` 只为 Node 正文许可登记。
   - 修复 notices 链路（清理失效 override + 修剪 9 个不存在的 root）作为**独立前置任务**提出，不在原定 F-001~F-005 范围内，是否纳入由用户决定。

### Step 6 — 全局复核

1. **同类路径扫一遍**：还有哪些地方在直连外网？还有哪些目录落在 clean / ignore 的边界上？按 `CLAUDE.md` 的"全局扫描"原则，目标是能明确回答"就这一处"或列出全部同类。
2. **可观测**：让 `doctor` 报出"本地化覆盖率 / 未校验数 / 忽略命中数 / 各平台缺失项"，使离线可用性可自查，而不是等构建失败才发现。
3. **文档同步**：`README` / `AGENTS.md` 中与安装、清理、依赖相关的描述同步更新（`AGENTS.md` 明确要求删除功能时同步清理引用，反之亦然）。

## Think — Debug Methodology

- **先证据后假设**：本次的"远程资源到底有哪些"必须由扫描得出，不能凭记忆或印象罗列。Step 1.4 的差集校验就是这个原则的固化形式。
- **在框架边界加日志**：下载器与本地优先解析是本次的两个边界。日志加在**接收侧**——下载器打印 `资源 id / url / 命中缓存还是发起下载 / sha256 判定结果`；解析器打印 `请求的 target / 命中的路径 / 缺失原因`。前缀统一用 `[DEBUG-offline]`，便于一次性 grep 清除。
- **先读源码再判断行为**：`scripts/clean.mjs`（清理范围）、`build-sea.mjs` + `sea-node-download.mjs`（缓存与跳过逻辑）、`native-search-tools-process.mjs`（下载与校验）三处必须读源码确认，不靠文档推断。本计划中 `nodeCache = resolve(dist, "sea-node-cache")` 与 `--node-binary` 接受已解压二进制这两条，都是读源码才发现的。
- **定位顺序**：断网构建失败时，从**最上游**开始——是"根本没找到本地副本"还是"找到了但校验不过"还是"校验过了但消费方没读对路径"。三者现象相似，上游日志能一次区分。
- **别用重试掩盖**：构建失败时不要反复重跑（第二次成功通常是缓存或网络抖动）。先看日志判定是哪一类失败。

## Do — Verification Strategy

**每一阶段都要跑（`AGENTS.md` 要求，报告真实结果，不把已有失败写成通过）：**

| 门 | 命令 | 通过标准 |
|---|---|---|
| 基线新鲜度 | `node scripts/check-workspace-freshness.mjs` | 通过（Step 0 执行一次） |
| 构建 | `pnpm bootstrap` | 成功 |
| 类型检查 | `pnpm typecheck` | 零错误 |
| Lint | `pnpm lint` | 零错误 |
| 格式 | `pnpm fmt:check` | 通过（本次改动含大量新文件） |
| 架构检查 | `pnpm architecture:check --changed` | 通过（`AGENTS.md` 要求涉及代码改动时执行） |
| 安装自检 | `node scripts/install/install.mjs doctor` | 通过 |

**本次特有的验证门：**

| 门 | 做法 | 通过标准 |
|---|---|---|
| 忽略断言 | 对台账每个 `vendored_path` 跑 `git check-ignore` | 零命中 |
| 清理存活 | `make clean` 后按台账逐条断言 | 零缺失 |
| 差集校验 | 台账 vs 全仓实际引用 | 差集为空 |
| 幂等性 | 下载器连跑两次 | 第二次零网络请求、零文件变更 |
| 断网构建 | Step 4 的断网环境 | 连续两次成功 |
| 扫描覆盖 | 扫描报告 | 覆盖 100%，无未处置 `high` |

**逻辑正确性——必须手工走完的执行路径（列出每条路径的预期返回值）：**

*下载器*：① 本地不存在 → 下载 + 校验通过 + 落盘，返回成功；② 本地存在且 sha256 匹配 → **不发网络请求**，返回成功；③ 本地存在但 sha256 不匹配 → 重新下载并覆盖，返回成功；④ 下载中断 → 临时文件被清理，**不留下半成品**；⑤ 远端 sha256 与台账不符 → 失败并同时报出期望值/实际值；⑥ 目标路径被 `.gitignore` 命中 → 失败（不入库）。

*本地优先解析器*：① 命中本地副本 → 直接使用，零网络；② 本地缺失 → 指名 `资源 id + platform` 失败；③ 本地存在但版本与台账不符 → 以台账为准判定，不做"看起来是那个文件"的猜测；④ 请求了台账未登记的平台 → 显式失败。

*清理*：① 目标在 keep 白名单内 → 跳过删除并记录；② 目标不在白名单 → 正常删除；③ 清理后自检发现资源缺失 → 失败。

**边界情况必须覆盖**：空台账（不得假通过）、台账有条目但 `platforms` 为空、部分平台已入库部分未入库、`.env` 不存在（`install.mjs` 已有此分支，改动不得破坏）。

## Adjust — Rollback and Global Scan

**回滚**：
- 本次改动**以新增为主**（台账 + 资源文件 + 少量消费方改动），回滚成本低。
- 单步回滚：`git rm -r third-party/vendored/` 并还原消费方脚本；资源文件不入库前改动可 `git checkout -- <file>` 撤销。
- 整体回滚：`git reset --hard <Step 0 的分支基点>`，或从 `~/zcode-baseline-<date>.bundle` 恢复。
- **顺序即回滚保障**：Step 1.5 的体积门**先于任何下载**执行。这样"体积不可接受"的情况在产生数百 MB 提交物之前就能中止，不需要回滚二进制。
- **`.env.bak-before-vendor-migration` 删除不足以撤销凭据泄露**——Git 历史中仍在。本计划只做"删文件 + 登记轮换建议"，**不重写历史**（重写历史是独立决策，见 Open Questions）。

**全局扫描**（`CLAUDE.md` 要求：不单点修复，找同类）：
- **同类落点**：除 `sea-node-cache` 外，是否还有其他缓存/下载产物落在 `dist/` 或其他被忽略目录下？
- **同类直连**：Step 3.3 的排查要覆盖全部 `consumers`，而不是只修被点名的那两处。
- **同类忽略**：`.gitignore` 里是否还有其他"引用的东西已不存在"的规则？（已知三条）
- **同类残留**：除 `.env.bak-*` 外，仓库里是否还有其他 `*.bak` / `*.old` / 临时备份被跟踪？（用 `git ls-files` 配合模式匹配确认，不靠印象）
- **一致性风险**：Step 2 给 `clean.mjs` 引入的 keep 白名单，必须与 `git check-ignore` 断言覆盖同一批路径——A 改了而 B 没改，就会留下"清理时保留、入库时又被忽略"或反之的裂缝。

**向后兼容**：
- `make install` / `make doctor` / `make clean` 三条命令的**对外行为不得改变**（只是更快、更离线）。
- `--node-binary` 这条既有逃生口必须继续可用——已有用户可能依赖它。
- 若 Step 3 改了 `nodeCache` 根，需确认没有其他消费方按字面路径引用 `dist/sea-node-cache`。

## Open Questions

1. **托管方与单文件上限**：`.dockerignore` 中出现 `.gitlab`，但未确认实际托管方。GitHub / GitLab 的单文件与仓库体积限制不同，Step 1.5 的判定阈值取决于此。**执行 Step 1.5 前需要确认。**
2. **是否可使用 Git LFS**：若体积门触发，LFS 是候选选项之一。但 LFS 会让"克隆即得"打折扣（需额外拉取），与"随仓库上传"的诉求存在张力，需你定夺。
3. **`.env.bak-before-vendor-migration` 中的 `BIGMODEL_API_KEY` 是否为真实凭据**、是否已轮换。若是真实凭据且未轮换，应**先轮换再谈其他**；是否重写 Git 历史是独立决策。
4. **`mise` / `pnpm` 工具链是否纳入本地化**：`mise.toml` pin 了 node 24.14.0 与 pnpm 10.33.2，首次运行需要联网拉取。它属于"包管理器自身"还是"npm 包"的豁免范围，边界未定。
5. **受保护根的确切命名**：本文建议 `third-party/vendored/`，但 `apps/zcode-cli/dependencies/native-search/` 是既有先例。是统一到一个新根，还是各自就近存放？执行 Step 2.1 时定。
6. **Step 3 的 (a)/(b) 选择**：改 `nodeCache` 根 vs 从受保护目录播种，取决于改动面与是否有其他消费方，读源码后定。

## Out of Scope

- **F-006 本地化插件市场**（运行期插件图标兜底）——Phase 2。
- **F-007 资源刷新入口**——Phase 3。
- **修复 GitHub zipball 安装路径缺 sha256 校验**（`github-archive-source.ts:79`）——扫描发现的安全问题，已在痛点文档 §8 登记为独立 Issue，本计划不含。**但它不因不在本计划而降低严重性**，建议并行处理。
- **重写 Git 历史以移除已泄露的凭据**——需独立决策，见 Open Questions 3。
- **F-007 之外的资源自动更新机制**——本次只做"显式的本地化"，不做自动刷新。
- **`harness/remote/Dockerfile` 的 `apt-get`**——只影响测试脚手架，不属交付物依赖。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

### 风险索引

| ID | 风险 | 评分 | 级别 |
|----|------|------|------|
| R1 | Node 版本不确定：SEA 构建用 `process.versions.node` 决定下载哪一版 | 21.25 | **HIGH** |
| R2 | 基线不干净：本计划要改的文件正被并发修改且未提交 | 16 | **HIGH** |
| R3 | 台账的差集校验口径写错，导致"所有"变成静默的假保证 | 17 | **HIGH** |
| R4 | 受保护根命名撞上 `apps/zcode-cli/.gitignore` 的 `vendor` 规则，资源被静默忽略 | 13.6 | **HIGH** |
| R5 | 仓库无任何自动化门禁，数百 MB 的提交没有任何东西会拦 | 12.8 | **HIGH** |
| R6 | `licenses.mjs notices` 已损坏，"重新生成 notices"这条缓解路径不可用 | 19 | 极易发现，须记录 |
| R7 | 本地化的 Node 归档未连同 `SHASUMS256.txt` 一起落盘，断网时仍会先尝试联网 | 11.2 | 中高 |
| R8 | `.env.bak-before-vendor-migration` 只删文件不重写历史，凭据在 Git 历史中持续存在 | 7.5 | 中高 |
| R9 | 320 MiB 二进制使克隆成本成为新的开发者痛点，团队绕过它导致断网验收形同虚设 | 9.6 | 中高 |
| R10 | 断网验收本身可能假通过或假失败 | 6 | 中 |
| R11 | 扫描范围被外部解读为"整个仓库已扫过" | 3.6 | 低 |
| R12 | 修改 SEA 缓存根会外溢到发布链路行为 | 6 | 中 |

> 评分口径：`Severity(1-5) × Likelihood(1-5) × (1 - 提前发现概率)`，> 12 记为 HIGH。Detectability 按"**越难在早期发现、分值越高**"取值。

> 本次 pre-mortem 的结论**基于实测而非推断**：Node 各平台产物体积来自对 `nodejs.org` 的 HEAD 实测；`licenses.mjs` 的失败来自实际运行；`clean.mjs` 与 `.gitignore` 的范围来自读源码与 `git check-ignore`。三处被推翻的初判已在正文就地更正。

### [Risk] Node 版本不确定：SEA 构建用 `process.versions.node` 决定下载哪一版

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.15
**Risk Score**: 5 × 5 × (1 - 0.15) = 21.25 — **HIGH**

**Failure Scenario**：`build-sea.mjs:301` 是 `const nodeVersion = process.versions.node;`——**没有任何 pin**。于是"要本地化哪个版本的 Node 运行时"取决于**跑构建的那台机器上的 `node -v`**。本仓库三方声明已经互相矛盾：`.nvmrc` 写 `24`、`mise.toml` 写 `24.14.0`、`package.json` 的 `engines` 在本轮已被改成 `>=22.13.0`，而**当前 shell 实际是 v22.23.2**。结果：按 24.14.0 本地化 6 个平台的归档，换一台 Node 22 的机器构建时全部命中不了，只会静默回源 `nodejs.org`——而如果那台机器断网，就直接失败。更隐蔽的是反向情况：磁盘上残留了旧版本的缓存，缓存键**不含版本语义**，会被当成新鲜资源复用。本仓库磁盘上**根本没有 `sea-node-cache`**，说明这条路径从未被实际执行过——问题不会在开发时暴露，只会在交付现场暴露。

**Mitigation**：
- 把 Node 版本从"环境推导"改为"显式 pin"：新增一个单一真源（建议加入现有台账的 `RemoteResource.platforms` 所在处，或独立 `node-version` 字段），让 `build-sea.mjs` 读它而不是 `process.versions.node`。这是**前置改动**，必须在 Step 2.5 下载之前完成——否则下载的版本可能从一开始就是错的。
- 顺带收敛三方声明的不一致（`.nvmrc` / `mise.toml` / `engines`），并在计划里记录最终选定的版本与理由。
- 缓存键加入版本维度，杜绝旧版本归档被静默复用。
- 台账中每个 Node 归档条目必须与 pin 的版本严格对应，且 Step 1.4 的差集校验要能发现"pin 的版本 ≠ 已本地化的版本"。

### [Risk] 基线不干净：本计划要改的文件正被并发修改且未提交

**Severity**: 4 | **Likelihood**: 5 | **Detectability**: 0.2
**Risk Score**: 4 × 5 × (1 - 0.2) = 16 — **HIGH**

**Failure Scenario**：`git status` 显示 `scripts/install/toolchain.mjs`、`apps/zcode-cli/packages/cli/src/doctor.ts`、`package.json`、`apps/zcode-cli/package.json`、`packages/provider/src/model-selection-config.ts`、`README.md`、`README.en.md` 均**已修改未提交**，且 `main` 领先 `origin/main` 两个提交。这些正是本计划的核心改动区域（`toolchain.mjs` 属安装链路、`doctor.ts` 属 F-004 的可观测输出、`package.json` 的 `engines` 就是 R1 里的版本歧义来源之一）。照计划执行会在别人的未完成工作上继续叠加，产生冲突、覆盖或被覆盖，且 Step 0 用 `git bundle` 打的"基线"里混入了他人 WIP——回滚点不可信。

**Mitigation**：
- **Step 0 增加一步：先与用户确认这些未提交改动的归属与状态**，明确是"放弃、保留、还是先提交"。在确认之前不动手。
- 不把 `git bundle` 当作回滚锚点，除非工作区已提交或已 stash。回滚锚点改为"当前 HEAD 提交 + 已确认的 WIP 处置方式"。
- 特性分支从**已提交的 HEAD** 切出，不携带他人未提交改动；实施期间与那批改动保持文件级隔离。
- 每完成一个 Step 就 `git status` 复核哪些改动是自己的，避免把并发改动误当成自己的产物提交。

### [Risk] 台账的差集校验口径写错，导致"所有"变成静默的假保证

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.15
**Risk Score**: 5 × 4 × (1 - 0.15) = 17 — **HIGH**

**Failure Scenario**：Step 1.4 的差集校验是"所有"这个诉求**唯一**的可证明手段，而它极容易写成只匹配字面量 `https://`。本仓库恰恰大量使用**非字面量**的获取方式：`sea-targets.mjs:66` 用 `new URL(artifact, base)` **拼接**出 URL；`native-search-tools-config.mjs` 的预编译产物**只有 sha256 没有下载地址**；插件链路走 `git clone` 与 registry 引用。一个只扫字面量的校验器会产出**空的差集**，报告"全部覆盖"——而这个"通过"是自我印证的，没有任何下游信号能推翻它。最终结果是仓库交付时看起来"所有远程资源都已本地化"，实际漏掉一整类，断网时才暴露。

**Mitigation**：
- 差集校验**必须由两条独立路径产出并互相对账**：一路扫源码字面量与已知 API 形态（`fetch(` / `curl` / `git clone` / `new URL(` / registry 配置），另一路**从台账反推**（逐条追问"这条的消费者在哪、消费方式是什么"）。两路都空才算过。
- 增加**反向测试**：人为在源码里插入一个未被台账登记的获取点，确认校验器会失败；再人为从台账移除一条，确认校验器同样失败。校验器若不能失败，就没有证明力。
- 明确记录**豁免边界**（npm registry、用户配置的 LLM 端点）作为白名单，并对白名单本身做人工复核——白名单是差集校验最常见的漏网口。
- 台账中"只有 sha256 没有 url"的条目（预编译产物）单独归类并标注 `source: prebuilt`，不参与"需要下载"的差集，但**参与"需要入库"的差集**。

### [Risk] 受保护根命名撞上 `apps/zcode-cli/.gitignore` 的 `vendor` 规则，资源被静默忽略

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.15
**Risk Score**: 4 × 4 × (1 - 0.15) = 13.6 — **HIGH**

**Failure Scenario**：`apps/zcode-cli/.gitignore` 最后一行是一条**裸 `vendor`** 规则（匹配 `apps/zcode-cli/` 下任意名为 `vendor` 的路径）。计划正文同时给了两个落点倾向——"建议 `third-party/vendored/`"与"对齐既有先例 `apps/zcode-cli/dependencies/native-search/`"。若实施者选了后者并在其下建 `vendor/`，或者选了任何 `apps/zcode-cli/**/vendor*` 形态，**资源会静默不入库**：`git status` 不显示被忽略的文件，本地一切正常（文件就在磁盘上、构建也能读到），只有克隆到断网机器时才全线失败。这是本计划里**最典型的"本地全绿、交付全崩"**形态。

**Mitigation**：
- Step 2.1 的落点决策**以 Step 2.3 的断言为准**，而不是以美观或先例为准：先把候选路径逐个跑 `git check-ignore`，命中即淘汰，再谈其他。
- 断言必须覆盖**全部** `.gitignore`（本仓库有 6 个：根、`.husky/_`、`apps/zcode-cli`、`browser-use-plugin`、`dynamic-workflow`、`debug`），而不是只查根目录那一个——这正是本风险能成立的直接原因。
- 断言做成**入库前自动执行**的脚本，而不是一次性人工核对；`git add` **之后**再跑一次 `git ls-files` 确认文件确实进了索引，用"是否被跟踪"而非"是否被忽略"作为最终判据。
- 在 Step 2 的验收集里增加一条：新资源路径出现在 `git ls-files` 输出中，条目数与台账一致。

### [Risk] 仓库无任何自动化门禁，数百 MB 的提交没有任何东西会拦

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.2
**Risk Score**: 4 × 4 × (1 - 0.2) = 12.8 — **HIGH**

**Failure Scenario**：实测确认本仓库**没有 CI 配置**（无 `.github/`、无 `.gitlab-ci.yml`），**husky 钩子未安装**（`.husky/` 下只有 `_`，无 `pre-commit` / `pre-push`）。`package.json` 里的 `verify:pre-push` 只是一个不会自动执行的脚本。而 `.gitignore` 里那句"入库由 `scripts/ci/ci-repo-hygiene.mjs` 在 CI 第一站拒绝"所描述的护栏**并不存在**——那个脚本本身已被删除。因此：一次把 320 MiB 二进制推进历史的操作，**不会在任何环节被拦下**，直到推送被远端拒绝（或推送成功但此后所有人被迫克隆 320 MiB）。而一旦进入历史，即使回滚也无法缩小仓库——只能重写历史。

**Mitigation**：
- **不得依赖不存在的护栏**：把 `.gitignore` 里引用 `ci-repo-hygiene.mjs` 的注释一并更正（已在痛点文档 §8 登记为 Issue）。
- 在 Step 2 落盘之后、`git commit` 之前，**人工执行一次体积检查**并记录数字：总量、单文件最大值、最大贡献者。把它写成计划里的显式步骤而非"顺带看看"。
- 提交前**先确认远端推送限制**（单文件硬限、仓库体积限），再决定是否提交——不要在推送失败后才发现。
- 考虑到无钩子，**在 Step 0 明确本计划的所有验证门都是人工执行**，不存在"忘了跑也会被拦"的兜底。每个 Step 结束时如实报告"跑了哪些门、结果如何"，不得因为"反正没 CI"而跳过。
- 若体积门判定越界，回退到 Open Questions 2（LFS）或缩减平台集合，**由用户决策**，不自行降级。

### [Risk] `licenses.mjs notices` 已损坏，"重新生成 notices"这条缓解路径不可用

**Severity**: 4 | **Likelihood**: 5 | **Detectability**: 0.05
**Risk Score**: 4 × 5 × (1 - 0.05) = 19 — 低于阈值仅因极易发现，但**必须记录**

**Failure Scenario**：实测 `node scripts/licenses.mjs notices` **以退出码 1 失败**：`Error: Stale npm notice override: victory-vendor@37.3.6`。这是**精简分支带来的既存损坏**，与本计划无关，但它会让本计划的合规缓解手段失效。此外 `third-party/copied-components.json` 声明的 16 个 `roots` 中有 **9 个已不存在**（随 `packages/ui`、`packages/web`、`packages/rpc`、`packages/desktop` 一起被删），而 `generateThirdPartyNotices` 会对每个 root 调 `stat()`——即使修掉上面那个 override，还有下一层失败在等着。后果：新增本地化资源后**无法重新生成 `THIRD-PARTY-NOTICES.md` / `third-party/inventory.json`**，而 `third-party-notices.mjs:15-18` 会校验 `noticesSha256`，一旦这个链路彻底断裂，后续任何触碰 notices 输入的操作都会失败。

**Mitigation**：
- **本计划不承诺"重新生成 notices"**：把这条不可用的缓解从计划里剔除，避免给人"合规已处理"的错觉。
- 在 Step 5 的扫描报告里**单独记录这条既存损坏**，明确它是前置问题、不是本计划引入的。
- 明确本计划的合规立场：本地化新增二进制**会增加分发义务**（Node 运行时含 V8 / OpenSSL / libuv / ICU / zlib 等组件，当前 `third-party/runtime/sources.json` 只为 Node 正文许可登记）。在 notices 链路修复之前，**本地化的资源只登记进台账、不声称合规已覆盖**。
- 修复 notices 链路（清理失效 override + 修剪 9 个不存在的 root）作为**独立前置任务**提出，是否纳入本计划由用户决定——它不在原定的 F-001~F-005 范围内。

### [Risk] 本地化的 Node 归档未连同 `SHASUMS256.txt` 一起落盘，断网时仍会先尝试联网

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.3
**Risk Score**: 4 × 4 × (1 - 0.3) = 11.2 — 中高

**Failure Scenario**：`sea-node-download.mjs:90` 在下载产物**之前**先下载 `SHASUMS256.txt` 用于校验。如果本地化只放了归档而漏了这份校验清单，断网构建会在"下载 SHASUMS"这一步失败——现象是"资源明明在本地却仍说下载失败"，极易被误判成网络封锁没生效或缓存根没配好，排查方向完全跑偏。

**Mitigation**：
- 台账中把 `SHASUMS256.txt` 作为**独立的 `RemoteResource` 条目**登记（`kind: checksum-manifest`），而不是当作归档的附属——这样 Step 1.4 的差集校验才能看见它。
- 落盘断言增加一条：每个归档条目的同级目录下存在对应版本的校验清单，且条目数与归档数一致。
- Step 4 的断网验收必须**从未填充过的干净缓存**开始，否则本地残留会掩盖这个缺口。

### [Risk] `.env.bak-before-vendor-migration` 只删文件不重写历史，凭据在 Git 历史中持续存在

**Severity**: 5 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 5 × 3 × (1 - 0.5) = 7.5 — 中高（但严重度最高，须显式决策）

**Failure Scenario**：该文件**被 Git 跟踪**且含 `BIGMODEL_API_KEY`。本计划只删工作区文件——**文件仍留在历史中**，任何能克隆仓库的人都能取出它。而计划若把它列为"已处置"，会给交付方一个错误的安全感。这是"随仓库上传"这条诉求的负面镜像：想随仓库上传的东西没上传，不想上传的东西早就在仓库里了。

**Mitigation**：
- 该条目在扫描报告中单独列为 `kind: secret-exposure`，**severity 不低于 high**，并在交付前明确"未撤销"。
- **删除文件与轮换凭据必须同时做**，且轮换优先——轮换后即使历史泄露，凭据也已失效。
- 是否重写历史是**独立决策**（会改变所有 commit hash、影响所有协作者），列为 Open Question，不在本计划内执行。
- 全局扫描同步确认是否还有其他 `*.bak` / `*.old` / 临时备份被跟踪（计划 Adjust 段已列，此处升级为**必做项**）。

### [Risk] 320 MiB 二进制使克隆成本成为新的开发者痛点，团队绕过它导致断网验收形同虚设

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 4 × 4 × (1 - 0.4) = 9.6 — 中高

**Failure Scenario**：实测 Node 单平台产物合计 **320.6 MiB**（win-x64 87.1 / win-arm64 76.7 / darwin-x64 49.8 / darwin-arm64 48.7 / linux-x64 29.6 / linux-arm64 28.6 MiB），对照当前 `.git` 仅 37 MiB。日常开发只需宿主平台，全量拉取纯属浪费。团队会自然形成"浅克隆 / 不拉二进制 / 单独走一次下载"的变通做法——于是**没有人再跑真正的克隆即用路径**，断网验收从"每次交付都跑"退化为"发布前补一次"，F-004 的关卡在两次交付之间事实上失效。同时 darwin 两个归档（48.7 / 49.8 MiB）已越过 50 MB 告警线，win-x64（87.1 MiB）距 100 MB 硬限仅 13 MiB。

**Mitigation**：
- 明确**"克隆即用"是交付承诺，不是开发承诺**：开发者允许只拉宿主平台，但**交付验收必须在完整克隆上执行**，且这一点写进 Step 4 的前置条件。
- 在 Step 1.5 的体积门里**同时记录单文件最大值**，而不只是总量——`win-x64/node.exe` 87.1 MiB 已经是硬限的 87%，任何一次 Node 大版本升级都可能越界。
- 把"平台集合"做成**台账里的显式可配置项**，使缩减平台（Open Questions 2 的备选之一）是一次配置变更而非代码改动——这样体积门被触发时，用户有真实可选项。
- 在 `README` 中说明仓库体积构成与"只需要宿主平台"的获取方式，把变通做法**正规化**，避免它变成不受控的隐性实践。
- 每次 Node 版本升级后重跑体积门（新增一条维护动作，写入 Step 6 的文档同步）。

### [Risk] 断网验收本身可能假通过或假失败

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 3 × 4 × (1 - 0.5) = 6 — 中

**Failure Scenario**：两个方向都会错。**假通过**：封锁不彻底（只封了 HTTP 没封 DNS、或封了但缓存/连接池还在），构建实际仍走了网络却报告"断网成功"。**假失败**：把 npm registry 一起封了，而 npm 是本计划的**豁免项**，于是验收失败但归因错误，团队去修一个不存在的问题。

**Mitigation**：
- 验收前先做**封锁有效性自检**：确认一个已知非 npm 域名确实不可达、同时 `registry.npmjs.org` 可达。两个断言都必须成立，验收才开始。
- **从未填充过的干净状态起跑**（清 `dist`、清受保护目录外的所有缓存），并记录起跑时的 `git status`——用缓存残余换来的"成功"是本风险最可能的形态。
- 验收失败时**先看日志判定失败类型**再动手修：是"根本没找到本地副本"、"找到了但校验不过"、还是"npm 被封了"。三者现象相似，日志能一次区分（与 Think 段的定位顺序一致）。

### [Risk] 扫描范围被外部解读为"整个仓库已扫过"

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 3 × 3 × (1 - 0.6) = 3.6 — 低

**Failure Scenario**：F-005 的基线是"本轮资源 + 三条已知残留"（用户选定）。但"扫过一遍"的结论一旦离开语境，容易被当成对整个仓库的安全背书——而 `scripts/`、`apps/`、`packages/` 的历史遗留脚本并不在范围内。交付方可能据此省略后续审计。

**Mitigation**：
- 扫描报告**首屏写明覆盖范围与未覆盖范围**（计划已要求"覆盖不全不得出通过结论"，此处扩展为"必须显式列出未覆盖项"）。
- 报告措辞避免"仓库已通过安全扫描"这类整体性表述，改为"以下 N 项资源与 3 项残留已完成扫描"。
- 未覆盖范围作为**已知缺口**记入 Open Questions，供后续决策是否扩大。

### [Risk] 修改 SEA 缓存根会外溢到发布链路行为

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 4 × 3 × (1 - 0.5) = 6 — 中

**Failure Scenario**：Step 3 若改 `nodeCache` 根，会影响 `build-sea.mjs` 中所有以 `dist` 为基准的步骤（如 `stageNodeNotices(dist, ...)`、`seaAssetStagingForTarget`、`seaBlobForTarget`）。缓存位置与**产物输出位置**是两件事，改错会表现为产物缺失或 LICENSE 未随包分发——而 SEA 产物本就未被本仓库实际构建过（磁盘无 `sea-node-cache`），任何错误都不会在开发时显现。

**Mitigation**：
- 严格区分"缓存根"与"产物输出根"：只改**下载与解析的寻址**，不动 `dist` 下的产物写出路径。优先选 Step 3 的 (b) 播种方案，它对本风险的暴露面最小。
- 改动后**实际执行一次 `pnpm build:sea`（至少宿主平台）**，确认产物生成且 LICENSE 随包分发——这是本计划中少数必须真跑发布链路的地方，不能只靠类型检查。
- 改动前 grep 确认没有其他消费方按字面路径引用 `dist/sea-node-cache`（计划 Adjust 段已列，此处确认为**必做前置检查**）。

---

### Pre-mortem 结论

**5 个 HIGH RISK**（R1 版本不确定 21.25 / R4 并发未提交改动 16 / R6 差集校验假通过 17 / R3 vendor 命名静默忽略 13.6 / R5 无自动化门禁 12.8），以及 8 个中低风险，**全部附有缓解措施**。

最需要在动手前处理的三个：

1. **R1（Node 版本）**——它决定 Step 2.5 下载的东西是否正确。**必须在任何下载之前**解决，否则可能整批白做。
2. **R4（并发改动）**——`toolchain.mjs` 与 `doctor.ts` 正是本计划要改的文件，且未提交。先与用户确认归属，再决定从哪一点切分支。
3. **R6（差集校验）**——它是"所有"唯一的证明手段，一旦写错会给出静默的假保证，且没有任何下游信号能推翻它。

另外两条**改变了计划的既定内容**（已就地更正，不再作为待办）：
- `.gitignore` 的护栏并不存在（无 CI、无钩子），"会被 CI 拦住"的假设必须删除。
- `licenses.mjs notices` 已损坏，"重新生成 notices"这条缓解不可用，计划不得声称合规已覆盖。
