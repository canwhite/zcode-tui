# Plan: 全局重命名 zcode → qcode + 蓝紫色主题

> 将所有 `zcode` 字符串替换为 `qcode`，目录 `apps/zcode-cli/` 改名为 `apps/qcode-cli/`，npm scope `@zcode/*` 改为 `@qcode/*`，主题色调整为 `#6366F1`。

## Context

用户痛点（来源：`docs/painpoint-qcode-rename.md`）：代码中多处硬编码的 `zcode` 字符串分散在多个子包中，品牌定制需要统一替换为 `qcode`，同时将 TUI 主题色调整为蓝紫色系。澄清结果：目录名同步改、npm scope 同步改、目标色值 `#6366F1`（Indigo 蓝紫）。

## Goal

- 所有源码文件中无 `zcode` 残留字符串（Symbol 键、agentName、tokenizer 标识符、包名等均已替换为 `qcode`）
- `apps/zcode-cli/` 目录改名为 `apps/qcode-cli/`
- npm scope `@zcode/*` 全部迁移为 `@qcode/*`
- TUI 主题色为蓝紫渐变（`#6366F1` → `#8B5CF6`），支持渐变色变量
- `pnpm build` 成功，`pnpm typecheck` 零错误，`qcode --version` 正常输出

## Plan

### Step 1: 提交基线快照

```bash
cd /Users/doing/Desktop/zcode-tui
git add -A
git commit -m "chore: baseline before zcode→qcode rename"
```

**理由**：大规模重命名是高风险操作，先留快照便于回滚。

---

### Step 2: 全局字符串替换（zcode → qcode）

在以下文件类型中执行精确匹配替换（word boundary，防止误替换如 `ozcode`）：

```bash
# 精确替换（不替换 ozcode 等情况）
# 替换范围：.ts .tsx .json .md（排除 node_modules、.turbo/cache、dist/）

grep -rl '"zcode\|'\''zcode\|zcode/' --include="*.ts" --include="*.tsx" --include="*.json" \
  apps/ packages/ tools/ scripts/ \
  | grep -v node_modules | grep -v ".turbo" | grep -v "/dist" \
  | xargs sed -i '' \
    -e 's/"zcode\//"qcode\//g' \
    -e 's/'\''zcode\//'\''qcode\//g' \
    -e 's/"zcode"/"qcode"/g' \
    -e 's/'\''zcode'\''/'\''qcode'\''/g' \
    -e 's/Symbol\.for("zcode\./Symbol.for("qcode./g' \
    -e 's/zcode-agent/qcode-agent/g' \
    -e 's/zcode\.estimateTokens\.v1/qcode.estimateTokens.v1/g' \
    -e 's/zcode-cli/qcode-cli/g' \
    -e 's/zcode_desktop/qcode_desktop/g' \
    -e 's/zcode-node-repl/qcode-node-repl/g' \
    -e 's/"zcode"/"qcode"/gi' \
    -e "s/'zcode'/'qcode'/gi"
```

**需特别处理的文件子集**（grep 验证后手动确认）：

| 文件 | 替换内容 | 确认要点 |
|------|----------|----------|
| `apps/zcode-cli/package.json` | `"name": "zcode-cli"` → `"name": "qcode-cli"` | npm 包名 |
| `apps/zcode-cli/turbo.json` | `@zcode/*` → `@qcode/*`，`zcode-builtin.json` → `qcode-builtin.json` | turbo 依赖图 |
| `.oxlintrc.json` | `apps/zcode-cli` → `apps/qcode-cli` | lint 忽略路径 |
| `AGENTS.md` | `zcode CLI` → `qcode CLI` 等引用 | 文档字符串 |
| `docs/dependency-boundary.md` | `zcode` 引用 | 边界文档 |

**替换完成后必检**：

```bash
# 验证无 zcode 残留（排除 .git 历史）
grep -r "zcode" apps/ packages/ tools/ scripts/ \
  --include="*.ts" --include="*.tsx" --include="*.json" --include="*.md" \
  | grep -v node_modules | grep -v ".turbo" | grep -v "/dist" | grep -v "\.git"
# 期望：无输出
```

---

### Step 3: 目录重命名

```bash
# 重命名目录
mv apps/zcode-cli apps/qcode-cli

# 更新所有内部路径引用（grep 确认后再执行 sed）
grep -rl "apps/zcode-cli" --include="*.json" --include="*.md" . \
  | grep -v node_modules | grep -v ".git" \
  | xargs sed -i '' 's|apps/zcode-cli|apps/qcode-cli|g'
```

**验证**：

```bash
# 确认 apps/zcode-cli 不存在
ls apps/zcode-cli 2>&1 | grep -q "No such file" && echo "✓ 目录已改名" || echo "✗ 目录仍存在"
# 确认 apps/qcode-cli 存在
ls apps/qcode-cli/package.json && echo "✓ 新目录存在"
```

---

### Step 4: 更新 turbo.json 依赖图

`apps/qcode-cli/turbo.json` 中的依赖引用已随 Step 2 的 sed 替换为 `@qcode/*`，但需确认：

```bash
grep "zcode" apps/qcode-cli/turbo.json
# 期望：无输出
```

如仍有残留，手动替换：

```bash
# turbo.json 中 zcode-builtin.json 等文件名引用
sed -i '' 's/zcode-builtin/qcode-builtin/g' apps/qcode-cli/turbo.json
```

---

### Step 5: 更新 .oxlintrc.json

```bash
sed -i '' 's|apps/zcode-cli|apps/qcode-cli|g' /Users/doing/Desktop/zcode-tui/.oxlintrc.json
# 验证
grep "qcode-cli" /Users/doing/Desktop/zcode-tui/.oxlintrc.json
```

---

### Step 6: 同步更新其他配置文件

**`packages/provider-node/src/zcode-builtin-release.ts`** → 重命名为 `qcode-builtin-release.ts` 并更新内部引用。

**CI 配置**（如有 `.github/workflows/*.yml`）：

```bash
grep -rl "zcode-cli\|@zcode" .github --include="*.yml" --include="*.yaml" \
  | xargs sed -i '' \
    -e 's/zcode-cli/qcode-cli/g' \
    -e 's/@zcode\//@qcode\//g'
```

---

### Step 7: 主题色调整为蓝紫渐变

**目标**：用户感知以蓝紫色调为主（primary 色从 sky blue 改为蓝紫 `#6366F1`）。

```bash
# 查找主题配置文件
ls apps/qcode-cli/packages/tui/src/theme/
```

**替换策略**（已综合 Risk #26 缓解方案）：

- **primary / secondary / accent** 三个字段统一更新为蓝紫色系：
  - `DARK_TUI_THEME.primary`: `"#7dd3fc"` → `"#6366F1"`（蓝紫）
  - `DARK_TUI_THEME.secondary`: `"#c4b5fd"` → `"#8B5CF6"`（紫）
  - `DARK_TUI_THEME.accent`: `"#7dd3fc"` → `"#818CF8"`（浅蓝紫）
  - `LIGHT_TUI_THEME.primary`: `"#0369a1"` → `"#6366F1"`
  - `LIGHT_TUI_THEME.secondary`: `"#7c3aed"` → `"#8B5CF6"`
  - `LIGHT_TUI_THEME.accent`: `"#0369a1"` → `"#818CF8"`
- **不修改 background 字段**（保持对比度，避免背景色压制蓝紫感知）
- **如需背景渐变**：在 `TuiThemeTokens` 中新增可选字段 `backgroundGradient?: { from: string; to: string; direction: string }`，在渲染层判断并绘制渐变；暂不实现（Phase 2 候选）

**验证**：启动 TUI，肉眼确认 primary/accent 色为蓝紫色，文字与按钮可辨识。

---

### Step 8: 验证

```bash
# 类型检查
cd /Users/doing/Desktop/zcode-tui
pnpm typecheck

# 构建
pnpm build

# CLI 启动验证
./apps/qcode-cli/dist/qcode.js --version
# 或 pnpm --filter qcode-cli exec qcode --version
```

---

## Think — Debug Methodology

**高风险点**：大规模 sed 替换可能误伤或遗漏，目录改名后 import path 可能断裂。

- **替换后**：立即运行 `grep -r "zcode" apps/qcode-cli --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v dist` 确认零残留
- **目录改名后**：运行 `pnpm build`，观察是否有 import path 报错（路径仍引用 `apps/zcode-cli`）
- **构建失败**：优先检查 turbo.json 和 package.json 的 name 字段是否同步更新
- **CLI 启动失败**：检查 `bin` 字段是否指向正确路径

**符号约定**：`[RENAME-CHECK]` 作为本任务的 debug prefix，方便清除：

```bash
grep -r "\[RENAME-CHECK\]" apps/qcode-cli/
```

---

## Do — Verification Strategy

| 验证步骤 | 命令 | 通过标准 |
|----------|------|----------|
| zcode 残留检查 | `grep -r "zcode" apps/qcode-cli --include="*.ts" --include="*.tsx" --include="*.json" \| grep -v node_modules \| grep -v dist \| grep -v ".git"` | 无输出 |
| 类型检查 | `pnpm typecheck` | 零错误 |
| 构建 | `pnpm build` | 退出码 0 |
| CLI 启动 | `./apps/qcode-cli/dist/qcode.js --version` | 正常输出版本号 |
| 主题色 | 启动 TUI | 肉眼确认为 #6366F1 蓝紫色 |

---

## Adjust — Rollback and Global Scan

**回滚方案**：

```bash
git checkout HEAD -- .
git clean -fd apps/qcode-cli
mv apps/zcode-cli apps/qcode-cli 2>/dev/null || true
```

**全局扫描**（替换后检查以下同类位置）：

- `packages/*/package.json` 中是否还有 `@zcode/` scope
- `.github/workflows/` 中 CI 配置是否已更新
- `README*.md` 中 `zcode-cli` 命令示例是否已更新
- `docs/` 中引用 `zcode` 的文档是否已更新

**兼容性**：本次为品牌重命名，无向后兼容需求（外部无依赖方）。

---

## Open Questions

1. **git 历史清理**：已有提交中的 `zcode` 是否需要清理（`git filter-branch`）？当前计划不清理历史。
2. **Symbol.for() 跨进程影响**：Symbol 键从 `zcode.xxx` 改为 `qcode.xxx` 后，已安装版本的旧 CLI 与新 CLI 通信可能不兼容。已在新 CLI 构建后通过版本号隔离，无直接兼容问题。

---

## Out of Scope

- `.git` 历史中的 zcode 字符串清理
- `node_modules` 中的依赖包重命名
- 其他产品的 zcode 引用（如 docs/ 中与 zcode 无关的引用）
- 已有用户数据中的 zcode 残留

---

## Pre-Mortem Risks

### [Risk #4] 目录改名后 import path 未全量更新，运行时 Module not found

**Severity**: 5 | **Likelihood**: 2 | **Detectability**: 0.7
**Risk Score**: 3.0（已缓解）

**Failure Scenario**: `mv apps/zcode-cli apps/qcode-cli` 执行后，代码库中仍有文件通过相对路径 `../../apps/zcode-cli/...` 或绝对路径 `/Users/doing/Desktop/zcode-tui/apps/zcode-cli/...` 引用旧目录，构建时 turbo 找不到 `apps/qcode-cli`，pnpm workspace 解析失败，所有包报 `Module not found`。

**Mitigation**:
- **Step 2 的 sed 替换必须先于目录重命名执行**，确保所有源码内的 import path 已替换为 `apps/qcode-cli`
- **Step 3 目录改名后**，立即运行以下验证命令：
  ```bash
  # 确认无残留的旧目录引用
  grep -r "apps/zcode-cli" apps/ packages/ tools/ --include="*.ts" --include="*.tsx" --include="*.json" | grep -v node_modules
  # 期望：无输出
  ```
- **Step 8 构建前**，先执行 `pnpm install` 重新生成 pnpm-lock.yaml，确保 workspace 配置解析到新目录路径
- **回滚触发器**：如果 `pnpm build` 报 `Module not found` 或 workspace 解析错误，立即 `git stash` 后检查 sed 替换范围是否遗漏了 import path 类型的引用（如 `from "zcode-cli/..."` 或 `from "@zcode/cli"`）

### [Risk #13] turbo.json inputs 硬编码 zcode 文件名，与实际文件名不同步

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.3
**Risk Score**: 17.5

**Failure Scenario**：`turbo.json` 中 `build:desktop-agent` 和 `@zcode/cli#build` 两个 task 的 inputs 数组硬编码了 `"$TURBO_ROOT$/../../config/provider/zcode-builtin.json"` 和 `"$TURBO_ROOT$/../../packages/provider-node/src/zcode-builtin-release.ts"` 等文件路径。sed 替换将 turbo.json 内容中的 `@zcode/` 依赖引用改为了 `@qcode/`，但 inputs 中的具体文件名 `"zcode-builtin.json"` 和 `"zcode-builtin-release.ts"` **不会被 sed 改到**（因为 sed 替换的是 `"zcode` 字符串，而文件名是 `zcode-builtin`，中间是 `-` 不是引号）。改名后文件变为 `qcode-builtin.json`，但 turbo.json 仍引用 `zcode-builtin.json`，构建失败。

**Mitigation**：
- **Step 6（turbo.json 更新）中增加显式文件名替换**：
  ```bash
  # 将 turbo.json 中所有 zcode-builtin 文件名替换为 qcode-builtin
  sed -i '' 's/zcode-builtin/qcode-builtin/g' apps/qcode-cli/turbo.json
  # 验证无 zcode-builtin 残留
  grep "zcode-builtin" apps/qcode-cli/turbo.json
  # 期望：无输出
  ```
- 同理检查 `packages/provider-node/src/zcode-builtin-*.ts` 文件名是否需要重命名（见 Risk #14）

### [Risk #14] provider-node/src/ 下 6 个文件名含 zcode，sed 只改内容不改文件名

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.3
**Risk Score**: 17.5

**Failure Scenario**：`packages/provider-node/src/` 下有 6 个源文件：`zcode-builtin-release.ts`、`zcode-builtin-cache-paths.ts`、`zcode-builtin-provider-config-source.ts`、`zcode-builtin-provider-config-materializer.ts`、`zcode-builtin-remote-synchronizer.ts`、`zcode-builtin-download.ts`。sed 替换了文件内容中的 `zcode` 字符串，但 **文件名本身不会被 sed 修改**。改名后这些文件仍叫 `zcode-builtin-*.ts`，而其他代码的 import 路径（如 `from "@zcode/provider-node/zcode-builtin-release"`）已被替换为 `@qcode/provider-node/qcode-builtin-release`，导致 Module not found。

**Mitigation**：
- **Step 6 中增加文件名重命名**：
  ```bash
  cd packages/provider-node/src/
  for f in zcode-builtin-*.ts; do
    mv "$f" "${f//zcode-builtin/qcode-builtin}"
  done
  # 验证无 zcode-builtin 文件残留
  ls zcode-builtin-*.ts 2>&1 | grep -q "No such file" && echo "✓" || echo "✗ 仍有残留"
  cd -
  # 同步更新 config/provider/zcode-builtin.json → qcode-builtin.json
  mv config/provider/zcode-builtin.json config/provider/qcode-builtin.json
  # 同步更新 apps/qcode-cli/packages/cli/dist/provider/zcode-builtin.json
  mv apps/qcode-cli/packages/cli/dist/provider/zcode-builtin.json \
     apps/qcode-cli/packages/cli/dist/provider/qcode-builtin.json 2>/dev/null || true
  ```

### [Risk #15] config/provider/zcode-builtin.json 文件名未改，但 turbo.json inputs 引用它

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.3
**Risk Score**: 17.5

**Failure Scenario**：与 Risk #13/#14 联动。`config/provider/zcode-builtin.json` 是 turbo.json 中 `build:desktop-agent` task 的输入文件之一。如果只改了 turbo.json 中的引用路径（`zcode-builtin.json` → `qcode-builtin.json`），但实际文件仍叫 `zcode-builtin.json`，turbo 在执行该 task 时会报错 "file not found"，构建中断。反过来，如果只改了文件名但 turbo.json 未更新，构建同样失败。两者必须同步。

**Mitigation**：
- **将文件名重命名与 turbo.json 更新放在同一原子步骤中**（见 Risk #13 和 #14 的 mitigation 命令）；任何一步失败则立即回滚整个步骤

### [Risk #21] packages/shared/src/ 下 20+ 文件的 ZCODE_* 常量未被 sed 全部覆盖

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.3
**Risk Score**: 17.5

**Failure Scenario**：`packages/shared/src/` 下散布大量 `ZCODE_*` 标识符常量，包括但不限于：`ZCODE_RPC_CLIENT_MODE_HEADER = "x-zcode-rpc-client-mode"`、`ZCODE_DYNAMIC_WORKFLOW_MODE_ENV = "ZCODE_DYNAMIC_WORKFLOW_MODE"`、`ZCODE_OFFICIAL_PLUGIN_MARKETPLACE_ID = "zcode-plugins-official"`、`ZCODE_JWT_INVALID_BROADCAST_CHANNEL`、`ZCODE_SERVICE_AUTHORITY_MODE_ENV`、`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV` 等。这些标识符在 sed 替换规则 `s/"zcode/QCODE/` 下不会被匹配（因为它们不是以 `"zcode` 开头的字符串字面量）。改名后：HTTP header 名称不匹配导致 RPC 握手失败、BroadcastChannel 名称不匹配导致 JWT 失效广播失效、env var 名称不匹配导致配置读取 fallback 到默认值——全部是静默故障，无报错但逻辑全错。

**Mitigation**：
- **Step 2 sed 替换后，增加专项 grep 验证**：
  ```bash
  # 验证 packages/shared/src/ 下无 ZCODE_ 前缀的标识符残留（排除版本号等无害常量）
  grep -rn "ZCODE_" /Users/doing/Desktop/zcode-tui/packages/shared/src/ \
    --include="*.ts" --include="*.tsx" \
    | grep -v "node_modules\|dist\|__ZCODE\|__zcode" \
    | grep -v "ZCODE_VERSION\|ZCODE_COMMIT\|ZCODE_BUILD_TIME\|ZCODE_PROTOCOL_VERSION\|ZCODE_PROTOCOL_V4_WIRE_VERSION\|ZCODE_MCP_RESOURCE_SAMPLE_INTERVAL_MS\|ZCODE_WORKFLOWS_RUNS_MAX_LIMIT\|ZCODE_SESSION_RUNTIME_PREFERENCES_REQUEST_TIMEOUT_MS\|ZCODE_FILE_LOCK_TIMEOUT_ERROR_CODE\|ZCODE_AGENT_PROVIDER_NOT_READY_CODE\|ZCODE_CLI_RESOURCE_SAMPLE_INTERVAL_MS\|ZCODE_UGREP_BINARY\|ZCODE_RG_BINARY\|ZCODE_BFS_BINARY\|ZCODE_PROVIDERS"
  # 期望：无输出（或仅 harmless 版本号常量）
  ```
- **手动审查 `packages/shared/src/` 下的每个 ZCODE_* 常量**，确认其字符串值（如 env var 名、HTTP header 名、plugin ID）是否需要同步改名
- **关键项必须单独处理**：
  - `runtimeEnv.ts`：所有 `ZCODE_*_ENV_KEY` 常量的**字符串值**必须改为 `QCODE_*`
  - `runtime-paths.ts`：`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV` 等的**字符串值**必须改为 `QCODE_*`
  - `zcode-protocol/index.ts`：`ZCODE_PROTOCOL_NAME = "ZCode Protocol"` 等可保留（显示名称），但 `ZCODE_RPC_CLIENT_MODE_HEADER = "x-zcode-rpc-client-mode"` 必须改
  - `channels.ts`：`x-zcode-rpc-*` HTTP header 必须改为 `x-qcode-rpc-*`
  - `plugin-marketplaces.ts`：`zcode-plugins-official` plugin ID 必须改为 `qcode-plugins-official`

### [Risk #19] ZCODE_ENV env var 注入与代码引用不同步

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 12.5

**Failure Scenario**：`packages/shared/src/env.ts` 导出 `ZCODE_ENV`，turbo.json 中 task 有 `env: ["ZCODE_ENV"]`。sed 替换会将 `ZCODE_ENV` 变量引用改为 `QCODE_ENV`，turbo.json 中的 `env` 数组也可能被 sed 改为 `["QCODE_ENV"]`——但若 turbo.json 中的 `"ZCODE_ENV"` 字符串因格式问题未被 sed 匹配到（引号边界问题），则构建时 turbo 向进程注入的仍是 `ZCODE_ENV=...`，而代码已改名为 `QCODE_ENV`，环境判断逻辑全走错分支（静默故障，无报错）。

**Mitigation**：
- Step 6 中对 turbo.json 执行以下验证：
  ```bash
  # 确认 env 数组中无 ZCODE_ENV 残留
  grep -n "ZCODE_ENV\|QCODE_ENV" apps/qcode-cli/turbo.json
  # 期望：所有出现均为 QCODE_ENV，无 ZCODE_ENV
  ```
- 同步检查 `packages/shared/src/env.ts` 中的 `__ZCODE_ENV__` 编译时常量（需确保全局替换覆盖了此符号）

### [Risk #20] ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV 字符串值未同步

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 12.5

**Failure Scenario**：`packages/provider-node/src/runtime-paths.ts` 中定义 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"`。sed 替换将变量名 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV` 改为了 `QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV`，但等号右边的**字符串字面量** `"ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"` 如果没被 sed 匹配到（因为它在引号内），则变量值为 `"ZCODE_..."` 而非 `"QCODE_..."`。结果：代码读取 `process.env["ZCODE_BUILTIN_PROVIDER_CONFIG_FILE"]`，但实际 env 中已改名为 `QCODE_BUILTIN_PROVIDER_CONFIG_FILE`，config 文件路径查找静默失败，fallback 到错误默认值。

**Mitigation**：
- Step 6 中对 `runtime-paths.ts` 增加显式字符串替换：
  ```bash
  sed -i '' 's/ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV/QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV/g' \
         packages/provider-node/src/runtime-paths.ts
  # 验证字符串值也被替换
  grep "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE" packages/provider-node/src/runtime-paths.ts
  # 期望：无输出（字符串值也已改为 QCODE_...）
  ```
- 验证 `process.env["QCODE_BUILTIN_PROVIDER_CONFIG_FILE"]` 在运行时可正确读取 config 文件路径

### [Risk #23] URL 字符串中的 zcode.z.ai 被替换为不存在的 qcode.z.ai

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.1
**Risk Score**: 22.5

**Failure Scenario**：`sed 's/"zcode"/"qcode"/gi'` 会无差别地替换所有 `"zcode"` 字符串，包括 URL 字面量 `"https://zcode.z.ai"`、`"https://cdn-zcode.z.ai/zcode/official-plugin/..."`。替换后这些 URL 变为 `"https://qcode.z.ai"`，但 `qcode.z.ai` 这个 DNS 域名**不存在或未解析到正确地址**。结果：所有默认 endpoint 调用（认证、token 交换、插件市场查询）全部 404 或 DNS 解析失败，是影响核心功能的灾难性故障。

**Mitigation**：
- **Step 2 的 sed 命令中增加排除规则**：URL 字符串（`https://` 后、`http://` 后）中的 zcode 不参与替换：
  ```bash
  # 使用否定 lookahead 保留 URL 中的 zcode 域名
  grep -rl '"zcode\|'\''zcode\|zcode/' --include="*.ts" --include="*.tsx" --include="*.json" \
    apps/ packages/ tools/ scripts/ \
    | grep -v node_modules | grep -v ".turbo" | grep -v "/dist" \
    | xargs sed -i '' \
      -e 's|"zcode\([^./]\)|"qcode\1|g' \    # zcode 后面不是 / 或 . 才替换（保护 URL）
      -e "s|'zcode\([^./]\)|'qcode\1|g" \
      # 剩余规则不变...
  ```
- **更安全的方案——手动审查所有含 URL 的文件**：
  ```bash
  # 找出所有含 https://zcode 或 https://cdn-zcode 的文件
  grep -rl "https://zcode\|https://cdn-zcode" --include="*.ts" --include="*.tsx" --include="*.json" \
    apps/ packages/ \
    | grep -v node_modules | grep -v ".turbo" | grep -v "/dist"
  ```
  对这些文件手动确认：哪些是外部服务 URL（不可改），哪些是内部 path（需要改）
- **明确哪些字符串必须保留不变**：
  - `https://zcode.z.ai`（默认 API endpoint）
  - `https://cdn-zcode.z.ai`（插件 CDN）
  - `https://zcode.ai`（官网）
  - `.z.ai` 域名相关所有字符串
- **如果确实需要改域名**（如同时迁移 DNS），则需要先确认 `qcode.z.ai` 等域名已购买并解析到位，再执行替换

### [Risk #26] DARK 模式背景极深，蓝色渐变不可见；将 CSS 渐变字符串写入颜色字段会破坏渲染

**Severity**: 4 | **Likelihood**: 5 | **Detectability**: 0.3
**Risk Score**: 14.0

**Failure Scenario**：`DARK_TUI_THEME.background = "#0f1419"`（近黑），在此背景上应用 `linear-gradient(135deg, #6366F1, #8B5CF6)` **完全不可见**——渐变色被淹没在极深背景中，用户看不到任何蓝紫色感知。同时，`TuiThemeTokens.background` 是 `string` 类型，组件中可能对该字段做单色解析（如取 `background.split(" ")[0]` 取第一位色、或用色值做 alpha 混合）。将整个 CSS 渐变字符串写入 `background` 字段会导致这些组件行为异常。

**Mitigation**：
- **Step 7 替换策略改为**：不修改 `background` 字段，而是新增可选字段 `backgroundGradient?: { from: string; to: string; direction: string }`，在渲染侧判断该字段是否存在来决定是否绘制渐变
- **DARK 模式背景同步更新**：`DARK_TUI_THEME.background` 从 `#0f1419` 改为较浅的中间色（如 `#1a1b3c`，深蓝紫），使渐变在其上可见
- **如主题系统不支持可选字段扩展**：退而求其次，将 `primary` / `secondary` / `accent` 三个字段从纯色替换为蓝紫色系（`primary: "#6366F1"`, `secondary: "#8B5CF6"`, `accent: "#818CF8"`），而非改 background——这在暗色背景下对比度更高，用户能感知蓝紫色调
- **验证**：在 dark 和 light 两种模式下均启动 TUI，肉眼确认蓝紫色感知明显
