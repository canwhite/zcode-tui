import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@zcode/contracts";
import {
  readVendoredOfficialAsset,
  ZHIPU_OFFICIAL_ASSET_BASE_URL,
} from "./official-vendored-assets.js";

const BUNDLED_PARTITION_FILE = "bundled-marketplace.json";
const CDN_PARTITION_FILE = "cdn-marketplace.json";
const MERGED_MARKETPLACE_FILE = "marketplace.json";

interface BundledMarketplacePartition {
  manifest: Record<string, unknown>;
  version: 1;
}

export function writeBundledOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, BUNDLED_PARTITION_FILE), {
    manifest: input.manifest,
    version: 1,
  } satisfies BundledMarketplacePartition);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

export function writeCdnOfficialMarketplacePartitionSync(input: {
  manifest: Record<string, unknown>;
  storageRoot: string;
}): Record<string, unknown> {
  assertOfficialManifest(input.manifest);
  writeJsonFileSync(partitionPath(input.storageRoot, CDN_PARTITION_FILE), input.manifest);
  return rebuildOfficialMarketplaceSync(input.storageRoot);
}

/**
 * 用随仓库分发的官方清单为 CDN 分片播种（**仅在分片尚不存在时**）。
 *
 * 为什么播到 CDN 分片、而不是内置分片：随仓库分发的 `marketplace.json` 就是 CDN 目录的
 * 内容快照，条目带 `source.url` + `source.sha256`；而内置插件的条目带 `cachePath`
 * （内容已 seed 到本地缓存）。两者是不同形态，混进内置分片会和 `loadBundledOfficialPluginRootsSync`
 * 的 cachePath 校验冲突。放进 CDN 分片既符合语义，也让后续的 CDN 刷新
 * （`writeCdnOfficialMarketplacePartitionSync`）自然覆盖它，不需要任何额外分支。
 *
 * 已存在则不覆盖：用户可能已经从 CDN 刷新到了更新的目录，回退成仓库里那份旧快照
 * 会让"刷新"这个动作失去意义。
 *
 * @returns 是否真的播种了
 */
export function seedCdnPartitionFromVendoredSync(storageRoot: string): boolean {
  if (process.env.ZCODE_DEBUG_VENDOR) {
    console.error(`[DEBUG-vendor] seed 被调用，storageRoot=${storageRoot}`);
  }
  if (readJsonRecord(partitionPath(storageRoot, CDN_PARTITION_FILE)) !== undefined) {
    if (process.env.ZCODE_DEBUG_VENDOR) console.error(`[DEBUG-vendor] cdn 分片已存在，跳过`);
    return false;
  }

  const bytes = readVendoredOfficialAsset(`${ZHIPU_OFFICIAL_ASSET_BASE_URL}marketplace.json`);
  if (!bytes) {
    if (process.env.ZCODE_DEBUG_VENDOR) console.error(`[DEBUG-vendor] 读不到本地清单`);
    return false;
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(bytes.toString("utf8"));
  } catch {
    // 本地副本损坏不是致命错误：不播种即可，市场会退化成仅内置插件。
    // 损坏本身由 `node scripts/vendor-resources.mjs verify` 负责报出。
    return false;
  }
  if (!isRecord(manifest) || manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) return false;

  writeCdnOfficialMarketplacePartitionSync({ manifest, storageRoot });
  return true;
}

export function loadBundledOfficialPluginRootsSync(storageRoot: string): string[] | undefined {
  const bundledPartition = readBundledPartition(storageRoot);
  if (!bundledPartition) return undefined;

  const officialCacheRoot = resolve(storageRoot, "cache", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE);
  return readPluginEntries(bundledPartition.manifest).flatMap((plugin) => {
    const name = readPluginName(plugin);
    const cachePath = typeof plugin.cachePath === "string" ? plugin.cachePath : undefined;
    if (!name || !cachePath) return [];

    const pluginCacheRoot = resolve(officialCacheRoot, name);
    const resolvedCachePath = resolve(cachePath);
    if (
      !isStrictDescendant(officialCacheRoot, pluginCacheRoot) ||
      !isStrictDescendant(pluginCacheRoot, resolvedCachePath)
    ) {
      return [];
    }
    return [resolvedCachePath];
  });
}

function rebuildOfficialMarketplaceSync(storageRoot: string): Record<string, unknown> {
  const bundledPartition = readBundledPartition(storageRoot);
  const cdnManifest = readJsonRecord(partitionPath(storageRoot, CDN_PARTITION_FILE));
  const bundledManifest = bundledPartition?.manifest;
  const cdnPlugins = readPluginEntries(cdnManifest);
  const cdnPluginNames = new Set(cdnPlugins.map(readPluginName).filter(isDefined));
  const bundledPlugins = readPluginEntries(bundledManifest).filter((plugin) => {
    const name = readPluginName(plugin);
    return name !== undefined && !cdnPluginNames.has(name);
  });

  // 内置插件与 CDN 插件曾使用两个 marketplace id，UI 会把内置市场当成
  // 无 source 的独立市场并在刷新时报 not found。两个分片必须独立持久化后再合并，
  // 否则应用启动时的 seed 会覆盖 CDN 目录，或 CDN 刷新会覆盖内置目录。同名时以
  // 可刷新的 CDN 市场条目为准，但只过滤合并目录，不删除应用内置缓存。
  const merged = {
    ...(bundledManifest ?? {}),
    ...(cdnManifest ?? {}),
    name: ZCODE_OFFICIAL_PLUGIN_MARKETPLACE,
    plugins: [...cdnPlugins, ...bundledPlugins],
  };
  writeJsonFileSync(partitionPath(storageRoot, MERGED_MARKETPLACE_FILE), merged);
  return merged;
}

function readBundledPartition(storageRoot: string): BundledMarketplacePartition | undefined {
  const value = readJsonRecord(partitionPath(storageRoot, BUNDLED_PARTITION_FILE));
  if (!value || value.version !== 1 || !isRecord(value.manifest)) return undefined;
  return {
    manifest: value.manifest,
    version: 1,
  };
}

function readPluginEntries(
  manifest: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return Array.isArray(manifest?.plugins) ? manifest.plugins.filter(isRecord) : [];
}

function readPluginName(plugin: Record<string, unknown>): string | undefined {
  return typeof plugin.name === "string" && plugin.name.length > 0 ? plugin.name : undefined;
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function isStrictDescendant(parentPath: string, childPath: string): boolean {
  const relativePath = relative(parentPath, childPath);
  return (
    relativePath.length > 0 &&
    !isAbsolute(relativePath) &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`)
  );
}

function assertOfficialManifest(manifest: Record<string, unknown>): void {
  if (manifest.name !== ZCODE_OFFICIAL_PLUGIN_MARKETPLACE) {
    throw new Error(
      `Official marketplace manifest must be named ${ZCODE_OFFICIAL_PLUGIN_MARKETPLACE}`,
    );
  }
}

function partitionPath(storageRoot: string, fileName: string): string {
  return join(storageRoot, "marketplaces", ZCODE_OFFICIAL_PLUGIN_MARKETPLACE, fileName);
}

function readJsonRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeJsonFileSync(path: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  mkdirSync(dirname(path), { recursive: true });
  try {
    // 官方目录在每次启动都会重建；同内容反复写盘会增加 Windows 上
    // marketplace 文件被杀毒/索引器占用的概率。只跳过字节完全相同的单文件写入，
    // 读取失败或内容变化仍执行写入并保留原有失败语义。
    if (readFileSync(path, "utf8") === contents) return;
  } catch {
    // 文件不存在或暂时不可读时继续写，让真实更新失败继续向调用方暴露。
  }
  writeFileSync(path, contents, "utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
