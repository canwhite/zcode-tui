# Plan: 换厂商只在 .env 里配

> **文档层级**：本文是**总纲**（要做什么、分几期）。
> 字段契约与实现细节以 [plan-vendor-config-write.md](plan-vendor-config-write.md) 为准；
> 本文 Plan 章节中"协议字段""由 MODEL 反查厂商"等描述已被四字段方案取代。

> 让用户在 `.env` 里声明 base url / api key / 协议 / model，即可切换到任意大模型厂商（内置模板自动带出端点，自建端点显式声明），且切换后可当场验证连通。

## Context

本计划由 [/pre-mortem 对痛点拆解的失败模式扫描](painpoint-vendor-switch.md) 产出。目标痛点拆解见 [docs/painpoint-vendor-switch.md](painpoint-vendor-switch.md)（痛点 A~E）。

计划前已核对的现状（全部来自源码与真实文件，非推断）：

| 事实 | 证据 |
|------|------|
| 个人 Provider Config 支持任意厂商 | `packages/provider/src/config/provider-data-schema.ts`：`access.type` 支持 `api-key` 且可内联 `apiKey`；`api.type` ∈ {anthropic-messages, openai-chat-completions, openai-responses}；`baseUrl` 任意 URL |
| 厂商分组枚举只有三个 | `providerGroupDataSchema` = `standard-personal` / `zai-family` / `bigmodel-family` |
| 内置模板自带 baseUrl/api/模型清单 | `config/provider/zcode-builtin.json` 的 `templateRules`（18+ 家，含 Moonshot / DeepSeek / Qwen / OpenAI / Anthropic / OpenRouter） |
| **当前生效的是 Coding Plan，不是普通 api-key** | `~/.zcode/v2/provider_config.json` → `defaultModelSelection = { providerId: "account:bigmodel-individual-coding-plan", modelId: "GLM-5.3" }` |
| 个人层当前是空的 | 同文件 `providerConfigRules = { providerRules: [] }` |
| 凭据是加密落盘的 | `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts` 使用 `createZCodeCredentialCipher` 加解密，非明文 |
| 两套存储并存 | Coding Plan key 在 `~/.zcode/v2/credentials.json`（加密）；普通 api-key 内联在 `provider_config.json` |
| 内置配置随包分发，非远程必需 | `apps/zcode-cli/packages/cli/dist/provider/zcode-builtin.json` 存在；远端刷新失败时会走 `skipped (not-due)` 而非中断 |

已确认前提：一次只生效一个厂商 ｜ 内置列表内的厂商自动匹配、列表外的显式声明协议。

## Goal

1. `.env` 中声明厂商三元组（+ 协议），即可完成切换，**无需手工构造内部配置文件**。
2. 切换后能用一条命令验证真实连通，失败原因可区分（鉴权 / 网络 / 协议 / 模型）。
3. 切换是**单活且幂等**的——不残留旧指针，不产生重复配置项。
4. **不破坏现有可用的 Coding Plan 链路**（当前 `bigmodel` 走 `zhipu-account` + 加密凭据库）。
5. `doctor` 能报出当前生效厂商、base url、协议与模型，"配了但没生效"当场可见。

## Plan

1. **定义 `.env` 厂商字段契约**（对外接口，第 9 章待澄清项之一需先定）。至少覆盖：厂商名（可选）、base url、api key、协议类型（可选）、model。命名需同时容纳"内置厂商前缀键"与"自定义厂商通用键"两种形态。
2. **实现解析与校验**：读取 `.env`，做存在性与取值域校验（协议必须三选一、base url 必须是合法 URL），缺失关键项时**拒绝写入而非写入半成品**。
3. **实现内置模板匹配**：厂商名命中 `templateRules` 时，带出该模板的 `baseUrl` / `api.type` / `builtinModelIds`，用户只需补 key；未命中则要求显式提供 base url 与协议。
4. **实现个人 Provider Config 写入**：向 `providerConfigRules.providerRules` 写入/覆盖一条记录（`group: standard-personal`、`access.type: api-key` 内联 `apiKey`、`api.type`、`baseUrl`、**`personalModelIds`**），**写入必须是原子的**并保持幂等。
   > 订正（2026-09-22）：个人层**禁止** `builtinModelIds`（`rule-data-schema.ts` 的 `omit`），模型写在 `personalModelIds`。原写法有误。
5. **实现生效指针切换**：改写 `defaultModelSelection` 指向新厂商与模型；同时明确旧 Coding Plan 凭据的去留策略（见风险 R-003）。
6. **实现连通性校验**：发一次真实最小请求，把失败归类为鉴权失败 / 网络不可达 / 协议不匹配 / 模型不存在，并给出对应修复方向。
7. **扩展 `doctor`**：新增"当前生效厂商"检查项，输出厂商名、base url、协议类型、模型名（**绝不输出 key**）。
8. **接入既有安装入口**：与 `make install` 的配置阶段衔接，保证"装完即可换"。

## Think — Debug Methodology

- **两套存储必须先分清**：动手前先确认目标厂商走哪条链路（`api-key` 内联 vs `zhipu-account` + 凭据库）。混用是本次最可能的错误来源。
- **在边界处立刻加日志**：`.env` 解析的出入口（读到了哪些键、值是否为空）、模板匹配的判定结果（命中哪个 templateId）、写入前后的 `defaultModelSelection` 实际值。**日志只打键名与结构，绝不打 key 值**。
- **先读源码再断言**：`api.type` 三个取值的行为差异必须读 `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` 的 `toAiSdkProviderConfig` 分支，不能靠猜。
- **用真实请求验证**：写入成功不等于可用；必须用 `zcode -p` 实际发一次请求。
- **定位顺序**：请求失败时，先确认"生效的是不是新厂商"（`doctor`），再看端点与协议，最后才看 key——顺序反了会在错误的层反复试。

## Do — Verification Strategy

- **构建**：`pnpm --filter "@zcode/cli..." build` — 必须通过。
- **静态分析 / 类型检查**：`pnpm typecheck` 与 `pnpm --filter @zcode/cli typecheck` — 零错误。
- **Lint**：`pnpm lint` — 零错误。
- **运行时验证**（需真实请求，逐条给出命令与期望）：
  1. 用**内置模板厂商**（如 Moonshot）切换 → `zcode -p` 真实成功；
  2. 用**自建端点 + `openai-chat-completions`** 切换 → 真实成功；
  3. 用**自建端点 + `openai-responses`** 切换 → 确认该协议是否真的可用（见风险 R-005）；
  4. 切回 `bigmodel` Coding Plan → 原有链路仍然可用（回归，见风险 R-003）；
  5. 故意写错协议类型 → 报错能指向"协议类型"这一项，而不是泛化的请求失败；
  6. 故意写错 api key → 报"鉴权失败"而非"网络不可达"；
  7. 同一条配置**重复执行两次** → 不产生重复 provider 条目，`defaultModelSelection` 稳定。
- **逻辑正确性**（必须逐条走通）：`.env` 缺 base url / 缺协议（自定义厂商）/ 厂商名拼错 / 模型名不存在 / `provider_config.json` 已被手工改乱，各返回是否符合预期。
- **回归重点**：切换前后各跑一次 `zcode doctor`，确认没有把原本 PASS 的项跑成 FAIL。

## Adjust — Rollback and Global Scan

- **回滚方案**：
  - 改动前**备份** `~/.zcode/v2/provider_config.json`（当前可用的 Coding Plan 指针就在里面）；
  - 记录当前 `defaultModelSelection` 原值，失败时可直接写回；
  - 新增脚本反悔即删；`.env` 的改动用户可自行还原。
  - 注意：`credentials.json` 是加密的，回滚时**不要**去改它，只动生效指针。
- **全局扫描**：本次引入的是"由 `.env` 驱动的写入路径"，要检查是否与既有写入路径冲突——尤其 `zcode configure`（写 Coding Plan）、TUI 命令中心的配置入口、`zhipu-account` 的 overlay 逻辑。**避免出现多条写入路径写同一份配置**（本仓库 AGENTS.md 明确要求避免）。
- **向后兼容**：现有 `BM MODEL_API_KEY` 驱动的 `make install` 预置行为必须继续可用；`.env` 新增字段应为**可选**，缺失时保持现有行为不变。

## Open Questions

- **`.env` 字段命名**：通用键（`ZCODE_VENDOR_*`）vs 厂商前缀键（`MOONSHOT_API_KEY`）。已确认"两者都要"，但两套如何共存、优先级如何，直接影响第 1 步的契约设计。
- **`openai-responses` 在自定义厂商下是否可用**：内置模板里 OpenAI/xAI 用的是该协议，但个人 `api-key` 配置走这条协议是否同样成立需要实测（风险 R-005）。
- **Coding Plan 凭据去留**：切到普通 api-key 厂商时，`credentials.json` 里的 Coding Plan 凭据是保留还是清理（风险 R-003 的缓解方向需据此定）。
- **`group: standard-personal` 是否适用于全部非智谱厂商**：影响 TUI 里的厂商展示与排序。
- **与上一个痛点的同源遗留**：`.env` 由 cwd 逐级向上查找，仓库外启动不加载——换厂商配置在仓库外不生效（风险 R-004）。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

> 扫描规则：Severity(1-5) × Likelihood(1-5) × (1 - Detectability)，Risk Score > 12 记为 HIGH RISK。
> 本计划共执行 2 轮迭代，第 2 轮未发现新的 HIGH RISK，循环收敛。

### R-001: 用户无法在仓库外使用自己配好的厂商

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 8

**Failure Scenario**: 用户在 `.env` 里配好 Moonshot 并验证通过，此后在 `~/work/other-project` 里敲 `zcode`，以为用的还是 Moonshot，实际因为 `findDotenv` 从 cwd 逐级向上找不到仓库里的 `.env`，回落到内置默认端点或直接未加载配置，表现为"我明明配了却像没配"。这个失败**不会报错**，只会静默换一套端点，是最难被发现的一类。

**Mitigation**:
- `doctor` 必须报出"当前生效厂商 + base url + 配置文件路径"，让"没加载到"当场可见（本计划第 7 步已含）。
- 未加载配置时给出显式 WARN，而不是静默使用默认值（沿用已实现的 `config.env` WARN 形态）。
- 在 `docs/` 与 `.env.example` 注释中写明 `.env` 的查找范围是 cwd 向上，不是全局。
- 明确记录为**已知限制**而非缺陷；若要彻底解决需引入显式路径入口（独立议题，不在本计划范围）。

### R-002: api key 以明文落在用户家目录的个人配置里

**Severity**: 5 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 6

**Failure Scenario**: 现有 Coding Plan 凭据走的是加密的 `credentials.json`（`createZCodeCredentialCipher`），而普通 api-key 按 schema 是**内联在 `provider_config.json` 的 `access.apiKey`**——那是明文。用户把厂商 key 配进来后，家目录里多了一份明文密钥；若该文件被同步到云盘、被备份工具收走、或被误提交，即构成凭据泄露。

**Mitigation**:
- **如实告知**：在文档与 `doctor` 输出中说明"普通厂商 key 以明文存于 `~/.zcode/v2/provider_config.json`"，不粉饰为"已加密"。
- 写入时对该文件设置**仅属主可读**权限（0600），与 `credentials.json` 的权限对齐（已观察到后者为 `-rw-------`）。
- 所有日志、`doctor` 输出、错误信息**只列键名不回显值**（本计划第 7 步硬性要求）。
- 安装脚本与文档提示：不要把 `~/.zcode` 纳入任何同步/备份范围。
- 若需更强保障，另立议题评估把普通 api-key 也迁入加密凭据库（**不在本计划范围**，避免一次改动横跨两套存储）。

### R-003: 切换厂商把当前可用的配置弄坏，且回不去

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 6

**Failure Scenario**: 当前 `defaultModelSelection` 指向 `account:bigmodel-individual-coding-plan/GLM-5.3`，这是**已验证可用**的配置。切换逻辑若在写入新 provider 后、改写指针前失败，或覆盖了 `providerConfigRules` 的错误层级，用户会同时失去旧配置与新配置——从"能用"变成"完全不能用"。更隐蔽的是只坏了一半：指针指向新厂商但凭据仍在旧位置。

**Mitigation**:
- 写入前**备份** `~/.zcode/v2/provider_config.json`，并在切换失败时自动写回原 `defaultModelSelection`。
- 写入采用**原子替换**（同目录临时文件 + rename），避免中途失败留下损坏 JSON。
- **明确单一写入路径**：本次新增的写入必须与 `zcode configure`、TUI 命令中心共用同一底层写入入口，不新增第二条写同一文件的路径。
- 切换后**立即**执行连通校验（本计划第 6 步）；校验失败即视为切换失败并回滚。
- `doctor` 增加"生效厂商是否与 `.env` 声明一致"的检查项，捕获"配了新的、跑的仍是旧的"半切换态。

### R-004: 协议类型配错，静默失败或报出无从定位的错误

**Severity**: 3 | **Likelihood**: 5 | **Detectability**: 0.7
**Risk Score**: 4.5

**Failure Scenario**: 同一个 base url 在 `anthropic-messages` 与 `openai-chat-completions` 下都"看起来合理"。用户用了 Anthropic 兼容端点却声明了 OpenAI 协议，请求发出后返回的是难以理解的解析错误或 4xx，用户会在 base url、key、模型之间反复试，唯独想不到是协议这一项。这是本痛点最**高频**的失败模式。

**Mitigation**:
- 连通校验的错误分类中**把"协议不匹配"作为独立一类**输出，明确提示"可疑项：协议类型"（本计划第 6 步）。
- 内置模板匹配时**不让用户手填协议**（模板自带），从源头消除该错误（本计划第 3 步）。
- 自定义厂商场景下，`doctor` 输出中始终回显当前协议类型，便于一眼核对。
- 若某厂商已知协议（如 `openai-*` 基址路径含 `/v1`），可在解析阶段给出**启发式提示**（仅提示，不自动改写）。

### R-005: `openai-responses` 协议在自定义厂商下根本不成立

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 5.4

**Failure Scenario**: 内置模板里 OpenAI 与 xAI 用的是 `openai-responses`，据此在 `.env` 契约中把它列为合法取值。但个人 `api-key` 配置走该协议时若不被支持（schema 允许 ≠ 运行时支持），用户选了它只会得到失败，而文档却告诉他这是合法选项——**接口承诺了做不到的能力**。

**Mitigation**:
- 动手前**先读** `apps/zcode-cli/packages/adapters/src/model/model-execution.ts` 的 `toAiSdkProviderConfig` 分支，确认三个 `api.type` 在个人 api-key 路径下的实际行为。
- 用真实请求**实测**该协议（验证清单已列为第 3 条）；若不成立，从 `.env` 契约的合法取值中移除，而不是留给用户试错。
- 契约文档只承诺**已验证**的取值。

---

> Next step: 运行 `/planning docs/painpoint-vendor-switch.md` 的 F-001（`.env` 字段契约），先把第 9 章的命名取舍定下来，再据此细化本计划的第 1~4 步。
