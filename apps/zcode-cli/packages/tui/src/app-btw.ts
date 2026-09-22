import { displayWidth } from "./app-terminal-width.js";
import type { TuiSideQuestionFailureReason, TuiSideQuestionResult } from "./types.js";

/**
 * 运行中侧问（`/btw`）的界面状态。
 *
 * **只存内存，不落盘**：这里的状态在会话重载后必须无残留（与 core 侧「零持久化」同一条约束）。
 */
export type BtwStatus = "failed" | "ready" | "refused" | "waiting";

export interface BtwEntry {
  /** 一次侧问请求的标识；过期回调靠它丢弃，不得写进已关闭/已替换的浮层。 */
  id: string;
  question: string;
  /** 进行中态显示已等待时长的起点。 */
  startedAt: number;
  status: BtwStatus;
  answer: string;
  failureReason?: TuiSideQuestionFailureReason;
  /**
   * 行窗口偏移（**不是 `scrollTop`**）——仓库里没有任何地方读写 `scrollTop`，
   * 三个既有窗口助手都是「钳制索引」口径，这里对齐同一形态。
   */
  scroll: number;
}

export interface BtwState {
  entry?: BtwEntry;
  /**
   * 浮层**是否持有键盘焦点**。`awaitingQuestion` 期间焦点仍在输入框，
   * 所以两者不能合并成一个字段。
   */
  focused: boolean;
  /** 无参数 `/btw` 之后进入的「等待用户输入侧问内容」态。 */
  awaitingQuestion: boolean;
}

export const INITIAL_BTW_STATE: BtwState = { awaitingQuestion: false, focused: false };

export type BtwSubmission =
  | { kind: "ask"; question: string }
  | { kind: "await" }
  | { kind: "cancel-await" };

/**
 * 判定一次输入该不该走侧问通道。**纯函数**（R-022：本仓库没有测试框架，键位与状态机这类
 * 纯逻辑只能靠「导出纯函数」留出将来的回归保护）。
 *
 * `awaitingQuestion` 期间任何非斜杠输入都算侧问原文；斜杠输入按用户改主意处理，
 * 撤销等待态并交回普通路径，不劫持命令。
 */
export function resolveBtwSubmission(text: string, awaitingQuestion: boolean): BtwSubmission | null {
  const trimmed = text.trim();
  if (awaitingQuestion) {
    if (trimmed.startsWith("/")) return { kind: "cancel-await" };
    return trimmed.length > 0 ? { kind: "ask", question: trimmed } : null;
  }
  const match = /^\/btw(?:\s+([\s\S]*))?$/u.exec(trimmed);
  if (!match) return null;
  const question = (match[1] ?? "").trim();
  return question.length > 0 ? { kind: "ask", question } : { kind: "await" };
}

/** 把任意数值钳到 `[0, total - visible]`；`visible >= total` 时恒为 0。 */
export function clampBtwScroll(scroll: number, totalLines: number, visibleLines: number): number {
  const maxScroll = Math.max(0, totalLines - Math.max(1, visibleLines));
  if (!Number.isFinite(scroll)) return 0;
  return Math.min(Math.max(0, Math.floor(scroll)), maxScroll);
}

export function btwHasMoreBelow(
  scroll: number,
  totalLines: number,
  visibleLines: number,
): boolean {
  return clampBtwScroll(scroll, totalLines, visibleLines) + visibleLines < totalLines;
}

export function elapsedSeconds(startedAt: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - startedAt) / 1000));
}

/**
 * 按**显示宽度**换行（CJK 是双宽字符，不能用 `length` 近似）。
 *
 * 侧问答案会在浮层里滚动，所以窗口必须以显示行为单位——整段按 `\n` 切会把一个长段落
 * 当成一行，方向键一次跳一整段。
 */
export function wrapDisplayLines(value: string, maxCells: number): string[] {
  const width = Math.max(1, Math.floor(maxCells));
  const lines: string[] = [];
  for (const paragraph of value.split(/\r?\n/u)) {
    const words = paragraph.split(/\s+/u).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    lines.push(...wrapParagraph(words, width));
  }
  return lines;
}

function wrapParagraph(words: readonly string[], width: number): string[] {
  const lines: string[] = [];
  let current = "";

  const flush = (): void => {
    if (current.length > 0) lines.push(current);
    current = "";
  };

  for (const word of words) {
    let rest = word;
    while (rest.length > 0) {
      const separator = current.length > 0 ? 1 : 0;
      const room = width - displayWidth(current) - separator;
      if (room < 1) {
        flush();
        continue;
      }
      const [head, tail] = takeDisplayWidth(rest, room);
      if (head.length === 0) {
        flush();
        continue;
      }
      current = current.length > 0 ? `${current} ${head}` : head;
      rest = tail;
      // 这一段塞满了就换行；剩下的继续在同一循环里从空行起排。
      if (rest.length > 0) flush();
    }
  }

  flush();
  return lines.length > 0 ? lines : [""];
}

function takeDisplayWidth(text: string, maxCells: number): [string, string] {
  let cells = 0;
  let index = 0;
  for (const char of text) {
    const next = cells + displayWidth(char);
    if (next > maxCells && cells > 0) break;
    cells = next;
    index += char.length;
    if (cells >= maxCells) break;
  }
  return [text.slice(0, index), text.slice(index)];
}

/**
 * 把一次侧问结果落到状态上。**纯函数**，并且**按 id 认领**：结果回来的那一刻浮层可能已经
 * 被关闭、或被另一次侧问替换，此时直接丢弃，不写任何状态（R-038）。
 */
export function applyBtwResult(
  state: BtwState,
  id: string,
  result: TuiSideQuestionResult,
): BtwState {
  if (state.entry?.id !== id) return state;
  if (result.kind === "failure") {
    // 取消是「用户自己关掉了浮层」导致的，不该把失败态留在屏幕上。
    if (result.reason === "cancelled") return state;
    return {
      ...state,
      entry: { ...state.entry, answer: "", failureReason: result.reason, status: "failed" },
    };
  }
  return {
    ...state,
    entry: { ...state.entry, answer: result.text, status: result.refused ? "refused" : "ready" },
  };
}

/**
 * 滚动偏移的**唯一写入口**。
 *
 * 上界用「显示行数 ≤ 答案字符数 + 1」这个恒成立的粗界，真实窗口在渲染时再由
 * `btwLineWindow` 钳制——所以状态里不会积累出一个失控的大数（`End` 键推的是
 * `Number.MAX_SAFE_INTEGER`），`app.tsx` 也不必知道浮层的真实几何。
 */
export function scrollBtwBy(entry: BtwEntry, delta: number): BtwEntry {
  const upperBound = entry.answer.length + 1;
  const next = Math.min(Math.max(0, entry.scroll + delta), upperBound);
  return next === entry.scroll ? entry : { ...entry, scroll: next };
}

/** 浮层可滚动的显示行窗口；返回的 `scroll` 已钳制，调用方应据此回写状态。 */
export function btwLineWindow(
  lines: readonly string[],
  scroll: number,
  visibleLines: number,
): { items: string[]; scroll: number } {
  const clamped = clampBtwScroll(scroll, lines.length, visibleLines);
  return { items: lines.slice(clamped, clamped + Math.max(1, visibleLines)), scroll: clamped };
}
