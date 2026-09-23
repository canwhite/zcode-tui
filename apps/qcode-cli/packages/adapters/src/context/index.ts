// ============================================================
// Node Context Source Adapter
// ============================================================

import { readFile, stat } from "node:fs/promises";
import { arch, release } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { formatLocalIsoDate } from "@qcode/contracts";
import type {
  ContextSourceDiagnostic,
  ContextSourcePort,
  ContextSourceRequest,
  ContextSourceSnapshot,
  EnvInfo,
  PackageManager,
  ProjectContext,
  ProjectType,
  ResolvedUserInstructionSource,
  ResolvedUserInstructions,
  UserInstructionsOptions,
} from "@qcode/contracts";
import {
  CONFIG_HOME_INSTRUCTION_FILE,
  getUserConfigHome,
} from "../config-home/index.js";
import { resolveGitSnapshot } from "./git-snapshot.js";

const DEFAULT_PRIORITY_FILES = ["AGENTS.md"];
const DEFAULT_MAX_BYTES = 100 * 1024;

export interface NodeContextSourceAdapterOptions {
  env?: NodeJS.ProcessEnv;
}

export class NodeContextSourceAdapter implements ContextSourcePort {
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: NodeContextSourceAdapterOptions = {}) {
    this.env = options.env ?? process.env;
  }

  async resolveContextSources(request: ContextSourceRequest): Promise<ContextSourceSnapshot> {
    const workingDirectory = resolve(request.workingDirectory);
    const diagnostics: ContextSourceDiagnostic[] = [];
    const projectRoot = await findProjectRoot(workingDirectory);

    const envInfo =
      request.envInfo ??
      (await this.detectEnvInfo(workingDirectory, request.effectiveShellDisplayName));
    const userInstructions = request.userInstructions
      ? await resolveUserInstructions(
          {
            ...request.userInstructions,
            workingDirectory: request.userInstructions.workingDirectory ?? workingDirectory,
            projectRoot: request.userInstructions.projectRoot ?? projectRoot ?? undefined,
          },
          diagnostics,
          this.env,
        )
      : undefined;
    const projectContext =
      request.projectContext ?? (projectRoot ? await detectProjectContext(projectRoot) : undefined);

    return {
      workingDirectory,
      envInfo,
      currentDate: request.currentDate ?? formatLocalIsoDate(new Date()),
      userInstructions,
      projectContext,
      diagnostics,
    };
  }

  private async detectEnvInfo(
    workingDirectory: string,
    effectiveShellDisplayName?: string,
  ): Promise<EnvInfo> {
    const shellPath = this.env.SHELL ?? this.env.ComSpec ?? this.env.COMSPEC ?? "";
    const shell = effectiveShellDisplayName ?? (shellPath ? basename(shellPath) : "unknown");
    const gitSnapshot = await resolveGitSnapshot(workingDirectory);
    return {
      cwd: workingDirectory,
      platform: process.platform,
      shell,
      osVersion: `${process.platform} ${release()} ${arch()}`,
      nodeVersion: process.version,
      ...gitSnapshot,
    };
  }
}

export function createNodeContextSourceAdapter(
  options: NodeContextSourceAdapterOptions = {},
): NodeContextSourceAdapter {
  return new NodeContextSourceAdapter(options);
}

async function resolveUserInstructions(
  options: UserInstructionsOptions,
  diagnostics: ContextSourceDiagnostic[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedUserInstructions | undefined> {
  const priorityFiles = options.priorityFiles ?? DEFAULT_PRIORITY_FILES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const projectRoot = options.projectRoot ?? (await findProjectRoot(options.workingDirectory));

  // 注意：**不传 priorityFiles**。用户级文件名固定为 CLAUDE.md，与项目级的
  // AGENTS.md 列表解耦 —— 传进去会让闸门把用户级文件挡掉（见该函数注释第 2 点）。
  const defaultUserInstructionFile = await findDefaultUserInstructionFile(env);
  const workspaceInstructionFile = await findInstructionFile(
    options.workingDirectory,
    projectRoot,
    priorityFiles,
  );
  const candidates = dedupeInstructionFileCandidates([
    defaultUserInstructionFile
      ? { ...defaultUserInstructionFile, scope: "user" as const }
      : undefined,
    workspaceInstructionFile
      ? { ...workspaceInstructionFile, scope: "workspace" as const }
      : undefined,
  ]);
  const sources: ResolvedUserInstructionSource[] = [];

  for (const candidate of candidates) {
    const source = await readInstructionSource(candidate, maxBytes, diagnostics);
    if (source) {
      sources.push(source);
    }
  }

  if (sources.length === 0) return undefined;

  return mergeInstructionSources(sources);
}

async function readFirstTextBytes(path: string, maxBytes: number): Promise<string> {
  const content = await readFile(path);
  return content.subarray(0, maxBytes).toString("utf8");
}

type InstructionFileCandidate = {
  filePath: string;
  fileName: string;
  scope: ResolvedUserInstructionSource["scope"];
};

function dedupeInstructionFileCandidates(
  candidates: Array<InstructionFileCandidate | undefined>,
): InstructionFileCandidate[] {
  const seen = new Set<string>();
  const deduped: InstructionFileCandidate[] = [];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const key = resolve(candidate.filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(candidate);
  }

  return deduped;
}

async function readInstructionSource(
  candidate: InstructionFileCandidate,
  maxBytes: number,
  diagnostics: ContextSourceDiagnostic[],
): Promise<ResolvedUserInstructionSource | undefined> {
  try {
    const info = await stat(candidate.filePath);
    const bytesToRead = Math.min(info.size, maxBytes);
    const content = await readFirstTextBytes(candidate.filePath, bytesToRead);
    return {
      scope: candidate.scope,
      filePath: candidate.filePath,
      fileName: candidate.fileName,
      content,
      bytesRead: Buffer.byteLength(content),
      sizeBytes: info.size,
      truncated: info.size > maxBytes,
    };
  } catch (error) {
    diagnostics.push({
      code: "user_instructions_read_failed",
      message: error instanceof Error ? error.message : "Failed to read user instructions",
      path: candidate.filePath,
    });
    return undefined;
  }
}

function mergeInstructionSources(
  sources: ResolvedUserInstructionSource[],
): ResolvedUserInstructions {
  const primary = sources.find((source) => source.scope === "workspace") ?? sources[0];
  const content = sources.map((source) => source.content).join("\n\n");

  return {
    filePath: primary.filePath,
    fileName: primary.fileName,
    content,
    bytesRead: sources.reduce((sum, source) => sum + source.bytesRead, 0),
    sizeBytes: sources.reduce((sum, source) => sum + source.sizeBytes, 0),
    truncated: sources.some((source) => source.truncated),
    sources,
  };
}

async function findInstructionFile(
  startDir: string,
  projectRoot: string | null,
  priorityFiles: string[],
): Promise<{ filePath: string; fileName: string } | undefined> {
  let current = resolve(startDir);

  while (true) {
    for (const fileName of priorityFiles) {
      const filePath = join(current, fileName);
      if (await isFile(filePath)) {
        return { filePath, fileName };
      }
    }

    if (current === projectRoot || current === dirname(current)) {
      break;
    }

    current = dirname(current);
  }

  return undefined;
}

/**
 * 用户级（全局）指令文件：`~/.claude/CLAUDE.md`。
 *
 * 三点与项目级**刻意不同**，改动前请先读完：
 *
 * 1. 路径来源是配置家目录（经 `getUserConfigHome`，承载 `QCODE_CONFIG_HOME` 覆盖），
 *    而**不是** `home/.zcode`。用户级配置面已统一到 `.claude`，不再读 `.qcode/AGENTS.md`。
 *
 * 2. 闸门与项目级共用同一个 `priorityFiles`（见 `:99` 的 `options.priorityFiles ??
 *    DEFAULT_PRIORITY_FILES`，以及 `:107` 传给 `findInstructionFile`）。
 *    因此这里**只把 `"AGENTS.md"` 换成 `"CLAUDE.md"` 是不够的** ——
 *    `DEFAULT_PRIORITY_FILES` 仍是 `["AGENTS.md"]`，闸门会直接 return undefined。
 *    这里的判定必须独立于 `priorityFiles` 的取值，否则用户级文件永远加载不到。
 *
 * 3. `CLAUDE.md` 常见为**软链**（如指向某个仓库里的文件）。`isFile` 走的是 stat，
 *    会跟随软链，因此软链场景天然可用 —— 不要在这里加 realpath 包含性校验。
 */
async function findDefaultUserInstructionFile(
  env: NodeJS.ProcessEnv,
): Promise<{ filePath: string; fileName: string } | undefined> {
  const filePath = join(getUserConfigHome(env), CONFIG_HOME_INSTRUCTION_FILE);
  if (await isFile(filePath)) {
    return { filePath, fileName: CONFIG_HOME_INSTRUCTION_FILE };
  }

  return undefined;
}

async function detectProjectContext(projectRoot: string): Promise<ProjectContext> {
  let type: ProjectType = "unknown";
  let packageManager: PackageManager | undefined;
  let scripts: Record<string, string> | undefined;
  const buildFiles: string[] = [];

  const packageJsonPath = join(projectRoot, "package.json");
  if (await isFile(packageJsonPath)) {
    try {
      const pkg = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
        scripts?: unknown;
      };
      type = "node";
      if (pkg.scripts && typeof pkg.scripts === "object") {
        scripts = pkg.scripts as Record<string, string>;
      }
    } catch {
      type = "node";
    }
  }

  if (type === "unknown") {
    const pythonIndicators = ["requirements.txt", "pyproject.toml", "setup.py", "Pipfile"];
    for (const file of pythonIndicators) {
      if (await isFile(join(projectRoot, file))) {
        type = "python";
        break;
      }
    }
  }

  if (type === "unknown" && (await isFile(join(projectRoot, "Cargo.toml")))) {
    type = "rust";
  }
  if (type === "unknown" && (await isFile(join(projectRoot, "go.mod")))) {
    type = "go";
  }
  if (type === "unknown") {
    for (const file of ["pom.xml", "build.gradle", "build.gradle.kts"]) {
      if (await isFile(join(projectRoot, file))) {
        type = "java";
        break;
      }
    }
  }

  if (await isFile(join(projectRoot, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  } else if (await isFile(join(projectRoot, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (await isFile(join(projectRoot, "bun.lockb"))) {
    packageManager = "bun";
  } else if (await isFile(join(projectRoot, "package-lock.json"))) {
    packageManager = "npm";
  }

  for (const file of ["Makefile", "docker-compose.yml", "docker-compose.yaml", "Dockerfile"]) {
    if (await isFile(join(projectRoot, file))) {
      buildFiles.push(file);
    }
  }

  return {
    type,
    packageManager,
    scripts,
    buildFiles: buildFiles.length > 0 ? buildFiles : undefined,
  };
}

async function findProjectRoot(startDir: string): Promise<string | null> {
  let current = resolve(startDir);

  while (current !== dirname(current)) {
    if (await hasGitMarker(current)) return current;
    current = dirname(current);
  }

  return null;
}

async function hasGitMarker(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}
