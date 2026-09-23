# Plan: 让 zcode 以 ~/.claude 为配置家目录，并让个人 skill 升为一级命令

> 将 zcode 的三条用户级配置面（skill / MCP / 指令文件）切到 `~/.claude`，并把个人 skill 提升为与内置命令同级、可直接触达的一级命令。

> **上游**：[docs/painpoint-claude-config-home.md](painpoint-claude-config-home.md)（痛点拆解）
>
> **已确认决策**（来自本次澄清，作为本文的 ground truth）：
> 1. **范围**：三条线全做 —— skill + MCP + 指令文件。
> 2. **家目录策略**：`~/.claude` **独占**，不再读 `~/.zcode` 下的用户级 skill / 指令。
> 3. **层级**：用户级 + 项目级都接。

## Context

用户同时使用 Claude Code 与 zcode，已在 `~/.claude` 下积累了 15 个 skill（`pain-decomposition`、`planning`、`pre-mortem` 等）、一份用户级指令（`~/.claude/CLAUDE.md`，**是指向 `/Users/doing/Desktop/zack-skills/CLAUDE.md` 的软链**）。zcode 目前对这些一律不可见，配置被迫维护两份。

三条现状事实决定了本计划的形状：

- **`config.storage.dir` 不是配置家目录**。`apps/zcode-cli/packages/contracts/src/config/index.ts:303` 的 `~/.zcode` 是**整个运行时数据树**的根 —— session db、凭据、provider 配置、日志、rollout、workflows 全在其下（`bootstrap/src/app/paths.ts:5` 的 `getCliStorageRoot` 再派生出 `cli/plugins`、`cli/{debug,rollout}`）。**因此本计划不改 `storage.dir`**：那会把所有既有会话、凭据、记忆一并搬到 `~/.claude`，属于远超本次诉求的破坏性迁移。
- **skill 根目录已有多生态先例**。`adapters/src/skills/roots.ts:94-105` 的 `skillRootsForBase` 已经是「`.zcode` 优先 + `.agents` 兜底」的合并语义，且 `adapters/src/skills/index.ts:31-36` 的 `PLUGIN_MANIFEST_RELATIVE_PATHS` 里已经包含 `.claude-plugin/plugin.json`。`.claude` 生态在本仓库并非全新概念，本次是把它提升为用户级 skill 的主来源。
- **「用户自定义名字出现在一级」已有成熟通道**。自定义命令（`~/.zcode/commands`）与内置命令同列于 `AVAILABLE_COMMANDS`，但它们**不被 `parseSlashCommand` 识别**，而是解析为 `type === "unknown"` 后在 prompt 层异步探测（`cli/src/prompt-command.ts:257-265`、`isResolvableCustomCommand` at `:458`）。**skill 升一级应复用这条通道**，而不是去动同步的 `parseSlashCommand`。

约束：不破坏既有会话/凭据（见上）；`~/.claude/settings.json` 内含明文凭据，任何新读取路径都必须遵守「只列键名、不回显值」；`.claude` 不存在时需能自举出同构目录。

## Goal

- `~/.claude/skills/*` 与 `<repo>/.claude/skills/*` 下的合法 skill 全部可被发现，并**出现在一级命令清单**中，输入 `/pain-decomposition` 即可直接加载执行，无需经 `/skill`。
- 用户级指令从 `~/.claude/CLAUDE.md` 读取（含软链场景）；项目级同样认 `<repo>/CLAUDE.md`。
- 用户级 MCP server 配置可被解析并连接，且与既有插件级来源的优先级确定。
- `~/.claude` 不存在时首次运行可自举出与现有 `.claude` 同构的目录，且幂等。
- 上述状态可在 `doctor` 中自查。

## Plan

### Phase 1 — 配置家目录抽象（先立地基，不改行为）

1. **引入配置家目录解析层**。在 `apps/zcode-cli/packages/bootstrap/src/app/paths.ts` 增加 `getUserConfigHome(env)`，返回 `~/.claude` 的解析结果，作为**用户级配置面**的唯一来源。刻意与 `getCliStorageRoot`（运行时数据）并列而非替代，避免误伤 session/凭据。
2. **自举同构目录**（对应痛点 F-007）。`~/.claude` 不存在时按需创建 `skills/`、`CLAUDE.md` 等与现有 `.claude` 同构的结构。要求：幂等（重复启动不覆盖、不重复创建）、失败不留半成品（临时目录 + 原子 rename，或「只在缺失时才 mkdir」的逐步创建）。若已存在则**只读不写**。

   > ✅ **已按折中方案实现（2026-09-22）**：做**轻量自举**，不装任何外部工具。
   >
   > 曾提议的「没 `.claude` 就自动安装 Claude Code」已否决，理由记在此处备查：
   > 1. 那是**静默安装第三方软件**（全局 npm 包 + 联网），量级远超建目录；
   > 2. 会让 zcode 变成 Claude Code 的**产品依赖** —— 二者应共享目录约定，不共享安装关系；
   > 3. 与本分支「除 npm 包外不依赖远程资源」的离线目标**直接冲突**。
   >
   > **实际做法**：`~/.claude` 不存在时，创建目录 + 写入一个 `README.md` 说明文件
   > （skill / 指令 / 命令各自的落点）。一个文件、零网络、零副作用、完全可逆，
   > 解决「新用户找不到入口」这个真问题，而不引入上述三个问题。
   >
   > 约束（已由 `test/claude-config-home.mjs` 断言）：幂等（用户改动保留）、
   > **不预置空 `skills/`**（空目录会被误判为「已有配置」）、失败降级为 error 不抛错、
   > `ZCODE_NO_CONFIG_HOME_BOOTSTRAP=1` 可关闭。
   >
   > **挂载点**：`bootstrap/src/app/create-app.ts`（随 app 创建触发一次）。
   > 刻意**不放 `main()`** —— 那里在每个 plugin-host 子进程里都会跑一遍。
3. **`doctor` 暴露生效来源**（对应痛点 F-009）。报出：配置家目录路径、`source`（existing / self-bootstrapped）、各来源档位扫到的 skill / MCP 数量。MCP 只列 server 名，**不回显 `env` 与任何密钥**。

### Phase 2 — skill 接轨 + 升为一级命令（核心闭环）

4. **把 `.claude/skills` 接入 skill 根目录并移除 `.zcode` 根**（对应痛点 F-002）。
   > ✅ **决策已定**（Open Questions 第 1 条）：严格独占。**可直接实现，无阻塞。**
   - 改 `adapters/src/skills/roots.ts:94-105` 的 `skillRootsForBase`，产出顺序为：`<base>/.claude/skills`（`source: "claude"`，最高优先）→ `<base>/.agents/skills`。**删去 `.zcode` 根**。
   - 用户级与项目级共用该函数，故 `resolveDefaultSkillRoots`（`:20`）与项目级目录遍历（`:49-53`）**无需改动**即同时生效。
   - 需要在 `@zcode/contracts` 的 `SkillSource` 联合类型中新增 `"claude"`（`contracts/src/skills/index.ts:9`）。
   - **同构改动**：`adapters/src/commands/roots.ts:10,27` 的 `ZCODE_DIR` 同样要移除，否则会出现「skill 已接轨、自定义命令仍读 `.zcode`」的分裂。
   - ⛔ **同样只作用于用户级**：`.zcode` 根的移除必须限定在 `scope === "user"` 分支，**项目级 `<repo>/.zcode/` 保持原样**（见上方「项目级边界」）。两个 `roots.ts` 都是 `scope` 无关的共用函数，无条件删除会同时误伤项目级。
   - **存量迁移提示必做**：启动时检测到 `~/.zcode/skills` 非空即输出一次可见提示，不因本机为空而跳过（见 Pre-Mortem 对应条目）。
5. **把 skill 并入一级命令清单**（对应痛点 F-003）。在 `cli/src/command-center-custom.ts:40` 的 `listCustomCommandSuggestions` 同层新增 `listSkillSuggestions(skills)`，由 `cli/src/command-center/slash-commands.ts:238` 的 `listSlashCommandSuggestions` 一并拼接，使建议列表 = 内置命令 ∪ 自定义命令 ∪ 个人 skill。
6. **复用 `unknown` 通道完成异步派发**（对应痛点 F-003，关键设计）。**不改**同步的 `parseSlashCommand`。在 `cli/src/prompt-command.ts` 中，对 `type === "unknown"` 的命令：先按既有逻辑探测自定义命令（`:458` `isResolvableCustomCommand`），未命中则**新增一次 skill 名探测**；命中即用既有的 `buildManualSkillPrompt(skillName, task)`（`cli/src/command-center/slash-commands.ts:218`）改写本回合 prompt，与 `/skill <name> task` 走**完全同一条**执行路径。
   - 判据必须与自定义命令对齐：**只有「不存在」才算不命中**，读盘失败/解析错误不得静默降级为「交给模型」。
   - 顺序：内置 > 自定义命令 > skill（保持既有行为不回退）。
7. **重名防护**（对应痛点 F-004）。已实测：现有 19 个内置命令（`compact/dwf/effort/expert/fork/goal/help/init/locale/login/logout/mcp/mode/model/new/plugins/resume/rewind/skill`）与你 `~/.claude/skills` 下 15 个 skill **当前零重名**。但仍需实现规则以防未来冲突：内置命令在 `parseSlashCommand` 阶段即被识别为 `known`，**结构上已天然优先**，skill 永远够不到；需补的是**可见性** —— 建议列表中对与内置同名的 skill 显式标注「被内置命令遮蔽」而非静默丢弃，`doctor` 同步报出。

### Phase 3 — 指令文件接轨

8. **用户级指令改读 `CLAUDE.md`，移除 `.zcode/AGENTS.md`**（对应痛点 F-006）。
   > ✅ **决策已定**（Open Questions 第 2 条）：全局 system prompt 使用 `~/.claude/CLAUDE.md`，**无 `AGENTS.md` 兜底**。
   - **只改 `findDefaultUserInstructionFile`（`:229-241`，用户级）**：把 `join(resolveUserHomeDir(env), ".zcode", "AGENTS.md")` 改为经 `getUserConfigHome` 解析的 `CLAUDE.md`。
   - **同处第二道闸门**：`:233` 的 `if (!priorityFiles.includes("AGENTS.md")) return undefined;` 是**用户级专属**的早退闸门（已读代码确认，项目级不经过它）。改文件名时若不同步，会出现「路径改了但仍被闸门挡住」的静默失效。
   - ⛔ **`DEFAULT_PRIORITY_FILES`（`:24`）不要改。** 它同时被用户级（`:103`）和项目级（`findInstructionFile`，`:107` → `:212` 的 `for (const fileName of priorityFiles)`）使用。一旦给它加上 `"CLAUDE.md"`，**项目级解析也会开始匹配 `<repo>/CLAUDE.md`**，超出本次范围（见上方「项目级边界」）。
     - 正确做法：用户级用**独立常量**或直接内联 `"CLAUDE.md"`，与 `DEFAULT_PRIORITY_FILES` 解耦。
     - 若确实希望 `priorityFiles` 的调用方能覆盖用户级文件名，则需把「用户级文件名」与「项目级文件名列表」拆成两个参数——但**本次不做**，保持最小改动。
   - **项目级行为不变**：`<repo>/AGENTS.md` 的语义保持不变，本次不为项目级新增 `CLAUDE.md` 识别。
   - **软链必须跟随**：`~/.claude/CLAUDE.md` 是指向 `/Users/doing/Desktop/zack-skills/CLAUDE.md` 的软链（119 行），读取路径不得做 realpath 包含性校验而误拒。
   - **`/init` 无需改**：`buildInitAgentsPrompt`（`bootstrap/src/builtin-prompt-command.ts:19`）产出的是**项目级** `AGENTS.md`（help 文案明写「targets the workspace root, not the user default」），项目级语义本次不变，故**保持原样**。
     - 唯一需确认的是：`/init` 在**已存在** `<repo>/AGENTS.md` 时会编辑而非覆盖（help 文案已如此约定），不会误伤用户级 `CLAUDE.md`。验证时走一遍即可。

### Phase 4 — MCP 接轨

9. **新增用户级 MCP 配置来源**（对应痛点 F-005）。当前 MCP 只从插件根解析（`adapters/src/plugins/mcp.ts:26-27`：插件根下 `.mcp.json` 或 `manifest.mcpServers`），**不存在用户级档位**。

   > ✅ **已实现（2026-09-22）**。新增 `adapters/src/config-home/mcp.ts`，接线点在
   > `config/config-factory.ts` 的 MCP 解析链。
   >
   > **实现了两个实现陷阱，记此备查**：
   > 1. **只往 `configs` 数组里加一层是不够的。** `config-factory.ts` 里
   >    `resolveEffectiveMcpServers` 会**从头重算** `mcp.servers`，完全不复用
   >    `mergeConfigs` 的结果 —— 新加的那层会被静默丢掉。必须把 config-home 的
   >    server 显式传进该函数。这是整件事里最容易踩空的一处。
   > 2. **MCP 有自己的优先级规则**：该函数内注释明确写着
   >    「user config shadows project config」，与全局配置优先级相反。接入时必须
   >    顺着这条既有规则，不能按全局优先级推导。
   >
   > **校验复用**：直接复用 `config/schema.ts` 的 `mcpServerSchema`（已导出）。
   > 它的 preprocess 本就为**外部 Agent 配置导入**而写 —— 处理 `environment` → `env`、
   > `remote` → `http`、legacy `enable` 字段、provider 私有 timeout 字段，
   > 并从 `command` 推断 `stdio`。这正是 Claude Code 的 MCP 条目形态，
   > **无需另写一套解析**；另写反而会让同一份配置在两个入口行为不一致。
   >
   > **安全**：`loadMcpServersFromConfigHome` 的返回值只含结构化的 `skipped`
   > （名字 + 原因），**从设计上就不可能把 `env`/`headers` 的值带进日志或 doctor**。
   - **用户级落点：`~/.claude.json` 的顶层 `mcpServers` 键**。这是 Claude Code 用户级 MCP 的实际位置，语义上最不意外，且**只需只读解析该键**，不触碰同样存在于该文件中的大量客户端本地状态。本项目当前该键不存在（实测 0 个 server），属于纯增量。
   - **项目级落点：`<repo>/.mcp.json` 的 `mcpServers` 键**。注意该文件名在本仓库已被**插件根**占用，但二者根目录不同（插件包根 vs 工作区根），需确保解析路径不互相污染。
   - **优先级的默认取法：项目级 > 用户级 > 插件级**（最具体者优先，与 Claude Code 行为一致）。此条需在实现前与 Claude Code 实测行为对齐。
   - 任一档位缺失 = 干净的 no-op，不报错、不阻塞启动。
   - 单条配置非法时**只跳过该条并报条目名**，不因一条坏配置丢掉整份配置。

### Phase 5 — 收尾

10. **`/skill` 的处置**。建议**保留 `/skill <name>` 作为兼容别名**（`~/.claude/skills` 的 `RESOLVER.md` 及 zack-skills 的既有文档都按 `/skill` 语义书写），本次不移除。用户原话是「甚至你可以去掉」，属可选项；移除是用户可见的破坏性变更，收益（省一个命令名）远小于风险。
11. **更新文档**：`README.md` / `README.en.md` 中关于配置路径与 skill 发现的描述。

## Think — Debug Methodology

- **先读源码再假设**：`parseSlashCommand` 是同步的、`isResolvableCustomCommand` 是异步的，两者的边界是本计划最容易出错的地方。动 skill 派发前先把 `prompt-command.ts:250-280` 与 `:445-480` 完整读一遍——那段注释（`:257-265`）已明确记录过一次「未知命令被早退吞掉」的历史 bug，**不要重蹈**。
- **在框架边界打日志**：skill 根目录解析（`resolveDefaultSkillRoots` 的返回数组）、`listSlashCommandSuggestions` 的拼接结果、`unknown` 命令的三段判定（内置 / 自定义 / skill）——每处都打一行带 `[DEBUG-SKILL]` 前缀的结构化日志，便于事后 `grep -r "\[DEBUG-SKILL\]"` 一次性清理。
- **定位顺序**：先确认「扫到了没有」（roots 数组 + 文件系统实际内容），再确认「列出来了没有」（`AVAILABLE_COMMANDS` / 建议列表），最后才查「派发了没有」（prompt 是否被改写）。三段的失败表现完全不同，混在一起排查会绕远。
- **绕开客户端验证**：`zcode skills list` 是现成的只读入口（`cli/src/skills-command.ts`），先用它验证发现层，比经 TUI 快得多。

## Do — Verification Strategy

- **Build**：`pnpm build` —— 必须通过。
- **静态分析 / 类型检查**：`pnpm typecheck` —— 全仓零错误。新增 `SkillSource: "claude"` 后，确认所有对 `SkillSource` 做 `switch` / 排他的地方都已覆盖（`grep -rn "SkillSource" apps/ packages/`）。
- **Lint**：`pnpm lint` —— 零错误。
- **运行时验证（发现层）**：`zcode skills list` 应列出 `~/.claude/skills` 下的 15 个 skill，且来源标注为 `claude`。
- **运行时验证（触达层，必须走真实 TUI/CLI，不能只看编译）**：
  1. 在仓库内运行 `pnpm --filter @zcode/cli dev`，输入 `/` 确认 15 个个人 skill 与内置命令**同屏出现**。
  2. 输入 `/pain-decomposition`（不带参数）确认被识别为 skill 而非交给模型。
  3. 输入 `/pain-decomposition <task>` 确认参数正确透传。
  4. 输入 `/skill pain-decomposition <task>` 确认旧路径仍可用且行为一致。
- **运行时验证（指令文件）**：确认 `~/.claude/CLAUDE.md`（软链）内容进入上下文；构造 `CLAUDE.md` 与 `AGENTS.md` 并存场景，确认行为符合定死的优先级。
- **运行时验证（MCP）**：构造一个最小用户级 MCP server 定义，确认 `zcode mcp list` 能列出并连接；再构造一条非法条目，确认**只跳过该条**且报出条目名；确认 `env` 值不出现在任何日志或 `doctor` 输出中。
- **逻辑正确性 —— 必须手工走完的执行路径**：
  - `unknown` 命令的三段判定：内置命中 / 自定义命令命中 / skill 命中 / 三者皆不命中（应交给模型）。
  - skill 与内置命令**同名**时：应被内置遮蔽，且在一级清单中有可见标注。
  - `~/.claude` 不存在时：自举成功；重复运行不重复创建。
  - `~/.claude` 存在但**不可读**时：明确报错，**不得静默回退到 `~/.zcode`**（那会让用户误以为接轨成功）。
  - `~/.claude.json` 不存在 / 无 `mcpServers` 键：干净 no-op。
  - 项目级 `<repo>/.claude/skills` 与用户级同名时：按 root priority 解析，行为与既有 user/project 语义一致。

## Adjust — Rollback and Global Scan

- **回滚路径**：本计划是**纯增量 + 一处重定向**，回滚面很小。
  - 增量部分（新根目录、新建议来源、新 MCP 档位）删除即可，不影响既有行为。
  - 唯一的行为改写是 `adapters/src/context/index.ts:237` 的指令文件路径与 `skillRootsForBase` 的合并顺序——两者都是单点改动，revert 该 hunk 即恢复原状。
  - 所有改动不迁移、不删除任何既有数据，`~/.zcode` 下的会话与凭据全程未被触碰。
- **全局扫描（必做，勿只改单点）**：`.zcode` 作为用户级配置面的引用不止一处，改完 `skills/roots.ts` 后**必须**扫描同类：
  - `adapters/src/commands/roots.ts:10,27` —— 自定义命令根，与 skill 根是**同构代码**，二者若不同步会造成「skill 接轨了、命令没接轨」的不一致。
  - `adapters/src/context/index.ts:237` —— 用户级指令。
  - `grep -rn 'join(homedir(), "\.zcode"' apps/zcode-cli/packages --include='*.ts'` —— 一次性列出全部直连点，逐个判定「这是配置面还是运行时数据」。**配置面改，运行时数据不改**。这个判定必须逐条写下来，不能凭印象批量改。
- **向后兼容（缺口已封口）**：`~/.zcode/skills` 与 `~/.zcode/AGENTS.md` 的处置已定为**严格独占、直接移除**（Open Questions 第 1 条）。因此存在一处**有意的破坏性变更**：存量用户升级后旧路径不再生效。
  - 补偿措施不是保留旧根，而是**启动期可见提示 + README 迁移表**（见 Pre-Mortem「存量用户迁移」条目）。
  - 回滚方式：revert `skillRootsForBase` 的 `.zcode` 根删除 hunk 即恢复旧读取路径；**旧文件全程未被删除**，故回滚无数据损失。
  - ⚠️ 再次确认边界：本条只涉及**配置面**（skills / 指令），**不含** `config.storage.dir` 指向的运行时数据树——见 Out of Scope 的边界澄清。

## Open Questions

1. ✅ **已决策（2026-09-22）：严格独占，移除 `~/.zcode` 作为用户级配置面。**
   用户原话：「移除，我不需要 `~/.zcode`」。因此：
   - `skillRootsForBase` **移除 `.zcode` 根**，用户级 skill 只从 `~/.claude/skills` 读取。
   - 用户级指令**不再**读 `~/.zcode/AGENTS.md`，只读 `~/.claude/CLAUDE.md`。
   - **`.agents` 根保留**（用户未否决；它是 Claude/Codex/Cursor 跨工具生态约定，属互操作面而非 zcode 私有面）。最终顺序：`<base>/.claude/skills` → `<base>/.agents/skills`。
   - 存量迁移提示为**必做项**（见 Pre-Mortem「存量用户迁移」风险条目），不得因本机无 `~/.zcode/skills` 而跳过。
2. ✅ **已决策（2026-09-22）：全局 system prompt 使用 `~/.claude/CLAUDE.md`。**
   用户原话：「全局的 system prompt 也可以使用 `.claude` 中的 `CLAUDE.md`」。
   - 用户级指令文件 = `~/.claude/CLAUDE.md`（唯一来源，无 `AGENTS.md` 兜底）。
   - 项目级仍认 `<repo>/CLAUDE.md`；与项目级 `AGENTS.md` 并存时的顺序沿用「`.claude` 优先」（`CLAUDE.md` → `AGENTS.md`），保持与 skill 根一致的优先级心智模型。
   - ✅ 与 `/init` **无冲突**（已读源码确认）：`buildInitAgentsPrompt` 产出的是**工作区** `AGENTS.md`，且提示词显式禁止写用户级文件（`Do not write ~/.zcode/AGENTS.md`）。用户级与项目级是不同作用域，`/init` **保持原样**。
   - ⛔ 实现时注意：**不要改 `DEFAULT_PRIORITY_FILES`（`adapters/src/context/index.ts:24`）**，它同时被项目级复用；用户级文件名需与之解耦。
3. **用户级 MCP 落点是否接受 `~/.claude.json`？** 该文件 76KB，99% 是客户端本地状态（history、projects、onboarding），我们只读顶层 `mcpServers` 键。若认为读取该文件风险过高，备选是只做项目级 `<repo>/.mcp.json`，用户级推迟到真有 server 时再做（当前该键不存在，推迟无实际损失）。
4. **`<repo>/.mcp.json` 与插件根的 `.mcp.json` 是否需要显式区分？** 二者文件名相同、根目录不同。需确认解析层不会把工作区根的 `.mcp.json` 误当插件清单。
5. **MCP 三级同名优先级**需与 Claude Code 实测行为对齐（推测为 项目 > 用户 > 插件），本计划按此实现，验证时以实测为准。
6. **`skill.<path>.enable=false` 的既有禁用机制**（`adapters/src/skills/index.ts:38-40`）对新的 `.claude` skill 是否同样适用？这些禁配项是按绝对路径记录的，接入新根后路径形态变化，需确认禁用清单仍能正确命中。

## 范围边界（已与用户确认 2026-09-22）

> 用户原话：「配置面都取 `.claude`，它运行时候的数据可以都留在 `.zcode`，这样可以吧」—— 确认无误，这就是本计划的范围。

**一句话判据：配置读 `.claude`，数据留 `.zcode`。**

| 面 | 落点 | 是否本次改动 |
|---|---|---|
| skill（用户级 / 项目级） | `~/.claude/skills`、`<repo>/.claude/skills` | ✅ 改 |
| 全局指令 | `~/.claude/CLAUDE.md` | ✅ 改 |
| 自定义命令 | `~/.claude/commands` | ✅ 改 |
| 用户级 MCP | `~/.claude.json` 的 `mcpServers` | ✅ 改（Phase 4） |
| session db | `~/.zcode/cli/db/db.sqlite` | ❌ 留 |
| 凭据 | `~/.zcode/v2/credentials.json` | ❌ 留 |
| 厂商配置 | `~/.zcode/v2/provider_config.json` | ❌ 留 |
| 日志 / rollout / memories | `~/.zcode/cli/{log,rollout,memories}` | ❌ 留 |

**实现要点（易错处）**：

- `config.storage.dir` **不动**，继续是 `~/.zcode`。它是数据面的根，与配置面正交。
- 用户级与**项目级**要分开看：用户级配置根从 `.zcode` 移除，但**项目级 `<repo>/.zcode/` 的行为不在本次改动内**（见下方「项目级边界」）。
- `.agents` 保留（用户已确认），最终顺序 `<base>/.claude/skills` → `<base>/.agents/skills`。

### 项目级边界（需在实现时保持）

`skillRootsForBase(baseDirectory, scope, ...)` 被用户级与项目级**共用**。移除其中的 `.zcode` 根会同时影响两者，因此需明确：

- **用户级**：`~/.zcode/skills` 移除（已确认）。
- **项目级**：`<repo>/.zcode/skills` 与 `<repo>/.zcode/config.json` 是**仓库内的工程配置**，与「个人配置放哪」是不同的问题，**本次不动**。若一并移除，会打断既有仓库的本地配置，超出用户诉求。

→ 实现上应让「移除 `.zcode`」只作用于 `scope === "user"` 的分支，而非无条件删除。**这是本次最容易顺手改错的地方。**

> 另注：项目级指令文件（`<repo>/AGENTS.md`）是**仓库里**的约定文件，不属于「全局 system prompt」范畴。本计划只把**用户级**指令切到 `CLAUDE.md`；`/init` 生成的项目级 `AGENTS.md` 语义保持不变。

## Out of Scope

- **不迁移 `~/.zcode` 下的运行时数据**（session db、凭据、provider 配置、记忆、日志、rollout）——它们继续留在 `~/.zcode`。**`config.storage.dir` 不改**。

  > ⚠️ **边界澄清（重要）**：用户原话「移除，我不需要 `~/.zcode`」是在回答「`~/.zcode/skills` 与 `~/.zcode/AGENTS.md` 的处置」这一具体问题时说的，本计划据此**只移除配置面**。
  >
  > 但 `config.storage.dir` 默认值同样是 `~/.zcode`（`contracts/src/config/index.ts:303`），它是**整个运行时数据树的根**：session db、明文凭据（`v2/credentials.json`）、provider 配置、记忆、日志、rollout 全在其下（经 `bootstrap/src/app/paths.ts:5` 的 `getCliStorageRoot` 派生）。若把「不需要 `~/.zcode`」推广到它，将导致**全部既有会话失联、凭据丢失、厂商配置失效**，且不可逆。
  >
  > **本计划明确不做这一推广。** 若用户确实希望连运行时数据一并迁到 `~/.claude`，那是一独立且高风险的迁移项目，需单独立项（含数据搬迁、凭据重加密、回滚方案），不应混入本次配置接轨。**开工前若对此有疑义，先确认再做。**
- **不移除原生 `/skill` 命令**（保留为兼容别名，见 Plan 第 10 步）。
- **不解析 `~/.claude.json` 的 `projects` 结构**（其内是客户端本地状态与按项目分的配置快照，与 zcode 的 project 概念不对应）。
- **不做 `~/.claude/settings.json` 的配置迁移**——该文件含明文凭据，读取它带来的安全面扩大远超本次诉求。
- **不实现 skill 的跨工具同步 / 反向写入**（zcode 不往 `~/.claude` 写 skill）。
- **不做 `plugins/`、`agents/` 等其他 `.claude` 子目录的接轨**（本次只覆盖 skill / MCP / 指令文件三条线）。
- **不改 `.env` 厂商配置链路**——属 `docs/plan-vendor-config-write.md` 的范围。

---

## Post-Mortem（2026-09-22）

对已实现部分做通读审计，**以「能否在任意一台 macOS 上开箱可用」为主判据**。
共发现并修复 3 个缺陷，全部已回归测试锁定。

### [BUG-1] `.agents` 由 `dirname(configHome)` 推导，自定义落点下静默读错目录

**位置**：`adapters/src/skills/roots.ts`、`adapters/src/commands/roots.ts`
**严重度**：High ｜ **类型**：Hardcoded Assumption

**问题**：`.agents` 根用 `join(dirname(configHome), ".agents", ...)` 推导，隐含假设
「configHome 一定是 `<home>/.claude`」。当 `ZCODE_CONFIG_HOME=/opt/acme/cfg` 时，
`.agents` 被解析到 `/opt/acme/.agents` —— **换一个落点就读错地方，且没有任何报错**。
两个文件各有一份，同一 bug 出现两次（正是 Pre-Mortem 里「skill 接了、命令没接」的形状）。

**修复**：`configHome` 与 `userHome` 拆成两个独立入参，各自由其正主解析
（`getUserConfigHome` / `resolveUserHomeDir`）。函数注释里写明「不要用一个推导另一个」。

**回归**：`test/claude-config-home.mjs` 的隔离断言 + 手工用例（三种 `ZCODE_CONFIG_HOME` 取值下
`.agents` 均落在 `$HOME` 下）。

### [BUG-2] `doctor` 的自定义命令计数恒为 0

**位置**：`cli/src/doctor.ts`（`countSkillEntries` 被复用于命令目录）
**严重度**：Medium ｜ **类型**：Copy-paste Error / 判据错用

**问题**：skill 的判据是「目录内含 `SKILL.md`」，而命令是**平铺的 `.md` 文件**。
同一函数拿来数命令目录，结果永远为 0。表现为 `doctor` 报「自定义命令 0 个」，
而 `zcode commands list` 同时列出命令 —— **自检与实况互相矛盾，比不报更误导**。
本机恰好没有命令文件，所以此 bug 不会在开发机上暴露；是在模拟一台「另一台 macOS」时才现形。

**修复**：新增 `countCommandEntries`，按 `.md` 文件计数。注释写明两种判据为何不同。

**回归**：fixture 里放一个命令文件，断言 `doctor` 输出「自定义命令 1 个」。

### [BUG-3] `doctor` 的迁移检查用 `homedir()`，忽略传入 env

**位置**：`cli/src/doctor.ts`（`legacySkills` 行）
**严重度**：Low ｜ **类型**：Hardcoded Assumption

**问题**：同一函数里其余路径都经 env 解析，唯独迁移检查用裸 `homedir()`。
在 HOME 被覆盖的环境（测试、容器、launchd）会指向**真实机器家目录**，
报出与本次运行无关的迁移提示。

**修复**：改用 `resolveUserHomeDir(env)`，与「skill 实际从哪读」同源。

### 已确认**不是**缺陷（审计后排除）

| 疑点 | 结论 |
|------|------|
| `enabled: false` 的 server 是否仍被连接 | 否。`mcp/index.ts:320` 与 `mcp/pool.ts:316` 均有 `enabled !== false` 判定下传。 |
| 非法条目报错时是否会带出 `env` 中的密钥 | 否。`skipped.reason` 只由 Zod 的 issue **路径**拼成，不含 message，从设计上无法带出值。已用含密钥的用例实测。 |
| `ZCODE_CONFIG_HOME` 带尾斜杠 | 否。`getUserConfigHome` 经 `resolve()`，尾斜杠与相对路径均已规范化。 |
| `HOME` 为空 / 未设置 | 否。回落到 `homedir()`（OS 级解析），非硬编码。 |
| 源码中是否有绝对路径硬编码 | 无。全部改动文件扫描无 `/Users/`、`/var/folders`、`/tmp` 等字面量。 |

### 记录但不修（超出本次范围）

- **`mcpServerSchema` 对非法 `type` 偏宽松**：`type: 123` 不会被拒，而是因
  `typeof server.type !== "string"` 回退为按 `command` 推断出的 `stdio`。
  这是 `config.json` 路径**既有**的行为，两条入口共用同一 schema；
  收紧它属于独立变更，且会改变存量配置的接受范围。此处仅记录。
- **`adapter` 其余 ~18 处 `join(homedir(), ".zcode", ...)`**：属运行时数据面，本次不涉及。

### 根因

1. **用「另一个变量的派生值」当坐标**（BUG-1）—— `dirname(configHome)` 看似等价于家目录，
   但它只在默认落点下等价。凡是「A 通常长这样」的假设，都要问一句「A 不这样时呢」。
2. **两套实体复用一套判据**（BUG-2）—— skill 与命令是不同形态的实体，共用计数函数必然出错；
   且失败值（0）是**合法且常见**的取值，所以不会引起怀疑。
3. **同一个函数里混用两种路径来源**（BUG-3）—— 一处 `homedir()`、其余 `env`，肉眼很难发现。

---

## Post-Mortem 第二轮（2026-09-22，外部审计）

上一轮之后又做了一轮带**独立复核**的审计（两个并行审查代理 + 自查），
专查「路径拼接」与「MCP 合并方向」。**又发现 5 个缺陷，其中 1 个是灾难性的。**

### [BUG-4] 用户级 MCP 读错文件：`~/.claude/.claude.json` 而非 `~/.claude.json`

**位置**：`adapters/src/config-home/mcp.ts:74`
**严重度**：**Critical** ｜ **类型**：路径拼接错误

**问题**：`join(getUserConfigHome(env), ".claude.json")`。`getUserConfigHome` 返回的是
**配置家目录** `~/.claude`，而 Claude Code 的 `.claude.json` 是它的**同级文件**（在家目录下）。
算出来的 `~/.claude/.claude.json` 在真实机器上**永远不存在** ——
`readServersFrom` 把 ENOENT 静默吞成 `{}`，于是**整个「用户级 MCP」功能是一个 no-op**，
且没有任何报错、没有诊断。

**为什么测试没抓到**：我的 fixture 把 `.claude.json` 写进了 `$HOME/.claude/` ——
**测试复刻了 bug 本身**，于是「自证正确」。更糟的是 fixture 没设 `HOME`，
`resolveUserHomeDir` 实际读的是**本机真实的** `~/.claude.json`，测试跑的是别人的配置却通过。

**修复**：改从**家目录**拼 —— `join(resolveUserHomeDir(env), USER_MCP_CONFIG_FILE)`。
测试侧：fixture 改写到 `$HOME/.claude.json` 并把 `process.env.HOME` 指向 fixture。

**验证**：把修复临时回退，测试**确实变红**（21/23），恢复后 23/23 —— 证明这条断言真的在防它。

### [BUG-5] `mcp/list` 丢弃全部非插件 MCP（与已修的 runtime-config 同一形状）

**位置**：`bootstrap/src/zcode-protocol/mcp.ts:65-69`
**严重度**：**High** ｜ **类型**：逻辑错误（`??` 当合并用）

**问题**：`...(provided ? explicit : configResult.config.mcp.servers)` ——
调用方（桌面端设置页）提供 `params.mcpServers` 时，`configResult` 那一整套被**整体丢弃**，
而那正是 `~/.claude.json` / `.mcp.json` 的落点。更糟：`params.mcpServers: []` 也命中
`!== undefined`，算出 `{}`，再经下游 `connectConfiguredServers` 的 **replace 语义**
把已连上的 server 全部**断开**。旁边 `runtime-config.ts` 已修过同一形状，
`mcp/list` 这条路径漏了。

**修复**：改为三层叠加 `plugin → configResult → explicit`，与 `runtime-config.ts` 一致。

### [BUG-6] `mergeConfigs` 的 `mcp.servers` 深合并是死代码（**既有缺陷，非本次引入**）

**位置**：`adapters/src/config/config-merger.ts:45,66-75`
**严重度**：Medium（当前不可达）｜ **类型**：逻辑错误

**问题**：`Object.assign(result, config)` 先把 `result.mcp` 指向当前层，
随后的 `{...result.mcp?.servers, ...config.mcp.servers}` 就成了 `{...X, ...X}` ——
**只有最后一层的 servers 存活**。实测：三层 `{systemA} / {userA,shared} / {projectA,shared}`
→ 结果只剩 `[projectA, shared]`。触发条件是某一层写了 `mcp` 但没写 `mcp.servers`（如只写 `mcp.enabled`）。

**当前不可达**：`createConfig` 在 `:276-279` 会把 `merged.mcp.servers` 整体重算覆盖，
恰好掩盖了它。**属既有缺陷，本次不改**（改动合并器影响面远超本任务），
但已在下方列为预防任务。

### [BUG-7] 用户级指令的护栏与文档仍指向已废弃路径

**位置**：`bootstrap/src/builtin-prompt-command.ts:58`、`packages/shared/src/zcode-slash-command-help.ts:47`
**严重度**：Medium ｜ **类型**：Comment/Code Drift（且会注入模型提示词）

**问题**：`/init` 的提示词里写着 `Do not write ~/.zcode/AGENTS.md`，而该路径**已不再生效**；
真正需要护栏的是 `~/.claude/CLAUDE.md`。护栏指向错目标 = 形同虚设，
且这段文本**直接进模型提示词**。`/init` 的 help 文案同病。

**修复**：护栏改为 `Do not write ~/.claude/CLAUDE.md`；候选清单补上
`.claude/CLAUDE.md` 与 `AGENTS.md`；help 文案同步。

### [BUG-8] 4 处注释仍把用户级 skill 根写成 `~/.zcode/skills`

**位置**：`adapters/src/skills/index.ts:245`、`adapters/src/skills/scan.ts:23`、
`packages/shared/src/skills-types.ts:18`、`packages/shared/src/skill-scan-policy.ts:46`
**严重度**：Low ｜ **类型**：Comment Drift

**修复**：统一改为 `~/.claude/skills`。
（`doctor.ts:534` 与 `skills/roots.ts:115` 提到 `~/.zcode/skills` 是**刻意的** ——
前者描述迁移检查、后者说明「不读哪里」，均保留。）

### 第三轮：处理审计遗留项（2026-09-22）

**已修 2 项：**

- **[BUG-9] `isolation` 漏在 strict schema 里** —— 该字段在契约
  （`mcp.port.ts:18`）与运行态（`mcp/pool.ts` 消费）中都存在，却不在
  `mcpServerBaseSchema` 里。因三个变体都是 `.strict()`，带它的 server 会被**整条丢弃**：
  声明了、能用、却进不来。已补 `z.enum(["session", "workspace"])`
  （取值以契约的 `McpServerIsolation` 为准；初稿写错成 `none/process`，比对契约后修正）。
- **[BUG-10] 配置路径不展开 `${VAR}`** —— 插件加载器有展开，配置路径没有。
  Claude Code 的 `.mcp.json` 惯例是用 `${GITHUB_TOKEN}` 引用密钥，
  不展开就会把**字面量**交给适配器 —— 表现为远端 401，而用户配置里看着完全正确，极难排查。
  已加递归展开（覆盖 `command`/`args`/`env`/`url`/`headers`），并定了一条与插件侧
  **刻意不同**的缺失语义：**不抛错，而是收集缺失变量名、整条跳过并报出名字** ——
  `process.env` 的缺失是用户可修的，报出名字才有可操作性。

**记录但未修（及理由）：**

| 项 | 判定 |
|---|---|
| `untrustedProjectMcpServers` 恒为空集（`.mcp.json` server 自动信任 + 自动执行 `command`） | ✅ **已决策：维持现状**。代码中该行为有明确注释「产品决定 workspace MCP 开箱即用」，是**已文档化的产品决定**而非疏漏。本次只把该风险面从 `.zcode/config.json` 扩到 `.mcp.json`（后者是**可提交进版本库**的约定文件名）。已向用户明示此区别并确认保持现状。 |
| `mergeConfigs` 的 `mcp.servers` 深合并是死代码（只有最后一层存活） | **既有**，当前**不可达**（`createConfig:276-279` 整体重算覆盖，恰好掩盖）。改动合并器影响面远超本任务，列为预防任务。 |
| `includeZcodeSkills` / `includeZcodeCommands` 命名名不副实且无调用方 | **既有**，无害，仅命名误导。 |
| `doctor` 没有 MCP 段 | 计划 §3.1 要求过。当前本机 0 个 MCP server，加了只会是噪声；等真有 server 时再补。 |

> 附注：本轮新增的 3 条断言在**写完第一次运行时就把我自己写错的东西抓住了** ——
> 测试脚本用模板字符串承载内层脚本，注释里的 `` `${VAR}` `` 被外层当成了插值。
> 这正是「断言锚在事实上」的价值：它不等你 review，运行时就直接报错。

### 根因（第二轮）

1. **测试复刻了 bug 的假设**（BUG-4）—— fixture 按「代码怎么算」来构造，
   而不是按「Claude Code 实际长什么样」来构造。**测试必须锚在外部事实上，不能锚在实现上。**
   并且 fixture 没隔离 `HOME`，实际读的是本机真实文件，于是连「有没有读到」都测错了。
2. **同一个错误形状修了一处、漏了另一处**（BUG-5）—— `runtime-config.ts` 与
   `mcp/list` 是同构的两条路径，修第一条时没有全局扫描同类。这正是项目 `Adjust` 章
   「修完一处要扫全局」要防的事。
3. **注释跟着旧路径一起留在原地**（BUG-7/8）—— 路径迁移时只改了代码，没改描述代码的文字；
   而当注释会进提示词时，它就成了实际行为的一部分。

---

## Pre-Mortem Risks

<!-- AUTO-GENERATED: New risks will be appended below -->

### [风险] ~~用户级指令静默降级：`AGENTS.md` 的既有指令不再加载~~ ✅ 已排除

**原评**: Severity 4 × Likelihood 4 × Detectability 0.0 = 16（HIGH）→ **降为 0，已排除**

**排除依据（已实测）**：`~/.zcode/AGENTS.md` **不存在**（`ls` 确认）。`~/.claude/CLAUDE.md` 存在，是指向 `/Users/doing/Desktop/zack-skills/CLAUDE.md` 的软链，**119 行实际内容**。

**结论**：切换不会丢失任何既有用户级指令——改动前该文件根本不存在，改动后**新增**了 119 行指令生效。这不是风险，而是一次**净增益**。

**保留的残余关注**：这是本机形态；其他存量用户可能确实有 `~/.zcode/AGENTS.md`。见下方「存量用户迁移」风险条目。

### [风险] ~~`~/.claude` 独占 vs `.zcode` 兜底——决策从未被拍板就开工~~ ✅ 已关闭

**原评**: Severity 5 × Likelihood 3 × Detectability 0.0 = 15（HIGH）→ **降为 0，已关闭**

**关闭依据**：2026-09-22 已明确决策为**严格独占**（Open Questions 第 1 条），Phase 2 第 4 步的沉默默认值已改为显式实现要求。决策不再悬空，实现者不会走岔。

**残余动作（已并入 Phase 2 第 4 步）**：启动时检测 `~/.zcode/skills` 非空需给可见提示——这从「若选严格独占则…」的条件项变成了**必做项**。

### [风险] 自举出的空 `~/.claude` 静默遮蔽全部配置来源

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 9.6 — MEDIUM

**失败场景**：自举逻辑在 `~/.claude` 不存在时创建一个**空壳目录**。此后每次启动都因「目录已存在」而走「已存在」分支——干净利落，但用户什么配置都没有，且**没有任何错误或提示**。表现是「zcode 里一个 skill 都没有」，与「接轨逻辑写错了」的现场完全一致，排查会从错误的方向开始。

**Mitigation**:
- 自举产物必须**可辨识**：写入一个标记（如 `agent-config-home.json` 记录 `bootstrappedAt`），使 `doctor` 能区分「用户自建的 `.claude`」与「zcode 自举的」。
- 自举成功后**必须输出一行用户可见提示**（告知创建了什么、路径在哪、如何加第一个 skill），不允许静默创建。
- `doctor` 在「配置家目录为空且由 zcode 自举」时给出明确的下一步指引，而非只报「0 个 skill」。

### [风险] ~~`/init` 的提示词硬编码 `AGENTS.md`，与新的 `CLAUDE.md` 优先级打架~~ ✅ 已排除

**原评**: Severity 3 × Likelihood 4 × Detectability 0.2 = 9.6（MEDIUM）→ **降为 0，已排除**

**排除依据（已读源码 `bootstrap/src/builtin-prompt-command.ts:37-60`）**：`/init` 的目标是**工作区**，与用户级指令是**两个不同的作用域**，互不冲突：
- 提示词要求 `File name must be exactly AGENTS.md`，且 `targetPath` 是工作区路径。
- 提示词**显式禁止**写用户级文件：`"- This command targets the current workspace only. Do not write ~/.zcode/AGENTS.md."`
- help 文案同源确认：「This command targets the workspace root, not the user default ~/.zcode/AGENTS.md.」

**结论**：用户级指令切到 `~/.claude/CLAUDE.md` 后，`/init` 继续产出工作区 `AGENTS.md`——**作用域不同，不构成「两份并存打架」**。原先的判断建立在「`/init` 会写用户级文件」的错误假设上。

**残余动作（降为验证项，非风险）**：
- `/init` 提示词里列出的 `Existing hidden instruction candidates` 引用了 `<cwd>/.zcode/AGENTS.md`——这是**项目级**路径，与本次「用户级移除 `.zcode`」无冲突。但若 Phase 2 顺手把项目级 `.zcode` 也删了，这行文案会变得不准确。**验证时确认项目级 `.zcode` 行为未被改动。**
- 走一遍 `/init`，确认在已存在工作区 `AGENTS.md` 时是编辑而非覆盖，且未触碰 `~/.claude/CLAUDE.md`。
- 补一条端到端用例：在只有 `CLAUDE.md` 的环境跑 `/init`，断言不会产出与之冲突的第二份用户级指令。
- 软链穿透问题**在此降级**：写入由模型按提示词执行，不是代码 `open()` 硬写，风险从「代码必然穿透」降为「模型可能照做」，故 Severity 由 5 降至 3。但仍需在验证中**确认 `zack-skills/CLAUDE.md` 事后未被意外修改**（`git -C /Users/doing/Desktop/zack-skills status`）。

### [风险] symlink `CLAUDE.md` 是本机特有形态——验证依赖它则结论不可复现

**Severity**: 3 | **Likelihood**: 4 | **Detectability**: 0.1
**Risk Score**: 10.8 — MEDIUM

**失败场景**：本机 `~/.claude/CLAUDE.md` 是软链，这是**个人仓库的习惯**（`zack-skills` 的 CLAUDE.md 被链接过来）。任何验证若依赖这一形态（比如「能读到就说明对了」），在普通用户的普通文件上会**得出不同结论**；反过来，围绕软链写的特殊处理也可能在普通文件场景引入回归。

**Mitigation**:
- 验证必须**同时覆盖两种形态**：软链文件 与 普通文件。两种都写入验证清单（见 `Do` 节）。
- 加一条对照用例：把用户级指令文件换成普通文件，断言行为一致。
- 代码中不得假设用户级指令一定是软链或一定不是。

### [风险] 一级命令清单在启动期失败，连带整个 slash 命令面不可用

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.1
**Risk Score**: 10.8 — MEDIUM

**失败场景**：`listSlashCommandSuggestions` 由 `cli/src/tui-command.ts:77` 在启动期调用。新增的 skill 建议来源要读盘、解析 frontmatter。一旦某处抛错，**整个建议列表**（含全部内置命令）一起挂掉——用户看到的是「一个命令都没有」，而不是「skill 没扫到」。这是典型的「新增的弱环节拖垮既有强环节」。

**Mitigation**:
- skill 建议的拼装必须**独立 try/catch**，失败时降级为「只返回内置命令 + 自定义命令」并输出一条告警，**绝不向上抛**。
- 沿用既有的 `throws/aborted` 判定惯例，区分「用户中断」与「真实错误」——中断应传播，错误应降级。
- 验证时构造一个 frontmatter 非法的 skill，断言：该 skill 被跳过并告警，**其余 14 个 skill 与全部内置命令仍在**。

### [风险] `<repo>/.mcp.json` 与插件根的 `.mcp.json` 互相污染

**Severity**: 4 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 9.6 — MEDIUM

**失败场景**：`.mcp.json` 这个文件名在本仓库**已被插件根占用**（`adapters/src/plugins/mcp.ts:26` 读 `<pluginRoot>/.mcp.json`）。新增「工作区根的 `.mcp.json`」后，两条解析路径的根目录不同但文件名相同。若解析层靠文件名而非根路径判断，工作区根的 `.mcp.json` 会被当作插件清单解析，或反之——表现为「MCP server 莫名多出来/少掉」，且因为 MCP 目前**零使用**，这个 bug 可以潜伏很久。

**Mitigation**:
- 在工作区根解析处**加一条显式断言**：解析出的根路径必须等于 `workingDirectory`，且**不得**位于任何插件包目录内。
- 两条路径的解析函数**不复用同名入口**，各自命名以免日后被误接。
- 加回归用例：工作区根放一个 `.mcp.json`，断言插件清单解析结果不受影响（反之亦然）。

### [风险] `SkillSource` 新增字面量后，非穷尽分支静默误处理 `"claude"`

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 4.8 — MEDIUM

**失败场景**：`SkillSource` 现为 `"agents" | "zcode" | "bundled" | "plugin" | "remote"`（`contracts/src/skills/index.ts:9`）。新增 `"claude"` 后，类型检查能抓出**穷尽 switch**，但抓不出 `if (source === "zcode")`、`source !== "bundled"` 这类**非穷尽条件**。表现为某个来源标记的地方把 `.claude` skill 归错类（如优先级排序、`disabledPaths` 匹配、展示分组）。

**Mitigation**:
- 改类型后跑 `grep -rn 'SkillSource\|source ===\|source !==' apps/zcode-cli/packages --include='*.ts' | grep -v dist`，**逐条人工判定**，不依赖类型检查兜底。
- 把新字面量放在联合类型的**首位**并在类型处加注释说明它与 `zcode` / `agents` 的关系与优先级。
- 验证时断言 `zcode skills list` 中来自 `.claude` 的条目 source 显示为 `claude`，且排序在 `zcode` 与 `agents` 之前。

### [风险] MCP 优先级顺序反了，静默顶掉既有可用 server

**Severity**: 3 | **Likelihood**: 2 | **Detectability**: 0.3
**Risk Score**: 4.2 — MEDIUM

**失败场景**：计划默认「项目 > 用户 > 插件」。若实际 Claude Code 的行为是「用户 > 项目」，实现出的顺序会让**低优先级的配置顶掉高优先级的**。因为当前用户级 MCP server 数为 0，这个 bug 在本机**永远不会暴露**，只会在别人机器上出现。

**Mitigation**:
- 实现前用一次**真实对照实验**确定 Claude Code 的行为：在用户级与项目级放**同名但不同 command** 的 server，观察哪一条生效，把结论写进本文档。
- 若无法实验，则**明示这是推测**，并在 `doctor` 输出中同时列出「生效的那条」与「被遮蔽的那条」，让错配当场可见而不是静默。

### [风险] 五阶段跨度中途停摆，配置面分裂成三处

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 7.2 — MEDIUM

**失败场景**：Phase 1-2 落地后停摆（skill 走 `.claude`，指令与 MCP 仍走 `.zcode`）。用户的配置被**分裂到三个位置**：skill 在 `.claude`、指令在 `.zcode`、MCP 在插件包。这比改动前**更糟**——改动前至少是「都在 `.zcode`」这一个心智模型。

**Mitigation**:
- Phase 2 的验收标准必须包含**「`.claude` 是用户唯一需要关心的位置」这句是否成立**；不成立则不得宣称 Phase 2 完成。
- 每完成一个 Phase 即在 `README` 中更新一次「当前配置面在哪」，避免文档与实现脱节。
- 若确定会中途停摆，则**先做 Phase 3（指令文件）再做 Phase 2（skill）**——指令文件是三条线里改动最小的，能最快让「配置集中在 `.claude`」这个心智模型成立。

### [风险] 一级清单加入 15+ 条 skill 后，命令面板搜索体验退化

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 4.8 — MEDIUM

**失败场景**：`AVAILABLE_COMMANDS` 与建议列表从 19 条增至 34+ 条。TUI 的命令面板若把内置命令与个人 skill **混排无分组**，用户敲 `/` 后很难在噪声里找到 `/model`、`/mode` 这类高频内置命令——用一个新能力换掉了一个既有能力的可用性。

**Mitigation**:
- 建议列表**按来源分组呈现**（内置 / 自定义 / skill），而非平铺。
- 计算 `skill 触达层级` 指标时**同时度量内置命令的触达代价**，确保没有净损失。
- 验收时实际在 TUI 中敲 `/m` 等前缀，确认内置命令仍能在一屏内定位。

### [风险] `~/.claude` 不可读时静默回退到 `.zcode`，用户误以为接轨成功

**Severity**: 3 | **Likelihood**: 2 | **Detectability**: 0.2
**Risk Score**: 4.8 — MEDIUM

**失败场景**：`~/.claude` 存在但权限不可读（或路径异常）。若实现选择「读不到就退回 `.zcode`」，用户会在**接轨成功的错觉**下继续工作，而实际生效的是旧配置。这类「静默回退」是本项目历史上已经出现过一次的失败形态（见 `prompt-command.ts:257-265` 关于未知命令被早退吞掉的注释）。

**Mitigation**:
- **禁止静默回退**。配置家目录不可读 = 明确报错 + 指路，不降级。
- 在 `doctor` 中始终显式打印「本机生效的配置家目录是哪一个」，让回退（若发生）无处藏身。
- 补一条用例：把 `~/.claude` 设为不可读，断言报错而非静默降级。

### [风险] 自举目录对用户家目录的可写依赖在受限环境下直接失败

**Severity**: 3 | **Likelihood**: 2 | **Detectability**: 0.1
**Risk Score**: 5.4 — MEDIUM

**失败场景**：在 CI、容器、只读家目录或 `HOME` 未设置的环境里，自举逻辑尝试 `mkdir` 失败。若该失败未被妥善处理，会**连累启动流程**——一个纯锦上添花的自举能力，把主流程拖挂了。

**Mitigation**:
- 自举失败**绝不阻断启动**：捕获后降级为「无用户级配置」并输出一行告警。
- 自举应**惰性触发**（首次真正需要用户级配置时），而非每次启动无脑检查。
- 补一条用例：`HOME` 指向只读目录，断言 zcode 仍能正常启动并使用项目级配置。

### [风险] `skill.<path>.enable=false` 禁用机制对新根失效

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 4.2 — MEDIUM

**失败场景**：既有禁用机制按 **skill 的绝对路径**记录（`adapters/src/skills/index.ts:38-40`，构造时同时索引入 `resolve(path)` 与 `realpath`）。用户此前禁用的一个 `~/.zcode/skills/xxx` 在切换后路径形态变化，**禁用不再命中**——被禁的 skill 悄悄复活。

**Mitigation**:
- 切换根目录后，`doctor` 增加一致性检查：报告「已禁配但未命中任何已发现 skill」的条目。
- 在 Phase 2 验收中显式走一遍「禁用某 skill → 确认它不出现在一级清单」。
- 若确认为有意行为变更，则在迁移说明中列出受影响路径。

### [风险] 存量用户迁移：本机已排除，但其他用户的 `~/.zcode/skills` 会静默失联

**Severity**: 3 | **Likelihood**: 3 | **Detectability**: 0.2
**Risk Score**: 7.2 — MEDIUM ｜ **已定策略：严格独占（决策已下），故本条转为必做动作项**

**失败场景**：本节开头那条 HIGH RISK 是**在本机被排除**的（`~/.zcode/AGENTS.md` 不存在）。但这是**本机形态，不是普遍结论**。已确认采用「严格独占」后，任何**其他**已把 skill 装在 `~/.zcode/skills` 的用户，会在升级后**静默失去全部个人 skill**——升级动作本身没有任何提示，且失联与「接轨逻辑写错了」表现一致。

**Mitigation**（决策已定为严格独占，以下为必做项而非备选）:
- 本次改动面向的是**分发工具**，不是单人环境。**不得以「本机没有 `~/.zcode/skills`」为理由跳过迁移设计。**
- **启动时检测到 `~/.zcode/skills` 或 `~/.zcode/AGENTS.md` 非空，必须输出一次可见提示**：告知新位置（`~/.claude/skills`、`~/.claude/CLAUDE.md`）、旧路径已不再生效、如何迁移（一行 `mv`/`cp` 命令）。这是最低成本且唯一的兜底。
- 在 `README` / `README.en.md` 的变更说明中显式列出**路径迁移表**（旧 → 新）。
- **不建议加宽限期**：宽限期意味着 `.zcode` 根降权保留，与刚确立的「严格独占」心智模型相冲突，且会让「配置在哪」重新变得不确定。用一次明确的启动提示替代。
- 验收：在一个 `~/.zcode/skills` 非空的环境启动，断言提示出现且 `doctor` 报出旧路径已失效。

### [风险] TUI 与 CLI 两条入口的命令面不一致

**Severity**: 2 | **Likelihood**: 3 | **Detectability**: 0.3
**Risk Score**: 4.2 — MEDIUM

**失败场景**：skill 派发在 `prompt-command.ts`（CLI 入口）与 `command-center/create.ts:326`（TUI 入口）**各有一份** `buildManualSkillPrompt` 调用。若只在一处接入 skill 名探测，另一处会在同名 skill 上表现不同——用户在 TUI 里能用、在 `zcode -p` 里不能用（或反之），且两边**看起来都对**。

**Mitigation**:
- skill 名探测必须抽成**单一函数**，两处入口共用，不得复制逻辑。
- 验证清单中**同时覆盖两条入口**：TUI 交互 与 `zcode -p "/pain-decomposition <task>"`。
- 改动后跑 `grep -rn 'buildManualSkillPrompt' apps/zcode-cli/packages --include='*.ts' | grep -v dist`，确认所有调用点都被覆盖。

---
