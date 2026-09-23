import type { TuiSubmitPromptResult } from "@qcode/tui";
import type {
  CommandCenterDeps,
  CommandCenterSkill,
  CommandCenterSkillListOutcome,
} from "../types.js";

export async function handleSkillListCommand(
  deps: CommandCenterDeps,
): Promise<TuiSubmitPromptResult> {
  if (!deps.listSkills) {
    return {
      mode: deps.getMode?.(),
      response: "Skill listing is not available in this client.",
    };
  }

  try {
    const outcome = await deps.listSkills();
    // undefined = 扫描失败且已被降级兜底。必须与「真的没有 skill」区分开，
    // 否则一次读盘失败会被报成「No skills found」，把用户引向错误方向。
    if (!outcome) {
      return {
        mode: deps.getMode?.(),
        response: "Unable to list skills: the skill scan did not complete.",
      };
    }
    return {
      mode: deps.getMode?.(),
      response: formatCommandCenterSkillList(outcome),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      mode: deps.getMode?.(),
      response: `Unable to list skills: ${message}`,
    };
  }
}

function formatCommandCenterSkillList(outcome: CommandCenterSkillListOutcome): string {
  if (outcome.skills.length === 0) {
    return "No skills found.";
  }

  const lines = [`Available skills (${outcome.skills.length})`];
  for (const skill of outcome.skills) {
    const alias = skill.qualifiedName ? `; alias ${skill.name}` : "";
    lines.push(`- ${formatCommandCenterSkillName(skill)} (${skill.scope}/${skill.source}${alias})`);
    lines.push(`  ${formatCommandCenterSkillDescription(skill)}`);
    lines.push(`  ${skill.path}`);
  }
  lines.push("", "Use /skill <name> [task] to load one.");
  return lines.join("\n");
}

function formatCommandCenterSkillDescription(skill: CommandCenterSkill): string {
  return skill.whenToUse ? `${skill.description} ${skill.whenToUse}` : skill.description;
}

function formatCommandCenterSkillName(skill: CommandCenterSkill): string {
  return skill.qualifiedName ?? skill.name;
}
