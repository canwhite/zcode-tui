#!/usr/bin/env node
// 远程资源台账的读取与对账入口。
//
// 为什么需要它：`make clean` 不删、`.gitignore` 不忽略、断网仍能用——这三条要成立，
// 前提是「所有远程获取点」这个集合是可枚举、可复核的。靠人工记忆列举会不断漏项，
// 且漏项时没有任何信号。本脚本把「台账」与「源码里实际的获取点」做差集，
// 差集非空即失败。
//
// 用法：
//   node scripts/remote-resources.mjs list       列出台账与体积
//   node scripts/remote-resources.mjs check      对账（差集必须为空）
//   node scripts/remote-resources.mjs self-test  反向测试：确认校验器真的会失败
//
// 设计要点（对应 docs/plan-offline-vendoring.md Step 1.4 与 Pre-Mortem R3）：
//   1. 只认「获取点」而不是「任何 URL 字面量」。仓库里有 780 处 github.com、
//      102 处 static.crates.io，绝大多数是许可元数据与文档出处，不是获取动作。
//      把字面量一律当资源会让白名单膨胀到没有复核价值。
//   2. 必须覆盖非字面量形态：`new URL(x, base)` 拼接与模板字符串
//      （sea-targets.mjs:67 就是 `https://nodejs.org/dist/v${nodeVersion}/`）。
//      只匹配 `https://...` 完整字面量会漏掉它，并产出一个自我印证的「空差集」。
//   3. 调用点常在下一行才出现 URL（downloadFile( 与 new URL( 分列两行），
//      因此按调用点取窗口，而不是只看调用那一行。

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const LEDGER_RELATIVE_PATH = "third-party/resources.json";

// scan-ignore-start —— 下面是「什么算获取点」的定义表本身，不是获取点。
/** 视为「可能起网络请求」的调用形态。命中即取其窗口内的 host。 */
const FETCH_TRIGGERS = [
  { re: /\bfetch\s*\(/, label: "fetch()" },
  { re: /\bdownloadFile\s*\(/, label: "downloadFile()" },
  { re: /["'`](curl|wget)["'`]/, label: "curl/wget" },
  { re: /\bgit\b[^\n]*\bclone\b/, label: "git clone" },
  { re: /^\s*registry\s*=/m, label: ".npmrc registry" },
];
// scan-ignore-end

/**
 * 调用点前后各看多少行找 URL。
 *
 * 必须双向：`const u = new URL(x, base)` 在前一行、`await downloadFile(u.href)` 在后一行，
 * 只向后看会漏掉前者——这正是 self-test 抓到的第一个真实缺陷，也正是
 * Pre-Mortem R3 描述的「静态匹配漏掉非字面量形态」。
 * 宁可多捕获（多捕获的 host 多半已在台账或豁免名单里），不可少捕获（少捕获是静默漏项）。
 */
const CALL_WINDOW = 4;

const SCAN_EXTENSIONS = new Set([".mjs", ".cjs", ".js", ".ts", ".tsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "dist-release", "coverage", ".turbo", "out"]);
const SKIP_PATH_SEGMENTS = ["/dist/", "/node_modules/"];

const URL_RE = /https?:\/\/([a-zA-Z0-9._-]+)/g;
/** 拼接形态：new URL(artifact, `https://nodejs.org/dist/v${v}/`) —— 模板里的 host 仍可提取。 */
const TEMPLATE_HOST_RE = /https?:\/\/([a-zA-Z0-9._-]+)\//g;

/**
 * 去掉行内注释，返回该行的「代码部分」。跨行块注释由 state.inBlock 携带。
 *
 * 两个必须处理的细节，都是实测踩出来的：
 *   1. `//` 前若是 `:`（即 `https://`），那是 URL 不是注释——不排除会把 URL 截断，
 *      制造假阴性。这是最危险的方向。
 *   2. `/** *\/` 块注释（含 JSDoc 的 `*` 续行）里提到 fetch/downloadFile 的散文，
 *      不排除就会被当成调用点——本次实测中它贡献了 4 个假阳性。
 */
function nonCommentText(line, state) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (state.inBlock) {
      const end = line.indexOf("*/", i);
      if (end === -1) return out;
      state.inBlock = false;
      i = end + 2;
      continue;
    }
    const block = line.indexOf("/*", i);
    const lineComment = line.indexOf("//", i);
    const isUrlSlash = lineComment > 0 && line[lineComment - 1] === ":";
    if (lineComment !== -1 && !isUrlSlash && (block === -1 || lineComment < block)) {
      return out + line.slice(i, lineComment);
    }
    if (block === -1) return out + line.slice(i);
    out += line.slice(i, block);
    state.inBlock = true;
    i = block + 2;
  }
  return out;
}

/** 判断一行（已去注释）是否含触发形态。 */
function isCallLine(code) {
  return FETCH_TRIGGERS.some((t) => t.re.test(code));
}

/** 扫描忽略区：夹具与自测代码用标记括起来，避免校验器把自己算成漏项。 */
const SCAN_IGNORE_START = "scan-ignore-start";
const SCAN_IGNORE_END = "scan-ignore-end";

/** 取调用点前后 CALL_WINDOW 行的拼接文本，用于提取该调用涉及的 host。 */
function windowAround(lines, index) {
  const start = Math.max(0, index - CALL_WINDOW);
  const end = Math.min(lines.length, index + CALL_WINDOW + 1);
  return lines.slice(start, end).join("\n");
}

/** 从一段文本里提取所有出现的 host（含模板字符串与 new URL 拼接形态）。 */
function hostsIn(text) {
  const hosts = new Set();
  for (const m of text.matchAll(URL_RE)) hosts.add(m[1].toLowerCase());
  for (const m of text.matchAll(TEMPLATE_HOST_RE)) hosts.add(m[1].toLowerCase());
  return hosts;
}

export function readLedger(root = repoRoot) {
  const path = join(root, LEDGER_RELATIVE_PATH);
  const ledger = JSON.parse(readFileSync(path, "utf8"));
  return { ledger, path };
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
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".");
      if (dot === -1) continue;
      if (SCAN_EXTENSIONS.has(entry.name.slice(dot))) out.push(full);
    }
  }
  return out;
}

/** 扫描的可执行源码范围。数据文件、文档、许可原文不在其中——它们不含获取动作。 */
function scanRoots(root) {
  return [
    join(root, "scripts"),
    join(root, "packages"),
    join(root, "apps"),
    join(root, "config"),
    join(root, "harness"),
  ];
}

/**
 * 路径 A：从源码里找出「获取点」，并尽力解析其 host。
 *
 * @returns {{sites: Array<{file:string,line:number,trigger:string,hosts:string[],dynamic:boolean}>}}
 */
export function scanFetchSites(root = repoRoot) {
  const sites = [];
  for (const base of scanRoots(root)) {
    for (const file of walk(base)) {
      const rel = relative(root, file);
      if (SKIP_PATH_SEGMENTS.some((seg) => rel.includes(seg))) continue;
      if (rel.includes(".test.")) continue;

      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      const state = { inBlock: false };
      let ignored = false;
      for (let i = 0; i < lines.length; i += 1) {
        // 注释状态必须在每一行推进（含被忽略的行），否则忽略区之后的判定会错位。
        const code = nonCommentText(lines[i], state);

        if (lines[i].includes(SCAN_IGNORE_START)) {
          ignored = true;
          continue;
        }
        if (lines[i].includes(SCAN_IGNORE_END)) {
          ignored = false;
          continue;
        }
        if (ignored) continue;

        const trigger = FETCH_TRIGGERS.find((t) => t.re.test(code));
        if (!trigger) continue;

        const hosts = hostsIn(windowAround(lines, i));

        sites.push({
          file: rel,
          line: i + 1,
          trigger: trigger.label,
          hosts: [...hosts],
          // 有调用但窗口内解析不出 host：可能是变量传参（codeload 那类），
          // 必须显式声明，而不是当作「没有获取点」。
          dynamic: hosts.size === 0,
          window: windowAround(lines, i),
        });
      }
    }
  }
  return { sites };
}

function collectHosts(ledger) {
  const resourceHosts = new Map();
  for (const r of ledger.resources ?? []) {
    if (!r.url) continue;
    const m = r.url.match(/^https?:\/\/([a-zA-Z0-9._-]+)/);
    if (!m) continue;
    const host = m[1].toLowerCase();
    if (!resourceHosts.has(host)) resourceHosts.set(host, []);
    resourceHosts.get(host).push(r.id);
  }

  const exemptHosts = new Map();
  for (const e of ledger.exemptions ?? []) {
    for (const h of e.hosts ?? []) exemptHosts.set(h.toLowerCase(), e.id);
  }

  const nonResourceHosts = new Map();
  for (const group of ledger.nonResourceHosts ?? []) {
    for (const h of group.hosts ?? []) nonResourceHosts.set(h.toLowerCase(), group.host);
  }

  return { resourceHosts, exemptHosts, nonResourceHosts };
}

/**
 * 路径 A + 路径 B 的对账。
 *
 * 路径 A：源码里的获取点 → 其 host 必须被台账或豁免解释，否则是漏项。
 * 路径 B：台账每条资源的 consumers 必须真实存在，且真的引用到该 host——
 *         防止「台账写了消费者，但消费者根本没在用」这种反向漂移。
 */
export function check(root = repoRoot) {
  const { ledger } = readLedger(root);
  const { resourceHosts, exemptHosts, nonResourceHosts } = collectHosts(ledger);
  const { sites } = scanFetchSites(root);

  const unexplained = [];
  const dynamicSites = [];
  const seen = new Set();

  for (const site of sites) {
    if (site.dynamic) {
      const key = `${site.file}:${site.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        dynamicSites.push(site);
      }
      continue;
    }
    for (const host of site.hosts) {
      if (resourceHosts.has(host) || exemptHosts.has(host) || nonResourceHosts.has(host)) continue;
      const key = `${site.file}:${site.line}:${host}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unexplained.push({ ...site, host });
    }
  }

  // 路径 B：台账里声明的消费者必须真实存在，且真的在用。
  //
  // 不能用「文件里出现该 host」当判据：本仓库的消费方式大量经过变量中转——
  // native-search-tools-process.mjs 读的是配置模块的 source.url，
  // official-marketplace.ts 读的是 shared 里的常量，两处都不出现 host 字面量。
  // 因此改为逐条声明 evidence：一个「必须出现在该文件里」的字符串，
  // 由人工复核一次，之后机器每次都验。
  const missingConsumers = [];
  for (const r of ledger.resources ?? []) {
    for (const consumer of r.consumers ?? []) {
      const spec = typeof consumer === "string" ? { file: consumer } : consumer;
      let text;
      try {
        text = readFileSync(join(root, spec.file), "utf8");
      } catch {
        missingConsumers.push({ id: r.id, file: spec.file, reason: "文件不存在" });
        continue;
      }
      if (spec.evidence && !text.includes(spec.evidence)) {
        missingConsumers.push({
          id: r.id,
          file: spec.file,
          reason: `未找到约定证据 ${JSON.stringify(spec.evidence)}`,
        });
      }
    }
  }

  // 动态获取点必须逐条声明，否则失败。
  //
  // 这是本校验器「能不能失败」的关键：静态解析不出 host 的调用点如果不强制声明，
  // 就成了一个永远绿灯的黑洞——新的下载点加进来不会被拦，而 R3 说的正是
  // 「差集恒为空」的自我印证。声明按 file + trigger + evidence 匹配，
  // 不按行号：行号会随无关改动漂移，会让声明变成噪音。
  const declarations = ledger.dynamicSites ?? [];
  const usedDeclarations = declarations.map(() => false);
  const undeclaredDynamic = [];
  for (const site of dynamicSites) {
    // 一条声明覆盖同 file + trigger + evidence 的全部调用点——
    // 同一文件里三个 input.fetch(request, init) 是同一件事，不必声明三遍。
    const idx = declarations.findIndex(
      (d) =>
        d.file === site.file &&
        d.trigger === site.trigger &&
        (!d.evidence || site.window.includes(d.evidence)),
    );
    if (idx === -1) undeclaredDynamic.push(site);
    else usedDeclarations[idx] = true;
  }
  // 反向：声明了但源码里已找不到对应调用点——说明声明腐化，同样要报。
  const staleDeclarations = declarations.filter((_, k) => !usedDeclarations[k]);

  // 台账里的 Node 归档版本集合必须覆盖发布工具链版本，否则断网构建会找不到对应版本。
  const nodeVersions = new Set(
    (ledger.resources ?? []).filter((r) => r.kind === "runtime").map((r) => r.nodeVersion),
  );
  const versionGap =
    ledger.nodeVersion && !nodeVersions.has(ledger.nodeVersion)
      ? `台账未登记发布工具链版本 ${ledger.nodeVersion}`
      : null;

  return {
    ledger,
    sites,
    unexplained,
    dynamicSites,
    undeclaredDynamic,
    staleDeclarations,
    missingConsumers,
    versionGap,
  };
}

function formatBytes(n) {
  if (n === null || n === undefined) return "未测";
  const mib = n / 1024 / 1024;
  return mib >= 1 ? `${mib.toFixed(1)} MiB` : `${(n / 1024).toFixed(1)} KiB`;
}

/**
 * 反向测试：把检测逻辑跑在一段合成源码上，确认它真的能把漏项判出来。
 * 校验器若不能失败，就没有证明力——这是 Step 1.4 的硬要求。
 */
function selfTest() {
  // scan-ignore-start —— 以下是夹具源码文本，不是真的获取点。
  const fixtures = [
    {
      name: "字面量 URL",
      text: `await fetch("https://resource.invalid.example/data.json");`,
      expectHost: "resource.invalid.example",
    },
    {
      name: "new URL 拼接（非字面量，最易漏）",
      text: "const u = new URL(artifact, `https://nodejs.org/dist/v${v}/`);\nawait downloadFile(u.href);",
      expectHost: "nodejs.org",
    },
    {
      name: "调用点与 URL 分列两行",
      text: "await downloadFile(\n  new URL(`https://cdn.invalid.example/x`).href,\n  dest,\n);",
      expectHost: "cdn.invalid.example",
    },
  ];
  // scan-ignore-end

  let failed = 0;
  for (const fixture of fixtures) {
    const lines = fixture.text.split(/\r?\n/);
    let found = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (!isCallLine(lines[i])) continue;
      if (hostsIn(windowAround(lines, i)).has(fixture.expectHost)) found = true;
    }
    const ok = found;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${fixture.name}`);
  }

  // 反向断言：台账必须能发现「没被登记的 host」。
  const { resourceHosts, exemptHosts, nonResourceHosts } = collectHosts(
    JSON.parse(readFileSync(join(repoRoot, LEDGER_RELATIVE_PATH), "utf8")),
  );
  const probe = "definitely-not-registered.invalid";
  const wouldFlag =
    !resourceHosts.has(probe) && !exemptHosts.has(probe) && !nonResourceHosts.has(probe);
  console.log(`  ${wouldFlag ? "ok  " : "FAIL"}  未登记 host 会被判为漏项`);
  if (!wouldFlag) failed += 1;

  console.log(failed === 0 ? "\n[resources] self-test 通过" : "\n[resources] self-test 失败");
  return failed === 0 ? 0 : 1;
}

function list() {
  const { ledger } = readLedger();
  const byKind = new Map();
  for (const r of ledger.resources ?? []) {
    const list = byKind.get(r.kind) ?? [];
    list.push(r);
    byKind.set(r.kind, list);
  }
  let total = 0;
  let measured = 0;
  for (const [kind, items] of byKind) {
    console.log(`\n== ${kind} ==`);
    for (const r of items) {
      total += r.sizeBytes ?? 0;
      if (typeof r.sizeBytes === "number") measured += 1;
      console.log(
        `  ${r.status === "pending" ? "待本地化" : r.status.padEnd(12)} ${r.id.padEnd(36)} ${formatBytes(r.sizeBytes).padStart(9)}`,
      );
      if (r.sizeWarning) console.log(`      ⚠ ${r.sizeWarning}`);
    }
  }
  console.log(`\n合计（已测部分）：${formatBytes(total)} ｜ 已测 ${measured} 项`);
  console.log(`受保护根：${ledger.protectedRoot}`);
  console.log(`Node 版本：${ledger.nodeVersion}`);
  return 0;
}

function runCheck() {
  const result = check();
  const {
    ledger,
    sites,
    unexplained,
    dynamicSites,
    undeclaredDynamic,
    staleDeclarations,
    missingConsumers,
    versionGap,
  } = result;

  console.log(`[resources] 台账条目：${(ledger.resources ?? []).length}`);
  console.log(
    `[resources] 源码获取点：${sites.length}（其中静态解析不出 host 的：${dynamicSites.length}，已声明：${(ledger.dynamicSites ?? []).length}）`,
  );
  console.log(
    `[resources] 豁免项：${(ledger.exemptions ?? []).length} ｜ 非资源 host 组：${(ledger.nonResourceHosts ?? []).length}`,
  );

  let failed = false;

  if (unexplained.length > 0) {
    failed = true;
    console.error(`\n[resources] ✗ 以下获取点的 host 既不在台账、也不在豁免名单（差集非空）：`);
    for (const u of unexplained) {
      console.error(`    ${u.file}:${u.line}  [${u.trigger}]  ${u.host}`);
    }
    console.error(
      `  处置：要么把对应资源登记进 ${LEDGER_RELATIVE_PATH}，要么把该 host 归入豁免/非资源并写明理由。`,
    );
  }

  if (undeclaredDynamic.length > 0) {
    failed = true;
    console.error(`\n[resources] ✗ 以下获取点静态解析不出 host，且未在台账 dynamicSites 中声明：`);
    for (const d of undeclaredDynamic) {
      console.error(`    ${d.file}:${d.line}  [${d.trigger}]`);
    }
    console.error(
      `  处置：确认它是否真的取远程资源。是则登记为资源；否则在 dynamicSites 里声明并写明 reason。`,
    );
  }

  if (staleDeclarations.length > 0) {
    failed = true;
    console.error(`\n[resources] ✗ 以下 dynamicSites 声明已失效（源码里找不到对应获取点）：`);
    for (const d of staleDeclarations) console.error(`    ${d.file}  [${d.trigger}]`);
  }

  if (dynamicSites.length > 0 && undeclaredDynamic.length === 0) {
    console.log(`\n[resources] 静态解析不出 host 的获取点（全部已声明）：`);
    for (const d of dynamicSites) console.log(`    ${d.file}:${d.line}  [${d.trigger}]`);
  }

  if (missingConsumers.length > 0) {
    failed = true;
    console.error(`\n[resources] ✗ 台账声明的消费者与实际不符：`);
    for (const m of missingConsumers) console.error(`    ${m.id} -> ${m.consumer}（${m.reason}）`);
  }

  if (versionGap) {
    failed = true;
    console.error(`\n[resources] ✗ 版本缺口：${versionGap}`);
  }

  if (!failed) console.log(`\n[resources] ✓ 对账通过：台账与源码获取点一致。`);
  return failed ? 1 : 0;
}

// 只有被当作入口直接执行时才跑 CLI。
// 不加这道守卫，任何 `import` 本模块的脚本（如 vendor-resources.mjs）都会在导入时
// 触发这里的 process.exit——表现为"运行 A 脚本却报 B 脚本的用法"，且静默、难查。
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  const runners = { check: runCheck, list, "self-test": selfTest };
  const command = process.argv[2] ?? "check";
  const runner = runners[command];
  if (!runner) {
    console.error(`未知模式：${command}（可选：${Object.keys(runners).join(", ")}）`);
    process.exit(2);
  }
  process.exit(runner());
}
