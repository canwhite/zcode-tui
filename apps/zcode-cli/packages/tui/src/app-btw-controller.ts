import type { TuiCopy } from "@zcode/i18n";
import { useCallback, useRef, useState } from "react";
import {
  applyBtwResult,
  INITIAL_BTW_STATE,
  scrollBtwBy,
  type BtwState,
  type BtwSubmission,
} from "./app-btw.js";
import type { TuiOptions } from "./types.js";

export interface BtwController {
  close: () => void;
  /** 失败态的手动重试：复用同一条问题原文，不要求用户重新打一遍。 */
  retry: () => void;
  scroll: (delta: number) => void;
  state: BtwState;
  submit: (submission: BtwSubmission) => Promise<void>;
}

/**
 * 运行中侧问（`/btw`）的控制器。
 *
 * 状态**只活在内存里**：不写配置、不写 session、不写日志——与 core 侧的「零持久化」
 * 是同一条约束的两端。
 */
export function useBtwController(input: {
  copy: TuiCopy;
  focusComposer: () => void;
  options: TuiOptions;
  setStatus: (status: string) => void;
}): BtwController {
  const { copy, focusComposer, options, setStatus } = input;
  const [state, setState] = useState<BtwState>(INITIAL_BTW_STATE);
  const abortRef = useRef<AbortController | undefined>(undefined);
  // 只认最后一次请求的回调：浮层可能已被关闭，或被另一次侧问替换。
  const activeIdRef = useRef<string | undefined>(undefined);
  // 序号只在**本会话内**需要唯一，不引 `crypto`（对齐 app.tsx 的 nextAttachmentIdRef）。
  const nextIdRef = useRef(0);

  const runQuestion = useCallback(
    async (question: string): Promise<void> => {
      const ask = options.askSideQuestion;
      if (!ask) {
        // 缺省能力时**明确报出**，不要静默退化成普通提问——那会把一次「不写入」的
        // 侧问变成一次真正落进转录的工具轮。
        setStatus(copy.btw.unavailable);
        return;
      }

      // 串行：上一条还没回来时再问一次，先取消上一条，避免两份结果互相覆盖。
      abortRef.current?.abort();
      const controller = new AbortController();
      nextIdRef.current += 1;
      const id = `btw-${nextIdRef.current}`;
      abortRef.current = controller;
      activeIdRef.current = id;
      setState({
        awaitingQuestion: false,
        entry: {
          answer: "",
          id,
          question,
          scroll: 0,
          startedAt: Date.now(),
          status: "waiting",
        },
        focused: true,
      });

      // 非流式：答案整段返回。这里用 await 而不是回调，正是为了让「写向已关闭浮层」
      // 这类问题在结构上不存在——返回值落地前先核对 id。
      const result = await ask({ question, signal: controller.signal }).catch((error: unknown) => ({
        kind: "failure" as const,
        message: error instanceof Error ? error.message : String(error),
        reason: "provider" as const,
      }));

      if (activeIdRef.current !== id) return;
      activeIdRef.current = undefined;
      abortRef.current = undefined;
      setState((current) => applyBtwResult(current, id, result));
    },
    [copy, options, setStatus],
  );

  const submit = useCallback(
    async (submission: BtwSubmission): Promise<void> => {
      if (submission.kind === "cancel-await") {
        // 等待提问期间用户改用别的斜杠命令：撤销等待态，交回普通路径，不劫持命令。
        setState((current) => ({ ...current, awaitingQuestion: false }));
        return;
      }
      if (submission.kind === "await") {
        setState({ awaitingQuestion: true, focused: false });
        setStatus(copy.btw.awaitingQuestion);
        return;
      }
      await runQuestion(submission.question);
    },
    [copy, runQuestion, setStatus],
  );

  const close = useCallback((): void => {
    // 关闭浮层即取消在途请求（R-038）：非流式下答案整段返回，用户等不及按 Esc 是很自然的
    // 动作，不取消就会白烧 token，并且让一个已经没人看的请求继续跑。
    abortRef.current?.abort();
    abortRef.current = undefined;
    activeIdRef.current = undefined;
    setState(INITIAL_BTW_STATE);
    // Esc 只关浮层 ≠ 用户理解了「主任务还在跑」，必须显式说一句。
    setStatus(copy.btw.closedNotice);
    focusComposer();
  }, [copy, focusComposer, setStatus]);

  const scroll = useCallback((delta: number): void => {
    setState((current) =>
      current.entry ? { ...current, entry: scrollBtwBy(current.entry, delta) } : current,
    );
  }, []);

  const retry = useCallback((): void => {
    const entry = state.entry;
    // 只在失败态重试：重试一个还在飞的请求只会自己取消自己，重试一个成功的答案没有意义。
    if (!entry || entry.status !== "failed") return;
    void runQuestion(entry.question);
  }, [runQuestion, state.entry]);

  return { close, retry, scroll, state, submit };
}
