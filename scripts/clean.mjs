#!/usr/bin/env node
// 清空可重建产物：node_modules 与 dist。
//
// 与本地化资源的关系（docs/plan-offline-vendoring.md Step 2.4）：
//   受保护根下的资源**不属于可重建产物**，绝不能被清理——它们是随仓库上传的交付物，
//   删掉就意味着下次构建要重新回公网，而目标机器未必有公网。
//
// 为什么不能只靠"目录名恰好不在删除列表里"：
//   本脚本按**目录名**匹配（node_modules / dist），所以第三方资源只要不叫这两个名字
//   就"碰巧安全"。这种安全是隐性的——将来有人把 removableNames 放宽，或把资源放到
//   某个 dist/ 下，就会被无声删掉。这里把"不删"变成一条**显式断言**。

import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const packagesDir = join(repoRoot, "packages");
const removableNames = new Set(["node_modules", "dist"]);

const ledgerPath = join(repoRoot, "third-party", "resources.json");
const DEFAULT_PROTECTED_ROOT = "third-party/vendored";

/**
 * 受保护根：台账是唯一真源。台账读不到时用文档化的默认值并**明确告警**——
 * 静默回落到某个常量会让"保护"变成猜测，而这里猜错的代价是删掉交付物。
 */
function readProtectedRoot() {
  try {
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
    if (typeof ledger.protectedRoot === "string" && ledger.protectedRoot) {
      return { root: ledger.protectedRoot, source: "台账" };
    }
    console.warn(`[clean] 台账缺少 protectedRoot 字段，回落到默认值 ${DEFAULT_PROTECTED_ROOT}`);
  } catch (error) {
    console.warn(
      `[clean] 无法读取台账（${error instanceof Error ? error.message : String(error)}），` +
        `回落到默认受保护根 ${DEFAULT_PROTECTED_ROOT}`,
    );
  }
  return { root: DEFAULT_PROTECTED_ROOT, source: "默认值" };
}

const { root: protectedRoot, source: protectedRootSource } = readProtectedRoot();
const protectedRootAbs = resolve(repoRoot, protectedRoot);

function collectPackageDirs() {
  if (!existsSync(packagesDir)) {
    return [];
  }

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name));
}

/** 目标是否落在受保护根之内（含自身）。用相对路径判定，避免前缀字符串误判。 */
export function isInsideProtectedRoot(targetPath) {
  const rel = relative(protectedRootAbs, resolve(targetPath));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`));
}

export function assertSafeTarget(targetPath, ownerDir) {
  if (!removableNames.has(basename(targetPath)) || dirname(targetPath) !== ownerDir) {
    throw new Error(`Refuse to remove unexpected path: ${targetPath}`);
  }
  if (isInsideProtectedRoot(targetPath)) {
    throw new Error(
      `Refuse to remove a path inside the protected root (${protectedRoot}): ${targetPath}\n` +
        `本地化资源是交付物，不是可重建产物。若确实要删，请先把它从台账中移除。`,
    );
  }
}

function removeTarget(targetPath, ownerDir) {
  assertSafeTarget(targetPath, ownerDir);

  if (!existsSync(targetPath)) {
    return false;
  }

  rmSync(targetPath, { force: true, recursive: true });
  console.log(`removed ${targetPath}`);
  return true;
}

/**
 * 清理前记录受保护根下当前存在的所有条目，清理后逐条复核。
 *
 * 用"清理前后快照对比"而不是"断言台账每条都存在"：后者在未本地化的全新克隆上
 * 会误报失败，而快照对比只关心"本来有的有没有被删掉"，这才是本步要保证的事。
 */
function snapshotProtectedRoot() {
  if (!existsSync(protectedRootAbs)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  walk(protectedRootAbs);
  return found;
}

function main() {
  const before = snapshotProtectedRoot();

  const ownerDirs = [repoRoot, ...collectPackageDirs()];
  let removedCount = 0;

  for (const ownerDir of ownerDirs) {
    for (const name of removableNames) {
      if (removeTarget(join(ownerDir, name), ownerDir)) {
        removedCount += 1;
      }
    }
  }

  const after = new Set(snapshotProtectedRoot());
  const lost = before.filter((path) => !after.has(path));

  console.log(`clean removed ${removedCount} director${removedCount === 1 ? "y" : "ies"}`);
  console.log(
    `[clean] 受保护根 ${protectedRoot}（来源：${protectedRootSource}）：清理前 ${before.length} 个文件，清理后 ${after.size} 个`,
  );

  if (lost.length > 0) {
    console.error(`[clean] ✗ 受保护根内的 ${lost.length} 个文件被误删：`);
    for (const path of lost) console.error(`    ${relative(repoRoot, path)}`);
    console.error(`  恢复：node scripts/vendor-resources.mjs fetch`);
    return 1;
  }
  return 0;
}

// 只有作为入口直接执行时才真的删东西。
// 没有这道守卫，任何 `import` 本模块做测试的代码都会连带删掉 node_modules——
// 副作用是"删文件"，比一般 CLI 误触发严重得多。
const isMainModule =
  process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMainModule) {
  process.exit(main());
}
