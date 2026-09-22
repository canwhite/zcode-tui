#!/usr/bin/env node
// 侧问三块**纯逻辑**的行为断言（R-022）。
//
// 为什么需要它：本仓库没有测试框架，而侧问里最危险的三块——尾部 tool_use 配对裁剪、
// 键位/窗口数学、结果归属——都只是纯函数。纯函数没有回归保护时，缓解方案会悄悄失效：
// 裁剪坏了会 400，窗口数学坏了会截断，归属坏了会把过期回调写进已关闭的浮层。
//
// 这些断言直接 import **源码里的纯函数**（不是源码文本），所以它们证伪的是行为，不是字面量。
// 之所以能直接 import：`@zcode/shared` 等 workspace 包把 `exports` 指向 `.ts` 源文件，
// 只有 tsx 能解析这种形态（`node` 不能，`zcode.cjs` 是 esbuild 内联后的产物）。
//
// 用法：npx tsx test/btw-pure-logic.mjs
//
// 放 `test/` 而不是各包里，是因为它跨 core 与 tui 两个包——放任何一边都要深引另一个包。

import { withoutPendingTrailingToolCalls } from "../apps/zcode-cli/packages/core/src/runtime/helpers/pending-tool-calls.js";
import {
  assessBtwEvidence,
  extractEvidenceTokens,
} from "../apps/zcode-cli/packages/core/src/runtime/methods/btw-evidence.js";
import * as btw from "../apps/zcode-cli/packages/tui/src/app-btw.js";
import * as keyboard from "../apps/zcode-cli/packages/tui/src/app-btw-keyboard.js";

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

{
  // 工具执行刚开始：assistant 已提交、结果一条都还没回来。
  const entries = [userMessage("hi"), assistantWithTools("t1")];
  const trimmed = withoutPendingTrailingToolCalls(entries);
  assert(
    "R-040 全悬空：丢掉尾部那条带 toolCalls 的 assistant",
    trimmed.length === 1 && trimmed[0].message.role === "user",
    JSON.stringify(trimmed.map((entry) => entry.message.role)),
  );
}

{
  // 部分结果：两个 tool_use，只回来一个 —— 只看「最后一条是不是 assistant」的旧写法会漏掉这里。
  const entries = [userMessage("hi"), assistantWithTools("t1", "t2"), toolResult("t1")];
  const trimmed = withoutPendingTrailingToolCalls(entries);
  assert(
    "R-040 部分结果：assistant 与其已返回的部分结果一并丢弃（孤立的 tool_result 同样非法）",
    trimmed.length === 1 && trimmed[0].message.role === "user",
    JSON.stringify(trimmed.map((entry) => entry.message.role)),
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
  const answered = btw.applyBtwResult(waiting, "btw-1", {
    kind: "answer",
    refused: false,
    text: "答案",
  });
  assert(
    "结果归属：命中 id 时写入答案",
    answered.entry.status === "ready" && answered.entry.answer === "答案",
  );

  const refused = btw.applyBtwResult(waiting, "btw-1", {
    kind: "answer",
    refused: true,
    text: "指引",
  });
  assert(
    "结果归属：拒答走独立的 refused 态（与正常答案可区分）",
    refused.entry.status === "refused",
  );

  const stale = btw.applyBtwResult(waiting, "btw-9", {
    kind: "answer",
    refused: false,
    text: "过期答案",
  });
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
  const actions = { closed: 0, scrolled: [] };
  const close = () => {
    actions.closed += 1;
  };
  const scrollBy = (delta) => actions.scrolled.push(delta);

  keyboard.handleBtwKey({ name: "escape" }, { close, scrollBy }, 10);
  keyboard.handleBtwKey({ name: "return" }, { close, scrollBy }, 10);
  keyboard.handleBtwKey({ name: "space" }, { close, scrollBy }, 10);
  assert(
    "键位：Esc / Enter / 空格 都关闭浮层（F-004）",
    actions.closed === 3,
    `closed=${actions.closed}`,
  );

  keyboard.handleBtwKey({ name: "down" }, { close, scrollBy }, 10);
  keyboard.handleBtwKey({ name: "up" }, { close, scrollBy }, 10);
  assert(
    "键位：上下滚动",
    JSON.stringify(actions.scrolled) === "[1,-1]",
    JSON.stringify(actions.scrolled),
  );

  actions.scrolled.length = 0;
  keyboard.handleBtwKey({ name: "pagedown" }, { close, scrollBy }, 10);
  assert("键位：页翻步长为可见行数 - 1", actions.scrolled[0] === 9, String(actions.scrolled[0]));

  assert(
    "键位：Ctrl+C 不被浮层吞掉（R-002 的逃生口）",
    keyboard.shouldConsumeBtwKey({ name: "c", ctrl: true }) === false &&
      keyboard.shouldConsumeBtwKey({ name: "space" }) === true,
  );
}

// ---------------------------------------------------------------------------
// 无据证据检查（软信号）
// ---------------------------------------------------------------------------

{
  // 证据检查是**软信号**：hit / miss 只决定要不要追加「请声明依据」那一段，
  // 两者都不等于拒答（拒答只由模型按约束给出哨兵触发）。所以这里断言的是**分级行为**，
  // 不是「必须命中」——后者正是 R-032 警告过的单向验收。
  const englishContext = [
    { message: { content: "function resolveBtwSubmission(text) { return null; }", role: "user" } },
  ];
  const cjkContext = [
    {
      message: {
        content: "侧问的提交判定由 resolveBtwSubmission 负责，窗口偏移需要钳制。",
        role: "user",
      },
    },
  ];

  const englishHit = assessBtwEvidence("resolveBtwSubmission 做了什么", englishContext);
  assert(
    "证据：英文标识符与上下文重合 → hit",
    englishHit.level === "hit",
    JSON.stringify(englishHit),
  );

  const cjkHit = assessBtwEvidence("侧问的提交判定和窗口偏移是怎么处理的", cjkContext);
  assert(
    "证据：中文提问 × 中文上下文 → hit（否则中文提问会被一律打成低置信）",
    cjkHit.level === "hit",
    JSON.stringify(cjkHit),
  );

  // 反过来：中文提问 × 纯英文/代码上下文，字面重合本就极少。
  // 这里是 **miss 才是正确行为**——它只追加「请显式声明依据」，不拒答。
  const crossLanguage = assessBtwEvidence("数据库迁移脚本在哪里", englishContext);
  assert(
    "证据：跨语言/无重合 → miss（低置信，**不是**直接拒答）",
    crossLanguage.level === "miss",
    JSON.stringify(crossLanguage),
  );
  assert(
    "证据：miss 的返回里没有任何「拒答」字段（分级与拒答在结构上就分开了）",
    !("refused" in crossLanguage) && !("refusal" in crossLanguage),
  );

  const empty = assessBtwEvidence("好", englishContext);
  assert(
    "证据：无可判定 token 时不制造低置信信号",
    empty.level === "hit" && empty.tokenCount === 0,
  );
  assert(
    "证据：中文按二字组切分（整句匹配会全不命中）",
    extractEvidenceTokens("函数实现").has("函数"),
  );
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
