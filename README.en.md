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

## Repository Structure

| Directory                                      | Responsibility                                                                          |
| ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| `apps/zcode-cli`                               | Agent CLI, TUI, runtime, and tools                                                      |
| `packages/shared`, `packages/model-option-map` | Shared protocols and types, model option mapping                                        |
| `packages/provider`, `packages/provider-node`  | Common provider capabilities and Node implementations                                   |
| `packages/zcode-cua`                           | Computer Use interface placeholder (this build does not provide the capability)         |
| `scripts`, `config`, `third-party`             | Build and maintenance scripts, built-in configuration, and third-party notice materials |

Removed from upstream by this branch: `packages/desktop`, `packages/web`, `packages/server`, `packages/ui`, `packages/client`, `packages/services`, `packages/rpc`, `packages/formal-proof`, and `packages/zcode-server-cli`.

## Project Notice

See [NOTICE.md](NOTICE.md) for feature and promotion scope, maintenance policy, execution and data risks, licensing, and third-party copyright information.

See [third-party/README.md](third-party/README.md) for notice generation and distribution checks. Note that [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and `third-party/inventory.json` are still generated from the **full** repository dependency graph and have not yet been narrowed to match this branch — their component lists include more than the actual dependencies.
