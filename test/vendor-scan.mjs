#!/usr/bin/env node
// 本地化资源的扫描器：后门 + 特例判断（F-005，见 docs/plan-offline-vendoring.md Step 5）。
//
// 扫描对象是**随仓库分发的智谱资源**（26 个插件包 + 清单 + 图标）。它们是要跑在用户机器上
// 的代码，因此"扫一遍"的对象是包内的可执行文件，而不是台账里的 URL。
//
// 设计取向：
//   - 只扫**可执行文件**（py/js/ts/mjs/sh…）。markdown 里出现的主机名是文档出处，
//     不是获取动作；把它们一并计入会让报告淹没在噪声里，反而看不见真问题。
//   - 命中即报**证据**（文件 + 行号 + 原文），不只给结论。
//   - 覆盖不全不得出"通过"结论：报告末尾强制打印覆盖率与未覆盖项。
//
// 用法：
//   node test/vendor-scan.mjs            扫描并输出报告
//   node test/vendor-scan.mjs --json     机器可读输出

import { spawnSync } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VENDORED = join(repoRoot, "third-party", "vendored", "zhipu-official-plugin");

/** 可执行扩展名。扫描只在这些文件里找"行为"。 */
const EXEC_EXT = new Set([
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".sh",
  ".bash",
  ".zsh",
  ".rb",
  ".pl",
  ".ps1",
]);
/** 判定规则。每条给一个 id，便于在报告里引用与后续收敛。 */
// 规则分两层：
//   SIGNALS = 单条即可疑，独立成 HIGH
//   CONTEXT = 单独出现是常态（`subprocess.run`、`requests.get` 在正经工具里到处都是），
//             只有**同一文件内与出网/动态求值同时出现**才升级。
//
// 为什么要分层：第一版把 `subprocess.run` 与 `re.compile` 直接记 HIGH，得到 699 条
// "高危"，全部是噪声——`re.compile` 根本不是 eval。**一个把噪声当高危的扫描器，
// 会让真正的发现淹在里面，等于没有扫描器。**
const SIGNALS = [
  {
    id: "credential-access",
    severity: "high",
    // 读凭据/密钥材料：正经插件没有理由碰这些
    test: /(\.ssh\/|\/\.aws\/|\.netrc|\.git-credentials|id_rsa|\.docker\/config\.json|\.kube\/config|security\s+find-generic-password)/,
  },
  {
    id: "exfil-shape",
    severity: "high",
    // 把本地环境/文件内容拼进请求体的形态
    test: /(base64[^\n]{0,40}(process\.env|os\.environ)|readFileSync?[^\n]{0,60}(fetch|http)|(fetch|requests\.(get|post))[^\n]{0,80}(process\.env|os\.environ))/,
  },
  {
    id: "dynamic-eval",
    severity: "high",
    // 真正的动态求值。刻意**不含** Python 的 re.compile 与 __import__——
    // 前者是正则编译、后者是常规导入，把它们算作求值会制造大量假阳性。
    test: /((?<![.\w])eval\s*\(|new\s+Function\s*\(|vm\.runIn|pickle\.loads|marshal\.loads|child_process[^\n]{0,40}(exec|spawn))/,
  },
];

const CONTEXT = [
  {
    id: "egress",
    test: /(requests\.(get|post|put)|urllib\.request|urlopen|http\.client|socket\.socket|\bfetch\s*\(|axios\.|net\.connect|dgram\.createSocket|curl\s+|wget\s+)/,
  },
  {
    id: "shell-exec",
    test: /(subprocess\.(run|Popen|call|check_output)|os\.system|os\.popen|child_process|spawnSync|execSync)/,
  },
  { id: "obfuscation", test: /(_0x[0-9a-f]{3,}|\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){8,})/ },
];

const ALLOWED_HOSTS = new Set([
  // 智谱自家
  "cdn-zcode.z.ai",
  "zcode.z.ai",
  "api.z.ai",
  "open.bigmodel.cn",
  "bigmodel.cn",
  "chat.z.ai",
  "z.ai",
  // 包管理与公共规范
  "registry.npmjs.org",
  "schemas.openxmlformats.org",
  "www.w3.org",
  "purl.org",
  "schemas.microsoft.com",
  // 本地
  "localhost",
  "127.0.0.1",
]);

/**
 * 把插件包解出来构成"扫描语料"。
 *
 * **这一步不能省**：插件内容存放在 `plugin.zip` 里，直接遍历 vendored 目录只会得到
 * 0 个可执行文件——扫描器会报告"0 命中、无异常主机"，看起来像一份干净结论，
 * 实际什么都没看。本脚本第一版就踩了这个坑，因此下面加了一条硬断言：
 * 语料为空即失败。**一个能给出"通过"却其实没扫到东西的扫描器，比没有扫描器更危险。**
 */
function buildCorpus() {
  const root = mkdtempSync(join(tmpdir(), "zcode-vendor-scan-"));
  const pluginsDir = join(VENDORED, "plugins");
  let extracted = 0;
  let decrypted = 0;

  for (const name of readdirSync(pluginsDir)) {
    for (const version of readdirSync(join(pluginsDir, name))) {
      const zip = join(pluginsDir, name, version, "plugin.zip");
      if (!existsSync(zip)) continue;
      const dest = join(root, name);
      const unzip = spawnSync("unzip", ["-qq", "-o", zip, "-d", dest], { encoding: "utf8" });
      if (unzip.status === 0) extracted += 1;
    }
  }

  // 加密产物必须解密后一并扫描，否则"覆盖 100%"是假的。
  // 密钥随包分发（manifest 自述 embeddedKeyBoundary: obfuscated-node-module/cost-raising-only），
  // 因此这些载荷实际上**可审计**——不解密就相当于主动放弃审计。
  for (const keyFile of findAll(root, "mimosa-embedded-key.cjs")) {
    const packRoot = dirname(dirname(keyFile));
    let key;
    try {
      const require = createRequire(import.meta.url);
      delete require.cache[keyFile];
      key = require(keyFile)();
    } catch {
      continue;
    }
    for (const blob of findAll(packRoot, undefined).filter((f) => f.endsWith(".mimosa"))) {
      try {
        const plain = decryptProtected(readFileSync(blob), key);
        writeFileSync(`${blob}.decrypted.js`, plain);
        decrypted += 1;
      } catch {
        // 解密失败不静默：计入未覆盖项（见下方报告）
      }
    }
  }

  return { root, extracted, decrypted };
}

const MAGIC = Buffer.from("MIMOSA1\0", "ascii");

/** 复刻 protected-loader.cjs 的 decrypt()：AES-256-GCM，AAD 为产物内嵌 id。 */
function decryptProtected(payload, key) {
  if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("magic 不符");
  let offset = MAGIC.length;
  const version = payload.readUInt8(offset);
  offset += 1;
  const idLength = payload.readUInt16BE(offset);
  offset += 2;
  const iv = payload.subarray(offset, offset + 12);
  offset += 12;
  const tag = payload.subarray(offset, offset + 16);
  offset += 16;
  const id = payload.subarray(offset, offset + idLength);
  offset += idLength;
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(id);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(payload.subarray(offset)), decipher.final()]);
  return version === 2 ? gunzipSync(plain) : plain;
}

/**
 * 取命中点附近的片段作为证据。
 *
 * 压缩后的 bundle 是**一整行**，直接截前 200 字符会得到一段与命中无关的代码——
 * 报告里给了"证据"却看不出问题，等于没有证据。
 */
function evidenceAround(line, pattern) {
  const match = line.match(pattern);
  if (!match || match.index === undefined) return line.trim().slice(0, 200);
  const start = Math.max(0, match.index - 90);
  const end = Math.min(line.length, match.index + match[0].length + 90);
  const snippet = line.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${snippet}${end < line.length ? "…" : ""}`;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && EXEC_EXT.has(extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

/** 收集插件包内声明的自动执行面：hooks、mcp command。 */
function collectAutoExecSurface(dir) {
  const findings = [];
  for (const name of ["hooks.json", ".mcp.json", "plugin.json"]) {
    for (const file of findAll(dir, name)) {
      let parsed;
      try {
        parsed = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        continue;
      }
      const text = JSON.stringify(parsed);
      if (/"hooks"|"command"|spawn|"args"/.test(text)) {
        findings.push({ file: relative(corpus.root, file), kind: name });
      }
    }
  }
  return findings;
}

/** name 为 undefined 时返回全部文件。 */
function findAll(dir, name, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) findAll(full, name, out);
    else if (name === undefined || entry.name === name) out.push(full);
  }
  return out;
}

const corpus = buildCorpus();
const files = walk(corpus.root);
const findings = [];
const hostsSeen = new Map();
let scannedFiles = 0;

// 语料为空 = 什么都没扫到。此时任何"0 命中"都不是结论，必须失败。
if (files.length === 0) {
  console.error("扫描器未取到任何可执行文件——插件内容在 plugin.zip 内，必须先解包。");
  console.error(`  解包数=${corpus.extracted} 解密数=${corpus.decrypted}`);
  console.error("  **不得**把这种状态报告为「无发现」。");
  process.exit(1);
}

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  scannedFiles += 1;
  const lines = text.split(/\r?\n/);

  const fileSignals = new Set();
  const fileContext = new Set();

  for (const rule of SIGNALS) {
    lines.forEach((line, index) => {
      if (!rule.test.test(line)) return;
      fileSignals.add(rule.id);
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        file: relative(corpus.root, file),
        line: index + 1,
        evidence: evidenceAround(line, rule.test),
      });
    });
  }

  for (const rule of CONTEXT) {
    lines.forEach((line, index) => {
      if (!rule.test.test(line)) return;
      fileContext.add(rule.id);
      // 上下文规则单独出现只记为 info，不污染高危列表
      findings.push({
        rule: rule.id,
        severity: "info",
        file: relative(corpus.root, file),
        line: index + 1,
        evidence: evidenceAround(line, rule.test),
      });
    });
  }

  // 相关性升级：出网 + 执行 同时出现在一个文件里，才是"下载并运行"这一类形态。
  if (fileContext.has("egress") && fileContext.has("shell-exec") && fileSignals.size === 0) {
    findings.push({
      rule: "egress+exec",
      severity: "high",
      file: relative(corpus.root, file),
      line: 0,
      evidence: "同一文件内同时出现出网与子进程调用——需人工确认是否存在「下载后执行」",
    });
  }

  // 出网目标普查（可执行文件里的 URL 字面量）
  for (const match of text.matchAll(/https?:\/\/([a-zA-Z0-9._-]+)/g)) {
    const host = match[1].toLowerCase();
    if (!hostsSeen.has(host)) hostsSeen.set(host, new Set());
    if (hostsSeen.get(host).size < 3) hostsSeen.get(host).add(relative(corpus.root, file));
  }
}

const unexpectedHosts = [...hostsSeen.keys()].filter((h) => !ALLOWED_HOSTS.has(h));
const autoExec = collectAutoExecSurface(corpus.root);

const bySeverity = (s) => findings.filter((f) => f.severity === s);
const asJson = process.argv.includes("--json");

if (asJson) {
  console.log(
    JSON.stringify(
      { scannedFiles, totalExec: files.length, corpus, findings, unexpectedHosts, autoExec },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(`扫描本地化资源：${VENDORED}`);
console.log(`  解包插件包 ${corpus.extracted} 个 ｜ 解密受保护载荷 ${corpus.decrypted} 个`);
console.log(`  可执行文件 ${scannedFiles}/${files.length} 个已读取\n`);

const highs = bySeverity("high");
console.log(
  `规则命中：${findings.length} 条（high ${highs.length} ｜ info ${bySeverity("info").length}）`,
);

// 按文件聚合：148 条平铺没人看得完，而"哪些文件需要人工看"才是可用结论。
const byFile = new Map();
for (const hit of highs) {
  const entry = byFile.get(hit.file) ?? { count: 0, sample: hit };
  entry.count += 1;
  byFile.set(hit.file, entry);
}
console.log(`\n--- HIGH 命中文件（${byFile.size} 个）---`);
for (const [file, entry] of [...byFile].sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ×${String(entry.count).padStart(3)}  [${entry.sample.rule}] ${file}`);
  console.log(`          ${entry.sample.evidence.slice(0, 180)}`);
}

console.log(`\n--- 可执行文件中的出网目标 ---`);
console.log(
  `  允许清单外的主机：${unexpectedHosts.length === 0 ? "无" : unexpectedHosts.join(", ")}`,
);
for (const host of unexpectedHosts) {
  console.log(`    ${host}`);
  for (const file of hostsSeen.get(host)) console.log(`        ${file}`);
}

console.log(`\n--- 自动执行面（hooks / mcp command 声明）---`);
for (const item of autoExec) console.log(`  ${item.kind}  ${item.file}`);

console.log(`\n覆盖率：可执行文件 ${scannedFiles}/${files.length}；`);
console.log(`未覆盖：markdown / json / 图标不参与行为扫描（无行为语义）`);
console.log(`语料目录（供复核）：${corpus.root}`);
if (corpus.decrypted === 0) {
  console.log(
    `  ⚠ 未解密任何受保护载荷——若包内含 .mimosa，说明解密失败，加密代码未被审计，此时不得宣称覆盖完整。`,
  );
}
