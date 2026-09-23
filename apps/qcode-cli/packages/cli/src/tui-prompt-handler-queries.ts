// tui-prompt-handler.ts 顶到 oxlint max-lines 上限（400 行），把 submitPrompt 上
// 那组「拿到当前 App 就只读转发」的查询方法拆到本文件；公开面仍从 tui-prompt-handler.ts 导出。
import { BtwModelRequestError } from "@zcode/core";
import type { CommandCenterApp } from "./command-center.js";
import { listAppEffortOptions } from "./command-center/effort-options.js";
import type { TuiPromptHandler } from "./tui-command-state.js";
import type {
  TuiSideQuestionFailureReason,
  TuiSideQuestionResult,
  TuiSessionMetadata,
} from "@zcode/tui";

export async function readTuiSessionMetadata(app: CommandCenterApp): Promise<TuiSessionMetadata> {
  const modelOptions = (await app.listModels?.()) ?? [];
  return {
    locale: app.getLocale?.(),
    model: app.getModel?.(),
    theme: app.getTheme?.(),
    thoughtLevel: app.getThoughtLevel?.(),
    modelOptions,
    effortOptions: (await listAppEffortOptions(app)) ?? [],
    providerSetupRequired: !modelOptions.some((model) => !model.disabledReason),
  };
}

export const attachTuiAppQueries = (
  submitPrompt: TuiPromptHandler,
  getApp: () => Promise<CommandCenterApp>,
): void => {
  submitPrompt.readSubagents = async (input) => {
    const app = await getApp();
    return (
      app.readSubagents?.(input) ?? {
        revision: 0,
        childSessionIds: [],
        running: [],
        ended: { total: 0, items: [] },
      }
    );
  };
  submitPrompt.readSubagentTranscript = async (childSessionId) => {
    const app = await getApp();
    if (!app.readSubagentTranscript) throw new Error("Subagent transcript is unavailable.");
    return app.readSubagentTranscript(childSessionId);
  };
  submitPrompt.recallPreviousInput = async (skip) => {
    const activeApp = await getApp();
    return (await activeApp.recallPreviousInputHistory?.(skip)) ?? null;
  };

  submitPrompt.getSessionMetadata = async () => {
    const activeApp = await getApp();
    return readTuiSessionMetadata(activeApp);
  };

  submitPrompt.listModelOptions = async () => {
    const activeApp = await getApp();
    return activeApp.listModels?.() ?? [];
  };

  submitPrompt.listEffortOptions = async () => {
    const activeApp = await getApp();
    return (await listAppEffortOptions(activeApp)) ?? [];
  };

  submitPrompt.listMcpServers = async () => {
    const activeApp = await getApp();
    return activeApp.listMcpServers?.() ?? {};
  };

  submitPrompt.listWorkflowRuns = async () => {
    const activeApp = await getApp();
    // 会话级摘要；服务端已按「最近更新在前」给序，读侧不重排（端口注释的裁定）。
    return (await activeApp.listDynamicWorkflowRuns?.({})) ?? [];
  };

  submitPrompt.replayWorkflowRuns = async (input) => {
    const activeApp = await getApp();
    // 与 v4 冷物化同一条链：journal → 与 live
    // 同一种进度载荷 → 镜像的共享 reducer。
    return (await activeApp.replayDynamicWorkflowRuns?.(input)) ?? [];
  };

  submitPrompt.askSideQuestion = async ({ question, signal }): Promise<TuiSideQuestionResult> => {
    const activeApp = await getApp();
    const runtime = (activeApp as { runtime?: BtwCapableRuntime }).runtime;
    // 能力缺席时**明确报出**，不要静默退化成普通提问——那会把一次「不写入」的侧问
    // 变成一次真正落进转录、且带工具的普通 turn。
    if (typeof runtime?.runBtwModelRequest !== "function") {
      return { kind: "failure", message: "Side question runtime is unavailable.", reason: "unavailable" };
    }
    try {
      const result = await runtime.runBtwModelRequest({ abortSignal: signal, question });
      return { kind: "answer", text: result.text };
    } catch (error) {
      return {
        kind: "failure",
        message: error instanceof Error ? error.message : String(error),
        reason: toSideQuestionFailureReason(error),
      };
    }
  };
};

/**
 * 侧问方法的最小结构面。
 *
 * 这里用结构类型而不是 `AgentRuntime`，是因为 `app.runtime` 本来就是按需读出来的
 * （见 `getMainSessionId`），把它窄化成真正用到的那一个方法，能力缺席时的分支才是显式的。
 */
type BtwCapableRuntime = {
  runBtwModelRequest?: (input: {
    abortSignal?: AbortSignal;
    question: string;
  }) => Promise<{ text: string }>;
};

const SIDE_QUESTION_FAILURE_REASONS: ReadonlySet<string> = new Set<TuiSideQuestionFailureReason>([
  "cancelled",
  "context_exceeded",
  "provider",
  "timeout",
]);

function toSideQuestionFailureReason(error: unknown): TuiSideQuestionFailureReason {
  const reason = error instanceof BtwModelRequestError ? error.reason : undefined;
  return reason !== undefined && SIDE_QUESTION_FAILURE_REASONS.has(reason)
    ? (reason as TuiSideQuestionFailureReason)
    : "provider";
}
