# Plan: 运行中侧问（/btw）

> 让 zcode TUI 用户在 Agent 正在执行长任务时，输入 `/btw <问题>` 得到一个浮层答案——答案来自当前会话上下文，不写入转录、不打断主任务、不能使用工具。

> **上游**：[docs/painpoint-side-question-overlay.md](painpoint-side-question-overlay.md)（痛点拆解）
>
> **已确认决策**（来自本次澄清，作为本文的 ground truth）：
> 1. **范围**：Phase 1 全部 5 个 P0（F-001 唤出入口、F-002 隔离上下文应答、F-003 运行中不打断、F-004 浮层展示与关闭、F-005 无据拒答）。
> 2. **模型**：复用当前主会话模型（`getSessionModelSelection()`），不引入新的模型配置项。
> 3. **快照边界**：完整会话，**含工具结果**。
> 4. **工具能力**：无工具、单轮。
> 5. **记录归属**：完全不写入主会话，纯临时。

## Context

痛点拆解已把问题定义清楚，本计划解决的是「**在这套架构里怎么做才对**」。动手前做了三路源码勘察，结论如下（全部来自源码，非推断）：

**① 可行性成立，且有两个成品先例。** 主会话转录是单一可变对象 `MessageHistoryImpl`（`core/src/agent/message-history.ts:135-136`），但代码库已确立「同步浅快照 + 依赖 entry 不可变」的跨异步读约定（`core/src/runtime/helpers/project-memory-agent.ts:67-70`，注释明确写了对不可变的依赖）。模型句柄 `createRuntimeModel` 产出的 `ExecutableModel` 是不可变配置 + 无状态 executor（`adapters/src/model/model.ts:40-93`），**并发两次 `streamText` 在客户端层是安全的**。已有先例：`runCompactSummaryModelRequest` 证明「第二个流不进会话/UI」可行，`scheduleProjectMemoryExtraction` 证明「并发 + 用当前会话上下文 + 自己的 AbortSignal」可行。

**② 存在一个必须绕开的陷阱（本计划最关键的一条）。** 主请求路径 `runModelTextRequest`（`core/src/runtime/methods/model.ts:228-230`）最终通过 `emitModelStreamingEvent`（`core/src/runtime/methods/model-streaming-event-queue.ts:39-59`）以**主 sessionId** 发 `SessionEventType.ModelStreaming` 事件。而 TUI 侧 `isMainSessionEvent`（`tui/src/app-session-event-handler.ts:34-42`）会放行同 sessionId 的事件，`appendStreamingTextDelta`（`tui/src/app-transcript-stream.ts:7-36`）在 **assistantMessageId 未知时会直接新建一条 agent 消息**：

```ts
if (found) return updated;
return [...updated, appendTextPart({ content: "", id: assistantMessageId, parts: [], role: AGENT_ROLE, streamProjected: true, streaming: true }, delta)];
```

即：**侧问若走主请求路径，会在主转录里凭空插入一条幽灵 assistant 消息**——这正是痛点 A 要消灭的东西，却由实现本身制造出来。侧问必须**直接消费 `model.streamText(...)` 的迭代器，自己 reduce，绝不发会话事件**，形态对齐 `compact-summary-model-request.ts:302-309`。

**③ 运行中拦截有两道闸门，缺一不可。** TUI 里「正在跑任务时提交输入」会走 `app-submit-controller.ts:49-68` 的 busy 分支被**当成排队输入**；即使绕过它，`cli/src/tui-prompt-handler.ts:322-341` 的 `sendInput` 只允许 `model` 与 `effort` 两个 known 命令回到命令中心，其余一律转发给 agent 当作 turn 输入。两处都要放行 `/btw`。

约束：`pnpm architecture:check`（`verify:pre-push` 的一部分）要求 `maxFileLines: 400`、`forbidCycles`、`forbidDeepImports`；`packages/tui` 不得深引 `cli`。当前所有模块 `managed: false`，行数上限尚未强制，但**新模块按 400 行以内写**。另外 `/btw` 必须**零持久化**（见 Adjust）。

## Goal

1. 主任务**正在流式输出时**输入 `/btw <问题>`，浮层给出答案，主任务输出**不出现停顿**、不被取消。
2. 该问答**不出现在**主转录、`/context` 统计、后续任何请求的 payload 中；会话重载后无残留。
3. 上下文不含所需信息时**明确拒答**并指引改用普通提问，绝不以猜测填补。
4. 侧问全程**不调用任何工具**（硬约束，非提示词约束）。
5. 关闭浮层后焦点回到主输入框；浮层内 `Esc` **不**中断主任务。

## Plan

### 阶段一：命令面注册（先让 `/btw` 可见、可解析）

1. **同步四处清单**。`/btw` 必须同时出现在「可解析」与「可见」两条链路上，缺一处就会出现「能跑但补全里没有」或反之：
   - `packages/shared/src/zcode-slash-command-help.ts:9` —— 加一条 help entry（name/usage/summary/details）。`AVAILABLE_COMMANDS`（`command-center/slash-commands.ts:19`）与 `/help` 文案都由它派生，加这一条即可自动覆盖。
   - `apps/zcode-cli/packages/cli/src/command-center/slash-command-types.ts` —— 加联合类型分支。
   - `apps/zcode-cli/packages/cli/src/command-center/slash-commands.ts:23` 的手写 if-chain —— 加 `rawName === "btw"`，**必须放在 `:195` 的 `/skill` 特殊解析之前**。
   - 验证 `bootstrap/src/slash-command-surface.ts:19-27` 是否真的从 builtin 集合自动派生 `RESERVED_SLASH_COMMAND_NAMES`；若是则无需手改，若否则补上（否则用户的自定义命令/skill 可以静默遮蔽 `/btw`）。
2. **headless 显式拒绝**。`cli/src/prompt-command.ts:81-306` 的 `-p` 路径不做特判时，`/btw ...` 会被当作普通 prompt 发给 agent——脚本里写 `/btw` 会变成一次**带工具的正常 turn**，属于静默且可能产生副作用的错误行为。
   **落点必须是 `prompt-command.ts:96-135` 那条早于路由判断的 `if (command.name === "help")` 早退链**，返回「`/btw` 仅在交互式 TUI 中可用」并**不发起任何模型请求**。
   **不要动 `routesToPromptCommandCenter`（`prompt-command.ts:490-496`）**——它只对 known 命令放行 `expert`/`goal`，让它对 `btw` 返回 true 会把命令路由进 TUI 形态的命令中心，headless 下并不成立（见 R-020）。
   这条同时让验收脚本可自动化（见 Do）。

### 阶段二：core 侧问调用（本计划的技术核心）

> **先作为独立切片做（R-024）**：步骤 3 是全计划的风险集中点——R-001 / R-017 / R-018 / R-019 全落在它身上。不要按 1→12 平推，**先把步骤 3 单独跑通**（一次隔离侧问调用 + 断言 A5 通过），确认走通后再推进阶段三起的 UI 工作，避免沉没成本。

3. **新增隔离的侧问调用**。新文件 `apps/zcode-cli/packages/core/src/runtime/methods/btw-model-request.ts`（< 400 行），形态对齐 `compact-summary-model-request.ts`：
   - 模型句柄：`createRuntimeModel(this, { selection: this.getSessionModelSelection() })`（与 `compact-active.ts:174-178` 一致，满足「复用主会话模型」）。
   - 上下文：`[...this.messageHistory.borrowReadOnlyRuntimeEntries()]` 同步浅快照（对齐 `project-memory-agent.ts:67-70`），再经 `buildRuntimeProviderRequestMessages`（`core/src/runtime/helpers/runtime-provider-request-messages.ts:9-24`）转成 provider 消息。
   - 调用：`runWithModelInvocationContext(ctx, () => model.streamText(request))`，**本地 reduce 迭代器**，delta 经普通回调推出。
   - **禁止**：调用 `runModelTextRequest`、调用 `emitModelStreamingEvent`、发任何 `SessionEventType.ModelStreaming`、写 `messageHistory`。**在文件头部用注释写明理由**（幽灵 assistant 消息那一节），否则后来者会「顺手统一成主请求路径」而引入回归。
   - `tools: []` 写死。
   - 自己的 `AbortController`，与 turn 的 signal 无关（对齐 `core/src/memory/extraction.ts:96`）。
   - **必须带自己的超时**：`AbortSignal` 与超时组合，超时后进入失败态。没有超时的侧问会把浮层永久留在屏幕上（见 R-002）。
   - **走非流式（`generateText`）+ `metadata: { skipTranscript: true }`**（Pre-Mortem 决策，R-001）。`runner-generate.ts:89` 今天即支持该开关（`input.request.metadata?.skipTranscript !== true && shouldRecordModelIO(...)`），而 `runner-stream.ts:117` 只有 `shouldRecordModelIO(input.env)`、**没有这个开关**——走流式就会把侧问的完整会话快照与答案落盘到 `~/.zcode/cli/rollout`。非流式让 R-001 归零、零 adapter 改动，并**自动继承 `runner-generate.ts` 的准入与重试**（`admitAttempt`、`retryBudgetAllows`、`calculateRetryDelay`），因此不必再自己实现 R-004/R-018 的恢复逻辑。等 `runner-stream.ts` 对齐后再切流式是纯增量改动。
   - **`skipTranscript` 只关掉「model-io」一条通道，≠「不落盘」的全部（R-028 / R-030）**。侧问路径必须同时满足：
     - **不提供 `statusSink`**。它在 `ModelInvocationContext` 里是**可选**字段（`contracts/src/model/invocation-context.ts`），而 `createModelStatusSink` 的 `publish` 会 `this.appendEvent(...)`（`methods/model-status.ts:20-33`）。
     - **完全不调用 `this.appendEvent(...)` / `this.createEvent(...)`**——即**不要复制 `workspace-generate-text.ts:177-193` 的 `appendEvent(modelRequestEvent)` 段**。`appendEvent`（`methods/events.ts:81-147`）会执行 `eventStore.append` + `persistDurableSessionEvent` + `notifyEventSinks`：**落进 `~/.zcode/cli/db/db.sqlite`，并对 TUI 可见**。
     - **不发任何 `SessionEventType.*`**：`ModelStreaming`（幽灵消息，见上文②）、`ModelRequest`、`ModelNetworkStatus`、`ModelComplete` 一个都不发。
     - 形态上的真正先例是 **`project-memory-agent.ts:47-58`**（只构造 invocation context，不发任何会话事件），**不是** `workspace-generate-text.ts`（它发事件）。
   - **不调 `recordModelUsageFact`**。它写的是 `runtime.sessionStore` 的 `model_usage` 表（`usage-observability.ts:55-129` → `~/.zcode/cli/db/db.sqlite`），属**持久化**，与「零持久化」硬约束直接冲突（R-021 已改判，见 R-029）。
   - **`querySource` 必须是独特且可检索的值（如 `"btw"`）**。它是 A5 归属断言的**唯一锚点**（见 R-036/R-037）：`operation` 只能是封闭 enum 的既有成员，新 `querySource` 会落到 `default` → `ToolInternalModelCall`（`contracts/src/telemetry/index.ts:150-204`），**与别的调用撞车，不能用作锚点**。Phase 1 接受该观测口径偏差、不改 contracts（见 R-037）。
   - **运行时 header 刷新必须挂上**：对齐 `project-memory-agent.ts:55` 的 `createRefreshRuntimeHeadersBeforeModelAttempt(...)`，否则长会话里凭据过期后侧问 401 而主任务正常（见 R-019）。
   - **失败与超时都要有明确出口**：非流式虽自带重试预算，但在预算耗尽后仍是单次失败——必须进入浮层失败态并保留问题原文可重试，不要让侧问裸失败或静默（见 R-018 / R-002）。
4. **暴露为 `AgentRuntime` 公开方法**。`runModelTextRequest` 声明在 `AgentRuntimeInternal`（`core/src/runtime/internal-methods.ts:282`）上，TUI 侧不可见，需在公开面上加一个方法（回调形态：`onDelta` / `onDone` / `onError`）。

### 阶段三：桥接到 TUI

5. **新增 TUI 能力**。`tui/src/types.ts:298-338` 的 `TuiOptions` 加侧问方法；在 `cli/src/tui-command.ts:92-113` 接线；handler 成员加在 `cli/src/tui-command-state.ts:18-33`，实现放 `cli/src/tui-prompt-handler-queries.ts:21-78`（既有的「取 app → 转发」位置），转调步骤 4 的 runtime 方法。
6. **在两道闸门上放行 `/btw`**（**缺任何一处，运行中侧问都不成立**）：
   - `tui/src/app-submit-controller.ts:49-68`：在 `if (input.busy)` **之前**识别 `/btw`，否则它会被塞进排队输入。
   - `cli/src/tui-prompt-handler.ts:322-341`：把 `btw` 加入 `sendInput` 的 known 命令白名单（当前只有 `model` / `effort`）。

### 阶段四：浮层与交互

7. **侧问状态**。在 `tui/src/app.tsx:91` 的 `liveModelText` 附近新增 state，形状按痛点拆解 §3.2 的 `BtwEntry` / `BtwOverlay`（`entries` / `cursor` / `scroll` / `focus`）。**只存内存，不落盘。**
8. **浮层组件**。新文件 `tui/src/app-btw-panel.tsx`：
   - 外壳抄 `tui/src/app-components.tsx:68-85` 的 `overlaySidebar`（`position:"absolute"` + 四边 0 + `zIndex: 10` + 半透明底），加 `justifyContent/alignItems: center` 变居中。
   - body 抄 `tui/src/app-selection-panel.tsx`：`contentWidth` 归一化、chrome 固定高、行窗口切片、逐行 fitter。
   - 答案用 `MarkdownText`（`tui/src/app-markdown.tsx:30-68`），外层 box 给 `height` + `overflow:"hidden"`（`MarkdownOptions` 本身没有宽高，必须由父 box 约束）。
   - 尺寸来自 `useTerminalDimensions()`；宽度/截断助手在 `tui/src/app-terminal-width.ts`（`truncateDisplay` / `wordWrappedLineCount` / `displayWidth`）。
   - 渲染位：`tui/src/app-view.tsx:192-229` 附近的兄弟节点。
   - **长答案滚动用「行窗口 + 钳制偏移」**，不要用 `scrollTop`——仓库里没有任何地方读写 `scrollTop`，三个既有窗口助手（`app-selection-keyboard.ts:53-83` 等）都是 `clampIndex` 口径。
9. **键盘路由**。在 `tui/src/app-keyboard.ts:184` 与 `:186` 之间插入 `btw` 分支，得到优先级 `readOnlyView > approval > selection > btw > 其余`，与痛点拆解 §4.3「审批面板优先」一致。要点：
   - 浮层打开时 `consumeKey`（`app-keyboard.ts:420-423`）吞掉按键——否则 Space/方向键会漏进 composer 文本域、输入历史、Ctrl+C 退出保护。**但 Ctrl+C 必须显式排除在被吞之列**：要么不吞、要么吞掉后自己处理为「取消侧问」。理由见 R-002——浮层若吞掉 Ctrl+C 且侧问卡住，用户将既关不掉浮层也停不掉主任务。
   - `Esc` 只关浮层不等于用户理解了「主任务还在跑」，关闭时在状态栏给出显式提示（见 R-011）。
   - 新模块 `tui/src/app-btw-keyboard.ts` 对齐 `app-approval.ts:14-52`：`"return"` / `"space"` / `"escape"` / `"up"` / `"down"`。注意 Enter 是 `"return"`、空格是 `"space"`、Esc 是 `"escape"`。
   - `Esc` 仅在浮层有焦点时关闭浮层且 `stopPropagation`，**不冒泡中断主任务**（`app-approval.ts` 已有的面板级 Esc 语义即先例）。
   - 浮层关闭时 `focus` 必须归还主输入框，否则用户下一次输入会丢。
10. **无据拒答（不能只靠提示词）**。步骤 3 的请求里追加一段侧问系统约束：只依据给定上下文作答；不足则**明说上下文不含**并指引改用普通提问。**但提示词约束本身不可靠**（见 R-003），需加一层廉价证据检查：装配快照时对问题关键词做一次「是否出现在上下文中」的检查，无证据时**主动降级为拒答态**，不交给模型自行判断。同时产出一个可判定的「拒答」标记供埋点使用——**该标记只记布尔与计数，不记原文**（否则埋点即等同「写入」，见痛点拆解 §9）。拒答态在 UI 上必须与正常答案**显著区分**，不能长得像答案。

### 阶段五：文案与验收

11. **i18n**。`packages/i18n/src/locales/{zh-CN,en-US}.ts` 的 help 段落（`zh-CN.ts:61-70` 附近）加 `/btw`；新增 `tui.btw.*` 文案：输入占位、无据、失败、流式中、headless 不可用。
12. **验收脚本** `test/btw-side-question.mjs`，形态对齐 `test/claude-config-home.mjs`（硬断言、失败即 FAIL、不静默跳过）。断言见 Do 章节。

## Think — Debug Methodology

- **在框架边界立刻加日志**，统一前缀 `[DEBUG-btw]`：TUI→CLI 桥（handler 收到的输入与 busy 状态）、core 侧问方法入口（快照 entry 数、`tools.length` 是否为 0、是否复用了 turn 的 signal）、首个 delta 的时间戳、浮层开关事件。收尾时 `grep -r "\[DEBUG-btw\]" packages/` 一次清干净。
- **先读源码再断言**：隔离模式的地面真相是 `compact-summary-model-request.ts` 与 `project-memory-agent.ts`，不要凭想象构造调用方式。
- **禁止在侧问路径上做实验性修改**：本功能最大的风险是污染主转录，而污染是**不可逆**的（痛点 A 的定义）。任何拿不准的改动，先在只读快照上验证，不要先接上主路径再回退。
- **定位顺序**（故障时按此顺序，不要跳步）：
  1. `/btw` 无反应 → 查 `parseSlashCommand` 是否命中、两道闸门是否都放行（步骤 6 是双点，只改一处会表现为「空闲可用、运行中失效」）。
  2. 浮层开了但答案空 → 查 delta 回调是否被调用，以及消费迭代器时是否漏了 `text_delta` 之外的事件形态。
  3. **主任务停顿或中断** → 首先查侧问是否误用了 turn 的 `AbortSignal`，其次查 `Esc` 是否冒泡。
  4. **主转录出现幽灵消息** → 立刻确认侧问是否发了会话事件（对照步骤 3 的禁令），不要在 TUI 渲染层打补丁。
- **用真实运行验证，不要只靠编译通过**：TUI 是交互式的，`pnpm build` 通过不能证明浮层能显示。

## Do — Verification Strategy

**构建与静态检查**

- **构建**：`pnpm --filter "@zcode/cli..." build` — 必须通过。
- **类型检查**：`pnpm typecheck` + `pnpm --filter @zcode/tui typecheck` — 零错误。
- **Lint**：`pnpm lint` — 零错误。
- **架构检查**：`pnpm architecture:check` — 通过（关注新增文件行数与 tui→cli 边界）。

**自动化验收**：`node test/btw-side-question.mjs`（前置：已构建 `apps/zcode-cli/packages/cli/dist/zcode.cjs`）

| # | 断言 | 为什么它能证伪 |
|---|------|----------------|
| A1 | `/help` 与命令清单中出现 `/btw` | 覆盖步骤 1 的四处清单，漏任何一处即 FAIL |
| A2 | **源码级**：`btw-model-request.ts` 中不出现 `emitModelStreamingEvent`、`SessionEventType.`（任意形态，含 `ModelStreaming` / `ModelRequest` / `ModelNetworkStatus` / `ModelComplete`）、`runModelTextRequest`、`appendEvent`、`createEvent`、`createModelStatusSink`、`recordModelUsageFact`、`streamText` | 直接钉住幽灵消息陷阱，并覆盖 R-028 的**会话事件通道**与 R-029 的**usage 表通道**——只禁 `ModelStreaming` 会漏掉这两条同样落库的路 |
| A3 | **源码级**：`btw-model-request.ts` 中 `tools` 恒为空数组 | 钉住「无工具」硬约束 |
| A4 | headless `zcode -p "/btw xxx"` 返回明确的「交互式 TUI 专用」提示，且**退出码与输出中不含模型响应内容** | 覆盖步骤 2；若被转发给 agent，输出中会出现模型生成的答案，断言即失败 |
| A5 | **运行时**：跑一次侧问前后，对 `~/.zcode/cli/` 下的 **`rollout` / `debug` / `log` 三个目录** + **`db/db.sqlite` 的 `session_events` / `model_usage` 两张表**做快照对比。断言：① 三个目录无新增文件，或新增文件不含侧问问题原文；② 两张表**无归属于侧问的行** | 唯一能证伪 R-001 的断言。**范围按「落盘通道」枚举而非按「目录」拍脑袋**：`rollout`/`debug`（model-io）、`log`（JSONL 日志）、`db`（会话事件 + 用量）——它们是同一层级的**兄弟**，漏掉任一条都会「快照全绿而侧问已落库」（R-028/R-029/R-030/R-034） |
| A6 | **源码级**：`btw-model-request.ts` 使用 `generateText`（且如上 A2 所钉，不出现 `streamText`），且请求 metadata 显式含 `skipTranscript: true` | 钉住 R-001 的落地形态（非流式是退出口生效的前提）；这是 A5 能通过的前提 |

> A2/A3 是源码断言而非行为断言，这是**权衡后的选择**：本仓库无测试框架（无 `*.test.*`、无 test script），且「不污染」的唯一可靠运行时证据需要启动完整 TUI 会话。源码断言能捕获真实回归（后来者把侧问统一到主请求路径），代价是它不能证明运行时一定不污染——因此下面的手工清单不可省略。

**验收脚本的三条实现口径（不遵守就会拆掉护栏，见 R-035 / R-036 / R-037）**

1. **A2/A6 必须先剥离注释再匹配**（R-035）。步骤 3 **强制**在 `btw-model-request.ts` 文件头写「为什么不能走主请求路径」的注释，而这类注释天然会写出 `emitModelStreamingEvent` / `SessionEventType.ModelStreaming` / `streamText` 等符号名——直接对原始文本做子串匹配**必然误报**。正确做法：先去掉 `//` 行注释与 `/* */` 块注释，再匹配；或匹配**调用点形态**（`emitModelStreamingEvent(`、`this.appendEvent(`、`model.streamText(`）。**绝不允许用「删掉那条注释」来让断言变绿**——那正是 R-016/R-023 防回归守卫的载体。
2. **A5 的 db 部分用「归属」而非「计数」**（R-036）。分两次跑：**空闲态**做严格「零新增」断言；**运行态**（主任务流式中）只做归属断言——因为主任务本身一直在写 `session_events` / `model_usage`，计数断言在运行态**必然假失败**，而假失败的结局就是护栏被以「太吵」为由删除。归属锚点用 **`querySource` 字符串**（`btw`），**不要用 `operation`**（R-037：它只能是 `ToolInternalModelCall`，会与别的调用撞车）。
3. **A5 的三个目录同样优先断言「新增内容不含问题原文」而非「无新增文件」**——主任务的 model-io 与 JSONL 日志一直在写，`rollout`/`debug`/`log` 在运行态本就会有新文件（R-034 / R-036）。

**手工 TUI 验证清单**（在真实终端跑 `pnpm --filter @zcode/cli dev`，逐条走）

- [ ] 空闲时 `/btw <会话题内的问题>` → 浮层给出答案；`/context` 的数字**与问之前一致**。
- [ ] **主任务流式中**输入 `/btw` → 浮层正常出现，且**主任务输出不出现停顿**（观察字符流连续性）。**注意：这条只验证 F-003 的"不打断"，不验证侧问本身能否成功——流式期间快照是干净的（见 R-040）。**
- [ ] **工具执行中输入 `/btw`（R-040，必测）**：让主任务跑一条长命令（如 `sleep 60`，或会等待审批的工具），**在命令执行期间**输入侧问 → **必须能正常作答**。这是主任务"看起来在跑"的**大多数时刻**，也是快照尾部悬空（未兑现的 `tool_calls`）的唯一窗口——不测这条，等于没测运行中侧问。
- [ ] 浮层内按 Esc → 只关闭浮层；**主任务仍在继续**（这是 F-003 的核心判据）。
- [ ] 关闭后直接打字 → 能正常进入输入框（焦点已归还）。
- [ ] **无据拒答压力测试**：准备 10 个「上下文里其实没有、但看起来像有」的问题（含诱导型，如上下文提到文件名 A 但没提内容，问"文件 A 里那个函数是怎么实现的"）→ 要求 **10/10 拒答**，任一编造即 F-005 失败（见 R-003）。只测 1 个明显 case 不算通过。
- [ ] 长答案 → 上下滚动可读，且**主转录的滚动位置没有变化**。
- [ ] 浮层开着时主任务弹出工具审批 → 审批面板取得焦点（对齐痛点拆解 §4.3）。
- [ ] 侧问结束后查看 `/cost` 或缓存统计 → **主会话的缓存命中率没有塌陷**（验证痛点拆解 §5.1 的「不得改写 cache 前缀」约束；这是最容易被忽略、也最容易被实现本身破坏的一条）。
- [ ] 会话重载 → 无任何侧问残留。
- [ ] **逃生演练（R-002）**：把 base url 改成一个不响应的地址，在主任务运行中发起侧问 → 侧问超时进入失败态；此时 **Ctrl+C 仍能停主任务**，浮层仍能关闭。这是最坏情况下的唯一逃生口，必须实测。
- [ ] **侧问期间主任务状态栏未被顶掉**（R-009）：侧问用独立状态字段，不复用 `liveModelText`（`app.tsx:91`）。
- [ ] **`midConversationSystem` force 模式**（R-007）：在 mcs 为 `force` 的配置下跑一次侧问，确认消息装配不冲突、请求不报错。
- [ ] **长会话成本实测**（R-005）：在一个 >100k token 的会话里发起侧问，记录耗时与费用；超出可接受阈值则回退到「最近 N 轮 + 系统提示」快照策略。
- [ ] **长任务场景**（R-017）：在 goal / expert / dwf 前台执行期间发起侧问，确认不是静默失败、有明确文案。
- [ ] **长会话凭据刷新**（R-019）：跨一次运行时凭据刷新周期后发起侧问，确认不出现 401。
- [ ] **极窄 / 极矮终端**（R-026）：确认浮层内 Markdown 换行与 CJK/emoji 宽字符不截断错位。
- [ ] **usage 记账**（R-021）：侧问后 `/cost` 的数字包含了这次侧问的用量（记 usage、不记内容）。

**逻辑正确性检查**（按痛点拆解 §4.2 的异常流程逐条走）

- [ ] 主任务在侧问生成**期间**结束 / 报错 → 侧问独立完成，互不影响。
- [ ] 侧问生成失败 / 超时 → 浮层显示失败态并保留问题原文。
- [ ] 侧问为空或仅空白 → 直接关闭，不产生条目。
- [ ] 空闲时用 `/btw` → 走同一条通道（答案同样不写入主会话），不要退化成普通提问。

## Adjust — Rollback and Global Scan

**Rollback plan**

本功能是**纯增量**的：不加配置项、不改 schema、不落盘、不动任何持久化状态。回滚 = 移除三处增量并从命令清单摘掉 `/btw`：

1. `parseSlashCommand`（`slash-commands.ts:23`）的 `btw` 分支 + `zcode-slash-command-help.ts:9` 的 entry（+ 类型分支）。
2. 两道闸门（`app-submit-controller.ts:49-68`、`tui-prompt-handler.ts:322-341`）的放行。
3. TUI 侧的浮层组件、键盘分支、state、`TuiOptions` 能力。

**硬约束：侧问不得引入任何持久化。** 一旦侧问写进 session db / config / 日志原文，回滚就不再干净，且直接违反痛点 A 的解法。这条要写进代码注释。

**「持久化」的完整口径（第 3/4 轮补全，此前只点了 model-io 一条）**——侧问不得写入以下**任何一条**：

| # | 通道 | 落点 | 控制手段 |
|---|------|------|----------|
| ① | model-io（请求/响应原文） | `~/.zcode/cli/{rollout,debug}` | 非流式 + `metadata.skipTranscript: true` |
| ② | 会话事件流 | `~/.zcode/cli/db/db.sqlite` → `session_events` | 不调用 `appendEvent` / `createEvent`；不提供 `statusSink` |
| ③ | 用量表 | `~/.zcode/cli/db/db.sqlite` → `model_usage` | 不调用 `recordModelUsageFact`（**故意**的代价：`/cost` 少报，见 R-029） |
| ④ | JSONL 文件日志 | `~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`（保留 7 天） | 提问原文与答案**不得**作为任何 `logger.*` 调用的字段值（含 `[DEBUG-btw]` 调试日志） |

> ②③④ 是前几轮**漏掉的**：第 1 轮只堵了 ①，因此「已收敛」的结论不成立（见 R-028/R-030）。**验证（A5）必须与这张表一一对应**——按通道枚举，而不是按目录枚举。

**Global scan**（改完后逐条回答，不要只修一处）

1. **同一形态的陷阱还有谁？** 第 3/4 轮已证明这不是「一个陷阱」而是**四条并列的落盘通道**：① model-io（`rollout`/`debug`，`shouldRecordModelIO`）；② 会话事件流（`appendEvent` → `db.sqlite` 的 `session_events`）；③ 用量表（`recordModelUsageFact` → `db.sqlite` 的 `model_usage`）；④ JSONL 文件日志（`~/.zcode/cli/log/`）。**任何未来的带外调用都要先回答「它会不会走这四条」**，而不是复制一份「隔离流」。本次除侧问外，检查是否还有其他调用点语义上不该进转录；若有，把「隔离流」**连同通道枚举表**抽成共享形态而不是复制第二份。
2. **白名单是不是该泛化？** `tui-prompt-handler.ts:322-341` 目前硬编码 `model` / `effort`，本次再加 `btw`。若第三个「运行中可用」的命令出现，应改为按声明的元数据判定，而不是继续堆字面量——本次先记录，不重构。
3. **busy 分支的其他出口**：`app-submit-controller.ts:49-68` 的排队逻辑是否还有别的路径能绕开拦截（例如 `sendInput` 的其他调用方）？
4. **`/btw` 与用户自定义命令/skill 的遮蔽**：确认 `RESERVED_SLASH_COMMAND_NAMES` 生效且遮蔽是**可见的**（有提示），不是静默丢弃。

**Backwards compatibility**

无需迁移、无需 shim。唯一的外部影响是 `/btw` 成为保留名——若用户已有同名 skill/自定义命令，会被遮蔽（须保证有可见提示，见 Global scan 第 4 条）。

## Open Questions

- **headless 行为是否要改**：当前计划是「显式拒绝」。若改为「把答案打到 stdout」，则本计划大部分手工验证可转为自动化端到端验证，且脚本可用性提升——建议作为 Phase 2 首个候选，但需先确认它不违背「不写入」的定位。
- **模型请求准入是否会被拒**：`modelRequestAdmission`（`runtime-model.ts:42-50`）是并发/限流治理，侧问会经过它。在主任务繁忙时它是否会拒绝侧问？需实测；若频繁拒绝，需要一条独立通道。
- **缓存前缀是否真的命中**：侧问复用同一模型与同一消息前缀，理论上命中主会话 prompt cache，但 `withModelInvocationContext` 的 metadata（`skipTranscript` / `modelRequestSessionType: "other"`）是否影响 provider 侧缓存键，**必须实测**，不能假设。这直接决定痛点拆解 §5.1「不得改写 cache 前缀」是否成立。
- **拒答标记的判定口径**：由模型自评（会漏）还是硬约束（会缩窄应答范围）？影响 F-005 的验证指标可信度。
- **`Esc` 键位冲突**：主任务运行中 `Esc` 通常是中断。浮层有焦点时劫持 `Esc` 是必要的，但与肌肉记忆冲突——是否需要额外确认或改用别的键。
- **并发多条侧问**：痛点拆解 §4.2 暂定串行排队。条数上限与「丢弃最新」策略未定。
- **是否展示流式（已被 R-001 升级为必须先定的决策）**：侧问要不要边生成边显示（更像主任务），还是等完整答案再显示（更简单、避免半成品误导）？影响 `MarkdownText` 的 `streaming` 参数与浮层状态机。
  **与 R-001 强耦合**：走流式就必须先修 `runner-stream.ts:117` 的 `skipTranscript` 支持（`runner-generate.ts:89` 已有，两条路径应对齐）；走非流式则退出口今天即可用、零 adapter 改动。
  **Pre-Mortem 第 2 轮的建议：先按非流式落地**（见「残余风险评估」）。理由：这是唯一能让 R-001 归零、且不必动 `adapters` 这个更底层包的路径；代价只是答案整段出现而非逐字出现。切流式留作 `runner-stream.ts` 对齐后的纯增量改动。
  **若采纳，步骤 3 相应调整为**：`generateText` + `metadata: { skipTranscript: true }`，删除 `runner-stream.ts` 的修改项与断言 A6（A5 保留）。
- **F-006 / F-007 的范围落差**：在痛点拆解的澄清中，你已把「上下滚动 / 左右翻历史侧问」与「`c` 复制答案为 Markdown」列为期望的 MVP 交互，但拆解文档把 F-006 / F-007 定为 P1、排在 Phase 2，而本次确认的范围是「Phase 1 全部 5 个 P0」。**本计划按 5 个 P0 编写**，F-006 / F-007 列为范围外。滚动（F-004 的一部分）已在范围内；若要把「历史翻阅」与「复制」也纳入本次，请明确，键盘设计已为它们预留了不冲突的键位。

## Out of Scope

- **F-006 翻阅侧问历史**（左右键切换历次侧问）——P1，见 Open Questions 最后一条。
- **F-007 复制答案为 Markdown**（`c` 键）——P1，见 Open Questions 最后一条。注意 `writeClipboardText` 虽已在 `TuiOptions`（`tui/src/types.ts:337`）声明，但**并未接进 `TuiApp`**（`app.tsx:42-46` 只有 `copySelection` / `hasCopyableSelection`），落地时需要新增一条 `copyText` 能力从 `tui.tsx:80-84` 接到面板，并复用 `app-copy.ts:26-89` 的 `SelectionCopyResult` / `selectionCopyStatus` 保持 i18n 一致。
- **F-008 转正为 fork 会话**（`f` 键）——P2。
- **侧问携带工具**（读文件 / 执行命令）——已确认不做；这与子代理（`subagent.ts:239`，独立 sessionId + 全新上下文）是两条不同的路，不要混用。
- **非 TUI 入口**（桌面端、浏览器界面）——本仓库是精简分支，不涉及。
- **侧问的持久化与跨会话回看**——与「不写入」的定位直接冲突。
- **模型选择配置项**——已确认复用主会话模型。
- **对 `tui-prompt-handler.ts` 白名单的泛化重构**——见 Global scan 第 2 条，本次只记录。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

> 评分口径：**Risk Score = Severity × Likelihood × (1 − Detectability)**。Detectability = 「早期就能发现它」的概率（越高越容易发现、风险越低）。
>
> **最终状态（第 5 轮收敛）**：累计 **42 个风险，其中 7 个 HIGH**（R-001 / R-002 / R-003 / R-028 / R-029 / R-030 / R-040），**7 个 HIGH 的残余分已全部降至 LOW**（见文末残余评估表）。全部风险均附缓解方案，并已回写进 Plan / Do / Adjust 章节。
>
> **阅读指引**：R-001–R-027 为第 1–2 轮；**R-028 起为第 3–5 轮复检**，其中三条**推翻或修正了前轮的结论**，建议优先阅读——
> - **R-030**：「零持久化」此前只堵了**四条落盘通道中的一条**，第 2 轮的「已收敛」是**假收敛**。
> - **R-029**：第 1 轮为 R-021 定的缓解方案「记 usage」**本身就是 HIGH RISK**（它写 session db）。
> - **R-040**：手工清单的「主任务流式中」用例**恰好避开了唯一会失败的窗口**（工具执行期），是本次复检最重要的发现。

### R-001 侧问原文与答案被落盘到 `~/.zcode/cli/rollout`

**Severity**: 5 | **Likelihood**: 5 | **Detectability**: 0.2
**Risk Score**: 5 × 5 × (1 − 0.2) = **20**
**判定**：🔴 HIGH

**Failure Scenario**：每次 `/btw` 都把**完整会话快照 + 问题 + 答案**写进磁盘的 rollout 目录。功能最核心的承诺——「完全不写入、纯临时」——被打破，而用户完全不可见。

**证据（已核对源码，非推断）**：
- `adapters/src/model/runner-debug.ts:64-68`：`shouldRecordModelIO` 只排除 `ZCODE_RUNTIME_ENV=test`，**生产与开发默认都记录**。
- `adapters/src/model/runner-generate.ts:89`：`input.request.metadata?.skipTranscript !== true && shouldRecordModelIO(input.env)` —— **有**退出口。
- `adapters/src/model/runner-stream.ts:117`：`const recordModelIO = shouldRecordModelIO(input.env);` —— **没有**退出口。
- 全仓库唯一的 `skipTranscript: true` 生产者是 `project-memory-agent.ts:53`，而它走的是 `generateText`，不是流式。
- `bootstrap/src/app/paths.ts:13`：`getModelIoDir` → 生产落 `cli/rollout`，开发落 `cli/debug`。

**为什么计划的验证抓不到**：断言 A2 只禁止 `emitModelStreamingEvent`（会话事件通道），而这是一条**完全不同的磁盘通道**。手工清单也没有任何一条会去看文件系统。这正是它 Detectability 只有 0.2 的原因。

**决策（已定，第 3 轮）**：**走非流式 `generateText` + `metadata: { skipTranscript: true }`**。这是原「备选方案」，现采纳为唯一方案——退出口 `runner-generate.ts:89` **今天即生效、零 adapter 改动**，R-001 由此归零；代价只是答案整段出现而非逐字出现。

**Mitigation**:
- `/btw` 改用 `generateText` 并在请求 metadata 显式设置 `skipTranscript: true`（已回写进 Plan 步骤 3）。
- **运行时**断言 A5：侧问前后对 `~/.zcode/cli/{rollout,debug}` **与 `~/.zcode/cli/db/db.sqlite`** 做快照对比（已扩展，见 R-028/R-029）。
- **源码**断言 A6：钉住「走 `generateText` 且带 `skipTranscript`」，防止后来者为了浮层流式而改回 `streamText`——**那会立刻让 R-001 复活**（`runner-stream.ts:117` 至今无退出口）。
- 若将来要切流式，**前置条件**是先把 `runner-stream.ts:117` 的 `recordModelIO` 与 `runner-generate.ts:89` 对齐（支持 `metadata?.skipTranscript`），并同步重跑 A5。**这是一条有前置条件的增量改动，不是平级选项。**

### R-002 侧问卡死 + 浮层吞掉按键 = 用户无法停止任何东西

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.3
**Risk Score**: 5 × 4 × (1 − 0.3) = **14**
**判定**：🔴 HIGH

**Failure Scenario**：侧问请求因网络/厂商/限流**永不返回** → 浮层一直开着。按计划步骤 9，浮层 `consumeKey` 吞掉全部按键；按痛点拆解 §4.3，`Esc` 只关浮层、不冒泡。于是：**Ctrl+C 被吞、Esc 不冒泡、主任务也停不下来**。用户唯一的出路是杀掉终端。逃生口被自己的键位设计堵死了。

原计划步骤 9 明确要求「吞掉全部按键」，却**没有给侧问定义超时**，也没有定义卡住时的逃生路径——两者叠加才构成这个死锁。

**为什么难以发现**：只有真的遇到卡住时才会暴露，正常测试路径下永远不会触发。

**Mitigation**:
- 侧问请求带**自己的超时**，超时进入失败态并保留问题原文可重试（已回写进 Plan 步骤 3）。
- `Ctrl+C` **显式排除**在被吞之列：要么不吞、要么吞掉后自己处理为「取消侧问」（已回写进 Plan 步骤 9）。
- 手工清单新增**逃生演练**：把 base url 改成不响应的地址，确认侧问超时的同时 Ctrl+C 仍能停主任务、浮层仍能关闭。

### R-003 无据拒答不可靠，且计划没有验证它的手段

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.3
**Risk Score**: 5 × 4 × (1 − 0.3) = **14**
**判定**：🔴 HIGH

**Failure Scenario**：模型天然倾向迎合，对上下文里没有的东西给出**看似合理的推断**。用户基于它做决策——比没有侧问更糟，而且**静默**（答案长得跟正常答案一样）。痛点拆解 §5.1 已点名这个风险，计划步骤 10 却只写了「追加一段系统约束」。

**为什么计划的验证抓不到**：手工清单只有一条「问一个上下文里没有的东西 → 明确拒答」。这只覆盖最明显的情形，覆盖不了「看起来像有但实际没有」——而那恰恰是最容易骗过用户、也最容易骗过测试的形态。

**Mitigation**:
- 拒答**不能只靠提示词**：装配快照时增加一层廉价的证据检查（问题关键词是否真的出现在上下文中），无证据时**主动降级为拒答态**，不交给模型自行判断（已回写进 Plan 步骤 10）。
- 拒答态在 UI 上必须与正常答案**显著区分**。
- 手工验证升级为**压力测试**：10 个诱导型无据问题要求 10/10 拒答，任一编造即判 F-005 失败（已回写进 Do 章节）。

### R-004 并发请求触发厂商限流，反噬主任务

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 4 × 3 × (1 − 0.4) = **7.2**
**判定**：🟡 MEDIUM

**Failure Scenario**：zcode 支持多厂商。部分厂商对同一 API key 的并发连接限制严格，运行中侧问触发 429，表现为**侧问失败**，更糟的情况是**主任务被连带限流**——直接违反 F-003。

**Mitigation**:
- 侧问经过 `modelRequestAdmission`（`runtime-model.ts:42-50`）这条既有准入通道；主任务繁忙时侧问应**降级等待**而非与之竞争。
- 被拒时给出明确文案，不要静默失败。
- 手工清单覆盖至少一家非 Anthropic 厂商的真实并发场景。

### R-005 长会话下快照过大，侧问又慢又贵

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 4 × 4 × (1 − 0.5) = **8**
**判定**：🟡 MEDIUM

**Failure Scenario**：已确认快照为「完整会话含工具结果」。长会话里快照可达数十万 token，每次「顺口一问」的代价接近主任务一轮。用户很快就不用它了——功能自然消亡，而不是报错。

**Mitigation**:
- 先实测（手工清单已加 >100k token 会话的耗时与费用项）。
- 超出可接受阈值时回退到痛点拆解的选项三「最近 N 轮 + 系统提示」，并把它做成**可调参数而非写死**。

### R-006 缓存前缀假设未经证实

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 3 × 3 × (1 − 0.5) = **4.5**
**判定**：🟢 LOW-MEDIUM

**Failure Scenario**：计划基于「复用主会话模型即复用其 prompt cache 前缀」的假设。若 `withModelInvocationContext` 的 metadata（`skipTranscript` / `modelRequestSessionType: "other"`）影响 provider 侧缓存键，侧问每次全价，成本优势消失。

**Mitigation**: 实测对比侧问前后的缓存命中统计，把结论**写回本计划**而不是留在 Open Questions。

### R-007 `buildRuntimeProviderRequestMessages` 的 mcs 依赖与侧问系统约束冲突

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 4 × 3 × (1 − 0.6) = **4.8**
**判定**：🟢 LOW-MEDIUM

**Failure Scenario**：`runtime-provider-request-messages.ts:10-18` 读 `runtime.config.midConversationSystem?.mode === "force"`，force 模式下会产出**对话中间的系统条目**。若侧问再自行追加系统约束，可能与之冲突，甚至在部分厂商的 message 格式下直接请求失败。

**Mitigation**: 复用同一个 `runtime` 调 `buildRuntimeProviderRequestMessages`；侧问约束**追加在末尾**而非重排消息；手工清单覆盖 mcs=`force` 模式跑一次。

### R-008 侧问流含 `tool_call`，而 reducer 只处理 `text_delta`

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.4
**Risk Score**: 3 × 3 × (1 − 0.4) = **5.4**
**判定**：🟢 LOW-MEDIUM

**Failure Scenario**：`tools: []` 是硬约束，但若中间层注入了工具描述，模型仍可能输出 tool_call；侧问 reducer 若不处理，会崩溃或静默截断答案。

**Mitigation**: reducer 显式忽略非文本事件并计数；配合源码断言 A3 与运行时日志，出现即暴露。

**第 3 轮更新——风险面已缩小（非流式决策的副产品）**：改走 `generateText` 后**不再有「流 reducer」**，原失效形态（消费 `AsyncIterable` 时漏处理 `text_delta` 之外的事件）**随之消失**。剩余的部分是：`ModelResult` 里可能带有 `toolCalls`，取值时必须**只取文本内容、忽略 `toolCalls`**，并在发现 `toolCalls` 非空时**计数告警**（说明 `tools: []` 的硬约束在某处被穿透——这是比"答案为空"更早的预警）。源码断言 A3 保留。

### R-009 主任务状态栏 / `liveModelText` 串台

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 3 × 4 × (1 − 0.5) = **6**
**判定**：🟡 MEDIUM

**Failure Scenario**：两侧流式输出同时 setState。若侧问复用了 `liveModelText`（`app.tsx:91`）或共用 `setStatus`，主任务的进度提示会被侧问顶掉——不崩溃，但"运行中不打断"的体感破产。

**Mitigation**: 侧问使用**独立**状态字段，绝不复用 `liveModelText`；手工清单加对应观察项。

### R-010 `Esc` 语义与肌肉记忆冲突

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 3 × 4 × (1 − 0.4) = **7.2**
**判定**：🟡 MEDIUM

**Failure Scenario**：用户按 `Esc` 想停主任务，结果只关了浮层，主任务继续跑——**用户以为自己停了**。属于静默的意图违背。

**Mitigation**: 浮层常驻一行键位提示（复用 selection panel 的 help 行形态）；关闭浮层时在状态栏显式提示「主任务仍在运行」。

### R-011 验收断言 A2/A3 是源码断言，证明不了运行时行为

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 4 × 3 × (1 − 0.3) = **8.4**
**判定**：🟡 MEDIUM

**Failure Scenario**：A2/A3 能抓住「后来者把侧问统一回主请求路径」这类回归，但**它们只读源码**。R-001 恰恰证明了这个盲区：源码里没有 `emitModelStreamingEvent` 完全不代表运行时没有落盘。

**Mitigation**: 不把源码断言当作「不污染」的充分证据；A5 提供运行时证据；手工清单保持必做而非可选。

### R-012 运行中拦截只改一处

**Severity**: 4 | **Likelihood**: 2 | **Detectability**: 0.8
**Risk Score**: 4 × 2 × (1 − 0.8) = **1.6**
**判定**：🟢 LOW

**Failure Scenario**：只改 `app-submit-controller.ts` 或只改 `tui-prompt-handler.ts` 白名单，表现为「空闲可用、运行中失效」。

**Mitigation**: 计划步骤 6 已把两处并列并标注「缺任何一处都不成立」；手工清单有运行中用例。

### R-013 用户输入 `/btw` 但没带问题

**Severity**: 2 | **Likelihood**: 4 | **Detectability**: 0.8
**Risk Score**: 2 × 4 × (1 − 0.8) = **1.6**
**判定**：🟢 LOW

**Failure Scenario**：无参数时若直接关闭浮层，用户会以为命令坏了。

**Mitigation**: 无参数时进入「等待输入侧问内容」的浮层输入态（而非直接关闭）。

### R-014 输入历史被 `/btw` 与侧问内容污染

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 2 × 3 × (1 − 0.5) = **3**
**判定**：🟢 LOW

**Failure Scenario**：拦截发生在 `app-input-history.ts` 的 push 之后，导致 `↑` 历史里混入 `/btw` 指令与侧问原文。

**Mitigation**: 确认拦截点在历史写入之前；手工验证 `↑` 历史不含侧问内容。

### R-015 范围蔓延：F-006 / F-007 中途加入

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 3 × 3 × (1 − 0.6) = **3.6**
**判定**：🟢 LOW

**Failure Scenario**：实现中途要求加入「历史翻阅」与「`c` 复制」，导致键盘分支与浮层状态机返工。

**Mitigation**: 已在 Open Questions 标注这一范围落差；若确认加入，**在步骤 9 的键盘分支设计阶段一并定键位**，不要等浮层写完再补。

### R-016 后来者把侧问「统一」回主请求路径

**Severity**: 5 | **Likelihood**: 2 | **Detectability**: 0.7
**Risk Score**: 5 × 2 × (1 − 0.7) = **3**
**判定**：🟢 LOW

**Failure Scenario**：后续维护者出于「减少重复代码」把侧问改回 `runModelTextRequest`，幽灵 assistant 消息回归。

**Mitigation**: 步骤 3 要求在文件头部用注释写明理由；源码断言 A2 兜底。

---

### R-017 侧问的并发准入被拒时行为未定义

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 4 × 3 × (1 − 0.2) = **9.6**
**判定**：🟡 MEDIUM

**Failure Scenario**：侧问经过 `modelRequestAdmission`（`runtime-model.ts:42-50`）这条并发准入通道。`turn-model-step.ts:289-303` 显示**主任务自己都会**因为 start-plan admission busy 被拒并重试（`Main turn retrying after Start Plan admission busy`）——并发第二个请求只会更容易被拒。计划完全没有定义「侧问被拒时怎么办」，表现为侧问**在最需要它的长任务场景下静默失败**。

**Mitigation**:
- 明确被拒时的降级语义：给用户明确文案（而非空浮层），保留问题原文可重试。
- 手工清单补一个**长任务场景**用例（goal / expert / dwf 前台执行期间发起侧问），不要只测普通 turn——计划现有的清单只覆盖普通运行中 turn，这正是 Detectability 低的来源。

### R-018 侧问绕过重试与流恢复机制

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 3 × 4 × (1 − 0.4) = **7.2**
**判定**：🟡 MEDIUM

**Failure Scenario**：侧问以隔离形态直调模型，不经过主路径的完整恢复机制。偶发的 provider 抖动会让侧问失败，而同样的抖动主任务能自愈——用户感受为「侧问怎么老失败」。

**第 3 轮更新：风险已大幅下降，但**不是**归零。** 走非流式 `generateText` 后，侧问请求同样经过 `runner-generate.ts`，**自动继承其准入与重试栈**（`admitAttempt`（`:58`）、`retryBudgetAllows` / `retryBudgetMaxAttempts`（`:60-63`）、`calculateRetryDelay`（`:36`）、`scheduleEmptyCompletionRetry`（`:34`））——原文担心的「直调 `streamText` 绕过这些」不再成立。剩余缺口只有两处：**重试预算耗尽后的终态**，以及 `runner-stream.ts` 特有的 `signatureRepairAttempted` 一类**流式专属**修复（非流式路径本就不适用，无损失）。

**Mitigation**:
- 重试交给 `runner-generate.ts` 的既有预算，**不要自己再包一层重试**（会与准入/预算叠加，放大 429，见 R-004）。
- 预算耗尽后必须进入**浮层失败态**并保留问题原文，提供一次**手动重试**——这是「裸失败」与「可恢复」的分界。
- 失败态文案要与「无据拒答」态**可区分**（两者都可能被用户当成同一件事）。

### R-019 侧问未处理运行时凭据刷新

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 4 × 3 × (1 − 0.2) = **9.6**
**判定**：🟡 MEDIUM

**Failure Scenario**：`project-memory-agent.ts:55` 的带外调用显式挂了 `createRefreshRuntimeHeadersBeforeModelAttempt(...)`。侧问若不挂，长会话里运行时尚凭据过期后侧问开始 401，而主任务正常——又是「短测试通过、长会话失效」的形态，且恰好命中侧问最有价值的使用场景。

**Mitigation**: 侧问的 model invocation context 必须与 `project-memory-agent.ts` 对齐，带上运行时 header 刷新。手工清单补一条长会话（跨凭据刷新周期）的侧问用例。

### R-020 headless 的第三道闸门未被计划点名

**Severity**: 4 | **Likelihood**: 2 | **Detectability**: 0.4
**Risk Score**: 4 × 2 × (1 − 0.4) = **4.8**
**判定**：🟢 LOW-MEDIUM

**Failure Scenario**：`routesToPromptCommandCenter`（`prompt-command.ts:490-496`）对 known 命令只放行 `expert` / `goal`，其余返回 false 后**落到 `app.submitPrompt`**。计划步骤 2 只说「在 headless 路径明确拒绝」，没点名这个函数。若实现者改在这里（让它返回 true），就会走进命令中心——而命令中心是 TUI 形态的，headless 下并不成立。真正正确的落点是文件顶部那条早于它的 `if (command.name === "help")` 链。

**Mitigation**: 计划步骤 2 明确写「加在 `prompt-command.ts:96-135` 那条早退链里，**不要**动 `routesToPromptCommandCenter`」。这类「同一命令面有 N 处清单」的坑与 R-012 同源，验收断言 A1/A4 覆盖。

### R-021 侧问的 usage 记账策略未定义

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 3 × 4 × (1 − 0.4) = **7.2**
**判定**：🟡 MEDIUM

**Failure Scenario**：`recordModelUsageFact` 是**逐点显式调用**的（`compact-active.ts:418,457`、`title-generation-sidecar.ts:158,185` 都调了），不是自动的。计划没决定侧问记不记：记了侧问会出现在 `/cost`（与「纯临时」的直觉冲突）；不记则 `/cost` 少报、用户实际花了钱却看不到。两种都需要一个**故意做出的决定**，而不是默认。

**第 3 轮改判：原缓解方案（「记 usage、不记内容」）被证伪，它自己就是一条 HIGH RISK（R-029）。**

原方案错在把「内容」当成了唯一的持久化形态：`recordModelUsageFact` 写的是 `runtime.sessionStore`（`usage-observability.ts:55-129`），落点是 **`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表**，带 `session_id`、`query_source`、token 数与错误码，**30 天保留**（`repositories/usage.ts:19-20`）。那正是 Adjust 硬约束点名的「写进 session db」，也违反 Goal 2「重载后无残留」。**「不记内容」不等于「不写入」。**

**决策（已定，第 3 轮）：不记 usage。** 理由：本功能的立身之本是「完全不写入、纯临时」（已确认决策 5），而 usage 行是**用户重载后仍可见**的残留；为一项「顺口一问」放弃这一定位不划算。

**Mitigation**:
- 步骤 3 **不调用 `recordModelUsageFact`**，并在文件头注释写明这是**故意**的代价（防后来者「顺手补上」而破坏零持久化）。
- **诚实对待副作用**：`/cost` 会**少报**侧问的花费。必须在「Open Questions / 已知限制」里显式记录，并让 A5 的 db 断言成立（见 R-029）。
- **备选（需放宽约束才能采纳）**：若后续决定「侧问也要计入 `/cost`」，则必须**同时**：① 改写 Adjust 硬约束为「不写内容、可写用量」；② 改写 Goal 2 的口径；③ 把 A5 的 db 断言从「零新增行」改为「`model_usage` 至多 +1 行且不含问题原文」。**三项缺一不可，否则约束与验证自相矛盾。**

### R-022 新增的纯逻辑模块没有任何回归保护

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 3 × 4 × (1 − 0.5) = **6**
**判定**：🟡 MEDIUM

**Failure Scenario**：本仓库无测试框架，`test/*.mjs` 只能打 CLI 产物。因此侧问里三块**纯逻辑**——答案行窗口的钳制数学、键位路由分支、无据证据检查——**一行回归保护都没有**，只能靠手工清单。它们是 R-002 / R-003 的缓解方案所依赖的部件，一旦悄悄坏掉，缓解方案也随之失效。

**Mitigation**: 把这三块写成**纯函数并导出**（对齐 `app-keyboard-helpers.ts:61-98` 的既有做法），即使当前没有框架也能在未来接上；验收脚本对可从 CLI 侧触达的部分做断言。

### R-023 关键洞察只存在于本计划文档

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 3 × 3 × (1 − 0.5) = **4.5**
**判定**：🟢 LOW-MEDIUM

**Failure Scenario**：本计划的核心价值是两条不易重新发现的结论——幽灵消息陷阱、以及 `runner-stream.ts` 与 `runner-generate.ts` 的 `skipTranscript` 不对称。若实现时只读代码不读计划，两条都会踩中。

**Mitigation**: 两条结论都落进**代码注释**（步骤 3 已要求），并在 `CONTEXT.md` 里留一行指针。

### R-024 步骤 3 是全计划风险集中点，却与其他步骤等权推进

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 3 × 3 × (1 − 0.6) = **3.6**
**判定**：🟢 LOW

**Failure Scenario**：R-001 / R-017 / R-018 / R-019 全都落在步骤 3 这一个「core 侧问调用」里。若按 1→12 顺序平推进度，等发现步骤 3 走不通时，命令面、桥接、浮层的投入已经沉没。

**Mitigation**: 把步骤 3 拆成一个**独立的可验证切片**先做（跑通一次隔离侧问调用 + R-001 的 rollout 断言 A5），通过后再推进步骤 4 起的 UI 工作。

### R-025 主任务运行中切换模型后，侧问用哪个模型未定义

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 2 × 3 × (1 − 0.5) = **3**
**判定**：🟢 LOW

**Failure Scenario**：`/model` 在主任务运行中是**允许**的（`tui-prompt-handler.ts:328-337` 的白名单里就有它）。用户运行中切了模型再发 `/btw`，侧问取「当前 turn 的模型」还是「新选中的模型」没有定义，表现为答案质量/成本与预期不符。

**Mitigation**: 明确取 `getSessionModelSelection()`（即最新选择），与 `/model` 的语义保持一致：切了就是切了。

### R-026 窄终端下浮层内 Markdown 渲染

**Severity**: 2 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 2 × 4 × (1 − 0.5) = **4**
**判定**：🟢 LOW

**Failure Scenario**：`MarkdownText` 本身没有宽高约束，全靠父 box。窄终端下若宽度计算没走 `app-terminal-width.ts` 的助手，会出现换行错乱、宽字符（CJK/emoji）截断错位。

**Mitigation**: 宽度一律经 `truncateDisplay` / `displayWidth` / `wordWrappedLineCount`；手工清单补极窄与极矮两个尺寸。

### R-027 上游 `/btw` 行为漂移导致预期不符

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 2 × 3 × (1 − 0.5) = **3**
**判定**：🟢 LOW

**Failure Scenario**：zcode 是 Claude Code 的分支，官方 `/btw` 覆盖 `f` fork / `x` clear 等更多交互。用户对照官方行为会认为本实现「残缺」。

**Mitigation**: 已在 Out of Scope 明确列出未覆盖项；`x`（清空历史）与 `f`（fork）作为 P2 保留在痛点拆解 F-008 中，不静默丢弃。

---

### R-028 侧问经会话事件通道落库：`appendEvent` 把事件写进 `db.sqlite`，A2 与 A5 都看不见

**Severity**: 5 | **Likelihood**: 4 | **Detectability**: 0.15
**Risk Score**: 5 × 4 × (1 − 0.15) = **17**
**判定**：🔴 HIGH

**Failure Scenario**：实现者按仓库里**最接近的非流式先例** `workspace-generate-text.ts` 来写侧问——它调 `this.appendEvent(modelRequestEvent, ...)`（`:177-193`）并传 `statusSink: this.createModelStatusSink(...)`（`:211`）。而 `createModelStatusSink` 的 `publish` 内部也调 `this.appendEvent(...)`（`methods/model-status.ts:20-33`）。`appendEvent`（`methods/events.ts:81-147`）会执行 `eventStore.append` + `persistDurableSessionEvent` + `notifyEventSinks`：**`ModelRequest` / `ModelNetworkStatus` / `ModelComplete` 事件被持久化进 `~/.zcode/cli/db/db.sqlite`，并推送给 TUI**（`createEvent` 用的是 `this.sessionId`，即主会话 id）。于是侧问在**用户完全不可见**的情况下写进了主会话的持久化事件流，违反「不写入、纯临时」，且会污染 `sequenceNumber` 序列。

**为什么计划的验证抓不到**：A2 只禁 `emitModelStreamingEvent` / `SessionEventType.ModelStreaming` / `runModelTextRequest`——**它禁的是「流式」这一条，不是「会话事件」这一类**；`appendEvent` 走的是同一个 `eventStore` 的另一条入口。A5 则只快照 `rollout`/`debug`，而 `db/` 是它们的**兄弟目录**（`adapters/src/storage/session-store/paths.ts:7`）。**两条断言同时全绿，落库照常发生**——与 R-001 是同一种失效形态，只是换了个通道。

**Mitigation**:
- 步骤 3 明写：**不提供 `statusSink`**（该字段在 `ModelInvocationContext` 里是**可选**的，省略即可，无需 adapter 改动）。
- 步骤 3 明写：**不调用 `appendEvent` / `createEvent`，不发任何 `SessionEventType.*`**；把 `workspace-generate-text.ts` 的 `appendEvent` 段标为**反面**示例，把 `project-memory-agent.ts` 标为**正面**先例（已回写进 Plan 步骤 3）。
- **A2 扩展禁用符号清单**：加 `appendEvent`、`createEvent`、`createModelStatusSink`、`SessionEventType.`（任意形态）、`recordModelUsageFact`、`streamText`（已回写进 Do）。
- **A5 扩展快照范围**：加 `~/.zcode/cli/db/db.sqlite` 的 `session_events` 行数/最大 `sequenceNumber`（已回写进 Do）。

### R-029 R-021 的「记 usage」缓解方案本身违反本计划的硬约束

**Severity**: 4 | **Likelihood**: 5 | **Detectability**: 0.2
**Risk Score**: 4 × 5 × (1 − 0.2) = **16**
**判定**：🔴 HIGH

**Failure Scenario**：第 1 轮为 R-021 定下的缓解方案是「**记 usage、不记内容**」并**已写进 Plan 步骤 3**——也就是说，只要按计划实现，这条**必然发生**（Likelihood 5 的来源）。但 `recordModelUsageFact` 写的是 `runtime.sessionStore`（`usage-observability.ts:55-129`），落点是 **`~/.zcode/cli/db/db.sqlite` 的 `model_usage` 表**，含 `session_id`、`query_source`、token 用量与错误码，**30 天保留**（`repositories/usage.ts:19-20`）。这与本计划 Adjust 的硬约束（「侧问不得引入任何持久化。一旦侧问写进 session db……回滚就不再干净」）**直接冲突**，也违反 Goal 2「会话重载后无残留」。原缓解方案错在把「不记内容」等同于「不写入」——**usage 行不含原文，但它照样是一条持久化记录**。

**Mitigation**:
- **改判为「不记 usage」**（已回写进 R-021 与 Plan 步骤 3），理由：本功能的立身之本是「完全不写入、纯临时」（已确认决策 5）。
- 在文件头注释写明这是**故意**的代价，防止后来者「顺手补上」而破坏零持久化。
- **诚实记录副作用**：`/cost` 会少报侧问花费 → 写入「已知限制」，并让 A5 的 db 断言显式断言 `model_usage` **零新增行**。
- **备选（需同时改三处才自洽）**：若要计入 `/cost`，必须同步 ① 改写 Adjust 硬约束为「不写内容、可写用量」；② 改写 Goal 2 口径；③ 把 A5 的 db 断言改为「`model_usage` 至多 +1 行且不含问题原文」。**只改其中一处 = 约束与验证自相矛盾。**

### R-030 「零持久化」缺一份完整通道清单，修复是打地鼠

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.2
**Risk Score**: 4 × 4 × (1 − 0.2) = **12.8**
**判定**：🔴 HIGH

**Failure Scenario**：第 1 轮把「侧问会落盘」定位为**一条通道**（model-io 的 `recordModelIO`），修复也只修那一条。但本仓库把一次模型调用落盘的路至少有**三条**：① model-io（`rollout`/`debug`，由 `shouldRecordModelIO` 控制）；② 会话事件流（`db.sqlite` 的 `session_events`，由 `appendEvent` 写入）；③ 用量表（`db.sqlite` 的 `model_usage`，由 `recordModelUsageFact` 显式写入）。**第 2 轮的「已收敛」结论正建立在这个不完整的通道清单上**——它之所以看起来收敛，是因为当时的验证手段（A2/A5）只覆盖了第 ① 条。凡「以文件/表为单位」断言的功能，都会栽在同一处。

**Mitigation**:
- 在 Plan 步骤 3 里把**三条通道并列写全**（已回写），并把「禁发会话事件」列为与「禁落 model-io」同级的硬约束。
- A2 从「禁三个符号」升级为「**禁一类符号**」（`SessionEventType.` 全形态 + `appendEvent`/`createEvent`/`createModelStatusSink`/`recordModelUsageFact`/`streamText`，已回写）。
- A5 从「两个目录」升级为「**两个目录 + 一个库的两张表**」（已回写）。
- Global scan 第 1 条同步改写为**通道枚举**问题：任何未来的带外调用，都要先回答「它会不会走这三条通道」，而不是复制一份「隔离流」。

### R-031 非流式下长上下文首字节等待久，浮层无进度反馈会被误判为卡死

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 3 × 4 × (1 − 0.5) = **6**
**判定**：🟡 MEDIUM

**Failure Scenario**：走非流式后，答案**整段出现**——`generateText` 返回前浮层没有任何内容变化。而快照是「完整会话含工具结果」（已确认决策 3），长会话下请求可能数十秒才有响应，用户看到的是一个**不动的浮层**，会判定为卡死，进而触发 R-002 的逃生动作（Ctrl+C / Esc），或在超时前放弃。这与 R-002 的超时缓解形成**交互**：超时设短了误杀正常请求，设长了加剧「像卡死」。

**Mitigation**:
- 浮层必须有**显式的进行中态**（i18n 键 `tui.btw.流式中` 已在步骤 11 列出），显示已等待时长；**非流式不等于没有进度反馈**。
- 超时值要**按上下文规模**给足余量并写进计划（不要沿用 `workspace-generate-text.ts` 的 60s——那是给最小 prompt 的探测/短生成用的）；建议先实测再定阈值，与 R-005 的成本实测同批做。
- 手工清单补一条：>100k token 会话下发侧问，观察等待期间**有进行中态**、且不被误超时。

### R-032 无据拒答的证据检查会误伤 CJK：字面关键词匹配几乎必然不命中

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 4 × 4 × (1 − 0.4) = **9.6**
**判定**：🟡 MEDIUM（接近 HIGH）

**Failure Scenario**：R-003 的缓解方案是「装配快照时对问题关键词做一次『是否出现在上下文中』的检查，无证据时主动降级为拒答」。但中文侧问与上下文之间**几乎没有字面重合**：上下文是代码/英文标识符，侧问是「刚才那个函数是怎么实现的」。朴素的分词/字面匹配会大面积**判定为无据**，于是**合法问题被拒答**。更糟的是——**现有验收断言抓不到这个方向**：手工清单只要求「10 个无据问题 10/10 拒答」，一个「无脑全拒」的实现会**满分通过**，而功能实际上已经废掉。这是「缓解方案自己制造新失败」的典型形态（与 R-029 同源）。

**Mitigation**:
- **验收必须双向**：在 10 个诱导型无据问题（要求 10/10 拒答）之外，**另加 N 个「确实在上下文内」的问题，要求 N/N 正常作答**（建议同量级，含中文提问）。**单向验收不算通过。**
- 证据检查定位为**软信号，不是硬闸门**：命中→正常作答；未命中→**不直接拒答**，而是走「低置信」路径（系统约束要求模型显式声明依据，仍答不出才拒答），避免把中文提问一律打死。
- 阈值与匹配策略要**可调且留档**（对齐 R-005 的「可调参数而非写死」），并记录一次实测的**误拒率**作为基线。
- 拒答判定口径本身就是未决项（见 Open Questions）——**本风险说明：口径会同时决定漏拒与误拒，不能再只按「漏拒」单向评估。**

### R-033 非流式使浮层的流式渲染能力失去用武之地，留下误导性实现

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 2 × 3 × (1 − 0.5) = **3**
**判定**：🟢 LOW

**Failure Scenario**：计划多处（步骤 8 的 `MarkdownText`、步骤 11 的 `流式中` 文案、Open Questions）是按**流式**写的。改为非流式后，`MarkdownText` 的 `streaming` 参数与「流式中」文案会**失去对应状态**，实现者可能照抄一个用不上的流式管线（`onDelta` 回调形态的 runtime 方法，见步骤 4），留下一套永远不会被触发的代码。

**Mitigation**:
- 步骤 4 的公开方法形态随之调整：**非流式下不需要 `onDelta`**，`onDone` / `onError` 即可，**除非**要保留将来切流式的接缝（若要保留，必须在注释里写明「非流式期间不会被调用」）。
- 明确「进行中态」的文案语义是**等待**而非**流式渲染**（与 R-031 同一处），避免 `MarkdownText` 的 `streaming` 被误用。

### R-034 第四条持久化通道：JSONL 文件日志（`~/.zcode/cli/log/`），A5 同样不覆盖

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 4 × 3 × (1 − 0.3) = **8.4**
**判定**：🟡 MEDIUM

**Failure Scenario**：除 model-io（`rollout`/`debug`）与会话库（`db.sqlite`）之外，本仓库还有**第四条**落盘通道：`NodeFileLogger` 写 JSONL 到 **`~/.zcode/cli/log/zcode-YYYY-MM-DD.jsonl`**（`debug/server/sources.ts:18-20`），**保留 7 天**（`logging/retention.ts:7`）。它在**生产 CLI 路径上确实被构造**（`cli/src/run.ts:671`、`bootstrap/src/app/create-app.ts:168`），不是测试专有。只要侧问路径的任何一次 `logger.*` 调用带上了问题原文（或 provider 错误里回显了请求片段），答案与提问就进了这个目录——而 **A5 只快照 `rollout`/`debug`，看不到 `log`**。`DefaultLogRedactor` **不构成保护**：它只按**键名**匹配 `api[-_]?key|authorization|cookie|credential|password|secret|token`（`logging/serialize.ts:16-17`）做遮蔽，**对任意内容值明文放行**。

**为什么难以发现**：与前三条同源——验证按「目录/表」枚举，而不是按「落盘通道」枚举（R-030）。`log` 是 `rollout`/`debug` 的**第三个兄弟目录**，最容易在枚举时被漏掉。

**Mitigation**:
- **A5 的快照范围补上 `~/.zcode/cli/log/`**（断言该目录下当日 JSONL 不含侧问问题文本）。至此 A5 覆盖**三个兄弟目录 + 会话库两张表**。
- 步骤 3 加一条硬约束：**侧问的提问原文与答案，不得作为任何 `logger.*` 调用的字段值**（只在注释与代码里传 `querySource`、`tools.length` 一类元数据）。
- Plan 的 Think 章节已定 `[DEBUG-btw]` 前缀日志——**收尾时必须 `grep` 清干净**（该节已写），补一句：**这些调试日志同样不得包含提问原文**，否则调试验证本身就会把内容写进 `log/`。

### R-035 A2/A6 的禁用符号清单与「必须写理由注释」硬要求自相矛盾

**Severity**: 3 | **Likelihood**: 5 | **Detectability**: 0.3
**Risk Score**: 3 × 5 × (1 − 0.3) = **10.5**
**判定**：🟡 MEDIUM（接近 HIGH）

**Failure Scenario**：步骤 3 **强制**要求在 `btw-model-request.ts` 文件头写注释说明「为什么不能走主请求路径」（幽灵 assistant 消息那一节），R-016 与 R-023 也要求把这些结论落进代码注释——这类注释**天然会写出 `emitModelStreamingEvent`、`SessionEventType.ModelStreaming`、`streamText` 这些符号名**。而 A2/A6 是**源码级字符串断言**：断言「文件中不出现 X」，而注释里恰恰有 X。于是断言**必然失败**。

**真正的危害不是断言失败本身，而是失败的「修法」**：实现者只会二选一——① 删掉注释 → **R-016/R-023 的防回归守卫失效**；② 放宽断言（改成匹配更宽松的形态或直接跳过）→ **R-028/R-029 唯一的自动化守卫失效**。两条路都在**静默地拆掉本计划的护栏**，而 CI 仍然是绿的（因为护栏被拆掉了）。

**Mitigation**:
- **A2/A6 断言前先剥离注释**：匹配**可执行代码**而非原始文本——先去掉 `//...` 行注释与 `/* ... */` 块注释，再做子串匹配；或改为匹配**调用点形态**（带左括号/点的形式，如 `emitModelStreamingEvent(`、`this.appendEvent(`、`model.streamText(`）。
- 在 Do 章节**显式写明这条冲突及其正确解法**，避免实现者「用删注释的方式让测试变绿」——这是本风险最可能的落地形态。
- 验收脚本对「剥离注释后仍命中」与「仅在注释中命中」要能**区分报告**（后者不算违规）。

### R-036 A5 的 db 断言在主任务运行中会被正常流量击穿，导致「假失败 → 拆护栏」

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.4
**Risk Score**: 4 × 4 × (1 − 0.4) = **9.6**
**判定**：🟡 MEDIUM（接近 HIGH）

**Failure Scenario**：侧问**最有价值的场景就是主任务运行中**——而主任务运行时会**持续写库**：每一步模型调用都会 `appendEvent`（`methods/events.ts:81-147`）写入 `session_events`，`recordModelUsageFact` 写入 `model_usage`。因此 A5 若按**「前后行数不变」**这种最自然的写法实现，在运行中跑侧问时**必然假失败**。假失败的真实代价不是「测试红了」，而是**它会被当成噪声删掉或放宽**——而 A5 是 R-028 / R-029 / R-034 这**三个 HIGH 的唯一运行时证据**。护栏一旦以「太吵」为由被拆，落库就重新变成不可观测。（这与 R-035 是同一类失效：**验证本身的脆弱，最终以静默移除护栏收场**。）

**Mitigation**:
- **分两次跑，口径不同**（这是本风险的核心解法，必须写进 Do）：
  - **① 空闲态**：空闲时发起一次侧问 → 做**严格**的「零新增」断言（此时无主任务噪声，是最干净的判据）。
  - **② 运行态**：主任务流式中发起侧问 → 只做**归属断言**，不做计数断言。
- **归属断言的锚点**：断言库中**不存在**「`model_usage` 有行且其 `query_source` 为侧问专用值」，以及**不存在**「`session_events` 的 payload 含侧问问题原文的行」。这就要求步骤 3 **必须给侧问设一个可检索的独特 `querySource`（如 `btw`）与 `modelCall.operation`**——否则归属断言**没有锚点**，只能退回计数，重新落入本风险。
- 三个目录（`rollout`/`debug`/`log`）同理：**优先断言「新增文件不含问题原文」**，而不是「无新增文件」——后者在主任务运行中同样会假失败（主任务的 model-io 一直在写）。

### R-037 侧问的 `querySource` 会落进 `default` 分支，被记成「工具内部调用」

**Severity**: 2 | **Likelihood**: 4 | **Detectability**: 0.6
**Risk Score**: 2 × 4 × (1 − 0.6) = **3.2**
**判定**：🟢 LOW

**Failure Scenario**：`ModelApiOperation` 是**封闭 enum**（`contracts/src/telemetry/index.ts:114-126`），`operation` 只能取既有成员。`mapQuerySourceToModelApiOperation`（`:150-204`）只对**枚举过的** querySource 做映射，其余一律落到 `default` → `{ operation: ToolInternalModelCall, actorKind: System }`。因此侧问会被观测面**记成「工具内部发起的模型调用」**——语义错误（侧问既非工具调用也非系统发起，而是**用户发起**），且会稀释 `ToolInternalModelCall` 的统计口径。

**Mitigation**:
- **Phase 1 接受 `default` 映射，不改 contracts**：`querySource: "btw"` 已经提供了 A5 归属断言需要的锚点（见 R-036），而新增 enum 成员会扩大改动面、削弱本计划「纯增量、回滚干净」的定位。**明确记录**这是已知的观测口径偏差，而不是听任它悄悄发生。
- 若后续要把侧问计入观测/成本口径（与 R-029 的备选决策耦合），**那时再一并加 enum 成员与映射分支**——两件事同批做，避免改两次 contracts。
- **注意 A5 的锚点选择**：既然 `operation` 不可自定义，归属断言应以 **`querySource` 字符串**为准，不要以 `operation` 为准（后者是 `ToolInternalModelCall`，与别的调用撞车）。

### R-038 关闭浮层不取消在途请求，回调写向已关闭的浮层

**Severity**: 2 | **Likelihood**: 4 | **Detectability**: 0.5
**Risk Score**: 2 × 4 × (1 − 0.5) = **4**
**判定**：🟢 LOW

**Failure Scenario**：步骤 9 定义 `Esc` 关闭浮层，但**没有定义关闭时是否取消在途的侧问请求**。非流式下答案整段返回，用户等待期间按 `Esc` 关掉浮层是很自然的动作。若不取消：① 一个 `AbortController` 与请求被泄漏到结束（白花 token）；② 请求完成后 `onDone` 回调**向已关闭的浮层写状态**——轻则触发一次无意义的重渲染，重则把条目重新插回 `entries`（浮层「自己又开了」），或对已清空的 state 做写入而抛错。这与「`Esc` 关掉就是不闻不问」的用户预期直接冲突。

**Mitigation**:
- **关闭浮层时 abort 在途请求**（侧问本就有自己的 `AbortController`，见步骤 3）——这是一行接线，不是新机制。
- `onDone` / `onError` 回调必须**先检查该次请求是否仍是当前活跃项**（对齐 `AbortSignal.aborted` 或一个 request id），过期回调**直接丢弃**，不得写状态。
- 手工清单补一条：发起侧问后**立即** `Esc` 关闭，确认不报错、不复活、且不再产生后续渲染。

### R-039 会话接近上下文上限时，完整快照的侧问会直接 context_exceeded 失败

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.35
**Risk Score**: 4 × 3 × (1 − 0.35) = **7.8**
**判定**：🟡 MEDIUM

**Failure Scenario**：快照是「**完整会话含工具结果**」（已确认决策 3）。R-005 已识别「长会话下又慢又贵」，但把它框定为**成本/体验**问题——漏掉了同源的**功能失败**：长会话越接近上下文上限，侧问越可能直接 `context_exceeded` 报错。而主任务能继续跑，是因为它有自己的压缩/裁剪链路；**侧问绕开了那套链路**（这正是它的隔离性的代价）。于是失败恰好集中在**长任务 + 长会话——侧问最有价值的场景**：用户看到的是「侧问又坏了」，而不是「会话太长了」。

**Mitigation**:
- `context_exceeded` 必须有**专门的失败文案**（如「会话过长，请先 `/compact` 再侧问」），**不要**与网络失败/超时共用一条泛化文案——否则用户无从修正。
- 与 R-005 的「最近 N 轮 + 系统提示」降级策略**共用同一个可调参数**（R-005 已要求参数化而非写死）：一旦触发 `context_exceeded`，可按该参数**自动重试一次裁剪后的快照**，而不是直接失败。这样 R-005 的降级路径同时成为本风险的缓解。
- 手工清单把「长会话」用例拆成两条：**>100k token**（R-005 的成本观测）与**接近上限**（本风险的失败路径），后者要求观察到**明确文案**而非泛化报错。

### R-040 【高危】工具执行期间取快照，尾部是「未兑现的 tool_calls」，请求被 provider 拒绝

**Severity**: 4 | **Likelihood**: 4 | **Detectability**: 0.2
**Risk Score**: 4 × 4 × (1 − 0.2) = **12.8**
**判定**：🔴 HIGH ——**本轮最重要的发现**

**Failure Scenario**：主任务运行中，**history 的尾部在「工具执行期间」是一条带 `toolCalls` 的 assistant 条目**，而对应的工具结果**尚未追加**。此时用户输入 `/btw`（**这恰恰是最常见的时机——长任务之所以"在跑"，多数时候是卡在一条 bash 命令 / MCP 调用 / 审批等待上**），快照被原样装配后发给 provider：assistant 消息带 `tool_use` 块却没有紧随其后的 `tool_result` 块 → **provider 直接拒绝请求**（Anthropic：tool_use 后必须紧跟 tool_result；OpenAI 同族约束）。侧问在**最有价值的场景下必然失败**，而用户看到的是一个令人费解的厂商报错。

**证据（源码，逐跳可核）**：
- `turn-model-step.ts:721` — `commitAssistantToTurnRequest(...)` 在**执行工具之前**把 assistant（含 `toolCalls`）提交进 canonical history。紧邻注释（`:719-720`）写明该顺序是**有意**的：只写 canonical history 会让紧随其后的工具结果失去对应 assistant tool-call。
- `turn-output-token-continuation.ts:98-106` → `messageHistory.addEntries(entries)`（`agent/message-history.ts:174-177`）；assistant 条目的 `message.toolCalls` 见 `message-history.ts:368-372`。
- `agent/message-history.ts:220-222` — `borrowReadOnlyRuntimeEntries()` **按引用返回** `this.entries`，因此读取方**立即**看到那条悬空的 assistant 作为尾部。
- `turn-model-step.ts:724-731` → `turn-tools.ts:180` `await this.executeTools(...)` — **窗口 = 整个工具执行耗时的 await**（数秒到数分钟，含权限等待）。
- `turn-tools.ts:281`、`:359-366` — 工具结果在**执行全部返回之后**才逐条追加。
- **无任何修复**：`provider-request-messages.ts`（全文 333 行）与 `runtime-provider-request-messages.ts` 只做附件重排 / mid-conversation system 投影 / 渲染 / cache-control，**没有任何 tool-call 与 tool-result 的配对校验**；全仓库唯一的配对处理是 `target-completion-verification.ts:400-413` 的 `withoutTrailingPendingAssistantToolCallEntries`，且**只被 goal 验证器用一次**（`:135`），**不适用于普通 turn 与任何其他请求**。

**为什么计划的验证抓不到（Detectability 0.2 的来源）**：手工清单写的是「**主任务流式中**输入 `/btw`」。但**流式期间 assistant 条目尚未提交进 history**（提交发生在 model step 结束后的 `:721`）——**那个窗口的快照是干净的，测试必然通过**。真正会失败的是**工具执行期间**，而计划没有任何一条用例打在这个窗口上。**测试恰好选在了唯一不出问题的时刻。**

**Mitigation**:
- **装配快照时做「尾部落尾」**：丢弃尾部那条带 `toolCalls` 的 assistant 条目。**复用仓库已有的 `withoutTrailingPendingAssistantToolCallEntries`**——把它从 `target-completion-verification.ts` **提取到 `core/src/runtime/helpers/` 并导出**（当前是模块内私有），供侧问与 goal 验证器**共用**。**不要复制一份**：复制会与 goal 验证器分叉，正是 Global scan 第 1 条要防的形态。
- **必须补上该 helper 覆盖不到的「部分结果」窗口**（**只看尾部一条是不够的**）：`turn-tools.ts:359-366` 是**逐条**追加结果的循环，若在其中途取快照，尾部是**某条 tool result**，盲删 helper **不会触发**，但 assistant 的 `tool_use` 数与已追加的结果数**不匹配**，同样会被 provider 拒绝。因此正确形态是**按 `toolCallId` 配对裁剪**：丢弃所有没有对应结果的尾部 `tool_use`（必要时整体丢弃该 assistant 条目）。**这是一个需要新写的纯函数**——对齐 R-022 的要求，**写成纯函数并导出**，便于将来接测试。
- **手工清单的用例必须改窗口**：把「主任务流式中输入 `/btw`」改为「**工具执行中**输入 `/btw`」——制造方式：让主任务跑一条长命令（如 `sleep 60`，或一个会等待审批的工具），**在命令执行期间**输入 `/btw`。**保留**流式用例，但只用于验证「主任务输出不停顿」（F-003），**不要**把它当作本风险的验证。
- **验收脚本补运行时断言**：工具执行中发起侧问 → 不出现 400 / `InvalidModelRequest`，且浮层能给出答案。（这条可自动化：`sleep` 命令 + 定时触发侧问。）

### R-041 步骤 3 已膨胀为「六项必须同时正确」的巨石，任一处漏掉都表现为「侧问偶尔失败」

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.6
**Risk Score**: 3 × 3 × (1 − 0.6) = **3.6**
**判定**：🟢 LOW

**Failure Scenario**：经过 3 轮加固，步骤 3 现在必须**同时**做对六件事：① 走 `generateText`；② 带 `skipTranscript: true`；③ 不提供 `statusSink`；④ 不调用 `appendEvent`/`createEvent`；⑤ 不调用 `recordModelUsageFact`；⑥ 装配快照时做**按 `toolCallId` 配对的尾部裁剪**（R-040）。其中任意一条单独漏掉，症状都**收敛为同一句话**——「侧问有时候不好使」，而六种的根因与修法完全不同（落盘 / 400 / 记账）。这会让排障退化成猜谜，也是 R-024「先做独立切片」要防的形态**在新条件下的升级版**。

**Mitigation**:
- **把步骤 3 的独立切片定义成一张六项 checklist**（上列 ①–⑥），**逐条勾选**，不允许「跑通了就都算对」。
- **切片的验收 = 两件事**：ⓐ **主任务跑长命令期间**发起侧问能正常作答（R-040 的窗口）；ⓑ **A5 双快照干净**（三目录 + 两表）。
- 给这六项各留一条 `[DEBUG-btw]` 日志（**只记元数据、不记原文**，见 R-034），让切片阶段能一眼看出是六项里的哪一项没生效——**这正是 Think 章节「框架边界立刻加日志」的落点**。

### R-042 侧问未设输出上限，单个「顺口一问」的花费与耗时无上界

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.5
**Risk Score**: 2 × 3 × (1 − 0.5) = **3**
**判定**：🟢 LOW

**Failure Scenario**：计划给侧问定了「无工具、单轮、复用主会话模型」，但**没有定 `maxOutputTokens`**。侧问的定位是「顺口一问、要短」，而主会话模型往往配置了很高的输出预算（甚至开启高推理档位）。不设上限时，一个开放式问题可能换来数千 token 的长篇回答：**成本无上界**（与 R-005 叠加）、**但非流式下首字节等待更久**（与 R-031 叠加）、**且浮层的行窗口要滚动很久**（与步骤 8 的 UI 设计叠加）。三处放大的是同一个未受约束的量。

**Mitigation**:
- 给侧问设一个**适度的输出上限**（对齐 `workspace-generate-text.ts` 的 `auxiliaryModelOptions` 一类的辅助调用口径），并把它作为**可调参数**而非写死——与 R-005 的「最近 N 轮」同属一组可调项。
- **不要**顺手降推理档位：已确认决策是「复用当前主会话模型」，擅自降档会让答案质量与用户预期不符；**只限输出长度**，不动模型身份。
- 手工清单的 >100k 会话用例**同时记录**耗时与 token（R-005 已要求），把上限调参建立在实测上。

### 已核验并排除的假设（记录以免重复提出）

- **「侧问装配消息时会改写共享 entry、污染主会话或缓存前缀」——不成立。** `renderProjectedEntryToModelMessage`（`provider-request-messages.ts:184-203`）对普通条目返回 **`cloneModelInputMessage(entry.message)`**，对附件条目**新建对象**；`clearNonSystemMessageCacheControl`（`:326-333`）也只**替换数组槽位**（解构产生新对象），**不原地修改**。因此 `buildRuntimeProviderRequestMessages` 不会改写 `messageHistory` 持有的 entry。**结论**：跨会话污染不来自这条路径；缓存前缀问题仍按 Open Questions 走**实测**（不要假设命中，也不必无谓担心被改写）。

---

### 残余风险评估（应用缓解方案后，第 5 轮 / 最终）

| 风险 | 原始分 | 残余分 | 残余判定 |
|------|--------|--------|----------|
| R-001 落盘（model-io） | 20 | **1.5** | 🟢 LOW（决策已定：非流式 + `skipTranscript`） |
| R-002 死锁无逃生 | 14 | 1.5 | 🟢 LOW |
| R-003 拒答不可靠 | 14 | 5 | 🟢 LOW-MEDIUM |
| R-028 会话事件通道落库 | 17 | **2** | 🟢 LOW（步骤 3 禁令 + A2 扩清单 + A5 覆盖 db） |
| R-029 usage 表落库 | 16 | **1.5** | 🟢 LOW（决策已定：不记 usage） |
| R-030 通道清单不完整 | 12.8 | **2.5** | 🟢 LOW（四通道并列写全 + A2/A5 升级为「一类」而非「一条」） |
| **R-040 工具执行中快照尾部悬空 → 400** | **12.8** | **2** | 🟢 LOW（配对裁剪 + 复用既有 helper + **测试窗口改到工具执行期**） |

**残余为何能降到 LOW（而非乐观）**：
- R-001 / R-028 / R-029 / R-030 是**同一根因**（以点代面地断言持久化）的不同表现，缓解方案互相加固：步骤 3 给出**正面先例**（`project-memory-agent.ts`）与**反面示例**（`workspace-generate-text.ts` 的 `appendEvent` 段）；A2 从「禁三个符号」升级为「禁一类符号」；A5 从「两个目录」升级为「**按通道枚举**的四通道」。
- R-040 的残余分能压到 LOW，靠的是**三件事同时成立**：① 复用仓库已有的 `withoutTrailingPendingAssistantToolCallEntries`（不重新发明）；② 补上它覆盖不到的**部分结果**窗口（按 `toolCallId` 配对）；③ **把测试窗口从"流式"移到"工具执行期"**——③ 是降低 Detectability 的关键，因为原清单测的恰好是唯一不出问题的窗口。

**仍未归零的部分（诚实记录，不粉饰）**：
- `/cost` **会少报**侧问的花费（R-029 决策的已知代价）。
- **误拒率没有基线数据**（R-032）：缓解方案是加双向验收（N/N 应答 + 10/10 拒答），但基线要实测才有。
- **超时阈值与输出上限未经实测**（R-031 / R-042）：写进计划的是「实测后定值 + 可调参数」，不是具体数字。
- **缓存前缀是否命中仍是未决的实测项**（Open Questions）：本次只排除了「被改写」，**没有**证明「会命中」。

---

**Pre-mortem 完成（第 5 轮，收敛）**：

- **第 3 轮**：新增 6 个风险（R-028–R-033），其中 **3 个 HIGH**（R-028 / R-029 / R-030）→ **未收敛**。
- **第 4 轮**：新增 7 个风险（R-034–R-040），其中 **1 个 HIGH**（R-040，工具执行期快照尾部悬空）→ **未收敛**。
- **第 5 轮**：新增 2 个风险（R-041 / R-042）+ 1 条已排除假设，**0 个 HIGH** → 按停止条件（**一整轮无新增 HIGH**）**循环收敛**。
- **累计 7 个 HIGH RISK**（R-001 / R-002 / R-003 / R-028 / R-029 / R-030 / R-040）、**37 个中低风险**，全部附缓解方案，并已回写进 Plan / Do / Adjust 章节。
- 7 个 HIGH 的残余分**已全部降至 LOW**（见上表）。

**本轮（第 3–5 轮）推翻的两项历史结论**——这是本次复检的主要价值：
1. 第 1 轮「R-001 做完就没有 HIGH RISK」**不成立**：它只堵住了**四条落盘通道中的一条**（R-028 / R-029 / R-030 / R-034）。
2. 第 1 轮为 R-021 定的缓解方案「**记 usage**」**本身就是一条 HIGH RISK**——它写 session db（R-029）。
3. 第 2 轮的「已收敛」是**假收敛**：当时的验证手段（A2 禁三个符号 + A5 只看两目录）覆盖不到未被枚举的通道，且手工清单的「流式中」用例恰好避开了真正会失败的**工具执行窗口**（R-040）。

> Next step: 按步骤 3 的**六项 checklist**（R-041）先做独立切片：`generateText` + `skipTranscript` + 无 `statusSink` + 无 `appendEvent` + 不记 usage + **按 `toolCallId` 配对裁剪**；以「**长命令执行中发起侧问能作答**」+「**A5 四通道快照干净**」两者同时通过为切片完成判据，再推进步骤 4 起的 UI 工作（对齐 R-024）。

---

## 变更记录：F-005「无据拒答」撤出范围（2026-09-22，实现完成后）

**决策（用户）**：`/btw` **不做拒答判定——问什么都要回答**。上下文里有就优先用上下文（那样更好），没有就正常作答并说明这部分不是来自对话。

**这推翻了计划里的以下内容**（原文保留不删，以记录决策变迁）：

| 位置 | 原内容 | 现状 |
|------|--------|------|
| 已确认决策 1 | F-005 无据拒答是 5 个 P0 之一 | **不做** |
| Goal 第 3 条 | 「上下文不含所需信息时明确拒答并指引改用普通提问」 | 作废 |
| Plan 步骤 10 | 整步「无据拒答（不能只靠提示词）」：哨兵 + 证据检查 + 拒答态 + 埋点标记 | **作废** |
| Do 手工清单 | 「10 个诱导型无据问题 → 要求 10/10 拒答」压力测试 | 作废 |
| R-003 / R-032 | 两条风险的缓解方案与验收口径 | 随功能一并作废 |

**连带删除**：`core/src/runtime/methods/btw-evidence.ts`（95 行）及其在 `test/btw-pure-logic.mjs` 里的 7 条断言。
**为什么是删除而不是留着**：证据检查在旧设计里的**唯一**消费者就是拒答态。拒答态没了，它就只剩「每次侧问都跑、却没人在读结果」——保留它正是 R-033 警告的那种误导性实现。

**代价（诚实记录，不粉饰）**：模型可能对上下文里没有的东西给出**看似合理**的回答，而该回答长得和正常答案一模一样（这正是 R-003 描述的形态，也是当初把它列为 P0 的理由）。这是明确接受的取舍：侧问的定位从「只读上下文的检索器」变成「随时可以顺口一问」，可信度改由用户自己判断。

**残留的约束**：请求里仍写明「优先用上面的对话；没覆盖到就说明这部分不是来自对话」——这是**提示词级的偏好**，不是硬闸门，也没有本地规则替模型决定答不答。

---

# Post-Mortem（2026-09-22，实现完成后）

> 目标：对已实现的 `/btw` 做一次对抗性复检，**验证到没有未缓解的 HIGH**。
> 分三点给结论：① 计划里的高风险现在有多少**运行时**证据；② 实现中**新发现**的缺陷；③ 仍然无法在本环境闭合的部分。
>
> **结论先说**：本轮新发现 **2 个 HIGH**（PM-1 / PM-2），**已修复并补上可证伪的回归保护**；其中 PM-2 是「**缓解方案自己有一个洞**」——R-040 的全部寄望就是那一个裁剪函数，而它在尾部有附件时会整体放弃裁剪。
> 计划里的 7 个 HIGH，现在 **5 个有运行时证据或结构闭合**，**3 项验证**因本机没有 provider 而**不可能在此闭合**（见 §3，这里说的是「未被证明」，不是「已知有问题」）。

## 1. 验证等级提升（本轮新增的证据）

| 原风险 | 之前只有 | 现在有 |
|--------|----------|--------|
| **R-001** model-io 落盘 | 读源码推断 `runner-generate.ts:89` 的闸门 | **运行时证据 + 负向对照**：`test/btw-skip-transcript.mjs` 注入假 AI SDK runtime，落到临时 debugDir——不带 `skipTranscript` **会写出文件**，带 `skipTranscript` **零文件**。两次结果不同才说明被测的是那道闸门本身（闸门恒关也会让「零文件」变绿）。已证伪：把 metadata 里的 `skipTranscript` 去掉，该断言立刻 FAIL。 |
| **R-028** 会话事件通道 | A2 禁符号（源码字符串） | **结构闭合**：adapters 包**零** `SessionEventType` 引用（grep 实证）；`modelFactory` 全程不碰会话事件（`provider-registry-model-runtime.ts` 同样零引用）。侧问的调用链只有 `createRuntimeModel` + `withModelInvocationContext` + `model.generateText`，没有任何一环能发会话事件。 |
| **R-040** 工具执行期快照悬空 | 只有计划里的推理 | **8 条行为测试**覆盖全悬空 / 部分结果 / 全部兑现 / 无工具回合 / 孤立 tool_result / 尾部附件 / 附件夹在结果之间 / 配对完整+附件；并已证伪（见下文 PM-2 的反例注入）。 |
| **R-002** 逃生口 | 只有键位设计 | `shouldConsumeBtwKey` 有行为断言：Ctrl+C **不被吞**。超时链路仍需 provider（§3）。 |
| **R-030** 通道清单 | 四通道表 | 四通道各自有对应控制手段；① 有运行时证据、② 有结构闭合、③ 有源码断言、④ 由「侧问自身的日志**只记计数与元数据、不记提问原文与答案**」+ 适配层既有脱敏覆盖（本轮加了 R-008 要求的 toolCalls 计数告警后，本模块不再是零日志）。 |

> **A2/A6 的可证伪性**也做了实测：注入 `appendEvent` 调用 → A2 FAIL；`tools: []` 改非空、`skipTranscript: true` 改 false → A3/A6 FAIL。恢复后 7/7。

## 2. 本轮新发现并已修复的缺陷

### [PM-1] 失败态没有手动重试 —— R-018 的缓解方案没落地

**位置**：`tui/src/app-btw-keyboard.ts` + `app-btw-controller.ts`
**严重度**：High ｜ **类型**：计划 vs 实现落差

**描述**：R-018 明确要求「重试预算耗尽后必须进入浮层失败态并保留问题原文，**提供一次手动重试**——这是「裸失败」与「可恢复」的分界」。实现只做了失败态与文案，**没有任何重试入口**：用户唯一的选择是关掉浮层把那句话重新打一遍。

**修复**：失败态绑定 `r` 重试（`applyBtwResult` 已保留问题原文，重试直接复用），并在状态行显示 `r 重试`——键位存在但没人告诉用户等于不存在。非失败态按 `r` 不触发（重试在飞的请求只会自己取消自己）。

**回归保护**：`PM-1 失败态：r 触发重试` / `PM-1 非失败态：r 不触发重试` / `PM-1 r 不误触关闭`。

### [PM-2] 尾部一条 system reminder 就让 R-040 的裁剪整体失效

**位置**：`core/src/runtime/helpers/pending-tool-calls.ts`
**严重度**：High ｜ **类型**：缓解方案自身的洞（与 R-032 同源：缓解方案制造新失败）

**描述**：R-040 把「工具执行期 400」的全部希望押在这一个函数上。但它扫描尾部时**遇到附件条目就中止**，随后判定「尾部那条不是 assistant → 原样返回」。于是只要尾部多一条 system reminder（shell 环境变化 / 目标变更 / 日期变更 / 计划提醒），**悬空 tool_use 照样进请求 → provider 400**。这个洞继承自被提取的旧实现（原本只服务 goal 验证器），提取时被一并带了过来。

**修复**：附件**跳过而不是中止**——它既不参与 `tool_use`/`tool_result` 配对，也不该让裁剪放弃。配对完整时仍原样保留附件（不误裁合法消息）。

**回归保护**：`PM-2 尾部附件不阻止裁剪` / `PM-2 附件夹在结果之间` / `PM-2 配对完整 + 尾部附件：历史原样保留`。

**同源清扫（Global scan）**：`pending-tool-calls.ts` 是 goal 完成验证与侧问**共用**的唯一一份；修复对两侧同时生效（goal 验证器原本也有同一个洞）。未发现第二处复制品。

### [PM-6] 提交侧问后输入框不清空 —— 下一次回车会把 `/btw 问题` 当普通提问重发

**位置**：`tui/src/app-submit-controller.ts`
**严重度**：High ｜ **类型**：控制流副作用遗漏（截获路径绕过了清理）

**描述**：`/btw 问题` 在两条正常提交路径（idle / busy）**之前**被截获，而清空输入框是那两条路径各自做的事（各自调 `setDraftValue("")`）。截获后直接 `return`，输入框里仍留着 `/btw 问题`——用户下一次回车会把它当成**普通提问**发出去。这比「看起来脏」严重：它把一次「不写入」的侧问，在下一拍变成了一次真正落进转录、且**带工具**的正常 turn，正是本功能要消灭的东西。

**修复**：截获分支自己清空输入框（清空值也会顺带丢弃已不在文本中的附件占位符）。`cancel-await` 分支**不清**——那次输入还要继续走普通路径。

**回归保护**：这一条是 React 层的副作用，本仓库没有渲染测试，**没有自动化断言**；已写进手工清单（见 §4 P-3）。纯函数层能保证的是「问题原文已被完全消费」，但那证明不了输入框被清空。

### [PM-7] 回归保护自身会在回归时崩溃而不是判 FAIL

**位置**：`test/btw-pure-logic.mjs`
**严重度**：Medium ｜ **类型**：测试自身缺陷（护栏失效形态）

**描述**：断言失败时构造的详情串直接解引用 `entry.message.role`，而附件条目没有 `message`。于是「裁剪行为回归」表现成 `TypeError` 崩溃——看起来像测试基础设施坏了，而不是被判成 FAIL。**这正是本计划反复点名的形态**：护栏不是被抓坏，而是**在真需要它的那一刻不好用**，然后被当成噪声处理掉。已在 PM-2 的证伪实测中暴露（旧行为下 3 条断言整片崩溃，而不是干净失败）。

**修复**：详情串改用不会越界的 `shapeOf`。修复后同样的证伪输入得到 **43/45 的干净 FAIL**（两条 PM-2 断言命中、第三条正确地仍为绿）。

### [PM-8] 抽屉里划选不触发「选中即复制」

**位置**：`tui/src/app-view.tsx`
**严重度**：Medium ｜ **类型**：事件边界遗漏（新节点没接上既有语义）

**描述**：全应用的「鼠标划选即复制」挂在 `AppShell` 的 `onMouseUp` 上（`handleShellMouseUp` → `copyCurrentSelection`）。侧问抽屉是 `AppShell` 的**兄弟节点**（当初为了让半透明底铺满整屏才放到外层），于是抽屉区域内的划选**根本不经过**那个 handler——功能没坏，是新节点没接上既有语义。

**修复**：把 `onMouseUp` 上移到最外层的整屏 box，覆盖包括抽屉在内的所有区域。同时**不再把焦点抢回输入框**：抽屉持有键盘焦点时抢回来会让下一次按键打字进输入框。

**回归保护**：纯鼠标行为，本仓库无渲染测试，**无自动化断言**；已写进手工清单（P-3）。

### [PM-3] 极矮终端下抽屉高于屏幕

**位置**：`tui/src/app-btw.ts::resolveBtwPanelHeight`
**严重度**：Medium ｜ **类型**：边界条件

**描述**：`max(下限 8, 屏幕高/2)` 在 <16 行的终端上会算出比屏幕还高的抽屉，直接顶穿布局。R-026 点名的就是「极窄 / 极矮终端」。

**修复**：上限压在终端高度以内。回归保护：`PM-3 极矮终端：抽屉不超过终端高度`。

### [PM-4] 不可达分支（死代码）

`wrapParagraph` 里的 `if (head.length === 0)`：`room >= 1` 时 `takeDisplayWidth` 至少吃下一个字符，head 必非空。已删除并注明理由。

### [PM-5] 证据检查是主线程同步全量扫描 —— 已量化，**关闭**

先前怀疑长会话下这次字面扫描会卡住 TUI。实测：**256k token 语料单次 1.2 ms**。不构成风险，记录数值以免重复怀疑。

## 3. 仍然无法在本环境闭合的部分（诚实记录）

以下三项**不是**「已知有问题」，而是「**未被证明**」——它们都需要一个已配置 provider 的真实会话：

1. **A5 的完整快照比对**：`rollout`/`debug`/`log` 三目录 + 会话库四张表。当前 `~/.zcode/cli/config.json` 无任何 provider，脚本也刻意**不静默跳过**。① 通道已用 §1 的运行时用例单独证明，但 `log/` 与 `model_usage` 的端到端仍待跑。
2. **R-002 的超时逃生链路**：`AbortSignal.timeout` 触发 → 失败态 → 此时 Ctrl+C 仍能停主任务。定时器与键位各自有断言，**接起来的那一段**没跑过。
3. ~~**R-003 的模型遵从度**~~ **已随 F-005 撤出范围而作废**（见上文「变更记录」）：不再有拒答判定，也就不存在「10/10 拒答」这条验收。

另外两条**规格落差**，明确延期并给出理由（计划要求「要么实现，要么明确延期」）：

- **R-039 的「`context_exceeded` 后按可调参数自动重试裁剪后的快照」未实现**。当前只做了计划的第一条缓解（专用文案 + 指引 `/compact`）。延期的理由：裁剪快照必须**同时**处理尾部悬空与**头部孤立的 tool_result**（从中间切片会让首条是 `role: "tool"`，同样是非法序列），这是一个新的纯函数 + 一组新的边界，属于**独立切片**，不该塞进本轮；而在没有 provider 的情况下也无法验证它真的修好了 `context_exceeded`。
- **R-005 / R-042 的可调参数只有形没有实**：`maxOutputTokens` 与超时都是模块常量 + 调用方可覆盖，没有配置项，也没有实测基线。理由同 R-005 原文：调参要建立在对 >100k token 会话的实测上，本环境没有 provider。

## 4. 预防措施

| # | 任务 | 类型 |
|---|------|------|
| P-1 | 新增 `pnpm run test:btw`（三套共 56 条断言，本轮已加） | ✅ 已做 |
| P-2 | 把 `test:btw` 接进 `verify:pre-push`（当前只有 lint + architecture + zero-account，新护栏不会自动跑） | AFK（待定：会改变所有人的 pre-push 时长） |
| P-3 | 配一个 provider，跑完 §3 的三项 + 计划里的手工清单（尤其「长命令执行中输入侧问」与逃生演练，PM-6 的「提交后输入框清空」、PM-8 的「抽屉里划选即复制」） | HITL |
| P-4 | 让 A5 的 `--verify` 在无 provider 时给出**可操作**的下一步（当前只给用法） | AFK |
| P-5 | 把「按 `toolCallId` 配对」的理由补进 `CONTEXT.md` 指针（R-023：关键洞察不能只活在计划文档里） | AFK |
| P-6 | **新增带外模型调用前，先搜仓库里有没有既成的「契约遵守」口径**（如 `auxiliaryModelOptions` 的 `Math.min(..., spec.max)`），不要自己发明常数。PM-9 就是没对齐这个惯例 | AFK（纪律，非代码） |

## 5. 根因

1. **PM-1 / PM-2 / PM-6 同一根因**：**缓解方案只被写进计划，没有被写进「验收集合」**。R-018 要求「手动重试」、R-040 要求「配对裁剪」，实现时把注意力放在「主流程能跑」上，而这四条恰好都在**异常/边界路径**上——正常测试路径永远不会触发它们（PM-6 甚至连异常都不需要：它在**成功路径**上，只是截获点早于清理点）。这与计划自己在 R-011/R-035/R-036 反复点名的形态完全一致：**护栏最容易死在没人走的那条路上**。
2. **PM-2 的修复同时暴露了「提取即继承洞」**：把 goal 验证器的私有函数提成共享件时，只核对了它的**语义**（尾部悬空），没核对它的**前置假设**（「尾部一定是 tool result 或 assistant」）。提取共享件时要连假设一起复核。

---

# Post-Mortem 第 2 轮（2026-09-22，F-005 撤出 + 鼠标改动之后）

> 范围：**整体实现**（不只是增量）。指令：验证到没有未缓解的 HIGH。
>
> **结论**：本轮新发现 **1 个 HIGH（PM-9）**，**已复现、已修、已加可证伪的成对断言**。另有 3 条中低问题与 1 条文档漂移，全部已修。上一轮那条「已修但只是推断」的鼠标问题，本轮**从框架源码拿到了证据**：事件确实冒泡。

## 本轮新发现并已修复

### [PM-9] 输出上限写死 → 在低上限模型上侧问**整条失败**（High）

**位置**：`core/src/runtime/methods/btw-model-request.ts`
**类型**：契约违反（写死的常数越过了模型自己声明的范围）

**描述**：侧问把 `maxOutputTokens` 写死为 2048。而 `Model.prepareRequest` → `validateOptions` 对**超范围**的值**直接抛 `invalidRequest`**。于是任何 spec 上限低于 2048 的模型，侧问都**整条失败**，用户看到的是「maxOutputTokens is outside the model option range」——一句与侧问毫不相干、也无法自行修正的报错。

**已复现**（不是推断）：构造一个 spec 上限 1024 的模型，用写死的 2048 调 `generateText` → 抛错。

**为什么之前没发现**：这条只在**特定模型**上触发，而本机没有 provider，任何真实请求都没跑过。同时 `test/btw-side-question.mjs` 的 A3/A6 是源码断言，读不出「常数与模型 spec 的关系」。

**修复**：钳制到模型 spec 上限——这正是仓库里 `model/auxiliary-model-options.ts` 已有的口径（7 处调用点）。**只借钳制，不动 `reasoningLevel`**：已确认决策要求复用主会话模型，擅自降档会让答案质量与预期不符（R-042）。

**佐证**：`provider-registry-model-runtime.ts` 里那句注释直接说明了责任归属——「输出预算属于单次请求，由 Agent 执行链显式决定，不能在 ModelFactory 中静默绑定」。也就是说**调用方**（本模块）负责把预算压进模型范围内。

**回归保护**（成对，缺一不可）：
- 写死的 2048 在 spec=1024 的模型上**被拒**（证明这条测试能失败）；
- 钳制后的值在同一个模型上**通过**。
两条都真的跑 `validateOptions`，不是只算数学。

### [PM-14] 失败的真实原因被丢弃，用户只看得到一句泛化文案（Medium）

**位置**：`tui/src/app-btw.ts` + `app-btw-panel.tsx`
**类型**：可诊断性缺失（错误被 catch 后**静默降级**）

**描述**：链路把失败原因一路带到了 UI（`TuiSideQuestionResult.failure.message` 是 provider 的原文），但 `applyBtwResult` 只存 `reason`，面板也只渲染按 reason 查表得到的泛化文案——**真实原因从来没被显示**。用户看到「侧问请求失败。」，无从知道是 401、是限流，还是模型没选中。本仓库对主请求路径的既有口径是 `tui.model.requestFailed(message)`——把原文带上。

**修复**：`BtwEntry.failureMessage` 存原文，面板在泛化文案下再渲染一行「原因：…」。泛化文案负责「这是什么状态」，原文负责「我该怎么办」。

### [PM-15] 窄终端下换行宽度按 24 列兜底，与实际抽屉宽度不符（Low）

**位置**：`app-btw-panel.tsx`
**类型**：计算依据与渲染依据不一致

**描述**：`normalizeContentWidth` 里有个 `Math.max(24, …)` 下限——那是面板还是「居中定宽」时代留下的。抽屉改成贴底满宽后，抽屉**没有**最小宽度，于是窄终端（<24 列）上：换行按 20+ 列算、实际只有 16 列可用 → 渲染器二次折行 → 行窗口切片与「↓N」提示同时错位（R-026 点名的场景）。

**修复**：换行宽度直接取 `终端宽度 - 4`（边框 2 + padding 2），不再引入与渲染无关的下限。

### [PM-10] R-008 要求的「toolCalls 计数告警」没实现（Medium）

**位置**：同上
**类型**：规格落差

**描述**：计划 R-008 明确要求「在发现 `toolCalls` 非空时**计数告警**」。实现只在返回值里放了一个 `toolCallCount`，而**没有任何调用方读它**——等于把一条要求做成了一个没人看的字段。这也是 R-033 警告的形态：看起来有防护，实际没有。

**修复**：真的打一条 `logger.warn`，**只记计数与 trace 元数据，不记提问原文与答案**（R-034：日志是第四条落盘通道）。

### [PM-11] 头注释里的表名与实现不符（Low，文档漂移）

头注释写「会话事件流 → `session_events`」，但该表在本构建的 schema 里**不存在**（实际是 `session_entry` / `message` / `part`）。已订正。这条漂移会误导后来者按错误表名去验证。

### [PM-12] 无人消费的 `usage` 字段（Low）

`BtwModelResult.usage` 没有任何调用方读取。按 deletion test 删除——留着一个没人用的字段，下一位读者会以为它在某处被记录/使用了。

### [PM-13] A5 的库查询没转义 LIKE 通配符（Low，护栏自身脆弱）

探针问题里若含 `%` 或 `_`，`data like '%…%'` 会过匹配 → **断言假失败**。而假失败的真实代价是这个护栏被当成噪声删掉——正是本计划反复点名的失效形态。已加 `escape`。

## 本轮新增的最强证据（第 3 轮补）

上面 PM-2 修好之后，R-040 的裁剪一直只用**手搓 entry** 测。第 3 轮补了一条**端到端**断言：
用真的 `MessageHistoryImpl` 造出「工具执行中」的历史（assistant 带 `toolCalls`、结果尚未回来），
走真的 `buildRuntimeProviderRequestMessages` 投影，然后直接检查**发出去的那份消息**满足
provider 的配对不变量（每条 assistant 的 `tool_use` 后面紧跟同数量的 `tool` 消息）。

这条比纯函数断言强在：它同时覆盖了**投影层**——手搓 entry 的测试完全绕过了那一层。
同时断言系统提示与提问都还在，防止「裁剪过头把合法消息吃掉」。

## 本轮关闭的怀疑（有证据，不是推断）

| 怀疑 | 结论 | 证据 |
|------|------|------|
| 上一轮「抽屉里划选即复制」只是推断，可能不成立 | **成立** | 读 opentui 源码：`processMouseEvent` 会 `this.parent.processMouseEvent(event)`，鼠标事件**确实冒泡**；抽屉内也没有任何 `stopPropagation`（只有子代理只读视图与侧边栏有，二者与抽屉互斥） |
| `AbortSignal.timeout(180s)` 每次侧问留一个定时器，可能钉住事件循环 | **不成立** | 实测：创建信号后不 await 任何东西，进程 **1 ms** 退出 → 定时器是 unref 的 |
| `reasoningLevel` 缺失会不会让侧问在 `validateOptions` 上炸 | **不会** | `provider-registry-model-runtime.ts` 的工厂把 session 的 `reasoningLevel` 绑进模型（`options: { reasoningLevel: target.selection.options!.reasoningLevel! }`），与主任务同源 |
| i18n 有没有残留的孤儿键 | **没有** | 逐个比对「定义的 btw 键」与「被消费的 btw 键」，一一对应 |

## 第 2 轮的根因

**PM-9 与 PM-10 同一根因，且与第 1 轮的根因是同一个**：**「调用方必须遵守的契约」没有在本机被执行过**。

- PM-9：`validateOptions` 的上限约束是**真实存在的契约**，仓库里已有 7 处调用点用 `Math.min(..., spec.max)` 遵守它——我没有对齐这个既有惯例，因为我按「常量 + 可覆盖」设计时，脑子里没有那个校验器。
- PM-10：计划的缓解方案写的是「计数告警」，我实现成了「返回一个计数」——**动作被降级成了数据**。

两条的共同点：本机没有 provider，**任何真实请求都没跑过**，所以所有「只有真跑一次才会撞上」的契约都不在反馈回路里。这也是本计划从第 1 轮起就写在「仍未归零」里的那一条。

**可操作的推论**：本仓库既然有 `auxiliaryModelOptions` 这种「契约遵守」的既有实现，新增同类调用时应**先搜有没有现成口径**，而不是自己发明一个常数。这一条已写进 P-6。
