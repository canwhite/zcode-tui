#!/usr/bin/env node
// 远程资源的本地化入口（F-002）。
//
// 职责边界：
//   - 本脚本是**唯一**会去公网取远程资源的地方。构建与安装链路一律不取网，
//     只读本地副本；缺失时指名失败（见 docs/plan-offline-vendoring.md Step 3）。
//   - 「刷新本地副本」是显式动作（本脚本 fetch），不是构建的副作用（对应 F-007 的方向）。
//
// 用法：
//   node scripts/vendor-resources.mjs status        列出每条资源的本地状态
//   node scripts/vendor-resources.mjs verify        离线校验：本地副本存在且 sha256 匹配
//   node scripts/vendor-resources.mjs assert        断言：本地副本不被任何 .gitignore 命中
//   node scripts/vendor-resources.mjs fetch         下载缺失项（幂等；已匹配则不发任何请求）
//     --only <id[,id]>   只处理指定资源
//     --dry-run          只报告将要做什么，不落盘
//
// 三条硬要求（对应计划 Step 2 与 Pre-Mortem R4/R7）：
//   1. 先校验后落盘：写临时文件 → 校验 sha256 → 原子 rename。半成品永远不会冒充完整文件。
//   2. 幂等：本地已存在且 sha256 匹配 → 直接跳过，**不发起任何网络请求**。
//   3. 落盘位置必须通过 git check-ignore 断言（覆盖全部 6 个 .gitignore）。
//      实测反例：apps/zcode-cli/dependencies/vendor/** 被 apps/zcode-cli/.gitignore
//      的裸 vendor 规则静默忽略——本地正常、克隆即崩。

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { repoRoot, readLedger } from "./remote-resources.mjs";

const formatBytes = (n) => `${(n / 1024 / 1024).toFixed(1)} MiB`;

async function sha256File(path) {
  const hash = createHash("sha256");
  // 流式读取：单个产物最大 87 MiB，整份读入内存没有必要，也会在大平台上放大峰值。
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

/**
 * 需要本地化的条目：有落点、尚未就绪、且未被标记为排除。
 *
 * `vendoring === "excluded"` 用于「环境前提」类资源（目前是 Node 运行时）——
 * 它们在台账里保留登记（对账要看得见），但不随仓库分发：336 MiB 占全部资源的 97%，
 * 而 make install 全程并不需要它。理由与判定见台账的 vendoringExclusions。
 */
function vendorable(ledger) {
  return (ledger.resources ?? []).filter(
    (r) => r.vendoredPath && r.status !== "ready" && r.vendoring !== "excluded",
  );
}

/** 本地副本是否已存在且内容与台账一致。不匹配的文件一律视为需要重新取。 */
async function localState(resource) {
  const path = join(repoRoot, resource.vendoredPath);
  if (!existsSync(path)) return { state: "missing", path };
  const actual = await sha256File(path);
  if (actual === resource.sha256) return { state: "ok", path, actual };
  return { state: "mismatch", path, actual };
}

/**
 * git check-ignore 断言。
 *
 * 作用域是**整个仓库**而不是只查根 .gitignore——本仓库有 6 个 .gitignore，
 * R4 的陷阱正是由 apps/zcode-cli/.gitignore 里的一条裸 vendor 造成的。
 * git 自身会合并全部规则，所以直接问 git 比自己实现匹配可靠。
 */
export function assertNotIgnored(paths) {
  const offenders = [];
  for (const p of paths) {
    try {
      execFileSync("git", ["check-ignore", "-q", p], { cwd: repoRoot, stdio: "ignore" });
      offenders.push(p); // 退出码 0 = 命中忽略规则
    } catch {
      // 退出码 1 = 未被忽略，正是期望结果
    }
  }
  return offenders;
}

function runStatus({ withHash }) {
  const { ledger } = readLedger();
  const items = vendorable(ledger);
  return Promise.all(items.map(localState)).then((states) => {
    let ok = 0;
    let missing = 0;
    let mismatch = 0;
    items.forEach((r, i) => {
      const s = states[i];
      const mark = s.state === "ok" ? "已就绪" : s.state === "missing" ? "缺失  " : "校验不过";
      if (s.state === "ok") ok += 1;
      else if (s.state === "missing") missing += 1;
      else mismatch += 1;
      // 只在**校验不过**时展示哈希：匹配时也打一行 "!= 台账" 会让状态行自相矛盾。
      const detail =
        withHash && s.state === "mismatch" ? `  (本地 ${s.actual.slice(0, 12)}… ≠ 台账)` : "";
      console.log(`  ${mark}  ${r.id.padEnd(36)}${detail}`);
    });
    console.log(
      `\n[resources] 已就绪 ${ok} ／ 缺失 ${missing} ／ 校验不过 ${mismatch}（共 ${items.length}）`,
    );
    return missing + mismatch === 0 ? 0 : 1;
  });
}

function runVerify() {
  const { ledger } = readLedger();
  const items = vendorable(ledger);
  return Promise.all(items.map(localState)).then((states) => {
    const bad = [];
    items.forEach((r, i) => {
      if (states[i].state !== "ok") bad.push({ id: r.id, ...states[i] });
    });
    if (bad.length === 0) {
      console.log(`[resources] ✓ ${items.length} 条本地副本全部存在且 sha256 匹配（全程未联网）`);
      return 0;
    }
    console.error(`[resources] ✗ ${bad.length} 条本地副本不可用：`);
    for (const b of bad) {
      const why = b.state === "missing" ? "本地副本缺失" : `sha256 不匹配（实际 ${b.actual}）`;
      console.error(`    ${b.id}：${why}`);
      console.error(`      ${relative(repoRoot, b.path)}`);
    }
    console.error(`  修复：node scripts/vendor-resources.mjs fetch`);
    return 1;
  });
}

function runAssert() {
  const { ledger } = readLedger();
  const paths = vendorable(ledger).map((r) => r.vendoredPath);
  const offenders = assertNotIgnored(paths);
  if (offenders.length === 0) {
    console.log(`[resources] ✓ ${paths.length} 条落点均未被任何 .gitignore 命中`);
    return 0;
  }
  console.error(`[resources] ✗ 以下落点被 .gitignore 命中——资源会静默不入库：`);
  for (const p of offenders) console.error(`    ${p}`);
  console.error(`  本地一切正常、克隆到断网机器才失败，是本项目最危险的失效形态。`);
  return 1;
}

async function downloadOne(resource) {
  const target = join(repoRoot, resource.vendoredPath);
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.download`;
  rmSync(temp, { force: true });

  const response = await fetch(resource.url, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`HTTP ${response.status}：${resource.url}`);
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temp));

  const actual = await sha256File(temp);
  if (actual !== resource.sha256) {
    rmSync(temp, { force: true });
    throw new Error(
      `sha256 不匹配\n      期望 ${resource.sha256}\n      实际 ${actual}\n      未落盘（临时文件已删除）`,
    );
  }
  renameSync(temp, target);
  return statSync(target).size;
}

async function runFetch(args) {
  const dryRun = args.includes("--dry-run");
  const onlyIndex = args.indexOf("--only");
  const only =
    onlyIndex >= 0 ? new Set((args[onlyIndex + 1] ?? "").split(",").filter(Boolean)) : null;

  const { ledger } = readLedger();
  let items = vendorable(ledger);
  if (only) {
    items = items.filter((r) => only.has(r.id));
    const found = new Set(items.map((r) => r.id));
    const unknown = [...only].filter((id) => !found.has(id));
    if (unknown.length > 0) {
      console.error(`[resources] 台账中没有这些 id：${unknown.join(", ")}`);
      return 2;
    }
  }

  // 先断言再下载：落点若会被忽略，取下来也进不了仓库，白白花掉带宽。
  const offenders = assertNotIgnored(items.map((r) => r.vendoredPath));
  if (offenders.length > 0) {
    console.error(`[resources] ✗ 落点被 .gitignore 命中，已中止下载：`);
    for (const p of offenders) console.error(`    ${p}`);
    return 1;
  }

  let fetched = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const resource of items) {
    const s = await localState(resource);
    if (s.state === "ok") {
      // 幂等的关键：命中即返回，连 HEAD 请求都不发。
      console.log(`  跳过  ${resource.id}（本地已匹配）`);
      skipped += 1;
      continue;
    }
    if (dryRun) {
      const size = resource.sizeBytes ? formatBytes(resource.sizeBytes) : "体积未测";
      console.log(`  将取  ${resource.id}  ${size}  -> ${resource.vendoredPath}`);
      continue;
    }
    try {
      process.stdout.write(`  下载  ${resource.id} … `);
      const size = await downloadOne(resource);
      bytes += size;
      fetched += 1;
      console.log(`${formatBytes(size)} ✓`);
    } catch (error) {
      failed += 1;
      console.log("失败");
      console.error(`        ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(
    `\n[resources] 新取 ${fetched} ／ 跳过 ${skipped} ／ 失败 ${failed}${fetched > 0 ? ` ｜ 新增 ${formatBytes(bytes)}` : ""}`,
  );
  if (failed > 0) {
    console.error(`[resources] 有资源未取到——**不要**忽略此结果，缺失会让断网构建在交付现场失败。`);
    return 1;
  }
  if (dryRun) return 0;
  return runVerify();
}

// 同 remote-resources.mjs：只有作为入口直接执行时才跑 CLI，
// 否则 import 本模块做单测/复用时会连带触发一次真实 CLI 执行。
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const command = process.argv[2] ?? "status";
  const rest = process.argv.slice(3);
  const runners = {
    status: () => runStatus({ withHash: true }),
    verify: runVerify,
    assert: runAssert,
    fetch: () => runFetch(rest),
  };
  const runner = runners[command];
  if (!runner) {
    console.error(`未知模式：${command}（可选：${Object.keys(runners).join(", ")}）`);
    process.exit(2);
  }
  process.exit(await runner());
}
