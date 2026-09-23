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

| 项       | 决定                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------- |
| 覆盖范围 | F-001 ~ F-005 **加上 F-006**（判据修正后插件市场本地化成为核心，不再是 Phase 2 增强项）；不含 F-007        |
| 资源判据 | **按归属方划分**：智谱自家的远程资源在本地留一份；第三方通用包直接下载即可、不保留                         |
| 扫描基线 | 本轮本地化的资源 **+** 已发现的残留（`.env.bak-*`、失效 `.gitignore` 规则、`prepare-prebuilds.sh` 死入口） |
| npm 边界 | npm 注册表**豁免**，只登记不本地化                                                                         |

> **判据在执行中被修正过一次，记录在此以免后续再走回头路。** 初版按"是不是环境前提"划分，于是把 Node 运行时（336 MiB）与 8 个上游源码包（~25 MiB）都列进了本地化范围——占全部体积的 97%，而它们只是第三方通用包。按用户的归属方判据改判后，**真正的目标浮出来了：智谱自家 CDN 上的官方插件市场**——清单 + 26 个插件包 + 26 个图标，合计 **10.8 MiB**。
>
> 修正后的实际效果：本地化范围从 ~345 MiB 降到 **10.8 MiB**，且这 10.8 MiB 恰好是"断网用户真正拿不到、且只有智谱能提供"的那部分。Node 与上游源码包改为由环境自行获取（`build-sea` 的 `--node-binary`、`build:native-search` 使用时下载）。
>
> **由此带来的一处诚实代价**：`pnpm build:native-search` 仍是唯一硬依赖公网的构建步骤。它属于第三方通用包，按判据不保留——**这是有意接受的结果，不是遗漏**。若要连它一起离线，前提是重新讨论判据。

约束：

- 仓库已有一处完成的正确形态可对齐——`apps/zcode-cli/dependencies/native-search/`（19 个预编译包入库 + `SHA256SUMS` + 全离线）。本计划**不另起一套**，落点与校验方式向它看齐。
- `scripts/clean.mjs` 目前按**目录名**匹配 `node_modules` / `dist`，不具备"显式保留"的表达能力。
- 本仓库是精简分支，`AGENTS.md` 要求改动后跑 `pnpm typecheck` 与 `pnpm lint` 并报告真实结果。

## Goal

完成后应能同时成立：

1. **断网可构建**：屏蔽全部非 npm 出网后，从零 `pnpm bootstrap` 成功。
2. **断网可用官方插件**：断网启动 zcode，官方插件市场可列出**并安装**智谱的插件（而不只是看到空壳）——这是本次本地化要买到的核心能力。
3. **资源可入库**：智谱自家的 52 条资源进入 Git 跟踪，`git check-ignore` 对本地副本路径**零命中**。
4. **清理后存活**：`make clean` 后台账逐条仍存在，清理后可直接再次构建。
5. **可审计**：存在一份台账，且"台账 vs 全仓实际引用"的差集为空；台账中缺 sha256 的条目数为 0。
6. **扫过一遍**：对本轮资源与三条已知残留产出扫描报告，无未处置的 `high` 发现。

> 体积约束相应从"320 MiB 是否可接受"变成"**10.8 MiB，最大单文件 5.73 MiB**"——两个 GitHub 硬限相关的高风险项（win-x64 一度到 100MB 硬限的 87%）随之消失。

## Plan

### Step 0 — 基线与回滚锚点

1. 跑 `node scripts/check-workspace-freshness.mjs`，确认基线不是旧的（`AGENTS.md` 明确要求开工前执行）。
2. **确认工作区状态（R2 已解除，保留记录）**。开始执行时复核：那批并发改动已由提交 `0189deb`（feat: expand node version fields）落地，HEAD 前移；工作区仅剩一处**非本计划的**调试日志清理（`process-provider-registry-runtime.ts` 删除 `[DEBUG-vendor]` 插桩），**保留不动**。若再次出现未知改动，重复本步的确认流程。
3. 记录基线数字作为对账依据：`.git` 体积、跟踪文件数、`git rev-parse HEAD`。
4. 建仓库外备份（对齐 `docs/dependency-boundary.md` 既有做法）：`git bundle create ~/zcode-baseline-<date>.bundle --all`。**注意：工作区不干净时这份 bundle 不含未提交改动**，故它只能作为已提交历史的回滚锚点，不能作为"完整基线"。
5. 起一个特性分支，从**已提交的 HEAD** 切出，不携带他人未提交改动；不直接在 `main` 上做。
6. **明确本计划的验证门全部为人工执行**（无 CI、husky 未安装，见 Pre-Mortem R5）。不存在"忘了跑也会被拦"的兜底。

### Step 1 — F-001 建立资源台账（含体积 Go/No-Go 关卡）

1. **枚举**：对全仓（`scripts/`、`packages/`、`apps/`、`config/`、根配置）扫描远程引用点，来源包括但不限于 `https?://` 字面量、`fetch(` / `curl` / `git clone`、`.npmrc` registry、`mise.toml` 工具链。输出候选清单，**先不判重、不下结论**。
2. **定义结构**：按痛点文档 §3.2 的 `RemoteResource` 落一份机器可读台账。落点建议 `third-party/resources.json`（与既有 `third-party/*/sources.json` 同类、同目录、已被 `.gitattributes` 覆盖为 `-text`，且确认过**不在任何忽略规则下**）。
3. **填充**：逐条补 `id` / `kind` / `url` / `sha256` / `vendored_path` / `scope(build|runtime)` / `platforms` / `size_bytes` / `consumers`。已被本地化的既有资源（`dependencies/native-search/` 的 19 个包、许可原文、`config/provider/zcode-builtin.json`）**一并登记并标记为"已就绪"**，不重复下载。
4. **差集校验（见 Pre-Mortem R3——这是静默假通过的高危点）**：写一个校验入口，把"台账声明的资源"与"实际引用"取差集。**必须由两条独立路径产出并互相对账**：
   - 路径 A：扫源码中的获取点，覆盖**非字面量**形态——`new URL(x, base)` 拼接（`sea-targets.mjs:66` 即此形态）、`fetch(` / `curl` / `git clone` / registry 配置。
   - 路径 B：从台账反推，逐条追问"这条的消费者在哪、以什么方式消费"。

   两路都为空才算通过。并做**反向测试**：人为插入一个未登记的获取点 → 校验器必须失败；人为从台账删一条 → 校验器必须失败。**校验器若不能失败，就没有证明力。** 白名单（npm registry、用户配置的 LLM 端点）单独人工复核。

5. **按归属方划分资源范围（判据修正后的实际执行）**：把台账条目分成两类——
   - **智谱自家**（`vendor: "zhipu"`）→ 本地化。实际命中：`cdn-zcode.z.ai/zcode/official-plugin/**` 的清单 + 26 个插件包 + 26 个图标。
   - **第三方通用包** → 不本地化，改由环境在使用时获取。实际命中：Node 运行时（nodejs.org）、8 个上游源码包（codeload / sourceware / GitHub Releases）、GitHub 插件 zipball、cloudbase 外域图标。
   - 台账中两类**都要登记**（对账要看得见全部获取点），但只有前者参与本地化与体积预算。

6. **体积预算门（决策点，先于任何下载）**：
   - 修正前的初版范围（Node + 上游源码包）实测 **~345 MiB**，其中 `win-x64/node.exe` 87.1 MiB，距 GitHub 100MB 单文件硬限仅 13 MiB——这是一个真实的推送阻断风险。
   - 判据修正后，实际本地化范围是 **10.8 MiB，最大单文件 5.73 MiB**（`mimosa` 插件包）。对照基线 `.git` 38 MiB，仓库增量约 +11 MiB。
   - **门禁判定：通过，且两个硬限相关风险随之消失**。托管方已确认是 GitHub（`origin = git@github.com:canwhite/zcode-tui.git`），适用 100MB 单文件硬限 / 50MB 起警告——10.8 MiB 与 5.73 MiB 对两条线都留有充足余量。

### Step 2 — F-002 本地化与受保护目录

1. **定受保护根**：建议 `third-party/vendored/`。**落点以断言为准，不以美观或先例为准**（见 Pre-Mortem R4）：把候选路径逐个跑 `git check-ignore`，命中即淘汰。
   > **已知陷阱**：`apps/zcode-cli/.gitignore` 最后一行是一条**裸 `vendor`** 规则。若落点选在 `apps/zcode-cli/**/vendor*` 形态（例如为了对齐 `dependencies/native-search/` 先例而建 `dependencies/vendor/`），资源会**静默不入库**——`git status` 不显示，本地一切正常，克隆到断网机器才全线失败。
2. **实现下载器**：输入台账条目，输出落盘文件。必须做到——sha256 校验后才落盘、写临时文件再原子 rename（避免半成品冒充完整文件）、**幂等**（已存在且 sha256 匹配即跳过，不发网络请求）。
3. **落盘断言（脚本化，非一次性人工核对）**：入库前对每个 `vendored_path` 跑 `git check-ignore`，命中即失败。**必须覆盖全部 6 个 `.gitignore`**（根、`.husky/_`、`apps/zcode-cli`、`browser-use-plugin`、`dynamic-workflow`、`debug`），而不是只查根目录那个——这正是 R4 能成立的直接原因。最终判据用 **`git ls-files` 是否包含该文件**（"是否被跟踪"），而不是"是否被忽略"：`git add` 之后再跑一次，确认条目数与台账一致。
4. **清理边界**：让 `scripts/clean.mjs` 具备"显式保留"的表达能力。当前它按名字匹配 `node_modules` / `dist`，建议引入一份 keep 白名单并断言 `assertSafeTarget` 不落在受保护根之下；同时补一条清理后自检（台账逐条断言存在）。
5. **落地智谱自家资源**：官方插件市场清单 + 26 个插件包 + 26 个图标。
   - **校验来源分两种，须在台账中标注**：26 个插件包的 sha256 直接取自官方 `marketplace.json` 的 `source.sha256`（**官方发布值**，可信锚点）；清单自身与 26 个图标 CDN 未发布校验值，采用 **TOFU**（首次获取时本机计算并固化），台账中以 `sha256Provenance` 字段标明来源，不与官方值混为一谈。
   - **已执行结果**：52 条全部下载并通过校验，新增 10.8 MiB，0 失败；`git add -n` 预演确认恰好 52 个文件、零第三方包误入。
   - **体积已回填台账**并与预算对账：实测 10.8 MiB、最大单文件 5.73 MiB，与预估无偏差。
6. **对账**：入库后复算实际体积（总量 **与单文件最大值**），与 Step 1.6 的预算逐项对账，偏差需解释。

### Step 3 — F-003 本地优先解析

> **范围已随判据修正而改变**：初版这里处理的是 SEA 的 Node 缓存与 native-search 的 `curl`——两者都属第三方通用包，现已不在本地化范围内。**本地优先解析的对象改为智谱自家的插件市场与插件包。**

1. **官方插件市场：本地分片必须能独立成立**。`official-marketplace.ts` 已把 `bundled-marketplace.json` 与 `cdn-marketplace.json` 分片持久化后合并，且 CDN 拉取是惰性的。要做的是**把本地清单作为真正的数据源**，而不是依赖"拉不到就用空的"：
   - 首启用受保护目录里的 `marketplace.json` 生成内置分片；
   - CDN 分片降级为**可选增量**——它的存在不得成为列出智谱插件的必要条件。
2. **插件安装：`type: "zip"` 这条路要能命中本地副本**。清单里 26 个插件包的 `source` 都是 `{source:"url", type:"zip", url, sha256}`，`zip-source.ts` 已按 64 位 sha256 校验后才解包——**校验链路是现成的，不要新增一套**。要做的是在 URL 指向智谱 CDN 时优先解析到 `third-party/vendored/zhipu-official-plugin/plugins/<name>/<version>/plugin.zip`。
   > **只改寻址，不改校验**：本地副本同样要过那道 sha256。改成读本地就跳过校验，等于把这次本地化变成一次安全性倒退。
3. ~~**图标：CDN URL 改为本地 URL**~~ **本条作废（实测证伪）。**
   > 原文断言"图标是直接渲染的 CDN URL，断网下市场可见但全是碎图"——**经全仓 grep 证伪**：`apps/zcode-cli/packages/tui/src` 中 `icon` 的命中数为 **0**，`apps/` 与 `packages/` 下也没有任何 `.tsx` 渲染 `listing.icon`；适配器只在解析清单时读取、归档、再删掉它（`marketplace.ts:1494` 的 `delete raw.icon`）。**当前没有任何消费方**，因此断网不会产生碎图，也就无需为此改代码。
   >
   > 图标仍**保留在本地化范围内**（753 KiB，且确属智谱自家资源，符合判据），但理由改为"清单引用了它、且属智谱资产，留存成本可忽略"，而**不是**"否则界面会坏"。这条不作数等于砍掉一处臆想的改动。
4. **扫其余直连**：逐个确认构建/安装链路里没有残留的、未被台账解释的直连获取（登记在台账里的 `consumers` 即为此用）。
5. **缺失时行为**：本地副本缺失必须**指名资源 id**（插件名 + 版本）后失败，不静默回源、不静默跳过。这是"相对独立的个体"能否被信任的关键——静默回源会让断网问题推迟到交付现场才暴露。

> **执行结果（已实测，非设计意图）**
>
> 改动落在三处：新增 `adapters/src/plugins/official-vendored-assets.ts`（URL→本地副本的寻址，含越界防护）；`zip-source.ts` 加本地优先读取；`bundled-plugins.ts` 在写内置分片后播种 CDN 分片。
>
> | 验证项                         | 做法                                                  | 结果                                                             |
> | ------------------------------ | ----------------------------------------------------- | ---------------------------------------------------------------- |
> | 寻址与越界防护                 | 12 个用例（映射、`..`、绝对路径、空路径、非智谱域名） | 12/12 通过                                                       |
> | 离线可列出                     | 隔离 storage 跑 `plugins list`                        | 合并清单 **28 个**（26 智谱 + 2 内置），26 个全部带 64 位 sha256 |
> | 离线可安装                     | `HTTP(S)_PROXY` 指向死端口，`plugins install wind`    | **成功**：`Installed plugin wind@zcode-plugins-official (0.1.0)` |
> | 副本缺失（清单也没了）         | 移走整个本地副本目录                                  | 失败：`Plugin not found in any marketplace`                      |
> | 副本不完整（清单在、单个包缺） | 移走 `wind/0.1.0/plugin.zip`                          | 失败并给出指名诊断（见下）                                       |
>
> 诊断输出形如：
>
> ```
> plugin_marketplace_invalid: 官方插件包既无本地副本、也无法回源（断网环境下即为预期失败）：
>   https://cdn-zcode.z.ai/zcode/official-plugin/plugins/wind/0.1.0/plugin.zip
>   修复：在仓库根执行 node scripts/vendor-resources.mjs fetch
>   原始错误：connect ECONNREFUSED 127.0.0.1:9
> ```
>
> **两处值得记下的执行教训**：
>
> 1. **验证必须走真实产物**：`@zcode/contracts` 的 `exports` 指向 `.ts` 源码，只有打包器能解析，因此这批逻辑无法用 node/tsx 直接单测——最终是靠重建 `@zcode/cli` 产物、用 `ZCODE_STORAGE_DIR` 隔离跑真 CLI 才验证到位的。
> 2. **改 bootstrap 必须重建 bootstrap**：`@zcode/cli` 打包时解析的是 `@zcode/bootstrap` 的 **dist**，不是源码。只重建 adapters 与 cli 时，播种代码根本没进产物——表现为"分片没生成但日志也不报错"，排查了一轮。**这是本仓库构建顺序的一个真实陷阱，已记入 Step 6 的文档同步。**
>
> `ZCODE_DEBUG_VENDOR=1` 保留了常驻诊断（默认关闭）："本地副本没被找到"在交付现场最难远程判断，而一行基准目录日志就能区分"跑错目录 / 被 gitignore 漏发 / 副本损坏"这三种修法完全不同的原因。

### Step 4 — F-004 断网验收关卡

1. **造断网**：提供一种可重复的"封锁全部非 npm 出网"的方式（代理黑洞或等价手段）。
2. **封锁有效性自检（见 Pre-Mortem R10，先做再验收）**：确认一个已知非 npm 域名**确实不可达**，同时 `registry.npmjs.org` **确实可达**。两个断言都成立才开始验收——只做前者会得到假失败（把 npm 一起封了，去修一个不存在的问题），只做后者会得到假通过（没真封住）。
3. **从零验证**：**先清到干净状态**（清 `dist`、清 Agent storage 里的插件市场缓存 `marketplaces/zcode-plugins-official/`、清受保护目录外的全部缓存），记录起跑时的 `git status`，再 `pnpm bootstrap` → 构建 → `zcode doctor` → 启动 TUI。用缓存残余换来的"成功"是本关卡最可能的失效形态——插件市场尤其容易，因为它本来就有上次联网留下的分片。
4. **核心断言（本次本地化真正要买到的东西）**：断网下官方插件市场**可列出智谱的 26 个插件**，且能**成功安装至少一个**（安装要走到解包完成，不是"点了没反应"）。只验"市场不为空"是不够的——空壳与可用是两件事。
5. **清理后验证**：`make clean` 后再走一遍，确认资源存活（`clean.mjs` 的受保护根快照对比会直接打印文件数）。
6. **连续两次通过**才算达标（单次通过可能是缓存命中造成的假象）。
7. ~~在完整克隆上执行~~ **此条已不适用**：本地化范围降到 10.8 MiB 后，全体克隆都天然包含全部资源，不再存在"只拉宿主平台"的变通做法。原 R9（克隆成本导致开发者绕过、验收形同虚设）随之消解。

> **执行结果**：本关卡已落成可重复执行的脚本 **`test/offline-acceptance.mjs`**（不再是手工步骤），断言全部实测通过：
>
> | 断言     | 内容                                                  | 结果 |
> | -------- | ----------------------------------------------------- | ---- |
> | A1       | 封锁机制有效（死代理确实拒绝连接）                    | ok   |
> | A2       | npm 豁免完好（registry.npmjs.org 可达）               | ok   |
> | A3 / A3b | 断网可列出 **26 个**智谱插件，且每个都带 64 位 sha256 | ok   |
> | A4       | 断网可安装（`plugins install wind`）                  | ok   |
> | A5       | **负向**：屏蔽本地副本后同一安装必须失败              | ok   |
> | A6       | 台账 52 条副本齐全且 sha256 匹配（离线校验）          | ok   |
> | A7       | 落点不被任何 `.gitignore` 命中                        | ok   |
> | A8       | `make clean` 后本地副本仍齐全（`--with-clean`）       | ok   |
>
> **A5 是这套断言里最关键的一条**，它一举证明两件事：A4 的成功确实来自本地副本（不是缓存、不是回源），且封锁对 CLI 的取网路径真的生效——若 CLI 能出网，A5 反而会"安装成功"而失败。没有 A5，"装成功了"证明不了"断网也能用"。
>
> **连续通过**：A1~A7 连续跑通三遍（其中一遍在 `pnpm install` 重装依赖之后），A8 单独跑通一遍。A8 默认不跑（会删 `node_modules` 需重装），但**这条恰是用户最初三条诉求之一**（"在 make 指令清理的时候不做清理"），所以已实际执行验证，不是靠读代码推断。
>
> 为此新增了一个能力：`ZCODE_VENDORED_ASSETS_ROOT` 可显式指定本地副本根。它有两个用处——运维把副本放共享挂载时不必复制仓库目录；以及让 A5 能在**不触碰受版本控制的文件**的前提下证明副本是必需的。

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
   - 本地化内容的**性质已随判据修正而改变**：初版计划要分发的是 Node 运行时（内含 V8 / OpenSSL / libuv / ICU / zlib 等一堆上游组件，会显著扩大分发义务）；现在分发的是**智谱自家的插件包与图标**。这不是 OSS 许可问题，而是**智谱自家资产的再分发边界**问题——需要确认这批插件包是否允许随仓库分发，以及是否需要在仓库内附带来源与版本标记。这是本计划新增的一条待确认项（已记入 Open Questions）。
   - 附带收益：不再分发第三方二进制后，"重新生成 notices 不可用"对本计划的实际影响大幅下降——本计划已不含会扩大 OSS 分发义务的产物。
   - 修复 notices 链路（清理失效 override + 修剪 9 个不存在的 root）作为**独立前置任务**提出，不在原定 F-001~F-005 范围内，是否纳入由用户决定。

### Step 5 扫描报告（已执行）

**工具**：`test/vendor-scan.mjs`（可重复执行）。**语料**：26 个插件包解包 = 363 个可执行文件，其中 **11 个受保护载荷已解密**后一并纳入扫描。

**覆盖范围与未覆盖项（先说清楚，避免"通过"被过度解读）**：

- ✅ 覆盖：26 个插件包内的全部可执行文件（py / js / mjs / ts / tsx…），含加密载荷解密后的明文。
- ⚠️ 未覆盖：markdown / json / 图标（无行为语义）；插件运行期访问的第三方数据源（见下"运行期依赖"）；仓库内非本地化的第三方包（Node、上游源码包）——它们不在本次分发范围内。

---

#### 发现 1（HIGH → 已核实为良性，但需你知悉）：`mimosa` 交付包使用加密载荷 + 自定义加载器

| 项         | 内容                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 现象       | `.mimosa` 载荷为 **AES-256-GCM** 加密，由 `runtime/protected-loader.cjs` 在运行时解密执行；5 个 hook 脚本经它加载，`hooks.json` 注册为 `PreToolUse` / `PostToolUse` **自动触发**                                                                        |
| 独立复核   | 用包内固定公钥**自行验证 Ed25519 签名：通过**；manifest 的 `publicKeySha256 = f076043b…` 与 loader 中钉死的指纹**完全一致**（无法换钥匙）；35 个文件逐条 sha256 全部匹配                                                                                |
| 可审计性   | 密钥**随包分发**（`runtime/mimosa-embedded-key.cjs`）。manifest 自述 `embeddedKeyBoundary: "obfuscated-node-module/cost-raising-only"`——即官方明说这是"抬高成本"而非真保密。**因此我实际解密了全部 11 个载荷并读完。**                                  |
| 解密后结论 | `git-gate-hook` 等 hook **无任何出网代码**，只 `spawnSync` 本地 `git` 与自带扫描器；它会**拒绝**通过 Bash 直接写源码/安全配置（要求改走 Write/Edit 以便被扫描）；含符号链接防护、状态文件 mode 0600、原子写。**这是安全工具该有的姿态，与"后门"相反。** |
| 处置       | **不阻断交付**。但要点明：这是**唯一**一处"源码不可直接阅读"的内容，其可信性建立在"官方签名 + 公钥钉死"上，而非"读过源码"。若要更高保证，需要求上游提供明文审计或纳入其签名发布流程。                                                                   |

#### 发现 2（MEDIUM → 假阳性，记录成因）：5 处 HIGH 命中来自扫描器自身的规则定义

`mimosa` 把**自己的检测规则**作为数据随包分发（`rules/mimosa-offline.mimosa`、`security-scan-worker` 内的 `re:` 模式表、`scan-hook` 内的命令执行特征串）。这些规则文本**长得和它们要检测的东西一模一样**，例如：

```
- pattern: child_process.exec($CMD, ...)
{id:"child-process",re:/\b(exec|execSync|spawn)\s*\(/,desc:"命令执行 child_process"}
```

扫描一个安全工具，必然命中它自己的规则表。**这是可解释的假阳性，不是隐瞒**——证据（模式表、`desc` 中文说明）都在明文里。另有 1 处 `new Function(...)` 属 **ajv** 编译 JSON Schema 的既有行为。

#### 发现 3（HIGH → 假阳性，已逐个读源码）：2 处 `egress+exec` 文件

| 文件                                                     | 实情                                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `video2code/mcp/v2c_tools/deploy.py`                     | `subprocess.Popen(["python3","-m","http.server",…,"--bind","127.0.0.1"])`——**回环**预览服务器；出网信号来自字符串 `http.server`。无外部请求。 |
| `video-agent-kit/skills/env-setup/scripts/env_doctor.py` | 环境诊断脚本：探测 pip 镜像（清华/阿里）、跑 `ffmpeg` 探测编解码、做连通性检查。属诊断工具的正常行为。                                        |

#### 发现 4（LOW → 已核实）：其余"非允许主机"均为文档/测试夹具/业务数据源

`sse.com.cn` / `pbc.gov.cn` / `wind.com.cn` / `tianyancha.com` 出现在 `selftest.py` 里是 **URL 解析的测试夹具**，该文件网络调用行数为 **0**。其余为主机名出现在 markdown 文档或 json 元数据中。

> **运行期依赖（需你知悉，不在本计划范围）**：这些插件本身是**联网业务插件**（金融数据、公司查询、视频生成等）。本地化买到的是"**断网可列出、可安装、可加载**"，**不是"断网可完成业务功能"**——后者的数据源在第三方服务，按判据不属本地化范围。

#### 发现 5（HIGH → 未处置，需你决策）：被跟踪的凭据文件

`.env.bak-before-vendor-migration` **被 Git 跟踪**，含 9 个键，其中 `BIGMODEL_API_KEY` 属凭据类。**删除文件不足以撤销**——历史里仍在。处置见 §8 的独立 Issue。

#### 发现 6（LOW → 已核实）：两处失效残留

- 三个脚本已被删除，但 `.gitignore` 仍以它们为理由保留规则：`scripts/ci/ci-repo-hygiene.mjs`、`scripts/prepare-prebuilds.mjs`、`scripts/cua-helper-sea-base.mjs`。
- `scripts/prepare-prebuilds.sh` 仍 `exec node scripts/prepare-prebuilds.mjs`，实测**报 module not found 退出**——死入口。

---

#### 扫描器自身的一次真实缺陷（记录在案）

`test/vendor-scan.mjs` **第一版报告"0 个文件、0 命中、无异常主机"**——因为插件内容在 `plugin.zip` 内，而它直接遍历目录，等于什么都没看却给出了一份"干净"结论。这与 Pre-Mortem R3 是同一类失效。

已修复并加**硬断言**：语料为空即 `exit 1`，且报告强制打印覆盖率。**加密载荷也必须解密后纳入**，否则"覆盖 100%"是假的——本扫描因此覆盖 11 个解密载荷。**一个能给出"通过"却其实没扫到东西的检查器，比没有检查器更危险。**

#### 交付判定

| 发现                 | 级别     | 处置                                                              |
| -------------------- | -------- | ----------------------------------------------------------------- |
| 1 mimosa 加密载荷    | HIGH     | 已解密审计 → 良性；不阻断，但公开其"信任基于签名而非明文"这一性质 |
| 2 扫描器规则表假阳性 | MEDIUM   | 记录成因，不阻断                                                  |
| 3 egress+exec 两文件 | HIGH     | 已逐个读源码 → 假阳性，不阻断                                     |
| 4 文档/夹具主机      | LOW      | 不阻断；附运行期依赖说明                                          |
| **5 被跟踪的凭据**   | **HIGH** | **未处置——需先轮换凭据，独立 Issue**                              |
| 6 失效残留           | LOW      | 独立 Issue，不阻断                                                |

**结论：无未处置的、指向本地化资源本身的高危发现。**唯一 HIGH 未决项是发现 5（仓库既存的凭据文件），它与本次本地化无关，但**不因无关而降低严重性**。

### Step 6 — 全局复核

1. **同类路径扫一遍**：还有哪些地方在直连外网？还有哪些目录落在 clean / ignore 的边界上？按 `CLAUDE.md` 的"全局扫描"原则，目标是能明确回答"就这一处"或列出全部同类。
2. **可观测**：让 `doctor` 报出"本地化覆盖率 / 未校验数 / 忽略命中数 / 各平台缺失项"，使离线可用性可自查，而不是等构建失败才发现。
3. **文档同步**：`README` / `AGENTS.md` 中与安装、清理、依赖相关的描述同步更新（`AGENTS.md` 明确要求删除功能时同步清理引用，反之亦然）。

> **执行结果**
>
> **同类路径扫描**（`CLAUDE.md` 的"全局扫描"要求，目标是能回答"就这一处"或列出全部同类）：
>
> - 同类残留：`git ls-files` 匹配 `*.bak|*.old|*.orig|*.save|*.tmp|*_backup` —— **仅 `.env.bak-before-vendor-migration` 一例**，已作为 HIGH 发现登记。
> - 同类落点：`clean.mjs` 的删除目标为 `node_modules` / `dist`，受保护根为 `third-party/vendored`，**无交集**；且 `clean.mjs` 现在有 `assertSafeTarget` 硬断言，未来交集会被拦。
> - 同类直连：`remote-resources.mjs check` 通过——**除台账已解释的获取点外，没有第二个未登记的出网点**。
>
> **可观测**：`zcode doctor` 新增 `官方插件本地化` 检查项，三个分支都实测过：
>
> | 场景       | 输出                                                                          |
> | ---------- | ----------------------------------------------------------------------------- |
> | 正常       | `PASS 官方插件本地化: 覆盖率 100%（26/26），断网可列出并安装`                 |
> | 无副本     | `WARN 官方插件本地化: 未找到随附的官方插件副本；官方插件市场与安装将依赖网络` |
> | 副本不完整 | `FAIL 官方插件本地化: 覆盖率 96%（25/26）；缺失：wind` → `result: FAILED`     |
>
> 判 `warn` 而非 `fail` 的取舍：包管理器安装或 SEA 发行形态不一定带仓库目录，那是合法部署形态（只是官方插件需要联网）。已把这条取舍写进代码注释。
>
> **文档同步**：`README.md` 与 `README.en.md` 各新增「离线可用性 / Offline Availability」一节（含判定口径、四条命令、doctor 输出示例，以及"离线可用≠业务功能可用"的限定）；`AGENTS.md` 命令表新增四条入口，并新增「本地化资源」小节记录三处**只有踩过才知道**的坑：裸 `vendor` 忽略规则、改 bootstrap 必须单独重建、`@zcode/contracts` 只能由打包器解析因而无法直接单测。
>
> **最终门禁**（全部实测）：`remote self-test` / `remote check` / `vendor verify` / `vendor assert` / `offline acceptance` / `vendor scan` 六项 exit 0；adapters、bootstrap、cli 三个包 `tsc --noEmit` 通过；根 `pnpm typecheck` 通过；12 个改动文件 oxfmt 全部通过；5 个脚本 oxlint **0 warnings 0 errors**。

## Think — Debug Methodology

- **先证据后假设**：本次的"远程资源到底有哪些"必须由扫描得出，不能凭记忆或印象罗列。Step 1.4 的差集校验就是这个原则的固化形式。
- **在框架边界加日志**：下载器与本地优先解析是本次的两个边界。日志加在**接收侧**——下载器打印 `资源 id / url / 命中缓存还是发起下载 / sha256 判定结果`；解析器打印 `请求的 target / 命中的路径 / 缺失原因`。前缀统一用 `[DEBUG-offline]`，便于一次性 grep 清除。
- **先读源码再判断行为**：`scripts/clean.mjs`（清理范围）、`build-sea.mjs` + `sea-node-download.mjs`（缓存与跳过逻辑）、`native-search-tools-process.mjs`（下载与校验）三处必须读源码确认，不靠文档推断。本计划中 `nodeCache = resolve(dist, "sea-node-cache")` 与 `--node-binary` 接受已解压二进制这两条，都是读源码才发现的。
- **定位顺序**：断网构建失败时，从**最上游**开始——是"根本没找到本地副本"还是"找到了但校验不过"还是"校验过了但消费方没读对路径"。三者现象相似，上游日志能一次区分。
- **别用重试掩盖**：构建失败时不要反复重跑（第二次成功通常是缓存或网络抖动）。先看日志判定是哪一类失败。

## Do — Verification Strategy

**每一阶段都要跑（`AGENTS.md` 要求，报告真实结果，不把已有失败写成通过）：**

| 门         | 命令                                         | 通过标准                                   |
| ---------- | -------------------------------------------- | ------------------------------------------ |
| 基线新鲜度 | `node scripts/check-workspace-freshness.mjs` | 通过（Step 0 执行一次）                    |
| 构建       | `pnpm bootstrap`                             | 成功                                       |
| 类型检查   | `pnpm typecheck`                             | 零错误                                     |
| Lint       | `pnpm lint`                                  | 零错误                                     |
| 格式       | `pnpm fmt:check`                             | 通过（本次改动含大量新文件）               |
| 架构检查   | `pnpm architecture:check --changed`          | 通过（`AGENTS.md` 要求涉及代码改动时执行） |
| 安装自检   | `node scripts/install/install.mjs doctor`    | 通过                                       |

**本次特有的验证门：**

| 门       | 做法                                             | 通过标准                     |
| -------- | ------------------------------------------------ | ---------------------------- |
| 忽略断言 | 对台账每个 `vendored_path` 跑 `git check-ignore` | 零命中                       |
| 清理存活 | `make clean` 后按台账逐条断言                    | 零缺失                       |
| 差集校验 | 台账 vs 全仓实际引用                             | 差集为空                     |
| 幂等性   | 下载器连跑两次                                   | 第二次零网络请求、零文件变更 |
| 断网构建 | Step 4 的断网环境                                | 连续两次成功                 |
| 扫描覆盖 | 扫描报告                                         | 覆盖 100%，无未处置 `high`   |

**逻辑正确性——必须手工走完的执行路径（列出每条路径的预期返回值）：**

_下载器_：① 本地不存在 → 下载 + 校验通过 + 落盘，返回成功；② 本地存在且 sha256 匹配 → **不发网络请求**，返回成功；③ 本地存在但 sha256 不匹配 → 重新下载并覆盖，返回成功；④ 下载中断 → 临时文件被清理，**不留下半成品**；⑤ 远端 sha256 与台账不符 → 失败并同时报出期望值/实际值；⑥ 目标路径被 `.gitignore` 命中 → 失败（不入库）。

_本地优先解析器_：① 命中本地副本 → 直接使用，零网络；② 本地缺失 → 指名 `资源 id + platform` 失败；③ 本地存在但版本与台账不符 → 以台账为准判定，不做"看起来是那个文件"的猜测；④ 请求了台账未登记的平台 → 显式失败。

_清理_：① 目标在 keep 白名单内 → 跳过删除并记录；② 目标不在白名单 → 正常删除；③ 清理后自检发现资源缺失 → 失败。

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
- `--node-binary` 这条既有逃生口必须继续可用——已有用户可能依赖它（判据修正后它反而更重要了：Node 不再随仓库分发，它就是"用环境自带 Node 构建 SEA"的正规入口）。
- Step 3 改插件寻址后，**联网路径必须仍然可用**：本地优先不等于只能用本地，CDN 刷新（`updateMarketplace`）这条既有能力不能被砍掉，只是降级为可选。
- 插件缓存目录的既有结构（`bundled-marketplace.json` / `cdn-marketplace.json` / 合并后的 `marketplace.json`）不得改变——已有用户的本地缓存要能平滑升级。

## Open Questions

1. ~~**托管方与单文件上限**~~ **已解决（Step 1 执行时确认）**：托管方是 **GitHub**（`git@github.com:canwhite/zcode-tui.git`），适用 100MB 单文件硬限 / 50MB 起警告。Step 1.6 已按此判定通过。
2. ~~**是否可使用 Git LFS**~~ **已不适用**：体积门在修正后的范围下是 10.8 MiB，远未触发任何硬限，LFS 不必考虑。
3. **智谱官方插件包的再分发边界（本次新增，需你确认）**：现在入库的是**智谱自家的 26 个插件包与图标**。这不是 OSS 许可问题，而是自家资产的再分发边界问题——
   - 这批包是否允许随本仓库分发？
   - 是否需要在仓库内附带来源 URL 与版本标记以便追溯？
   - 插件包随 CDN 更新时，仓库内的副本会静止在某个版本；是否需要约定刷新节奏（对应 F-007）？
4. **`.env.bak-before-vendor-migration` 中的 `BIGMODEL_API_KEY` 是否为真实凭据**、是否已轮换。若是真实凭据且未轮换，应**先轮换再谈其他**；是否重写 Git 历史是独立决策。
5. **`mise` / `pnpm` 工具链是否纳入本地化**：`mise.toml` pin 了 node 24.14.0 与 pnpm 10.33.2，首次运行需要联网拉取。它属于"包管理器自身"还是"npm 包"的豁免范围，边界未定。
6. **`pnpm build:native-search` 的离线化（本次判据下有意不解决）**：它是唯一硬依赖公网的构建步骤，但取的是第三方通用包，按判据不保留。若你希望连它也离线，等于要放宽判据——需要重新讨论，本计划不擅自处理。

## Out of Scope

- ~~**F-006 本地化插件市场**~~ **已并入本计划**：判据修正后，官方插件市场（清单 + 26 个插件包 + 图标，10.8 MiB）正是"智谱自家的远程资源"，即本次本地化的核心目标，Step 2.5 已落地、Step 3 负责接通。痛点文档原把它划为 Phase 2，是在判据错误的前提下做的划分。
- **F-007 资源刷新入口**——仍为后续（Step 3 的 Open Question 3 提到插件包会静止在某个版本，刷新节奏需要它）。
- **修复 GitHub zipball 安装路径缺 sha256 校验**（`github-archive-source.ts:79`）——扫描发现的安全问题，已在痛点文档 §8 登记为独立 Issue，本计划不含。**但它不因不在本计划而降低严重性**，建议并行处理。
- **重写 Git 历史以移除已泄露的凭据**——需独立决策，见 Open Questions 3。
- **F-007 之外的资源自动更新机制**——本次只做"显式的本地化"，不做自动刷新。
- **`harness/remote/Dockerfile` 的 `apt-get`**——只影响测试脚手架，不属交付物依赖。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

### 风险索引

| ID  | 风险                                                                             | 评分  | 级别             |
| --- | -------------------------------------------------------------------------------- | ----- | ---------------- |
| R1  | Node 版本不确定：SEA 构建用 `process.versions.node` 决定下载哪一版               | 21.25 | **HIGH**         |
| R2  | 基线不干净：本计划要改的文件正被并发修改且未提交                                 | 16    | **HIGH**         |
| R3  | 台账的差集校验口径写错，导致"所有"变成静默的假保证                               | 17    | **HIGH**         |
| R4  | 受保护根命名撞上 `apps/zcode-cli/.gitignore` 的 `vendor` 规则，资源被静默忽略    | 13.6  | **HIGH**         |
| R5  | 仓库无任何自动化门禁，数百 MB 的提交没有任何东西会拦                             | 12.8  | **HIGH**         |
| R6  | `licenses.mjs notices` 已损坏，"重新生成 notices"这条缓解路径不可用              | 19    | 极易发现，须记录 |
| R7  | ~~Node 归档未连同 SHASUMS256.txt 落盘~~                                          | —     | **已不适用**     |
| R8  | `.env.bak-before-vendor-migration` 只删文件不重写历史，凭据在 Git 历史中持续存在 | 7.5   | 中高             |
| R9  | ~~320 MiB 二进制使克隆成本成为新的开发者痛点~~                                   | —     | **已消解**       |
| R10 | 断网验收本身可能假通过或假失败                                                   | 6     | 中               |
| R11 | 扫描范围被外部解读为"整个仓库已扫过"                                             | 3.6   | 低               |
| R12 | ~~修改 SEA 缓存根会外溢到发布链路行为~~                                          | —     | **已不适用**     |

> 评分口径：`Severity(1-5) × Likelihood(1-5) × (1 - 提前发现概率)`，> 12 记为 HIGH。Detectability 按"**越难在早期发现、分值越高**"取值。

> 本次 pre-mortem 的结论**基于实测而非推断**：Node 各平台产物体积来自对 `nodejs.org` 的 HEAD 实测；`licenses.mjs` 的失败来自实际运行；`clean.mjs` 与 `.gitignore` 的范围来自读源码与 `git check-ignore`。三处被推翻的初判已在正文就地更正。

### [Risk] R1 — Node 版本不确定：SEA 构建用 `process.versions.node` 决定下载哪一版

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.15
**Risk Score**: 5 × 5 × (1 - 0.15) = 21.25 — **HIGH**

**Failure Scenario**：`build-sea.mjs:301` 是 `const nodeVersion = process.versions.node;`——**没有任何 pin**。于是"要本地化哪个版本的 Node 运行时"取决于**跑构建的那台机器上的 `node -v`**。本仓库三方声明已经互相矛盾：`.nvmrc` 写 `24`、`mise.toml` 写 `24.14.0`、`package.json` 的 `engines` 在本轮已被改成 `>=22.13.0`，而**当前 shell 实际是 v22.23.2**。结果：按 24.14.0 本地化 6 个平台的归档，换一台 Node 22 的机器构建时全部命中不了，只会静默回源 `nodejs.org`——而如果那台机器断网，就直接失败。更隐蔽的是反向情况：磁盘上残留了旧版本的缓存，缓存键**不含版本语义**，会被当成新鲜资源复用。本仓库磁盘上**根本没有 `sea-node-cache`**，说明这条路径从未被实际执行过——问题不会在开发时暴露，只会在交付现场暴露。

**Mitigation**：

> ⚠️ **本条在开始执行时已被修正**——原缓解是"把 `engines` 改为显式 pin"，但提交 `0189deb`（feat: expand node version fields）**刚刚做了相反的决定**：两个 `package.json` 的 `engines.node` 从 `24.14.0` / `>=24.0.0` 统一改为 **`>=22.13.0`**，并把 `scripts/install/toolchain.mjs` 的校验从"只比 major"升级为**逐段比较 major.minor.patch**（注释写明：`>=22.13.0` 的下限落在 minor 上，因为更低版本 `node:sqlite` 仍需 flag）。**重新 pin `engines` 会推翻这个已提交的决定，不得执行。**

- **区分两条轴，不要混淆**：`engines.node` 是**运行兼容性下限**（用户跑的 Node 可以落在 22.13+ 区间），这是 `0189deb` 有意放宽的；而**发布用的构建工具链**由 `mise.toml` 钉死为 **24.14.0**（`AGENTS.md` 明确："Node 版本以 `mise.toml` 为准"）。两者不冲突，SEA 产物嵌入的是**构建时**的 Node。
- 因此本地化的正确目标是：**发布工具链那一版（24.14.0）**，而不是"把 engines 收窄"。台账中每个 Node 归档条目绑定 `nodeVersion` 字段，标注它是为哪一版本地化的。
- **把静默回源改为显式失败**：`build-sea.mjs` 不应在"当前 Node 无对应本地归档"时静默去 `nodejs.org` 下载，而应指名报告"当前构建用 Node = X，台账中无该版本归档"。这才是 R1 的真正解——问题不是"没 pin"，而是**不匹配时无声无息**。
- **缓存键加入版本维度**，杜绝 22.x 构建误用 24.x 归档（当前缓存键不含版本语义）。
- 若将来真的用非 24.14.0 构建 SEA，必须显式登记该版本归档，否则发布步骤失败——把这条写进发布说明。
- Step 1.4 的差集校验增加一条断言：台账中的 `nodeVersion` 集合 ⊇ 发布工具链版本。

> **执行后状态（判据修正后，本条已重新判定为「不适用」）**
>
> 原文要求"把静默回源改为指名失败"。**post-mortem 复核后明确：这条缓解在本判据下不仅未做，而且是错的，不应实施**——
>
> - Node 运行时按归属方判据**不随仓库分发**，因此"本地无归档"是**设计状态**而非缺陷。让 `build:sea` 在此状态下失败，等于**打断正常的在线构建**（`pnpm build:sea` 本就需要下载 Node，与 `pnpm install` 取 npm 包同类）。
> - 原风险成立的前提是"仓库里存了一份 Node 归档，而构建可能用错版本"。仓库现在不存任何 Node 归档，该前提消失。
>
> **仍然保留、且已完成的动作**：台账中 node-\* 条目**依旧登记**（标 `prerequisite` / `vendoring: excluded`），因此"仓库会去 nodejs.org 取 Node"这件事在对账里**始终可见**（`remote-resources.mjs check` 覆盖它）。这是本条真正需要的部分——可见性，而不是阻断。
>
> **一条如实移交的残余（不属本计划范围，未处理）**：`build-sea.mjs:301` 用 `process.versions.node` 决定取哪个版本，因此用 Node 22 构建会得到一个基于 22 的 SEA 产物，而 `mise.toml` pin 的是 24.14.0。该不一致**先于本计划存在**，与本地化无关；本计划只保证它**可见**（台账登记 + doctor 报 Node 版本），不保证它被修复。

### [Risk] R2 — 基线不干净：本计划要改的文件正被并发修改且未提交

**Severity**: 4 | **Likelihood**: 5 | **Detectability**: 0.2
**Risk Score**: 4 × 5 × (1 - 0.2) = 16 — **HIGH**

**Failure Scenario**：`git status` 显示 `scripts/install/toolchain.mjs`、`apps/zcode-cli/packages/cli/src/doctor.ts`、`package.json`、`apps/zcode-cli/package.json`、`packages/provider/src/model-selection-config.ts`、`README.md`、`README.en.md` 均**已修改未提交**，且 `main` 领先 `origin/main` 两个提交。这些正是本计划的核心改动区域（`toolchain.mjs` 属安装链路、`doctor.ts` 属 F-004 的可观测输出、`package.json` 的 `engines` 就是 R1 里的版本歧义来源之一）。照计划执行会在别人的未完成工作上继续叠加，产生冲突、覆盖或被覆盖，且 Step 0 用 `git bundle` 打的"基线"里混入了他人 WIP——回滚点不可信。

**Mitigation**：

- **Step 0 增加一步：先与用户确认这些未提交改动的归属与状态**，明确是"放弃、保留、还是先提交"。在确认之前不动手。
- 不把 `git bundle` 当作回滚锚点，除非工作区已提交或已 stash。回滚锚点改为"当前 HEAD 提交 + 已确认的 WIP 处置方式"。
- 特性分支从**已提交的 HEAD** 切出，不携带他人未提交改动；实施期间与那批改动保持文件级隔离。
- 每完成一个 Step 就 `git status` 复核哪些改动是自己的，避免把并发改动误当成自己的产物提交。

### [Risk] R3 — 台账的差集校验口径写错，导致"所有"变成静默的假保证

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.15
**Risk Score**: 5 × 4 × (1 - 0.15) = 17 — **HIGH**

**Failure Scenario**：Step 1.4 的差集校验是"所有"这个诉求**唯一**的可证明手段，而它极容易写成只匹配字面量 `https://`。本仓库恰恰大量使用**非字面量**的获取方式：`sea-targets.mjs:66` 用 `new URL(artifact, base)` **拼接**出 URL；`native-search-tools-config.mjs` 的预编译产物**只有 sha256 没有下载地址**；插件链路走 `git clone` 与 registry 引用。一个只扫字面量的校验器会产出**空的差集**，报告"全部覆盖"——而这个"通过"是自我印证的，没有任何下游信号能推翻它。最终结果是仓库交付时看起来"所有远程资源都已本地化"，实际漏掉一整类，断网时才暴露。

**Mitigation**：

- 差集校验**必须由两条独立路径产出并互相对账**：一路扫源码字面量与已知 API 形态（`fetch(` / `curl` / `git clone` / `new URL(` / registry 配置），另一路**从台账反推**（逐条追问"这条的消费者在哪、消费方式是什么"）。两路都空才算过。
- 增加**反向测试**：人为在源码里插入一个未被台账登记的获取点，确认校验器会失败；再人为从台账移除一条，确认校验器同样失败。校验器若不能失败，就没有证明力。
- 明确记录**豁免边界**（npm registry、用户配置的 LLM 端点）作为白名单，并对白名单本身做人工复核——白名单是差集校验最常见的漏网口。
- 台账中"只有 sha256 没有 url"的条目（预编译产物）单独归类并标注 `source: prebuilt`，不参与"需要下载"的差集，但**参与"需要入库"的差集**。

### [Risk] R4 — 受保护根命名撞上 `apps/zcode-cli/.gitignore` 的 `vendor` 规则，资源被静默忽略

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.15
**Risk Score**: 4 × 4 × (1 - 0.15) = 13.6 — **HIGH**

**Failure Scenario**：`apps/zcode-cli/.gitignore` 最后一行是一条**裸 `vendor`** 规则（匹配 `apps/zcode-cli/` 下任意名为 `vendor` 的路径）。计划正文同时给了两个落点倾向——"建议 `third-party/vendored/`"与"对齐既有先例 `apps/zcode-cli/dependencies/native-search/`"。若实施者选了后者并在其下建 `vendor/`，或者选了任何 `apps/zcode-cli/**/vendor*` 形态，**资源会静默不入库**：`git status` 不显示被忽略的文件，本地一切正常（文件就在磁盘上、构建也能读到），只有克隆到断网机器时才全线失败。这是本计划里**最典型的"本地全绿、交付全崩"**形态。

**Mitigation**：

- Step 2.1 的落点决策**以 Step 2.3 的断言为准**，而不是以美观或先例为准：先把候选路径逐个跑 `git check-ignore`，命中即淘汰，再谈其他。
- 断言必须覆盖**全部** `.gitignore`（本仓库有 6 个：根、`.husky/_`、`apps/zcode-cli`、`browser-use-plugin`、`dynamic-workflow`、`debug`），而不是只查根目录那一个——这正是本风险能成立的直接原因。
- 断言做成**入库前自动执行**的脚本，而不是一次性人工核对；`git add` **之后**再跑一次 `git ls-files` 确认文件确实进了索引，用"是否被跟踪"而非"是否被忽略"作为最终判据。
- 在 Step 2 的验收集里增加一条：新资源路径出现在 `git ls-files` 输出中，条目数与台账一致。

### [Risk] R5 — 仓库无任何自动化门禁，数百 MB 的提交没有任何东西会拦

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.2
**Risk Score**: 4 × 4 × (1 - 0.2) = 12.8 — **HIGH**

**Failure Scenario**：实测确认本仓库**没有 CI 配置**（无 `.github/`、无 `.gitlab-ci.yml`），**husky 钩子未安装**（`.husky/` 下只有 `_`，无 `pre-commit` / `pre-push`）。`package.json` 里的 `verify:pre-push` 只是一个不会自动执行的脚本。而 `.gitignore` 里那句"入库由 `scripts/ci/ci-repo-hygiene.mjs` 在 CI 第一站拒绝"所描述的护栏**并不存在**——那个脚本本身已被删除。因此：一次把 320 MiB 二进制推进历史的操作，**不会在任何环节被拦下**，直到推送被远端拒绝（或推送成功但此后所有人被迫克隆 320 MiB）。而一旦进入历史，即使回滚也无法缩小仓库——只能重写历史。

**Mitigation**：

- **不得依赖不存在的护栏**：把 `.gitignore` 里引用 `ci-repo-hygiene.mjs` 的注释一并更正（已在痛点文档 §8 登记为 Issue）。
- 在 Step 2 落盘之后、`git commit` 之前，**人工执行一次体积检查**并记录数字：总量、单文件最大值、最大贡献者。把它写成计划里的显式步骤而非"顺带看看"。
- 提交前**先确认远端推送限制**（单文件硬限、仓库体积限），再决定是否提交——不要在推送失败后才发现。
- 考虑到无钩子，**在 Step 0 明确本计划的所有验证门都是人工执行**，不存在"忘了跑也会被拦"的兜底。每个 Step 结束时如实报告"跑了哪些门、结果如何"，不得因为"反正没 CI"而跳过。
- 若体积门判定越界，回退到 Open Questions 2（LFS）或缩减平台集合，**由用户决策**，不自行降级。

### [Risk] R6 — `licenses.mjs notices` 已损坏，"重新生成 notices"这条缓解路径不可用

**Severity**: 4 | **Likelihood**: 5 | **Detectability**: 0.05
**Risk Score**: 4 × 5 × (1 - 0.05) = 19 — 低于阈值仅因极易发现，但**必须记录**

**Failure Scenario**：实测 `node scripts/licenses.mjs notices` **以退出码 1 失败**：`Error: Stale npm notice override: victory-vendor@37.3.6`。这是**精简分支带来的既存损坏**，与本计划无关，但它会让本计划的合规缓解手段失效。此外 `third-party/copied-components.json` 声明的 16 个 `roots` 中有 **9 个已不存在**（随 `packages/ui`、`packages/web`、`packages/rpc`、`packages/desktop` 一起被删），而 `generateThirdPartyNotices` 会对每个 root 调 `stat()`——即使修掉上面那个 override，还有下一层失败在等着。后果：新增本地化资源后**无法重新生成 `THIRD-PARTY-NOTICES.md` / `third-party/inventory.json`**，而 `third-party-notices.mjs:15-18` 会校验 `noticesSha256`，一旦这个链路彻底断裂，后续任何触碰 notices 输入的操作都会失败。

**Mitigation**：

- **本计划不承诺"重新生成 notices"**：把这条不可用的缓解从计划里剔除，避免给人"合规已处理"的错觉。
- 在 Step 5 的扫描报告里**单独记录这条既存损坏**，明确它是前置问题、不是本计划引入的。
- 明确本计划的合规立场：本地化新增二进制**会增加分发义务**（Node 运行时含 V8 / OpenSSL / libuv / ICU / zlib 等组件，当前 `third-party/runtime/sources.json` 只为 Node 正文许可登记）。在 notices 链路修复之前，**本地化的资源只登记进台账、不声称合规已覆盖**。
- 修复 notices 链路（清理失效 override + 修剪 9 个不存在的 root）作为**独立前置任务**提出，是否纳入本计划由用户决定——它不在原定的 F-001~F-005 范围内。

### [Risk] R7 — ~~本地化的 Node 归档未连同 `SHASUMS256.txt` 一起落盘~~ **【已不适用】**

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.3
**Risk Score**: 4 × 4 × (1 - 0.3) = 11.2 — 中高

**Failure Scenario**：`sea-node-download.mjs:90` 在下载产物**之前**先下载 `SHASUMS256.txt` 用于校验。如果本地化只放了归档而漏了这份校验清单，断网构建会在"下载 SHASUMS"这一步失败——现象是"资源明明在本地却仍说下载失败"，极易被误判成网络封锁没生效或缓存根没配好，排查方向完全跑偏。

**Mitigation**：

- 台账中把 `SHASUMS256.txt` 作为**独立的 `RemoteResource` 条目**登记（`kind: checksum-manifest`），而不是当作归档的附属——这样 Step 1.4 的差集校验才能看见它。
- 落盘断言增加一条：每个归档条目的同级目录下存在对应版本的校验清单，且条目数与归档数一致。
- Step 4 的断网验收必须**从未填充过的干净缓存**开始，否则本地残留会掩盖这个缺口。

### [Risk] R8 — `.env.bak-before-vendor-migration` 只删文件不重写历史，凭据在 Git 历史中持续存在

**Severity**: 5 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 5 × 3 × (1 - 0.5) = 7.5 — 中高（但严重度最高，须显式决策）

**Failure Scenario**：该文件**被 Git 跟踪**且含 `BIGMODEL_API_KEY`。本计划只删工作区文件——**文件仍留在历史中**，任何能克隆仓库的人都能取出它。而计划若把它列为"已处置"，会给交付方一个错误的安全感。这是"随仓库上传"这条诉求的负面镜像：想随仓库上传的东西没上传，不想上传的东西早就在仓库里了。

**Mitigation**：

- 该条目在扫描报告中单独列为 `kind: secret-exposure`，**severity 不低于 high**，并在交付前明确"未撤销"。
- **删除文件与轮换凭据必须同时做**，且轮换优先——轮换后即使历史泄露，凭据也已失效。
- 是否重写历史是**独立决策**（会改变所有 commit hash、影响所有协作者），列为 Open Question，不在本计划内执行。
- 全局扫描同步确认是否还有其他 `*.bak` / `*.old` / 临时备份被跟踪（计划 Adjust 段已列，此处升级为**必做项**）。

### [Risk] R9 — ~~320 MiB 二进制使克隆成本成为新的开发者痛点~~ **【已消解】**

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 4 × 4 × (1 - 0.4) = 9.6 — 中高

**Failure Scenario**：实测 Node 单平台产物合计 **320.6 MiB**（win-x64 87.1 / win-arm64 76.7 / darwin-x64 49.8 / darwin-arm64 48.7 / linux-x64 29.6 / linux-arm64 28.6 MiB），对照当前 `.git` 仅 37 MiB。日常开发只需宿主平台，全量拉取纯属浪费。团队会自然形成"浅克隆 / 不拉二进制 / 单独走一次下载"的变通做法——于是**没有人再跑真正的克隆即用路径**，断网验收从"每次交付都跑"退化为"发布前补一次"，F-004 的关卡在两次交付之间事实上失效。同时 darwin 两个归档（48.7 / 49.8 MiB）已越过 50 MB 告警线，win-x64（87.1 MiB）距 100 MB 硬限仅 13 MiB。

**Mitigation**：

- 明确**"克隆即用"是交付承诺，不是开发承诺**：开发者允许只拉宿主平台，但**交付验收必须在完整克隆上执行**，且这一点写进 Step 4 的前置条件。
- 在 Step 1.5 的体积门里**同时记录单文件最大值**，而不只是总量——`win-x64/node.exe` 87.1 MiB 已经是硬限的 87%，任何一次 Node 大版本升级都可能越界。
- 把"平台集合"做成**台账里的显式可配置项**，使缩减平台（Open Questions 2 的备选之一）是一次配置变更而非代码改动——这样体积门被触发时，用户有真实可选项。
- 在 `README` 中说明仓库体积构成与"只需要宿主平台"的获取方式，把变通做法**正规化**，避免它变成不受控的隐性实践。
- 每次 Node 版本升级后重跑体积门（新增一条维护动作，写入 Step 6 的文档同步）。

> **已消解**：判据修正后 Node 与上游源码包均不本地化，实际入库体积是 **10.8 MiB**（最大单文件 5.73 MiB），与基线 `.git` 38 MiB 同量级。本风险赖以成立的前提——"每次克隆被迫拖数百 MB"——已不存在，团队也就没有理由去走"浅克隆/不拉二进制"的变通做法。上述缓解中仍值得保留的是"体积门要同时看单文件最大值"，它作为常规维护动作并入 Step 6。

### [Risk] R10 — 断网验收本身可能假通过或假失败

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 3 × 4 × (1 - 0.5) = 6 — 中

**Failure Scenario**：两个方向都会错。**假通过**：封锁不彻底（只封了 HTTP 没封 DNS、或封了但缓存/连接池还在），构建实际仍走了网络却报告"断网成功"。**假失败**：把 npm registry 一起封了，而 npm 是本计划的**豁免项**，于是验收失败但归因错误，团队去修一个不存在的问题。

**Mitigation**：

- 验收前先做**封锁有效性自检**：确认一个已知非 npm 域名确实不可达、同时 `registry.npmjs.org` 可达。两个断言都必须成立，验收才开始。
- **从未填充过的干净状态起跑**（清 `dist`、清受保护目录外的所有缓存），并记录起跑时的 `git status`——用缓存残余换来的"成功"是本风险最可能的形态。
- 验收失败时**先看日志判定失败类型**再动手修：是"根本没找到本地副本"、"找到了但校验不过"、还是"npm 被封了"。三者现象相似，日志能一次区分（与 Think 段的定位顺序一致）。

### [Risk] R11 — 扫描范围被外部解读为"整个仓库已扫过"

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 3 × 3 × (1 - 0.6) = 3.6 — 低

**Failure Scenario**：F-005 的基线是"本轮资源 + 三条已知残留"（用户选定）。但"扫过一遍"的结论一旦离开语境，容易被当成对整个仓库的安全背书——而 `scripts/`、`apps/`、`packages/` 的历史遗留脚本并不在范围内。交付方可能据此省略后续审计。

**Mitigation**：

- 扫描报告**首屏写明覆盖范围与未覆盖范围**（计划已要求"覆盖不全不得出通过结论"，此处扩展为"必须显式列出未覆盖项"）。
- 报告措辞避免"仓库已通过安全扫描"这类整体性表述，改为"以下 N 项资源与 3 项残留已完成扫描"。
- 未覆盖范围作为**已知缺口**记入 Open Questions，供后续决策是否扩大。

### [Risk] R12 — ~~修改 SEA 缓存根会外溢到发布链路行为~~ **【已不适用】**

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 4 × 3 × (1 - 0.5) = 6 — 中

**Failure Scenario**：Step 3 若改 `nodeCache` 根，会影响 `build-sea.mjs` 中所有以 `dist` 为基准的步骤（如 `stageNodeNotices(dist, ...)`、`seaAssetStagingForTarget`、`seaBlobForTarget`）。缓存位置与**产物输出位置**是两件事，改错会表现为产物缺失或 LICENSE 未随包分发——而 SEA 产物本就未被本仓库实际构建过（磁盘无 `sea-node-cache`），任何错误都不会在开发时显现。

**Mitigation**：

- 严格区分"缓存根"与"产物输出根"：只改**下载与解析的寻址**，不动 `dist` 下的产物写出路径。优先选 Step 3 的 (b) 播种方案，它对本风险的暴露面最小。
- 改动后**实际执行一次 `pnpm build:sea`（至少宿主平台）**，确认产物生成且 LICENSE 随包分发——这是本计划中少数必须真跑发布链路的地方，不能只靠类型检查。
- 改动前 grep 确认没有其他消费方按字面路径引用 `dist/sea-node-cache`（计划 Adjust 段已列，此处确认为**必做前置检查**）。

---

### Pre-mortem 结论

**5 个 HIGH RISK**（R1 Node 版本不确定 21.25 / R2 并发未提交改动 16 / R3 差集校验假通过 17 / R4 vendor 命名静默忽略 13.6 / R5 无自动化门禁 12.8），以及 7 个中低风险，**全部附有缓解措施**。

最需要在动手前处理的三个：

1. **R1（Node 版本）**——它决定 Step 2.5 下载的东西是否正确。**必须在任何下载之前**解决，否则可能整批白做（已写入 Step 1.5 作为阻断项）。
2. **R2（并发改动）**——`toolchain.mjs` 与 `doctor.ts` 正是本计划要改的文件，且未提交。先与用户确认归属，再决定从哪一点切分支（已写入 Step 0.2 作为阻断项）。
3. **R3（差集校验）**——它是"所有"唯一的证明手段，一旦写错会给出静默的假保证，且没有任何下游信号能推翻它（已写入 Step 1.4，含反向测试要求）。

另外两条**改变了计划的既定内容**（已就地更正，不再作为待办）：

- `.gitignore` 的护栏并不存在（无 CI、无钩子），"会被 CI 拦住"的假设必须删除。
- `licenses.mjs notices` 已损坏，"重新生成 notices"这条缓解不可用，计划不得声称合规已覆盖。

---

## Post-Mortem（对照实现复核）

> 目标：**验证到没有 HIGH RISK 为止**。方法是审计自己的实现、对每个可疑点先复现再修，而不是只读代码。

### 已修复的缺陷

#### [BUG-1] `doctor` 把第三方来源插件算作"本地副本缺失"，且修复建议无效

**位置**：`apps/zcode-cli/packages/cli/src/doctor.ts` · **级别**：High
**复现**：向官方清单注入一个 GitHub 来源插件 →
`FAIL 官方插件本地化: 覆盖率 96%（26/27）；缺失：community-thing`，`doctor` 退出 1。
**为什么是错的**：官方市场 schema 允许条目指向第三方来源，而按本仓库判据第三方包**本就不本地化**。更严重的是 `install.mjs` 把 doctor 的退出码作为 `make install` 的结果透传——于是**安装会坏在一个永远修不好的报错上**，而提示的修复命令（`vendor-resources fetch`）对这个插件根本不适用。
**修复**：分母只取智谱自家 CDN 来源（`isZhipuOfficialAssetUrl`），第三方条目单列说明。
**验证**：注入案例 → PASS 并注明"另有 1 个第三方来源插件按判据不本地化"；删掉一个真·智谱插件 → 仍 FAIL。

#### [BUG-2] URL→路径映射不自证其契约，安全性依赖调用方再查一次

**位置**：`adapters/src/plugins/official-vendored-assets.ts` · **级别**：Medium
**复现**：`officialAssetRelativePath()` 对 `%2e%2e/%2e%2e/etc/passwd` 与 `..\..\etc\passwd` **原样返回**，只有调用方的二次 `relative()` 检查才拦住。
**为什么是错的**：函数名叫"相对路径"，却会返回带穿越语义的字符串；今天没出事是因为唯一的消费方额外查了一次——这是单层防御，对后来者是个陷阱。
**修复**：映射函数自身拒绝含 `..`、`\`、`%` 的段。
**验证**：6 个恶意输入全部 `undefined`，3 个正常输入（清单/插件包/图标）仍通过。

#### [BUG-3] `verify` / `assert` 作用域变空，却报告"✓ 0 条全部匹配"

**位置**：`scripts/vendor-resources.mjs` · **级别**：High
**复现**：Step 2.6 把 52 条回填成 `status: "ready"` 后，`verify` 打印 **`✓ 0 条本地副本全部存在且 sha256 匹配`** 并返回 0——**一个都没查**。
**为什么是错的**：`vendorable()` 带 `status !== "ready"`，而 verify/assert 要问的是"本地副本现在对不对"，与台账记账无关。**连带后果**：`test/offline-acceptance.mjs` 的 A6 断言在这个空转的 verify 上，因此 A6 一直是**假通过**，却打印"台账 52 条本地副本齐全"。
**修复**：拆成 `vendored()`（verify/assert/status 用，全部已本地化条目）与 `fetchable()`（fetch 用）；再加 `assertNonEmpty()`——作用域为空直接失败。
**验证**：`verify` 现在报 **52 条**；A6 名副其实。

#### [BUG-4] `fetch` 无法修复被删的本地副本，而 `verify` 恰恰让你去跑 `fetch`

**位置**：`scripts/vendor-resources.mjs` · **级别**：High
**复现**：删掉一个插件包 → `verify` 正确报出缺失并提示"修复：node scripts/vendor-resources.mjs fetch" → **`fetch` 什么都不做并退出 1**。修复路径是死循环。
**为什么是错的**：`fetch` 按台账的 `status` 过滤，而 `status` 是**入库当时的记账快照，不是文件系统的事实**。副本被删后它仍是 `ready`，于是 fetch 认为无事可做。
**修复**：`fetchable()` 不再按 status 过滤；幂等由循环内的 `localState()` 磁盘检查负责（那才是事实来源）。
**验证**：删文件 → `新取 1 ／ 跳过 51` 并恢复；再跑一次 → `新取 0 ／ 跳过 52`（仍然幂等，不发请求）。

#### [BUG-5] `check` 在"一个文件都没扫到"时报告"✓ 对账通过"

**位置**：`scripts/remote-resources.mjs` · **级别**：High
**复现**：把扫描根指向不存在的目录并清空 `dynamicSites` 声明 → `✓ 对账通过：台账与源码获取点一致`，退出 0，**实际扫描文件数为 0**。
**为什么是错的**：`unexplained` 在空集上恒为空，"差集为空"于是恒真。这是本项目的**主对账门**，它一旦能空转，Pre-Mortem R3 想防的"自我印证的假保证"就真的发生了。
**修复**：`scanFetchSites` 返回实际读取的文件数；`check` 对"覆盖为零"与"获取点为零"各自硬失败。
**验证**：正常态打印 `扫描文件数：1723`、退出 0；破坏态退出 1。

#### [BUG-6] 扫描器未断言解包完整性

**位置**：`test/vendor-scan.mjs` · **级别**：Medium
**修复**：解包数必须等于磁盘上 `plugin.zip` 的实际数量（动态计数，不硬编码 26）；包内含加密载荷却一个都没解开时同样失败。
**验证**：正常 26/26 通过；人为制造 25/26 → `解包不完整：25/26`，退出 1。

#### [BUG-7] 断网验收在有网/无网两种环境下都会误判

**位置**：`test/offline-acceptance.mjs` · **级别**：Medium
**问题**：A2 断言"npm 可达"，因此在**真离线环境**（恰恰是本验收想覆盖的场景）必然失败，验收无法在目标环境运行。
**修复**：npm 不可达时记 warn 并继续——A2 问的是"本机能否到 npm"，而非"我们的封锁有没有误伤 npm"，两者不同。
**验证**：正常 → ok；模拟离线 → `warn A2 跳过`，其余断言照常，验收通过。

#### [BUG-8] `fetch --only` 的退出码混淆了两件事

**位置**：`scripts/vendor-resources.mjs` · **级别**：Low
**修复**：verify 支持传入子集；`--only` 时只校验该子集。

#### [BUG-9] 计划的 Pre-Mortem 风险条目与实现不一致（spec vs implementation）

**位置**：`docs/plan-offline-vendoring.md` · **级别**：High（文档层面）
**问题**：R1 的缓解写着"**仍然必须做**"，而我从未实现；R7 / R12 在判据变更后已不适用，却仍以"中高/中"风险列在册。
**复核结论**：R1 的第三条缓解在本判据下**不仅是未做，而且是错的**——Node 不随仓库分发，"本地无归档"是设计状态，让 `build:sea` 在此失败会打断正常在线构建。已改为显式标记"不适用"并写明理由，同时**如实移交残余**：`build-sea.mjs:301` 用 `process.versions.node` 选版本，与 `mise.toml` 的 pin 可能不一致——该问题**先于本计划存在**，本计划只保证它可见，不保证它被修复。R7 / R12 同样标记"已不适用"并保留原始缓解供将来参考。

### 根因分析

**根因一（主导，4 次复发）：判据式校验器把"没有可查的"当成"查过了没问题"。**
同一形态出现在：扫描器扫到 0 个文件、`verify` 作用域为 0、`check` 扫描 0 个文件、`fetch` 作用域为 0。它们都**返回成功**，且都打印了一个看起来正常的数字（`0 条全部匹配`、`无异常主机`、`对账通过`）。

> **可复用的判据**：任何形如"遍历 X 检查 Y，全部通过则成功"的校验器，都必须先断言 `X` 非空。空集上的全称命题恒真，这不是"没问题"，是"没查"。

**根因二：把记账字段当成事实来源。**
BUG-3 与 BUG-4 同源——`status: "ready"` 被当成"文件在磁盘上"。它是入库当时的快照。**事实来源应当是文件系统，记账字段只用于报告历史。**

**根因三：分母取错。**
BUG-1 用了"清单里所有插件"而不是"按判据需要本地化的插件"；BUG-2 的映射函数把契约的完整性寄托在调用方。

### 预防任务

| 任务                                                   | 类型 | 根因 | 验收标准                                                               |
| ------------------------------------------------------ | ---- | ---- | ---------------------------------------------------------------------- |
| 为所有校验器加"作用域非空"断言，并在仓库约定里写明     | AFK  | 一   | 每个 `check/verify/assert/scan` 入口在作用域为空时退出非零；带回归用例 |
| 把三条"空转必须失败"的回归用例固化成脚本               | AFK  | 一   | 一键可跑；人为制造空覆盖时全部失败                                     |
| 评估是否从台账移除 `status` 字段                       | HITL | 二   | 明确它是否还有消费方；若无可删，避免再次被误用为决策输入               |
| 复核 `build-sea` 的 Node 版本与 `mise.toml` pin 不一致 | HITL | 三   | 决定是收敛版本来源，还是接受并记录                                     |

### 结论

**BUG-1 / BUG-3 / BUG-4 / BUG-5 均为 High，且全部已修复并双向验证**（构造失败用例 → 修复 → 用例转绿 → 回归用例仍红）。
**代码层面已无未处置的 HIGH RISK。**

唯一仍开放的高危项是仓库既存的 **`.env.bak-before-vendor-migration` 凭据**（被 Git 跟踪），它**需要你行动**（轮换凭据 + 决定是否重写历史），我无法代为处理——这条自始至终都在报告里，未因本次复核而降低级别，也未因与本地化无关而被忽略。
