// Modified by ZCode: 新增「官方插件本地化」自检项：报出本地化覆盖率，副本缺失或损坏时指名失败。
// 变更清单与依据见 README.md「本分支的改动」与 docs/plan-offline-vendoring.md。
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { resolveRuntimeZCodeEndpointOrigin, DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
} from "@zcode/provider-node";
import {
  CONFIG_HOME_COMMANDS_DIR,
  CONFIG_HOME_INSTRUCTION_FILE,
  CONFIG_HOME_SKILLS_DIR,
  getUserConfigHome,
  resolveUserHomeDir,
  isZhipuOfficialAssetUrl,
  readVendoredOfficialAsset,
  resolveVendoredOfficialAssetPath,
  resolveVendoredOfficialRoot,
  ZHIPU_OFFICIAL_ASSET_BASE_URL,
} from "@zcode/adapters";
import type { CliEnv } from "./env.js";
import { parseVendorConfig, readBuiltinVendors, resolveVendor } from "./vendor.js";
import { providerIdFromBaseUrl } from "./personal-vendor.js";

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

/**
 * 解析 engines.node 约束，取出可见的版本下限 [major, minor, patch]。
 *
 * 契约（必须与安装侧 `scripts/install/toolchain.mjs` 的 parseNodeFloor 一致）：
 *   - 本仓库只声明 ">=X.Y.Z"，解析为三元组做逐段比较；
 *   - 出现其它形式时退化为「只取首个版本号，minor/patch 记 0」；
 *   - 完全没有版本号时返回 undefined，由调用方降级为 warn。
 *
 * 只比 major 是不够的：`>=22.13.0` 的下限落在 minor 上，
 * 按 major 比较会把 22.0.0（node:sqlite 仍需 flag）误判为满足。
 */
function parseNodeFloor(raw: string): [number, number, number] | undefined {
  const full = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (full) return [Number(full[1]), Number(full[2]), Number(full[3])];
  const major = raw.match(/(\d+)/);
  return major ? [Number(major[1]), 0, 0] : undefined;
}

/** [major, minor, patch] 逐段比较，返回 actual 是否不低于 floor。 */
function nodeMeetsFloor(
  actualVersion: string,
  [floorMajor, floorMinor, floorPatch]: readonly [number, number, number],
): boolean {
  const [major = 0, minor = 0, patch = 0] = actualVersion.split(".").map(Number);
  if (major !== floorMajor) return major > floorMajor;
  if (minor !== floorMinor) return minor > floorMinor;
  return patch >= floorPatch;
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
    const floor = parseNodeFloor(expectedNode);
    if (!floor) {
      checks.push({
        id: "toolchain.node",
        label: "Node 版本",
        status: "warn",
        detail: `无法解析期望版本「${expectedNode}」，当前 ${actualNode}`,
      });
    } else {
      const meets = nodeMeetsFloor(actualNode, floor);
      checks.push({
        id: "toolchain.node",
        label: "Node 版本",
        status: meets ? "pass" : "fail",
        detail: `当前 ${actualNode}，仓库要求 ${expectedNode}`,
        ...(meets
          ? {}
          : {
              fix: `切换到满足 ${expectedNode} 的 Node（仓库 pin 见 apps/zcode-cli/.node-version）后重试`,
            }),
      });
    }
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
/** 读取个人 Provider 配置里的默认模型选择；无配置或损坏时返回 undefined。 */
function readActiveModelSelection(
  env: CliEnv,
): { providerId?: string; modelId?: string } | undefined {
  const path = resolveDoctorPersonalConfigPath(env);
  if (!existsSync(path)) return undefined;
  const file = readJsonFile(path);
  const config = (file?.config ?? {}) as Record<string, unknown>;
  return config.defaultModelSelection as { providerId?: string; modelId?: string } | undefined;
}

function resolveDoctorPersonalConfigPath(env: CliEnv): string {
  return (
    env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ||
    join(homedir(), ".zcode", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME)
  );
}

function checkProviderSelection(env: CliEnv): DoctorCheck {
  const path = resolveDoctorPersonalConfigPath(env);

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

/**
 * 报出 .env 声明的厂商，以及它与当前生效配置是否一致。
 *
 * "配了新的、跑的仍是旧的"是本功能最难发现的一类失败——它不报错，
 * 只是静默使用另一个厂商。因此这一项必须显式比对，而不是只报配置存在。
 */
function checkVendorDeclaration(env: CliEnv, activeProviderId: string | undefined): DoctorCheck {
  const parsed = parseVendorConfig(env);
  if (!parsed.ok) {
    if (parsed.notConfigured) {
      // 未配置厂商本身没问题（沿用内置默认），但要说清"当前生效的其实由哪里决定"，
      // 否则用户会以为空着就等于没在用任何厂商。
      const activeId = activeProviderId;
      return {
        id: "config.vendor",
        label: "厂商声明",
        status: "warn",
        detail: activeId
          ? `未在 .env 中声明厂商；当前生效由已有配置决定：${activeId}`
          : "未在 .env 中声明厂商（ZCODE_VENDOR_* 缺失）",
        fix: "如需由 .env 驱动厂商，请填写 ZCODE_VENDOR 与 ZCODE_VENDOR_API_KEY",
      };
    }
    return {
      id: "config.vendor",
      label: "厂商声明",
      status: "fail",
      detail: parsed.reason,
      ...(parsed.fix ? { fix: parsed.fix } : {}),
    };
  }

  const vendors = readBuiltinVendors(env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]);
  const resolved = resolveVendor(parsed.config, vendors);

  if (!resolved.ok) {
    return {
      id: "config.vendor",
      label: "厂商声明",
      status: "fail",
      detail: resolved.reason,
      ...(resolved.fix ? { fix: resolved.fix } : {}),
    };
  }

  const declared = parsed.config.vendorName ?? "自建端点";
  const endpoint = parsed.config.baseUrl ?? resolved.resolved.vendor.baseUrl;
  const summary = `${declared} ｜ ${endpoint} ｜ 模型 ${resolved.resolved.model}`;
  const vendor = resolved.resolved.vendor;

  // 声明应对应的 providerId：套餐落 `account:<id>`，其余（含自建端点）落 `personal:<host>`。
  // 必须精确比对这个派生结果，不能拿厂商名去子串匹配——
  // `declared="bigmodel"` 会错误地匹配上 `account:bigmodel-standard-api`，而那是另一个厂商。
  const expectedProviderId =
    vendor.kind === "coding-plan" && vendor.accountProviderId
      ? vendor.accountProviderId
      : /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint)
        ? providerIdFromBaseUrl(endpoint)
        : undefined;

  if (!activeProviderId) {
    return { id: "config.vendor", label: "厂商声明", status: "pass", detail: summary };
  }
  if (expectedProviderId && activeProviderId === expectedProviderId) {
    return { id: "config.vendor", label: "厂商声明", status: "pass", detail: summary };
  }
  // 声明存在但生效的不是它：这正是"配了新的、跑的仍是旧的"。
  // 该状态不会报错、只是静默使用另一个厂商，必须显式告警。
  return {
    id: "config.vendor",
    label: "厂商声明",
    status: "warn",
    detail: `${summary}（当前生效：${activeProviderId}）`,
    fix: "声明与生效不一致：重新执行 make install 或 zcode configure；若仍不一致，说明该厂商配置未被运行期加载",
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
 * 官方插件本地化自检。
 *
 * 为什么放进 doctor：这条链路失效时的表现只是"插件市场是空的"或"插件装不上"，
 * 而原因可能是三种截然不同的情况——副本没随这次安装分发、被某个 .gitignore 漏发、
 * 或副本损坏。三者修法完全不同，却都没有任何界面信号。这里把"覆盖率"变成一个
 * 可自查的数字，让用户不必等到装插件失败才发现。
 *
 * 未找到副本时判 warn 而非 fail：包管理器安装或 SEA 发行形态不一定带仓库目录，
 * 那是合法的部署形态（只是官方插件需要联网）。
 */
function checkVendoredOfficialResources(): DoctorCheck {
  const root = resolveVendoredOfficialRoot();
  if (!root) {
    return {
      id: "plugins.vendored",
      label: "官方插件本地化",
      status: "warn",
      detail: "未找到随附的官方插件副本；官方插件市场与安装将依赖网络",
      fix: "在仓库根执行 node scripts/vendor-resources.mjs fetch",
    };
  }

  const manifest = readVendoredOfficialAsset(`${ZHIPU_OFFICIAL_ASSET_BASE_URL}marketplace.json`);
  if (!manifest) {
    return {
      id: "plugins.vendored",
      label: "官方插件本地化",
      status: "fail",
      detail: `本地清单不可读：${join(root, "marketplace.json")}`,
      fix: "在仓库根执行 node scripts/vendor-resources.mjs fetch",
    };
  }

  let plugins: { name?: unknown; source?: { url?: unknown } }[];
  try {
    const parsed = JSON.parse(manifest.toString("utf8")) as { plugins?: unknown };
    plugins = Array.isArray(parsed.plugins) ? parsed.plugins : [];
  } catch {
    return {
      id: "plugins.vendored",
      label: "官方插件本地化",
      status: "fail",
      detail: "本地清单不是合法 JSON",
      fix: "在仓库根执行 node scripts/vendor-resources.mjs fetch",
    };
  }

  // 只有**智谱自家 CDN** 的来源才要求本地副本。
  //
  // 不能把清单里所有带 url 的插件都算进分母：官方市场 schema 允许条目指向第三方来源
  // （GitHub 等），而按本仓库的资源判据，第三方通用包**不本地化**。若把它们算作"缺失"，
  // doctor 会为一个**按设计就不该存在**的本地副本永久失败——而 doctor 的退出码会被
  // `make install` 透传（install.mjs 的收口自检），于是安装会坏在一个修不好的报错上，
  // 且给的修复建议（vendor-resources fetch）对这个插件根本不适用。
  const declared = plugins.filter(
    (p) => typeof p.source?.url === "string" && isZhipuOfficialAssetUrl(String(p.source.url)),
  );
  const thirdParty = plugins.length - declared.length;
  const missing = declared.filter(
    (p) => resolveVendoredOfficialAssetPath(String(p.source?.url)) === undefined,
  );
  const coverage = declared.length === 0 ? 0 : (declared.length - missing.length) / declared.length;
  const thirdPartyNote = thirdParty > 0 ? `，另有 ${thirdParty} 个第三方来源插件按判据不本地化` : "";

  if (missing.length > 0) {
    return {
      id: "plugins.vendored",
      label: "官方插件本地化",
      status: "fail",
      detail: `覆盖率 ${(coverage * 100).toFixed(0)}%（${declared.length - missing.length}/${declared.length}）；缺失：${
        missing
          .slice(0, 3)
          .map((p) => String(p.name ?? "?"))
          .join("、") || "—"
      }${missing.length > 3 ? ` 等 ${missing.length} 个` : ""}${thirdPartyNote}`,
      fix: "在仓库根执行 node scripts/vendor-resources.mjs fetch",
    };
  }

  return {
    id: "plugins.vendored",
    label: "官方插件本地化",
    status: "pass",
    detail: `覆盖率 100%（${declared.length}/${declared.length}），断网可列出并安装${thirdPartyNote}`,
  };
}

/**
 * 用户级配置面自检。
 *
 * 目的不是校验「目录好不好」，而是让**接轨了但没生效**当场可见：
 * 用户改了 `~/.claude` 却看不到效果时，第一件事是确认 zcode 到底在读哪里。
 *
 * 只列数量与路径，**绝不回显任何配置值**（该目录下可能含密钥）。
 */
function checkConfigHome(env: CliEnv): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const configHome = getUserConfigHome(env);
  const homeExists = existsSync(configHome);
  const skillsDir = join(configHome, CONFIG_HOME_SKILLS_DIR);

  checks.push({
    id: "confighome.path",
    label: "用户级配置家目录",
    status: "pass",
    detail: `${configHome}（${homeExists ? "已存在" : "不存在"}）`,
  });

  if (homeExists) {
    const commandsDir = join(configHome, CONFIG_HOME_COMMANDS_DIR);
    const instructionFile = join(configHome, CONFIG_HOME_INSTRUCTION_FILE);
    checks.push({
      id: "confighome.contents",
      label: "用户级配置",
      status: "pass",
      detail: `skill ${countSkillEntries(skillsDir)} 个，自定义命令 ${countCommandEntries(commandsDir)} 个，指令文件 ${existsSync(instructionFile) ? CONFIG_HOME_INSTRUCTION_FILE : "无"}`,
    });
  } else {
    // 缺失是**正常状态**（不用个人配置的人很多），不是故障 —— 故 PASS 而非 WARN。
    // 但要让用户知道「它不在」以及「放哪能生效」，否则会怀疑是自己的配置写错了。
    checks.push({
      id: "confighome.contents",
      label: "用户级配置",
      status: "pass",
      detail: `未使用（${configHome} 不存在，zcode 不会创建它）`,
      fix: `如需个人 skill / 指令，自行创建 ${configHome} 并放入 ${CONFIG_HOME_SKILLS_DIR}/、${CONFIG_HOME_INSTRUCTION_FILE}`,
    });
  }

  // 存量迁移提示：严格独占已生效，旧路径下的 skill **不再被读取**。
  //
  // 这一段刻意放在 `homeExists` 分支**之外**：既有 `~/.zcode/skills`、
  // 又从未建过 `~/.claude` 的用户，正是受影响最严重的一群 ——
  // 若把提示塞进 `homeExists === true` 分支里，他们恰好收不到迁移提示，
  // skill 会静默消失，且表现与「接轨逻辑写错了」完全一致。
  // 用 env 感知的解析，而不是 `homedir()`：本项要与「skill 实际从哪读」同源，
  // 否则在 HOME 被覆盖的环境（测试、容器、launchd）会指向真实机器家目录，
  // 报出与本次运行无关的迁移提示。
  const legacySkills = join(resolveUserHomeDir(env), ".zcode", CONFIG_HOME_SKILLS_DIR);
  if (countSkillEntries(legacySkills) > 0) {
    checks.push({
      id: "confighome.legacySkills",
      label: "迁移提示",
      status: "warn",
      detail: `检测到旧位置仍有 skill：${legacySkills}（**当前已不再读取**）`,
      fix: `迁移到 ${skillsDir} 后旧位置的 skill 才会重新生效`,
    });
  }

  return checks;
}

/**
 * 汇总安装自检结论。`zcode doctor` 与 `make install` 的收口自检共用这一份实现，
 * 避免出现两套判定标准。
 */

/**
 * 统计目录下「含 SKILL.md」的条目数；目录不存在或不可读时返回 0。
 *
 * 刻意**不用 `Dirent.isDirectory()`**：个人 skill 常以**软链**形式安装
 * （本机 12/13 就是这样），而 `isDirectory()` 对软链返回 false，
 * 会把它们全部漏计 —— 报出「3 个」而实际有 13 个，比不报更误导。
 * 判据与 skill 发现层对齐：有 SKILL.md 才算一个 skill。
 */
function countSkillEntries(directory: string): number {
  try {
    return readdirSync(directory)
      .filter((name) => !name.startsWith("."))
      .filter((name) => existsSync(join(directory, name, "SKILL.md"))).length;
  } catch {
    return 0;
  }
}

/**
 * 统计目录下的自定义命令文件数；目录不存在或不可读时返回 0。
 *
 * 与 skill **判据不同**：命令是**平铺的 `.md` 文件**，不是「含 SKILL.md 的目录」。
 * 早先误用 `countSkillEntries` 统计命令目录，导致 `doctor` 恒报「自定义命令 0 个」，
 * 而 `zcode commands list` 同时能列出命令 —— 自检与实况矛盾，比不报更误导。
 */
function countCommandEntries(directory: string): number {
  try {
    return readdirSync(directory).filter(
      (name) => !name.startsWith(".") && name.toLowerCase().endsWith(".md"),
    ).length;
  } catch {
    return 0;
  }
}

export function collectDoctorReport(gate: DoctorGateOptions): DoctorReport {
  const checks: DoctorCheck[] = [
    ...checkToolchain(gate.env, gate.repoRoot),
    checkCommandReachable(gate.env),
    checkEnvSource(gate),
    checkEndpoint(gate.env),
    checkProviderSelection(gate.env),
    checkVendorDeclaration(gate.env, readActiveModelSelection(gate.env)?.providerId),
    checkBuiltinProviderConfig(gate.env),
    checkVendoredOfficialResources(),
    ...checkConfigHome(gate.env),
  ];
  return {
    ok: !checks.some((check) => check.status === "fail"),
    checks,
  };
}
