import type { TuiSubmitPrompt } from "@qcode/tui";
import {
  formatAvailableCommandNames,
  listCustomCommandsForHelp,
} from "../command-center-custom.js";
import { findSkillEntry, listSkillsForHelp } from "../command-center-skills.js";
import { formatNewSessionResult, formatResumeResult } from "./formatters.js";
import { handleCustomCommand } from "./handlers/custom.js";
import { handleDwfCommand } from "./handlers/dwf.js";
import { handleEffortCommand } from "./handlers/effort.js";
import { handleExpertCommand } from "./handlers/expert.js";
import { handleLocaleCommand } from "./handlers/locale.js";
import { handleMcpCommand } from "./handlers/mcp.js";
import { handleModeCommand } from "./handlers/mode.js";
import { handleModelCommand } from "./handlers/model.js";
import { handlePluginsCommand } from "./handlers/plugins.js";
import { handleSkillListCommand } from "./handlers/skill.js";
import { handleTargetCommand } from "./handlers/goal.js";
import { recordSlashCommandInHistory } from "./history.js";
import { attachCurrentSessionMetadata, normalizeTuiPromptInput } from "./metadata.js";
import { buildCheckpointSelection, buildSessionSelection } from "./selections.js";
import {
  AVAILABLE_COMMANDS,
  buildManualSkillPrompt,
  formatSlashCommandHelp,
  parseSlashCommand,
} from "./slash-commands.js";
import { providerSetupRequiredResponse } from "../tui-provider-setup-state.js";
import type { CommandCenterDeps } from "./types.js";

export function createCommandCenter(deps: CommandCenterDeps): TuiSubmitPrompt {
  return async (input, options) => {
    const promptInput = normalizeTuiPromptInput(input);
    const command = parseSlashCommand(promptInput.text);
    const hasAttachments = (promptInput.attachments?.length ?? 0) > 0;

    if (!command) {
      if (await isProviderSetupRequired(deps)) {
        return {
          providerSetupRequired: true,
          mode: deps.getMode?.(),
          response: providerSetupRequiredResponse(deps.getLocale?.()),
        };
      }
      const app = await deps.getApp();
      return attachCurrentSessionMetadata(await app.submitPrompt(input, options), deps, app);
    }

    if (hasAttachments) {
      return {
        mode: deps.getMode?.(),
        response: "Image attachments are only supported for normal prompts.",
      };
    }

    if (command.type === "unknown") {
      const customResult = await handleCustomCommand(command.rawName, command.args, deps, options);
      if (customResult) {
        await recordSlashCommandInHistory(deps, promptInput.text);
        return customResult;
      }
      const skills = await listSkillsForHelp(deps);
      // 个人 skill 与内置命令同级呈现（`listSlashCommandSuggestions` 把它们拼进一级清单），
      // 派发层必须给出对应分支 —— 否则建议列表里点得到的命令一提交就报「未知命令」，
      // 而那条报错文案还会把同一个 skill 列进「可用命令」，自相矛盾。
      //
      // 顺序与 headless 的 `resolveSkillCommandName` 对齐：内置 > 自定义命令 > skill。
      // 内置命令在 `parseSlashCommand` 阶段即为 `known`，结构上天然优先，够不到这里；
      // 自定义命令已在上面探测过，故此处只补 skill 这一段。
      //
      // 传 `skill.name`（frontmatter 规范名）而不是 `command.rawName`：
      // `parseSlashCommand` 已把 rawName 小写化，而 skill 加载是**大小写精确匹配**
      // （adapters skills `matchesSkillRequest`），拿 "no-useeffect" 去加载 `no-useEffect` 会找不到。
      const skill = findSkillEntry(command.rawName, skills);
      if (skill) {
        const app = await deps.getApp();
        const result = await attachCurrentSessionMetadata(
          await app.submitPrompt(buildManualSkillPrompt(skill.name, command.args), options),
          deps,
          app,
        );
        await recordSlashCommandInHistory(deps, promptInput.text);
        return result;
      }

      const customCommands = await listCustomCommandsForHelp(deps);
      return {
        mode: deps.getMode?.(),
        response: `Unknown command: /${command.rawName}. Available commands: ${formatAvailableCommandNames(AVAILABLE_COMMANDS, customCommands, skills)}.`,
      };
    }

    const result = await (async () => {
      if (command.name === "help") {
        const customCommands = await listCustomCommandsForHelp(deps);
        const skills = await listSkillsForHelp(deps);
        return {
          mode: deps.getMode?.(),
          response: formatSlashCommandHelp(command.args, customCommands, skills),
        };
      }

      if (command.name === "btw") {
        // 侧问由 **TUI 层**在排队判定之前截获（见 `tui/src/app-submit-controller.ts`），
        // 从不应该走到这里：答案不写转录，所以它不能作为一次 submitPrompt 结果返回。
        // 这条分支是防「落到文件末尾的 resume 兜底」——那样会把问题原文当成 sessionId
        // 去恢复会话，是静默且错误的行为。这里只做显式拒绝，不重复实现侧问。
        return {
          mode: deps.getMode?.(),
          response: "Side questions are not available through this entry point.",
        };
      }

      if (command.name === "compact") {
        const app = await deps.getApp();
        const prompt = command.args ? `/compact ${command.args}` : "/compact";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "init") {
        const app = await deps.getApp();
        const prompt = command.args ? `/init ${command.args}` : "/init";
        // TUI 已知 slash command 若没有显式分支，会落到文件末尾的
        // resume 兜底。/init 是普通 prompt command，必须交给 app.submitPrompt
        // 进入 bootstrap resolver，才能和 app --stdio 复用同一套展开逻辑。
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "expert") {
        return handleExpertCommand(command.args, deps, options);
      }

      if (command.name === "effort") {
        return handleEffortCommand(command.args, deps);
      }

      if (command.name === "dwf") {
        return handleDwfCommand(command.args, deps);
      }

      if (command.name === "rewind") {
        const app = await deps.getApp();
        if (command.args.length === 0 && app.listCheckpoints) {
          return {
            mode: deps.getMode?.(),
            response: "Select a checkpoint to rewind.",
            selection: buildCheckpointSelection("rewind", await app.listCheckpoints({ limit: 50 })),
          };
        }
        const prompt = command.args ? `/rewind ${command.args}` : "/rewind";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "fork") {
        if (command.args.length === 0) {
          const app = await deps.getApp();
          if (app.listCheckpoints) {
            return {
              mode: deps.getMode?.(),
              response: "Select a checkpoint to fork.",
              selection: buildCheckpointSelection("fork", await app.listCheckpoints({ limit: 50 })),
            };
          }
        }
        const targetCheckpointId = parseForkTarget(command.args);
        if (deps.forkApp) {
          const result = await deps.forkApp(targetCheckpointId);
          return {
            mode: deps.getMode?.(),
            response: result.response,
            traceId: undefined,
          };
        }

        const app = await deps.getApp();
        const prompt = targetCheckpointId ? `/fork ${targetCheckpointId}` : "/fork latest";
        return attachCurrentSessionMetadata(await app.submitPrompt(prompt, options), deps, app);
      }

      if (command.name === "mode") {
        return handleModeCommand(command.args, deps);
      }

      if (command.name === "locale") {
        return handleLocaleCommand(command.args, deps);
      }

      if (command.name === "mcp") {
        return handleMcpCommand(command.args, deps);
      }

      if (command.name === "plugins") {
        return handlePluginsCommand(command.args, deps);
      }

      if (command.name === "model") {
        return handleModelCommand(command.args, deps, promptInput.modelSelection);
      }

      if (command.name === "goal") {
        return handleTargetCommand(command.args, deps, options);
      }

      if (command.name === "new") {
        if (command.args.length > 0) {
          return {
            mode: deps.getMode?.(),
            response: "Usage: /new",
          };
        }
        if (!deps.newApp) {
          return {
            mode: deps.getMode?.(),
            response: "Creating a new session is not available in this client.",
          };
        }

        const app = await deps.newApp();
        return {
          mode: deps.getMode?.(),
          locale: app.getLocale?.(),
          model: app.getModel?.(),
          theme: app.getTheme?.(),
          resetSessionProjection: true,
          response: formatNewSessionResult(app.sessionId),
          sessionId: app.sessionId,
          thoughtLevel: app.getThoughtLevel?.(),
          traceId: app.traceId,
        };
      }

      if (command.name === "skill") {
        if (!command.skillName) {
          return handleSkillListCommand(deps);
        }
        const app = await deps.getApp();
        return attachCurrentSessionMetadata(
          await app.submitPrompt(buildManualSkillPrompt(command.skillName, command.task), options),
          deps,
          app,
        );
      }

      if (
        command.name === "resume" &&
        command.args.length === 0 &&
        command.rawName === "resume" &&
        deps.listSessions
      ) {
        return {
          mode: deps.getMode?.(),
          response: "Select a session to resume.",
          selection: buildSessionSelection(await deps.listSessions()),
        };
      }

      const app = await deps.resumeApp(command.args || undefined);
      const result = await app.resume({
        onEvent: options.onEvent,
      });
      const restoredMessages = app.loadSessionTranscript
        ? await app.loadSessionTranscript()
        : undefined;

      return {
        mode: deps.getMode?.(),
        locale: app.getLocale?.(),
        model: app.getModel?.(),
        theme: app.getTheme?.(),
        ...(restoredMessages !== undefined
          ? {
              resetSessionProjection: true,
              restoredMessages,
            }
          : {}),
        response: formatResumeResult(app.sessionId, result),
        thoughtLevel: app.getThoughtLevel?.(),
        traceId: result.traceId ?? app.traceId,
      };
    })();

    await recordSlashCommandInHistory(deps, promptInput.text);
    return result;
  };
}

function parseForkTarget(args: string): string | undefined {
  const trimmed = args.trim();
  if (trimmed.length === 0 || trimmed === "latest") return undefined;
  return trimmed;
}

async function isProviderSetupRequired(deps: CommandCenterDeps): Promise<boolean> {
  if (!deps.hasSelectableModels) return false;
  try {
    return !(await deps.hasSelectableModels());
  } catch {
    return false;
  }
}
