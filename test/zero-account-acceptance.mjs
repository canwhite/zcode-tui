#!/usr/bin/env node
// 「零账号可用」验收关卡（F-007，见 docs/plan-remove-login-zai-coupling.md Step 10）。
//
// 为什么需要它：本仓库**没有任何单元测试**。这次拆除最容易的失效形态是
// **静默复发** —— 上游同步、依赖升级或后续改动把登录命令或隐式回连重新引进来，
// 而没有任何东西会失败。痛点 B 当初之所以能长期存在，正是因为这个原因。
//
// 所以这里把「删干净了」做成硬断言，而不是靠一次性人工观察。断言全部选**行为**
// 或**精确字面量**：
//   - 行为：真的去跑 CLI，看它是否还认 login；
//   - 精确字面量：网关改写的路径串（`ultra/anthropic` / `ultra-zai/anthropic`）
//     在产物里只可能来自那次改写，不存在误报。
// 刻意**不做**宽泛的源码文本扫描 —— 假红会训练人放宽断言，比没有断言更糟。
//
// 用法：
//   node test/zero-account-acceptance.mjs          跑全部断言
//   node test/zero-account-acceptance.mjs --list   只列出断言名
//
// 前置：需要已构建的 CLI 产物。未构建时**直接失败并给出构建命令**，不静默跳过。

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = join(repoRoot, "apps/zcode-cli/packages/cli/dist/zcode.cjs");
const builtinConfigPath = join(repoRoot, "config", "provider", "zcode-builtin.json");

/** 网关改写独有、直连不可能产生的路径串。删掉改写后产物里不应再出现。 */
const GATEWAY_PATH_MARKERS = ["ultra-zai/anthropic", "/ultra/anthropic/"];

const results = [];
function assert(name, ok, detail) {
  results.push({ name, ok });
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail && !ok ? `\n        ${detail}` : ""}`);
}

if (process.argv.includes("--list")) {
  console.log("零账号可用验收关卡");
  process.exit(0);
}

if (!existsSync(cliPath)) {
  console.error(`缺少构建产物：${cliPath}`);
  console.error(
    "请先构建：pnpm run build   （注意：pnpm --filter @zcode/cli build 不会重建 adapters）",
  );
  process.exit(1);
}

function runCli(args, { env = {} } = {}) {
  const child = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { status: child.status, stdout: child.stdout ?? "", stderr: child.stderr ?? "" };
}

const mentionsLogin = (text) => /\blogin\b|\blogout\b/i.test(text);

console.log("零账号可用验收关卡");

// —— 1. 命令面：帮助里不能再出现登录入口 ——
{
  const help = runCli(["--help"]);
  const offending = help.stdout
    .split("\n")
    .filter((l) => mentionsLogin(l))
    .map((l) => l.trim());
  assert(
    "zcode --help 不含 login / logout",
    offending.length === 0,
    `仍出现：${offending.join(" | ")}`,
  );
}

// —— 2. 子命令：zcode login 应被判为未知命令 ——
{
  const res = runCli(["login"]);
  const combined = `${res.stdout}${res.stderr}`;
  assert(
    "zcode login 报未知命令",
    /unknown command/i.test(combined) && !/browser authorization/i.test(combined),
    `实际输出：${combined.trim().slice(0, 200)}`,
  );
}

// —— 3. 斜杠命令：/login 与 /logout 应被判为未知命令，且可用列表不含它们 ——
{
  for (const cmd of ["/login", "/logout"]) {
    const res = runCli(["-p", cmd, "--disallowed-tools", "Bash", "Edit", "Write", "Read"]);
    const combined = `${res.stdout}${res.stderr}`;
    assert(
      `headless ${cmd} 报未知命令`,
      /unknown command/i.test(combined),
      `实际输出：${combined.trim().slice(0, 200)}`,
    );
  }
}

// —— 4. 网关改写：产物里不得再有改写路径串（这是 Step 1 的行为断言） ——
{
  const bundle = readFileSync(cliPath, "utf8");
  const found = GATEWAY_PATH_MARKERS.filter((m) => bundle.includes(m));
  assert(
    "构建产物不含平台网关改写路径",
    found.length === 0,
    `仍含：${found.join(", ")}（说明模型请求仍可能被改写到 zcode.z.ai）`,
  );
}

// —— 5. 内置配置：没有模型端点指向 zcode.z.ai（cdn-zcode.z.ai 是另一台主机，不在本关） ——
{
  const config = JSON.parse(readFileSync(builtinConfigPath, "utf8"));
  const rules = config?.config?.providerConfigRules ?? {};
  const zcodeHostUrls = [];
  for (const list of Object.values(rules)) {
    if (!Array.isArray(list)) continue;
    for (const rule of list) {
      const baseUrl = rule?.config?.api?.baseUrl;
      if (typeof baseUrl !== "string") continue;
      let host;
      try {
        host = new URL(baseUrl).host;
      } catch {
        continue;
      }
      if (host === "zcode.z.ai")
        zcodeHostUrls.push(`${rule.providerId ?? rule.templateId} → ${baseUrl}`);
    }
  }
  assert(
    "内置配置无端点指向 zcode.z.ai",
    zcodeHostUrls.length === 0,
    `仍指向：${zcodeHostUrls.join(" | ")}`,
  );
}

// —— 6. 零账号配置路径可用：隔离目录下写入普通厂商配置，不应提到登录 ——
{
  const storage = mkdtempSync(join(tmpdir(), "zcode-zero-account-"));
  try {
    // 清空厂商相关变量：本仓库的 .env 会设置 ZCODE_VENDOR_BASE_URL，与 --provider
    // 指定的厂商端点不一致时会（正确地）报错。本关要验的是"仅凭 API Key 可配置"，
    // 因此必须隔离掉宿主机的 .env 影响。
    const res = runCli(["configure", "--provider", "deepseek", "--api-key", "acceptance-probe"], {
      env: {
        ZCODE_DATA_BASE_DIR: storage,
        // 只留 model（deepseek 的内置模型之一），其余清空以隔离宿主机 .env。
        ZCODE_VENDOR: "",
        ZCODE_VENDOR_BASE_URL: "",
        ZCODE_VENDOR_MODEL: "deepseek-flash",
        ZCODE_VENDOR_API_KEY: "",
      },
    });
    const combined = `${res.stdout}${res.stderr}`;
    assert(
      "仅凭 API Key 即可完成厂商配置（无需账号）",
      res.status === 0 && !mentionsLogin(combined),
      `exit=${res.status} 输出：${combined.trim().slice(0, 200)}`,
    );

    // 落盘凭据中不得出现登录态键
    const credentialPath = join(storage, ".zcode", "v2", "credentials.json");
    let loginKeys = [];
    if (existsSync(credentialPath)) {
      loginKeys = Object.keys(JSON.parse(readFileSync(credentialPath, "utf8"))).filter(
        (k) => k.startsWith("oauth:") || k === "zcodejwttoken",
      );
    }
    assert("凭据落盘无登录态键", loginKeys.length === 0, `仍写入：${loginKeys.join(", ")}`);
  } finally {
    rmSync(storage, { recursive: true, force: true });
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length > 0) {
  console.log("失败项：");
  for (const f of failed) console.log(`  - ${f.name}`);
  process.exit(1);
}
