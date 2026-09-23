# Step 0 证据记录：网关是"多余的一跳"还是"必需的一跳"

> 来源计划：`docs/plan-remove-login-zai-coupling.md` 的 Phase 1 Step 0。
> 执行时间：2026-09-22 ｜ 分支：`feat/remove-login-zai-coupling`
> 结论：**route #1 上网关不是鉴权所必需 —— 套餐 key 直连可用。** 据此执行全量断开（两条路由）。

本文件是**一次性人工验证的记录**，不含明文凭据。Step 10（F-007）会把它固化为可执行断言。

---

## 1. 目的

判定 `official-coding-plan-gateway.ts` 的端点改写是"多余的一跳"（可安全移除）还是"必需的一跳"
（承载鉴权 / 计费归属 / 内容安全校验，不可移除）。该判定阻断 Step 1。

**先验反证（预设应当"网关必需"）**：`3007`（`model-execution.ts:450,605`、
`failure-provider-business-codes.ts:100`）被注释为「zcode-plan 安全校验拒绝」，是网关独有、
直连厂商端点不可能产生的业务码。因此初始假设为"网关必需"，本测试的任务是**推翻**它。

## 2. 前提闭合情况

| #   | 前提                     | 状态        | 依据                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ①   | key 来源与受影响用户一致 | ✅          | `~/.zcode/v2/credentials.json` 仅有 `account-provider:*` 键、无 `oauth:*` 键 → 由 `configureCodingPlanApiKey`（非登录路径）写入。`~/.zcode/v2/provider_config.json` 的 `defaultModelSelection.providerId` = `account:bigmodel-individual-coding-plan`，即运行时走账号型 provider + 凭据库。该 key 在 `/api/anthropic` 可用（**套餐**端点；标准 key 走 `/api/paas/v4`）→ 确属套餐 key |
| ②   | 走真实客户端，非裸 curl  | ✅          | 用 `node apps/zcode-cli/packages/cli/dist/zcode.cjs -p ...` 真实调用；探针打在 `resolveOfficialCodingPlanGatewayUrl` 入口与各返回分支                                                                                                                                                                                                                                                |
| ③   | 两条路由都测             | ⚠️ **部分** | 仅测 route #1（`bigmodel`）。route #2（`api.z.ai`）在本机**无 zai 套餐凭据，不可测**                                                                                                                                                                                                                                                                                                 |
| ④   | 临时开关测完即删         | ✅          | 探针随 Step 1 删除 `official-coding-plan-gateway.ts` 一并消失（该文件即探针所在处）                                                                                                                                                                                                                                                                                                  |

## 3. 方法

在 `official-coding-plan-gateway.ts` 的 `resolveOfficialCodingPlanGatewayUrl` 中临时插桩：

- 入口打印实际请求 URL 与路由表比较键；
- 命中路由时打印改写前 → 改写后 URL；
- 提供 `ZCODE_DEBUG_S0_DISABLE_GATEWAY=1` 强制 `viaGateway=false`，用于取得"直连"状态。

两种状态下各跑一次最小请求，比对实际 URL、退出码、响应与用量元数据。

> **构建注意**：`pnpm --filter @zcode/cli build` **不会重建 `@zcode/adapters`**，
> 插桩不会进入 bundle。必须用全量 `pnpm run build`。
> 本次执行曾因此对着旧二进制得出"探针未触发"的错误结论，改用全量构建后复现正常。
> 建议在计划 Do 章的构建闸门中注明此点。

## 4. 结果

| 状态             | 实际请求 URL                                                                                                              | 退出码 | 响应   |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ------ | ------ |
| 网关 ON（默认）  | `https://open.bigmodel.cn/api/anthropic/v1/messages` → **改写** → `https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages` | 0      | `PONG` |
| 网关 OFF（直连） | `https://open.bigmodel.cn/api/anthropic/v1/messages`（**未改写**）                                                        | 0      | `PONG` |

原始探针输出：

```
[DEBUG-S0-] entry url=https://open.bigmodel.cn/api/anthropic/v1/messages
[DEBUG-S0-] viaGateway=true from=https://open.bigmodel.cn/api/anthropic/v1/messages to=https://zcode.z.ai/api/v1/ultra/anthropic/v1/messages
```

```
[DEBUG-S0-] entry url=https://open.bigmodel.cn/api/anthropic/v1/messages
[DEBUG-S0-] viaGateway=false url=https://open.bigmodel.cn/api/anthropic/v1/messages reason=forced-off
```

用量元数据比对（`model_usage` 表，按时间序对应上述两次运行）：

| 运行     | 状态    | input | output | raw_usage 字段集                                                        | provider_metadata                |
| -------- | ------- | ----- | ------ | ----------------------------------------------------------------------- | -------------------------------- |
| 16:01:08 | 网关 ON | 34406 | 41     | `inputTokens/outputTokens/totalTokens/cacheReadTokens/cacheWriteTokens` | `{"rawFinishReason":"end_turn"}` |
| 16:02:11 | 直连    | 34406 | 4      | **同上，字段集完全一致**                                                | **同上**                         |

> 两次 output 差异（41 vs 4）系模型对同一提示的输出长度不同，非链路差异。
> 输入 token 数一致（34406），缓存读一致（34368）。

## 5. 结论

**route #1 成立**：套餐 key 直连 `open.bigmodel.cn/api/anthropic` 可用，且用量元数据结构与经网关时**完全一致**
（客户端侧记账无差异）。→ **网关在 route #1 上不是鉴权所必需。**

**route #2（`api.z.ai`）未实测**。结构对称性依据：内置清单中 `zai-api` 模板与 `bigmodel-api` 模板同为
`access.type = zhipu-coding-plan-api-key`（即"用户直接提供一串 key"），声明该端点同样接受用户直供 key。

**决策**：经确认，**全量断开两条路由**。

## 6. 已接受的取舍（未闭合项）

执行全量断开后，以下三点**不再成立或无法验证**，明确记录以备复评：

1. **平台侧计费归属未经证实**。客户端侧 usage 元数据一致，但**平台是否按直连正常扣减套餐额度无法从客户端验证**。
   如需确证，须向平台侧确认，属计划 Out of Scope。
2. **`3007`（zcode-plan 安全校验拒绝）不再触发**。直连绕过平台内容安全校验。相关错误路径
   （`model-execution.ts:450,605`、`failure-classifier.ts:160`、`failure-provider-business-codes.ts:100`）
   将退化为死代码，由 Step 9（F-006）显式处理，**不依赖 knip 兜底**（它们是被业务码匹配的字符串，非符号引用）。
3. **route #2 未经实测**。依赖上述结构对称性推定。

## 7. 复现步骤

改回网关改写（见 git 历史中的 `official-coding-plan-gateway.ts`）后：

```bash
pnpm run build                      # 必须全量：filter 构建不会重建 adapters
node apps/zcode-cli/packages/cli/dist/zcode.cjs -p "Reply with exactly: PONG" \
  --disallowed-tools Bash Edit Write Read Glob Grep WebFetch WebSearch Task
ZCODE_DEBUG_S0_DISABLE_GATEWAY=1 node apps/zcode-cli/packages/cli/dist/zcode.cjs -p "..." # 直连状态
```

对照 stderr 中的 `[DEBUG-S0-]` 行即可确认两种状态下的实际请求 URL。
