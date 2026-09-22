import { dirname } from "node:path";
import { extractDisallowedToolsArgs, parseGlobalArgs } from "./arguments.js";
import { createNodeLoggerFactory } from "@zcode/adapters";
import { getRuntimeInfo, type PresentationSurface } from "@zcode/core";
import { color, formatJson, supportsColor } from "@zcode/core";
import { getZCodeCopy, isUiLocale, type UiLocale } from "@zcode/i18n";
import type { RunContext, GlobalOptions, GlobalOutputFormat } from "@zcode/shared-types";
import {
  applyCliRuntimeEnvSanitization,
  loadCliDotenv,
  loadCliDotenvAtEntry,
  prepareCliRuntimeEnv,
  shouldLoadCliDotenvForProtocolServer,
  type CliEnv,
} from "./env.js";
import {
  collectDoctorReport,
  findRepoRoot,
  toJsonChecks,
  type DoctorReport,
} from "./doctor.js";
import { formatCliHelp } from "./help.js";
import { runHooksCommand } from "./hooks-trust-command.js";
import { detectCliLocale } from "./locale.js";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import { runEmbeddedSearchCli } from "./internal-search/embedded-search-cli.js";
import { runCommandsCommand } from "./commands-command.js";
import { resolveCliCwd } from "./cwd.js";
import { runLoginCommand, runLogoutCommand } from "./login-command.js";
import { CLI_COMMAND_NAME, CLI_PROCESS_NAME } from "./process-name.js";
import { isPluginHostInvocation, runPluginHostCommand } from "./plugin-host-command.js";
import { isDwfChildInvocation, runDwfChildCommand } from "./dwf-child-command.js";
import { runPrompt } from "./prompt-command.js";
import { runPluginsCommand, type PluginsCommandFlags } from "./plugins-command.js";
import { runSkillsCommand } from "./skills-command.js";
import { runTuiCommand } from "./tui-command.js";
import type {
  CliPermissionMode,
  CliResumeRequest,
  CliTargetRequest,
  RunDependencies,
} from "./cli-types.js";

export type { RunDependencies } from "./cli-types.js";

declare const __CLI_VERSION__: string | undefined;

const version = typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0";

const EMPTY_TARGET_ERROR = "--target requires non-empty text.";
const DEFAULT_HEADLESS_PROMPT_MODE: CliPermissionMode = "yolo";
const FORCE_MCS_SCOPE_ERROR = "--force-mcs can only be used with --prompt, --target, or tui.";
const TARGET_REPLACE_REQUIRES_TARGET_ERROR = "--target-replace requires --target.";
const TARGET_CONFLICTS_WITH_PROMPT_ERROR =
  '--target cannot be used with --prompt. Use either --target <objective> or --prompt "/goal <objective>".';
const BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR =
  "--browser-executable requires --browser-use=headless.";
const BROWSER_USE_SCOPE_ERROR =
  "--browser-use=headless can only be used with --prompt, --target, or tui.";
const SURFACE_SCOPE_ERROR =
  "--surface can only be used with --prompt, --target, app-server, or agent-server.";
const MEMORY_BENCH_SCOPE_ERROR = "--memory-bench can only be used with -p/--prompt.";

const pluginsCommandFlags = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): PluginsCommandFlags => ({
  ...(values.all === true ? { all: true } : {}),
  ...(values.available === true ? { available: true } : {}),
  ...(values["keep-data"] === true ? { keepData: true } : {}),
  ...(typeof values.scope === "string" ? { scope: values.scope } : {}),
  ...(Array.isArray(values.sparse) ? { sparse: values.sparse as string[] } : {}),
});

const commandName = (positionals: string[]): string => positionals[0] ?? "tui";

const isForceMcsSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean =>
  typeof input.prompt === "string" ||
  input.targetRequest !== undefined ||
  commandName(input.positionals) === "tui";

const isPresentationSurfaceSupportedInvocation = (input: {
  positionals: string[];
  prompt?: string;
  targetRequest?: CliTargetRequest;
}): boolean => {
  const command = commandName(input.positionals);
  return (
    typeof input.prompt === "string" ||
    input.targetRequest !== undefined ||
    command === "app-server" ||
    command === "agent-server"
  );
};

const globalOptions = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
  locale: UiLocale | undefined,
  detectedLocale: GlobalOptions["detectedLocale"],
  browserUse: GlobalOptions["browserUse"],
  browserExecutable: GlobalOptions["browserExecutable"],
  outputFormat: GlobalOptions["outputFormat"],
): GlobalOptions => {
  return {
    browserExecutable,
    browserUse,
    ...(typeof values["api-key"] === "string" ? { configureApiKey: values["api-key"] } : {}),
    ...(typeof values.provider === "string" ? { configureProvider: values.provider } : {}),
    detectedLocale,
    force: values.force === true,
    json: values.json === true,
    locale,
    ...(values["memory-bench"] === true ? { memoryBench: true } : {}),
    noColor: values["no-color"] === true,
    ...(outputFormat ? { outputFormat } : {}),
    verbose: values.verbose === true,
  };
};

const OUTPUT_FORMATS: readonly GlobalOutputFormat[] = ["text", "json", "stream-json"];

/**
 * Validate --output-format. Rejecting an unknown value matters more than it
 * looks: a caller that misspells it would otherwise get plain text back and
 * silently parse nothing.
 */
const normalizeOutputFormat = (value: string | undefined): GlobalOutputFormat | undefined => {
  if (value === undefined) return undefined;
  if ((OUTPUT_FORMATS as readonly string[]).includes(value)) return value as GlobalOutputFormat;
  throw new Error(
    `--output-format must be one of ${OUTPUT_FORMATS.join(", ")} (received: ${value}).`,
  );
};

const normalizeLocaleOption = (value: string | undefined): UiLocale | undefined => {
  if (value === undefined) return undefined;
  if (isUiLocale(value)) return value;
  throw new Error(getZCodeCopy().cli.errors.localeUnsupported(value));
};

const normalizePromptMode = (value: string | undefined): CliPermissionMode | undefined => {
  if (value === undefined) return undefined;
  const mode = value.toLowerCase();
  if (mode === "build" || mode === "plan" || mode === "edit" || mode === "yolo") return mode;
  throw new Error(`Unsupported --mode value: ${value}. Supported modes: build, edit, plan, yolo.`);
};

const normalizeBrowserUse = (value: string | undefined): GlobalOptions["browserUse"] => {
  if (value === undefined) return undefined;
  if (value.toLowerCase() === "headless") return "headless";
  throw new Error(`Unsupported --browser-use value: ${value}. Supported value: headless.`);
};

const normalizePresentationSurface = (value: string | undefined): PresentationSurface => {
  if (value === undefined || value.toLowerCase() === "terminal") return "terminal";
  if (value.toLowerCase() === "desktop") return "zcode_desktop";
  throw new Error(`Unsupported --surface value: ${value}. Supported surfaces: terminal, desktop.`);
};

const normalizeTargetRequest = (
  values: ReturnType<typeof parseGlobalArgs>["values"],
): CliTargetRequest | undefined => {
  const rawTarget = values.target as string | undefined;
  const replaceExisting = values["target-replace"] === true;
  if (rawTarget === undefined) {
    if (replaceExisting) {
      throw new Error(TARGET_REPLACE_REQUIRES_TARGET_ERROR);
    }
    return undefined;
  }

  const objective = rawTarget.trim();
  if (objective.length === 0) {
    throw new Error(EMPTY_TARGET_ERROR);
  }

  return {
    objective,
    replaceExisting,
  };
};

const buildHeadlessTargetCommand = (targetRequest: CliTargetRequest): string =>
  targetRequest.replaceExisting
    ? `/goal replace ${targetRequest.objective}`
    : `/goal ${targetRequest.objective}`;

const writeHelp = (
  stdout: NodeJS.WriteStream,
  locale?: UiLocale,
  detectedLocale?: GlobalOptions["detectedLocale"],
): void => {
  stdout.write(formatCliHelp(version, locale, detectedLocale));
};

const DOCTOR_STATUS_LABEL: Record<DoctorReport["checks"][number]["status"], string> = {
  pass: "PASS",
  warn: "WARN",
  fail: "FAIL",
};

const runDoctor = (
  ctx: RunContext,
  options: GlobalOptions,
  workingDirectory: string,
  gate: {
    dotenv: ReturnType<typeof loadCliDotenvAtEntry>;
    env: CliEnv;
  },
): number => {
  const runtime = getRuntimeInfo();
  // 仓库根先从 cwd 找；cwd 不在仓库内时退回已加载 .env 所在目录（.env 就在仓库根）。
  // 不依赖 __dirname / import.meta：本文件会被打成 CJS bundle，两者在运行期不都可用。
  const repoRoot =
    findRepoRoot(workingDirectory) ??
    (gate.dotenv.path ? findRepoRoot(dirname(gate.dotenv.path)) : undefined);
  const report = collectDoctorReport({
    dotenv: gate.dotenv,
    env: gate.env,
    cwd: workingDirectory,
    repoRoot,
  });
  const payload = {
    ok: report.ok,
    cli: {
      name: CLI_COMMAND_NAME,
      processName: CLI_PROCESS_NAME,
      version,
    },
    runtime: {
      arch: runtime.arch,
      cwd: workingDirectory,
      execPath: runtime.execPath,
      node: runtime.node,
      platform: runtime.platform,
      processTitle: process.title,
      sea: runtime.sea,
    },
    packaging: {
      default: "node-bundle",
      sea: "optional",
    },
    checks: toJsonChecks(report.checks),
  };

  if (options.json) {
    ctx.stdout.write(formatJson(payload));
    return report.ok ? 0 : 1;
  }

  const colors = supportsColor(ctx.stdout, options.noColor);
  ctx.stdout.write(`${color.bold("zcode doctor", colors)}\n`);
  ctx.stdout.write(`version: ${payload.cli.version}\n`);
  ctx.stdout.write(`process: ${payload.runtime.processTitle}\n`);
  ctx.stdout.write(`node: ${payload.runtime.node}\n`);
  ctx.stdout.write(`platform: ${payload.runtime.platform}/${payload.runtime.arch}\n`);
  ctx.stdout.write(`sea: ${payload.runtime.sea ? "yes" : "no"} (${payload.packaging.sea})\n`);
  ctx.stdout.write(`default artifact: ${payload.packaging.default}\n`);

  ctx.stdout.write(`\n${color.bold("self-check", colors)}\n`);
  for (const item of report.checks) {
    ctx.stdout.write(`${DOCTOR_STATUS_LABEL[item.status]}  ${item.label}: ${item.detail}\n`);
    if (item.fix) {
      ctx.stdout.write(`      → ${item.fix}\n`);
    }
  }
  ctx.stdout.write(report.ok ? "\nresult: OK\n" : "\nresult: FAILED\n");

  if (options.verbose) {
    ctx.stdout.write(`execPath: ${payload.runtime.execPath}\n`);
    ctx.stdout.write(`cwd: ${payload.runtime.cwd}\n`);
  }

  return report.ok ? 0 : 1;
};

const CODING_PLAN_PROVIDERS = ["bigmodel", "zai"] as const;
type CodingPlanProviderId = (typeof CODING_PLAN_PROVIDERS)[number];

const isCodingPlanProviderId = (value: string): value is CodingPlanProviderId =>
  (CODING_PLAN_PROVIDERS as readonly string[]).includes(value);

/** Coding Plan Key 的环境变量兜底，避免把凭据放进命令行（ps 可见）。 */
const CODING_PLAN_API_KEY_ENV: Record<CodingPlanProviderId, string> = {
  bigmodel: "BIGMODEL_API_KEY",
  zai: "ZAI_API_KEY",
};

/**
 * 非交互写入 Coding Plan 凭据并把默认模型预置为内置 Provider 的首个模型。
 * 与 TUI 命令中心走同一个 bootstrap 入口（configureCodingPlanApiKey），
 * 不另写一份配置格式，避免两套写入路径。
 */
const runConfigure = async (ctx: RunContext, options: GlobalOptions, deps: RunDependencies): Promise<number> => {
  try {
    const env = deps.env ?? process.env;
    const providerIdRaw = options.configureProvider?.trim() || "bigmodel";
    if (!isCodingPlanProviderId(providerIdRaw)) {
      ctx.stderr.write(`--provider must be one of ${CODING_PLAN_PROVIDERS.join(", ")}.\n`);
      return 1;
    }
    const providerId = providerIdRaw;
    const apiKey = options.configureApiKey?.trim() || env[CODING_PLAN_API_KEY_ENV[providerId]]?.trim();
    if (!apiKey) {
      ctx.stderr.write(
        `No API key provided. Pass --api-key or set ${CODING_PLAN_API_KEY_ENV[providerId]} in .env.\n`,
      );
      return 1;
    }

    const configure =
      deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
    const result = await configure({ apiKey, env, providerId });

    if (options.json) {
      ctx.stdout.write(formatJson({ providerId: result.providerId, model: result.model, configPath: result.configPath }));
    } else {
      // 只回报落点与模型，绝不回显 key。
      ctx.stdout.write(`Configured ${result.providerId}: default model ${result.model}\n`);
      ctx.stdout.write(`Provider config: ${result.configPath}\n`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};

const runZCodeProtocolCommand = async (
  ctx: RunContext,
  options: GlobalOptions,
  deps: RunDependencies,
  presentationSurface: PresentationSurface,
  prepareStorageOnly = false,
): Promise<number> => {
  try {
    const env = prepareCliRuntimeEnv(deps.env ?? process.env);
    const workingDirectory = (deps.cwd ?? process.cwd)();
    // 打包态 app-server 是 desktop host 的内部协议子进程。
    // 如果这里继续从 workspace 向上读取用户 .env，读文件失败或环境污染会在协议建立前
    // 直接退出，外层只能看到 ZCode agent transport closed。
    const dotenvResult = shouldLoadCliDotenvForProtocolServer(env)
      ? (deps.loadDotenv ?? loadCliDotenv)({
          cwd: workingDirectory,
          env,
        })
      : {
          keys: [],
          loaded: false,
        };
    applyCliRuntimeEnvSanitization(env);

    if (dotenvResult.error) {
      throw new Error(`Failed to load environment file: ${dotenvResult.path}`, {
        cause: dotenvResult.error,
      });
    }

    const runProtocolAgent =
      deps.runZCodeProtocolAgent ?? (await loadBootstrapModule()).runZCodeProtocolAgent;
    await runProtocolAgent({
      lifecycle: deps.protocolLifecycle,
      cwd: workingDirectory,
      env,
      input: deps.protocolInput ?? ctx.stdin,
      output: ctx.stdout,
      presentationSurface,
      prepareStorageOnly,
      version,
    });
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`Error: ${message}\n`);
    if (options.verbose && error instanceof Error && error.stack) {
      ctx.stderr.write(`${error.stack}\n`);
    }
    return 1;
  }
};

export const run = async (ctx: RunContext, deps: RunDependencies = {}): Promise<number> => {
  if (ctx.argv[0] === "__internal-search") {
    return runEmbeddedSearchCli(ctx.argv.slice(1), {
      cwd: (deps.cwd ?? process.cwd)(),
      stderr: ctx.stderr,
      stdin: ctx.stdin,
      stdout: ctx.stdout,
    });
  }

  if (isPluginHostInvocation(ctx.argv)) {
    return await runPluginHostCommand(ctx, ctx.argv.slice(1));
  }

  // 与 plugin host 同理，且必须同样在 parseArgs 之前：SEA 下 dwf 的沙箱子进程是本二进制的
  // 自 re-exec，argv 末位是入口文件路径——交给严格 parseArgs 只会报未知参数。
  if (isDwfChildInvocation(ctx.argv)) {
    return await runDwfChildCommand(ctx, ctx.argv.slice(1));
  }

  if (ctx.argv[0] === "hooks") {
    return await runHooksCommand(ctx, deps, version);
  }

  let parsed: ReturnType<typeof parseGlobalArgs>;
  let toolDisallowlist: readonly string[] | undefined;

  try {
    const extracted = extractDisallowedToolsArgs(ctx.argv);
    parsed = parseGlobalArgs(extracted.args);
    toolDisallowlist = extracted.toolDisallowlist;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n\n`);
    writeHelp(ctx.stderr);
    return 1;
  }

  let locale: UiLocale | undefined;
  try {
    locale = normalizeLocaleOption(parsed.values.locale as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  let mode: CliPermissionMode | undefined;
  let browserUse: GlobalOptions["browserUse"];
  let presentationSurface: PresentationSurface;
  try {
    mode = normalizePromptMode(parsed.values.mode as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  try {
    browserUse = normalizeBrowserUse(parsed.values["browser-use"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  try {
    presentationSurface = normalizePresentationSurface(parsed.values.surface as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const browserExecutable = parsed.values["browser-executable"] as string | undefined;
  if (browserExecutable !== undefined && browserUse !== "headless") {
    ctx.stderr.write(`${BROWSER_EXECUTABLE_REQUIRES_HEADLESS_ERROR}\n`);
    return 1;
  }

  const resumeRequest: CliResumeRequest = {
    continueSession: parsed.values.continue === true,
    resumeSessionId: parsed.values.resume as string | undefined,
  };
  if (resumeRequest.continueSession && resumeRequest.resumeSessionId) {
    ctx.stderr.write("--resume and --continue cannot be used together.\n");
    return 1;
  }

  const env = prepareCliRuntimeEnv(deps.env ?? process.env);
  const detectedLocale = detectCliLocale(env);
  let outputFormat: GlobalOptions["outputFormat"];
  try {
    outputFormat = normalizeOutputFormat(parsed.values["output-format"] as string | undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }
  const options = globalOptions(
    parsed.values,
    locale,
    detectedLocale,
    browserUse,
    browserExecutable,
    outputFormat,
  );
  const forceMcs = parsed.values["force-mcs"] === true;
  let targetRequest: CliTargetRequest | undefined;
  try {
    targetRequest = normalizeTargetRequest(parsed.values);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  if (targetRequest && typeof parsed.values.prompt === "string") {
    ctx.stderr.write(`${TARGET_CONFLICTS_WITH_PROMPT_ERROR}\n`);
    return 1;
  }

  if (
    parsed.values.surface !== undefined &&
    !isPresentationSurfaceSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${SURFACE_SCOPE_ERROR}\n`);
    return 1;
  }

  if (parsed.values.help === true) {
    writeHelp(ctx.stdout, options.locale, options.detectedLocale);
    return 0;
  }

  if (parsed.values.version === true) {
    ctx.stdout.write(`${version}\n`);
    return 0;
  }

  if (
    options.memoryBench &&
    (typeof parsed.values.prompt !== "string" || parsed.positionals.length > 0)
  ) {
    ctx.stderr.write(`${MEMORY_BENCH_SCOPE_ERROR}\n`);
    return 1;
  }

  if (
    browserUse === "headless" &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${BROWSER_USE_SCOPE_ERROR}\n`);
    return 1;
  }

  if (
    forceMcs &&
    !isForceMcsSupportedInvocation({
      positionals: parsed.positionals,
      prompt: parsed.values.prompt as string | undefined,
      targetRequest,
    })
  ) {
    ctx.stderr.write(`${FORCE_MCS_SCOPE_ERROR}\n`);
    return 1;
  }

  let workingDirectory: string;
  try {
    workingDirectory = resolveCliCwd({
      cwd: deps.cwd ?? process.cwd,
      requestedCwd: parsed.values.cwd as string | undefined,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.stderr.write(`${message}\n`);
    return 1;
  }

  // .env 的唯一加载点。必须在构造 commandDeps 之前完成：此处注入的 env 是
  // process.env 本体，TUI 主路径（tui-command.ts）直接读它，不经过 loadDotenv。
  // 例外见 runZCodeProtocolCommand：app-server / agent-server 仍自行决定是否加载。
  const entryDotenvResult = loadCliDotenvAtEntry({
    cwd: workingDirectory,
    env,
    loadDotenv: deps.loadDotenv,
  });
  if (entryDotenvResult.error) {
    ctx.stderr.write(
      `Failed to load environment file: ${entryDotenvResult.path ?? "<unknown>"}\n`,
    );
    return 1;
  }

  const commandDeps: RunDependencies = {
    ...deps,
    cwd: () => workingDirectory,
    env,
    logger:
      deps.logger ??
      createNodeLoggerFactory({ env }).createLogger("zcode").child({ module: "cli" }),
    // 入口已统一加载，这里保持既有回调签名但不再重复读文件，避免二次解析。
    loadDotenv: (dotenvOptions = {}) => {
      applyCliRuntimeEnvSanitization(dotenvOptions.env ?? env);
      return entryDotenvResult;
    },
  };

  if (typeof parsed.values.prompt === "string") {
    return await runPrompt(
      ctx,
      parsed.values.prompt,
      parsed.values.attach ?? [],
      options,
      commandDeps,
      version,
      mode ?? DEFAULT_HEADLESS_PROMPT_MODE,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      presentationSurface,
    );
  }

  if (targetRequest) {
    return await runPrompt(
      ctx,
      buildHeadlessTargetCommand(targetRequest),
      [],
      options,
      commandDeps,
      version,
      mode,
      resumeRequest,
      toolDisallowlist,
      forceMcs,
      presentationSurface,
    );
  }

  switch (commandName(parsed.positionals)) {
    case "help":
      writeHelp(ctx.stdout, options.locale, options.detectedLocale);
      return 0;
    case "version":
      ctx.stdout.write(`${version}\n`);
      return 0;
    case "agent-server":
    case "app-server":
      return await runZCodeProtocolCommand(
        ctx,
        options,
        commandDeps,
        presentationSurface,
        parsed.values["prepare-storage"] === true,
      );
    case "configure":
      return await runConfigure(ctx, options, commandDeps);
    case "doctor":
      return runDoctor(ctx, options, workingDirectory, {
        dotenv: entryDotenvResult,
        env,
      });
    case "login":
      return await runLoginCommand(
        ctx,
        options,
        commandDeps,
        parsed.values["no-browser"] === true,
        parsed.positionals.slice(1),
      );
    case "logout":
      return await runLogoutCommand(ctx, options, commandDeps);
    case "commands":
      return await runCommandsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "plugin":
    case "plugins":
      return await runPluginsCommand(
        ctx,
        options,
        commandDeps,
        parsed.positionals.slice(1),
        pluginsCommandFlags(parsed.values),
      );
    case "skills":
      return await runSkillsCommand(ctx, options, commandDeps, parsed.positionals.slice(1));
    case "tui":
      return await runTuiCommand(
        ctx,
        options,
        commandDeps,
        version,
        mode,
        resumeRequest,
        toolDisallowlist,
        forceMcs,
      );
    default:
      ctx.stderr.write(`Unknown command: ${commandName(parsed.positionals)}\n\n`);
      writeHelp(ctx.stderr, options.locale, options.detectedLocale);
      return 1;
  }
};
