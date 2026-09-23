#!/usr/bin/env node
// 运行中侧问（/btw）的验收关卡（见 docs/plan-btw-side-question.md 的 Do 章节）。
//
// 为什么需要它：侧问最容易的失效形态是**静默落盘**——功能看起来完全正常，而提问原文与
// 答案已经写进了会话库或 model-io。本仓库没有单元测试，所以这里把「不写入」做成硬断言。
//
// 断言分两层，两层都必须跑：
//   源码层（A2/A3/A6）：钉住「隔离调用」的形态，防后来者把侧问「统一」回主请求路径。
//   运行时层（A5）：只有它能否证「真的没落盘」，且必须按**落盘通道**枚举，而不是按目录拍脑袋。
//
// 用法：
//   node test/btw-side-question.mjs
//     跑 A1 / A2 / A3 / A4 / A6（不需要 provider）。
//
//   node test/btw-side-question.mjs --snapshot --question "<你的侧问原文>" [--state <文件>]
//     在**真实终端**里向 zcode 发起侧问**之前**采样四个落盘通道。
//
//   node test/btw-side-question.mjs --verify --question "<同一句>" --mode idle|running [--state <文件>]
//     侧问**之后**比对。`idle` = 空闲态（除这一次侧问外什么都没做）；`running` = 主任务运行中。
//
//   一条完整的空闲态验收流程：
//     1) node test/btw-side-question.mjs --snapshot --question "ZZBTW-PROBE-<随机串>"
//     2) 另开终端跑 `pnpm --filter @zcode/cli dev`，**只**输入 `/btw ZZBTW-PROBE-<随机串>`，然后退出
//     3) node test/btw-side-question.mjs --verify --question "ZZBTW-PROBE-<随机串>" --mode idle
//
// 前置：需要已构建的 CLI 产物。未构建时**直接失败并给出构建命令**，不静默跳过。

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "apps/qcode-cli/packages/cli/dist/zcode.cjs");
const btwSourcePath = join(
  repoRoot,
  "apps/qcode-cli/packages/core/src/runtime/methods/btw-model-request.ts",
);
const zcodeCliHome = join(homedir(), ".zcode", "cli");

/** ① model-io（rollout/debug）与 ④ JSONL 文件日志（log）——三个平级目录，漏一个就会「快照全绿而已落盘」。 */
const WATCHED_DIRECTORIES = ["rollout", "debug", "log"];
/** ② 会话事件流/转录（session_entry、message、part）与 ③ 用量表（model_usage）。 */
const TRANSCRIPT_TABLES = ["session_entry", "message", "part"];
const USAGE_TABLE = "model_usage";
/** 侧问在观测面的归属锚点；R-037：`operation` 只能是封闭 enum 的既有成员，不能用作锚点。 */
const BTW_QUERY_SOURCE = "btw";

/**
 * A2 的禁用符号清单。禁的是**一类**通道，不是一条：
 * - 会话事件与转录：`emitModelStreamingEvent`（幽灵 assistant 消息）、`SessionEventType.`（任意形态）、
 *   `appendEvent` / `createEvent`（写 session db）、`createModelStatusSink`（其 publish 内部 appendEvent）；
 * - 用量表：`recordModelUsageFact`；
 * - 主请求路径：`runModelTextRequest`；
 * - 流式：`streamText`（`runner-stream.ts` 没有 `skipTranscript` 退出口）。
 */
const BANNED_SYMBOLS = [
  "emitModelStreamingEvent",
  "SessionEventType.",
  "runModelTextRequest",
  "appendEvent",
  "createEvent",
  "createModelStatusSink",
  "recordModelUsageFact",
  "streamText",
];

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
}
function note(message) {
  console.log(`        ${message}`);
}
function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

if (!existsSync(cliPath)) {
  fail(
    `缺少构建产物：${cliPath}\n请先构建：pnpm --filter "@zcode/cli..." build\n` +
      "（注意：pnpm --filter @zcode/cli build 不会重建 adapters / core / tui）",
  );
}

function runCli(cliArgs, { timeout = 120_000 } = {}) {
  const child = spawnSync(process.execPath, [cliPath, ...cliArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout,
  });
  return { status: child.status, stderr: child.stderr ?? "", stdout: child.stdout ?? "" };
}

// ---------------------------------------------------------------------------
// 源码断言
// ---------------------------------------------------------------------------

/**
 * 剥离注释后再匹配（R-035）。
 *
 * 步骤 3 **强制**在文件头写「为什么不能走主请求路径」的注释，而这类注释天然会写出
 * `emitModelStreamingEvent` / `SessionEventType.ModelStreaming` 这些符号名；直接对原始文本
 * 做子串匹配必然误报。**绝不允许用「删掉那条注释」来让断言变绿**——那正是防回归守卫的载体。
 *
 * 同时返回注释文本，好把「仅在注释中命中」与「在可执行代码中命中」**区分报告**。
 */
function splitSourceComments(source) {
  let code = "";
  let comments = "";
  let index = 0;

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (char === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? source.length : end;
      comments += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      comments += source.slice(index, stop);
      index = stop;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      // 字符串里的 `//` 不是注释（URL、路径都可能出现），整体跳过。
      let cursor = index + 1;
      while (cursor < source.length) {
        if (source[cursor] === "\\") cursor += 2;
        else if (source[cursor] === char) {
          cursor += 1;
          break;
        } else cursor += 1;
      }
      code += source.slice(index, cursor);
      index = cursor;
      continue;
    }

    code += char;
    index += 1;
  }

  return { code, comments };
}

function runSourceAssertions() {
  if (!existsSync(btwSourcePath)) {
    assert("A2 侧问调用模块存在", false, `找不到 ${btwSourcePath}`);
    return;
  }
  const { code, comments } = splitSourceComments(readFileSync(btwSourcePath, "utf8"));

  const codeHits = BANNED_SYMBOLS.filter((symbol) => code.includes(symbol));
  assert(
    "A2 btw-model-request.ts 的可执行代码不含任何落盘/会话事件/流式符号",
    codeHits.length === 0,
    codeHits.length === 0 ? undefined : `在剥离注释后的代码里命中：${codeHits.join(", ")}`,
  );
  const commentOnly = BANNED_SYMBOLS.filter(
    (symbol) => !code.includes(symbol) && comments.includes(symbol),
  );
  if (commentOnly.length > 0) {
    note(`（仅出现在注释中，不算违规：${commentOnly.join(", ")}）`);
  }

  // A3：`tools` 只能是恒为空数组。逐个 `tools:` 赋值点检查，而不是只看有没有 `tools: []`
  // ——后者在「再补一个 tools: somethingElse」时仍是绿的。
  const toolAssignments = [...code.matchAll(/tools\s*:\s*([^\n,}]*)/gu)].map((match) =>
    (match[1] ?? "").trim(),
  );
  assert(
    "A3 侧问请求的 tools 恒为空数组",
    toolAssignments.length > 0 && toolAssignments.every((value) => value === "[]"),
    toolAssignments.length === 0
      ? "没有找到任何 tools 赋值点"
      : `发现非空 tools：${toolAssignments.join(" | ")}`,
  );

  const usesGenerateText = code.includes(".generateText(");
  const usesStreamText = code.includes(".streamText(");
  assert(
    "A6 侧问走非流式 generateText 且带 skipTranscript",
    usesGenerateText && !usesStreamText && code.includes("skipTranscript: true"),
    `generateText=${usesGenerateText} streamText=${usesStreamText} skipTranscript=${code.includes(
      "skipTranscript: true",
    )}`,
  );
}

// ---------------------------------------------------------------------------
// 命令行面断言（A1 / A4）
// ---------------------------------------------------------------------------

function runCliSurfaceAssertions() {
  const help = runCli(["--help"]);
  assert(
    "A1 CLI --help 列出 /btw",
    help.stdout.includes("/btw") || help.stderr.includes("/btw"),
    help.stdout.slice(0, 400),
  );

  const commandHelp = runCli(["-p", "/help"]);
  assert(
    "A1 /help 的 slash command 清单列出 /btw",
    commandHelp.stdout.includes("/btw"),
    commandHelp.stdout.slice(0, 400),
  );

  const probe = "ZZBTW-HEADLESS-PROBE";
  const rejected = runCli(["-p", `/btw ${probe}`]);
  const combined = `${rejected.stdout}${rejected.stderr}`;
  assert(
    "A4 headless 下 /btw 返回「交互式 TUI 专用」且非零退出",
    rejected.status !== 0 && /interactive TUI/iu.test(combined),
    `status=${rejected.status} output=${combined.slice(0, 300)}`,
  );
  // 若被转发给 agent，模型会针对问题生成一段答案——那才是这条断言真正的证伪点。
  assert(
    "A4 headless 下 /btw 不产生任何模型响应内容",
    !/Slash commands:/u.test(combined) && combined.trim().split("\n").length <= 3,
    combined.slice(0, 400),
  );
}

// ---------------------------------------------------------------------------
// 运行时落盘断言（A5）：按通道枚举
// ---------------------------------------------------------------------------

function statePath() {
  return option("--state") ?? join(tmpdir(), "zcode-btw-verify.json");
}

function listFilesRecursively(rootDirectory) {
  const files = {};
  if (!existsSync(rootDirectory)) return files;
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      const stat = statSync(fullPath);
      files[fullPath] = { mtimeMs: stat.mtimeMs, size: stat.size };
    }
  };
  walk(rootDirectory);
  return files;
}

function readTableSnapshot() {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return { available: false };
  }
  const dbPath = join(zcodeCliHome, "db", "db.sqlite");
  if (!existsSync(dbPath)) return { available: false };
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = {};
    for (const table of [...TRANSCRIPT_TABLES, USAGE_TABLE]) {
      try {
        counts[table] = db.prepare(`select count(*) as count from ${table}`).get().count;
      } catch {
        // 表在这个构建里可能不存在（例如 schema 迁移后改名）——记 -1，比对时按「未知」处理，
        // 而不是当成 0 悄悄放过。
        counts[table] = -1;
      }
    }
    return { available: true, counts };
  } finally {
    db.close();
  }
}

function takeSnapshot() {
  const directories = {};
  for (const name of WATCHED_DIRECTORIES) {
    directories[name] = listFilesRecursively(join(zcodeCliHome, name));
  }
  return { directories, tables: readTableSnapshot(), takenAt: new Date().toISOString() };
}

function readQuestionText(question) {
  if (!question)
    fail("--snapshot/--verify 需要 --question <原文>（用于「新增内容是否含提问原文」的断言）");
  return question;
}

/** 在目录快照里找出「新增或改动过、且内容含提问原文」的文件。 */
function filesContainingQuestion(previousFiles, currentRoot, question) {
  const offenders = [];
  const currentFiles = listFilesRecursively(currentRoot);
  for (const [filePath, stat] of Object.entries(currentFiles)) {
    const previous = previousFiles[filePath];
    const changed =
      previous === undefined || previous.size !== stat.size || previous.mtimeMs !== stat.mtimeMs;
    if (!changed) continue;
    try {
      // 日志与 model-io 都是文本；二进制按 latin1 读不会抛错，仍然能命中 ASCII 探针。
      if (readFileSync(filePath, "latin1").includes(question)) offenders.push(filePath);
    } catch {
      // 读不了的文件不计入违规：断言的是「内容含原文」，不是「文件不可读」。
    }
  }
  return offenders;
}

function rowsContainingQuestion(question) {
  let sqlite;
  try {
    sqlite = require("node:sqlite");
  } catch {
    return { available: false, offenders: [] };
  }
  const dbPath = join(zcodeCliHome, "db", "db.sqlite");
  if (!existsSync(dbPath)) return { available: false, offenders: [] };
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const offenders = [];
    // LIKE 的 `%` / `_` 是通配符：探针里带这两个字符会让查询过匹配 → 断言假失败。
    // 而**假失败的真实代价是这个护栏被当成噪声删掉**（本计划反复点名的失效形态），
    // 所以这里转义，而不是要求用户别在探针里写 `%`。
    const pattern = `%${question.replace(/[\\%_]/gu, (char) => `\\${char}`)}%`;
    for (const table of TRANSCRIPT_TABLES) {
      try {
        const rows = db
          .prepare(`select id from ${table} where data like ? escape '\\'`)
          .all(pattern);
        for (const row of rows) offenders.push(`${table}:${row.id}`);
      } catch {
        // 表不存在时跳过（见 readTableSnapshot 的同一条说明）。
      }
    }
    try {
      const usageRows = db
        .prepare(`select id from ${USAGE_TABLE} where query_source = ?`)
        .all(BTW_QUERY_SOURCE);
      for (const row of usageRows) offenders.push(`${USAGE_TABLE}:${row.id}`);
    } catch {
      // 同上。
    }
    return { available: true, offenders };
  } finally {
    db.close();
  }
}

function runVerify(question, mode) {
  const path = statePath();
  if (!existsSync(path)) {
    fail(
      `找不到快照：${path}\n` +
        "A5 需要先跑一次 --snapshot。**不会静默跳过**——静默跳过正是这条护栏失效的方式。",
    );
  }
  const snapshot = JSON.parse(readFileSync(path, "utf8"));

  for (const name of WATCHED_DIRECTORIES) {
    const offenders = filesContainingQuestion(
      snapshot.directories?.[name] ?? {},
      join(zcodeCliHome, name),
      question,
    );
    assert(
      `A5 ${name}/ 的新增或改动文件不含侧问提问原文`,
      offenders.length === 0,
      offenders.join("\n        "),
    );
  }

  const rows = rowsContainingQuestion(question);
  if (!rows.available) {
    assert("A5 会话库可读（转录三表 + 用量表）", false, "无法打开 ~/.zcode/cli/db/db.sqlite");
  } else {
    assert(
      "A5 会话库中不存在含提问原文的行，也不存在 query_source=btw 的用量行",
      rows.offenders.length === 0,
      rows.offenders.join(", "),
    );
  }

  if (mode === "idle") {
    // 空闲态是最干净的判据：除这一次侧问外没有别的模型流量，所以可以做**严格**的零新增断言。
    const current = readTableSnapshot();
    const before = snapshot.tables?.counts ?? {};
    const growth = Object.keys(current.counts ?? {})
      .filter((table) => before[table] !== -1 && current.counts[table] !== before[table])
      .map((table) => `${table}: ${before[table]} -> ${current.counts[table]}`);
    assert(
      "A5（空闲态）用量/转录表严格零新增",
      growth.length === 0,
      `${growth.join("; ")}\n        （空闲态验收要求这次会话里除 /btw 外什么都没做）`,
    );
  } else {
    note("运行态只做归属断言：主任务本身一直在写库，计数断言在这里必然假失败（R-036）。");
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

if (flag("--snapshot")) {
  const question = readQuestionText(option("--question"));
  const path = statePath();
  writeFileSync(path, JSON.stringify(takeSnapshot(), null, 2));
  console.log(`已采样四个落盘通道 → ${path}`);
  console.log(`探针原文：${question}`);
  console.log("现在去真实终端发起这一次侧问，然后跑 --verify。");
  process.exit(0);
}

if (flag("--verify")) {
  const question = readQuestionText(option("--question"));
  const mode = option("--mode") ?? "idle";
  if (mode !== "idle" && mode !== "running") fail("--mode 只能是 idle 或 running");
  runVerify(question, mode);
} else {
  console.log("侧问（/btw）验收关卡");
  console.log("\n源码断言：");
  runSourceAssertions();
  console.log("\n命令行面断言：");
  runCliSurfaceAssertions();
  console.log("\n提示：运行时落盘断言（A5）需要先在真实终端跑一次侧问，见本文件头部的用法说明。");
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length === 0 ? 0 : 1);
