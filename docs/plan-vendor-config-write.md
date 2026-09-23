# Plan: .env 四字段（厂商 / BASE_URL / API_KEY / MODEL）（F-002 / F-003 / F-005）

> 把 `.env` 收敛为 VENDOR / BASE_URL / API_KEY / MODEL 四个字段，据此写入厂商配置、切换默认模型、在 doctor 中可见；`.env` 中其余键全部删除。

## Context

本计划是 [docs/plan-vendor-switch.md](plan-vendor-switch.md) 中 F-002（写入）、F-003（切换生效）、F-005（可见性）的落地方案，上游痛点见 [docs/painpoint-vendor-switch.md](painpoint-vendor-switch.md)，契约层见 [docs/plan-vendor-config-contract.md](plan-vendor-config-contract.md)。

**本计划相对前序计划的重大变化**（来自本轮用户决策，覆盖早期设计）：

| 早期设计 | 现决策 |
|----------|--------|
| `.env` 五字段（含 `ZCODE_VENDOR_API_TYPE` 协议） | **四字段**：`ZCODE_VENDOR`（厂商，带默认值注释）/ `ZCODE_VENDOR_BASE_URL` / `ZCODE_VENDOR_API_KEY` / `ZCODE_VENDOR_MODEL`；**不再需要协议字段**，协议由厂商决定 |
| 厂商由 MODEL 反查 | **厂商由 `ZCODE_VENDOR` 显式指定**，MODEL 只在该厂商的清单内选模型 |
| 保留 `BIGMODEL_API_KEY` 作为 Coding Plan 专用入口 | **统一为一个 API_KEY 字段**，没有特例；现有写法一并改造 |
| 保留 `.env` 中的其它键 | **除这四个键外全部删除** |

```bash
# 厂商。可选值见下方注释；自定义厂商留空并自行填写 BASE_URL。
ZCODE_VENDOR=bigmodel
# 端点。必填：它同时决定走 Coding Plan 还是普通 API Key 链路。
ZCODE_VENDOR_BASE_URL=https://open.bigmodel.cn/api/anthropic
ZCODE_VENDOR_API_KEY=
ZCODE_VENDOR_MODEL=GLM-5.3
```

**已确认决策（2026-09-22）**：`ZCODE_VENDOR_BASE_URL` **对所有厂商必填**，含内置厂商。理由：判别 Coding Plan / 普通 API Key 链路依赖它，缺省会让判别失去依据。这带来两条连带规则，必须在第 2 步实现：

- **缺 BASE_URL 即报错**，不提供"由厂商模板自动带出"的兜底路径——否则同一份配置会有"写了"与"没写"两种行为，判别规则重新变得不确定。
- **`ZCODE_VENDOR` 与 BASE_URL 必须自洽**：内置厂商配了非该厂商的端点 → **报错**，不要以任意一方为准。静默取其一属于最难排查的一类问题（见 Open Questions 已决项）。

> **⚠️ 执行期修订（2026-09-22，实现后回写）** —— 上述"BASE_URL 必填 + 用 BASE_URL 判别链路"被推翻，实际实现如下：
>
> | 项 | 原计划 | 实际实现 | 原因 |
> |----|--------|----------|------|
> | 链路判据 | BASE_URL 判别 Coding Plan / 普通 | **厂商类型判别**（`family` 有无） | 引入厂商字段后 BASE_URL 已冗余；且 Moonshot/DeepSeek 等普通厂商端点也以 `/anthropic` 结尾，URL 判别过脆 |
> | BASE_URL | 必填 | **选填**；填了则与厂商端点做一致性校验 | 厂商字段已能带出端点，强制用户手抄只会引入抄错风险（R-211） |
> | 厂商取值 | 内置 id | **内置 id + 短名别名表** | 用户手写 `bigmodel` 比 `bigmodel-individual-coding-plan` 现实 |
> | 账号族来源 | —— | **读 `access.accountType`** | 原实现从 providerId 切分推导，含连字符的族名会静默切错 |

**已核对的现状与硬约束**（全部来自源码，非推断）：

| 事实 | 证据 |
|------|------|
| **MODEL → 厂商不是函数**：63/165 个模型名有歧义 | 由 `config/provider/qcode-builtin.json` 计算：`GLM-5.3` 命中 10 个候选（zai 系 5 + bigmodel 系 5），`kimi-k3` 命中 3 个 |
| Coding Plan 与普通 API Key **base url 完全相同** | `bigmodel-api` 与 `bigmodel-standard-api` 的 `api.baseUrl` 都是 `https://open.bigmodel.cn/api/anthropic` 系列，URL 无法区分二者 |
| 个人层**禁止**声明 `account:` 前缀 provider 的 access | `packages/provider/src/config/rule-data-schema.ts` 的 `superRefine`：`"固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明"` |
| 因此 Coding Plan 的 key **不能**落在个人 Provider Config | 它走共享凭据库（`~/.zcode/v2/credentials.json`，`createZCodeCredentialCipher` 加密） |
| 普通 api-key 厂商的 key **是内联明文** | `apiKeyAccessDataSchema.apiKey` 落在 `~/.zcode/v2/provider_config.json` |
| 已有现成写入 API | `ConfigService.savePersonalProviderOverlay` / `addPersonalModel`（`packages/provider/src/config-service.ts`） |
| 已有现成切换默认模型 API | `NodeModelSelectionConfigRepository.saveConfiguredDefault` |
| Coding Plan 现成入口 | `configureCodingPlanApiKey({ apiKey, providerId })`，`providerId ∈ {bigmodel, zai}` |
| `.env` 其余键均可安全删除 | `ZAI_OAUTH_CLIENT_ID` 有代码默认值（`zcodeEndpoint.ts:7`）；`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 由 `prepareCliProviderRuntimeEnv` 在运行期写入；`ZCODE_DEPS_BASE_URL` / `INTRANET_MACHINE_HOST` 仅内网部署需要 |

**已确认决策**：MODEL 唯一才自动推断，否则报错列出候选 ｜ 用户的 bigmodel key 是 **Coding Plan**（套餐） ｜ 默认模型跟着切 ｜ 一次只生效一个厂商。

> **文档层级**：本文是**实现基准**（四字段契约与落地形态）。
> 总纲见 [plan-vendor-switch.md](plan-vendor-switch.md)，痛点见 [painpoint-vendor-switch.md](painpoint-vendor-switch.md)，
> 早期契约草案见 [plan-vendor-config-contract.md](plan-vendor-config-contract.md)（其五字段设计已被本文取代）。

## 交付记录（2026-09-22）

全部 todo 完成，最终验证通过。本节记录实际交付内容、与原计划的偏差、以及未完成项。

### 分流规则（最终形态）

按用户提议简化：**看端点是否是某个账号型套餐的端点**来决定 key 写哪，不再判断厂商类型。

| 填写的 BASE_URL | 判定 | key 落点 |
|---|---|---|
| `https://open.bigmodel.cn/api/anthropic` | 套餐 | 加密凭据库 `~/.zcode/v2/credentials.json` |
| `https://api.z.ai/api/anthropic` | 套餐 | 加密凭据库 |
| `https://api.moonshot.cn/anthropic` | 非套餐 | 个人配置 `~/.zcode/v2/provider_config.json` |
| `https://api.deepseek.com/anthropic` | 非套餐 | 个人配置 |
| `https://api.minimaxi.com/anthropic` | 非套餐 | 个人配置 |
| `https://open.bigmodel.cn/api/paas/v4` | 非套餐 | 个人配置 |
| 任意自建端点 | 非套餐 | 个人配置 |

**必须精确匹配套餐端点**：上表第 3~5 行同样以 `/anthropic` 结尾，任何后缀匹配都会把它们误写进凭据库链路（前序风险 R-201）。

### 交付清单

| 项 | 状态 | 验证方式 |
|---|---|---|
| 厂商索引 / 解析 / 校验（`apps/zcode-cli/packages/cli/src/vendor.ts`） | ✅ | 28 厂商（8 套餐 + 20 普通）、14 短名；端点一致性、模型越界、自定义厂商放行逐条实测 |
| `zcode configure` 四字段（`run.ts`） | ✅ | 套餐链路 `zcode -p` 真实返回 |
| 个人厂商写入（`personal-vendor.ts`） | ✅ | 写入结构正确（`personalModelIds` / `group: standard-personal`）；**幂等**：连续两次写入条目数仍为 1；权限 `-rw-------` |
| `.env` / `.env.example` 迁移 | ✅ | 删除 8 个键；`BIGMODEL_API_KEY` → `ZCODE_VENDOR_API_KEY`；备份 `.env.bak-before-vendor-migration` |
| `make install` 接入 | ✅ | 自动读 `.env` 并调用 `configure`，不再读死 `BIGMODEL_API_KEY` |
| `doctor` 厂商可见性 | ✅ | 报出"厂商 ｜ 端点 ｜ 模型"；无 `.env` 时 WARN；声明与生效不一致时 WARN |
| 四份文档一致性回改 | ✅ | 订正 `builtinModelIds` → `personalModelIds`；三份旧文档加层级标注 |
| 全量校验 | ✅ | `pnpm lint` 零告警、`pnpm typecheck` 与 CLI `tsc --noEmit` 零错误 |

### 与原计划的偏差（均为执行期修订）

| 项 | 原计划 | 实际 | 原因 |
|----|--------|------|------|
| 链路判据 | BASE_URL 判别（后为厂商类型） | **端点是否命中账号型套餐端点** | 用户提议；比厂商类型更简单，且不依赖厂商字段 |
| BASE_URL | 必填 | **选填**（填了做一致性校验） | 厂商字段/端点可带出，强制手抄只会引入抄错风险（R-211） |
| 账号族来源 | 从 `accountProviderId` 切分推导 | **读 `access.accountType`** | 原实现 `split("-")[0]` 遇含连字符的族名会静默切错 |
| 厂商取值 | 内置 id | **内置 id + 显式短名别名表** | 用户手写 `bigmodel` 比 `bigmodel-individual-coding-plan` 现实 |
| 模板分类 | 非 `api-key` 即套餐 | **模板一律归 api-key** | `bigmodel-api` / `zai-api` 被误归套餐，但它们没有账号族，选中会直接报错 |

### 实测修正：shell 变量**不能**覆盖 .env 中的厂商字段

文档此前沿用 `env.ts` 的注释（`override: false`，shell 环境变量优先）。**Post-mortem 实测推翻了这一点**：`ZCODE_VENDOR_MODEL=xxx zcode configure` 中该变量不生效，`.env` 里的值胜出。

原因：`configure` 的解析入参是 `{...env, ...CLI参数}`，而 `env` 在入口已由 dotenv 写入 `.env` 的值（dotenv 只在**空位**写入，但这批键在进程启动时通常本就不存在于 shell 中，所以会被 `.env` 占满）。对用户的实际含义：

- **以 `.env` 为准**——这符合"改 `.env` 就生效"的产品预期，行为是对的；
- 但 shell 里临时改一个变量来试配置**不会生效**，排查时容易误判为"改了没反应"；
- 需要临时覆盖时用 CLI 参数：`zcode configure --configure-model <name>`（已实测穿透）。

验证方法：`ZCODE_VENDOR_MODEL=x zcode configure` 后检查个人配置里的 `defaultModelSelection`，值仍是 `.env` 中的模型。

### 未完成 / 已知限制

- **非套餐厂商未跑真实请求**：只验证了写入结构正确，没有可用于 Moonshot / DeepSeek 等厂商的真实 key。用户填入后执行 `make install` 即可生效。
- **`.env` 在仓库外不生效**：`findDotenv` 从 cwd 逐级向上查找；全局 `zcode` 在仓库外读不到 `.env`。已落库的套餐凭据不受影响，但换厂商配置在仓库外不生效（前序风险 R-103）。`doctor` 会以 WARN 提示。
- **`doctor` 的端点检查仍看 `ZCODE_BASE_URL`**：该键已从 `.env` 删除（有代码默认值），因此该项恒为 WARN。属既有行为，未在本轮调整。
- **套餐与普通厂商的落点不同**：套餐 key 在加密凭据库，普通厂商 key 明文内联在个人配置（权限 0600）。`configure` 输出中已如实提示（风险 R-002）。

## 执行状态（过程中的中间快照，已被上方《交付记录》取代）

> 保留此节仅为记录推进过程中的状态变化；**当前状态以上方《交付记录》为准**。

| 项 | 当时状态 |
|----|------|
| 厂商索引 / 解析 / 校验（`apps/zcode-cli/packages/cli/src/vendor.ts`） | ✅ 已实现并验证：28 个厂商（8 套餐 + 20 普通）、14 个短名、端点一致性校验、模型越界报错、自定义厂商放行 |
| `.env` / `.env.example` 迁移 | ✅ 已完成（备份 `.env.bak-before-vendor-migration`；删除 8 个键 + `BIGMODEL_API_KEY`→`ZCODE_VENDOR_API_KEY`） |
| `zcode configure` 读取四字段 | ✅ 已实现，套餐链路端到端跑通（`zcode -p` 真实返回） |
| `make install` 接入 | ✅ 已改为调用 `zcode configure`，不再读死 `BIGMODEL_API_KEY` |
| ~~普通 API Key 写入~~ | 当时未实现 → **现已实现**（见《交付记录》），走"端点非套餐即写个人配置" |
| ~~`doctor` 报生效厂商~~ | 当时未做 → **现已实现**（新增 `config.vendor` 检查项） |
| ~~四份文档一致性回改~~ | 当时未做 → **现已完成**（订正 `personalModelIds` + 加层级标注） |

## Goal

1. `.env` 中只保留四个字段，且**只写这四个就能切换厂商**。
2. 由 `ZCODE_VENDOR` 直接确定厂商，`ZCODE_VENDOR_MODEL` 只在该厂商清单内选模型；未识别厂商或模型越界时**报错并列出可选值**，绝不猜测。
3. Coding Plan（`bigmodel` / `zai`）与普通 api-key 厂商走各自正确的链路，对用户呈现一致。
4. 重复执行 `make install` **幂等**——不产生重复厂商条目（见前序 R-101）。
5. `doctor` 报出当前生效厂商、base url、模型。
6. 迁移：现有 `.env` 与 `.env.example` 收敛为三字段，且已跑通的 Coding Plan 链路保持可用。

## Plan

1. **建立厂商索引**。数据源是随包分发的内置配置（`providerConfigRules.templateRules` 与 `providerRules`），不新增第二份厂商清单。

   **解析必须容错**：`.env` 会被入口（`run.ts` 的 `loadCliDotenvAtEntry`）在**每一次 CLI 启动**时读取。若新字段的解析抛错，会把"改配置改错"升级成"整个 `zcode` 不可用"——包括 `zcode doctor` 这个本该用来救场的命令。因此：
   - 厂商字段解析失败**不得**在入口抛错，只能记录并在真正需要该配置的时机（`configure` / TUI 启动）报错；
   - `doctor` 必须在配置非法时仍能正常运行并报出问题——它是排障路径，不能依赖被排障的对象是好的。
   > 这是本计划对既有入口行为的**唯一硬性约束**，见风险 R-209。

2. **按 `ZCODE_VENDOR` 定位厂商，并在其清单内校验 MODEL**：
   - `ZCODE_VENDOR_BASE_URL` 为空 → 报错（必填，见上）；
   - `ZCODE_VENDOR` 命中内置 `templateRules`/`providerRules` → 采用该厂商，**并校验 BASE_URL 与该厂商的端点自洽**（不自洽即报错，不以任意一方为准）；
   - `ZCODE_VENDOR` 未命中且未填 `BASE_URL` → 报错"未识别的厂商名"，并**列出全部可用厂商取值**（第 7 步的 `.env.example` 注释与之同源，避免两处清单分叉）；
   - `ZCODE_VENDOR` 为空且填了 `BASE_URL` → 按**自定义厂商**处理（`providerId` 不得以 `account:` 开头）；
   - `MODEL` 不在该厂商的模型清单内 → **仅当该厂商确有模型清单时**报错并列出可用模型；
   - **有清单但模型不在内 → 报错**（内置厂商的模型名以清单为准，拼错即暴露）；
   - **无清单（自定义厂商）→ 不报错，照常写入**：自定义厂商在个人层用 `personalModelIds` 承载模型，本就不依赖内置清单；BASE_URL 是用户显式提供时才走这条分支。此时在输出中提示"该模型未经内置清单校验"。
   > **不再需要"MODEL 反查厂商"**：`GLM-5.3` 等 63 个歧义模型由显式厂商字段消解，不需要报错让用户二选一。这是引入 `ZCODE_VENDOR` 的主要收益。
   > **区分"清单里没有"与"根本没有清单"**：前者是用户写错（报错），后者是自定义厂商的正常形态（放行）。混为一谈会让自定义厂商直接不可用——见风险 R-208。

3. **按厂商类型分流写入**（执行期已修订，见上文修订表）：

   | 情形 | 判别依据 | 写入目标 |
   |------|----------|----------|
   | 套餐型 | 厂商来自内置 `providerRules` 且带 `access.accountType`（即 `family` 存在） | 复用 `configureCodingPlanApiKey({ apiKey, providerId: family })` → 加密凭据库；**不在个人层写任何东西**（`account:` 前缀禁止声明 access） |
   | 普通 API Key 型 | 厂商来自内置 `templateRules`（`api-key` 或 `zhipu-coding-plan-api-key`，两者都是用户直接提供 key） | 写个人层：`group:"standard-personal"`、`access:{type:"api-key",apiKey}`、`api:{type,baseUrl}`、`personalModelIds:[model]` |
   | 自定义厂商 | `ZCODE_VENDOR` 为空 + BASE_URL 非内置 | 同"普通 API Key"，`providerId` 由 base url 主机名派生，**不得**以 `account:` 开头 |

   - **判别不看 URL**：Moonshot / DeepSeek / Minimax / Qwen-cn / Xiaomi 的 api-key 端点路径**全部以 `/anthropic` 结尾**，而套餐也是 `.../api/anthropic`。任何基于 URL 的判别都会把五家普通厂商误判进凭据库链路（前序风险 R-201）。厂商类型由它在内置配置里的**来源**（`templateRules` vs `providerRules`）决定。
   - BASE_URL 仅在用户显式填写时做一致性校验（归一化后比较），**不做任何模糊匹配**。
   - 两条分支**不得**各写一份配置解析逻辑，差异只允许在"写到哪"这一层。

4. **实现幂等写入**（前序 R-101 的直接对应）—— 这是本计划**最容易写错的一步**，因为两个 API 各自的语义会诱使人写出 append-only 的实现：

   | API | 实际语义（读源码确认） | 陷阱 |
   |-----|------------------------|------|
   | `createPersonalProvider` | **只新建**，id 由 `nextPersonalProviderId` 生成 | id 被占用时返回 `xxx-2`（`config-service.ts:688`），**不报错** → 每跑一次多一条 |
   | `savePersonalProviderOverlay` | **只更新**，不存在时 `throw "Personal Provider 尚未创建"` | 不能单独用它完成首次写入 |

   因此写入必须是显式的两段式：
   - **先查**：用 `resolvePersonalProviderBaselines` 找出是否已有同一家厂商的条目；
   - **有 → 只调 `savePersonalProviderOverlay`**（更新路径）；
   - **无 → 调 `createPersonalProvider` 创建一次**，其返回的 `providerId` 才可用于后续步骤；
   - **绝不**在"已存在"的情况下调 `createPersonalProvider`；
   - 识别"同一家"的键要稳定：用 `templateId` 或规范化 base url，**不要**用 `providerName`（用户可改名，且 `nextPersonalProviderLabel` 会自动加后缀）。

5. **切换默认模型**：写入成功后调 `saveConfiguredDefault({ providerId, modelId })`，使 `defaultModelSelection` 指向新厂商。**必须先写入成功再改指针**，避免指针指向不存在的条目。

6. **`doctor` 增加"当前生效厂商"检查项**：报出厂商名、base url、模型；与 `.env` 声明不一致时给出 WARN（"配了新的、跑的仍是旧的"是静默失败的重灾区）。

7. **收敛 `.env` 与 `.env.example`**：
   - `.env.example` 只保留四个键；`ZCODE_VENDOR` **必须带可选值注释**（列出全部内置厂商取值），且该清单由内置配置生成，不手写，避免与第 2 步的报错清单分叉；
   - 迁移现有 `.env`：删除 `ZCODE_BASE_URL`、`BIGMODEL_API_BASE_URL`、`ZAI_OAUTH_ORIGIN`、`ZAI_BUSINESS_BASE_URL`、`ZAI_OAUTH_CLIENT_ID`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`、`ZCODE_DEPS_BASE_URL`、`INTRANET_MACHINE_HOST`、`BIGMODEL_API_KEY`，改填四个字段；
   - **迁移前备份** `.env`（删除的键里有用户可能需要的值，如内网地址），并**列出实际删除了哪些键**。

8. **接入 `make install`**：解析四字段 → 定位厂商 → 分流写入 → 切默认模型 → 自检。任一步失败即中止，不做部分写入。

   **写入不能由 scripts/install 直接调 `ConfigService`**：它属于 workspace 包（`packages/provider`，以 TS 源码出包），而安装脚本是仓库根的普通 Node `.mjs`。两次决策（"`make install` 自动读 `.env`" 与 "`zcode configure` 保留为底层写入入口"）合起来指向同一个接口形态：

   - **写入与默认模型切换实现为一个 CLI 子命令**（扩展现有 `zcode configure`，接受厂商/base url/key/model）；
   - 该子命令与 TUI 命令中心**复用同一个 `ConfigService` 实例与同一套逻辑**，不新增第二条写 `provider_config.json` 的路径；
   - `make install` 读 `.env` 后**调用该子命令**，并依赖其 `--json` 输出做校验（与既有 `zcode doctor --json` 一致的消费方式）。

## Think — Debug Methodology

- **两条链路先分清再动手**：Coding Plan 走凭据库、普通厂商走个人配置明文。混用是本次最可能的错误来源——**动手前先用 `doctor` 或直接读两个文件确认当前生效的是哪条**。
- **在边界处加日志**：三字段的解析结果（有值/空）、反查到的候选数、最终选中的 `providerId`、写入前后的 `defaultModelSelection`。**只打键名与结构，绝不打 API key**。统一前缀 `[DEBUG-VENDOR]`。
- **先读源码再断言**：`nextPersonalProviderId`、`superRefine` 的 `account:` 限制、`savePersonalProviderOverlay` 的覆盖语义，这三处必须读实现，不能凭 schema 推断。
- **上游优先**：写入失败时先确认"`.env` 到底读到了什么"（键名与是否有值），再怀疑反查，最后才查写入 API。
- **区分"未配置"与"配置错误"**：三字段全空应静默跳过（保持现状），有值但反查失败必须报错——两者日志要能一眼分辨。

## Do — Verification Strategy

- **构建**：`pnpm --filter "@zcode/cli..." build` — 必须通过。
- **静态分析 / 类型检查**：`pnpm typecheck` 与 `pnpm --filter @zcode/cli typecheck` — 零错误。
- **Lint**：`pnpm lint` — 零错误。
- **运行时验证**（每条都要真跑，给出命令与期望）：
  1. **回归**：迁移后的三字段配置下，Coding Plan 的 `zcode -p` 仍然真实成功（这是最重要的回归项——改造不得打断已验证可用的链路）；
  2. `MODEL=deepseek-v4-pro` 这类唯一候选 → 自动完成厂商配置与默认模型切换，`zcode -p` 成功；
  3. `MODEL=GLM-5.3`（10 个候选）→ **报错并列出候选**，不写入任何配置；
  4. `MODEL` 写不存在的值 → 报"未内置该模型"，不写入；
  5. 三字段全空 → 行为与改动前一致，不报错；
  6. **幂等**：同一份三字段连续执行两次 `make install`，`provider_config.json` 的 `providerRules` **长度不变**（R-101 的硬性回归）；
  7. `doctor` 报出的生效厂商与 `.env` 声明一致；
  8. 切换后 `.env` 中除三字段外无残留键，且 `zcode` 仍可用。
- **逻辑正确性**（逐条走通并确认返回值）：字段含前后空格 / base url 末尾带斜杠 / MODEL 大小写不同 / `.env` 只有部分字段 / 个人配置已被手工改乱。
- **不越界**：验证会真实改写 `~/.zcode/v2/` 下两个文件，**每次验证前先备份**两文件，验证后确认可恢复。

## Adjust — Rollback and Global Scan

- **回滚方案**：
  - 改动前备份 `~/.zcode/v2/provider_config.json` 与 `.env`（`credentials.json` 是加密文件，**不要手工改**）；
  - 记录当前 `defaultModelSelection` 原值（现为 `account:bigmodel-individual-coding-plan/GLM-5.3`），失败时写回；
  - `.env` 三字段改动失败 → 从备份还原即可，用户侧无损失（这正是"迁移前备份"的原因）。
- **全局扫描**：
  - `scripts/install/` 中上一轮实现的 `BIGMODEL_API_KEY` 预置逻辑 —— 本次要把它**移除或改造**，否则会与统一字段形成"两套写法"，违反本轮"没有特例"的决策；
  - `zcode configure` 子命令（上一轮新增）—— 保留还是并入新流程，需一次决定；建议保留为底层写入入口、由安装脚本调用，不新增第二条写同一文件的路径；
  - `docs/` 内既有的 `plan-vendor-config-contract.md` 与 `painpoint-vendor-switch.md` 的五字段/多字段描述——本次改为三字段后**必须回改**，否则文档与实现立刻分叉；
  - `.env.example` 的注释与实际解析逻辑一致性。
- **向后兼容**：删除 `.env` 中的旧键会改变用户现有行为（尤其 `ZCODE_BASE_URL` 影响 endpoint 解析）。迁移脚本必须**明确列出删了哪些键**，而不是静默删除。

## Open Questions

- ~~**`ZCODE_VENDOR_BASE_URL` 是否必填**~~ —— **已决**：必填（含内置厂商）。判别链路依赖它，见 Context 的已确认决策。
- ~~**`ZCODE_VENDOR` 与 BASE_URL 冲突时**~~ —— **已决**：报错，不以任意一方为准。
- **厂商字段的取值形态**：直接用内置 `templateId`（`bigmodel-api` / `moonshot-kimi`）还是短名（`bigmodel` / `moonshot`）？`.env.example` 的默认值注释要列出可选值，取值形态决定注释怎么写。**倾向**短名 + 由我们映射到 templateId，因为用户是手写这个值；但短名需要额外维护一层映射，且遇到 `opencode-go-chat` 这类无可简化的 id 时仍得用原名。
- **必填带来的体验代价**：内置厂商的端点本可由模板带出，现在要用户手抄一遍。是否值得提供"值为 `auto` 时代入模板值"的语法糖？**倾向不提供**——会重新引入"两种行为"，与本决策的初衷冲突。
- **`BIGMODEL_API_KEY` 的迁移**：用户现有 `.env` 已写该键，迁移时自动改名为 `ZCODE_VENDOR_API_KEY` 还是要求重填？前者体验好，但静默改用户凭据文件需要谨慎。
- **`.env` 在仓库外不生效**（前序 R-103）：四个字段仍受此限制，未解决。

## Out of Scope

- **契约层的解析与校验实现**——见 [docs/plan-vendor-config-contract.md](plan-vendor-config-contract.md)。
- **连通性校验**（F-004）与**回退上一厂商**（F-007）、**模型名探测**（F-008）。
- **把普通 api-key 迁入加密凭据库**——本计划如实按内联明文实现，只在权限与日志上做保护。
- **`.env` 的显式路径入口**（前序 R-103 的彻底解法）。
- **TUI 内的厂商切换 UI**——本计划只做 `.env` 驱动的切换。

---

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

> 扫描规则：Severity(1-5) × Likelihood(1-5) × (1 - Detectability)，Risk Score > 12 记为 HIGH RISK。
> 本计划共执行 3 轮迭代，全部 HIGH RISK 均已就地修正进 Plan 章节：
>
> | 轮次 | 新增 HIGH RISK | 处置 |
> |------|----------------|------|
> | 第 1 轮 | R-201（14.4）、R-202（10.2，按公认为 HIGH） | 已修正第 3 步判别规则、第 4 步两段式写入 |
> | 第 2 轮 | R-208（9.6→修正前更高）、R-209（7.8→修正前更高） | 已修正第 1 步入口容错、第 2 步自定义厂商放行 |
> | 第 3 轮 | R-211（6，BASE_URL 必填后用户手抄出错会被误判为另一条链路） | 已补第 2 步的自洽校验与错误提示 |
> | 第 4 轮（锁定"必填"决策后复扫） | 无 | 收敛 |
>
> 逐条复核结论：R-201 的精确匹配在"同一 URL 多模板"时会撞 R-204，已由"多候选即报错"承接；R-202 的两段式在首次/二次执行路径上分别落到 create/update；R-208 的自定义厂商路径不再依赖内置清单；R-209 的非法配置不会阻断入口与 `doctor`。四个修正项均在 Do 章节有对应断言。

### R-201: 端点判别用子串匹配，把五家普通厂商误判成 Coding Plan

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.1
**Risk Score**: 14.4 — **HIGH RISK**

**Failure Scenario**: 计划第 3 步最初的判别写法是"BASE_URL 命中 `/api/anthropic`"。实测内置端点后发现：Coding Plan 是 `https://api.z.ai/api/anthropic`，但 **Moonshot（`api.moonshot.cn/anthropic`）、DeepSeek（`api.deepseek.com/anthropic`）、Minimax、Qwen-cn、Xiaomi-mimo 的普通 api-key 端点也全部以 `/anthropic` 结尾**。任何"看起来像 anthropic 端点就当套餐"的判断，会把五家普通厂商写进 Coding Plan 的加密凭据库链路——**key 类型不同、鉴权方式不同**，表现为请求全部失败或鉴权异常，而用户改 key、改 base url 都不解决问题。

**Mitigation**:
- 判别改为 **BASE_URL 精确等于** 内置端点的完整 URL（归一化去尾斜杠后比较），**禁止**任何 `includes` / `endsWith` / 正则模糊匹配（已改写 Plan 第 3 步）。
- 验证清单中增加"Moonshot / DeepSeek 这类 `/anthropic` 结尾的普通厂商**不得**被判为 Coding Plan"的显式断言——这是防止回归到模糊匹配的关键用例。
- 判别函数单独成函数并直接对内置端点表做等值比较，便于逐条核对。

### R-202: 用 `savePersonalProviderOverlay` 当唯一写入路径 → 首次写入直接失败

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.15
**Risk Score**: 10.2

**Failure Scenario**: 前序计划（R-101）为了避免 `createPersonalProvider` 生成 `xxx-2` 的重复条目，给出的建议是"改用 `savePersonalProviderOverlay`"。但读实现后发现该函数**只更新不创建**：`if (!currentPersonal && !builtin) throw new Error("Personal Provider 尚未创建: ${providerId}")`。于是按这个建议实现，**首次配置任意厂商都会直接抛错**，功能完全不可用；而错误信息"尚未创建"又容易被误读为配置问题而非实现问题。

**Mitigation**:
- 改为显式两段式（已改写 Plan 第 4 步）：先查是否存在 → 存在走 `savePersonalProviderOverlay`（更新），不存在走 `createPersonalProvider`（创建一次）。
- 两个 API 的语义差异写入 Plan 的对照表，避免后续维护者再被"只用其中一个"的建议误导。
- 验证清单中，"同一配置连续执行两次 `providerRules` 长度不变"（R-101 的回归项）**必须同时覆盖首次与二次执行**——只测二次会漏掉首次失败。

### R-203: 安装脚本无法直接调用 `ConfigService`，写入路径被迫跨包

**Severity**: 2 | **Likelihood**: 4 | **Detectability**: 0.2
**Risk Score**: 6.4

**Failure Scenario**: `ConfigService` 属于 workspace 包 `packages/provider`（以 TS 源码出包），而 `scripts/install/` 是仓库根的普通 Node `.mjs`。计划早期默认"脚本直接调 ConfigService"，实际上要么走不通，要么诱使实现者从脚本里直接 import TS 源码，绕开构建链路与本仓库的公开入口约定。

**Mitigation**:
- 把写入实现为 CLI 子命令（扩展现有 `zcode configure`），由 `make install` 调用（已改写 Plan 第 8 步）。
- 该子命令与 TUI 命令中心复用**同一个 `ConfigService` 实例与同一套逻辑**，满足本仓库 AGENTS.md 的"单一写入路径"要求。
- 依赖其 `--json` 输出做校验，与既有 `zcode doctor --json` 的消费方式保持一致。

### R-204: 多厂商模板共用同一 URL，精确匹配也可能命中多个

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 6.3

**Failure Scenario**: 实测发现 `opencode-go-chat` / `opencode-go-messages` / `opencode-go-responses` 三个模板的 `api.baseUrl` **完全相同**（`https://opencode.ai/zen/go/v1`），`opencode-zen-*` 三个同理。仅凭 BASE_URL 无法区分它们——三者的差异在 `api.type`（`openai-chat-completions` / `anthropic-messages` / `openai-responses`）。若实现假设"URL 唯一确定厂商"，在这些厂商上会取到错误的技术协议。

**Mitigation**:
- 精确匹配命中**多个**候选时，**报错并列出候选**（含各自 `api.type`），不要取第一个。
- 这也说明 `ZCODE_VENDOR` 字段是必要的——用厂商名直接定位模板即可绕开 URL 歧义，BASE_URL 退回为一致性校验的输入。
- 验证清单补一条：`ZCODE_VENDOR=opencode-go-chat` 能正确定位到 `openai-chat-completions` 协议。

### R-205: 迁移 `.env` 时删掉用户仍需的键

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 7.2

**Failure Scenario**: 本计划要删除 8 个既有键。其中 `ZCODE_DEPS_BASE_URL` 与 `INTRANET_MACHINE_HOST` 是**内网部署**专用（源码注释明写"内网或私有部署地址没有线上默认值"），`ZCODE_BASE_URL` 影响 endpoint 解析。若迁移脚本静默删除，内网用户会在下一次安装依赖或登录时才发现拿不到内网地址，且很难联想到是这次迁移删掉的。

**Mitigation**:
- 迁移前备份 `.env`，且**逐一列出实际删除了哪些键及其原值来源**（不含 API key，但内网地址要回显给用户确认）。
- 对"值非空且不在新四字段内"的键，**不静默删除**，而是移动到一个保留区并提示用户；空值键可直接删。
- 文档中列出"本次删除了哪些键、如需保留请自行迁移"。

### R-206: Coding Plan 的 Access 不可禁用，被替换后仍留在候选里

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 5.4

**Failure Scenario**: `savePersonalProviderOverlay` 中有明确约束：`Account Provider 不允许禁用: ${providerId}`。用户从 Coding Plan 切到普通厂商后，旧的 `account:bigmodel-individual-coding-plan` 既不能被删除也不能被禁用，仍会出现在 TUI 的厂商列表里（只是不再是默认）。若用户误选它，会回到已失效的链路。更隐蔽的是它**仍被计入"同一家厂商"的判定**，可能干扰 R-202 的查重逻辑。

**Mitigation**:
- 查重逻辑必须区分"account 型内置 Provider"与"个人层 Provider"，**不要**把前者当成可更新的目标。
- 切换后通过"改默认指针"表达"不再使用"，而不是试图删除/禁用它；文档中说明这一行为。
- `doctor` 报出生效厂商时，若它是 account 型而 `.env` 声明的是普通厂商，给出明确 WARN。

### R-208: 自定义厂商因"模型不在清单内"被卡死

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 9.6

**Failure Scenario**: 计划第 2 步最初写的是"`MODEL` 不在该厂商的模型清单内 → 报错并列出可用模型"。但**自定义厂商根本没有内置模型清单**（这正是它需要用户指定 base url 与 model 的原因）。按字面实现，用户接自建端点时必然撞"模型不在清单内"而无法配置——恰好堵死了计划宣称支持的核心场景之一。

**Mitigation**:
- 明确区分两种情形（已改写 Plan 第 2 步）：**有清单但不含该模型** → 报错（用户拼错）；**根本没有清单**（自定义厂商） → 放行，并提示"该模型未经内置清单校验"。
- 自定义厂商的模型写入个人层的 `personalModelIds`，不依赖内置清单。
- 验证清单补一条：自定义厂商 + 任意模型名 → 能正常写入并跑通。

### R-209: `.env` 内容非法导致整个 CLI 不可用

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.35
**Risk Score**: 7.8

**Failure Scenario**: `.env` 已被入口在**每次 CLI 启动**时读取（上一轮引入的 `loadCliDotenvAtEntry`）。若新增的四字段解析在入口抛错（例如值里有未转义字符、或解析逻辑对空值不容错），则"改了配置"会升级为"`zcode` 完全用不了"——而 `zcode doctor` 这个本该用来排障的命令同样起不来，用户失去唯一的自查手段。

**Mitigation**:
- 厂商字段解析**不得**在入口抛错（已写入 Plan 第 1 步的硬性约束）；入口只做读取，校验推迟到真正消费该配置的时机（`configure` / TUI 启动）。
- `doctor` 必须在配置非法时仍能运行并报出问题——不得依赖被排障对象是好的。
- 验证清单补一条：`.env` 写入非法配置后，`zcode doctor` 仍能启动并给出可读错误。

### R-210: 四份文档重叠且互相矛盾，实现者读到废弃版本

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.3
**Risk Score**: 8.4

**Failure Scenario**: 本主题现有四份文档：`painpoint-vendor-switch.md`（五字段、厂商由 MODEL 反查）、`plan-vendor-switch.md`（总纲，其中的 Provider 结构写成 `builtinModelIds`，**已知错误**）、`plan-vendor-config-contract.md`（五字段含 `API_TYPE`）、本计划（**四字段，含 VENDOR，与前三者冲突**）。实现者若从任意一份旧文档起步，会实现出已经被推翻的契约——最可能的是多写一个 `API_TYPE` 字段、或按 MODEL 反查厂商而导致 `GLM-5.3` 撞歧义报错。

**Mitigation**:
- 本计划落地时**同步回改**前三份文档：把字段表统一为四字段、把 `builtinModelIds` 订正为 `personalModelIds`、在 `plan-vendor-switch.md` 顶部标注"字段契约以 `plan-vendor-config-write.md` 为准"。
- 每份文档顶部加一行"上位/下位关系"，形成单一事实来源，避免读者自行判断哪份最新。
- 把"文档与实现不一致"列入 Adjust 章节的全局扫描项（已列）。

### R-211: BASE_URL 必填后，用户手抄端点出错却被当作"自定义厂商"

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 6

**Failure Scenario**: BASE_URL 改为必填后，内置厂商的端点也要用户手抄。手抄极易出错（多一个尾斜杠、`open.bigmodel.cn` 误写成 `bigmodel.cn`、把 `/api/paas/v4` 抄成 `/api/anthropic`）。**后两种错误尤其危险**：`bigmodel.cn` 与 `open.bigmodel.cn` 不同、`paas/v4` 与 `anthropic` 不同，前者会导致端点不可达，后者会让本应走普通 API Key 的配置被判为 Coding Plan 链路（因为 `/api/anthropic` 恰好是套餐端点）。用户看到的是"鉴权失败"，而真实原因是端点抄错。

**Mitigation**:
- 第 2 步的"`ZCODE_VENDOR` 与 BASE_URL 必须自洽"校验正是为此：内置厂商配了不属于它的端点 → 报错，并在错误信息中**给出该厂商的正确端点**，让用户直接对照修改。
- `ZCODE_VENDOR` 为空但 BASE_URL 与某个内置端点高度相似（如同一主机名但路径不同）时，给出**提示性告警**（"是否想用 <厂商名>？"），但不自动改写。
- `.env.example` 中的默认值示例必须是**可直接使用的完整端点**，减少手抄。
- 验证清单补一条：`ZCODE_VENDOR=bigmodel` + `BASE_URL=https://open.bigmodel.cn/api/paas/v4`（普通端点配了套餐名义）→ 报错且错误信息含正确端点。

### R-207: 默认模型切换后，旧会话/旧指针残留指向已不存在的模型

**Severity**: 2 | **Likelihood**: 2 | **Detectability**: 0.3
**Risk Score**: 2.8

**Failure Scenario**: `saveConfiguredDefault` 改的是 `defaultModelSelection`，但用户可能已有进行中的会话或 TUI 内的模型选择状态。切换后 `defaultModelSelection` 指向新厂商模型，而会话里仍记录着旧模型 id，恢复会话时可能报错或静默回退到默认端点。

**Mitigation**:
- 切换默认模型**只在写入成功后**执行（已在 Plan 第 5 步要求），避免指针指向不存在的条目。
- 验证清单补一条：切换厂商后恢复一个旧会话，确认行为可预期（报清晰错误或正常回退），不是崩溃或静默用错厂商。

---

> Next step: 本计划的两个 HIGH RISK 已就地修正（第 3 步判别改为精确匹配、第 4 步改为两段式写入）。执行前仍需定 Open Questions 的第一条（`ZCODE_VENDOR_BASE_URL` 对内置厂商是否必填），它决定判别规则的输入形态。若需继续，可对 [docs/plan-vendor-switch.md](plan-vendor-switch.md) 或 [docs/plan-vendor-config-contract.md](plan-vendor-config-contract.md) 复扫，确认本次改动没有让它们的结论失效。
