import type { TuiCopy } from "@zcode/i18n";
import { useTerminalDimensions } from "@mbears/opentui-react";
import React, { useEffect, useState } from "react";
import {
  btwHasMoreBelow,
  btwLineWindow,
  elapsedSeconds,
  resolveBtwBodyRows,
  resolveBtwPanelHeight,
  wrapDisplayLines,
  type BtwEntry,
} from "./app-btw.js";
import { DEFAULT_TUI_COPY } from "./app-locale.js";
import { MarkdownText } from "./app-markdown.js";
import { palette } from "./app-model.js";
import type { TuiSideQuestionFailureReason } from "./types.js";

const h = React.createElement as (
  type: React.ElementType | string,
  props?: Record<string, unknown> | null,
  ...children: React.ReactNode[]
) => React.ReactElement;

const WAITING_TICK_MS = 1_000;

/**
 * 运行中侧问的抽屉。
 *
 * 形态：**贴底的半高面板**，不遮上半屏——主任务的流式输出继续可见，这正是 F-003
 * 「不打断」的体感来源；居中的模态浮层会把转录盖住，反而让人以为主任务停了。
 * 因为不是模态，背景用**不透明**的 `palette.background`，而不是半透明遮罩。
 *
 * 滚动用**行窗口 + 钳制偏移**，不是 `scrollTop`——仓库里没有任何地方读写 `scrollTop`，
 * 既有窗口助手都是「钳制索引」口径，这里与它们保持一致。窗口按**显示宽度**分行，
 * 这样 CJK 与 emoji 不会被按 `length` 误判成单宽。
 */
export function BtwPanel({
  contentWidth,
  copy = DEFAULT_TUI_COPY,
  entry,
}: {
  contentWidth?: number;
  copy?: TuiCopy;
  entry: BtwEntry;
}): React.ReactElement {
  const { height: terminalHeight } = useTerminalDimensions();
  const bodyRows = resolveBtwBodyRows(terminalHeight);
  // 抽屉铺满整宽；正文可用宽度要扣掉边框 2 + 左右 padding 2。
  const bodyWidth = Math.max(8, normalizeContentWidth(contentWidth) - 4);
  const body = entry.answer.trim();
  const lines = body.length > 0 ? wrapDisplayLines(body, bodyWidth) : [];
  const window = btwLineWindow(lines, entry.scroll, bodyRows);

  return h(
    "box",
    {
      style: {
        backgroundColor: palette.background,
        border: true,
        borderColor: statusColor(entry),
        bottom: 0,
        flexDirection: "column",
        height: resolveBtwPanelHeight(terminalHeight),
        left: 0,
        padding: 1,
        position: "absolute",
        right: 0,
        zIndex: 10,
      },
    },
    h("text", { key: "title", style: { fg: palette.accent } }, copy.btw.title),
    h(
      "text",
      { key: "question", style: { fg: palette.muted } },
      copy.btw.question(entry.question),
    ),
    // 正文有固定行数并裁剪，状态行才能稳定钉在抽屉底部（而不是被长答案顶走）。
    h(
      "box",
      {
        key: "body",
        style: { flexDirection: "column", height: bodyRows, overflow: "hidden", width: "100%" },
      },
      ...bodyContent({ body, bodyRows, copy, entry, lines, window }),
    ),
    // 状态行整体交给一个组件渲染，**不要**写成 `h("text", ..., <stateful/>)`：
    // 进行中态自己就是一条会重渲染的 `<text>`，嵌进外层 `<text>` 是 text-in-text 嵌套。
    h(BtwStatusLine, {
      bodyRows,
      copy,
      entry,
      key: "status",
      lines,
      scroll: window.scroll,
    }),
  );
}

function bodyContent(input: {
  body: string;
  bodyRows: number;
  copy: TuiCopy;
  entry: BtwEntry;
  lines: readonly string[];
  window: { items: string[]; scroll: number };
}): React.ReactNode[] {
  const { body, bodyRows, copy, entry, lines, window } = input;

  if (entry.status === "failed") {
    return [
      h(
        "text",
        { key: "failure", style: { fg: palette.danger, wrapMode: "word" } },
        btwFailureText(copy, entry.failureReason),
      ),
    ];
  }

  if (entry.status === "waiting") {
    // 非流式下答案整段返回，这里留白；进度由状态行给（见 BtwWaitingStatus）。
    return [];
  }

  if (body.length === 0) return [];

  // 短答案整段交给 markdown 渲染（保留格式）；长答案必须按行窗口切片，
  // 此时逐行渲染——把切片再喂给 markdown 会让跨窗口的代码围栏断在半截。
  if (lines.length <= bodyRows) {
    return [h(MarkdownText, { content: body, key: "answer" })];
  }
  return [
    h("text", { key: "answer-window", style: { fg: palette.text } }, window.items.join("\n")),
  ];
}

function BtwStatusLine({
  bodyRows,
  copy,
  entry,
  lines,
  scroll,
}: {
  bodyRows: number;
  copy: TuiCopy;
  entry: BtwEntry;
  lines: readonly string[];
  scroll: number;
}): React.ReactElement {
  if (entry.status === "waiting") {
    // 进行中态**只在这里挂载计时器**：非流式下浮层内容不会变化，没有这个时钟
    // 长等待会被当成卡死，进而触发不该发生的逃生动作（Ctrl+C / Esc）。
    return h(BtwWaitingStatus, { copy, startedAt: entry.startedAt });
  }
  // 失败态把重试键摆出来。键位存在但没人告诉用户，等于不存在。
  const help = entry.status === "failed" ? `${copy.btw.retryHint}  ${copy.btw.help}` : copy.btw.help;
  const suffix = btwHasMoreBelow(scroll, lines.length, bodyRows)
    ? `  ↓${lines.length - scroll - bodyRows}`
    : "";
  return h("text", { style: { fg: statusColor(entry) } }, `${help}${suffix}`);
}

function BtwWaitingStatus({
  copy,
  startedAt,
}: {
  copy: TuiCopy;
  startedAt: number;
}): React.ReactElement {
  const nowMs = useBtwTick();
  return h(
    "text",
    { style: { fg: palette.muted } },
    `${copy.btw.waiting(elapsedSeconds(startedAt, nowMs))}  ${copy.btw.help}`,
  );
}

/**
 * 每秒一帧的时钟。只在**确实需要**它的组件里挂载（`BtwWaitingStatus`），
 * 所以用 `useMountEffect` 的「挂载即起、卸载即停」形态，不需要依赖数组兜底。
 */
function useBtwTick(): number {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useMountEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), WAITING_TICK_MS);
    return () => clearInterval(timer);
  });
  return nowMs;
}

function useMountEffect(effect: () => void | (() => void)): void {
  // eslint-disable-next-line no-restricted-syntax -- 一次性外部同步（定时器），见 no-useeffect 规范。
  useEffect(effect, []);
}

/**
 * 失败原因（snake_case，来自 runtime）到文案键（camelCase）的**唯一映射点**。
 * 契约层的值是 `context_exceeded`，文案层的键是 `contextExceeded`，两边都不该为对方改名。
 */
function btwFailureText(copy: TuiCopy, reason: TuiSideQuestionFailureReason | undefined): string {
  switch (reason) {
    case "cancelled":
      return copy.btw.failure.cancelled;
    case "context_exceeded":
      return copy.btw.failure.contextExceeded;
    case "timeout":
      return copy.btw.failure.timeout;
    case "unavailable":
      return copy.btw.failure.unavailable;
    default:
      return copy.btw.failure.provider;
  }
}

function statusColor(entry: BtwEntry): string {
  return entry.status === "failed" ? palette.danger : palette.accent;
}

function normalizeContentWidth(contentWidth: number | undefined): number {
  if (contentWidth === undefined || !Number.isFinite(contentWidth)) return 80;
  return Math.max(24, Math.floor(contentWidth));
}
