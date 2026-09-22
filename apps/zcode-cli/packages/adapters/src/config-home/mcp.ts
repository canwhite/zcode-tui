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
import type { McpServerConfig } from "@zcode/contracts";
import { mcpServerSchema } from "../config/schema.js";
import { getUserConfigHome } from "./index.js";

/** 用户级 MCP 定义所在的文件（Claude Code 把 `mcpServers` 放在这个文件的顶层）。 */
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
  const userPath = join(getUserConfigHome(env), USER_MCP_CONFIG_FILE);
  const projectPath = join(options.workingDirectory, PROJECT_MCP_CONFIG_FILE);

  const skipped: LoadedMcpServers["skipped"] = [];
  const readPaths: string[] = [];
  const sourceByName: Record<string, McpConfigSource> = {};

  // 先用户级，再项目级 —— 后写的覆盖先写的，天然实现「项目 > 用户」。
  const userServers = readServersFrom(userPath, "user", readPaths, skipped);
  const projectServers = readServersFrom(projectPath, "project", readPaths, skipped);

  const servers: Record<string, McpServerConfig> = { ...userServers, ...projectServers };
  for (const name of Object.keys(userServers)) sourceByName[name] = "user";
  for (const name of Object.keys(projectServers)) sourceByName[name] = "project";

  return { servers, sourceByName, skipped, readPaths };
}

function readServersFrom(
  path: string,
  source: McpConfigSource,
  readPaths: string[],
  skipped: LoadedMcpServers["skipped"],
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
    const parsed = mcpServerSchema.safeParse(definition);
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
