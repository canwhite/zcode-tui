// ============================================================
// Skill Contracts - reusable local instruction packs
// ============================================================

import type { ExecutionContext, TraceContext } from "../tracing/tracer.js";

export type SkillScope = "project" | "user" | "system" | "admin";

/**
 * skill 的来源生态。
 *
 * - `claude` —— `~/.claude/skills`（用户级）或 `<repo>/.claude/skills`（项目级）。
 *   用户级配置面的**首选**来源，优先级高于 `zcode` / `agents`。
 * - `agents` —— `.agents/skills`，Claude/Codex/Cursor 生态的跨工具约定。
 * - `zcode` —— `.zcode/skills`。**用户级已停用**（配置面统一到 `.claude`）；
 *   项目级 `<repo>/.zcode/skills` 仍然有效。
 * - `bundled` / `plugin` / `remote` —— 随包分发、插件提供、远程拉取。
 *
 * 顺序即优先级：`claude` 在前，同名按 root 顺序解析。
 */
export type SkillSource = "claude" | "agents" | "qcode" | "bundled" | "plugin" | "remote";

export type SkillDiagnosticSeverity = "warning" | "error";

export type SkillDiagnosticCode =
  | "skill_root_not_found"
  | "skill_scan_failed"
  | "skill_read_failed"
  | "skill_missing_frontmatter"
  | "skill_invalid_frontmatter"
  | "skill_missing_name"
  | "skill_invalid_name"
  | "skill_missing_description"
  | "skill_description_too_long"
  | "skill_unknown_frontmatter"
  | "skill_duplicate_name"
  | "skill_too_large"
  | "skill_not_found";

export interface SkillRoot {
  path: string;
  scope: SkillScope;
  source: SkillSource;
  priority: number;
  /** 所属 plugin 的完整 id；仅 plugin root 可用。 */
  pluginId?: string;
}

export interface SkillPolicy {
  allowImplicitInvocation?: boolean;
}

export interface SkillMetadata {
  name: string;
  description: string;
  whenToUse?: string;
  pluginName?: string;
  /** 所属 plugin 的完整 id；非 plugin skill 不设置。 */
  pluginId?: string;
  qualifiedName?: string;
  path: string;
  directory: string;
  rootPath: string;
  scope: SkillScope;
  source: SkillSource;
  safeToAutoLoad: boolean;
  frontmatterKeys: string[];
  policy?: SkillPolicy;
}

/** Skill tool result 中允许跨边界传播的最小 metadata；不包含正文或 description。 */
export interface SkillTelemetryMetadata {
  qualifiedName?: string;
  pluginId?: string;
  source?: SkillSource;
}

export interface SkillDiagnostic {
  code: SkillDiagnosticCode;
  severity: SkillDiagnosticSeverity;
  message: string;
  path?: string;
  skillName?: string;
}

export interface SkillLoadOutcome {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
  totalDiscovered: number;
}

export interface SkillContent {
  metadata: SkillMetadata;
  content: string;
  baseDirectory: string;
  bytesRead: number;
  sizeBytes: number;
  truncated: boolean;
}

export interface SkillDiscoverRequest {
  workingDirectory: string;
  roots?: SkillRoot[];
  trace?: TraceContext;
}

export interface SkillLoadRequest {
  name: string;
  workingDirectory: string;
  roots?: SkillRoot[];
  maxBytes?: number;
  trace?: TraceContext;
}

export interface SkillOperationOptions {
  signal?: AbortSignal;
  context?: ExecutionContext;
}

export interface SkillPort {
  discoverSkills(
    request: SkillDiscoverRequest,
    options?: SkillOperationOptions,
  ): Promise<SkillLoadOutcome>;
  loadSkill(request: SkillLoadRequest, options?: SkillOperationOptions): Promise<SkillContent>;
}

export interface SkillConfig {
  enabled: boolean;
  includeInstructions: boolean;
  metadataBudget: number;
  roots: string[];
}
