# ZCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">Feishu community</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  <a href="README.md">简体中文</a> | English
</p>

ZCode is an AI coding workspace.

> **This repository is a slimmed-down branch: it keeps only the Agent CLI and TUI plus their dependency closure.** The desktop application, browser interface, backend services, distribution assembly, and remote asset preparation have been removed relative to upstream. See [docs/dependency-boundary.md](docs/dependency-boundary.md) for the exact boundary and the per-package rationale.

| Interface | Purpose                                                       | Development command            |
| --------- | ------------------------------------------------------------- | ------------------------------ |
| Agent CLI | The `zcode` terminal interface, which hosts the Agent runtime | `pnpm --filter @zcode/cli dev` |
| TUI       | Terminal UI, started by the Agent CLI                         | `pnpm --filter @zcode/cli dev` |

## Setup

Install Git, Node.js **>=22.13.0** (24.14.0 recommended), and pnpm **10.33.2**. [mise.toml](mise.toml) is the source of truth for tool versions. Run all commands below from the repository root.

> The 22.13.0 floor comes from `node:sqlite`: introduced in Node 22.5.0, available without `--experimental-sqlite` from 22.13.0. Node 20/21 lack the builtin entirely and fail at startup with `ERR_UNKNOWN_BUILTIN_MODULE` — this cannot be worked around by relaxing version declarations.

```bash
pnpm bootstrap
```

`pnpm bootstrap` installs workspace dependencies and then runs `build:bootstrap`, which builds `@zcode/cli` and all of its workspace dependencies. The install path contains no desktop-side dependencies such as electron.

The Agent CLI and runtime source code lives in [apps/zcode-cli/](apps/zcode-cli/) as a regular directory included when you clone this repository. No separate checkout or Git submodule initialization is required.

Commands that can also be run individually:

| Command          | Purpose                                                          |
| ---------------- | ---------------------------------------------------------------- |
| `pnpm install`   | Install dependencies                                             |
| `pnpm build`     | Recursively run each workspace package's build script            |
| `pnpm typecheck` | Run the TypeScript project-references check on retained packages |
| `pnpm lint`      | Run the root linter                                              |

## Development and Usage

### CLI Source Development

Use the source entry when developing the TUI or Agent. The TUI requires an interactive terminal:

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# Build the CLI and its workspace dependencies, then run the build output
pnpm --filter "@zcode/cli..." build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

## Configuration

The root [.env.example](.env.example) provides sample service URLs and build configuration. Copy it to `.env` as needed and place local overrides in `.env.local`.

| Setting                              | Purpose                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| `ZCODE_DATA_BASE_DIR`                | Base directory for application data, stored under its `.zcode/` subdirectory            |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | Path to a local provider configuration file; uses the built-in configuration when unset |

Runtime variables can be set explicitly in the environment of the startup command. See [config/README.md](config/README.md) for the default configuration shipped with the client.

### Where personal configuration lives

**Personal configuration is read from `~/.claude`; runtime data stays in `~/.zcode`. The two are independent.**

| Content                                    | Location                                   |
| ------------------------------------------ | ------------------------------------------ |
| Personal skills                            | `~/.claude/skills/<name>/SKILL.md`         |
| Global instructions                        | `~/.claude/CLAUDE.md`                      |
| Personal commands                          | `~/.claude/commands/<name>.md`             |
| User-level MCP                             | the `mcpServers` key in `~/.claude.json`   |
| Project-level MCP                          | the `mcpServers` key in `<repo>/.mcp.json` |
| Sessions, credentials, vendor config, logs | `~/.zcode/` (stays here, not migrated)     |

Personal skills are exposed as **top-level slash commands** — type `/<skill-name>` directly, no `/skill` prefix needed.
If `~/.claude` does not exist, the first run creates it and writes a short README explaining the layout; set
`ZCODE_NO_CONFIG_HOME_BOOTSTRAP=1` to disable that. Run `zcode doctor` to see the effective config home and per-source counts.

> Upgrading from an older version: `~/.zcode/skills` and `~/.zcode/AGENTS.md` are **no longer read**.
> Move them to the locations above to take effect; `zcode doctor` warns when skills are still present in the old location.

## Repository Structure

| Directory                                      | Responsibility                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/zcode-cli`                               | Agent CLI, TUI, runtime, and tools                                                      |
| `packages/shared`, `packages/model-option-map` | Shared protocols and types, model option mapping                                        |
| `packages/provider`, `packages/provider-node`  | Common provider capabilities and Node implementations                                   |
| `packages/zcode-cua`                           | Computer Use interface placeholder (this build does not provide the capability)         |
| `scripts`, `config`, `third-party`             | Build and maintenance scripts, built-in configuration, and third-party notice materials |

Removed from upstream by this branch: `packages/desktop`, `packages/web`, `packages/server`, `packages/ui`, `packages/client`, `packages/services`, `packages/rpc`, `packages/formal-proof`, and `packages/zcode-server-cli`.

## Offline Availability

The official plugin marketplace (manifest, 26 plugin packages, and icons — about 11 MiB) **ships with the repository** under `third-party/vendored/zhipu-official-plugin/`. As a result, **official Z.ai plugins can be listed and installed with no network access** — both the marketplace manifest and the plugin archives are read from the local copy, never from the CDN.

Scope rule: **Z.ai's own remote resources are kept locally; generic third-party packages (the Node runtime, upstream source archives, etc.) are downloaded on demand and not vendored.** The ledger [third-party/resources.json](third-party/resources.json) is the single source of truth and registers both kinds; only the former ships with the repository.

| Purpose                                | Command                                    |
| -------------------------------------- | ------------------------------------------ |
| Verify local copies are complete       | `node scripts/vendor-resources.mjs verify` |
| Refresh local copies                   | `node scripts/vendor-resources.mjs fetch`  |
| Check ledger matches actual references | `node scripts/remote-resources.mjs check`  |
| Offline acceptance                     | `node test/offline-acceptance.mjs`         |

`zcode doctor` reports localization coverage (`覆盖率 100%（26/26），断网可列出并安装`); when copies are missing or corrupt it fails and names the specific plugin.

> Note: offline availability covers **listing and installing** plugins. Most of these plugins are themselves network-dependent (financial data, company lookups, and similar); their business data comes from third-party services and is out of scope.

## Changes in This Branch

> This repository is a slimmed-down branch relative to upstream (see [docs/dependency-boundary.md](docs/dependency-boundary.md) for the retention boundary). On top of that, this branch makes the changes below. **Every modified upstream file carries a `Modified by ZCode:` header**; per-file detail follows.

### New files (original to this branch)

| File                                                                       | Purpose                                                                                                             |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `scripts/remote-resources.mjs`                                             | Remote-resource ledger reader and reconciliation (ledger vs. actual fetch sites; a non-empty difference fails)      |
| `scripts/vendor-resources.mjs`                                             | Localized-resource downloader and verifier (sha256-checked atomic writes, idempotent, ignore-path assertions)       |
| `test/offline-acceptance.mjs`                                              | Offline acceptance gate, 8 assertions                                                                               |
| `test/vendor-scan.mjs`                                                     | Behavioural scan of vendored resources (backdoors + special-case logic), including decryption of protected payloads |
| `third-party/resources.json`                                               | Remote-resource ledger (single source of truth)                                                                     |
| `third-party/vendored/zhipu-official-plugin/**`                            | Vendored official plugin marketplace (manifest + 26 plugin packages + icons, ~11 MiB)                               |
| `apps/zcode-cli/packages/adapters/src/plugins/official-vendored-assets.ts` | Official CDN URL → local-copy resolution primitives                                                                 |

### Modified files

**Offline localization** (`painpoints/done/pp2.md`)

| File                                                                   | Change                                                                                                                                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/adapters/src/plugins/zip-source.ts`           | Plugin archives are now read **local-first** (addressing only; the manifest-published sha256 check is unchanged); failed fetch produces a resource-naming diagnostic |
| `apps/zcode-cli/packages/adapters/src/plugins/official-marketplace.ts` | Added `seedCdnPartitionFromVendoredSync` to seed the CDN partition from the vendored manifest                                                                        |
| `apps/zcode-cli/packages/adapters/src/plugins/index.ts`                | Exported the localization resolution primitives                                                                                                                      |
| `apps/zcode-cli/packages/bootstrap/src/app/bundled-plugins.ts`         | Seeds the CDN partition after writing the bundled one, so official plugins are listed on a first offline start                                                       |
| `scripts/clean.mjs`                                                    | Added a protected-root assertion and a post-clean snapshot check so shipped resources are never deleted                                                              |
| `.gitignore`                                                           | Ignores local caches of generic third-party packages while keeping the shipped localization copies tracked                                                           |

**Vendor configuration and installation** (`painpoints/done/pp4.md`, `pp5.md`, `pp8.md`)

| File                                                             | Change                                                                                                                                  |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/cli/src/run.ts`                         | Wires in the `doctor` self-check and entry-level `.env` loading                                                                         |
| `apps/zcode-cli/packages/cli/src/env.ts`                         | Extracted the single entry-level `.env` loader (previously each command loaded its own)                                                 |
| `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts`        | `configure` now also prepares the built-in and personal Provider Config paths                                                           |
| `apps/zcode-cli/packages/cli/src/arguments.ts`                   | Added `configure`'s `--api-key` / `--provider`; the key can come from the environment so it never appears on the command line           |
| `apps/zcode-cli/packages/cli/src/doctor.ts` (new in this branch) | Added an "official plugin localization" self-check reporting coverage; fails by name when copies are missing or corrupt                 |
| `apps/zcode-cli/packages/shared-types/src/index.ts`              | Added the fields `configure` needs for non-interactive writes                                                                           |
| `packages/provider/src/model-selection-config.ts`                | Distinguishes registry-order fallback from "the configured model is no longer selectable"; the two degradations are reported separately |
| `apps/zcode-cli/packages/i18n/src/locales/{zh-CN,en-US}.ts`      | Synced CLI help text (added `configure`, corrected the `doctor` description)                                                            |
| `.env.example`                                                   | Reworked into a `ZCODE_VENDOR`-driven four-field vendor configuration template                                                          |

**Disconnecting the platform gateway rewrite** (`painpoints/pp8.md`)

Model requests used to be rewritten to a ZCode platform gateway endpoint (`{endpoint}/api/v1/ultra[-zai]/anthropic/...`), where the platform performed plan-entitlement and content-safety checks. They now go **straight to the configured vendor**. This is based on a Step 0 measurement: a plan key works when connected directly, and the usage metadata is identical either way — see [`test/step0-gateway-necessity.md`](test/step0-gateway-necessity.md).

| File                                                                         | Change                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.ts` | **Deleted** (endpoint rewrite, fetch wrapper, and the `OFFICIAL_CODING_PLAN_GATEWAY_ROUTES` route table)                                                                    |
| `apps/zcode-cli/packages/adapters/src/model/model-execution.ts`              | Removed the gateway fetch wrapper; `createProviderTransportFetch` is now a plain direct connection                                                                          |
| `apps/zcode-cli/packages/adapters/src/model/index.ts`                        | Removed the module's barrel export                                                                                                                                          |
| `config/provider/zcode-builtin.json`                                         | **Removed all 7 entries pointing at `zcode.z.ai`** (4 `providerRules` + 3 `providerSiteRules`) plus the 10 `builtinProviderModelRules` referencing them; `revision` 30 → 32 |

> **Four behaviour changes**: (1) one fewer network hop; (2) `httpProxy` / `noProxy` are now evaluated against the **vendor** endpoint instead of the gateway address — noticeable on corporate networks; (3) the platform-side `3007` content-safety check no longer fires and its error paths become dead code; (4) **platform-side billing attribution is unverified** and must be confirmed with the platform.
>
> **`revision` must be bumped** when this file changes: it is what forces account-provider snapshots to be rebuilt. Bumping it without a matching content change (or vice versa) silently makes the edit a no-op.

**Removing login / authentication / logout** (`painpoints/pp8.md`)

The account concept is gone entirely. The **non-login Coding Plan configuration path is preserved**: the user obtains a plan key from the plan console and writes it via `zcode configure --api-key`, with no sign-in at any point.

- **Deleted (11 files)**: `auth-login*.ts`, `cli-oauth.ts`, `coding-plan-api-key.ts`, `bigmodel-oauth.ts`, `browser.ts`, `login-command.ts`, `tui-auth.ts`, `command-center/login-flow.ts`.
- **Renamed / kept**: `auth-login.ts` → `coding-plan-config.ts` (only the non-login `configureCodingPlanApiKey` chain); `tui-auth.ts` → `tui-provider-config.ts`; `tui-login-state.ts` → `tui-provider-setup-state.ts`. The credential store (`shared-credentials.ts`, `credential-cipher.ts`, `localhost-callback.ts`) is **kept** — it is shared with MCP server OAuth.
- **Modified**: the slash-command registry, `command-center/{slash-commands,slash-command-types,create,types,history}.ts`, `run.ts`, `prompt-command.ts`, the TUI gate rename (`loginRequired` → `providerSetupRequired`), and the i18n catalogs.

> **Acceptance gate**: this repository has **no unit tests**, so the likeliest failure mode is silent reintroduction during an upstream sync. `test/zero-account-acceptance.mjs` (10 assertions) is the only guard, wired into `pnpm run verify:pre-push` via `pnpm run test:zero-account`. Several assertions have been proven **able to fail** (injecting a gateway path string, or a `baseUrlMatch` residue, does turn the gate red).
>
> **Known trade-off**: after removing `/login` the TUI has no in-app way to configure a provider. The CLI path (`zcode configure --api-key`) is unaffected and the gate message points at it.

**First-class personal skill commands: case preservation** (`painpoints/pp10.md`)

**Symptom**: `/pain-decomposition` reported `Unknown command: /pain-decomposition` — **while the same error message listed `/pain-decomposition` as available**. The error contradicted itself.

**Root cause**: resolution used `slashCommand.rawName`, which `parseSlashCommand` has already **lower-cased**, but skill loading is **case-sensitive** (adapters' `matchesSkillRequest` uses `===`). Any mixed-case skill name (e.g. `no-useEffect`) therefore never matched and fell through to the "unknown command" branch.

| File                                                | Change                                                                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/zcode-cli/packages/cli/src/prompt-command.ts` | `resolveSkillCommandName` now returns the skill's **canonical name** (`findSkillEntry(...)?.name`) instead of the lower-cased `rawName`; removed the now-redundant `isResolvableSkillName` |
| `test/repro-pp10-skill-command.mts` (new)           | Repro gate using the **real** skill discovery and custom-command loader, so the input list is byte-identical to the TUI's                                                                  |

> `package.json` and `apps/zcode-cli/package.json` also changed (the `engines.node` floor, the `configure` script, and so on), but **JSON cannot carry comments**, so no `Modified by ZCode:` header can be placed inside them — this section is the record for those. `pnpm-lock.yaml` is generated and likewise unannotated.

The remainder are this branch's own documentation (`README*`, `AGENTS.md`, `docs/`).

## Project Notice

See [NOTICE.md](NOTICE.md) for feature and promotion scope, maintenance policy, execution and data risks, licensing, and third-party copyright information.

See [third-party/README.md](third-party/README.md) for notice generation and distribution checks. Note that [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and `third-party/inventory.json` are still generated from the **full** repository dependency graph and have not yet been narrowed to match this branch — their component lists include more than the actual dependencies.
