import type {
  TuiAskSideQuestion,
  TuiEffortOption,
  TuiListMcpServers,
  TuiGetMainSessionId,
  TuiListWorkflowRuns,
  TuiReplayWorkflowRuns,
  TuiModelOption,
  TuiRecallPreviousInput,
  TuiSendInput,
  TuiSetMode,
  TuiSessionMetadata,
  TuiSubmitPrompt,
  TuiSubscribeSessionEvents,
} from "@qcode/tui";
import type { ZCodeAppOptions } from "@qcode/bootstrap";
import type { CliModeState, CliPermissionMode, CliRuntimeMode } from "./cli-types.js";

/**
 * 白名单：这些命令在**主任务运行中**也必须回到命令中心，而不是被当成 turn 输入转发给 agent。
 *
 * `/model` 与 `/effort` 是「配置后续请求」，`/btw` 是「运行中侧问」——它们共同的前提是
 * **不打断当前 turn**。第三个「运行中可用」的命令出现时应改为按声明的元数据判定，
 * 而不是继续堆字面量（本次只记录，不重构）。
 */
export const RUNNING_KNOWN_COMMANDS: ReadonlySet<string> = new Set(["model", "effort", "btw"]);

export type TuiPromptHandler = TuiSubmitPrompt & {
  askSideQuestion?: TuiAskSideQuestion;
  close?: () => Promise<void>;
  getSessionMetadata?: () => Promise<TuiSessionMetadata>;
  listEffortOptions?: () => Promise<readonly TuiEffortOption[]>;
  listMcpServers?: TuiListMcpServers;
  readSubagents?: import("@qcode/tui").TuiReadSubagents;
  readSubagentTranscript?: import("@qcode/tui").TuiReadSubagentTranscript;
  listWorkflowRuns?: TuiListWorkflowRuns;
  replayWorkflowRuns?: TuiReplayWorkflowRuns;
  getMainSessionId?: TuiGetMainSessionId;
  listModelOptions?: () => Promise<readonly TuiModelOption[]>;
  recallPreviousInput?: TuiRecallPreviousInput;
  sendInput?: TuiSendInput;
  setMode?: TuiSetMode;
  subscribeSessionEvents?: TuiSubscribeSessionEvents;
};

export const TUI_TITLE_GENERATION_CONFIG: NonNullable<
  NonNullable<ZCodeAppOptions["runtimeConfig"]>["titleGeneration"]
> = {};

export const createCliModeState = (mode?: CliPermissionMode): CliModeState => ({
  current: mode,
  override: mode,
});

export const currentCliMode = (state: CliModeState): CliRuntimeMode =>
  state.current ?? state.override ?? "build";

/** The TUI's Plan entry projects the runtime's independent planning flag. */
export function readTuiMode(
  app: {
    getMode?: () => CliRuntimeMode;
    readonly runtime?: { getPlanEnabled?: () => boolean };
  },
  fallback: CliRuntimeMode,
): CliRuntimeMode {
  return app.runtime?.getPlanEnabled?.() ? "plan" : (app.getMode?.() ?? fallback);
}
