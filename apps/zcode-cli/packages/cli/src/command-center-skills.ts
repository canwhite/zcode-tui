import type { TuiSlashCommandSuggestion } from "@zcode/tui";
import type {
  CommandCenterSkill,
  CommandCenterSkillListOutcome,
} from "./command-center/types.js";

export type { CommandCenterSkill, CommandCenterSkillListOutcome };

/**
 * 与内置命令同名的 skill。
 *
 * 内置命令在 `parseSlashCommand` 阶段即被识别为 `known`，结构上**天然优先** ——
 * 同名 skill 永远够不到派发层。这里不改变优先级，只负责**让它可见**，
 * 避免用户以为 skill 坏了（静默遮蔽比报错更难排查）。
 */
export type ShadowedSkill = {
  builtinName: string;
  skill: CommandCenterSkill;
};

export function findShadowedSkills(
  builtinCommandNames: readonly string[],
  skills?: CommandCenterSkillListOutcome,
): ShadowedSkill[] {
  if (!skills) return [];
  const builtin = new Set(builtinCommandNames.map((name) => name.toLowerCase()));
  return skills.skills
    .filter((skill) => builtin.has(skill.name.toLowerCase()))
    .map((skill) => ({ builtinName: skill.name, skill }));
}

/**
 * 把已发现的 skill 渲染成一级命令建议条目。
 *
 * 输出形状与 `listCustomCommandSuggestions` 一致（`name/summary/usage`），
 * 使 TUI 无需区分来源即可渲染。`summary` 中带 `(scope/source)` 后缀，
 * 沿用自定义命令的既有约定。
 */
export function listSkillSuggestions(
  skills?: CommandCenterSkillListOutcome,
  options: { shadowedNames?: ReadonlySet<string> } = {},
): TuiSlashCommandSuggestion[] {
  return (skills?.skills ?? []).map((skill) => ({
    name: skill.name,
    summary: formatSkillSummary(skill, options.shadowedNames),
    usage: `/${skill.name} [task]`,
  }));
}

function formatSkillSummary(
  skill: CommandCenterSkill,
  shadowedNames?: ReadonlySet<string>,
): string {
  const base = `${skill.description} (${skill.scope}/${skill.source})`;
  return shadowedNames?.has(skill.name.toLowerCase())
    ? `${base} [被内置命令 /${skill.name} 遮蔽]`
    : base;
}

/**
 * 渲染 `/help <skill-name>` 的详情。
 *
 * 与内置命令同名时显式指出遮蔽关系与替代触达方式，而不是静默返回内置命令的帮助。
 */
export function formatSkillCommandEntry(
  skill: CommandCenterSkill,
  options: { shadowed?: boolean } = {},
): string {
  const lines = [
    `/${skill.name} [task]`,
    skill.description,
    `Source: ${skill.scope}/${skill.source}`,
  ];
  if (options.shadowed) {
    lines.push(
      `注意：存在同名内置命令 /${skill.name}，它优先于此 skill。`,
      `请改用 /skill ${skill.name} [task] 触达该 skill。`,
    );
  }
  return lines.join("\n");
}

/**
 * 供 `/help` 与未知命令提示使用。与 `listCustomCommandsForHelp` 同构：
 * **失败返回 undefined 而非上抛**，help 输出版本不因 skill 扫描失败而整体不可用。
 */
export async function listSkillsForHelp(deps: {
  listSkills?: () => Promise<CommandCenterSkillListOutcome | undefined>;
}): Promise<CommandCenterSkillListOutcome | undefined> {
  if (!deps.listSkills) return undefined;
  try {
    return await deps.listSkills();
  } catch {
    return undefined;
  }
}

export function findSkillEntry(
  name: string,
  skills?: CommandCenterSkillListOutcome,
): CommandCenterSkill | undefined {
  const normalized = name.trim().replace(/^\/+/, "").toLowerCase();
  return skills?.skills.find((skill) => skill.name.toLowerCase() === normalized);
}
