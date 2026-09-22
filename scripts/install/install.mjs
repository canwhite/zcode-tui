#!/usr/bin/env node
// 安装编排：make install / prune / clean / doctor 的统一实现。
//
// 全部逻辑放在 Node 脚本里、Makefile 只做转发，理由有二：
//   1. 与仓库既有约定一致（scripts/*.mjs + scripts/spawn-command.mjs）；
//   2. 避免把判定逻辑写进 make 的 shell 方言，Windows 之外也好复用。

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "../spawn-command.mjs";
import { inspectToolchain, reportToolchain, repoRoot } from "./toolchain.mjs";
import { ensureEnvFile, parseEnvEntries, envPath } from "./env-config.mjs";
import { cliEntry, exposeCli, isOnPath, removeCliLauncher, resolveBinDir } from "./expose.mjs";

const mode = process.argv[2] ?? "install";

function runPnpm(args) {
  runCommand(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: repoRoot,
    env: process.env,
  });
}

/** 从项目根 .env 读取编码套餐 Key（不打印值）。 */
function readCodingPlanKey() {
  if (!existsSync(envPath)) return undefined;
  const entry = parseEnvEntries(readFileSync(envPath, "utf8")).find(
    (candidate) => candidate.key === "BIGMODEL_API_KEY",
  );
  return entry?.value ? entry.value : undefined;
}

/**
 * 跑 zcode 自检。复用 CLI 自身的 doctor，而不是在这里重写一套判定标准。
 *
 * spawn-command 的 runCommand 在非零退出时抛异常，因此这里必须显式捕获——
 * 自检失败是把退出码透传出去，不是让安装脚本崩栈。
 * @returns {number} 退出码
 */
function runSelfCheck({ env = process.env, label = "self-check" } = {}) {
  if (!existsSync(cliEntry)) {
    console.error(`[${label}] 缺少构建产物：${cliEntry}`);
    return 1;
  }
  try {
    runCommand(process.execPath, [cliEntry, "doctor"], { cwd: repoRoot, env });
    return 0;
  } catch (error) {
    console.error(`[${label}] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function install() {
  const log = console.log;
  log("== 1/5 环境前置 ==");
  const inspection = inspectToolchain(process.env);
  if (!reportToolchain(inspection, log)) {
    log("[install] 环境前置未通过，已停止。补齐上面的项后重试。");
    return 1;
  }

  log("\n== 2/5 安装依赖与构建 ==");
  // bootstrap 已封装 pnpm install + build:bootstrap，直接复用，不重复写构建顺序。
  runPnpm(["run", "bootstrap"]);

  log("\n== 3/5 全局暴露 ==");
  const exposed = exposeCli(log);

  log("\n== 4/5 配置 ==");
  ensureEnvFile(log);

  const apiKey = readCodingPlanKey();
  if (!apiKey) {
    log("[configure] .env 中未填写 BIGMODEL_API_KEY，跳过模型预置。");
    log("[configure] 填好后重新执行 make install，或在 TUI 设置里填入 Key。");
  } else {
    try {
      runCommand(process.execPath, [cliEntry, "configure", "--provider", "bigmodel"], {
        cwd: repoRoot,
        env: process.env,
      });
    } catch (error) {
      log(`[configure] 凭据写入失败：${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  log("\n== 5/5 自检 ==");
  // 刚建好的 bin 目录还不在当前进程的 PATH 里；先补上再自检，
  // 否则会把“新装好但本终端未重载”误报成失败。是否已在用户 shell 生效仍单独提示。
  const selfCheckEnv = { ...process.env };
  if (!exposed.onPath) {
    selfCheckEnv.PATH = `${exposed.binDir}:${process.env.PATH ?? ""}`;
  }
  const exitCode = runSelfCheck({ env: selfCheckEnv });

  if (exitCode === 0) {
    // 明确区分「本进程已可用」与「你的终端里已可用」：写入 shell 配置的改动只在
    // 新开的终端生效，不能让用户以为当前窗口就能直接用。
    switch (exposed.shellPath?.status) {
      case "added":
        log(`\n[install] 完成。${exposed.shellPath.path} 已更新，新开一个终端后输入 zcode 即可使用。`);
        break;
      case "already":
        log("\n[install] 完成。在终端输入 zcode 即可使用。");
        break;
      default:
        log("\n[install] 完成。按上面的指引把 PATH 加好之后，在终端输入 zcode 即可使用。");
        break;
    }
  } else {
    log("\n[install] 自检未通过，详见上面的 self-check 输出。");
  }
  return exitCode;
}

/**
 * 裁剪白名单：只含确认「运行 zcode 不需要、也不是后续构建所需」的包。
 *
 * 为什么不用 `pnpm install --prod`：那会一并移除 esbuild / typescript 等构建与
 * 类型检查依赖，使后续 `make install` 与 `pnpm typecheck` 直接失败——裁剪的收益
 * 换来的是仓库不可再构建，不划算。白名单方式可逆、影响面明确。
 * 判定口径若要放宽（例如连构建依赖一起裁），需要先确认这一点。
 */
const PRUNE_TARGETS = [
  "@withfig/autocomplete", // shell 补全素材，仅发布流程使用
  "esbuild", // 构建期打包器；裁剪后无法再构建，仅在确认不再构建时使用
  "knip", // 未使用依赖检查
  "oxlint", // lint
  "postject", // SEA 打包注入
  "release-it", // 发布
];

function prune() {
  const log = console.log;
  log("== 裁剪冗余依赖 ==");
  log(`[prune] 目标：${PRUNE_TARGETS.join(", ")}`);
  // 直接移除顶层包目录：node-linker=hoisted（见 .npmrc），运行期解析的是顶层目录。
  // 不碰 pnpm-lock.yaml，下次 make install 即可原样恢复。
  let removed = 0;
  for (const name of PRUNE_TARGETS) {
    const target = join(repoRoot, "node_modules", name);
    if (!existsSync(target)) continue;
    rmSync(target, { force: true, recursive: true });
    log(`[prune] 已移除 ${name}`);
    removed += 1;
  }
  log(`[prune] 共移除 ${removed} 项`);

  log("\n== 裁剪后复检 ==");
  const exitCode = runSelfCheck({ label: "prune" });
  if (exitCode !== 0) {
    log("[prune] 裁剪后自检失败，说明裁掉了运行期依赖。恢复：make install");
  }
  return exitCode;
}

function clean() {
  const log = console.log;
  log("== 清空工作区 ==");
  removeCliLauncher(log);
  // 复用既有脚本：它只删 node_modules 与 dist，不触碰源码与 git 状态。
  runPnpm(["run", "clean"]);
  log("[clean] 已清空构建产物与依赖；重新安装：make install");
  return 0;
}

function doctor() {
  const { dir } = resolveBinDir();
  const env = isOnPath(dir, process.env)
    ? process.env
    : { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` };
  return runSelfCheck({ env });
}

const runners = { install, prune, clean, doctor };
const runner = runners[mode];
if (!runner) {
  console.error(`未知模式：${mode}（可选：${Object.keys(runners).join(", ")}）`);
  process.exit(2);
}

try {
  process.exit(runner());
} catch (error) {
  console.error(`[${mode}] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
