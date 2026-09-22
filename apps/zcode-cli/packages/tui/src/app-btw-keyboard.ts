import type { KeyEvent } from "@mbears/opentui-core";
import { clampBtwScroll } from "./app-btw.js";

/**
 * 侧问浮层的键位路由。
 *
 * 优先级：`readOnlyView > approval > selection > btw > 其余`（与痛点拆解 §4.3「审批面板优先」
 * 一致，见 `app-keyboard.ts` 里的分支顺序）。
 *
 * 两条不能省的约束：
 * 1. **`Ctrl+C` 必须不被吞**。浮层若吞掉全部按键，而侧问又卡住，用户既关不掉浮层也停不掉
 *    主任务——逃生口会被自己的键位设计堵死。所以消费判定显式放行 Ctrl+C。
 * 2. **`Esc` 只关浮层，不冒泡**。主任务运行中 `Esc` 的默认语义是中断，冒泡出去会让用户
 *    以为自己停了主任务。关闭时由调用方在状态栏显式提示「主任务仍在运行」。
 */
export function handleBtwKey(
  key: KeyEvent,
  actions: { close: () => void; scrollBy: (delta: number) => void },
  visibleLines: number,
): void {
  // `Esc` / `Enter` / `Space` 都是关闭键（F-004：三者关闭浮层并交还焦点），
  // 所以键名分别是 `"escape"` / `"return"` / `"space"` —— 注意 Enter 不是 `"enter"`。
  if (key.name === "escape" || key.name === "return" || key.name === "space") {
    actions.close();
    return;
  }
  if (key.name === "up" || key.name === "down") {
    actions.scrollBy(key.name === "up" ? -1 : 1);
    return;
  }
  if (key.name === "pageup" || key.name === "pagedown") {
    const step = Math.max(1, visibleLines - 1);
    actions.scrollBy(key.name === "pageup" ? -step : step);
    return;
  }
  if (key.name === "home" || key.name === "end") {
    // `end` 用一个大到必然被钳制的偏移表达「到底」，避免在键位层重复一遍窗口数学。
    actions.scrollBy(key.name === "home" ? Number.MIN_SAFE_INTEGER : Number.MAX_SAFE_INTEGER);
  }
}

/** 浮层该吞的按键；`Ctrl+C` 例外，留给既有的「停止主任务」链路。 */
export function shouldConsumeBtwKey(key: KeyEvent): boolean {
  return !(key.name === "c" && key.ctrl);
}

export function nextBtwScroll(
  scroll: number,
  totalLines: number,
  visibleLines: number,
  delta: number,
): number {
  return clampBtwScroll(scroll + delta, totalLines, visibleLines);
}
