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
   - **请求 metadata 必须带 `skipTranscript: true`**。`runner-generate.ts:89` 已支持该开关（`input.request.metadata?.skipTranscript !== true && shouldRecordModelIO(...)`），但 `runner-stream.ts:117` 只有 `shouldRecordModelIO(input.env)`，**没有这个开关**——不改它，侧问的完整会话快照与答案会被落盘到 `~/.zcode/cli/rollout`（见 R-001）。
     **按 Pre-Mortem 的建议走非流式（`generateText`）**：退出口今天即生效、零 adapter 改动，R-001 立刻归零，也不需要承担 R-018。等 `runner-stream.ts` 对齐后再切流式是纯增量改动。
   - **运行时 header 刷新必须挂上**：对齐 `project-memory-agent.ts:55` 的 `createRefreshRuntimeHeadersBeforeModelAttempt(...)`，否则长会话里凭据过期后侧问 401 而主任务正常（见 R-019）。
   - **需要一条失败回退路径**：对齐 `compact-summary-model-request.ts` 的做法，请求失败时不要让侧问裸失败（见 R-018）。
   - **usage 记账：记 usage、不记内容**。`recordModelUsageFact` 是逐点显式调用的（`compact-active.ts:418,457`、`title-generation-sidecar.ts:158,185` 都调了），不调则 `/cost` 少报。显式调用它并在此处注释说明这是**故意**的（见 R-021）。
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
| A2 | **源码级**：`btw-model-request.ts` 中不出现 `emitModelStreamingEvent`、`SessionEventType.ModelStreaming`、`runModelTextRequest` | 直接钉住幽灵消息陷阱；这是 A 类断言里唯一能自动化验证「不污染」的方式 |
| A3 | **源码级**：`btw-model-request.ts` 中 `tools` 恒为空数组 | 钉住「无工具」硬约束 |
| A4 | headless `zcode -p "/btw xxx"` 返回明确的「交互式 TUI 专用」提示，且**退出码与输出中不含模型响应内容** | 覆盖步骤 2；若被转发给 agent，输出中会出现模型生成的答案，断言即失败 |
| A5 | **运行时**：跑一次侧问前后对 `~/.zcode/cli/{rollout,debug}` 做目录快照对比，断言无新增文件、或新增文件中不含侧问问题文本 | 唯一能证伪 R-001 的断言。这是**运行时**证据，补足了 A2/A3 源码断言证明不了的部分 |
| A6 | **源码级**：`runner-stream.ts` 的 `recordModelIO` 计算已与 `runner-generate.ts:89` 对齐（含 `metadata?.skipTranscript` 判定） | 钉住 R-001 的修复不被回退；这是 A5 能通过的前提 |

> A2/A3 是源码断言而非行为断言，这是**权衡后的选择**：本仓库无测试框架（无 `*.test.*`、无 test script），且「不污染」的唯一可靠运行时证据需要启动完整 TUI 会话。源码断言能捕获真实回归（后来者把侧问统一到主请求路径），代价是它不能证明运行时一定不污染——因此下面的手工清单不可省略。

**手工 TUI 验证清单**（在真实终端跑 `pnpm --filter @zcode/cli dev`，逐条走）

- [ ] 空闲时 `/btw <会话题内的问题>` → 浮层给出答案；`/context` 的数字**与问之前一致**。
- [ ] **主任务流式中**输入 `/btw` → 浮层正常出现，且**主任务输出不出现停顿**（观察字符流连续性）。
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

**Global scan**（改完后逐条回答，不要只修一处）

1. **同一形态的陷阱还有谁？** `emitModelStreamingEvent` 的「以主 sessionId 发布 → TUI 无条件并入转录」这一组合，对**任何**未来的带外调用都成立。本次除侧问外，检查是否还有其他调用点走主请求路径但语义上不该进转录；若有，把「隔离流」抽成共享形态而不是复制第二份。
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
> 本轮找到 **3 个 HIGH RISK**（>12）与 13 个中低风险。三条 HIGH 里有两条会**直接摧毁功能的立身之本**（R-001 违反"不写入"，R-003 让答案不可信），且**计划原有的验证手段都抓不到**——它们的缓解方案已回写进 Plan 与 Do 章节。

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

**Mitigation**:
- 把 `runner-stream.ts:117` 的 `recordModelIO` 计算**与 `runner-generate.ts:89` 对齐**，支持 `metadata?.skipTranscript`。这本就是两条路径应当具备的对称性，属顺手修掉的一个潜在缺陷。
- `/btw` 请求显式设置 `metadata: { skipTranscript: true }`。
- 新增**运行时**断言 A5（侧问前后对 `~/.zcode/cli/{rollout,debug}` 做目录快照对比）+ 源码断言 A6（钉住该修复不被回退）。
- **备选方案**（不想动 adapter 时）：`/btw` 改用 `generateText`——退出口今天已生效、零改动，代价是失去流式浮层。这正好与 Open Questions 里「是否展示流式」是同一个决策，可一并定。

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

**Failure Scenario**：计划要求直调 `model.streamText`（为隔离流）。但主路径经过 `runner-stream.ts` 的完整恢复机制（retryBudget、`signatureRepairAttempted`、`emptyCompletionRetryCount`）。直调若不继承这些，偶发的 provider 抖动会让侧问失败，而同样的抖动主任务能自愈——用户感受为「侧问怎么老失败」。

**Mitigation**: 对齐 `compact-summary-model-request.ts` 的做法——它有显式的失败回退（stream 失败改走 `generateText`）。侧问同样需要一条失败回退路径，而不是裸调一次就放弃。

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

**Mitigation**: 在计划里显式定：**记 usage、不记内容**——既让 `/cost` 诚实，又不违反「不写入内容」。并把这一点写进步骤 3 的注释，避免后来者顺手删掉。

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

### 残余风险评估（应用缓解方案后）

| 风险 | 原始分 | 残余分 | 残余判定 |
|------|--------|--------|----------|
| R-001 落盘 | 20 | **待定** | 🔴 **仍为 HIGH，直到做出下面的决策** |
| R-002 死锁无逃生 | 14 | 1.5 | 🟢 LOW |
| R-003 拒答不可靠 | 14 | 5 | 🟢 LOW-MEDIUM |

R-002 残余降低来自「侧问自带超时 + Ctrl+C 明确排除 + 逃生演练」三条**已写进 Plan 步骤 3/9 与手工清单**的具体动作，它们互相独立，任一条生效即可解锁死锁。
R-003 残余降低来自「证据检查强制降级」这条**不依赖模型自评**的硬路径，配合 10/10 压力测试。

**R-001 无法靠缓解方案单方面归零，因为它卡在一个尚未做出的决策上**：

> 若走**流式**且不做 `runner-stream.ts` 的修复 → 残余分仍是 **20**（HIGH，未变）。
> 若走**流式 + 修 `runner-stream.ts:117`** → 残余 **1.5**（LOW）。
> 若走**非流式（`generateText`）** → 残余 **1.5**（LOW），且**零 adapter 改动**，退出口今天即可用。

**建议**：**先按非流式落地**。代价只是答案整段出现而非逐字出现——对一个「顺口一问」而言完全可以接受；换来的是 R-001 立刻归零、不需要动 `adapters` 这个更底层的包、也不需要额外承担 R-018（绕过流恢复机制）的风险。等 `runner-stream.ts` 的 `skipTranscript` 对齐做完，再切流式是一个纯粹的增量改动。**这一步做完，本计划就没有 HIGH RISK 了。**

---

**Pre-mortem 完成（第 2 轮）**：

- **本轮新增 11 个风险，其中 0 个 HIGH** → 按停止条件（一整轮无新增 HIGH）**循环收敛**。
- 累计 **3 个 HIGH RISK、24 个中低风险**，全部附缓解方案，并已回写进 Plan / Do 章节。
- 3 个 HIGH 中，**R-002 / R-003 的残余风险已降至 LOW**；**R-001 是唯一未归零项，卡在「流式 vs 非流式」这个决策上**。建议按上面的建议定为非流式，即可清零。

---

> Next step: 按建议把 R-001 定为**非流式**，同步更新步骤 3（去掉 `metadata.skipTranscript` 与 `runner-stream.ts` 修改，改为 `generateText` + `skipTranscript: true`，后者今天已生效）与 Open Questions 里的「是否展示流式」；随后即可开工。
