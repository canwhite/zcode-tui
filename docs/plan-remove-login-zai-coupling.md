# Plan: 移除登录态体系与 zcode.z.ai 运行时回连

> 把 zcode 变成真正不需要账号概念的通用工具：拆掉登录/登出命令面与 OAuth 流程，并断开模型请求经平台网关的静默改道。

## Context

来源痛点：`docs/painpoint-remove-login-zai-coupling.md`（输入 `painpoints/pp8.md`）。

原始输入把两件事并列为一件 —— **"删登录"** 与 **"代码不和默认端点 `https://zcode.z.ai` 有任何关系"**。核实后确认二者**承载体不同、危险度也不同**：

|              | "删登录"                                                                                           | "与 zcode.z.ai 有关"                                                                                                                        |
| ------------ | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 承载体       | `auth-login*.ts`、`cli-oauth.ts`、`login-command.ts`、`tui-auth.ts`、`login-flow.ts`、命令注册四处 | `official-coding-plan-gateway.ts:22-31`、`config/provider/zcode-builtin.json:747/810/832/854`、`cli-oauth.ts:4`、`coding-plan-api-key.ts:4` |
| 性质         | 产品面（多出的命令与文案）                                                                         | **运行时网络行为**（静默改道 + 平台侧权益校验）                                                                                             |
| 需登录才生效 | 是                                                                                                 | **否 —— 普通 API Key 也会命中**                                                                                                             |

**最关键的一条事实**：`official-coding-plan-gateway.ts` 按「协议 + 主机 + 端口 + 路径」**精确匹配**两个官方端点并改写为 `{endpoint}/api/v1/ultra[-zai]/anthropic/v1/messages`。本仓库当前 `.env` 的 `ZCODE_VENDOR_BASE_URL=https://open.bigmodel.cn/api/anthropic` 恰好命中第一条路由 —— **此刻模型流量已在经 `zcode.z.ai` 转发，且与是否登录无关**。删掉 `/login` 不会让这一条消失。

### ⚠️ 拆解阶段的一处结论订正（影响 Feature 边界）

拆解稿曾提出"账号型套餐厂商失去取得凭据的唯一途径"，并据此建议把默认值改为 `bigmodel-standard`。**该建议错误，已撤回**，理由有二：

1. **`bigmodel-standard` 不是 coding plan**。`config/provider/zcode-builtin.json` 中 `bigmodel-standard-api` 的端点是 `https://open.bigmodel.cn/api/paas/v4`（OpenAI 协议、按量付费），而 coding plan 的端点是 `https://open.bigmodel.cn/api/anthropic`。改默认值会把用户**整个移出套餐**。
2. **coding plan 本来就不需要登录**。内置清单中 `bigmodel-api` / `zai-api` 两个 **template** 的端点正是 coding plan 端点，其 `access.type` 为 `zhipu-coding-plan-api-key`，`apiKeyManagementUrl` 指向套餐控制台页面 —— 即"用户自行提供一串 key"。且 `auth-login.ts:258-280` 的 `configureCodingPlanApiKey` **接受用户直传的明文 key**（`options.apiKey`），用 key 的哈希派生账号身份后落盘，**全程不涉及 OAuth**。

**结论：coding plan 厂商保留为默认值，`.env.example` 的 `ZCODE_VENDOR=bigmodel` 不动。** 真正需要保住的是 `configureCodingPlanApiKey` 这条**非登录**写入链；需要移除的只是 OAuth 授权链。这使 F-003 的拆除面收窄，F-005 从"补缺口"变为"保住既有能力"。

### 其他核实结论

- `runtime-config.ts`（305 行）**不含任何 auth 引用**，无需改动。
- `config-home/mcp.ts` 与 `zcode-protocol/mcp.ts` 都**不 import** `zcodeEndpoint.ts`，删登录不影响 MCP 配置加载。
- **凭据库与 MCP OAuth 共用同一文件**（`~/.zcode/v2/credentials.json`）：`shared-credentials.ts`、`credential-cipher.ts`、`localhost-callback.ts` **必须保留**。
- **本仓库零单元测试**（无任何 `*.test.ts` / `*.spec.ts`；`test/` 下三个 `.mjs` 均不涉 auth）→ 拆除无回归兜底，必须由 F-007 补。
- 现有工程模式：`test/offline-acceptance.mjs`（断网验收关卡，8 条断言）可作为 F-007 的形态参考。

### 已确认的范围决策

| 决策               | 结论                                                                    |
| ------------------ | ----------------------------------------------------------------------- |
| 删除范围           | 命令层 + 流程层（保留 MCP OAuth 与其共用凭据库）                        |
| `zcodeEndpoint.ts` | 保留文件，只摘登录专属导出                                              |
| 网关改写           | 断掉，请求直达所配置端点                                                |
| 计划覆盖面         | 全部 9 个 Feature，分 3 阶段                                            |
| 残余耦合           | 只纳入 HTTP-Referer；内置配置下载与官方 MCP origin 记入 Open Questions  |
| coding plan        | **保留为默认**，保住 `configureCodingPlanApiKey` 非登录链（见上方订正） |

## Goal

终态（可度量）：

1. 用户可见面**不存在**任何登录/登出入口：命令注册表、CLI 子命令、帮助文案、保留名门禁中 `login`/`logout` 出现次数 **= 0**。
2. 无模型门禁的提示指向**厂商配置**（`configure` / `.env` 四字段），指向已删命令的文案 **= 0**。
3. 模型请求经 `zcode.z.ai` 的占比 **= 0%**（含 HTTP-Referer 不再发默认端点）。
4. 冷启动、仅填 `.env` 四字段、磁盘**无任何账号凭据**时，可完成一次模型请求（成功率 100%）。
5. coding plan 用户经 `zcode configure --api-key <套餐 key>` 仍可配置并使用，**全程无登录**。
6. MCP 服务器 OAuth 登录/刷新**无回归**。

## Plan

按阶段执行。阶段内步骤可并行；阶段间有依赖，不得跳跃。

### Phase 1 — MVP（P0，建议 2-3 周）

**Step 0 — 前置验证关卡：判定网关是"多余的一跳"还是"必需的一跳"**（阻断 Step 1，必须先做）

> 由 pre-mortem 新增并二次加固。**这是本计划的第一道闸，未通过则不得执行 Step 1。**

**先看已有的反证**：`3007` 在 `model-execution.ts:450,605` 与 `failure-provider-business-codes.ts:100` 被专门处理，注释写明是「**zcode-plan 安全校验拒绝**」—— 即网关返回的、**直连厂商端点不可能产生的**业务码。客户端为它写了专门的错误路径。这说明网关至少承载**两项**平台侧处理：套餐权益校验 + 内容安全校验。**因此默认假设应当是"网关必需"，Step 0 的任务是推翻它，而不是确认它。**

**测试必须满足的四个前提**（任一不满足即判为「不确定」，走下方安全默认）：

1. **key 的来源必须与受影响的用户一致**。套餐 key 由 `configureCodingPlanApiKey` 经 biz API 签发，控制台 key 由厂商 API 页签发 —— **两者不等价**。若手上只有控制台 key，用它测出的 200 不能推广到套餐用户。**先确认 key 来源**（是否经 `account-provider:*` 写入凭据库），来源不明即判「不确定」。
2. **必须走真实客户端，不能用裸 curl**。客户端发送的是 `x-api-key` 或 `Authorization`，并附带来源头（`HTTP-Referer` / `X-Title` / `User-Agent`，见 `zcode-source-headers.ts`）。裸 curl 无法复制这套鉴权与来源识别，**会给出与真实客户端相反的结论**。
3. **两条路由都要测**：route #1 `open.bigmodel.cn/api/anthropic`（`bigmodel`）与 route #2 `api.z.ai/api/anthropic`（`zai`）。只测一条不能代表另一条。
4. **临时开关测完即删**。

**执行方式**：加一个临时 env 开关令 `resolveOfficialCodingPlanGatewayUrl` 直接返回 `viaGateway: false`（改动点即 `official-coding-plan-gateway.ts:53-68`），然后用真实客户端对每个厂商各发一次最小请求（`--prompt` 走一次），分别在「开关关」与「开关开」两种状态下比对：

| 直连（开关关）                                                           | 结论                                               | 动作                                                       |
| ------------------------------------------------------------------------ | -------------------------------------------------- | ---------------------------------------------------------- |
| 401 / 403 / 3007                                                         | 网关**承载鉴权/安全校验**，套餐 key 只在网关侧有效 | **F-101 收窄**：只对非套餐厂商断开改写，套餐端点保留网关   |
| 200 且响应正常、用量字段正常                                             | 网关确为多余一跳                                   | Step 1 按原计划执行                                        |
| 200 但用量/额度字段缺失或异常                                            | 网关承载计费归属                                   | 判为「收窄」，**并升级为需与你确认的范围变更**             |
| 任何测试前提不满足（key 来源不明 / 只有一条路由可测 / 无法走真实客户端） | **不确定**                                         | **一律判为「收窄」** —— 安全默认，不得因"看起来能通"而放宽 |

**收窄后的 Goal 修订**：Goal 第 3 条由「模型请求经 `zcode.z.ai` 占比 = 0%」改为「**非套餐请求**经 `zcode.z.ai` 占比 = 0%」。收窄**不是含糊过关** —— 它必须同时落成两件可交付物：① `OFFICIAL_CODING_PLAN_GATEWAY_ROUTES` 保留但加注释说明其为**协议要求**而非实现细节；② 在痛点文档 §9 新增一条**已决范围变更记录**，写明"运行时零回连"对套餐厂商**不成立**及原因，供后续复评。

**结论必须固化为证据**：把两种状态下的请求 URL、HTTP 状态码、响应体关键字段写入 `test/` 下一份可提交的证据文件（不含明文 key），并在 Step 1 的提交信息中引用。**一次性人工观察不算通过** —— 它会在下次被重新争论。

**为什么必须前置**：Step 1 是本计划唯一改变网络行为的步骤，且改写的是**默认厂商**的请求路径。若网关必需而计划假定它多余，Step 1 会一次性打断套餐用户主链路，且症状（401 / 3007）极易被误判为"配置写错了"而非"改坏了"。

**Step 1 — F-101 断开网关端点改写**（阻断于 Step 0；与其余步骤零耦合）

- `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts`：移除对官方端点的改写。注意该文件同时导出 `resolveOfficialCodingPlanGatewayUrl` / `createOfficialCodingPlanGatewayFetch`，需连带处理其调用方（模型发送链上的 fetch 包装点）。
- 保留 `EndpointRouting` 语义但令 `viaGateway` 恒为 `false`，作为指标「请求经 zcode.z.ai 占比」的观测点。
- **本步不触碰 `config/provider/zcode-builtin.json`**（那 4 处指向 `zcode.z.ai` 的端点属 Step 8）。由 pre-mortem 修正：原稿曾建议同批处理，但那会让 Step 1 的"单独 revert 即可恢复原转发路径"失效 —— 回滚会把清单也一并回退，产生难以归因的中间态。
- **代理语义变更需显式记录**：该 fetch 包装的注释明确"应放在用户 HTTP 代理 fetch 之前，使 httpProxy / noProxy 规则按实际发送的网关地址判定"。移除改写后，代理规则将**按 provider 端点判定** —— 对企业网络用户是可感知的行为变化，需在提交信息与 README 中写明。

**Step 2 — F-001 移除登录命令面**

命令面在**四处独立登记**，必须全部处理，否则出现"帮助里写着 `/login`、敲了没反应"：

1. `packages/shared/src/zcode-slash-command-help.ts:26,33` — 摘除 `login`/`logout` 两条（其余 17 条保留）。
2. `apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts:96-112` — 摘除解析分支。
3. `apps/zcode-cli/packages/cli/src/run.ts:735-744` — 摘除 `login`/`logout` 子命令分派；`arguments.ts:23-25` 的 `--no-browser` 随之失效。
4. `apps/zcode-cli/packages/cli/src/prompt-command.ts:20,123-137` — 摘除 headless `/login`、`/logout`。
5. `apps/zcode-cli/packages/bootstrap/src/slash-command-surface.ts:21-26,32-34` — 从保留名门禁移除（否则用户无法再自定义名为 `login` 的 skill）。
6. `apps/zcode-cli/packages/i18n/src/locales/{zh-CN,en-US}.ts:24-25,59-60` — 摘除子命令与斜杠命令帮助行；`loginSetup` 块（`en-US.ts:107-152`）随 F-002 处理。
7. `apps/zcode-cli/packages/cli/src/command-center/create.ts:88-203` — 摘除 `/login`、`/logout` handler 与其 `CommandCenterLogin*` 类型（`types.ts:136-187,308-312,322`）。
8. `apps/zcode-cli/packages/cli/src/command-center/login-flow.ts` — 整文件删除。

**Step 3 — F-002 重定位无模型门禁**（必须与 Step 2 同批）

- `command-center/create.ts:384-391` 的 `isLoginRequired()` 判据实为**"模型注册表无任何模型"**（`tui-login-state.ts:15` 读 `disabledReason`，而 `model-catalog-port.ts:76-81` 明确注明该字段**恒缺席**）。改写：判据语义改为"厂商未配置"，文案指向 `configure` 与 `.env` 四字段。
- 涉及 `create.ts:45-52`（非斜杠提示短路）、`tui-prompt-handler-queries.ts:17`、`tui/src/{app.tsx,app-view.tsx,app-components.tsx,app-result.ts,types.ts}` 的 `loginRequired` 传递与 `LoginRequiredPanel` 渲染。
- `command-center/handlers/model.ts:45` 硬编码的 `loginRequired: false` 一并更名。
- `tui-login-state.ts` 中 `loginRequiredResponse` / `createTuiModelAvailabilityChecker` 按新语义重命名或内联。

**Step 4 — F-003 剥离 OAuth 授权链**（保留 `configureCodingPlanApiKey`）

删除（OAuth 专属）：

- `apps/zcode-cli/packages/bootstrap/src/auth-login.ts` 的 `loginZCodeCli`、`loginBigmodelCodingPlan`、`logoutZCodeCli`、`ZCodeCliLoginError`；`auth-login-polling.ts`、`auth-login-abort.ts`。
- `apps/zcode-cli/packages/adapters/src/auth/cli-oauth.ts`（**内含独立硬编码副本** `zcode.z.ai/api/v1`，:4）、`coding-plan-api-key.ts`（OAuth token → key 兑换，:4 硬编码 `https://api.z.ai`）、`bigmodel-oauth.ts`（已零调用）、`browser.ts`（唯一消费者是登录）。
- `apps/zcode-cli/packages/cli/src/{login-command.ts,tui-auth.ts}`；`cli-types.ts:21-22,32,77-80,105` 的登录 DI 钩子；`provider-runtime-env.ts:129-130` 中 `login`/`logout` 的条目。

**必须保留**（非登录的 coding plan 链路）：

- `auth-login.ts` 的 `configureCodingPlanApiKey:258-280`、`persistStandaloneCodingPlanConnection:324`。
- `app/standalone-account-provider-runtime.ts`（`entitled` 快照、账号身份派生、运行时请求头注入）。
- `adapters/src/auth/{shared-credentials,credential-cipher,localhost-callback}.ts`（MCP OAuth 共用）。

> 验证点：`zcode configure --api-key <key>` 在本步后仍须可用（手测，见 Do 章）。

### Phase 2 — 增强（P1，建议 +2 周）

**Step 5 — F-004 收编凭据层为 MCP OAuth + coding plan 配置专用**

- `SHARED_ZCODE_CREDENTIAL_KEYS`（`shared-credentials.ts:15-24`）中移除登录态专属键：`oauth:active_provider`、`oauth:bigmodel:*`、`oauth:zai:*`、`zcodejwttoken`。
- 保留 `mcp:oauth:*` 与 `account-provider:*`（后者由 `configureCodingPlanApiKey` 写入）。
- **不得改动**加密强度、落点与文件锁（`credential-cipher.ts` 的 AES-256-GCM、0600、`withFileLock`）。

**Step 6 — F-005 保全非登录写入口径**

- 保持 `run.ts:347-352` 的**端点分流**判据不变（注释已明确"分流判据是端点，不是厂商类型"）。
- 确认 `findCodingPlanByBaseUrl` 命中后走的 `configureCodingPlanApiKey` 不再依赖任何已删模块。
- 补一条**明确指引**：若磁盘无凭据且用户未提供 key，报错文案指向 `.env` 四字段与 `configure --api-key`，不提登录。

**Step 7 — F-102 摘除端点文件的登录专属导出**

`packages/shared/src/zcodeEndpoint.ts` 保留文件，仅摘除登录/商务专属导出：`resolveZaiOAuthOrigin`、`resolveZaiBusinessBaseUrl`、`resolveZaiOAuthClientId`、`buildZaiOAuthUrl`、`buildRuntimeZaiOAuthUrl`、`buildRuntimeZaiBusinessUrl`、`isTrustedCodingPlanWebviewOrigin`、`rewriteZCodeEndpointUrl`、`buildBigModelCodingPlanPersonalManageUrl`，以及 `ZCodeEndpointUrls` 中的 `zcodePlanBillingCurrentUrl` / `zcodePlanBillingBalanceUrl` / `webShareCallbackUrl`（后三者**当前零消费者**）与常量 `DEFAULT_ZAI_OAUTH_ORIGIN` / `DEFAULT_ZAI_BUSINESS_BASE_URL` / `DEFAULT_ZAI_OAUTH_CLIENT_ID`。

**同时纳入 HTTP-Referer**（本次范围决策）：

- `packages/shared/src/zcode-source-headers.ts:1,5,39` 仍以 `DEFAULT_ZCODE_ENDPOINT_ORIGIN` 构造每个模型请求的 `HTTP-Referer`。需断开该默认值依赖 —— 要么改为按实际请求端点派生，要么移除该头。具体取向记入 Open Questions，但**本步必须消除"默认端点"这个缺省**。

**保留**（非登录引用方，不改）：`zcode-source-headers.ts` 之外的下述使用方 — `validationAppSettings.ts`、`model-provider-family.ts`、`helpAppConfig.ts`、`model-config.ts`、`process-provider-registry-runtime.ts`、`zcode-protocol-entrypoint.ts`、`doctor.ts`、`provider-runtime-env.ts`。

**Step 8 — F-103 解除内置配置中的官方端点硬编码**

- `config/provider/zcode-builtin.json:747/810/832/854`：`account:{zai,bigmodel}-start-plan` 与 `account:{zai,bigmodel}-offpeak-idle-plan` 的 baseUrl 为 `https://zcode.z.ai/api/v1/zcode-plan/anthropic` 与 `/api/v1/off-peak/anthropic`。这 4 条**必须移除或改造** —— 否则用户仍会在清单里选到指向 zcode.z.ai 的端点。
- 若 Step 1 已同批处理，本步只做**残留复查**：
  `grep -rn "zcode\.z\.ai" config/ apps/ packages/ --include="*.json" --include="*.ts"`，逐条判定是否属本次范围（注意 `cdn-zcode.z.ai` 是**不同主机**、插件市场用，不在范围）。

### Phase 3 — 完善（P2，建议 +1 周）

**Step 9 — F-006 清理零调用登录残留**

审计已确认的零调用者：`auth-login.ts:98` `hasConfiguredStandaloneCodingPlan`、`shared-credentials.ts:255` `loadSharedZCodeCredentialSync`、`packages/shared/src/oauth.ts` 的 `isCredentialDecryptError` / `resolveJwtExpiration` / `OAuthCachedSessionRestoreResult` / `ZCODE_JWT_INVALID_BROADCAST_CHANNEL`、`packages/shared/src/channels.ts` 的 OAuth IPC 通道、`runtimeEnv.ts:86-93` 的 `ZCODE_TELEMETRY_USER_*` 剥离项、`login-command.ts` / `tui-auth.ts` 中冗余的 `loadDotenv` 调用（入口已统一加载）、`tui/src/app-submit.ts:293-300` 的 `/login` transcript 脱敏规则。

- 用 `pnpm run knip` 作为零调用者的**权威判据**，不靠人工 grep。

**Step 10 — F-007 建立「零账号可用」验收关卡**

- 在 `test/` 下新增独立 `.mjs` 脚本（形态对齐 `test/offline-acceptance.mjs`），断言：
  1. 命令面（斜杠命令表 + 子命令分派 + 帮助文案 + 保留名门禁）中 `login`/`logout` 计数 = 0；
  2. 源码中不存在指向 `zcode.z.ai` 的模型端点或 `HTTP-Referer` 缺省；
  3. `.env` 仅四字段时，厂商解析可产出确定性事实；
  4. 官方端点 URL 不产生改写（对 `EndpointRouting.viaGateway` 断言恒 `false`）。
- **防假绿**：故意注入一次网关改写后关卡必须失败。

## 执行记录（偏差与实测）

> 执行中发现的、与计划文本不符之处，以及实测推翻的假设。按发现顺序记录。

### E1. 基线构建在 `main` 上即为红（已修）

`node-repl-host/src/cua-bridge.ts:5` 导入 `@modelcontextprotocol/sdk/types.js`，该包**未安装、也不在 lockfile 中**，
导致 `pnpm run build` 在 `main` 上即失败（`TS2307`），计划的「构建必须通过」闸门因此失去意义。
已作为**前置提交** `6791a6b` 修复（改为同包已声明的 `@modelcontextprotocol/server`），与 pp8 改动分离。

### E2. `pnpm --filter @zcode/cli build` 不重建 adapters

该命令**不会**重建 `@zcode/adapters`，插桩不会进入 bundle。必须用全量 `pnpm run build`。
执行中曾因此对着旧二进制得出「探针未触发」的错误结论。
→ **Do 章的构建闸门明确为全量 `pnpm run build`。**

### E3. knip 在基线上即为红，不能作为「权威判据」

实测基线的 `pnpm run knip` 退出码为 **1**：已有大量既存未使用导出（`contracts` / `shared` 多个模块）
与配置提示。Step 9 不能把 knip 当作零调用者的权威判据 —— **需先修基线，或改用「只检查本次涉及的包」的口径**。

### E4. fmt:check 基线为红（18 个既存文件）

基线已有 18 个文件不满足 oxfmt（`docs/*`、`scripts/install/*.mjs`、`test/claude-config-home.mjs`、
`third-party/.../marketplace.json`）。→ **Do 章的 fmt:check 闸门改为「只检查本次改动的文件」**，
不得为过闸而全仓库重排（会产生与 pp8 无关的巨大 diff）。本次已按此口径执行。

### E5. Step 0 实测结论与 pre-mortem 预期相反

pre-mortem 风险 1（「网关承载鉴权」，14.0 分）**被实测推翻**：套餐 key 直连可用，且 `raw_usage` 字段集与经网关时完全一致。
据此执行**全量断开（两条路由）**，而非计划预案中的「收窄」。风险 2 / 3 的缓解措施由实测取代 ——
但风险 2 的**平台侧计费归属**仍未证实，已记入 `test/step0-gateway-necessity.md` 第 6 节。

### E6. Step 1 实现方式偏离计划文本：整模块删除，而非保留观测点

计划 Step 1 原文为「保留 `EndpointRouting` 语义但令 `viaGateway` 恒为 `false`，作为指标观测点」。
实际**删除整个 `official-coding-plan-gateway.ts`**。理由：保留观测点的意义是**支持按路由收窄**；
决策已改为全量断开，该理由消失，而保留一个恒返回 `false` 的函数只会成为死代码（且 knip 在基线已红，兜不住）。

**对 F-007（Step 10）的连带影响**：原定断言「对官方端点 URL 调用 `resolveOfficialCodingPlanGatewayUrl`
得到 `viaGateway: false`」已不可行（函数不存在）。改为断言**行为**：provider transport fetch 不改写 URL。
本步的行为验证方法（可复用于 Step 10）：把 `ZCODE_ENDPOINT_ORIGIN` 指向死端口 —— 若仍有改写则请求必失败，
直连则不受影响。本次实测：模型请求成功，仅内置配置刷新失败。

### E7. 无关的未跟踪文件

`test/repro-pp10-skill-command.mts` 非本次工作产物（pp10：TUI 中一级 skill 命令的分发）。
已保持原样、未纳入任何提交。

### E8. Steps 2-4 合并为一个提交（偏离「每步一提交」）

计划要求 Step 0-10 各一个提交。实际 Steps 2-4 合并为 `a21ebb5`。理由：**三者相互依赖**，
拆开会产出无法编译的中间提交 —— `login-command.ts` / `tui-auth.ts` 的登录函数在 Step 2
移除调用方后即成为悬空引用，而它们引用的 `CommandCenterLogin*` 类型在 Step 3 才删除。
**保留的关键分离仍然成立**：Step 1（唯一改变网络行为的步骤）是独立提交，可单独 revert。

### E9. 方法论偏差：把 `build` 当成类型闸门（已在 Do 章修正）

执行 Step 2 时，删掉 `CommandCenterLogin*` 类型后 `pnpm run build` 仍为绿，遂一度认为改动无恙；
实际 apps typecheck 报出 **7 个类型错误**。根因：`packages/cli` 的构建是纯 esbuild，不检查类型。
**教训**：本仓库的 `build` 与 `typecheck` 覆盖的是**不同集合**，两者都必须跑 —— 这条已写进 Do 章。

### E10. 已知取舍：TUI 内不再有配置厂商的入口

原 `/login *-api-key` 是 TUI 内**唯一**的厂商配置入口（走 `configureApiKeyForTui` →
`configureCodingPlanApiKey`，非登录路径）。移除 `/login` 后该入口消失：
`CommandCenterDeps.configureApiKey` 与 `tui-provider-config.ts` 保留为**接缝**但当前无 UI 调用方。

CLI 侧 `zcode configure --api-key` 不受影响（已实测），F-002 的门禁文案亦指向它。
**若需 TUI 内配置，需新增一个 `/configure` 类命令** —— 新增命令超出本次「删除登录」的范围，
未实施，记此备查。

### E11. 并发工作树：pp10 改动与本次改动同文件

执行中发现 `prompt-command.ts` 同时存在本次改动与**另一份未提交的 pp10 改动**
（`resolveSkillCommandName` 相关）。处理方式：用 `git apply --cached` 精确只暂存本次的两处 hunk
（import 行 + `/login` `/logout` handler 块），**pp10 的改动原样留在工作区、未纳入任何提交**。
核验：提交内该文件 0 处 pp10 hunk。

**另发现并修正一次提交不完整**：首次提交因暂存循环未能解析重命名路径（porcelain 的
`旧 -> 新` 形式），漏掉了 `tui-provider-setup-state.ts` 的标识符改名，使该提交内含
「`create.ts` 引用 `providerSetupRequiredResponse`，而模块仍导出 `loginRequiredResponse`」的
不一致 —— 该提交**无法通过类型检查**。已 amend 修正，并用「临时换回 HEAD 版本跑 apps typecheck」
的方式验证提交本身（而非工作区）是绿的。

### E12. Step 8 的性质与计划不符：那 4 条不是"隐式回连"，是"显式平台套餐"

计划把 `zcode-builtin.json` 里 4 处 `zcode.z.ai` 当作残余耦合，称"必须移除或改造"。**实测发现性质不同**：

|                | 承载体                                                                         | 性质                        |
| -------------- | ------------------------------------------------------------------------------ | --------------------------- |
| Step 1 断掉的  | `individual/team coding plan`：声明 `open.bigmodel.cn` 却被改写到 `zcode.z.ai` | **隐式**改写（痛点 B 本身） |
| Step 8 这 4 条 | `start-plan` / `off-peak`：清单里**直接声明** `zcode.z.ai/api/v1/...`          | **显式**平台托管套餐        |

移除它们等于删掉两条完整产品线，实测规模：**off-peak 涉及 68 个文件**（含用户可见的
`OffPeakCreate`「闲时任务」工具、`offpeak-port.ts`、工具策略、重试语义、DB 迁移、schema 枚举），
start-plan 涉及 14 个文件。**"只删 4 条"做不到** —— 删后 off-peak 会指向不存在的 provider 而静默失效。

**决策（已确认）**：先只移除这 4 条 + 连带项；两条产品线的代码层全量移除**推迟**。
因此 `streaming-recovery` / `target-completion-verification` 的 `START_PLAN_BUSY_*`、
`model-provider-types` 的 `zaiStartPlan` / `bigmodelStartPlan`、`off-peak-types` 的
`OFF_PEAK_PROVIDER_IDS` 与整条闲时任务链路现在**不可达但不报错**，属**静默行为变化**，
必须在后续清理时一并处理。session-store 的三个历史迁移仍引用这些 providerId —— 迁移是
追加式历史记录，保持原样。

### E13. Step 8 的必需附带项：`revision` 必须 bump（计划未提）

`process-provider-registry-runtime.ts:131` 以
`config.zcodeBuiltinRevision !== account.basedOnZCodeBuiltinRevision` 判定账号型 Provider
快照是否需要重建。**不 bump `revision` 的话，已有快照会继续保留这 4 个 provider，改动等于没生效。**
已 bump 30 → 31。计划原文完全没提这一点 —— 未来改动 `zcode-builtin.json` 时必须同样处理。

### E14. Step 9 有意未删的契约面（附理由）

计划把 `packages/shared/src/oauth.ts` 的 4 个导出、`channels.ts` 的 OAuth IPC 通道、
`test-ids.ts` 的 Login entry 一组常量列为待删死代码。实测它们**确实零引用**，但**未删**：
它们是**面向桌面端的契约面**，而计划 Open Question 7（是否有仓库外消费者）**在本仓库内无法验证**。
盲删有跨仓库破坏风险，留待能确认下游时处理。

同理**有意保留** `runtimeEnv.ts` 的 `ZCODE_TELEMETRY_USER_*` 剥离项 —— 它们是**出于安全**
才留在剥离清单里的历史身份变量，删掉反而可能让这些变量进入遥测。

本步实际删除：整份死文件 `zcode-source-headers.ts`（含 Step 7 之前那处隐式回连的孪生副本）、
`loadSharedZCodeCredentialSync`，以及 env.ts 三处过时注释。**Step 2-4 已顺带清掉大部分**
（login-command / tui-auth / login-flow / app-submit 脱敏规则 / 冗余 loadDotenv）。

### E15. Step 10 关卡已验证"可失败"（防假绿）

`test/zero-account-acceptance.mjs`（8 条断言）建成后，**向产物注入 `"/ultra/anthropic/"`
确认关卡确实 FAIL（7/8）**，恢复后 8/8 —— 即网关改写那条断言不是空断言。
已接入 `pnpm run verify:pre-push`（原先只有 lint + architecture:check），并新增
`pnpm run test:zero-account` 单独入口。

**注意**：本仓库**没有 CI、也没有实际安装的 husky 钩子**（`.husky/_` 之外无钩子文件），
所以 `verify:pre-push` 仍需有人主动跑。这是已知的残余风险 —— 关卡存在但无强制触发点。

### E16. 方法教训：按声明边界删除，不要靠花括号计数

删除 `loadSharedZCodeCredentialSync` 时，我用花括号配平定位函数体，**从参数默认值里的 `{}`
开始计数**，切在了错误位置，留下悬空的函数体、文件语法损坏。改用**声明边界**（删到下一个
`export function resolveSharedZCodeCredentialsPath(` 为止）后一次成功。
**教训**：TS 里花括号配平不足以界定函数边界（参数默认值、对象字面量、模板串都会干扰）；
优先用下一个顶层声明作为右边界，并在删除后**校验中间没有别的声明**。

---

## Think — Debug Methodology

- **先读源码再假设**。本仓库大量关键行为写在注释里且与直觉相悖（如 `vendor.ts:173-176` 明说 `zhipu-coding-plan-api-key` 型模板归为 `api-key`、`run.ts:347-350` 明说"分流判据是端点不是厂商类型"）。任何"应该走 X 分支"的判断，先读对应函数。
- **框架边界立刻打日志**。本计划跨 CLI 入口 → 厂商解析 → provider 注册表 → fetch 发送链四层，日志加在**接收侧**：`runConfigure` 入口打 `parsed.config`、`resolveVendor` 出参打 `resolved.kind`、`resolveOfficialCodingPlanGatewayUrl` 出参打 `decision`。统一 `[DEBUG-LGC-]` 前缀，收尾 `grep -r "\[DEBUG-LGC-" src/` 一次清干净。
- **定位顺序：上游优先**。若"请求仍发往 zcode.z.ai"，先在 fetch 包装点确认 `resolveOfficialCodingPlanGatewayUrl` 的 `viaGateway` 返回值，再往上游查是谁传入了命中的 URL —— 不要先怀疑配置。
- **用 curl 绕过客户端**验证端点行为，避免客户端改写干扰对服务端事实的判断。
- **禁止猜测式重试**：同一命令失败两次即转去读源码或加日志。

## Do — Verification Strategy

每步完成后必过四道闸：

1. **构建**：`pnpm run build`（= `pnpm -r build`，覆盖 apps）。
   > ⚠️ **必须全量**。`pnpm --filter @zcode/cli build` **不会**重建 `@zcode/adapters`，改动不会进入 bundle —— 实测踩坑，见 E2。
   > 且**退出码管道会掩盖失败**：曾因 `pnpm run build | tail` 把 `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` 误读为通过。**取原始退出码判断**。
2. **类型检查**：根 `pnpm run typecheck`（= `tsc -b packages/provider packages/provider-node packages/shared`）**只覆盖 3 个包**。
   > 🔴 **apps 侧类型闸门是另一条命令**：`pnpm --filter zcode-cli run typecheck`（内部 `turbo run typecheck` → 各包 `tsc --noEmit`）。
   >
   > ⚠️ **原稿此处写错了**：曾断言「构建通过是 apps 侧类型的实际闸门」。**实测不成立** —— `packages/cli` 的构建脚本是 `node scripts/build.mjs`（**纯 esbuild，不做类型检查**）。Step 2 删掉 `CommandCenterLogin*` 类型后 `pnpm run build` 仍为绿，而 apps typecheck 报出 7 个类型错误（`tui-prompt-handler.ts` 的对象字面量传入已不存在的 `login` 属性等）。**只跑 build 会漏掉 apps 侧全部类型错误。**
   >
   > 另注：`pnpm --dir apps/zcode-cli run typecheck` 与 `pnpm --dir ... exec turbo` 都会因 `turbo` 不在 PATH 而失败，**必须用 `pnpm --filter zcode-cli run typecheck`**（见 E2/E9）。
3. **静态检查**：`pnpm run lint`（oxlint）。
   - **`pnpm run knip` 在基线上即为红**（既有大量未使用导出 + 配置提示，实测 `BASE_KNIP_EXIT=1`）→ **不能直接当闸门**，Step 9 需先修基线或用「只检查本次涉及的包」口径。见 E3。
   - **`pnpm run fmt:check` 在基线上即为红**（18 个既存文件）→ 改为**只检查本次改动的文件**：`pnpm exec oxfmt <改动文件...>`，不得全仓库重排。见 E4。
   - **Step 0 专用追加闸**（防临时开关残留）：`grep -rn "ZCODE_DEBUG_S0\|DISABLE_CODING_PLAN" apps packages` 必须**无结果**。`ZCODE_DEBUG_S0_DISABLE_GATEWAY` 是一条"能关掉平台网关的后门"，不得进入提交。实测已随 Step 1 删除 `official-coding-plan-gateway.ts` 一并消失。
4. **运行时验证**（手工，逐条走）：

| 场景                   | 操作                                                       | 期望                                             |
| ---------------------- | ---------------------------------------------------------- | ------------------------------------------------ |
| 零账号首请求           | 清空磁盘凭据，仅填 `.env` 四字段（api-key 型厂商）         | 冷启动可完成一次模型请求，无任何登录提示         |
| coding plan 非登录配置 | `zcode configure --api-key <套餐 key> --provider bigmodel` | 成功写入，输出落点与模型，**不回显 key**         |
| 不回连                 | 跑一次模型请求，观察实际目标 URL                           | 直发所配置端点，无 `zcode.z.ai`                  |
| 门禁出路               | 清空厂商配置后启动                                         | 提示指向 `.env` / `configure`，**不提 `/login`** |
| 命令面无残留           | `zcode --help`、TUI 内 `/help`、敲 `/login`                | 无 login/logout 条目；`/login` 报未知命令        |
| MCP 无回归             | MCP 服务器 OAuth 登录 → 刷新                               | 全程成功                                         |
| 保留名门禁             | 建一个名为 `login` 的用户 skill                            | 可正常注册（不再被门禁拦截）                     |

**逻辑正确性自检**（每条改动列出所有执行路径）：

- `parseVendorConfig`：四字段全空 → `notConfigured`（跳过，不算失败）；缺 VENDOR 与 BASE_URL → 报错；缺 API_KEY / MODEL → 报错；齐全 → ok。
- `resolveVendor`：无 VENDOR → custom（放行，不校验清单）；VENDOR 未识别 → 报错并列出可用取值；BASE_URL 与厂商端点不一致 → **报错不猜测**；模型不在清单 → 报错。
- `runConfigure` 分流：端点命中套餐 → `configureCodingPlanApiKey`；未命中 → `writePersonalVendor`（并检查"端点 A + 模型 B"的残留告警）。
- 门禁：有可选模型 → 放行；无可选模型 → 新文案。
- **边界**：空数据（无厂商配置）、未授权（无凭据 / 401）、磁盘残留 `oauth:*` 键、`zcode.z.ai` 不可达。

## Adjust — Rollback and Global Scan

**回滚方案**

- 全程在 `feat/remove-login-zai-coupling` 分支，**按 Step 分提交**（10 个提交），每步独立可回退。
- Step 1（网关改写）是本计划中**唯一改变网络行为**的步骤，也是外部可观测变化最大的一步 → **单独提交、单独验证、优先合入**。
- Step 2/4 的删除量最大（约 1300 行）→ 不与其他步骤混提交，便于精确回退。
- 不涉及数据迁移；磁盘凭据**只读忽略**、不删（见 Open Questions），因此**无不可逆操作**。

> ⚠️ **回滚承诺已订正（post-mortem 实测发现）**：本计划原先写「Step 1 若线上出问题，`git revert` 该提交即可恢复原转发路径」。
> **实测不成立** —— `git revert 10cf430` 会因 `README.md` 冲突而失败。
> 原因：Step 1 的提交同时携带了 README 的网关段落，而后续提交改动了同一区域。
>
> **实际可用的回滚流程**（三个代码文件可干净回退，仅文档需手工取舍）：
>
> ```bash
> git revert -n 10cf430            # 代码 3 个文件干净回退；README.md 冲突
> git checkout HEAD -- README.md   # 保留当前 README（网关段落已被后续文档覆盖）
> git commit -m "revert: 恢复平台网关改写"
> ```
>
> **教训**：回滚承诺必须以"实际执行一次"验证，不能只在计划里断言。行为变更提交**尽量不带文档改动**，否则回滚会被无关冲突卡住。

**全局扫描（每步后执行）**

1. **同类残留扫全局**：命令面四处登记、端点常量独立副本（`cli-oauth.ts:4`、`coding-plan-api-key.ts:4`）、内置清单 4 处硬编码 —— 均为"改一处别漏三处"的高危形态。每改一处即 `grep -rn "<原字面量>" .`。
2. **`grep -rn "zcode\.z\.ai" --include="*.ts" --include="*.json" apps packages config`** 作为每阶段收尾的固定动作；对每条命中判定"属本次范围 / 属 `cdn-zcode.z.ai`（不同主机，不在范围）"。
3. **反向扫"删了 A 忘改 B"**：删 `loginRequired` 语义后，扫所有消费该字段的 TUI 渲染点；删 i18n key 后，扫 `i18n/src/types.ts` 的类型定义。
4. **一致性风险**：Step 5 移除 `oauth:*` 凭据键时，确认 `logoutZCodeCli`（Step 4 已删）是唯一写入方 —— 若有其他写入方则需一并处理。

**向后兼容**

- 老用户磁盘上的 `oauth:bigmodel:*` / `oauth:zai:*` / `zcodejwttoken` 键 → **忽略、不参与解析、不阻塞启动、不主动删除**。
- `~/.zcode/v2/credentials.json` 的**文件格式与加密格式不变**，MCP OAuth 的 `mcp:oauth:*` 键读写路径不变 → MCP 无迁移成本。
- `.env` 四字段契约**不变**；`ZCODE_VENDOR=bigmodel` 仍为合法默认值，且仍可用（经 `configureCodingPlanApiKey`）。

## Open Questions

1. **HTTP-Referer 的替代形态**（Step 7 需定夺）：改为按实际请求端点派生、还是整个移除该头？需确认服务端是否依赖此头做来源识别 —— 若依赖，移除会引入服务端行为变化。
2. **`ZCODE_VENDOR_API_KEY` 在运行时对 coding plan 端点是否足够**：`configureCodingPlanApiKey` 会把 key 写入凭据库（`account-provider:*`），而 `standalone-account-provider-runtime.ts:169-206` 在缺凭据时抛"Standalone Account Provider 缺少请求凭据"。需确认：仅设 `.env` 的 `ZCODE_VENDOR_API_KEY` 而不跑 `configure`，运行时能否读到 key。若不能，F-005 需补一条自动落盘或明确报错。
3. **内置 provider 配置仍从 `{endpoint}/api/v1/client/configs` 下载**（`packages/provider-node/src/zcode-builtin-download.ts:50-53`，`credentials: "omit"`）。本次**未纳入**，记为残余耦合。
4. **官方 MCP origin 仍由 `resolveRuntimeZCodeEndpointOrigin()` 决定**（`zcode-protocol-entrypoint.ts:194-198`）。本次**未纳入**；端点默认值若变动会**静默改变**官方 MCP 鉴权接受哪些 origin。
5. **F-002 门禁是否该整体移除而非改写**：门禁判据实为"无可选模型"，与"未登录"本就无关。若"无可选模型"时有更自然的失败方式（直接在 provider 层报错），改写文案可能是多余的中间态。
6. **`bigmodel-start-plan` / `offpeak-idle-plan` 的处置**：这 4 条账号型条目的端点在 `zcode.z.ai` 上，Step 8 移除后老用户是否受影响？需确认是否有用户在 `account-provider:*` 中持有其凭据。
7. **`zcodeEndpoint.ts` 摘除导出的兼容性**：该文件经 `packages/shared/src/index.ts:99` 以 `export *` 转发，属公开面。是否有仓库外消费者（desktop app）依赖被摘除的符号？

## Out of Scope

- **插件市场本地化**：`cdn-zcode.z.ai` 是**不同主机**，由 `third-party/resources.json` 驱动，与本次 `zcodeEndpoint.ts:3` 的默认端点无关，不在范围。
- **遥测**：OTLP 端点仅由 `OTEL_EXPORTER_OTLP_*` 驱动，身份变量已在 `runtimeEnv.ts:86-93` 退役，无 auth 依赖。
- **MCP 服务器 OAuth 本身**：保留不动（仅确保不受本次删除影响）。
- **provider 请求鉴权**（`Authorization` / `x-api-key` 注入、401/403 分类）：**必须保留**，与工具自身账号无关。
- **`credential-cipher.ts` 加密强度、凭据文件格式**：不动。
- **桌面端**（`packages/shared/src/channels.ts` 的 IPC 契约、`oauth.ts` 的 desktop 面）：仅清理零调用残留，不做契约重构。

---

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

> **情景**：六个月后，这次拆除以最坏的方式失败了 —— 套餐用户全线 401，团队花了三天才意识到问题不在"配置写错"，而在那个被当成"多余一跳"删掉的网关。以下按"失败已发生"倒推。
>
> **评分口径**：Risk Score = Severity × Likelihood × (1 − Detectability)。**Detectability = 早期发现概率**（越低 ＝ 越隐蔽 ＝ 越危险）。> 12 为 HIGH。

### [Risk] 网关承载鉴权：断掉改写后套餐链路全线 401/403

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.3 → **0.9**（Step 0 加固后）
**Risk Score**: 5 × 4 × (1 − 0.3) = **14.0** → 加固后 5 × 4 × (1 − 0.9) = **2.0 — 已降至 LOW**

> **降分理由**：Step 0 是一道**在任何代码改动之前**执行的闸，且已加固为「测试前提不满足即判不确定、一律走收窄默认」。风险从"会打断套餐用户主链路"变为"最坏情况是 F-101 被收窄"——**后者是范围缩小，不是事故**。降分来自未知量被前置消解，不来自乐观假设。

**新增反证（提高本风险的重要性，但不改变降分结论）**：`3007`（`model-execution.ts:450,605`、`failure-provider-business-codes.ts:100`）是「**zcode-plan 安全校验拒绝**」，即网关独有、直连不可能产生的业务码，客户端为此写了专门错误路径。这是"网关承载平台侧处理"的**代码级证据**，使"网关必需"成为更可能的真相 —— 也因此 Step 0 的收窄默认更可能被触发。

**Failure Scenario**：`individual-coding-plan` / `team-coding-plan` 在清单里声明的端点是**厂商端点**（`https://open.bigmodel.cn/api/anthropic`），而网关把它改写为 `zcode.z.ai/api/v1/ultra/anthropic/...`。**这个"声明端点 ≠ 实际端点"的差异本身就是网关承载平台侧处理的证据** —— 若网关只是多余一跳，清单大可像 `start-plan` / `offpeak` 那样直接写 `zcode.z.ai`。因此真相很可能是：**套餐 key 由平台签发、也只在网关侧有效**。Step 1 断掉改写后，默认厂商（`bigmodel`）的全部请求直连厂商端点并返回 401。因为开发者手边通常只有普通 API Key，这个失败**不会在开发机上复现**，而会直接砸在套餐用户身上。

**Mitigation**:

- **Step 0 前置验证关卡（已写入 Phase 1）**：用同一个套餐 key 分别直连与经网关各发一次请求，比对 HTTP 状态码与响应体。**未通过不得执行 Step 1。**
- 若直连返回 401/403 → **F-101 收窄**：只对非套餐厂商断开改写，套餐端点保留网关。同步把 Goal 第 3 条由"模型请求经 `zcode.z.ai` 占比 = 0%"修订为"**非套餐请求**经 `zcode.z.ai` 占比 = 0%"，并回到痛点文档 §9 与你确认该范围变更。
- 保留 `OFFICIAL_CODING_PLAN_GATEWAY_ROUTES` 常量与 `viaGateway` 观测点，使"收窄"只是路由表取舍，而非重写 —— 便于按厂商逐条放开。

### [Risk] 套餐请求的计费归属随网关消失，用户静默地从套餐跌入按量付费

**Severity**: 5 | **Likelihood**: 3 | **Detectability**: 0.2 → **0.7**（Step 0 加固后）
**Risk Score**: 5 × 3 × (1 − 0.2) = **12.0** → 加固后 5 × 3 × (1 − 0.7) = **4.5 — 已降至 MEDIUM**

> **降分理由**：计费只能在"直连成功"这一分支下发生，而 Step 0 已把该分支的判据从"看状态码"改为"**比对用量/额度字段**"，并规定该分支直接升级为**需你确认的范围变更**。危害的不可逆性未变（仍需慎重复核），但"静默"这一属性被破坏 —— 它不再可能在你不知情时发生。

**Failure Scenario**：直连**成功**（非 401），但平台原本经网关完成套餐权益校验与计量。改写移除后请求绕过计量，用户的套餐额度不再被正确扣减 —— 要么被按量付费计费（账单暴增且无告警），要么被平台判定为异常使用。两种结果都**在用户的账单或封禁通知上才可见**，届时已产生实际费用，**无法回滚**。

**Mitigation**:

- Step 0 的第三行判据即为此设：直连返回 200 时**不能只看状态码** —— 追加比对响应中的用量/额度字段，或直接与商务/平台侧确认"套餐端点是否要求经网关计量"。
- 在 Step 0 通过前，Step 1 不得合入主干；可先以 feature flag 形式灰度（仅对自建端点与非套餐厂商生效）。
- 把"计费归属"写入 Goal 的可度量项：非套餐请求占比 = 0%，套餐请求**必须**保持经网关（若确认必需）。

### [Risk] 开发者自己的 `.env` 就是第一个受害者，症状被误判为"代码改坏了"

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.3 → **0.95**（Step 0 加固后）
**Risk Score**: 4 × 4 × (1 − 0.3) = **11.2** → 加固后 4 × 4 × (1 − 0.95) = **0.8 — 已降至 LOW**

> **降分理由**：Step 0 被明确要求**用真实客户端**在改动前跑通两种状态 —— 本仓库的 `.env` 恰好就在网关路径上，因此"直连是否可用"在动手前就有答案，不再存在"改完才发现、且误判归因"的窗口。

**Failure Scenario**：本仓库当前 `.env` 就是 `ZCODE_VENDOR=bigmodel` + `ZCODE_VENDOR_BASE_URL=https://open.bigmodel.cn/api/anthropic` —— **正在网关路径上**。Step 1 一落地，开发者本地环境立刻开始直连并（若风险 1 成立）返回 401。此时排查方向极易走偏：先怀疑 `resolveVendor` 改动、怀疑 `.env` 解析、怀疑 key 失效，**最后才怀疑"是我刚删的那一跳"**。三天时间损失，且中途可能引入无关的"修复"。

**Mitigation**:

- **Step 0 必须在改动代码之前跑，且必须用当前 `.env` 的原始配置跑** —— 这样"直连失败"在动手前就被归因清楚。
- Step 1 提交信息首行写明变更的网络语义：`fix: 模型请求不再经 zcode.z.ai 网关改写（套餐链路影响见 Step 0 结论）`。
- 在 `doctor` 中把"请求实际落点"作为一个自检项输出，使下一次同类问题可在一条命令内定位。

### [Risk] `HTTP-Referer` 是上游归属标识，移除或触碰服务条款

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 4 × 3 × (1 − 0.2) = **9.6 — MEDIUM-HIGH**

**Failure Scenario**：`zcode-source-headers.ts:3-7` 的三个头 —— `HTTP-Referer: DEFAULT_ZCODE_ENDPOINT_ORIGIN`、`X-Title: "Z Code@electron"`、`User-Agent: "ZCode/unknown"` —— 不是随手写的调试头，而是**发往每个上游 provider 的来源标识**。Step 7 把它"断掉"，若选择的是**整体移除**而非改为按实际端点派生，则可能违反上游服务条款（去除归属标识），或因服务端按 `HTTP-Referer` 做来源识别而返回 403。**这类后果在代码审查中完全不可见**。

**Mitigation**:

- **优先选"按实际端点派生"而非"移除"**：`buildZCodeSourceHeadersFromContext` **已经**接受 `endpointOrigin` 选项（`:15, :38-39`），只是缺省回落到了 `DEFAULT_ZCODE_ENDPOINT_ORIGIN`。本步只需让调用方传入实际端点，**几乎零新增机制** —— 这正是"消除缺省"而非"消除能力"，与输入诉求（"不应该有任何关系"）一致且风险最低。
- 移除整个头的方案需**先确认上游是否依赖**：查服务条款/归属要求，或至少保留 `X-Title` / `User-Agent` 不动（它们不含端点，不违反本次诉求）。
- 本项已列入 Open Questions 第 1 条；**执行 Step 7 前必须定夺**，不得边做边定。

### [Risk] 零测试 + 删 1300 行 → 回连以静默方式复发

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 4 × 3 × (1 − 0.2) = **9.6 — MEDIUM-HIGH**

**Failure Scenario**：本仓库**没有任何单元测试**。拆除完成后，未来某次上游同步、依赖升级或厂商配置扩展，重新引入一条指向 `zcode.z.ai` 的端点或改写 —— **没有任何东西会失败**。问题会像这次一样潜伏数月，直到某个用户发现自己的请求去了别的域名。这正是本次痛点当初得以长期存在的原因。

**Mitigation**:

- F-007（Step 10）是**唯一的防线，不是可选项** —— 不得因"P2 可延后"而砍掉。若进度吃紧，宁可延后 F-006（纯死代码清理，无行为风险）。
- 断言必须**行为化而非字面化**：断言"对官方端点 URL 调用 `resolveOfficialCodingPlanGatewayUrl` 得到 `viaGateway: false`"，而不是 grep 源码中是否出现 `zcode.z.ai`（见下一条风险）。
- **防假绿已在 Step 10 写明**：故意注入一次网关改写后关卡必须失败；该验证本身要留下记录（命令 + 输出）。
- 把该关卡接入 `pnpm run verify:pre-push`（现有 `lint && architecture:check -- --changed`），否则它不会被执行。

### [Risk] F-007 断言精度不足：`cdn-zcode.z.ai` 与注释造成假红，断言被习惯性放宽

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 3 × 4 × (1 − 0.4) = **7.2 — MEDIUM**

**Failure Scenario**：`cdn-zcode.z.ai` 是**不同主机**且**必须保留**（插件市场本地化，本次 Out of Scope），而文档与注释里还有大量 `zcode.z.ai` 字样。若 F-007 用宽泛的字符串匹配，关卡会**持续假红**。开发者的自然反应是放宽断言（加白名单、改成只扫某个目录），几次之后断言变得足够宽松，**真问题从旁边走过去**。假红比没有断言更糟：它训练人忽略告警。

**Mitigation**:

- 断言对象锁定为**代码行为**（函数返回值），不扫源码文本 —— 字面量扫描仅作为辅助，且必须精确到主机全等（`cdn-zcode.z.ai` 不匹配 `zcode.z.ai`）。
- 若保留文本扫描，白名单必须是**显式主机清单**而非目录或正则通配。
- 在关卡文件头部写明"本断言为何存在"（指向本 pre-mortem 风险 5），使后人放宽时知道代价。
- 把"故意注入改写应使关卡失败"作为关卡的**自检**，防止断言在某次放宽后静默失效。

### [Risk] `ZCODE_VENDOR_API_KEY` 在运行时对套餐端点可能不充分

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 4 × 3 × (1 − 0.4) = **7.2 — MEDIUM**

**Failure Scenario**：`configureCodingPlanApiKey` 把 key 写入**凭据库**（`account-provider:*`），而 `standalone-account-provider-runtime.ts:169-206` 在缺凭据时抛"Standalone Account Provider 缺少请求凭据"。若仅设 `.env` 的 `ZCODE_VENDOR_API_KEY` 而不跑 `configure`，运行时可能读不到 key —— 用户在文档指导下配好 `.env`、启动、报错，而错误信息指向"缺少请求凭据"这种**与 `.env` 无关联的措辞**，无法自解。

**Mitigation**:

- 在 Step 4/Step 6 之前**先跑通一次**：清空凭据库 → 只设 `.env` 四字段（套餐厂商）→ 启动并发一次请求。**这是 Open Question 2 的关闭条件**，不是可以留到执行中再看的疑点。
- 若确认仅 `.env` 不足 → F-005 补一条**自动落盘**路径（首次启动时将 `ZCODE_VENDOR_API_KEY` 种子写入凭据库），或把报错文案改为明确指向 `configure --api-key`。
- 无论走哪条，`zcode configure --api-key` 必须在 Step 4 后**手测通过**（已列在 Do 章场景表）。

### [Risk] `doctor` 给出指向已删登录的错误修复指引

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.3
**Risk Score**: 3 × 4 × (1 − 0.3) = **8.4 — MEDIUM**

**Failure Scenario**：`doctor.ts:329,350` 已按 `vendor.kind === "coding-plan" && vendor.accountProviderId` 做判定，`:219-234` 含端点自检。Step 2/4 删除登录后，这些分支很可能仍输出"请登录"或"需要账号"类修复建议 —— 而**卡住的用户第一件事就是跑 `doctor`**。一个指向已删命令的诊断信息比没有诊断更伤人：它让人确信自己漏了一步不存在的操作。

**Mitigation**:

- 把 `doctor.ts` 明确列为 Step 2 与 Step 4 的**必改文件**（原计划只在 Step 7 提及其端点检查，遗漏了登录相关分支）。
- Do 章场景表补一行：**清空厂商配置 → 跑 `doctor` → 断言输出中不含 login/登录/账号字样，且修复建议可执行**。
- 与 F-002 的门禁文案用**同一套文案源**（i18n key），避免两处各改一遍后不一致。

### [Risk] 定位冲突：自称"通用工具"却保留一个依赖平台账号体系与网关的默认厂商

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.3
**Risk Score**: 3 × 4 × (1 − 0.3) = **8.4 — MEDIUM**

**Failure Scenario**：本次确认保留 coding plan 为默认（用户已明确纠正），这在**功能上正确**，但与输入的原始诉求"通用工具不应该需要账号"存在张力：开箱默认值仍指向一个由平台签发的套餐 key、且（若风险 1 成立）仍须经 zcode.z.ai 网关。**痛点会在下次以同样的形式复发** —— 用户再次打开代码，看到默认值指向平台套餐，再次提出"和 z.ai 不该有关系"。

**Mitigation**:

- 在 README 的"本分支的改动"中**显式记录这一取舍**：默认保套餐是为了不动既有用户，通用性由"任意厂商 + 任意 baseUrl 均可配置"保证，而非由默认值体现。
- 确保 `.env.example` 里**普通 API Key 型厂商与自建端点路径同样醒目**（当前注释已列出全部别名，需在模板正文里给出一个非套餐的示例块）。
- 若风险 1 结论是"套餐必须经网关"，则把这一事实**写进 README 与 `.env.example` 注释**，而不是留在代码注释里 —— 否则下一个人会再问一次同样的问题。

### [Risk] 上游同步冲突：本分支是官方 zcode 的精简分支

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 4 × 3 × (1 − 0.3) = **8.4 — MEDIUM**

**Failure Scenario**：README 明确本仓库是**精简分支**（保留边界见 `docs/dependency-boundary.md`），并逐文件标注 `Modified by ZCode:`。本次删除约 1300 行，且横跨 `bootstrap` / `cli` / `adapters` / `i18n` / `shared` 五个包 —— 下次同步上游时，这些删除会与上游对同一批文件的修改**大面积冲突**。若合并者选择"以上游为准"，登录会被**静默恢复**，且没人会注意到（因为本次拆除没有测试兜底 —— 见风险 5）。

**Mitigation**:

- 延续仓库既有约定：**每个被修改的上游文件在文件头标注 `Modified by ZCode:`** 并说明改动性质（删除登录面）。本次新增文件（验收关卡）同步登记。
- 在 README「本分支的改动」表中新增一节，**按文件列出删除项**，使上游同步时有据可查 —— 这是本仓库已验证有效的机制（现有表格已达 20+ 行）。
- 把 F-007 关卡纳入 `verify:pre-push`：**上游同步若恢复登录或网关，关卡立刻失败**（这是风险 5 缓解措施的第二个收益）。

### [Risk] 误伤 MCP OAuth：凭据层是共用的

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 4 × 3 × (1 − 0.5) = **6.0 — MEDIUM**

**Failure Scenario**：`shared-credentials.ts`、`credential-cipher.ts`、`localhost-callback.ts` 与 MCP 服务器 OAuth **共用**。执行 Step 4/5 时按"登录相关"直觉整文件删除，或过度清理 `SHARED_ZCODE_CREDENTIAL_KEYS`。MCP OAuth 是**低频路径**（只在首次连接需授权的 MCP 服务器时走），可能数周后才被发现 —— 而那时"删凭据层"与"症状"之间的因果链已不明显。

**Mitigation**:

- 三个文件在计划中已标注**必须保留**；提交前用 `pnpm run knip` 确认无悬空引用，并**单独 grep** 这三个文件的引用方，逐一确认没有 `mcp/` 之外的意外消费者。
- Do 章场景表中的"MCP 无回归"必须**真实执行一次**（连接一个需 OAuth 的 MCP 服务器），不得以"代码没动它"为由跳过。
- `certificate`：`login-flow.ts` 与 `mcp/oauth-interactive.ts` **都** import `localhost-callback.ts` —— 删前者时**不得**顺手删后者。此点需写进 Step 4 的删除清单旁。

### [Risk] 老配置的 `providerId` 指向账号型 provider，登录删除后模型静默消失

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 3 × 4 × (1 − 0.4) = **7.2 — MEDIUM**

**Failure Scenario**：老用户的个人 Provider 配置（`~/.zcode/v2/{PERSONAL_PROVIDER_CONFIG_FILE_NAME}`）里 `providerId` 可能指向 `account:bigmodel-individual-coding-plan` 一类账号型 provider。Step 5 收编凭据层、Step 8 移除 `start-plan` / `offpeak` 端点后，这些 provider 解析失败 → **模型列表为空**。而按 F-002 改写后的门禁会提示"请配置厂商" —— 用户看到的是"我的配置没了"，且**没有线索**说明是本次升级导致的。

**Mitigation**:

- 判定为**升级路径问题**，需一次性迁移提示：启动时检测到旧配置含账号型 `providerId` 且凭据库无对应凭据时，输出一条**具名**提示（含旧 providerId 与迁移动作），而非静默丢弃。
- 在 Step 8 的 4 条端点处置前，**先确认是否有用户在 `account-provider:*` 中持有其凭据**（Open Question 6 的关闭条件）。
- 该迁移提示应复用 `doctor` 的输出通道，使 `doctor` 成为"升级后自检"的统一入口。

### [Risk] 代理规则判定基准变化，企业网络用户断连

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 3 × 3 × (1 − 0.3) = **6.3 — MEDIUM**

**Failure Scenario**：`official-coding-plan-gateway.ts:70-72` 的注释明确：该包装"应放在用户 HTTP 代理 fetch 之前，使 httpProxy / noProxy 规则按**实际发送的网关地址**判定"。移除改写后，代理规则改为按 provider 端点判定。对企业网络用户，`noProxy` 白名单若原本放行 `zcode.z.ai` 而不含 `open.bigmodel.cn`，请求会**突然需要走代理**并可能失败 —— 而这是本次改动**完全没有提到的**副作用。

**Mitigation**:

- 已在 Step 1 中补充"代理语义变更需显式记录"条目。
- 提交信息与 README 写明该行为变化；`doctor` 的端点自检项同时输出"实际发送地址"与"代理判定依据"。
- 若用户侧反馈代理相关故障，回滚粒度已保证：Step 1 单独提交，`git revert` 即恢复原判定基准。

### [Risk] apps 侧类型闸门缺失，错误逃到构建或运行时

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.6
**Risk Score**: 3 × 4 × (1 − 0.6) = **4.8 — MEDIUM-LOW**

**Failure Scenario**：`pnpm run typecheck` 仅覆盖 `packages/provider`、`provider-node`、`shared` 三个包，**不含 `apps/zcode-cli`** —— 而本次 10 步几乎全部落在 apps。开发者按习惯只跑 typecheck 看到绿灯，认为静态闸门已过；实际错误要到 `pnpm run build` 甚至运行时才暴露。在删除约 1300 行的场景下，这会表现为**多轮"改一处、构建一次"的长反馈环**，而非一次性暴露全部悬空引用。

**Mitigation**:

- Do 章已明确标注该缺口；执行时**以 `pnpm run build` 作为 apps 侧类型闸门**，不依赖 typecheck 绿灯。
- 每步结束跑**完整四道闸**（build / typecheck / lint+knip+fmt / 运行时），不因"只改了一行"而跳步。
- 可选改进（超出本计划范围，记入 Open Questions）：为 `typecheck` 增加 apps 覆盖面 —— 但这本身是一次独立改动，不与本次混做。

### [Risk] 直接在 `main` 上动工，回滚方案失效

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.8
**Risk Score**: 3 × 3 × (1 − 0.8) = **1.8 — LOW**

**Failure Scenario**：当前分支为 **`main`**。本计划的 Adjust 章假定"全程在 `feat/remove-login-zai-coupling` 分支、按 Step 分 10 个提交"。若忽略该前提直接在 `main` 上提交，则 Step 1 出问题时的 `git revert` 会作用在主线上，**无法通过"不合入该分支"来整体止损**。

**Mitigation**:

- 开工第一条命令：`git switch -c feat/remove-login-zai-coupling`。Do 章"零账号首请求"等运行时验证在该分支上进行。
- 已核实现工作树干净（仅两份新文档未跟踪），**无需 stash 或处理冲突**，可直接建分支。
- 步骤与提交保持**一一对应**（Step 0–10 各一个提交），使 Adjust 章的"单独 revert Step 1"真实可行。

---

### [Risk] Step 0 本身假绿：错的 key 来源 / 错的测试方式 / 只测一条路由

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.85（加固后）
**Risk Score**: 5 × 4 × (1 − 0.85) = **3.0 — LOW（加固前为 14.0）**

**Failure Scenario**：**这是第二轮迭代发现的最重要风险 —— 它由 Step 0 自身引入。** 三个机制都会让闸门给出**错误的"通过"**，而错误的通过比没有闸门更危险，因为它带上了"已验证"的权威：

1. **key 来源不符**：用控制台签发的普通 key 测直连 → 返回 200 → 结论"网关多余" → 全量断掉 → **真实套餐用户的平台签发 key 401**。开发者手上通常只有控制台 key。
2. **裸 curl 不等价**：客户端用 `x-api-key` / 附带来源头，裸 curl 用 `Authorization: Bearer` 且无来源头。curl 通不代表客户端通，反之亦然 —— **测的不是同一个请求**。
3. **只测 bigmodel**：route #2（`api.z.ai`）未验证，z.ai 套餐用户后续断链。

**Mitigation**（已全部写入加固版 Step 0）:

- 把"key 来源"列为**第一测试前提**：确认是否经 `account-provider:*` 写入凭据库；来源不明即判「不确定」。
- **禁止裸 curl**，改用真实客户端 + 临时 env 开关（复用 `official-coding-plan-gateway.ts:53-68` 的判定点）跑两种状态。
- route #1 与 route #2 **两条都测**。
- **安全默认**：任一前提不满足 → 一律判收窄，**不因"看起来能通"放宽**。
- 结论固化为 `test/` 下可提交的证据文件（不含明文 key），Step 1 提交信息引用它 —— 一次性人工观察不算通过。

### [Risk] 网关的内容安全校验（3007）随改写消失：绕过平台审核

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 4 × 3 × (1 − 0.5) = **6.0 — MEDIUM**

**Failure Scenario**：`3007` =「zcode-plan 安全校验拒绝」，是网关独有的业务码。若 Step 0 判定可直连并全量断掉改写，则套餐请求**绕过平台的套餐侧安全校验**。三重后果：① 平台控制被绕过，可能与套餐条款冲突；② `model-execution.ts:450,605` 与 `failure-classifier.ts:160` 中专为 3007 写的错误路径**成为死代码**（且 knip 不一定能发现 —— 它们是被业务码匹配的字符串，不是符号引用）；③ 用户遇到本应由平台拦截的内容时，行为与预期不一致。

**Mitigation**:

- Step 0 的判据表已把 3007 列入"直连即判收窄"的触发结果之一 —— 即**遇到 3007 就停手**，不进入全量断开的讨论。
- 若最终收窄，3007 错误路径**保持有效**（套餐仍走网关），无需清理 —— 这反而使收窄方案的改动面更小。
- 若最终全量断开，必须**显式处理 3007 相关路径**：在提交信息中说明其失效，并在 F-006（死代码清理）中单独列出，不用 knip 兜底。

### [Risk] 临时开关残留进产物

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 4 × 3 × (1 − 0.5) = **6.0 — MEDIUM**

**Failure Scenario**：Step 0 需要加一个临时 env 开关禁用网关改写。若该开关被遗忘在代码里并随版本发布，它就成了一个**可以关掉平台网关的公开后门** —— 任何用户设一个环境变量即可绕过套餐校验与安全审核。而它长得像一个正常的调试开关，代码审查时极易滑过。

**Mitigation**:

- 开关**只用于 Step 0 验证，在 Step 1 的提交中必须不存在**：提交前 `git diff` 自查 + grep 开关名，确认无残留。
- 若收窄方案落地，收窄的**实现方式是路由表取舍**（保留 `OFFICIAL_CODING_PLAN_GATEWAY_ROUTES` 并逐条决定去留），**不是保留一个运行时开关** —— 这样没有"可关掉"的状态。
- Do 章静态闸门追加一条：`grep -rn "<开关名>" apps packages` 必须无结果。

### [Risk] "收窄"成为永久状态，F-101 的交付被误读为已完成

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 4 × 4 × (1 − 0.4) = **9.6 — MEDIUM-HIGH**

**Failure Scenario**：若 Step 0 判为"不确定"（很可能 —— 团队未必持有套餐 key），安全默认会把 F-101 收窄为"只对非套餐厂商断开"。于是：① 你原始诉求中的"运行时零回连"**对套餐厂商不成立**；② 指标 Goal 第 3 条被改写成"非套餐请求占比 = 0%"，读起来像达标了，**实际是把未达成的那部分从指标里移了出去**；③ 下一个人看到 Goal 全绿，以为这件事做完了，不会再碰 —— **痛点 B 对最大的那部分用户群长期存留**。

**Mitigation**:

- 加固版 Step 0 已要求收窄时**产出两件可交付物**：`OFFICIAL_CODING_PLAN_GATEWAY_ROUTES` 加注释说明其为协议要求；痛点文档 §9 新增**已决范围变更记录**，明确写出"运行时零回连对套餐厂商不成立及原因"。**这两件是收窄的前置条件，不是可选项。**
- 收窄后的 Goal 表述必须**同时保留分母**：写"非套餐请求经 zcode.z.ai 占比 = 0%（套餐请求仍经网关，原因见 §9）"，而不是只留前半句。
- 若 Step 0 判为不确定，**立一条后续工作项**："取得套餐 key 证据后复评 F-101"，避免它消失在完成态里。

### [Risk] Step 0 被阻塞：拿不到套餐 key 导致 Phase 1 停摆

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.7
**Risk Score**: 3 × 4 × (1 − 0.7) = **3.6 — LOW**

**Failure Scenario**：Step 0 是 Step 1 的硬闸。若团队一时拿不到套餐 key（无套餐账号 / 需商务协调），闸门无法得出"可直连"结论，Step 1 被无限期阻塞，**而 Phase 1 的其余三个 P0 被误认为必须等待**。实际它们与 Step 0 结论无关。

**Mitigation**:

- 已明确：**Step 0 只阻断 Step 1**，F-001 / F-002 / F-003 照常推进，不受影响 —— 此点需在开工时明确告知执行者，避免整条 Phase 1 被一个闸门卡住。
- "不确定 → 收窄"的安全默认本身就是**解阻塞机制**：拿不到 key 不等于停摆，等于按收窄推进并挂一条后续项。

---

**Pre-mortem 完成（第 3 轮，已收敛）**：加固后 **HIGH RISK = 0 项**。

**迭代记录**

| 轮次 | 本轮新发现                                                            | HIGH 数（累计）        |
| ---- | --------------------------------------------------------------------- | ---------------------- |
| 1    | 风险 1–14（含 3 项 HIGH）                                             | 3                      |
| 2    | Step 0 引入的 5 项新风险（含"假绿"1 项 HIGH）；补获 `3007` 代码级反证 | 1（原 3 项经加固降级） |
| 3    | 无新增 HIGH                                                           | **0**                  |

**收敛判据**：第 3 轮遍历技术 / 组织 / 外部三类后未产生任何 Risk Score > 12 的新条目，且原 3 项 HIGH 均因 Step 0 加固而使**残余风险降至 12 以下**。

> **关于降分的诚实说明**：三项 HIGH 的降分主要来自 **Detectability 提升**，而非严重性或可能性下降 —— 即「把未知量在任何不可逆动作之前消解掉」。代价是 F-101 的**交付范围变小**（很可能收窄为"只对非套餐厂商"），这是范围缩小而非事故，且已由风险 N4 的缓解措施要求**显式记录**。若你要的是"套餐厂商也必须零回连"，那需要的是与平台侧确认而非代码改动 —— 这已超出本计划范围。

**本次 pre-mortem 对计划的结构性改动（4 处）**：

1. **新增并二次加固 Step 0 前置验证关卡**，阻断 Step 1（风险 1、2、3 与"假绿"的缓解）。
2. **撤销"Step 1 同批处理 `zcode-builtin.json`"**，恢复 Step 1 的独立可回滚性（风险 11 的缓解）。
3. **`doctor.ts` 提升为 Step 2 / Step 4 的必改文件**（风险 7 的缓解）。
4. **Step 1 补充"代理语义变更"记录项**（风险 13 的缓解）。

**HIGH RISK 速查（加固前 → 加固后）**：

| #   | 风险                                                          | 加固前 | 加固后  | 关键缓解                                                              |
| --- | ------------------------------------------------------------- | ------ | ------- | --------------------------------------------------------------------- |
| 1   | 网关承载鉴权，断掉后套餐 401 / 3007                           | 14.0   | **2.0** | Step 0 前置关卡（真实客户端 + key 来源校验 + 双路由）；不确定即判收窄 |
| 2   | 计费归属随网关消失，静默跌入按量付费                          | 12.0   | **4.5** | Step 0 比对用量/额度字段；该分支直接升级为需你确认的范围变更          |
| 3   | 开发者 `.env` 是第一个受害者，症状被误判                      | 11.2   | **0.8** | Step 0 在改动前用真实客户端跑通两种状态                               |
| 0   | Step 0 自身假绿（错 key / 裸 curl / 单路由）_（第 2 轮新增）_ | 14.0   | **3.0** | 四个测试前提 + 安全默认 + 证据落盘                                    |

> **执行顺序上的唯一硬约束**：Step 0 未通过（或未执行）时，**Step 1 不得合入**；但 **Step 0 只阻断 Step 1** —— F-001 / F-002 / F-003 与 Step 0 结论无关，可并行推进。若 Step 0 判定"套餐必须经网关"，只有 F-101 收窄，Phase 1 其余 P0 不受影响。

> Next step: 开工前先 `git switch -c feat/remove-login-zai-coupling`；然后执行 Step 0（它需要在 `official-coding-plan-gateway.ts:53-68` 加一个**临时**开关，测完即删），而不是原稿写的裸 curl。
