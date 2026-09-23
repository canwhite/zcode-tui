#!/usr/bin/env node
// 配置家目录接轨的验收关卡（见 docs/plan-claude-config-home.md Phase 2）。
//
// 为什么需要它：这组改动最容易的失效形态是**假通过** —— "skill 能列出来" 可能来自
// 真实的 ~/.claude 恰好有内容，而不是代码真的读对了地方。所以断言全部跑在
// **隔离的 fixture 配置家目录**（ZCODE_CONFIG_HOME 指向临时目录）上，
// 让"读对了"成为可证伪的结论，而不是靠观察真实家目录推断。
//
// 用法：
//   node test/claude-config-home.mjs
//
// 前置：需要已构建的 CLI 产物（apps/qcode-cli/packages/cli/dist/zcode.cjs）。
//       未构建时本脚本直接失败并给出构建命令，不静默跳过。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "apps/qcode-cli/packages/cli/dist/zcode.cjs");

/** fixture 里的 skill 名。刻意取一个真实环境中不可能存在的名字，避免与真家目录混淆。 */
const PROBE_SKILL = "zz-probe-skill";
/** 与内置命令同名的 skill，用于验证遮蔽是「可见的」而非静默丢弃。 */
const SHADOW_SKILL = "model";

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
}

function runCli(args, { env = {} } = {}) {
  const child = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    // 隔离：不让真实 ~/.claude 参与，也不让测试碰到真实家目录。
    env: { ...process.env, ZCODE_CONFIG_HOME: undefined, ...env },
    timeout: 60_000,
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

function writeSkill(root, name, description) {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  );
}

/**
 * 自举语义在适配器层直接验证。
 *
 * 为什么不用 CLI 驱动：自举挂在 `createZCodeApp` 里，而 app 创建需要交互式 TTY
 * 或真实模型会话 —— 两者都不适合放进验收关卡。这里直接对着源文件断言，
 * 覆盖面反而是完整的（幂等 / 开关 / 不预置空目录 / 失败不抛错）。
 */
function checkBootstrapSemantics() {
  const script = `
import { ensureUserConfigHome, CONFIG_HOME_BOOTSTRAP_OPT_OUT_ENV }
  from "./src/config-home/index.js";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const t = () => mkdtempSync(join(tmpdir(), "zcode-boot-"));
const env = (h, extra = {}) => ({ HOME: h, ZCODE_CONFIG_HOME: join(h, ".claude"), ...extra });
const out = {};

let h = t();
let r = await ensureUserConfigHome(env(h));
out.createdOnFirstRun = r.created;
out.readmeSeeded = readdirSync(join(h, ".claude")).includes("README.md");
out.noEmptySkillDir = !readdirSync(join(h, ".claude")).includes("skills");

// 二次运行：不得重复创建，也不得改动用户在配置家目录里放的东西。
// （注意不能用「改写 README 再断言它被保留」来测 —— 那是 ZCode 自己生成的
//  路标文件，不属于用户内容，允许被补写。）
mkdirSync(join(h, ".claude", "skills", "mine"), { recursive: true });
writeFileSync(join(h, ".claude", "skills", "mine", "SKILL.md"), "x");
writeFileSync(join(h, ".claude", "USER_NOTES.txt"), "user content\\n");
r = await ensureUserConfigHome(env(h));
out.idempotent = !r.created && readdirSync(join(h, ".claude")).includes("USER_NOTES.txt");

// 残留态：目录已建但说明文件缺失（上次写到一半失败）—— 必须补写，
// 否则「目录已存在就跳过」会把这次部分成功永久化，用户永远拿不到路标。
const h2 = t();
mkdirSync(join(h2, ".claude"), { recursive: true });
r = await ensureUserConfigHome(env(h2));
out.repairsMissingReadme = readdirSync(join(h2, ".claude")).includes("README.md") && !r.created;

h = t();
r = await ensureUserConfigHome(env(h, { [CONFIG_HOME_BOOTSTRAP_OPT_OUT_ENV]: "1" }));
out.optOutHonored = !r.created;

r = await ensureUserConfigHome({ HOME: t(), ZCODE_CONFIG_HOME: "/proc/nonexistent/x/.claude" });
out.failureDoesNotThrow = Boolean(r.error);

console.log(JSON.stringify(out));
`;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: join(repoRoot, "apps/qcode-cli/packages/adapters"),
      encoding: "utf8",
      env: { ...process.env },
      timeout: 120_000,
    },
  );
  const line = (child.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { error: (child.stderr ?? child.stdout ?? "").slice(-300) };
  }
}

/**
 * MCP 接轨在适配器层验证（与自举同理：走 CLI 需要真实会话）。
 *
 * 重点覆盖两件容易假通过的事：
 *   1. config-home 层真的**进入了最终配置**（曾经只加进 configs 数组、
 *      却被 `resolveEffectiveMcpServers` 的重算整个丢掉）；
 *   2. 优先级方向正确 —— 显式 config.json 压过 .claude，且两条来源都可见。
 */
function checkMcpPrecedence() {
  const script = `
import { createConfig } from "./src/config/config-factory.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = mkdtempSync(join(tmpdir(), "zcode-mcp-prec-"));
const home = join(root, ".claude"); mkdirSync(home, { recursive: true });
const ws = join(root, "ws"); mkdirSync(ws, { recursive: true });
const cfgs = join(root, "cfgs"); mkdirSync(cfgs, { recursive: true });

// 关键：把真实家目录也指到 fixture 里。
// 用户级 MCP 读的是 **~/.claude.json**（家目录下的文件，与 .claude/ 同级），
// 它经 resolveUserHomeDir 解析，只看 HOME —— 不设它就会去读**本机真实**的
// ~/.claude.json，测试于是「用的是别人的配置」却仍然通过。
process.env.HOME = root;
process.env.ZCODE_CONFIG_HOME = home;

writeFileSync(join(root, ".claude.json"), JSON.stringify({
  mcpServers: { "only-user": { command: "cu" }, "tie": { command: "from-claude" } },
  projects: { "/noise": {} },
}));
writeFileSync(join(ws, ".mcp.json"), JSON.stringify({
  mcpServers: { "only-project": { command: "cp" } },
}));
writeFileSync(join(cfgs, "config.json"), JSON.stringify({
  mcp: { servers: { "tie": { command: "from-explicit" } } },
}));

// 变量占位符展开 + 缺失变量处理
writeFileSync(join(ws, ".mcp.json"), JSON.stringify({
  mcpServers: {
    "only-project": { command: "cp" },
    "with-token": { command: "npx", env: { TOKEN: "\${PROBE_TOKEN}" } },
    "missing-var": { command: "npx", env: { TOKEN: "\${PROBE_NOT_SET_ANYWHERE}" } },
    "iso-ok": { command: "npx", isolation: "session" },
  },
}));

const r = createConfig({
  env: { HOME: root, PROBE_TOKEN: "sk-expanded-ok" },
  userConfigPath: join(cfgs, "config.json"),
  workingDirectory: ws,
});
const servers = r.config.mcp.servers;
const sources = r.sources.mcp.serverSources;
console.log(JSON.stringify({
  userLoaded: Boolean(servers["only-user"]),
  projectLoaded: Boolean(servers["only-project"]),
  tieWinner: servers["tie"]?.command,
  tieSource: sources["tie"],
  userSource: sources["only-user"],
  expandedToken: servers["with-token"]?.env?.TOKEN,
  missingVarDropped: servers["missing-var"] === undefined,
  isolationAccepted: Boolean(servers["iso-ok"]),
}));
`;
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: join(repoRoot, "apps/qcode-cli/packages/adapters"),
      encoding: "utf8",
      env: { ...process.env },
      timeout: 120_000,
    },
  );
  const line = (child.stdout ?? "").trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return { error: (child.stderr ?? child.stdout ?? "").slice(-300) };
  }
}

function listSkillsJson(configHome) {
  const { stdout } = runCli(["skills", "list", "--json"], {
    env: { ZCODE_CONFIG_HOME: configHome },
  });
  const start = stdout.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

if (!existsSync(cliPath)) {
  console.error(`未找到构建产物：${cliPath}\n请先执行：pnpm --filter "@zcode/cli..." build`);
  process.exit(1);
}

const fixture = mkdtempSync(join(tmpdir(), "zcode-config-home-"));
writeSkill(fixture, PROBE_SKILL, "Probe skill used to verify config home resolution.");
writeSkill(fixture, SHADOW_SKILL, "Probe skill that collides with a builtin command name.");
// 一个自定义命令：命令是**平铺的 .md 文件**，与 skill 的「目录含 SKILL.md」判据不同。
// 混用两种计数会让 doctor 恒报「自定义命令 0 个」，故在此固定住这个断言。
mkdirSync(join(fixture, "commands"), { recursive: true });
writeFileSync(
  join(fixture, "commands", "probe-command.md"),
  "---\ndescription: probe command\n---\n\nDo the thing.\n",
  "utf8",
);

console.log(`\n配置家目录接轨验收（fixture: ${fixture}）\n`);

try {
  // --- 发现层 ---------------------------------------------------------------

  const isolated = listSkillsJson(fixture);
  assert(
    "隔离配置家目录后能发现其中的 skill",
    Boolean(isolated?.skills?.some((s) => s.name === PROBE_SKILL)),
    `实际: ${JSON.stringify(isolated?.skills?.map((s) => s.name))}`,
  );

  assert(
    "隔离后的 skill 来源标记为 user/claude",
    isolated?.skills?.some((s) => s.name === PROBE_SKILL && s.scope === "user" && s.source === "claude"),
    `实际: ${JSON.stringify(isolated?.skills?.find((s) => s.name === PROBE_SKILL))}`,
  );

  // 这是本组改动最核心的否定断言：真实家目录里的 skill 不得泄漏进来。
  const leaked = (isolated?.skills ?? []).filter(
    (s) => s.scope === "user" && s.source === "claude" && !s.path.startsWith(fixture),
  );
  assert(
    "隔离生效：真实 ~/.claude 的 skill 未泄漏进结果",
    leaked.length === 0,
    `泄漏项: ${JSON.stringify(leaked.map((s) => s.path))}`,
  );

  assert(
    "用户级不再读取 .zcode/skills",
    !(isolated?.skills ?? []).some((s) => s.scope === "user" && s.source === "zcode"),
    `实际: ${JSON.stringify(isolated?.skills?.filter((s) => s.source === "zcode"))}`,
  );

  // --- 一级命令触达层 -------------------------------------------------------

  const help = runCli(["-p", "/help"], { env: { ZCODE_CONFIG_HOME: fixture } });
  assert(
    "/help 输出中出现 skill 一级条目",
    help.stdout.includes(`/${PROBE_SKILL} [task]`),
    `stderr: ${help.stderr.slice(0, 200)}`,
  );

  const skillHelp = runCli(["-p", `/help ${PROBE_SKILL}`], {
    env: { ZCODE_CONFIG_HOME: fixture },
  });
  assert(
    "/help <skill> 给出 skill 详情而非「未知命令」",
    skillHelp.stdout.includes(`/${PROBE_SKILL} [task]`) && !/Unknown slash command/i.test(skillHelp.stdout),
    `实际: ${skillHelp.stdout.slice(0, 200)}`,
  );

  // 未知命令文案应把 skill 也列进可用清单，否则用户无从知道它是一级命令。
  const unknown = runCli(["-p", "/definitely-not-a-command"], {
    env: { ZCODE_CONFIG_HOME: fixture },
  });
  assert(
    "未知命令的可用清单包含 skill",
    unknown.stdout.includes(`/${PROBE_SKILL}`),
    `实际: ${unknown.stdout.slice(0, 300)}`,
  );

  // 同名遮蔽必须是**可见的**，不能静默丢弃。
  assert(
    "与内置命令同名的 skill 被显式标注为遮蔽",
    /被内置命令/.test(help.stdout),
    "未找到遮蔽标注；同名 skill 可能被静默丢弃了",
  );

  // --- doctor 可见性 --------------------------------------------------------

  const doctor = runCli(["doctor"], { env: { ZCODE_CONFIG_HOME: fixture } });
  // 自定义命令必须与 skill **同步**接轨 —— 只改一边就会留下
  // 「skill 接轨了、命令没接轨」的分裂，而这从 skill 侧完全看不出来。
  const cmdFixture = mkdtempSync(join(tmpdir(), "zcode-cmd-"));
  const cmdDir = join(cmdFixture, "commands");
  mkdirSync(cmdDir, { recursive: true });
  writeFileSync(
    join(cmdDir, "zz-probe-command.md"),
    "---\ndescription: probe command\n---\n\nDo the probe thing.\n",
    "utf8",
  );
  const commandsOut = runCli(["commands", "list"], { env: { ZCODE_CONFIG_HOME: cmdFixture } });
  assert(
    "用户级自定义命令从 .claude/commands 读取",
    commandsOut.stdout.includes("zz-probe-command"),
    `实际: ${commandsOut.stdout.slice(0, 300)}`,
  );
  rmSync(cmdFixture, { recursive: true, force: true });

  assert(
    "doctor 报出配置家目录与 skill 数",
    doctor.stdout.includes(fixture) && /skill 2 个/.test(doctor.stdout),
    `实际: ${doctor.stdout.split("\n").filter((l) => /用户级/.test(l)).join(" / ")}`,
  );
  // 命令数与 skill 数用的是**两套判据**；混用会让命令数恒为 0 而 skill 数正常，
  // 自检与 `commands list` 互相矛盾。
  assert(
    "doctor 的自定义命令计数非 0（判据与 skill 不同）",
    /自定义命令 1 个/.test(doctor.stdout),
    `实际: ${doctor.stdout.split("\n").filter((l) => /用户级配置:/.test(l)).join(" / ")}`,
  );

  // 旧位置仍有 skill 时必须提醒 —— 否则那些 skill 会静默消失，
  // 与「接轨逻辑写错了」表现完全一致。
  const legacyHome = mkdtempSync(join(tmpdir(), "zcode-config-home-legacy-"));
  const legacySkills = join(legacyHome, ".zcode", "skills");
  mkdirSync(join(legacySkills, "legacy-probe"), { recursive: true });
  writeFileSync(
    join(legacySkills, "legacy-probe", "SKILL.md"),
    "---\nname: legacy-probe\ndescription: legacy\n---\n",
    "utf8",
  );
  // 用隔离的 HOME 跑，避免碰到真实 ~/.zcode。不设 ZCODE_CONFIG_HOME，
  // 让配置家目录落到这个临时 HOME 下的 .claude（不存在）。
  const doctorLegacy = spawnSync(process.execPath, [cliPath, "doctor"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, HOME: legacyHome, ZCODE_CONFIG_HOME: undefined },
    timeout: 60_000,
  });
  assert(
    "doctor 对旧位置残留 skill 给出迁移提示",
    /迁移提示/.test(doctorLegacy.stdout ?? ""),
    `实际: ${(doctorLegacy.stdout ?? "").split("\n").filter((l) => /用户级|迁移/.test(l)).join(" / ")}`,
  );
  rmSync(legacyHome, { recursive: true, force: true });

  // --- 自举语义 -------------------------------------------------------------

  const boot = checkBootstrapSemantics();
  assert(
    "首次运行创建配置家目录并留下 README 路标",
    boot.createdOnFirstRun === true && boot.readmeSeeded === true,
    `实际: ${JSON.stringify(boot)}`,
  );
  assert(
    "自举不预置空 skills/（空目录会被误判为「已有配置」）",
    boot.noEmptySkillDir === true,
    `实际: ${JSON.stringify(boot)}`,
  );
  assert(
    "自举幂等：不重复创建，且不改动用户放在配置家目录里的内容",
    boot.idempotent === true,
    `实际: ${JSON.stringify(boot)}`,
  );
  assert(
    "自举残留态可自愈：目录在但说明文件缺失时会补写",
    boot.repairsMissingReadme === true,
    `实际: ${JSON.stringify(boot)}`,
  );
  assert(
    "ZCODE_NO_CONFIG_HOME_BOOTSTRAP=1 时只读不写",
    boot.optOutHonored === true,
    `实际: ${JSON.stringify(boot)}`,
  );
  assert(
    "自举失败降级为 error 而非抛错（不阻断启动）",
    boot.failureDoesNotThrow === true,
    `实际: ${JSON.stringify(boot)}`,
  );

  // --- MCP 接轨 -------------------------------------------------------------

  const mcp = checkMcpPrecedence();
  assert(
    "MCP：用户级（~/.claude.json）server 进入生效配置",
    mcp.userLoaded === true,
    `实际: ${JSON.stringify(mcp)}`,
  );
  assert(
    "MCP：项目级（<repo>/.mcp.json）server 进入生效配置",
    mcp.projectLoaded === true,
    `实际: ${JSON.stringify(mcp)}`,
  );
  assert(
    "MCP：显式 config.json 压过 .claude（方向不能反）",
    mcp.tieWinner === "from-explicit",
    `实际: ${JSON.stringify(mcp)}`,
  );
  assert(
    "MCP：来源被正确标注为 config-home",
    mcp.userSource === "config-home",
    `实际: ${JSON.stringify(mcp)}`,
  );
  // `${VAR}` 必须展开：Claude Code 的 .mcp.json 惯例用它引用密钥。
  // 不展开会把字面量交给适配器，表现为远端 401，而配置里看着是对的。
  assert(
    "MCP：`${VAR}` 被展开为环境变量的值",
    mcp.expandedToken === "sk-expanded-ok",
    `实际: ${JSON.stringify(mcp.expandedToken)}`,
  );
  // 变量缺失时应整条跳过并报名字，而不是把 `${X}` 原样发出去。
  assert(
    "MCP：环境变量缺失的 server 被整条跳过（不静默发出占位符）",
    mcp.missingVarDropped === true,
    `实际: ${JSON.stringify(mcp)}`,
  );
  // `isolation` 在契约与运行态中都存在，曾因漏在 strict schema 里而被整条丢弃。
  assert(
    "MCP：带 isolation 字段的 server 不被丢弃",
    mcp.isolationAccepted === true,
    `实际: ${JSON.stringify(mcp)}`,
  );

  // --- 隔离性回归 -----------------------------------------------------------

  // 默认落点必须来自 OS 家目录解析，**不能**拿 process.env.HOME 直接比字符串：
  // 在 HOME 带尾斜杠、未设置、或与 OS 解析不一致的机器上，
  // 前缀比较会误报失败 —— 那是测试的脆弱，不是产品的缺陷。
  const realHomeResult = runCli(["skills", "list", "--json"]);
  const realHomeSkills = JSON.parse(
    realHomeResult.stdout.slice(realHomeResult.stdout.indexOf("{")),
  );
  const osHome = homedir();
  assert(
    "未设 ZCODE_CONFIG_HOME 时仍读取真实家目录（默认路径未被破坏）",
    realHomeSkills.skills.length > 0 &&
      realHomeSkills.skills.every((s) => s.path.startsWith(osHome)),
    `osHome=${osHome} 实际: ${JSON.stringify(realHomeSkills.skills.slice(0, 3).map((s) => s.path))}`,
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("\n失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
