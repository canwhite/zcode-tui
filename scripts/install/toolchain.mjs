#!/usr/bin/env node
// 工具链前置检查：安装链路的唯一判据来源。
//
// 设计要点：
//   - 期望版本从仓库的既有声明读取（.nvmrc / apps/zcode-cli/.node-version /
//     pnpm-workspace 的 packageManager），不在此处硬编码，避免第二份真相。
//   - 缺失命令一次性收集后统一报告，而不是遇到第一个就中断（F-008）。

import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(scriptDir, "..", "..");

/** 安装链路自身依赖的外部命令。 */
export const REQUIRED_COMMANDS = ["git", "make"];

function firstOnPath(command, pathValue) {
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export const which = (command, env = process.env) => firstOnPath(command, env.PATH);

/**
 * 解析 package.json 的 engines.node 约束，取出可见的版本下限 [major, minor, patch]。
 *
 * 契约（与 CLI 侧 `apps/zcode-cli/packages/cli/src/doctor.ts` 的 parseNodeFloor 必须一致）：
 *   - 本仓库只声明 ">=X.Y.Z"，解析为三元组做逐段比较；
 *   - 出现其它形式时退化为「只取首个版本号，minor/patch 记 0」，不把用户挡在门外；
 *   - 完全没有版本号时返回 undefined，由调用方降级为「不校验」。
 *
 * 只比 major 是不够的：`>=22.13.0` 的下限落在 minor 上，
 * 按 major 比较会把 22.0.0（node:sqlite 仍需 flag）误判为满足。
 */
function parseNodeFloor(pkg) {
  const raw = pkg?.engines?.node;
  if (typeof raw !== "string") return undefined;
  const full = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (full) return [Number(full[1]), Number(full[2]), Number(full[3])];
  const major = raw.match(/(\d+)/);
  return major ? [Number(major[1]), 0, 0] : undefined;
}

/** [major, minor, patch] 逐段比较，返回 actual 是否不低于 floor。 */
function nodeMeetsFloor(actualVersion, [floorMajor, floorMinor, floorPatch]) {
  const [major = 0, minor = 0, patch = 0] = actualVersion.split(".").map(Number);
  if (major !== floorMajor) return major > floorMajor;
  if (minor !== floorMinor) return minor > floorMinor;
  return patch >= floorPatch;
}

export function readToolchainSpec() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  const nodeVersionFile = join(repoRoot, "apps", "zcode-cli", ".node-version");
  let nodePin;
  if (existsSync(nodeVersionFile)) {
    nodePin = readFileSync(nodeVersionFile, "utf8").trim();
  }
  return {
    nodePin: nodePin || undefined,
    nodeFloor: parseNodeFloor(pkg),
    nodeEngines: typeof pkg?.engines?.node === "string" ? pkg.engines.node : undefined,
    pnpm: typeof pkg?.packageManager === "string" ? pkg.packageManager.replace(/^pnpm@/, "") : undefined,
  };
}

/**
 * 收集工具链体检结果。不抛异常——调用方决定把哪一档当作致命错误。
 * @returns {{spec: object, node: object, pnpm: object, missingCommands: string[]}}
 */
export function inspectToolchain(env = process.env) {
  const spec = readToolchainSpec();
  const actualNode = process.versions.node;
  const nodeOk = spec.nodeFloor === undefined || nodeMeetsFloor(actualNode, spec.nodeFloor);

  const pnpmPath = which("pnpm", env);
  const nodeMismatch = !nodeOk;

  return {
    spec,
    node: {
      actual: actualNode,
      expected: spec.nodeEngines ?? `>=${spec.nodeFloor?.join(".") ?? "?"}`,
      ok: nodeOk,
    },
    pnpm: {
      path: pnpmPath,
      expected: spec.pnpm,
      // 只校验能否找到；版本由 pnpm 自身在 workspace 内按 packageManager 约束执行。
      ok: pnpmPath !== undefined,
    },
    missingCommands: REQUIRED_COMMANDS.filter((command) => which(command, env) === undefined),
    nodeMismatch,
  };
}

/** 供 make install 使用的可读报告；返回是否有致命问题。 */
export function reportToolchain(inspection, log = console.log) {
  const { spec, node, pnpm, missingCommands } = inspection;
  let fatal = false;

  if (node.ok) {
    log(`[toolchain] node ${node.actual} 满足 ${node.expected}`);
  } else {
    fatal = true;
    log(`[toolchain] node 版本不满足：当前 ${node.actual}，仓库要求 ${node.expected}`);
    if (spec.nodePin) {
      log(`[toolchain] 仓库 pin 为 ${spec.nodePin}，补装后重试：mise install  或  nvm install`);
    }
  }

  if (pnpm.ok) {
    log(`[toolchain] pnpm ${spec.pnpm ?? "(未声明版本)"} @ ${pnpm.path}`);
  } else {
    fatal = true;
    log(`[toolchain] 找不到 pnpm；补装：corepack enable 或 npm i -g pnpm@${spec.pnpm ?? "latest"}`);
  }

  if (missingCommands.length > 0) {
    fatal = true;
    log(`[toolchain] 缺失必需命令：${missingCommands.join(", ")}`);
  } else {
    log(`[toolchain] 必需命令齐备：${REQUIRED_COMMANDS.join(", ")}`);
  }

  return !fatal;
}
