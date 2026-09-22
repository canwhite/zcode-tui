import { createChildTraceContext, runWithModelInvocationContext, traceContextToLogContext } from "../deps.js";
import type { ModelUsage } from "../deps.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildRuntimeProviderRequestMessages } from "../helpers/runtime-provider-request-messages.js";
import { isModelContextExceededError } from "../helpers/index.js";
import { withoutPendingTrailingToolCalls } from "../helpers/pending-tool-calls.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { createRuntimeModel } from "./runtime-model.js";
import { assessBtwEvidence, type BtwEvidenceAssessment } from "./btw-evidence.js";

/**
 * 运行中侧问（`/btw`）的隔离模型调用。
 *
 * ## 为什么不能走主请求路径 `runModelTextRequest`
 *
 * 主请求路径最终会经 `emitModelStreamingEvent` 以**主 sessionId** 发出
 * `SessionEventType.ModelStreaming` 事件；TUI 侧按 sessionId 放行后，会在
 * `assistantMessageId` 未知时**凭空新建一条 agent 消息**。也就是说，侧问若走主请求路径，
 * 会在主转录里插入一条幽灵 assistant 消息——而「消灭主转录污染」正是侧问存在的理由。
 * 因此本模块**直接消费模型句柄，自己归约结果，绝不发任何会话事件**。
 * 后来者请勿为「减少重复代码」把这里统一回主请求路径（见 A2 源码断言）。
 *
 * ## 零持久化硬约束（四条通道，缺一不可）
 *
 * | 通道 | 落点 | 本模块的控制手段 |
 * |------|------|------------------|
 * | ① model-io | `~/.zcode/cli/{rollout,debug}` | 非流式 `generateText` + `metadata.skipTranscript` |
 * | ② 会话事件流 | `~/.zcode/cli/db/db.sqlite` → `session_events` | 不调用 `appendEvent` / `createEvent`，不提供 `statusSink` |
 * | ③ 用量表 | `~/.zcode/cli/db/db.sqlite` → `model_usage` | 不调用 `recordModelUsageFact` |
 * | ④ JSONL 文件日志 | `~/.zcode/cli/log/` | 提问原文与答案不得作为任何 `logger.*` 的字段值 |
 *
 * ① 只在**非流式**路径有退出口：`runner-generate.ts` 读 `metadata?.skipTranscript`，
 * 而 `runner-stream.ts` 没有该开关。改成流式会立刻把完整会话快照与答案落进 rollout/debug。
 *
 * ③ 是**故意**付出的代价：`/cost` 会少报侧问的花费。不要「顺手补上」记账——
 * 那会把一条持久化记录写进用户重载后仍可见的 session db。
 *
 * 正面先例是 `helpers/project-memory-agent.ts`（只构造调用上下文，不发任何会话事件）；
 * 反面示例是 `methods/workspace-generate-text.ts`——它发 `ModelRequest` / `ModelComplete`
 * 事件并调 `recordModelUsageFact`，侧问**不要**照抄它。
 */

/** 侧问在观测面的归属锚点；自动化验收（A5）靠它做归属断言，不要改。 */
export const BTW_QUERY_SOURCE = "btw";

const BTW_DEFAULT_TIMEOUT_MS = 180_000;
/** 侧问是「顺口一问」，输出必须有上界，否则单次花费与耗时无界（R-042）。 */
const BTW_DEFAULT_MAX_OUTPUT_TOKENS = 2_048;

/** 拒答哨兵：模型无据时以此开头作答，由本模块剥离并转成可判定的布尔标记。 */
const BTW_NO_CONTEXT_SENTINEL = "ZCODE_BTW_NO_CONTEXT";

/**
 * 侧问约束**追加在末尾**（拼进用户消息）而非重排消息序列：
 * `buildRuntimeProviderRequestMessages` 在 `midConversationSystem` force 模式下会产出
 * 对话中间的系统条目，另插一条 system 可能与之冲突并在部分厂商直接报错。
 */
const BTW_CONTEXT_CONSTRAINT = [
  "You are answering a side question about the conversation above.",
  "You may ONLY use information that literally appears in the conversation above (including tool results).",
  "You have NO tools and cannot read files, run commands, or search the web.",
  `If the conversation does not contain the information needed, reply with exactly \`${BTW_NO_CONTEXT_SENTINEL}\` on the first line, then one short sentence telling the user to ask it as a normal message instead.`,
  "Never guess, never fill gaps with plausible-sounding content.",
  "Keep the answer short.",
].join("\n");

const BTW_LOW_CONFIDENCE_CLAUSE = [
  "A lexical check found little overlap between the question and the conversation.",
  "This does NOT by itself mean the information is absent (the question may be paraphrased or in another language).",
  "Answer only if you can point at the specific part of the conversation that supports it, and state that basis explicitly.",
  `Otherwise use the \`${BTW_NO_CONTEXT_SENTINEL}\` reply described above.`,
].join("\n");

export type BtwFailureReason = "cancelled" | "context_exceeded" | "provider" | "timeout";

export class BtwModelRequestError extends Error {
  readonly reason: BtwFailureReason;

  constructor(reason: BtwFailureReason, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BtwModelRequestError";
    this.reason = reason;
  }
}

export interface BtwModelRequestInput {
  /** 用户原始问题；空或仅空白由调用方先行拦截。 */
  question: string;
  /**
   * **只接受侧问自己的**取消信号（用户关闭浮层）。绝不能传主任务的 turn signal，
   * 否则主任务被取消时侧问会被连带中断。
   */
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

export interface BtwModelResult {
  /** 模型给出的答案；拒答时是那句指引，不是答案。 */
  text: string;
  finishReason: string;
  /** 只记布尔与计数，**不记原文**——埋点不得成为第二条「写入」通道。 */
  signals: {
    evidence: BtwEvidenceAssessment;
    refused: boolean;
    /** `tools: []` 是硬约束；非 0 说明约束在某处被穿透，是比「答案为空」更早的预警。 */
    toolCallCount: number;
    usage: {
      inputTokens: number;
      outputTokens: number;
    };
  };
  usage: ModelUsage;
}

export async function runBtwModelRequest(
  this: AgentRuntimeInternal,
  input: BtwModelRequestInput,
): Promise<BtwModelResult> {
  const question = input.question.trim();
  if (!question) {
    throw new BtwModelRequestError("provider", "Side question is empty");
  }

  const selection = this.getSessionModelSelection();
  const model = createRuntimeModel(this, { selection });
  const traceContext = createChildTraceContext(this.rootTraceContext, {
    attributes: { querySource: BTW_QUERY_SOURCE },
  });

  // 侧问有自己的取消信号与超时，与 turn 的 signal 无关。没有超时的侧问会把浮层永久留在
  // 屏幕上，这是最坏情况下的死锁来源。
  const cancelSignal = input.abortSignal ?? new AbortController().signal;
  const timeoutSignal = AbortSignal.timeout(input.timeoutMs ?? BTW_DEFAULT_TIMEOUT_MS);
  const abortSignal = AbortSignal.any([cancelSignal, timeoutSignal]);

  // 快照必须在**同步**片内取完，且必须裁掉尾部未兑现的 tool_use：工具执行期间 canonical
  // history 的尾部是「带 toolCalls 的 assistant + 部分 tool result」，原样发出会被 provider
  // 拒绝（400）。这个窗口是「主任务看起来在跑」的大多数时刻。
  const snapshot = withoutPendingTrailingToolCalls([
    ...this.messageHistory.borrowReadOnlyRuntimeEntries(),
  ]);
  const evidence = assessBtwEvidence(question, snapshot);

  const entries: RuntimeMessageEntry[] = [
    ...snapshot,
    { message: { content: buildBtwUserContent(question, evidence), role: "user" } },
  ];
  const messages = buildRuntimeProviderRequestMessages(this, {
    applyCacheControl: true,
    entries,
    model,
  }).messages;

  const request = {
    abortSignal,
    messages,
    // 无工具是硬约束，不是提示词约定。
    tools: [],
    options: {
      maxOutputTokens: input.maxOutputTokens ?? BTW_DEFAULT_MAX_OUTPUT_TOKENS,
    },
  };

  const result = await runWithModelInvocationContext(
    {
      metadata: {
        ...traceContextToLogContext(traceContext),
        querySource: BTW_QUERY_SOURCE,
        // ① 的唯一退出口：非流式路径读它，流式路径不读。
        skipTranscript: true,
      },
      modelRequestSessionType: "other",
      traceContext,
      // 长会话里凭据可能已过期；不挂这条刷新，侧问会 401 而主任务正常。
      refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(this, {
        abortSignal,
        model,
        traceContext,
      }),
      // 故意**不提供** statusSink：它的 publish 会 appendEvent，即写进 session db。
    },
    () => model.generateText(request),
  ).catch((error: unknown) => {
    throw toBtwError(error, { cancelSignal, timeoutSignal });
  });

  const { text, refused } = stripBtwNoContextSentinel(result.text);
  return {
    finishReason: result.finishReason,
    signals: {
      evidence,
      refused,
      // 只计数、不取内容；非 0 说明 tools:[] 的硬约束被穿透。
      toolCallCount: result.toolCalls?.length ?? 0,
      usage: {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
      },
    },
    text,
    usage: result.usage,
  };
}

function buildBtwUserContent(question: string, evidence: BtwEvidenceAssessment): string {
  const parts = [BTW_CONTEXT_CONSTRAINT];
  // 证据检查是**软信号**：命中直接作答；未命中不拒答，而是要求模型显式声明依据。
  // 中文提问与英文/代码上下文几乎无字面重合，硬闸门会把合法问题一律打死。
  if (evidence.level === "miss") parts.push(BTW_LOW_CONFIDENCE_CLAUSE);
  parts.push(`Side question: ${question}`);
  return parts.join("\n\n");
}

function stripBtwNoContextSentinel(text: string): { refused: boolean; text: string } {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith(BTW_NO_CONTEXT_SENTINEL)) {
    return { refused: false, text: text.trim() };
  }
  return {
    refused: true,
    text: trimmed.slice(BTW_NO_CONTEXT_SENTINEL.length).trim(),
  };
}

function toBtwError(
  error: unknown,
  signals: { cancelSignal: AbortSignal; timeoutSignal: AbortSignal },
): BtwModelRequestError {
  if (error instanceof BtwModelRequestError) return error;
  // 超时与用户取消都是本地判定，优先于 provider 错误分类。
  if (signals.timeoutSignal.aborted) {
    return new BtwModelRequestError("timeout", "Side question timed out", { cause: error });
  }
  if (signals.cancelSignal.aborted) {
    return new BtwModelRequestError("cancelled", "Side question was cancelled", { cause: error });
  }
  // 会话接近上限时完整快照会直接 context_exceeded；它与网络失败必须区分，否则用户无从修正。
  if (isModelContextExceededError(error)) {
    return new BtwModelRequestError("context_exceeded", "Session context exceeded", {
      cause: error,
    });
  }
  return new BtwModelRequestError("provider", errorMessage(error), { cause: error });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
