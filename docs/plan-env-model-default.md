# Plan: 让 `.env` 声明的模型真正生效（套餐分支）

> 触发：`make install` 自检 FAIL `厂商 bigmodel-individual-coding-plan 不支持模型 GLM-5.3-flash`。
> 排查中发现这不是一个 bug，而是同一族的五个，本文按"症状 → 根因 → 处置"记录。

## Context

用户在 `.env` 写 `QCODE_VENDOR_MODEL=GLM-5.3-Flash`，`make install` 后默认模型却是 `GLM-5.3`。
套餐（Coding Plan）分支**校验**了 MODEL，然后把它的值丢掉。

契约早已写明这件事（`docs/plan-vendor-config-write.md`）：

| 位置 | 原文 |
|------|------|
| `:192` | 「**切换默认模型**：写入成功后调 `saveConfiguredDefault({ providerId, modelId })`」 |
| `:201` | 「解析四字段 → 定位厂商 → 分流写入 → **切默认模型** → 自检」 |
| `:55` | 「用户的 bigmodel key 是 Coding Plan（套餐）｜ **默认模型跟着切**」 |
| `plan-vendor-config-contract.md:59` | 「**覆盖规则需明确**：显式字段优先于模板值，模板只补空缺……否则『我明明写了却没生效』会成为下一个排查黑洞」 |

所以这是**漏实现**，不是新需求。

## 五个问题与处置

### 1. 套餐分支丢弃 MODEL（用户报的那个）

`run.ts` 已解析出 `resolved.resolved.model`，但套餐分支调
`configure({ apiKey, env, providerId })` 时没有传；bootstrap 侧取的是
`builtinModelIds` 的**首个**模型（`standalone-account-provider-runtime.ts`）。

**处置**：`StandaloneCodingPlanProvider` 带上 `modelIds` / `modelRules` / `apiType` / `baseUrl`；
`ConfigureCodingPlanApiKeyOptions` 增加 `modelId`；`run.ts` 传 `modelId: model`；
bootstrap 侧校验成员资格后写入。

### 2. 套餐写出的默认选择**不可选**（比 1 更隐蔽）

`coding-plan-config.ts` 只写 `{ providerId, modelId }`，没有 `options`。而
`registry.ts` 的 `validateModelSelectionOptions` 对 `options?.reasoningLevel === undefined`
**无条件**判 `reasoning-level-missing`；`resolveInitialModelSelection` 遇到不可选的默认值
**不报错**，直接回退到 Registry 顺序的第一个模型。

即：套餐配置写完后，运行期可能根本没用写进去的默认选择。这条此前无任何断言覆盖，
`doctor` 只看持久化值，也看不出来。

**处置**：写入时带 `options.reasoningLevel`，取值由**该模型的实际规则**解析（`modelRules.resolve(...)`
后取 `.values.at(-1)`），与运行期 `completeNewModelSelection` 同口径。

> 关键：**不能用常量**。历史实现（个人分支）写死 `"enabled"`，依据是"通用模型是
> `["disabled","enabled"]`"；但档位是**按模型**匹配的，GLM-5.3 系是 `["low","high","max"]`，
> 写 `"enabled"` 会被判 `reasoning-level-not-supported` —— 同样不可选、同样静默回退。

### 3. 个人分支的硬编码档位

同上，`personal-vendor.ts` 的 `DEFAULT_REASONING_LEVEL = "enabled"` 对 GLM-5.3 系、
`kimi-k3`、`deepseek-*` 等模型都不成立。

**处置**：改为按模型规则解析（`composeEffective(内置, 个人)` → `resolve` → `.at(-1)`）；
解析不出来时不写档位（宁可不写，也不写一个不支持的）。

### 4. MODEL 大小写

`resolveVendor` 用 `modelIds.includes(model)` 精确匹配，而厂商名 `findVendorByName`
是大小写不敏感的 —— 同一文件里两套宽严标准。

**处置**：精确匹配优先，失败后做**唯一**的大小写不敏感匹配，并把**清单里的规范写法**
传下去（落盘、`doctor` 显示、请求用同一个串）；命中多条视为歧义，维持原报错。

### 5. 改名（zcode → qcode）的成批漏网

同一族问题，一并修：

| 位置 | 症状 |
|------|------|
| `scripts/install/install.mjs` | `hasVendorConfig()` 读 `ZCODE_VENDOR*` → 恒为 false → **`qcode configure` 每次安装都被静默跳过** |
| `scripts/install/env-config.mjs` | `REQUIRED_KEYS` 仍是契约已废除的 `BIGMODEL_API_KEY` |
| `apps/.../adapters` vs cli | 凭据读 `ZCODE_DATA_BASE_DIR`、个人配置读 `QCODE_DATA_BASE_DIR` → 只设一个，另一半静默落到 `~/.zcode` |
| `adapters/src/config-home` | 代码读 `ZCODE_CONFIG_HOME`，而 `.env.example` 宣传的是 `QCODE_CONFIG_HOME` → 照抄模板的用户设了个不生效的键 |
| `packages/shared/src/zcodeEndpoint.ts` | 端点覆盖同上（`ZCODE_BASE_URL`），`doctor` 也照着旧名提示用户 |
| `cli/src/run.ts` | `normalizePresentationSurface` 被改成返回 `"qcode_desktop"`，而类型是 `"zcode_desktop"` → **CLI 类型检查挂掉**，且 `core` 里按它分支的逻辑永不成立 |
| `test/*.mjs`、`scripts/build-desktop-agent-bytecode.mjs` | 指向不存在的 `dist/zcode.cjs` |
| `test/zero-account-acceptance.mjs` | 隔离宿主机 `.env` 时清的是旧键名 → 宿主机 BASE_URL 漏进来（该关此前应为红） |

**处置**：统一为 `QCODE_` 为规范名、**旧名兜底**（`packages/shared/src/env-keys.ts` 一处定义，
`readRenamedEnv` 新名优先）。旧名不删——已设置旧名的部署不能被静默改道。

## 验证

- 构建 `pnpm run build`、类型检查（根 + cli/bootstrap/adapters）、`pnpm lint` 全绿（6 条 warning 均为既有文件）。
- `test/zero-account-acceptance.mjs` **12/12**，其中两条为本次新增的回归断言：
  - 默认模型跟随声明的 MODEL（用清单**第二个**模型做探针，否则区分不出"生效"与"取首个"）；
  - 写出的默认选择带思考档位。
- `test/claude-config-home.mjs` 26/26、`test/btw-side-question.mjs` 7/7。
- `make install` 端到端：`result: OK`，输出 `默认模型 account:bigmodel-individual-coding-plan/GLM-5.3-Flash`。
- 沙箱隔离：只设 `QCODE_DATA_BASE_DIR`（或只设旧名）时，凭据、个人配置、遥测三者都落在沙箱，真实 `~/.zcode` mtime 不变。

## Pre-Mortem Risks

Score = S × L × (1 − D)。

| # | 风险 | S | L | 1−D | Score | 处置 |
|---|------|---|---|-----|-------|------|
| R-1 | 套餐 selection 缺档位 → 不可选 → 静默回退（**已证实**） | 5 | 5 | 0.7 | 17.5 | 已修；回归断言覆盖 |
| R-2 | 套餐账号未开通 `GLM-5.3-Flash`，写入不报错、发请求才失败 | 4 | 2 | 0.8 | 6.4 | 未消除：需真实发一次请求才算验证（本计划未做） |
| R-3 | 档位常量与内置配置漂移 | 3 | 2 | 0.7 | 4.2 | 已消除：不再用常量，取值由规则解析 |
| R-4 | 旧名兜底遗漏某处读取点 | 3 | 3 | 0.6 | 5.4 | 全局 grep 已覆盖 `DATA_BASE_DIR` / `CONFIG_HOME` / `BASE_URL`；新增读取点需继续遵守 |
| R-5 | 端点/数据目录改名影响既有部署 | 3 | 2 | 0.6 | 3.6 | 新名优先、旧名兜底，不删旧名支持 |

## 未处理（本次范围外）

- **`rejectedConfiguredDefault` 无消费者**（`docs/plan-remove-login-zai-coupling.md` PM-8）：
  存储的选择被运行期拒绝时用户看不到任何解释。本次只让"不再产生被拒绝的选择"，
  没做"被拒绝时报出来"。
- **`doctor` 的「模型配置」只读持久化值**，读不出"写进去了但运行期不可选"——这正是问题 2 能长期潜伏的原因。
- `QCODE_STORAGE_DIR` 是另一个概念（存储/测试根），本次未动；`docs/plan-offline-vendoring.md:136` 仍写作旧名。
- 内部协议键（`ZCODE_PLUGIN_ID_ENV_KEY`、`ZCODE_CUA_*` 等）是与插件/桌面端共享的内部契约，**不应**跟着改名。
