#!/usr/bin/env node

// 精简分支：本仓库只保留 CLI/TUI 及其依赖闭包。
//
// 相对上游的 bootstrap，这里移除了三类步骤，它们都随对应包一起被剔除：
//   1. git submodule update --init --recursive apps/qcode-cli
//      —— apps/qcode-cli 是普通目录（见 README），该行是从 submodule 时代遗留的死代码；
//         在空 index 的仓库里它会以 `pathspec did not match` 直接中断整个 bootstrap。
//   2. prepare:desktop-runtime —— @zcode/desktop 已被移除。
//   3. --with-remote 分支及其 server / desktop / 远程资源构建 —— 对应包已被移除。
//
// 结果是安装路径不再触发 electron 等桌面端依赖。

import process from "node:process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCommand } from "./spawn-command.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(scriptDir, "..");

function runPnpm(args) {
  runCommand(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: rootDir,
    env: process.env,
  });
}

runPnpm(["install"]);
runPnpm(["run", "build:bootstrap"]);
