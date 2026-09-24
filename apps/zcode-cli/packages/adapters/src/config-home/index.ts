// ============================================================
// Config Home Resolution
// ============================================================
//
// 用户级**配置面**（skill / 指令 / 自定义命令）的落点解析。
//
// 与 `bootstrap/src/app/paths.ts` 的 `getCliStorageRoot` 刻意并列而非替代：
// 后者指向 `~/.zcode` 下的**运行时数据树**（session db / 凭据 / provider 配置 /
// 日志 / rollout / memories），本模块指向 `~/.claude` 下的**配置面**。
// 两者正交，互不派生 —— 把配置面切到 `.claude` 不应搬动任何运行时数据。

import { mkdir, stat, writeFile } from "node:fs/promises";
import {
  CONFIG_HOME_BOOTSTRAP_OPT_OUT_ENV_KEYS,
  CONFIG_HOME_ENV_KEYS,
  readRenamedEnv,
} from "@zcode/shared";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** 用户级配置家目录的目录名。与 Claude Code 一致。 */
export const CONFIG_HOME_DIR = ".claude";

/** 用户级指令文件名。 */
export const CONFIG_HOME_INSTRUCTION_FILE = "CLAUDE.md";

/** 用户级 skill 目录名。 */
export const CONFIG_HOME_SKILLS_DIR = "skills";

/** 用户级自定义命令目录名。 */
export const CONFIG_HOME_COMMANDS_DIR = "commands";

/**
 * 解析用户家目录。
 *
 * 优先取环境变量（`HOME` / `USERPROFILE`），失败再回落到 `homedir()`。
 * 测试可通过 env 注入，避免触碰真实家目录。
 */
export function resolveUserHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  const envHome = env.HOME?.trim() || env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/**
 * 用户级配置家目录（`~/.claude`）的绝对路径。
 *
 * 只解析路径，**不创建目录**。需要自举时显式调用 {@link ensureUserConfigHome}。
 *
 * `QCODE_CONFIG_HOME` 可覆盖落点（兼容旧名 `ZCODE_CONFIG_HOME`）—— 与既有的
 * `QCODE_STORAGE_DIR` 同一惯例，供测试与隔离环境使用。
 *
 * 注意 `.env.example` 里宣传的就是 `QCODE_` 这个名；只读旧名会让照抄模板的用户
 * 设了一个不生效的键。
 */
export function getUserConfigHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = readRenamedEnv(env, CONFIG_HOME_ENV_KEYS);
  if (override) {
    return resolve(override);
  }
  return join(resolveUserHomeDir(env), CONFIG_HOME_DIR);
}

/** 路径是否已存在（含文件与目录）。 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** 用户级配置家目录当前是否可用。 */
export async function isUserConfigHomeAvailable(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  return await pathExists(getUserConfigHome(env));
}

/**
 * 关闭自举的开关。设成 `1` / `true` 即只读不写。
 *
 * 取值来自共享键表（`.env.example` 宣传的那个名）；读取时兼容旧名。
 */
export const CONFIG_HOME_BOOTSTRAP_OPT_OUT_ENV = CONFIG_HOME_BOOTSTRAP_OPT_OUT_ENV_KEYS.current;

export interface ConfigHomeBootstrapOutcome {
  /** 家目录绝对路径。 */
  path: string;
  /** 本次是否真的创建了目录。 */
  created: boolean;
  /**
   * 自举失败原因。**自举失败绝不抛错** —— 调用方应降级为「无用户级配置」并告警，
   * 一个锦上添花的自举能力不应拖挂主流程。
   */
  error?: string;
}

/** 首次自举时写入的说明文件，放在配置家目录根下。 */
const README_FILE = "README.md";

const README_CONTENT = `# ZCode 个人配置

这个目录由 ZCode 首次运行时创建。放在这里的配置对**所有项目**生效。

## 个人 skill

    skills/<skill-name>/SKILL.md

每个 skill 一个目录，入口必须是 \`SKILL.md\`。ZCode 启动时扫描本目录，
并把每个 skill 作为**一级斜杠命令**暴露 —— 输入 \`/<skill-name>\` 即可，无需前缀。

## 全局指令

    CLAUDE.md

会作为全局 system prompt 的一部分加载。项目内的 \`CLAUDE.md\` / \`AGENTS.md\`
优先级更高，可覆盖这里的通用约定。

## 个人命令

    commands/<command-name>.md

与 skill 的区别：命令是**固定提示词模板**，skill 是**按需加载的能力单元**。

## 说明

- 本项目**不会**修改你已有的配置，也不会往里写除本文件之外的内容。
- 设 \`ZCODE_NO_CONFIG_HOME_BOOTSTRAP=1\` 可关闭本目录的自动创建。
`;

/**
 * 确保用户级配置家目录存在；不存在时创建一个**最小可用**的目录。
 *
 * 与「静默 no-op」的取舍：目录缺失时用户没有任何线索知道该往哪放配置。
 * 这里只留**一个说明文件**作为路标，而不是装一整套外部工具。
 *
 * 语义约定（勿改）：
 * - **幂等**：绝不覆盖用户内容。目录已存在时**只**补写缺失的说明文件（见下），
 *   不触碰其它任何文件。
 * - **补写说明文件**：早先的实现是「目录存在就整体跳过」。那会让一次
 *   「目录建成了、说明文件写失败」（磁盘满、权限、进程被杀）的**部分成功**永久化 ——
 *   此后每次启动都因「目录已存在」而跳过，用户永远得不到那份路标，
 *   而这正是自举本来要解决的问题。现在改为：目录在、说明文件不在 → 补写。
 *   注意这**不会**与「用户主动删掉说明文件」冲突：补写是幂等的，
 *   删了会被下次启动补回；用户不想要它，请用下面的关闭开关。
 * - **不预置空目录**：刻意不创建空的 `skills/` / `commands/`。空目录会让
 *   下次启动误判为「用户已有配置」，从而静默遮蔽真实状态
 *   （见 Pre-Mortem「自举出的空 ~/.claude 静默遮蔽全部配置来源」）。
 * - **绝不抛错**：失败降级为 `error`，调用方告警即可，不阻断启动。
 * - **可关闭**：`ZCODE_NO_CONFIG_HOME_BOOTSTRAP=1` 时只读不写。
 */
export async function ensureUserConfigHome(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigHomeBootstrapOutcome> {
  const path = getUserConfigHome(env);
  const readmePath = join(path, README_FILE);
  const dirExists = await pathExists(path);

  if (isBootstrapOptedOut(env)) {
    return { path, created: false };
  }
  // 目录已在、说明文件也在 —— 无事可做，也绝不覆盖用户改动。
  if (dirExists && (await pathExists(readmePath))) {
    return { path, created: false };
  }

  try {
    if (!dirExists) await mkdir(path, { recursive: true });
    await writeFile(readmePath, README_CONTENT, "utf8");
    return { path, created: !dirExists };
  } catch (error) {
    // 竞态：另一进程刚创建。视为已存在，不算失败。
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      return { path, created: false };
    }
    return {
      path,
      created: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isBootstrapOptedOut(env: NodeJS.ProcessEnv): boolean {
  const value = readRenamedEnv(env, CONFIG_HOME_BOOTSTRAP_OPT_OUT_ENV_KEYS)?.toLowerCase();
  return value === "1" || value === "true";
}
