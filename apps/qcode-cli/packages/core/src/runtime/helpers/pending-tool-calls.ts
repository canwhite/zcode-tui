import { isRuntimeAttachmentEntry, type RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ModelToolCall } from "../deps.js";

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
  // 从尾部回收「已经兑现」的 tool result。**附件条目要跳过而不是中止**：它们是 system reminder
  // （shell 环境变化、目标变更、日期变更），既不参与 tool_use/tool_result 配对，也不该让整个
  // 裁剪放弃——尾巴上多一条提醒就退回原样，等于把悬空 tool_use 照样发给 provider（400）。
  let assistantIndex = -1;
  let pendingToolCalls: readonly ModelToolCall[] | undefined;
  const satisfiedToolCallIds = new Set<string>();

  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (isRuntimeAttachmentEntry(entry)) continue;
    if (entry.message.role === "tool" && entry.message.toolCallId) {
      satisfiedToolCallIds.add(entry.message.toolCallId);
      continue;
    }
    // 尾部区间遇到的第一个非附件、非工具结果条目：它要么是发起 tool_use 的 assistant，
    // 要么说明尾部根本没有悬空调用，两种情况都在这里定性。
    if (entry.message.role === "assistant" && entry.message.toolCalls?.length) {
      assistantIndex = index;
      pendingToolCalls = entry.message.toolCalls;
    }
    break;
  }

  if (assistantIndex === -1 || pendingToolCalls === undefined) return entries;
  const hasPendingToolCall = pendingToolCalls.some(
    (toolCall) => !satisfiedToolCallIds.has(toolCall.id),
  );
  // 只要有一条 tool_use 未兑现，这条 assistant 就不能出现在请求里；它已有的部分结果（以及
  // 夹在其中的附件）也必须一并丢弃——孤立的 tool_result 同样是非法序列。
  return hasPendingToolCall ? entries.slice(0, assistantIndex) : entries;
}
