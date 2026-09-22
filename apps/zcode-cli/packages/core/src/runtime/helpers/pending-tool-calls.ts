import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";

/**
 * 丢弃尾部「尚未兑现」的 assistant tool_use，让快照成为 provider 可接受的合法消息序列。
 *
 * provider 协议要求每条 assistant 的 `tool_use` 之后紧跟对应的 `tool_result`。主任务在
 * **工具执行期间**（`turn-tools.ts` 里 `await executeTools(...)` 那段窗口，含权限等待，
 * 可达数分钟）canonical history 的尾部恰好是「带 `toolCalls` 的 assistant」加上「已返回的
 * 部分 tool result」——此时把快照原样发给 provider 会被直接拒绝（400 / InvalidModelRequest）。
 * 这个窗口是「主任务看起来在跑」的**大多数时刻**，任何带外调用（goal 完成验证、/btw 侧问）
 * 都必须先裁剪。
 *
 * 只在**尾部**裁剪：历史中段的 assistant 必然已有配对结果，不可能悬空。
 *
 * 只看最后一条是不够的。`turn-tools.ts` 是**逐条**追加结果的循环，在其中途取快照时尾部是
 * 某条 tool result，但 assistant 的 `tool_use` 数与已追加的结果数**不匹配**，同样会被拒绝。
 * 因此这里按 `toolCallId` 配对，而不是无条件 `slice` 掉最后一条。
 *
 * 本函数由 goal 完成验证与 /btw 侧问**共用**。不要在任一侧复制一份——复制会与另一侧分叉，
 * 而分叉的代价是一侧修好了、另一侧仍会 400。
 */
export function withoutPendingTrailingToolCalls(
  entries: readonly RuntimeMessageEntry[],
): readonly RuntimeMessageEntry[] {
  let boundary = entries.length;
  const satisfiedToolCallIds = new Set<string>();

  // 从尾部回收「已经兑现」的 tool result，它们定义了尾部区间的起点。
  while (boundary > 0) {
    const entry = entries[boundary - 1]!;
    if (isRuntimeAttachmentEntry(entry)) break;
    if (entry.message.role !== "tool" || !entry.message.toolCallId) break;
    satisfiedToolCallIds.add(entry.message.toolCallId);
    boundary -= 1;
  }

  const assistant = boundary > 0 ? entries[boundary - 1] : undefined;
  if (
    !assistant ||
    isRuntimeAttachmentEntry(assistant) ||
    assistant.message.role !== "assistant" ||
    !assistant.message.toolCalls ||
    assistant.message.toolCalls.length === 0
  ) {
    return entries;
  }

  const hasPendingToolCall = assistant.message.toolCalls.some(
    (toolCall) => !satisfiedToolCallIds.has(toolCall.id),
  );
  // 只要有一条 tool_use 未兑现，这条 assistant 就不能出现在请求里；它已有的部分结果也必须
  // 一并丢弃——孤立的 tool_result 同样是非法序列。
  return hasPendingToolCall ? entries.slice(0, boundary - 1) : entries;
}
