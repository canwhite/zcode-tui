import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { CustomCommandRoot, CustomCommandSource } from "@zcode/contracts";
import {
  CONFIG_HOME_DIR,
  getUserConfigHome,
  resolveUserHomeDir,
} from "../config-home/index.js";

const COMMANDS_DIR = "commands";
const CLAUDE_DIR = CONFIG_HOME_DIR;
const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const PRIORITY_STEP = 10;
const ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";

export interface CustomCommandRootResolutionOptions {
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  extraResolvedRoots?: CustomCommandRoot[];
  homeDirectory?: string;
  includeZcodeCommands?: boolean;
}

export async function resolveDefaultCustomCommandRoots(
  workingDirectory: string,
  options: CustomCommandRootResolutionOptions = {},
): Promise<CustomCommandRoot[]> {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const roots: CustomCommandRoot[] = [];
  const includeZcode = options.includeZcodeCommands ?? true;
  const env = options.env ?? process.env;
  // 用户级根走配置家目录，必须经 getUserConfigHome 解析（承载 ZCODE_CONFIG_HOME 覆盖）。
  // `homeDirectory` 仍作为显式参数保留，供测试直接指定家目录。
  const home = options.homeDirectory ?? resolveUserHomeDir(env);
  const userConfigHome = options.homeDirectory
    ? join(resolve(options.homeDirectory), CONFIG_HOME_DIR)
    : getUserConfigHome(env);
  let priority = 0;
  const nextPriority = () => {
    priority += PRIORITY_STEP;
    return priority;
  };

  for (const extraRoot of options.extraRoots ?? []) {
    roots.push(
      root(
        resolveConfiguredRoot(extraRoot, resolvedWorkingDirectory, home),
        "project",
        "zcode",
        nextPriority(),
      ),
    );
  }

  if (includeZcode) {
    roots.push(...userCommandRoots(userConfigHome, nextPriority));
  }

  const projectDirectories = await resolveProjectDirectories(resolvedWorkingDirectory);
  for (const directory of projectDirectories) {
    if (includeZcode) {
      roots.push(...projectCommandRoots(directory, nextPriority));
    }
  }

  roots.push(...(options.extraResolvedRoots ?? []));

  return roots;
}

async function resolveProjectDirectories(workingDirectory: string): Promise<string[]> {
  const worktreeRoot = await findWorktreeRoot(workingDirectory);
  if (!worktreeRoot) return [workingDirectory];

  const directories: string[] = [];
  let current = workingDirectory;
  while (true) {
    directories.push(current);
    if (current === worktreeRoot || current === dirname(current)) break;
    current = dirname(current);
  }
  return directories;
}

async function findWorktreeRoot(workingDirectory: string): Promise<string | null> {
  let current = workingDirectory;
  while (true) {
    if (await pathExists(join(current, GIT_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 用户级自定义命令根。
 *
 * `configHome` 是**配置家目录本身**（`~/.claude`，可被 `ZCODE_CONFIG_HOME` 覆盖），
 * 不是包含它的家目录 —— 与项目级不同，务必区分。
 *
 * 不读 `~/.zcode/commands`：用户级配置面已统一到 `.claude`。
 * 与 `skills/roots.ts` 的 `userSkillRoots` 保持**相同的形状与理由**，
 * 二者若不同步就会出现「skill 接轨了、命令没接轨」的分裂。
 */
function userCommandRoots(configHome: string, nextPriority: () => number): CustomCommandRoot[] {
  return [
    root(join(configHome, COMMANDS_DIR), "user", "claude", nextPriority()),
    root(join(dirname(configHome), AGENTS_DIR, COMMANDS_DIR), "user", "agents", nextPriority()),
  ];
}

/**
 * 项目级自定义命令根。
 *
 * `baseDirectory` 是**仓库根目录**（`<repo>`），各目录名由本函数拼接。
 * 与用户级**刻意不同**：项目级 `<repo>/.zcode/commands` 是仓库内的工程配置，
 * 与「个人配置放哪」是不同问题，保持原样不动。
 */
function projectCommandRoots(baseDirectory: string, nextPriority: () => number): CustomCommandRoot[] {
  return [
    root(join(baseDirectory, CLAUDE_DIR, COMMANDS_DIR), "project", "claude", nextPriority()),
    root(join(baseDirectory, ZCODE_DIR, COMMANDS_DIR), "project", "zcode", nextPriority()),
    root(join(baseDirectory, AGENTS_DIR, COMMANDS_DIR), "project", "agents", nextPriority()),
  ];
}

function root(
  path: string,
  scope: CustomCommandRoot["scope"],
  source: CustomCommandSource,
  priority: number,
): CustomCommandRoot {
  return {
    path: resolve(path),
    scope,
    source,
    priority,
  };
}

function resolveConfiguredRoot(path: string, workingDirectory: string, home: string): string {
  const expanded = path.startsWith(HOME_PREFIX) ? join(home, path.slice(HOME_PREFIX.length)) : path;
  return isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
}
