#!/usr/bin/env node
// 「侧问不落 model-io」的**运行时**证据（R-001 的通道 ①）。
//
// 为什么需要它：A2 是源码断言，它只能证明「没有出现 appendEvent 这类符号」，证明不了运行时
// 没落盘（计划 R-011 已点名这个盲区）。而侧问的整条卖点就是「不写入」。
//
// 做法：`runGenerateText` 的 AI SDK runtime 是**可注入**的，所以不需要任何 provider 或网络，
// 就能把真实的落盘判定链跑起来，并落到一个临时 debugDir 上观察。
//
// **关键在于负向对照**：只断言「带 skipTranscript 时目录为空」是不够的——写盘逻辑本身坏掉时
// 它同样是绿的。所以同一个 fixture 跑两次：不带 skipTranscript 必须**写出文件**，
// 带 skipTranscript 必须**一个文件都不写**。两次结果不同，才说明被测的是那道闸门本身。
//
// 用法：npx tsx test/btw-skip-transcript.mjs

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runGenerateText } from "../apps/qcode-cli/packages/adapters/src/model/runner-generate.js";

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
}

/** 假的 AI SDK runtime：不联网，只回一个形状正确的 generateText 结果，并记录自己被调用过。 */
function createFakeRuntime() {
  const calls = [];
  return {
    calls,
    runtime: {
      generateText: async (options) => {
        calls.push(options);
        return {
          content: [{ text: "答案", type: "text" }],
          finishReason: "stop",
          reasoning: [],
          response: { id: "resp-probe", modelId: "probe-model" },
          steps: [],
          text: "答案",
          toolCalls: [],
          toolResults: [],
          totalUsage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
          },
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 10,
          },
        };
      },
      streamText: () => {
        throw new Error("本用例只覆盖非流式路径");
      },
    },
  };
}

const minimalResolved = {
  baseURL: "https://example.invalid/v1",
  modelId: "probe-model",
  properties: {},
  providerId: "probe-provider",
  providerKind: "openai-compatible",
};

async function runOnce({ debugDir, metadata }) {
  const fake = createFakeRuntime();
  const request = {
    abortSignal: new AbortController().signal,
    messages: [{ content: "ZZBTW-PROBE 侧问探针", role: "user" }],
    metadata,
  };
  await runGenerateText({
    debugDir,
    // development ⇒ 走 debug 目录；不应被当成 test 而静默跳过写盘。
    env: { ZCODE_RUNTIME_ENV: "development" },
    modelIoFullRetentionEnabled: true,
    request,
    resolveModel: () => minimalResolved,
    resolved: minimalResolved,
    retry: { backoffFactor: 1, baseDelayMs: 1, jitter: false, maxAttempts: 2, maxDelayMs: 10 },
    runtime: fake.runtime,
  });
  return fake.calls.length;
}

const root = mkdtempSync(join(tmpdir(), "qcode-btw-io-"));
try {
  const withoutSkipDir = join(root, "without-skip");
  const withSkipDir = join(root, "with-skip");

  let callsWithout;
  let errorWithout;
  try {
    callsWithout = await runOnce({ debugDir: withoutSkipDir, metadata: {} });
  } catch (error) {
    errorWithout = error;
  }

  if (errorWithout) {
    // fixture 本身没跑起来时必须**响亮失败**，不能把「跑挂」当成「没写盘」。
    assert(
      "model-io 闸门用例可运行（fixture 未被环境拒绝）",
      false,
      `不带 skipTranscript 的那一次就抛错了：${
        errorWithout instanceof Error ? errorWithout.message : String(errorWithout)
      }`,
    );
  } else {
    assert(
      "正向前置：假 runtime 确实被调用（否则后面两条都是空断言）",
      callsWithout > 0,
      `calls=${callsWithout}`,
    );
    const withoutSkipFiles = existsSync(withoutSkipDir) ? readdirSync(withoutSkipDir).length : 0;
    assert(
      "负向对照：不带 skipTranscript 时**会**写 model-io（证明闸门不是恒关的）",
      withoutSkipFiles > 0,
      `${withoutSkipDir} 下文件数 = ${withoutSkipFiles}`,
    );

    let callsWith;
    let errorWith;
    try {
      callsWith = await runOnce({
        debugDir: withSkipDir,
        metadata: { querySource: "btw", skipTranscript: true },
      });
    } catch (error) {
      errorWith = error;
    }
    assert(
      "带 skipTranscript 的请求能正常完成（闸门只关落盘，不影响请求本身）",
      errorWith === undefined && callsWith > 0,
      errorWith ? String(errorWith) : `calls=${callsWith}`,
    );
    const withSkipFiles = existsSync(withSkipDir) ? readdirSync(withSkipDir).length : 0;
    assert(
      "R-001 通道①：带 skipTranscript 时 model-io 零新增文件",
      withSkipFiles === 0,
      `${withSkipDir} 下文件数 = ${withSkipFiles}`,
    );
  }
} finally {
  rmSync(root, { force: true, recursive: true });
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
