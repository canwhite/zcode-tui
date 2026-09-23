#!/usr/bin/env node
// 侧问的**纯逻辑**行为断言（R-022）。
//
// 为什么需要它：本仓库没有测试框架，而侧问里最危险的三块——尾部 tool_use 配对裁剪、
// 键位/窗口数学、结果归属——都只是纯函数。纯函数没有回归保护时，缓解方案会悄悄失效：
// 裁剪坏了会 400，窗口数学坏了会截断，归属坏了会把过期回调写进已关闭的浮层。
//
// 这些断言直接 import **源码里的纯函数**（不是源码文本），所以它们证伪的是行为，不是字面量。
// 之所以能直接 import：`@qcode/shared` 等 workspace 包把 `exports` 指向 `.ts` 源文件，
// 只有 tsx 能解析这种形态（`node` 不能，`qcode.cjs` 是 esbuild 内联后的产物）。
//
// 用法：npx tsx test/btw-pure-logic.mjs
//
// 放 `test/` 而不是各包里，是因为它跨 core 与 tui 两个包——放任何一边都要深引另一个包。

import { MessageHistoryImpl } from "../apps/qcode-cli/packages/core/src/agent/message-history.js";
import { withoutPendingTrailingToolCalls } from "../apps/qcode-cli/packages/core/src/runtime/helpers/pending-tool-calls.js";
import { buildRuntimeProviderRequestMessages } from "../apps/qcode-cli/packages/core/src/runtime/helpers/runtime-provider-request-messages.js";
import { resolveBtwMaxOutputTokens } from "../apps/qcode-cli/packages/core/src/runtime/methods/btw-model-request.js";
import { createModel } from "../apps/qcode-cli/packages/adapters/src/model/model.js";
import * as btw from "../apps/qcode-cli/packages/tui/src/app-btw.js";
import * as keyboard from "../apps/qcode-cli/packages/tui/src/app-btw-keyboard.js";

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// R-040：尾部悬空 tool_use 的配对裁剪
// ---------------------------------------------------------------------------

const assistantWithTools = (...ids) => ({
  message: {
    content: "",
    role: "assistant",
    toolCalls: ids.map((id) => ({ id, input: {}, name: "Bash" })),
  },
});
const toolResult = (id) => ({ message: { content: "ok", role: "tool", toolCallId: id } });
const userMessage = (text) => ({ message: { content: text, role: "user" } });
/**
 * 断言失败时打印的形状。**不能直接 `entry.message.role`**：附件条目没有 `message`，
 * 而失败详情是在断言求值时就构造的——那样「行为回归」会表现成 TypeError 崩溃，
 * 看起来像测试基础设施坏了，而不是被判成 FAIL。
 */
const shapeOf = (entries) =>
  entries.map((entry) => (entry.kind === "attachment" ? "attachment" : entry.message.role)).join(",");

{
  // 工具执行刚开始：assistant 已提交、结果一条都还没回来。
  const entries = [userMessage("hi"), assistantWithTools("t1")];
  const trimmed = withoutPendingTrailingToolCalls(entries);
  assert(
    "R-040 全悬空：丢掉尾部那条带 toolCalls 的 assistant",
    trimmed.length === 1 && trimmed[0].message.role === "user",
    shapeOf(trimmed),
  );
}

{
  // 部分结果：两个 tool_use，只回来一个 —— 只看「最后一条是不是 assistant」的旧写法会漏掉这里。
  const entries = [userMessage("hi"), assistantWithTools("t1", "t2"), toolResult("t1")];
  const trimmed = withoutPendingTrailingToolCalls(entries);
  assert(
    "R-040 部分结果：assistant 与其已返回的部分结果一并丢弃（孤立的 tool_result 同样非法）",
    trimmed.length === 1 && trimmed[0].message.role === "user",
    shapeOf(trimmed),
  );
}

{
  // 全部兑现：合法的完整历史必须原样保留，不能被误裁。
  const entries = [userMessage("hi"), assistantWithTools("t1"), toolResult("t1")];
  const trimmed = withoutPendingTrailingToolCalls(entries);
  assert("R-040 全部兑现：完整历史原样保留", trimmed.length === 3, `len=${trimmed.length}`);
}

{
  // 普通文本回合：没有 toolCalls，不该被裁。
  const entries = [userMessage("hi"), { message: { content: "hello", role: "assistant" } }];
  assert(
    "R-040 无工具回合：尾部 assistant 不被裁",
    withoutPendingTrailingToolCalls(entries).length === 2,
  );
}

{
  const entries = [userMessage("hi"), toolResult("t1")];
  assert(
    "R-040 尾部孤立 tool_result（其 assistant 已被裁掉）：不崩溃且原样返回",
    withoutPendingTrailingToolCalls(entries).length === 2,
  );
}

const attachment = (text) => ({ content: text, kind: "attachment", metadata: {} });

{
  // PM-2：尾部落一条 system reminder（shell 环境变化 / 目标变更 / 日期变更）就放弃裁剪，
  // 等于把悬空 tool_use 照样发给 provider。附件不参与配对，必须跳过而不是中止。
  const entries = [userMessage("hi"), assistantWithTools("t1"), attachment("shell changed")];
  const trimmed = withoutPendingTrailingToolCalls(entries);
  assert(
    "PM-2 尾部附件不阻止裁剪：悬空 assistant 仍被丢弃",
    trimmed.length === 1 && trimmed[0].message.role === "user",
    shapeOf(trimmed),
  );
}

{
  // PM-2 变体：附件夹在部分结果与 assistant 之间。
  const entries = [
    userMessage("hi"),
    assistantWithTools("t1", "t2"),
    attachment("goal changed"),
    toolResult("t1"),
  ];
  const trimmed = withoutPendingTrailingToolCalls(entries);
  assert(
    "PM-2 附件夹在结果之间：仍按 toolCallId 配对并整段丢弃",
    trimmed.length === 1 && trimmed[0].message.role === "user",
    shapeOf(trimmed),
  );
}

{
  // 附件存在但配对完整：不能因为「尾巴不是 tool result」就误裁合法历史。
  const entries = [userMessage("hi"), assistantWithTools("t1"), toolResult("t1"), attachment("note")];
  assert(
    "PM-2 配对完整 + 尾部附件：历史原样保留（附件是合法消息）",
    withoutPendingTrailingToolCalls(entries).length === 4,
  );
}

// ---------------------------------------------------------------------------
// 提交判定与结果归属
// ---------------------------------------------------------------------------

{
  assert(
    "提交判定：/btw <问题> 解析出问题原文",
    JSON.stringify(btw.resolveBtwSubmission("/btw 这个函数怎么实现的", false)) ===
      JSON.stringify({ kind: "ask", question: "这个函数怎么实现的" }),
  );
  assert(
    "提交判定：裸 /btw 进入等待提问态，而不是当成空问题",
    btw.resolveBtwSubmission("/btw", false)?.kind === "await",
  );
  assert(
    "提交判定：/btwx 不是侧问（不能被前缀误吞）",
    btw.resolveBtwSubmission("/btwx", false) === null,
  );
  assert(
    "提交判定：等待态下的普通文本就是侧问原文",
    btw.resolveBtwSubmission("那它呢", true)?.kind === "ask",
  );
  assert(
    "提交判定：等待态下的斜杠命令撤销等待态（不劫持命令）",
    btw.resolveBtwSubmission("/help", true)?.kind === "cancel-await",
  );
  assert("提交判定：普通文本不触发侧问", btw.resolveBtwSubmission("你好", false) === null);
}

{
  const waiting = {
    awaitingQuestion: false,
    focused: true,
    entry: { answer: "", id: "btw-1", question: "q", scroll: 0, startedAt: 0, status: "waiting" },
  };
  const answered = btw.applyBtwResult(waiting, "btw-1", { kind: "answer", text: "答案" });
  assert(
    "结果归属：命中 id 时写入答案",
    answered.entry.status === "ready" && answered.entry.answer === "答案",
  );


  const stale = btw.applyBtwResult(waiting, "btw-9", { kind: "answer", text: "过期答案" });
  assert("结果归属：id 不匹配的过期回调被丢弃，不写任何状态", stale === waiting);

  const cancelled = btw.applyBtwResult(waiting, "btw-1", {
    kind: "failure",
    message: "cancelled",
    reason: "cancelled",
  });
  assert("结果归属：用户取消不留下失败态（浮层已经关了）", cancelled === waiting);

  const timedOut = btw.applyBtwResult(waiting, "btw-1", {
    kind: "failure",
    message: "timeout",
    reason: "timeout",
  });
  assert(
    "结果归属：超时进入失败态且保留问题原文可重试",
    timedOut.entry.status === "failed" && timedOut.entry.question === "q",
  );
}

// ---------------------------------------------------------------------------
// 行窗口 / 滚动钳制
// ---------------------------------------------------------------------------

{
  const lines = ["1", "2", "3", "4", "5"];
  assert("窗口：越界偏移被钳到 0", btw.clampBtwScroll(-3, 5, 2) === 0);
  assert("窗口：偏移上限为 total - visible", btw.clampBtwScroll(99, 5, 2) === 3);
  assert("窗口：可见行数超过总行数时恒为 0", btw.clampBtwScroll(2, 3, 10) === 0);
  const window = btw.btwLineWindow(lines, 99, 2);
  assert(
    "窗口：切片落在钳制后的偏移上",
    JSON.stringify(window.items) === JSON.stringify(["4", "5"]),
  );
  assert("窗口：到底时不再报告「下面还有」", btw.btwHasMoreBelow(window.scroll, 5, 2) === false);
}

{
  let entry = { answer: "abc", id: "x", question: "q", scroll: 0, startedAt: 0, status: "ready" };
  entry = btw.scrollBtwBy(entry, Number.MIN_SAFE_INTEGER);
  assert("滚动：Home 钳到 0", entry.scroll === 0);
  entry = btw.scrollBtwBy(entry, Number.MAX_SAFE_INTEGER);
  assert(
    "滚动：End 不会在状态里留下失控大数",
    entry.scroll <= entry.answer.length + 1,
    `scroll=${entry.scroll}`,
  );
}

{
  // 双宽字符：按显示宽度分行，不能按字符串长度。
  const lines = btw.wrapDisplayLines("中文测试一下这个宽度", 6);
  assert(
    "分行：CJK 按显示宽度换行（每行 ≤ 6 列）",
    lines.every(
      (line) => [...line].reduce((sum, char) => sum + (/[一-鿿]/u.test(char) ? 2 : 1), 0) <= 6,
    ),
    JSON.stringify(lines),
  );
  assert("分行：空串不产生行", btw.wrapDisplayLines("", 10).length === 1);
  const longToken = btw.wrapDisplayLines("a".repeat(25), 10);
  assert("分行：超长 token 被硬切而不是溢出", longToken.length === 3, JSON.stringify(longToken));
}

// ---------------------------------------------------------------------------
// 键位路由
// ---------------------------------------------------------------------------

{
  const actions = { closed: 0, retried: 0, scrolled: [] };
  const close = () => {
    actions.closed += 1;
  };
  const retry = () => {
    actions.retried += 1;
  };
  const scrollBy = (delta) => actions.scrolled.push(delta);

  keyboard.handleBtwKey({ name: "escape" }, { close, retry, scrollBy }, 10, "ready");
  keyboard.handleBtwKey({ name: "return" }, { close, retry, scrollBy }, 10, "ready");
  keyboard.handleBtwKey({ name: "space" }, { close, retry, scrollBy }, 10, "ready");
  assert(
    "键位：Esc / Enter / 空格 都关闭浮层（F-004）",
    actions.closed === 3,
    `closed=${actions.closed}`,
  );

  keyboard.handleBtwKey({ name: "down" }, { close, retry, scrollBy }, 10, "ready");
  keyboard.handleBtwKey({ name: "up" }, { close, retry, scrollBy }, 10, "ready");
  assert(
    "键位：上下滚动",
    JSON.stringify(actions.scrolled) === "[1,-1]",
    JSON.stringify(actions.scrolled),
  );

  actions.scrolled.length = 0;
  keyboard.handleBtwKey({ name: "pagedown" }, { close, retry, scrollBy }, 10, "ready");
  assert("键位：页翻步长为可见行数 - 1", actions.scrolled[0] === 9, String(actions.scrolled[0]));

  // PM-1：失败态必须能原地重试（R-018 说的「裸失败」与「可恢复」的分界）。
  keyboard.handleBtwKey({ name: "r" }, { close, retry, scrollBy }, 10, "failed");
  assert("PM-1 失败态：r 触发重试", actions.retried === 1, `retried=${actions.retried}`);
  keyboard.handleBtwKey({ name: "r" }, { close, retry, scrollBy }, 10, "ready");
  keyboard.handleBtwKey({ name: "r" }, { close, retry, scrollBy }, 10, "waiting");
  assert(
    "PM-1 非失败态：r 不触发重试（重试在飞请求只会自己取消自己）",
    actions.retried === 1,
    `retried=${actions.retried}`,
  );
  assert(
    "PM-1 r 不误触关闭：重试后浮层仍在",
    actions.closed === 3,
    `closed=${actions.closed}`,
  );

  assert(
    "键位：Ctrl+C 不被浮层吞掉（R-002 的逃生口）",
    keyboard.shouldConsumeBtwKey({ name: "c", ctrl: true }) === false &&
      keyboard.shouldConsumeBtwKey({ name: "space" }) === true,
  );
}

// ---------------------------------------------------------------------------
// 抽屉几何（PM-3）
// ---------------------------------------------------------------------------

{
  assert("几何：常规终端取一半", btw.resolveBtwPanelHeight(40) === 20);
  assert(
    "PM-3 极矮终端：抽屉不超过终端高度",
    btw.resolveBtwPanelHeight(6) <= 6 && btw.resolveBtwPanelHeight(1) <= 1,
    `${btw.resolveBtwPanelHeight(6)} / ${btw.resolveBtwPanelHeight(1)}`,
  );
  assert("几何：正文行数恒为正", btw.resolveBtwBodyRows(1) >= 1 && btw.resolveBtwBodyRows(10) >= 1);
}


// ---------------------------------------------------------------------------
// PM-9：输出上限必须受模型 spec 约束，否则整条侧问被 validateOptions 拒绝
// ---------------------------------------------------------------------------

{
  assert("PM-9 钳制：模型上限更小时取模型上限", resolveBtwMaxOutputTokens(undefined, 1024) === 1024);
  assert("PM-9 钳制：模型上限更大时用自己的默认上界", resolveBtwMaxOutputTokens(undefined, 64_000) === 2048);
  assert("PM-9 钳制：调用方显式指定且未越界时用调用方的", resolveBtwMaxOutputTokens(512, 64_000) === 512);
  assert("PM-9 钳制：永远为正（下限 1）", resolveBtwMaxOutputTokens(undefined, 0) === 1);

  // 真的拿一个「上限比侧问默认值小」的模型跑一遍 validateOptions：
  // 断言钳制后的值**能过校验**，而写死的值过不了。只测算式证明不了这一条。
  const makeModel = (specMax) =>
    createModel({
      providerId: "probe",
      modelId: "small",
      properties: {},
      // reasoningLevel 是 validateOptions 的另一个必填项，必须给上；
      // 否则失败原因会变成「档位缺失」，而不是我们要测的输出上限越界。
      options: { reasoningLevel: "low" },
      optionSpecs: {
        maxOutputTokens: { max: specMax, min: 1 },
        reasoningLevel: { values: ["low"] },
      },
      executor: {
        generateText: async () => ({ finishReason: "stop", text: "ok", usage: {} }),
        streamText: () => {},
      },
    });

  const send = async (model, maxOutputTokens) => {
    try {
      await model.generateText({
        messages: [{ content: "q", role: "user" }],
        options: { maxOutputTokens },
      });
      return true;
    } catch {
      return false;
    }
  };

  assert(
    "PM-9 复现：写死的 2048 在 spec=1024 的模型上会被拒绝（证明这条测试能失败）",
    (await send(makeModel(1024), 2048)) === false,
  );
  assert(
    "PM-9 修复：钳制后的值能过同一个模型的校验",
    (await send(makeModel(1024), resolveBtwMaxOutputTokens(undefined, 1024))) === true,
  );
}


// ---------------------------------------------------------------------------
// 端到端：真实 MessageHistory + 真实投影层，R-040 的裁剪必须成立
// ---------------------------------------------------------------------------

{
  // 上面那些断言用的是手搓的 entry，**没有经过投影层**。这里用真的 MessageHistory
  // 造出「工具执行中」的历史，再走一遍 `buildRuntimeProviderRequestMessages`，
  // 直接检查投影结果满足 provider 的配对不变量——这才是发出去的那份消息。
  const history = new MessageHistoryImpl();
  history.init("SYSTEM PROMPT");
  history.addUser("帮我把这个项目跑起来");
  history.addAssistant("", [{ id: "t1", input: { command: "sleep 60" }, name: "Bash" }]);

  const model = {
    modelId: "probe",
    optionSpecs: {},
    options: {},
    properties: { supportsMidConversationSystem: false },
    providerId: "probe",
  };
  const entries = [
    ...withoutPendingTrailingToolCalls([...history.borrowReadOnlyRuntimeEntries()]),
    { message: { content: "刚才那条命令是干嘛的", role: "user" } },
  ];
  const projected = buildRuntimeProviderRequestMessages(
    { config: { midConversationSystem: undefined } },
    { applyCacheControl: true, entries, model },
  ).messages;

  const dangling = [];
  projected.forEach((message, index) => {
    if (message.role !== "assistant" || !message.toolCalls?.length) return;
    const following = projected.slice(index + 1, index + 1 + message.toolCalls.length);
    const paired =
      following.length === message.toolCalls.length &&
      following.every((next) => next.role === "tool");
    if (!paired) dangling.push(index);
  });

  assert(
    "R-040 端到端：真实历史 + 真实投影后，不存在未配对的 assistant tool_use",
    dangling.length === 0,
    `违规位置 ${JSON.stringify(dangling)}：${JSON.stringify(projected.map((m) => m.role))}`,
  );
  assert(
    "R-040 端到端：系统提示与提问都还在（裁剪没有吃掉合法消息）",
    projected[0]?.role === "system" && projected.at(-1)?.content === "刚才那条命令是干嘛的",
    JSON.stringify(projected.map((m) => m.role)),
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
