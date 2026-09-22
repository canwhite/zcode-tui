import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveRuntimeZCodeEndpointOrigin, DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import type { CliEnv } from "./env.js";

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  /** 失败时的可执行修复建议；无建议时省略。 */
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

/** 把自检项转成纯 JSON 值，供 --json 输出消费。 */
export function toJsonChecks(checks: readonly DoctorCheck[]): Record<string, string>[] {
  return checks.map((check) => ({
    id: check.id,
    label: check.label,
    status: check.status,
    detail: check.detail,
    ...(check.fix ? { fix: check.fix } : {}),
  }));
}

export interface DoctorGateOptions {
  /** 入口已加载的 .env 结果；protocol server 路径不加载时为 undefined。 */
  dotenv?: { loaded: boolean; path?: string; keys: string[] };
  env: CliEnv;
  cwd: string;
  /** 仓库根；无法定位时为 undefined，此时跳过依赖仓库布局的检查。 */
  repoRoot?: string;
}

/** 安装链路自身依赖的外部命令。 */
const REQUIRED_COMMANDS = ["git", "make"];

/** 模型能否用起来，取决于这些键里至少有一个被解析到。 */
const DEFAULT_PROVIDER_ID = "bigmodel";

function readJsonFile(path: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * 从 startDir 向上寻找仓库根（存在 pnpm-workspace.yaml 的目录）。
 * 打包产物被复制到仓库外时返回 undefined，调用方据此跳过仓库布局相关的检查。
 */
export function findRepoRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function firstOnPath(command: string, pathValue: string | undefined): string | undefined {
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function checkToolchain(env: CliEnv, repoRoot: string | undefined): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const pkg = repoRoot ? readJsonFile(join(repoRoot, "package.json")) : undefined;
  const engines = (pkg?.engines ?? {}) as Record<string, string>;
  const expectedNode = engines.node;
  const actualNode = process.versions.node;

  if (!expectedNode) {
    checks.push({
      id: "toolchain.node",
      label: "Node 版本",
      status: "warn",
      detail: `无法读取期望版本（未定位到仓库根），当前 ${actualNode}`,
    });
  } else {
    const requiredMajor = Number(expectedNode.replace(/[^\d]/g, "").charAt(0));
    const actualMajor = Number(actualNode.split(".")[0]);
    checks.push({
      id: "toolchain.node",
      label: "Node 版本",
      status: actualMajor >= requiredMajor ? "pass" : "fail",
      detail: `当前 ${actualNode}，仓库要求 ${expectedNode}`,
      ...(actualMajor >= requiredMajor
        ? {}
        : {
            fix: `切换到满足 ${expectedNode} 的 Node（仓库 pin 见 apps/zcode-cli/.node-version）后重试`,
          }),
    });
  }

  const missing = REQUIRED_COMMANDS.filter(
    (command) => firstOnPath(command, env.PATH) === undefined,
  );
  checks.push({
    id: "toolchain.commands",
    label: "必需外部命令",
    status: missing.length === 0 ? "pass" : "fail",
    detail: missing.length === 0 ? REQUIRED_COMMANDS.join(", ") : `缺失：${missing.join(", ")}`,
    ...(missing.length === 0 ? {} : { fix: `安装缺失命令后重试：${missing.join(", ")}` }),
  });

  return checks;
}

function checkCommandReachable(env: CliEnv): DoctorCheck {
  const resolved = firstOnPath("zcode", env.PATH);
  if (!resolved) {
    return {
      id: "install.command",
      label: "zcode 命令可达",
      status: "fail",
      detail: "PATH 中找不到 zcode",
      fix: "运行 make install 完成全局安装，或把全局 bin 目录加入 PATH",
    };
  }
  return { id: "install.command", label: "zcode 命令可达", status: "pass", detail: resolved };
}

function checkEnvSource(gate: DoctorGateOptions): DoctorCheck {
  const dotenv = gate.dotenv;
  if (!dotenv?.loaded) {
    // 项目根以外启动属正常形态（向上查找没命中），不作失败处理。
    return {
      id: "config.env",
      label: "环境文件",
      status: "warn",
      detail: "未加载 .env（当前目录向上没有 .env 文件）",
      fix: "如希望用 .env 管理地址与凭据，请在项目根创建 .env",
    };
  }
  return {
    id: "config.env",
    label: "环境文件",
    status: "pass",
    detail: `${dotenv.path ?? "<未知路径>"} ｜ 键：${dotenv.keys.join(", ") || "无"}`,
  };
}

function checkEndpoint(env: CliEnv): DoctorCheck {
  const configured = env.ZCODE_BASE_URL?.trim();
  const origin = resolveRuntimeZCodeEndpointOrigin(env);
  if (!configured && origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN) {
    return {
      id: "config.endpoint",
      label: "端点解析",
      status: "warn",
      detail: `${origin}（未配置 ZCODE_BASE_URL，使用内置默认值）`,
      fix: "如需指向自建服务，请在 .env 中显式设置 ZCODE_BASE_URL",
    };
  }
  return {
    id: "config.endpoint",
    label: "端点解析",
    status: "pass",
    detail: `${origin}${configured ? "（来自 ZCODE_BASE_URL）" : ""}`,
  };
}

/**
 * 模型侧能否用起来，取决于个人 Provider Config 里的默认模型选择。
 * 凭据本身存在共享凭据库（权限 0600），此检查只读 Provider Config，
 * 不读取、不输出任何凭据内容。
 */
function checkProviderSelection(env: CliEnv): DoctorCheck {
  const path =
    env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ||
    join(homedir(), ".zcode", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);

  if (!existsSync(path)) {
    return {
      id: "config.model",
      label: "模型配置",
      status: "warn",
      detail: `尚无个人 Provider 配置：${path}`,
      fix: "运行 zcode configure --provider bigmodel --api-key <key>，或在 TUI 的设置里填入 Key",
    };
  }

  const file = readJsonFile(path);
  const config = (file?.config ?? {}) as Record<string, unknown>;
  const selection = config.defaultModelSelection as
    | { modelId?: string; providerId?: string }
    | undefined;
  if (!selection?.modelId) {
    return {
      id: "config.model",
      label: "模型配置",
      status: "warn",
      detail: `${path} 中没有默认模型选择`,
      fix: "运行 zcode configure 预置默认模型，或在 TUI 中切换模型",
    };
  }
  return {
    id: "config.model",
    label: "模型配置",
    status: "pass",
    detail: `默认模型 ${selection.providerId ?? DEFAULT_PROVIDER_ID}/${selection.modelId}`,
  };
}

function checkBuiltinProviderConfig(env: CliEnv): DoctorCheck {
  const explicit = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!explicit) {
    // 运行时若没有该变量，CLI 会落到随包/仓库内的内置配置；此处不作失败判定。
    return {
      id: "config.provider",
      label: "Provider 配置源",
      status: "pass",
      detail: "未显式覆盖，使用随包内置配置",
    };
  }
  return existsSync(explicit)
    ? {
        id: "config.provider",
        label: "Provider 配置源",
        status: "pass",
        detail: explicit,
        fix: undefined,
      }
    : {
        id: "config.provider",
        label: "Provider 配置源",
        status: "fail",
        detail: `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE 指向的文件不存在：${explicit}`,
        fix: "修正该路径或清空该变量以使用内置配置",
      };
}

/**
 * 汇总安装自检结论。`zcode doctor` 与 `make install` 的收口自检共用这一份实现，
 * 避免出现两套判定标准。
 */
export function collectDoctorReport(gate: DoctorGateOptions): DoctorReport {
  const checks: DoctorCheck[] = [
    ...checkToolchain(gate.env, gate.repoRoot),
    checkCommandReachable(gate.env),
    checkEnvSource(gate),
    checkEndpoint(gate.env),
    checkProviderSelection(gate.env),
    checkBuiltinProviderConfig(gate.env),
  ];
  return {
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  };
}
