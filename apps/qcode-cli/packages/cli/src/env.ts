// Modified by ZCode: 抽出入口统一加载 .env 的实现（原先 prompt / protocol server 等各自加载）。
// 本分支全部改动的清单见 README.md「本分支的改动」。
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse, resolve } from "node:path";
import { config as loadDotenv } from "dotenv";
import {
  QCODE_RUNTIME_ENV_KEY,
  buildZCodeToolEnvPassthroughEnv,
  normalizeZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnv,
  sanitizeZCodeRuntimeEnvInPlace,
  type ZCodeRuntimeEnv,
} from "@qcode/shared/runtime-env";

export type CliEnv = Record<string, string | undefined>;

export type DotenvLoadResult = {
  error?: Error;
  keys: string[];
  loaded: boolean;
  path?: string;
};

export type LoadCliDotenvOptions = {
  cwd?: string;
  env?: CliEnv;
};

export function prepareCliRuntimeEnv(
  env: CliEnv = process.env,
  argv: readonly string[] = process.argv,
): CliEnv {
  const prepared = {
    ...sanitizeZCodeRuntimeEnv(env),
    ...buildZCodeToolEnvPassthroughEnv(env),
  };
  applyCliRuntimeEnvDefaults(prepared, argv);
  return prepared;
}

export function applyCliRuntimeEnvSanitization(
  env: CliEnv,
  argv: readonly string[] = process.argv,
): void {
  const toolEnvPassthrough = buildZCodeToolEnvPassthroughEnv(env);
  sanitizeZCodeRuntimeEnvInPlace(env);
  Object.assign(env, toolEnvPassthrough);
  applyCliRuntimeEnvDefaults(env, argv);
}

export const findDotenv = (startDir: string): string | undefined => {
  let current = resolve(startDir);
  const root = parse(current).root;

  while (true) {
    const candidate = resolve(current, ".env");
    // 用户可能把 .env 当作目录使用（如 ~/.env/modelscope）。
    // existsSync 只检查存在性，不区分文件/目录；必须显式检查 isFile避免 loadDotenv 报错。
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return candidate;
    }

    if (current === root) {
      return undefined;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

export const loadCliDotenv = (options: LoadCliDotenvOptions = {}): DotenvLoadResult => {
  const env = options.env ?? process.env;
  const dotenvPath = findDotenv(options.cwd ?? process.cwd());

  if (!dotenvPath) {
    return {
      keys: [],
      loaded: false,
    };
  }

  // The build used to inline .env values into dist. Loading at the CLI boundary
  // keeps secrets runtime-scoped and lets users rotate .env without rebuilding.
  const result = loadDotenv({
    override: false,
    path: dotenvPath,
    processEnv: env,
    quiet: true,
  });

  if (result.error) {
    return {
      error: result.error,
      keys: [],
      loaded: false,
      path: dotenvPath,
    };
  }

  return {
    keys: Object.keys(result.parsed ?? {}),
    loaded: true,
    path: dotenvPath,
  };
};

/**
 * 入口处统一加载 .env 的唯一实现。
 *
 * 背景：`.env` 原先只由 prompt / protocol server 等入口各自加载，
 * 而 TUI 主路径（tui-command.ts）直接用 process.env，导致「改 .env 就能用」在
 * 交互式入口上不成立——用户在项目根配了 base url 和 api key，敲 zcode 却读不到。
 *
 * 这里把加载收敛到单点，process.env 作为唯一的运行时环境载体，所有子命令共享
 * 同一份已加载结果。语义保持不变：向上查找最近 .env，且 override: false，
 * shell 环境变量优先于文件。
 */
/**
 * 入口统一加载后，命令层的 `deps.loadDotenv` 已被替换为幂等 no-op（见 run.ts 的
 * commandDeps）。命令层留存的 `loadDotenv` 调用因此不会二次读盘，
 * 其 `dotenvResult.error` 分支也不会再触发——入口失败时进程已在加载点退出。
 */
export function loadCliDotenvAtEntry(options: {
  cwd: string;
  env: CliEnv;
  loadDotenv?: (options?: LoadCliDotenvOptions) => DotenvLoadResult;
}): DotenvLoadResult {
  const dotenvResult = (options.loadDotenv ?? loadCliDotenv)({ cwd: options.cwd, env: options.env });
  // 与既有命令路径一致：加载后立刻清洗，避免用户 shell 注入的代理/证书变量泄漏给子进程。
  applyCliRuntimeEnvSanitization(options.env);
  return dotenvResult;
}

export function shouldLoadCliDotenvForProtocolServer(env: CliEnv): boolean {
  return resolveCliRuntimeEnv(env, process.argv) === "development";
}

function applyCliRuntimeEnvDefaults(env: CliEnv, argv: readonly string[]): void {
  env[QCODE_RUNTIME_ENV_KEY] = resolveCliRuntimeEnv(env, argv);
  applyBetaStorageDefault(env, argv);
}

function resolveCliRuntimeEnv(env: CliEnv, argv: readonly string[]): ZCodeRuntimeEnv {
  const explicit = normalizeZCodeRuntimeEnv(env[QCODE_RUNTIME_ENV_KEY]);
  if (explicit) {
    return explicit;
  }

  // CLI 运行时不再读取 NODE_ENV。源码 tsx 入口仍表示本地开发形态，
  // 但该判定来自入口路径，不来自用户 shell 里的 NODE_ENV。
  const entrypoint = (argv[1] ?? "").replace(/\\/g, "/");
  return entrypoint.endsWith(".ts") && entrypoint.includes("packages/cli/src")
    ? "development"
    : "production";
}

function applyBetaStorageDefault(env: CliEnv, argv: readonly string[]): void {
  if (env.QCODE_STORAGE_DIR?.trim()) return;
  const explicitBeta = env.QCODE_BETA === "1" || env.QCODE_ENV === "beta";
  const invokedAsBeta = argv.some((arg) => /(^|[/\\])qcode-beta(?:$|\.)/u.test(arg));
  if (!explicitBeta && !invokedAsBeta) return;
  env.QCODE_STORAGE_DIR = join(homedir(), ".qcode-beta");
}
