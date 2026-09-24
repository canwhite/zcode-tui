#!/usr/bin/env node
// 断网验收关卡（F-004，见 docs/plan-offline-vendoring.md Step 4）。
//
// 为什么需要它：本地化最容易的失效形态是**假通过**——"装成功了"可能来自
// 上一次联网留下的缓存、回源下载、或根本没封住网。"看起来能用"证明不了
// "断网也能用"，所以这里把关键结论做成硬断言，而不是靠观察推断。
//
// 用法：
//   node test/offline-acceptance.mjs              跑全部断言
//   node test/offline-acceptance.mjs --with-clean 额外验证 make clean 后资源存活
//
// 前置：需要已构建的 CLI 产物（apps/zcode-cli/packages/cli/dist/zcode.cjs）。
//       未构建时本脚本直接失败并给出构建命令，不静默跳过。

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");

/** 封锁全部非 npm 出网：把代理指向一个必定拒绝连接的端口。 */
const DEAD_PROXY = "http://127.0.0.1:9";
const BLOCKED_ENV = {
  HTTP_PROXY: DEAD_PROXY,
  HTTPS_PROXY: DEAD_PROXY,
  http_proxy: DEAD_PROXY,
  https_proxy: DEAD_PROXY,
};
/** 被测插件：取体积最小的之一，减少验收耗时。 */
const PROBE_PLUGIN = "wind";
/** 本地清单里应有的智谱插件数（与 third-party/resources.json 的 zhipu-plugin-* 条目数一致）。 */
const EXPECTED_ZHIPU_PLUGINS = 26;

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
}

function runCli(args, { env = {}, storage } = {}) {
  const child = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ZCODE_STORAGE_DIR: storage, ...env },
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

/** 直连死端口的连通性探测：确认封锁机制本身是活的。 */
function probeDeadProxy() {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: "127.0.0.1", port: 9, timeout: 1500 });
    const done = (reachable) => {
      socket.destroy();
      resolveProbe(reachable);
    };
    socket.on("connect", () => done(true));
    socket.on("error", () => done(false));
    socket.on("timeout", () => done(false));
  });
}

function readMarketplace(storage) {
  const path = join(
    storage,
    "cli",
    "plugins",
    "marketplaces",
    "zcode-plugins-official",
    "marketplace.json",
  );
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8"));
}

const withClean = process.argv.includes("--with-clean");

console.log("断网验收关卡\n");

if (!existsSync(cliPath)) {
  console.error(`  FAIL  CLI 产物不存在：${cliPath}`);
  console.error(`        先构建：pnpm --filter @zcode/cli build`);
  console.error(`        注意：bootstrap 必须单独重建（CLI 解析的是它的 dist，不是源码）`);
  process.exit(1);
}

// A1 — 封锁机制本身是活的
assert(
  "A1 封锁机制有效（死代理确实拒绝连接）",
  !(await probeDeadProxy()),
  `127.0.0.1:9 竟然可达，封锁机制不成立`,
);

// A2 — npm 豁免完好（封锁不得误伤 npm，否则验收会假失败）
//
// 注意这是**在未施加封锁的情况下**测的：问的是"这台机器能否到 npm"，
// 而不是"我们的封锁有没有把 npm 一起封掉"。两者不同。
// npm 不可达只可能是机器本身就离线——那恰恰是本验收想覆盖的环境，
// 因此记 warn 而不判失败，否则验收在最需要它的地方跑不起来。
const npmReachable = await fetch("https://registry.npmjs.org/-/ping", { method: "HEAD" })
  .then((r) => r.ok)
  .catch(() => false);
if (npmReachable) {
  assert("A2 npm 豁免完好（registry.npmjs.org 可达）", true);
} else {
  console.log("  warn  A2 跳过：本机到 npm 不可达（真离线环境）——验收其余断言仍然有效");
}

// A3 — 断网下市场可列出智谱插件
const listStorage = mkdtempSync(join(tmpdir(), "qcode-accept-list-"));
const listed = runCli(["plugins", "list"], { env: BLOCKED_ENV, storage: listStorage });
const marketplace = readMarketplace(listStorage);
const zhipu = (marketplace?.plugins ?? []).filter((p) => p.source?.type === "zip");
assert(
  `A3 断网可列出智谱插件（期望 ${EXPECTED_ZHIPU_PLUGINS} 个）`,
  zhipu.length === EXPECTED_ZHIPU_PLUGINS,
  `实际 ${zhipu.length} 个；CLI status=${listed.status}；marketplace=${marketplace ? "已生成" : "未生成"}`,
);
assert(
  "A3b 每个插件条目都带 64 位 sha256",
  zhipu.length > 0 && zhipu.every((p) => /^[a-f0-9]{64}$/u.test(String(p.source?.sha256 ?? ""))),
);

// A4 — 断网下可安装（这一轮是"正向"：有本地副本，应当成功）
const okStorage = mkdtempSync(join(tmpdir(), "qcode-accept-ok-"));
const okInstall = runCli(["plugins", "install", PROBE_PLUGIN], {
  env: BLOCKED_ENV,
  storage: okStorage,
});
assert(
  `A4 断网可安装智谱插件（${PROBE_PLUGIN}）`,
  okInstall.status === 0 && /Installed plugin/i.test(okInstall.stdout),
  `status=${okInstall.status}\n        stdout=${okInstall.stdout.trim()}\n        stderr=${okInstall.stderr.trim().slice(0, 300)}`,
);

// A5 — 负向：屏蔽本地副本后，同一安装在断网下**必须失败**。
//
// 这一条同时证明两件事，缺一不可：
//   1) A4 的成功确实来自本地副本，不是缓存或回源；
//   2) 封锁对 CLI 的取网路径真的生效——若 CLI 能出网，这里反而会"安装成功"而断言失败。
const noVendorStorage = mkdtempSync(join(tmpdir(), "qcode-accept-novendor-"));
const noVendorInstall = runCli(["plugins", "install", PROBE_PLUGIN], {
  env: {
    ...BLOCKED_ENV,
    ZCODE_VENDORED_ASSETS_ROOT: join(tmpdir(), "zcode-no-such-vendored-root"),
  },
  storage: noVendorStorage,
});
assert(
  "A5 负向：屏蔽本地副本后断网安装必须失败",
  noVendorInstall.status !== 0,
  `竟然成功了——说明 A4 可能是假通过（缓存或回源）。stdout=${noVendorInstall.stdout.trim()}`,
);

// A6 — 资源的本地副本齐全（离线校验，全程不联网）
const verify = spawnSync(
  process.execPath,
  [join(repoRoot, "scripts/vendor-resources.mjs"), "verify"],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
);
assert(
  "A6 台账 52 条本地副本齐全且 sha256 匹配",
  verify.status === 0,
  verify.stdout + verify.stderr,
);

// A7 — 受保护根不被任何 .gitignore 命中
const ignored = spawnSync(
  process.execPath,
  [join(repoRoot, "scripts/vendor-resources.mjs"), "assert"],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
);
assert("A7 落点不被 .gitignore 命中", ignored.status === 0, ignored.stdout + ignored.stderr);

if (withClean) {
  // 会删掉 node_modules，需要重新 pnpm install 才能继续开发——故默认不跑。
  const before = spawnSync(process.execPath, [join(repoRoot, "scripts/clean.mjs")], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  const stillThere = spawnSync(
    process.execPath,
    [join(repoRoot, "scripts/vendor-resources.mjs"), "verify"],
    { cwd: repoRoot, encoding: "utf8" },
  );
  assert(
    "A8 make clean 后本地副本仍齐全",
    before.status === 0 && stillThere.status === 0,
    `clean=${before.status} verify=${stillThere.status}\n${before.stdout}${before.stderr}`,
  );
} else {
  console.log("  skip  A8 make clean 后存活（需 --with-clean；会删除 node_modules 需重装）");
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? "验收通过" : `验收未通过：${failed.length}/${results.length} 条断言失败`}`,
);
process.exit(failed.length === 0 ? 0 : 1);
