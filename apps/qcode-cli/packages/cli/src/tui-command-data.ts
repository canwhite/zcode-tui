import type { TuiSessionMetadata } from "@qcode/tui";
import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";

type TuiMetadataSource = {
  getSessionMetadata?: () => Promise<TuiSessionMetadata>;
};

export async function listCustomCommandsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.listCustomCommands) {
    return await deps.listCustomCommands({ env, logger: deps.logger, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.listZCodeCustomCommands({ env, logger: deps.logger, workingDirectory });
}

export async function loadCustomCommandForTui(deps: RunDependencies, name: string) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  if (deps.loadCustomCommand) {
    return await deps.loadCustomCommand({ env, logger: deps.logger, name, workingDirectory });
  }
  const bootstrap = await loadBootstrapModule();
  return await bootstrap.loadZCodeCustomCommand({
    env,
    logger: deps.logger,
    name,
    workingDirectory,
  });
}

export async function listSkillsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const listZCodeSkillsForTui = deps.listSkills ?? (await loadBootstrapModule()).listZCodeSkills;
  return await listZCodeSkillsForTui({
    env,
    logger: deps.logger,
    workingDirectory,
  });
}

/**
 * 供一级命令清单使用的 skill 投影。
 *
 * **失败必须降级而非上抛**：本函数的调用点在启动期，与内置命令建议同处一条路径。
 * 一旦它抛错，整个建议列表（含全部内置命令）会一起挂掉 —— 用户看到的是
 * 「一个命令都没有」，而不是「skill 没扫到」。因此这里独立兜底，只丢弃 skill 部分。
 */
export async function listSkillSuggestionsForTui(deps: RunDependencies) {
  try {
    const outcome = await listSkillsForTui(deps);
    return {
      skills: outcome.skills.map((skill) => ({
        description: skill.description,
        name: skill.name,
        path: skill.path,
        scope: skill.scope,
        source: skill.source,
      })),
      totalDiscovered: outcome.totalDiscovered,
    };
  } catch (error) {
    deps.logger?.warn("Failed to list skills for slash command suggestions", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export async function listSessionsForTui(deps: RunDependencies) {
  const env = deps.env ?? process.env;
  const workingDirectory = (deps.cwd ?? process.cwd)();
  const listZCodeSessionsForTui =
    deps.listSessions ?? (await loadBootstrapModule()).listZCodeSessions;
  const sessions = await listZCodeSessionsForTui({
    directory: workingDirectory,
    env,
    limit: 50,
  });
  return sessions.map((session) => ({
    directory: session.directory,
    id: session.id,
    parentId: session.parentID,
    title: session.title,
    updatedAt: session.time.updated,
  }));
}

export async function loadInitialTuiSessionMetadata(
  promptHandler: TuiMetadataSource,
): Promise<TuiSessionMetadata> {
  try {
    return (await promptHandler.getSessionMetadata?.()) ?? {};
  } catch (error) {
    if (isStartupGateError(error)) {
      throw error;
    }
    return {};
  }
}

function isStartupGateError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "SqliteSessionMigrationError";
}
