// ============================================================
// MCP Servers from the Config Home
// ============================================================
//
// 从 `.claude` 侧读取 MCP server 定义，供 zcode 直接连接 —— 使用户在
// Claude Code 里配好的 MCP 无需二次搬运。
//
// 两个来源：
//   - 用户级：`~/.claude.json` 顶层 `mcpServers`（Claude Code 的实际落点）
//   - 项目级：`<repo>/.mcp.json` 的 `mcpServers`
//
// 覆盖顺序：**项目级 > 用户级**（更具体者优先，与 Claude Code 行为一致）。
// 调用方再把它与插件来源合并，最终形成 项目 > 用户 > 插件。
//
// 两条硬约束（勿改）：
//   1. **`env` / `headers` 的值绝不出现在日志或 doctor 输出里** —— 它们通常含密钥。
//      本模块只返回结构化结果，由调用方负责投影（见返回值里的 `names`）。
//   2. **单条非法只跳过该条**，不因一条坏配置丢掉整份配置。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "@qcode/contracts";
import { mcpServerSchema } from "../config/schema.js";
import { resolveUserHomeDir } from "./index.js";

/**
 * 用户级 MCP 定义所在的文件。
 *
 * 注意它是**家目录下的文件**：`~/.claude.json`（与 `.claude/` 目录同级），
 * **不是** `~/.claude/.claude.json`。Claude Code 把 `mcpServers` 放在该文件顶层。
 */
export const USER_MCP_CONFIG_FILE = ".claude.json";

/** 项目级 MCP 定义文件名。注意：插件包内也用它，但二者根目录不同。 */
export const PROJECT_MCP_CONFIG_FILE = ".mcp.json";

/** MCP server 的来源档位，决定覆盖优先级。 */
export type McpConfigSource = "project" | "user";

export interface LoadedMcpServers {
  /** 合并后的 server 定义，项目级已覆盖用户级。 */
  servers: Record<string, McpServerConfig>;
  /** 每个 server 来自哪一档，供 doctor 展示与排查。 */
  sourceByName: Record<string, McpConfigSource>;
  /**
   * 被跳过的条目。**只含名字与原因，绝不含配置值**。
   * 报出而不是静默丢弃，否则用户会以为「配了但没生效」是 zcode 的 bug。
   */
  skipped: { name: string; reason: string; source: McpConfigSource }[];
  /** 读取过的文件路径（供 doctor 展示）。 */
  readPaths: string[];
}

export interface LoadMcpServersFromConfigHomeOptions {
  env?: NodeJS.ProcessEnv;
  workingDirectory: string;
}

/**
 * 读取 `.claude` 侧的用户级 + 项目级 MCP 定义。
 *
 * 任一文件缺失都是**干净的 no-op**（不报错、不产生 skipped 条目）——
 * 当前用户可能根本没用 MCP，这不该表现为故障。
 */
export function loadMcpServersFromConfigHome(
  options: LoadMcpServersFromConfigHomeOptions,
): LoadedMcpServers {
  const env = options.env ?? process.env;
  // ⚠️ `.claude.json` 是 `.claude/` **目录的同级文件**，不是它里面的文件。
  // 即 `~/.claude.json`，而**不是** `~/.claude/.claude.json`。
  // 早先写成 `join(getUserConfigHome(env), USER_MCP_CONFIG_FILE)`，算出的路径
  // 永远不存在 —— 用户级 MCP 一个都读不到，且静默无报错。
  // 因此必须从 **家目录** 拼，而不是从配置家目录拼。
  const userPath = join(resolveUserHomeDir(env), USER_MCP_CONFIG_FILE);
  const projectPath = join(options.workingDirectory, PROJECT_MCP_CONFIG_FILE);

  const skipped: LoadedMcpServers["skipped"] = [];
  const readPaths: string[] = [];
  const sourceByName: Record<string, McpConfigSource> = {};

  // 先用户级，再项目级 —— 后写的覆盖先写的，天然实现「项目 > 用户」。
  const userServers = readServersFrom(userPath, "user", readPaths, skipped, env);
  const projectServers = readServersFrom(projectPath, "project", readPaths, skipped, env);

  const servers: Record<string, McpServerConfig> = { ...userServers, ...projectServers };
  for (const name of Object.keys(userServers)) sourceByName[name] = "user";
  for (const name of Object.keys(projectServers)) sourceByName[name] = "project";

  return { servers, sourceByName, skipped, readPaths };
}

/** `${VAR}` 占位符。与插件加载器的 TEMPLATE_PATTERN 同形。 */
const TEMPLATE_PATTERN = /\$\{([^}]+)\}/g;

/**
 * 递归展开定义里的 `${VAR}`。
 *
 * 与插件加载器的差别：这里**不抛错**，而是把「缺失的变量名」收集起来交还调用方 ——
 * 调用方据此**跳过整条并报出名字**。理由：`process.env` 里的缺失是用户可修的，
 * 而静默把 `${TOKEN}` 原样传给远端只会得到一个 401，用户从配置里看不出任何问题。
 *
 * 找不到的变量**不做替换**（保留原字面量），保证返回的文本始终可读、可搜索。
 */
function expandEnvTemplates(
  value: unknown,
  env: NodeJS.ProcessEnv,
): { value: unknown; missing: string[] } {
  const missing = new Set<string>();
  const walk = (input: unknown): unknown => {
    if (typeof input === "string") {
      return input.replace(TEMPLATE_PATTERN, (match, name: string) => {
        const resolved = env[name];
        if (resolved === undefined || resolved === "") {
          missing.add(name);
          return match;
        }
        return resolved;
      });
    }
    if (Array.isArray(input)) return input.map(walk);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([key, child]) => [key, walk(child)]),
      );
    }
    return input;
  };
  return { value: walk(value), missing: [...missing] };
}

function readServersFrom(
  path: string,
  source: McpConfigSource,
  readPaths: string[],
  skipped: LoadedMcpServers["skipped"],
  env: NodeJS.ProcessEnv,
): Record<string, McpServerConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // 文件不存在 / 非法 JSON 一律按「没有配置」处理。
    // 不把解析失败升级成错误：MCP 是可选能力，且 `.claude.json` 里 99% 是
    // Claude Code 自己的客户端状态，我们只是顺带读一个键。
    return {};
  }
  readPaths.push(path);

  const container = raw as Record<string, unknown> | null;
  if (!container || typeof container !== "object" || Array.isArray(container)) return {};

  const candidate = container.mcpServers;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return {};

  const result: Record<string, McpServerConfig> = {};
  for (const [name, definition] of Object.entries(candidate as Record<string, unknown>)) {
    // `${VAR}` 展开：Claude Code 的 `.mcp.json` 惯例是用它引用环境变量
    // （典型如 `"Authorization": "Bearer ${GITHUB_TOKEN}"`）。
    // 不展开就会把字面量 `${GITHUB_TOKEN}` 交给适配器 —— 表现为远端 401，
    // 而用户看到的配置里明明写对了，极难排查。
    const expanded = expandEnvTemplates(definition, env);
    if (expanded.missing.length > 0) {
      skipped.push({
        name,
        reason: `未设置的环境变量：${expanded.missing.join(", ")}`,
        source,
      });
      continue;
    }

    const parsed = mcpServerSchema.safeParse(expanded.value);
    if (parsed.success) {
      result[name] = parsed.data as McpServerConfig;
      continue;
    }
    // 单条非法只跳过该条 —— 一条坏配置不该让其余可用的 server 一起失效。
    skipped.push({
      name,
      reason: parsed.error.issues
        .map((issue) => (issue.path.length > 0 ? issue.path.join(".") : "<server>"))
        .join(", "),
      source,
    });
  }
  return result;
}
