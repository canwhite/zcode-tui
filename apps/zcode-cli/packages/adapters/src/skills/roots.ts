import { stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { SkillRoot, SkillSource } from "@zcode/contracts";
import { CONFIG_HOME_DIR, getUserConfigHome, resolveUserHomeDir } from "../config-home/index.js";

const GIT_MARKER = ".git";
const HOME_PREFIX = "~/";
const PRIORITY_STEP = 10;
const SKILLS_DIR = "skills";
const CLAUDE_DIR = CONFIG_HOME_DIR;
const ZCODE_DIR = ".zcode";
const AGENTS_DIR = ".agents";

export interface SkillRootResolutionOptions {
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  extraRoots?: string[];
  extraResolvedRoots?: SkillRoot[];
  includeZcodeSkills?: boolean;
}

export async function resolveDefaultSkillRoots(
  workingDirectory: string,
  options: SkillRootResolutionOptions = {},
): Promise<SkillRoot[]> {
  const resolvedWorkingDirectory = resolve(workingDirectory);
  const roots: SkillRoot[] = [];
  const includeZcode = options.includeZcodeSkills ?? true;
  const env = options.env ?? process.env;
  // 用户级根走 `~/.claude`，必须经 getUserConfigHome 解析 ——
  // 它承载 ZCODE_CONFIG_HOME 覆盖；直接用 homeDirectory 拼 `.claude` 会让覆盖失效。
  // `homeDirectory` 仍作为显式参数保留，供测试直接指定家目录。
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
        resolveConfiguredRoot(extraRoot, resolvedWorkingDirectory, env),
        "project",
        "zcode",
        nextPriority(),
      ),
    );
  }

  if (includeZcode) {
    roots.push(...userSkillRoots(userConfigHome, nextPriority));
  }

  const projectDirectories = await resolveProjectSkillDirectories(resolvedWorkingDirectory);
  for (const directory of projectDirectories) {
    if (includeZcode) {
      roots.push(...projectSkillRoots(directory, nextPriority));
    }
  }

  roots.push(...(options.extraResolvedRoots ?? []));

  return roots;
}

async function resolveProjectSkillDirectories(workingDirectory: string): Promise<string[]> {
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
 * 用户级 skill 根。
 *
 * `configHome` 是**配置家目录本身**（`~/.claude`，可能被 `ZCODE_CONFIG_HOME` 覆盖），
 * 不是包含它的家目录 —— 这一点与项目级不同，务必区分。
 *
 * 不读 `~/.zcode/skills`：用户级配置面已统一到 `.claude`。
 */
function userSkillRoots(configHome: string, nextPriority: () => number): SkillRoot[] {
  return [
    root(join(configHome, SKILLS_DIR), "user", "claude", nextPriority()),
    // `.agents` 是 Claude/Codex/Cursor 的跨工具约定，属互操作面，保留为次优先。
    root(join(dirname(configHome), AGENTS_DIR, SKILLS_DIR), "user", "agents", nextPriority()),
  ];
}

/**
 * 项目级 skill 根。
 *
 * `baseDirectory` 是**仓库根目录**（`<repo>`），`.claude` / `.zcode` / `.agents`
 * 由本函数拼接。
 *
 * 与用户级**刻意不同**（勿合并成一份）：项目级 `<repo>/.zcode/skills` 是仓库内的
 * 工程配置，与「个人配置放哪」是不同问题，保持原样不动。
 */
function projectSkillRoots(baseDirectory: string, nextPriority: () => number): SkillRoot[] {
  return [
    root(join(baseDirectory, CLAUDE_DIR, SKILLS_DIR), "project", "claude", nextPriority()),
    root(join(baseDirectory, ZCODE_DIR, SKILLS_DIR), "project", "zcode", nextPriority()),
    root(join(baseDirectory, AGENTS_DIR, SKILLS_DIR), "project", "agents", nextPriority()),
  ];
}

function root(
  path: string,
  scope: SkillRoot["scope"],
  source: SkillSource,
  priority: number,
): SkillRoot {
  return {
    path: resolve(path),
    scope,
    source,
    priority,
  };
}

function resolveConfiguredRoot(
  path: string,
  workingDirectory: string,
  env: NodeJS.ProcessEnv,
): string {
  const expanded = path.startsWith(HOME_PREFIX)
    ? join(resolveUserHomeDir(env), path.slice(HOME_PREFIX.length))
    : path;
  return isAbsolute(expanded) ? expanded : resolve(workingDirectory, expanded);
}
