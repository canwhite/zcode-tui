#!/usr/bin/env node
// 把构建产物暴露成终端里可直接输入的 `zcode`。
//
// 取舍：用软链接而不是 `pnpm link --global`。
//   - @zcode/cli 是 workspace 成员（private），全局链接会把整棵 workspace 依赖带进全局；
//   - 软链接保留 argv[1] 的解析结果，进程名与 doctor 的“命令可达”判定都能对上。
// 代价是 dist 被删后链接变悬空——这由 make clean 一并清理，属于已知且可控的形态。

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot } from "./toolchain.mjs";

export const cliEntry = join(
  repoRoot,
  "apps",
  "zcode-cli",
  "packages",
  "cli",
  "dist",
  "qcode.cjs",
);

const launcherName = "qcode";

/** 回落到用户级目录：不依赖 sudo，也不受 pnpm 全局目录配置影响。 */
function fallbackBinDir() {
  const localBin = join(homedir(), ".local", "bin");
  return localBin;
}

/**
 * 选择安装目标目录。优先 pnpm 的全局 bin，但它可能未配置、不可写或根本不存在，
 * 任一情况都回落到 ~/.local/bin，而不是让安装失败。
 */
export function resolveBinDir({ verifyWritable = true } = {}) {
  try {
    const output = execFileSync("pnpm", ["bin", "-g"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (output && existsSync(output) && (!verifyWritable || canWrite(output))) {
      return { dir: output, source: "pnpm" };
    }
  } catch {
    // pnpm 缺失、未配置或该子命令报错都走回落路径。
  }
  return { dir: fallbackBinDir(), source: "fallback" };
}

function canWrite(dir) {
  try {
    // 目标不存在时先建出来；建不出来就说明不可用。
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export const isOnPath = (dir, env = process.env) =>
  (env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((candidate) => candidate === dir);

/** 写入 shell 配置的行都带这个标记，便于识别来源与安全撤销。 */
export const SHELL_PATH_MARKER = "# zcode: added by `make install`";

/**
 * 按登录 shell 选择要写入的配置文件。
 *
 * 只选一个文件，不把同一行同时写进 .zshrc / .zprofile / .zshenv：
 * 多处写入会产生重复 PATH 项，且撤销时要逐个找回来。
 */
export function resolveShellProfile(env = process.env, homeDir = homedir()) {
  const shell = env.SHELL?.trim() ?? "";
  if (shell.endsWith("/zsh")) {
    return { path: join(homeDir, ".zshrc"), shell: "zsh" };
  }
  if (shell.endsWith("/bash")) {
    return { path: join(homeDir, ".bashrc"), shell: "bash" };
  }
  // 识别不出 shell 时不猜——写错文件比不写更糟，交给调用方降级为打印指引。
  return undefined;
}

/**
 * 判断 shell 配置里是否已经有「把 dir 加入 PATH」的有效行。
 *
 * 识别两种等价写法：
 *   1. 我们写的字面形式 export PATH="<dir>:$PATH"
 *   2. 用户自己写的、带 $HOME 变量或引号变体的 PATH 前置写法
 * 第 2 种是关键：只比字面量会让 $HOME/.local/bin 被判定为“没有”，从而重复追加。
 */
export function profileAddsDirToPath(content, dir) {
  const homeDir = homedir();
  // 把 $HOME / ${HOME} / ~ 统一换成实际家目录，使两种写法可比较。
  // 注意不能靠「排除 $ 字符」来切分：$HOME/.local/bin 里就含 $，
  // 那样会在变量名处截断，把用户已有的行误判成不存在。
  const expandHome = (value) =>
    value.replace(/\$\{HOME\}/g, homeDir).replace(/\$HOME/g, homeDir).replace(/^~/, homeDir);
  const target = expandHome(dir);

  return content.split(/\r?\n/).some((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) return false;
    const match = line.match(/^export\s+PATH\s*=\s*(.*)$/);
    if (!match) return false;
    // 去掉外层引号
    const value = match[1].trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    // 只认「把 dir 前置」的写法：dir 后面紧跟 : 或直接接 $PATH 等变量引用。
    const head = expandHome(value).split(":")[0];
    return head === target && value.includes("$PATH");
  });
}

/**
 * 把 bin 目录写进用户的 shell 配置，使其在后续终端里生效。
 *
 * 幂等：已存在同一行（或已能从该文件生效）时不重复追加。
 * 可逆：写入行带 SHELL_PATH_MARKER 注释，撤销时按标记删除即可。
 *
 * @returns {{status: "already"|"added"|"skipped", path?: string, reason?: string}}
 */
export function ensureShellPath(dir, log = console.log, env = process.env) {
  const profile = resolveShellProfile(env);
  if (!profile) {
    log(`[expose] 无法识别登录 shell（SHELL=${env.SHELL ?? "<空>"}），未自动写入 PATH。`);
    log(`[expose] 请手动把下面一行加入你的 shell 配置：`);
    log(`[expose]   export PATH="${dir}:$PATH"`);
    return { status: "skipped", reason: "unknown-shell" };
  }

  const exportLine = `export PATH="${dir}:$PATH"`;
  let content = "";
  try {
    content = readFileSync(profile.path, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      log(`[expose] 读取 ${profile.path} 失败，未写入。请手动添加：`);
      log(`[expose]   ${exportLine}`);
      return { status: "skipped", path: profile.path, reason: "read-failed" };
    }
    // 文件不存在：下面直接创建，属于正常情况（例如尚未用过 bash）。
  }

  // 不能只比字符串：同样的目录既可能写成 $HOME/.local/bin，也可能写成展开后的
  // 绝对路径，两者文本不同但效果完全一样。这里按“是否已经把该目录加进 PATH”
  // 判定，否则用户已有的那一行会被我们重复追加一遍。
  if (profileAddsDirToPath(content, dir, env)) {
    log(`[expose] ${profile.path} 已经添加过该 PATH 项，跳过写入`);
    return { status: "already", path: profile.path };
  }

  const separator = content === "" || content.endsWith("\n") ? "" : "\n";
  writeFileSync(
    profile.path,
    `${content}${separator}\n${SHELL_PATH_MARKER}\n${exportLine}\n`,
    "utf8",
  );
  log(`[expose] 已把 ${dir} 加入 ${profile.path}`);
  log(`[expose] 新开一个终端即可使用 zcode；撤销：删除该文件中 "${SHELL_PATH_MARKER}" 及其下一行`);
  return { status: "added", path: profile.path };
}

/**
 * 幂等安装启动器：重复执行覆盖既有链接，不产生重复条目。
 * @returns {{target: string, binDir: string, source: string, onPath: boolean}}
 */
export function exposeCli(log = console.log, env = process.env) {
  if (!existsSync(cliEntry)) {
    throw new Error(`未找到构建产物：${cliEntry}。请先执行构建。`);
  }
  chmodSync(cliEntry, 0o755);

  const { dir, source } = resolveBinDir();
  mkdirSync(dir, { recursive: true });
  const target = join(dir, launcherName);

  // 已存在同名文件时先移除：symlinkSync 不会覆盖，rmSync 对普通文件与软链都适用。
  try {
    lstatSync(target);
    rmSync(target, { force: true });
  } catch {
    // 不存在即目标状态。
  }

  symlinkSync(cliEntry, target);
  log(`[expose] ${target} -> ${cliEntry}`);

  const onPath = isOnPath(dir, env);
  let shellPath;
  if (onPath) {
    log(`[expose] ${dir} 已在 PATH 中`);
  } else {
    // 当前进程的 PATH 通常来自启动它的 shell，不含刚写入的新目录；
    // 因此这里写入 shell 配置，让下一个终端生效。
    shellPath = ensureShellPath(dir, log, env);
  }
  if (source === "fallback") {
    log("[expose] 未能使用 pnpm 全局 bin 目录，已回落到用户级目录");
  }

  return { target, binDir: dir, source, onPath, shellPath };
}

/** 移除启动器；make clean 与卸载场景使用。 */
export function removeCliLauncher(log = console.log) {
  const { dir } = resolveBinDir();
  const target = join(dir, launcherName);
  try {
    const stat = lstatSync(target);
    if (!stat.isSymbolicLink()) {
      log(`[clean] ${target} 不是本仓库创建的软链接，已跳过`);
      return false;
    }
    rmSync(target, { force: true });
    log(`[clean] 已移除 ${target}`);
    return true;
  } catch {
    return false;
  }
}
