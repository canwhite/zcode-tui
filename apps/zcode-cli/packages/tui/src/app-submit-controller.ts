import React from "react";
import type { ModelSelection } from "@zcode/shared";
import type { SessionEvent, TurnId } from "@zcode/contracts";
import { resolveBtwSubmission, type BtwState, type BtwSubmission } from "./app-btw.js";
import { submitDuringActiveTurn, submitIdleTurn } from "./app-submit.js";
import type {
  DraftAttachment,
  Message,
  QueuedInput,
  SelectionState,
  SubmitValueOptions,
  SlashSelectionState,
} from "./app-model.js";
import type { TuiOptions, TuiRequestPermission, TuiSubmitPromptResult } from "./types.js";

export function useSubmitValue(input: {
  activeTurnId?: TurnId;
  applyResult: (result: TuiSubmitPromptResult, preserveTurnState?: boolean) => void;
  applySessionEvent: (event: SessionEvent) => void;
  btw: BtwState;
  busy: boolean;
  draftAttachmentsRef: React.MutableRefObject<DraftAttachment[]>;
  emptyPromptStatus: string;
  messageInsertIndex: number;
  options: TuiOptions;
  requestPermission: TuiRequestPermission;
  resolveSubmittedText: (submittedValue: string) => string;
  resolveSubmittedModel?: (submittedValue: string) => ModelSelection | undefined;
  setBusy: (value: boolean) => void;
  setDraftAttachments: React.Dispatch<React.SetStateAction<DraftAttachment[]>>;
  setDraftValue: (value: string) => void;
  setLastError: (message: string | undefined) => void;
  setLiveModelText: (value: string) => void;
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>;
  setQueuedInputs: React.Dispatch<React.SetStateAction<QueuedInput[]>>;
  setSelection: React.Dispatch<React.SetStateAction<SelectionState | undefined>>;
  setSlashSelection: React.Dispatch<React.SetStateAction<SlashSelectionState | undefined>>;
  setStatus: (status: string) => void;
  setStatusDetails: React.Dispatch<React.SetStateAction<string[]>>;
  submitBtw: (submission: BtwSubmission) => Promise<void>;
  turnRef: React.MutableRefObject<AbortController | undefined>;
}): (submittedValue: string, options?: SubmitValueOptions) => Promise<void> {
  return React.useCallback(
    async (submittedValue: string, options: SubmitValueOptions = {}) => {
      const text = input.resolveSubmittedText(submittedValue).trim();
      const modelSelection = input.resolveSubmittedModel?.(submittedValue);
      if (!text) {
        input.setStatus(input.emptyPromptStatus);
        return;
      }

      // 侧问必须在 `busy` 分支**之前**判定：运行中提交输入会走排队通道，
      // `/btw` 一旦被塞进排队输入就永远等不到答案（这正是 F-003 要防的形态）。
      const btwSubmission = resolveBtwSubmission(text, input.btw.awaitingQuestion);
      if (btwSubmission) {
        await input.submitBtw(btwSubmission);
        // `cancel-await` 只撤销「等待侧问内容」态，这次输入仍是用户的命令，必须继续往下走。
        // 在这里 return 会把用户敲的那条命令**静默吞掉**。
        if (btwSubmission.kind !== "cancel-await") return;
      }

      if (input.busy) {
        await submitDuringActiveTurn({
          activeTurnId: input.activeTurnId,
          applyResult: input.applyResult,
          applySessionEvent: input.applySessionEvent,
          draftAttachments: input.draftAttachmentsRef.current,
          messageInsertIndex: input.messageInsertIndex,
          options: input.options,
          requestPermission: input.requestPermission,
          setDraftValue: input.setDraftValue,
          setLastError: input.setLastError,
          setMessages: input.setMessages,
          setQueuedInputs: input.setQueuedInputs,
          setStatus: input.setStatus,
          signal: input.turnRef.current?.signal,
          text,
          modelSelection,
        });
        return;
      }

      await submitIdleTurn({
        applyResult: input.applyResult,
        applySessionEvent: input.applySessionEvent,
        draftAttachments: input.draftAttachmentsRef.current,
        options: input.options,
        requestPermission: input.requestPermission,
        setBusy: input.setBusy,
        setDraftAttachments: input.setDraftAttachments,
        setDraftValue: input.setDraftValue,
        setLastError: input.setLastError,
        setLiveModelText: input.setLiveModelText,
        setMessages: input.setMessages,
        setSelection: input.setSelection,
        setSlashSelection: input.setSlashSelection,
        setStatus: input.setStatus,
        setStatusDetails: input.setStatusDetails,
        submitOptions: options,
        text,
        modelSelection,
        turnRef: input.turnRef,
      });
    },
    [input],
  );
}
