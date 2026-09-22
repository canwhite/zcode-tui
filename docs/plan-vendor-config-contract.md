# Plan: 换厂商的 .env 字段契约（F-001）

> **文档层级**：本文的字段设计（五字段、含 `API_TYPE`）已被
> [plan-vendor-config-write.md](plan-vendor-config-write.md) 的**四字段**方案取代——
> 有了 VENDOR 字段后协议由厂商决定，不再需要用户声明。
> 本文仍有价值的部分：Context 里的 schema 约束核对（个人层禁止 `builtinModelIds`、
> `group` 被收窄、`account:` 前缀限制）与"解析与落盘分离"的取舍。

> 定义 `.env` 中声明一家大模型厂商所需的最小字段集，并实现其解析与校验，作为后续写入个人 Provider Config 的输入契约。

## Context

本计划是 [docs/plan-vendor-switch.md](plan-vendor-switch.md) 的第一个 P0 功能点（F-001）的专项落地方案，上游痛点见 [docs/painpoint-vendor-switch.md](painpoint-vendor-switch.md)。

**为什么先做契约**：字段命名与校验规则是对外接口，一旦写入用户 `.env` 就很难改；而下游的"写入 Provider Config""切换生效指针""连通校验"（F-002~F-004）都消费同一份契约。先把契约定死，后续三步才不会各自发明结构。

**已确认前提**：一次只生效一个厂商 ｜ 内置厂商自动匹配、列表外的显式声明 ｜ 触发入口是 **`make install` 自动读 `.env`**（不新增独立子命令）。

本计划新增的、此前计划未记录的关键约束（均已核对源码）：

| 约束 | 证据 | 影响 |
|------|------|------|
| 个人 Provider 规则**禁止** `builtinModelIds` | `packages/provider/src/config/rule-data-schema.ts:108` 的 `config: providerConfigDataSchema.omit({ builtinModelIds: true })` | 模型必须写入 **`personalModelIds`** |
| 个人规则的 `group` **只能是** `standard-personal` | 同处 `.extend({ group: providerGroupDataSchema.extract(["standard-personal"]) })` | 不能自造分组 |
| `account:` 前缀的 providerId 不允许带 `access` | 同文件 `superRefine`：`"固定 Account Provider 的 Access 只能由 ZCode Built-in Config 声明"` | 自定义厂商的 providerId **不得**以 `account:` 开头 |
| 个人 `api.baseUrl` 允许为 null | `personalProviderApiDataSchema` 放宽了 `baseUrl` | 支持"暂存编辑中"的半成品，但本计划**不使用**该放宽 |
| 个人规则是**数组**，不是 map | `personalProviderConfigRulesSchema` 为 `{ providerRules: [...] }` | 写入是数组元素的增改，不是对象键赋值 |
| 当前个人层为空 | `~/.zcode/v2/provider_config.json` → `providerRules: []` | 首次写入没有迁移负担 |

> ⚠️ 上游痛点文档 `docs/painpoint-vendor-switch.md` 的第 3.2 节把 `ProviderEntry.builtinModelIds` 写成"至少含用户指定的 model"，与上述源码约束不符。**执行本计划时一并订正该文档**，避免下游按错误结构实现。

## Goal

1. `.env` 能以**最少字段**声明一家厂商；内置列表内的厂商只需厂商名 + key。
2. 解析结果是一个**经过校验的强类型对象**，非法输入在写入任何文件之前就被拒绝。
3. 契约字段全部可选——**不配置时行为与现在完全一致**（不破坏现有 Coding Plan 链路）。
4. `.env.example` 与文档同步更新，用户照抄即可。

## Plan

1. **确定字段集与命名**（本计划的交付核心）。建议形态——通用键承载"当前生效厂商"，避免为每家厂商记一套前缀：

   | 字段 | 必填性 | 说明 |
   |------|--------|------|
   | `ZCODE_VENDOR` | 可选 | 内置厂商标识（如 `moonshot-kimi` / `deepseek`）。命中时自动带出 base url、协议、模型 |
   | `ZCODE_VENDOR_BASE_URL` | 条件必填 | 自定义厂商必填；内置厂商可省略（用模板值），显式填写则覆盖模板 |
   | `ZCODE_VENDOR_API_KEY` | 必填 | 厂商密钥。只进 `.env`，日志与 `doctor` 一律不回显 |
   | `ZCODE_VENDOR_API_TYPE` | 条件必填 | `anthropic-messages` / `openai-chat-completions` / `openai-responses`。内置厂商可省略 |
   | `ZCODE_VENDOR_MODEL` | 条件必填 | 自定义厂商必填；内置厂商可省略（取模板首个模型） |

   **覆盖规则需明确**：显式字段优先于模板值，模板只补空缺。这条规则必须写进文档，否则"我明明写了 base url 却没生效"会成为下一个排查黑洞。

2. **实现解析**。读取 `.env`（复用既有向上查找逻辑），产出 `VendorConfig` 对象。**只解析不写入**——把解析与副作用分离，便于单测与后续复用。

3. **实现校验**，按以下顺序短路，每条都给可执行的修复建议：
   - 五项全空 → 视为"未配置厂商"，返回 `undefined`，**不报错**（保持现状行为）；
   - `ZCODE_VENDOR_API_KEY` 为空 → 报缺失；
   - `ZCODE_VENDOR` 非空但不在 `templateRules` 中，**且**未提供 base url 或协议 → 报"未识别的厂商名；若为自建端点请显式提供 base url 与协议"；
   - `ZCODE_VENDOR_API_TYPE` 取值不在三元枚举内 → 报错并列出三个合法值；
   - `ZCODE_VENDOR_BASE_URL` 非空但不是合法 URL → 报错。
   > **关键**：把"协议类型配错"从运行时失败提前到解析期，这是该痛点最高频的失败模式（见 plan-vendor-switch.md 风险 R-004）。

4. **实现内置模板匹配**。从随包分发的 `providerConfigRules.templateRules` 中按 `templateId` 查找，带出 `api.type` / `api.baseUrl` / 模型清单。模板来源与运行时同源（`config/provider/zcode-builtin.json` 经 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 解析），不新增第二份厂商清单。

5. **产出 Provider 规则草稿**（供 F-002 写入，本计划只构造不落盘）。

   **不要手搓配置结构**：仓库已有 `ConfigService.createPersonalProvider`（`packages/provider/src/config-service.ts:222`），它已经处理了模板解析、分组固定、id 生成与约束校验，并会主动拒绝 `initialConfig` 里的 `group` 与 `builtinModelIds`。手搓等于把 Context 表里那几条 schema 约束重新实现一遍，且没有任何东西保证不会写错。

   ```
   { providerId, providerName, templateId?, config: { group: "standard-personal",
       access: { type: "api-key", apiKey }, api: { type, baseUrl },
       personalModelIds: [model] } }
   ```
   - 模型写 `personalModelIds`，**不是** `builtinModelIds`；
   - `providerId` **不得**以 `account:` 开头（见 Context 表的约束）；
   - **必须复用 `resolvePersonalProviderBaselines` 先查"是否已存在同一家厂商的条目"**，命中则改而不是新建——`nextPersonalProviderId` 在 id 被占用时会返回 `moonshot-kimi-2` 这类新 id（`config-service.ts:688`），直接重复调用 `createPersonalProvider` 会**每跑一次 `make install` 就多一条重复厂商**。这是本计划最需要明确的一条实现约束，详见风险 R-101。

6. **更新 `.env.example`**，加入这五个键及其注释，注明"留空即沿用当前配置"。

7. **接入 `make install` 的配置阶段**：解析 → 校验 → （F-002 落盘）→ 自检。本计划只到校验为止；校验失败时 `make install` 应输出失败原因并**不进行后续写入**。

## Think — Debug Methodology

- **边界处立刻加日志**：`.env` 解析的入口与出口——读到的键名、各字段是否为空、是否命中模板（命中哪个 `templateId`）、最终 `VendorConfig` 的结构。**只打键名与结构，绝不打 api key 值**。统一前缀 `[DEBUG-VENDOR]`，收尾用 `grep -r "\[DEBUG-VENDOR\]"` 一把清除。
- **先读源码再断言**：`providerConfigDataSchema` 的 omit/extend 关系是本次最容易踩的坑（个人层禁止 `builtinModelIds`、`group` 被收窄、`account:` 前缀禁止带 access）。改动前重读 `packages/provider/src/config/rule-data-schema.ts`，不要凭记忆。
- **上游优先定位**：解析出问题时，先确认"`.env` 到底被加载了没有"（`doctor` 的 `config.env` 检查项已能报出路径与键名），再怀疑字段名拼写，最后才查模板匹配。顺序反了会在错误的层反复试。
- **区分"未配置"与"配置错误"**：这两个分支返回完全不同（`undefined` vs 抛错），日志里要能一眼分辨，否则用户会看到"我什么都没配却报错"。
- **不要用 TUI 验证解析逻辑**：解析是纯函数，用直接调用 + 构造 `.env` 字符串的方式验证，比起 TUI 快且可复现。

## Do — Verification Strategy

- **构建**：`pnpm --filter "@zcode/cli..." build` — 必须通过。
- **静态分析 / 类型检查**：`pnpm typecheck` 与 `pnpm --filter @zcode/cli typecheck` — 零错误。
- **Lint**：`pnpm lint` — 零错误。
- **运行时验证**（解析是纯函数，优先用构造数据验证，再用真实 `.env` 端到端确认）：
  1. 五项全空 → 返回未配置，`make install` 行为与改动前**逐字一致**（回归基线）；
  2. 内置厂商（如 `moonshot-kimi`）+ key → 正确带出 base url、`anthropic-messages`、模型清单；
  3. 自定义厂商 + base url + 协议 + 模型 → 正确产出 `VendorConfig` 与规则草稿；
  4. 显式 base url **覆盖**内置模板值 → 以显式值为准（验证第 1 步定的覆盖规则）；
  5. 协议写成不存在的值 → 解析期报错并列出三个合法值；
  6. 未知厂商名且不给 base url → 报指引性错误，不是泛化的失败；
  7. 同一份输入解析两次 → 产出的 `providerId` 完全一致（幂等前提）。
- **逻辑正确性**（逐条走通并在报告中确认返回值）：空字符串 / 仅空格 / 带引号的值 / 值里含 `=` / base url 末尾带斜杠 / 大小写不同的协议值。**大小写要明确策略**（建议接受任意大小写、统一归一为小写），并在文档中写清。
- **不越界**：本计划不写盘，因此验证阶段**不得**修改 `~/.zcode/v2/provider_config.json`；如需演练，先备份再恢复。

## Adjust — Rollback and Global Scan

- **回滚方案**：本计划只新增解析与校验代码 + 修改 `.env.example`，**不触碰任何用户态文件**，回滚即删代码与还原 `.env.example`。这是把"解析"与"落盘"拆成两步的主要收益——契约错了，代价只是一次代码回滚，不需要修用户已经写坏的家目录配置。
- **全局扫描**（完成后必须回答"还有哪里存在同类问题"）：
  - `apps/zcode-cli/packages/cli/src/doctor.ts` 是否需要新增"厂商配置是否被识别"的检查项（F-005 范畴，确认接口预留即可）；
  - `zcode configure` 与 TUI 命令中心已有的写入路径——本次契约**不得**引入第二条写 `provider_config.json` 的路径（本仓库 AGENTS.md 明确要求单一写入路径）；
  - 上一轮实现的 `make install` 的 `BIGMODEL_API_KEY` 预置逻辑：新的契约字段与它是**并存还是替代**？需明确，否则会出现"两套配置方式，用户不知道哪个生效"。**建议**：`BIGMODEL_API_KEY` 保留为 Coding Plan 专用（它走 `zhipu-account`，与普通 api-key 不同链路），新字段只管普通厂商，并在文档中把两者区别写清楚。
- **向后兼容**：五个字段全部可选；未设置时**不产生任何行为变化**。这是本计划最重要的兼容性约束，必须在验证第 1 条中被证明。

## Open Questions

- **`ZCODE_VENDOR` 的取值空间**：直接用内置 `templateId`（如 `moonshot-kimi`）还是另设更友好的别名（如 `moonshot`）？直接用 `templateId` 实现最简，但用户要记住 `-kimi` 这类后缀。倾向前者（少一层映射），执行时若发现 `templateId` 对用户不友好再补别名层。
- **`providerId` 的派生规则**：由厂商名派生（`standard:moonshot-kimi`）还是由 base url 主机名派生（`standard:api.moonshot.cn`）？后者在用户换厂商名写法时更稳定，前者更可读。需要定一个，因为 F-002 的幂等性依赖它。
- **`openai-responses` 是否真的可用**：schema 允许 ≠ 运行时支持（plan-vendor-switch.md 风险 R-005）。契约里是否先只允许两种协议、实测通过后再放开第三种，需要决策。**倾向先只允许两种**，避免承诺做不到的能力。
- **协议值的大小写**：建议接受任意大小写并归一，但需确认与内置模板 `api.type` 的比较方式一致。
- **是否需要"多个厂商配置并保留"**：已确认"一次只用一个"，但用户换回上一家时是否希望 key 还在（即保留多条 provider 记录、只切换指针）？这影响 F-002 是"覆盖"还是"追加 + 切指针"。

## Out of Scope

- **写入个人 Provider Config**（F-002）与**切换生效指针**（F-003）——本计划只产出规则草稿，不落盘。
- **连通性校验**（F-004）与 **`doctor` 厂商可见性**（F-005）。
- **内置模板匹配的省事路径**（F-006）——本计划第 4 步已包含模板查找，但"只写厂商名即可"的完整体验由 F-006 收口。
- **回退到上一厂商**（F-007）与**自建端点模型名探测**（F-008）——均为 P2。
- **`.env` 在仓库外不生效的问题**（plan-vendor-switch.md 风险 R-001）——独立议题。
- **把普通 api-key 迁入加密凭据库**（风险 R-002 的增强方案）——本计划如实按明文内联实现，不横跨两套存储。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

> 扫描规则：Severity(1-5) × Likelihood(1-5) × (1 - Detectability)，Risk Score > 12 记为 HIGH RISK。
> 本计划共执行 2 轮迭代，第 2 轮未发现新的 HIGH RISK，循环收敛。

### R-101: 每跑一次 `make install` 就多一条重复厂商

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 8

**Failure Scenario**: 实现者按直觉调用 `ConfigService.createPersonalProvider` 完成写入。该函数用 `nextPersonalProviderId(occupied, templateId)` 生成 id，而它在 id 被占用时**不是报错、而是返回 `moonshot-kimi-2`**（`packages/provider/src/config-service.ts:688`）。于是用户每跑一次 `make install`，配置里就多一条同厂商记录；跑十次就是十条。用户不会察觉，但 TUI 的厂商列表会被同名项塞满，且 `defaultModelSelection` 指向哪一条变得不确定。

**Mitigation**:
- 写入前**必须**先用 `resolvePersonalProviderBaselines` 查出"是否已有同一家厂商的条目"，命中则**改**（`setRule` 覆盖同 `providerId`）而不是新建。
- 判定"同一家厂商"的键要**稳定**：优先用 `templateId`（内置厂商）或规范化后的 `baseUrl` 主机名（自定义厂商），**不要**用 `providerName`——它是用户可改的显示名，`nextPersonalProviderLabel` 还会自动加后缀。
- 验证清单里增加"同一条配置连续执行两次，`providerRules` 长度不变"的断言（已在 Do 章节列为运行时验证第 7 条，此处明确为**硬性回归项**）。
- 若无法稳定识别同一条，退一步：写入前检测到疑似同名厂商时**停下来报告**，要求用户确认，而不是默默追加。

### R-102: 配置写错却"看起来成功"，问题被推迟到发请求才暴露

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 4.8

**Failure Scenario**: 本计划刻意只做解析与校验、不落盘。但下游 F-002 若在写入时静默吞掉 schema 校验失败（例如某个字段被 omit 掉后 `.strict()` 拒绝），用户看到的是"`make install` 成功"，实际配置根本没写进去，直到某天发请求才发现用的是别的厂商。**写入成功 ≠ 解析成功 ≠ 配置生效**，这三件事在本计划里被拆开了，接缝处最容易漏。

**Mitigation**:
- 本计划的校验结果必须是**显式返回值**（成功时返回 `VendorConfig`，失败时抛带修复建议的错误），不允许用 `null` 静默表示失败。
- 契约层输出的对象要能被下游**直接检验**：F-002 写入后应重新读取个人配置并比对，确认写进去的与解析出的语义一致。
- `doctor` 增加"当前生效厂商与 `.env` 声明是否一致"的检查项（已在 plan-vendor-switch.md 的 F-005 中），作为端到端的兜底可见性。
- 验证阶段必须走一次**完整的 `make install` → `doctor` → `zcode -p`** 链路，不能只验解析函数。

### R-103: 仓库里的 `.env` 变成了实际配置源，而它本该只是仓库工件

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.7
**Risk Score**: 3.6

**Failure Scenario**: `.env` 位于仓库根（与 `.gitignore` 第 13 行匹配，不入库）。把它变成厂商配置源后，配置文件与仓库生命周期绑定：用户 `git clean`、换分支、重新克隆、或把仓库移到别处（当前全局 `zcode` 是指向仓库内 `dist/zcode.cjs` 的软链），配置就没了。更糟的是**删除是静默的**——不像删家目录配置那样有痕迹。

**Mitigation**:
- 文档中明确：`.env` 是**仓库工件**而非用户级配置，删除仓库即删除配置。
- 契约设计上不引入"必须存在于仓库根"的强假设——解析只依赖"cwd 向上能找到一个 `.env`"，保持与既有 `findDotenv` 语义一致。
- 长期方向（**不在本计划范围**）是把厂商配置迁移到用户级路径（`~/.zcode/v2/` 下），`.env` 只作为覆盖层。本计划不要预先锁定实现，免得迁移成本变高。
- `doctor` 报出实际生效的 `.env` 路径，让"配置到底从哪来"始终可见。

### R-104: 新契约与既有 Coding Plan 链路争抢"当前生效厂商"

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 4.8

**Failure Scenario**: 当前 `defaultModelSelection` 指向 `account:bigmodel-individual-coding-plan/GLM-5.3`（已验证可用）。新的普通厂商配置写入后，若两套配置**同时存在且都合法**，用户无法判断当前生效的是哪一套；若新配置未正确改写指针，会出现"我配了 DeepSeek，跑的却是 BigModel"且**不报错**。这是"静默用错厂商"，比直接失败更难发现。

**Mitigation**:
- 本计划的契约里**只描述一个厂商**（单活），不引入任何"多厂商并存"的表达能力，避免歧义进到配置层。
- 明确二者关系并写进文档：`BIGMODEL_API_KEY` 是 **Coding Plan 专用**（走 `zhipu-account` + 加密凭据库），新字段只管**普通 api-key 厂商**，两者不是同一件事的两个写法。
- 若两者同时配置，行为必须**有确定答案**并在文档写明（建议：普通厂商字段优先，因为它更晚引入且用户意图更明确），不能靠"谁先写谁生效"。
- `doctor` 的"当前生效厂商"检查项是这条的最终兜底（F-005）。

### R-105: 协议类型被当作可选项，配错却在验证阶段才暴露

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 5.4

**Failure Scenario**: 契约把 `ZCODE_VENDOR_API_TYPE` 设计为"内置厂商可省略"。用户从内置厂商切到自建端点时，只改了 base url 而**忘了补协议**；或者反过来，从自建端点切回内置厂商时残留了旧的协议值，覆盖掉模板的正确值。后者尤其隐蔽：第 1 步定的"显式字段优先于模板"规则会让残留值生效。

**Mitigation**:
- 自建端点场景下协议**必填**，缺失即报错（已在 Plan 第 3 步校验顺序中列出）。
- 第 1 步的覆盖规则要**显式文档化**，并在验证清单中加一条"切回内置厂商时行为正确"的用例（当前 Do 章节只覆盖了显式值覆盖模板，没覆盖"残留值是否应被清理"）。
- 考虑在解析时对"厂商名命中内置模板、但显式协议与模板不一致"的情况给出**明确告警**，而不是静默取显式值——这通常是用户改了一半的信号。

### R-106: 内置模板清单随上游更新而漂移

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 3.6

**Failure Scenario**: `.env` 里写的是 `templateId`（第 9 章待澄清项倾向的方案）。当内置配置更新换代，某个 `templateId` 被改名或移除时，用户 `.env` 里的厂商名会突然失效，报"Provider Template 不存在"。用户对此没有预期，因为他没改过任何东西。

**Mitigation**:
- 报错文案必须包含**当前可用的 templateId 列表**（或提示如何查看），让用户当场能改对。
- 契约层对"厂商名未命中"与"厂商名缺失"给出**不同**的错误，前者提示"可能是内置清单已更新"。
- 模板变更时在 CHANGELOG 或文档中记录，作为迁移信号。

---

> Next step: 本计划只覆盖 F-001。契约定下后再用 `/planning docs/painpoint-vendor-switch.md` 规划 F-002（写入 Provider Config），或用 `/pre-mortem docs/plan-vendor-switch.md` 扫总纲层面的风险。
