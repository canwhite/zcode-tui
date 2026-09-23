import { createConfig, resolvePath } from "@qcode/adapters/config";
import type { Logger, McpConnectionSnapshot, McpPort, McpServerStatus } from "@qcode/contracts";
import {
  zcodeMcpListParamsSchema,
  zcodeMcpListResultSchema,
  type ZCodeMcpListResult,
} from "@qcode/shared";
import {
  listMcpServerStatuses,
  omitMcpServers,
  resolveTrustedOfficialCuaServerNames,
} from "../mcp-config.js";
import { StartupTimer, startupNow } from "../startup-logging.js";
import { getCliStorageRoot } from "../app/paths.js";
import { resolveStartupPlugins } from "../app/startup-marks.js";
import { protocolMcpServersToRuntimeMcpConfig } from "./protocol-mcp-config.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

const noopLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
};

const MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS = 5_000;
const MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS = 100;

export async function listMcpServers(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
): Promise<ZCodeMcpListResult> {
  const params = parseParams(zcodeMcpListParamsSchema, rawParams);
  const workingDirectory = params.workspace.workspacePath;
  const configResult = createConfig({
    env: context.deps.env,
    workingDirectory,
  });
  const cliStorageRoot = getCliStorageRoot(resolvePath(configResult.config.storage.dir));
  const startupTimer = new StartupTimer(
    context.logger ?? noopLogger,
    {
      module: "bootstrap.zcode_protocol.mcp",
      workspaceKey: params.workspace.workspaceKey,
      workspacePath: params.workspace.workspacePath,
    },
    startupNow(),
  );
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: context.deps.env,
    logger: context.logger,
    options: {},
    startupTimer,
    workingDirectory,
  });
  const explicitRuntimeMcp = protocolMcpServersToRuntimeMcpConfig(params.mcpServers);
  // 三层**叠加**，不是二选一（与 runtime-config.ts 保持同一形状与理由）。
  //
  // 原为 `...(provided ? explicit : configResult…)`，会在调用方提供了 mcpServers 时
  // 把 `configResult.config.mcp.servers` **整体丢弃** —— 而那正是
  // `~/.claude.json` 与 `<repo>/.mcp.json` 的落点，于是「配了却连不上」且无报错。
  // 更糟的是 `params.mcpServers: []` 也会命中 `!== undefined`，算出 `{}`，
  // 再经下游 `connectConfiguredServers` 的 **replace 语义**把已连上的 server 全部断开。
  const configuredMcpServers = {
    ...pluginOutcome.mcpServers,
    ...configResult.config.mcp.servers,
    ...(explicitRuntimeMcp?.servers ?? {}),
  };
  const trustedOfficialCuaServerNames = resolveTrustedOfficialCuaServerNames(
    configuredMcpServers,
    pluginOutcome.mcpServers,
  );
  // 产品决定 workspace MCP 开箱即用：project 作用域 MCP 默认 trusted，并自动连接。
  const untrustedProjectMcpServers = new Set<string>();
  const mcpPort = context.deps.mcpPort;
  if (mcpPort) {
    if (params.mode === "status") {
      // OAuth 轮询只需要读取当前运行态。传入 pending 子集会落到
      // connectConfiguredServers 的 replace 语义，导致未列出的 MCP 被断开。
      const statuses = await listMcpServerStatuses(
        mcpPort,
        configuredMcpServers,
        untrustedProjectMcpServers,
      );
      return zcodeMcpListResultSchema.parse({ statuses });
    }

    // OAuth 轮询已由 mode=status 隔离；默认/connect 必须继续执行 replace 收敛，
    // 否则任一 server 待授权时，配置新增/删除和 stale MCP 清理都会被跳过。
    // 默认/connect 模式服务的是设置页刷新这类"重新探测"诉求，而 mcpPort 是进程级
    // `protocol-settings` lease；不带 revalidate 时连接池会直接复用旧 entry 并返回陈旧快照，
    // 停掉的 HTTP MCP 会永远显示已连接（见 adapters/src/mcp/pool.ts revalidateEntry）。
    const connectPromise = mcpPort.connectConfiguredServers(
      omitMcpServers(
        configuredMcpServers,
        untrustedProjectMcpServers,
        trustedOfficialCuaServerNames,
      ),
      {
        revalidate: true,
        workingDirectory,
      },
    );
    const pendingAuthorizationSnapshot = await waitForOAuthAuthorizationSnapshot(
      mcpPort,
      connectPromise,
    );
    if (pendingAuthorizationSnapshot) {
      void connectPromise.catch((error) => {
        context.logger?.warn("MCP background authorization connection failed", {
          error: error instanceof Error ? error.message : String(error),
          event: "mcp.authorization.background.failed",
          workspaceKey: params.workspace.workspaceKey,
          workspacePath: params.workspace.workspacePath,
        });
      });
      return zcodeMcpListResultSchema.parse({
        statuses: pendingAuthorizationSnapshot.statuses,
      });
    }

    await connectPromise;
  }
  const statuses = await listMcpServerStatuses(
    mcpPort,
    configuredMcpServers,
    untrustedProjectMcpServers,
  );
  return zcodeMcpListResultSchema.parse({ statuses });
}

async function waitForOAuthAuthorizationSnapshot(
  mcpPort: McpPort,
  connectPromise: Promise<McpConnectionSnapshot>,
): Promise<McpConnectionSnapshot | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < MCP_OAUTH_AUTHORIZATION_STATUS_WAIT_MS) {
    const race = await Promise.race([
      connectPromise.then(
        (snapshot) => ({ kind: "completed" as const, snapshot }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      delay(MCP_OAUTH_AUTHORIZATION_STATUS_POLL_MS).then(() => ({ kind: "poll" as const })),
    ]);

    if (race.kind === "completed") {
      return undefined;
    }
    if (race.kind === "failed") {
      throw race.error;
    }

    const statuses = await mcpPort.status();
    if (hasPendingOAuthAuthorization(statuses)) {
      return {
        statuses,
        tools: await mcpPort.listTools(),
      };
    }
  }

  return undefined;
}

function hasPendingOAuthAuthorization(statuses: Record<string, McpServerStatus>): boolean {
  return Object.values(statuses).some((status) => Boolean(status.authorization?.authorizationUrl));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
