// 智谱官方 CDN 资源的本地副本解析。
//
// 背景：官方插件市场（清单 + 26 个插件包 + 图标）托管在 cdn-zcode.z.ai。断网环境下，
// 用户会看到市场却装不了任何东西——这正是本次本地化要解决的问题。
// 本地副本随仓库分发，路径与 CDN 目录结构**一一对应**，因此 URL → 本地路径是一次
// 纯字符串变换，不需要在运行期读台账、也不需要额外的映射表。
//
// 为什么不做成"读 third-party/resources.json"：运行期产物（含 SEA）不该依赖仓库内的
// 构建期数据文件；而 URL 结构本身就是稳定的寻址契约。台账的职责是**校验本地副本是否
// 齐全**（scripts/vendor-resources.mjs verify），不是运行期寻址。

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** 智谱官方资源 CDN 前缀。清单里的 26 个插件包与全部图标都在这个前缀下。 */
export const ZHIPU_OFFICIAL_ASSET_BASE_URL = "https://cdn-zcode.z.ai/zcode/official-plugin/";

/** 本地副本相对仓库根的目录，与 CDN 目录结构同构。 */
const VENDORED_ROOT_RELATIVE = join("third-party", "vendored", "zhipu-official-plugin");

/** 判定一个 URL 是否属于智谱官方 CDN。非智谱来源（社区插件、GitHub 等）不受本地优先约束。 */
export function isZhipuOfficialAssetUrl(url: string): boolean {
  return url.startsWith(ZHIPU_OFFICIAL_ASSET_BASE_URL);
}

/**
 * 把官方 CDN URL 映射为本地副本的相对路径。
 *
 * 返回 undefined 的两种情况：URL 不属于官方 CDN；或映射结果越出受保护根
 * （`..`、绝对路径、空路径都视为越界）。后者是防御性的——URL 来自远端清单，
 * 是可以被上游影响的输入，不能拿它直接拼文件系统路径。
 */
export function officialAssetRelativePath(url: string): string | undefined {
  if (!isZhipuOfficialAssetUrl(url)) return undefined;
  const suffix = url.slice(ZHIPU_OFFICIAL_ASSET_BASE_URL.length).split(/[?#]/)[0];
  if (!suffix) return undefined;
  if (isAbsolute(suffix) || suffix.includes("\0")) return undefined;

  const normalized = suffix.split("/").filter((segment) => segment !== "" && segment !== ".");

  // 本函数必须**自证**其契约（"返回受保护根之下的合法相对路径"），
  // 不能把安全性寄托在调用方还会再查一次。实测过：只做下面的 `..` 判断时，
  // `%2e%2e/%2e%2e/etc/passwd` 与 `..\..\etc\passwd` 都能**原样通过本函数**，
  // 仅靠调用方的二次 relative() 检查才没出事——那是单层防御，且对后来者是个陷阱。
  if (
    normalized.length === 0 ||
    normalized.some(
      (segment) =>
        segment === ".." ||
        // Windows 上反斜杠也是分隔符，含它的段在别的消费路径下可能构成穿越。
        segment.includes("\\") ||
        // 百分号编码的 `..`（%2e%2e）不做解码就躲过了字面量判断，直接拒绝任何编码。
        segment.includes("%"),
    )
  ) {
    return undefined;
  }
  return normalized.join("/");
}

/** 候选基准目录。与官方插件 seed 的查找策略一致：入口目录优先，其次运行时目录与 cwd。 */
function candidateBaseDirs(): string[] {
  const dirs = [
    process.argv[1] ? dirname(process.argv[1]) : undefined,
    typeof __dirname === "string" ? __dirname : undefined,
    process.cwd(),
  ];
  return dirs.filter((dir): dir is string => typeof dir === "string");
}

/**
 * 定位本地副本根目录。
 *
 * 用 `marketplace.json` 作为存在性标记——它是本地化资源的入口文件，
 * 缺了它其余 51 个文件也没有意义。逐级向上探测，覆盖
 * 「仓库根 / dist 目录 / 打包后的同级目录」几种布局。
 */
export function resolveVendoredOfficialRoot(): string | undefined {
  // 显式覆盖：两个用途——
  //   1) 运维把副本放在共享挂载上时，不必把仓库目录复制过去；
  //   2) 验收脚本证明「本地副本确实是必需的」——把它指向不存在的路径，
  //      在断网下安装必须失败。不这样做就只能靠"装成功了"来推断命中了本地，
  //      而那同样可能是缓存或回源造成的假通过。
  const override = process.env.ZCODE_VENDORED_ASSETS_ROOT?.trim();
  if (override) {
    if (existsSync(join(override, "marketplace.json"))) {
      debugLog(`使用 ZCODE_VENDORED_ASSETS_ROOT 指定的本地副本根：${override}`);
      return override;
    }
    debugLog(`ZCODE_VENDORED_ASSETS_ROOT=${override} 下没有 marketplace.json，视为无本地副本`);
    return undefined;
  }

  const bases = candidateBaseDirs();
  for (const baseDir of bases) {
    let current = resolve(baseDir);
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(current, VENDORED_ROOT_RELATIVE);
      if (existsSync(join(candidate, "marketplace.json"))) {
        debugLog(`命中本地副本根：${candidate}（基准 ${baseDir}，上溯 ${depth} 层）`);
        return candidate;
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  debugLog(`未找到本地副本根。基准目录：${bases.join(" | ")}`);
  return undefined;
}

/**
 * 常驻诊断，默认关闭：`ZCODE_DEBUG_VENDOR=1` 时输出。
 *
 * 保留它是因为"本地副本没被找到"是这条链路在交付现场最可能、也最难远程判断的故障——
 * 它的表现只是"插件装不上"，而原因可能是：跑在没带 `third-party/vendored/` 的目录下、
 * 落在某个 .gitignore 里没随仓库分发、或副本损坏。这三种原因的修法完全不同，
 * 而一行基准目录日志就能一次区分。
 */
function debugLog(message: string): void {
  if (process.env.ZCODE_DEBUG_VENDOR) console.error(`[DEBUG-vendor] ${message}`);
}

/** 本地副本的绝对路径；不存在则 undefined。 */
export function resolveVendoredOfficialAssetPath(url: string): string | undefined {
  const relativePath = officialAssetRelativePath(url);
  if (!relativePath) return undefined;
  const root = resolveVendoredOfficialRoot();
  if (!root) return undefined;

  const target = resolve(root, relativePath);
  // 双重保险：即使 officialAssetRelativePath 放行了，也再确认落点在根之内。
  const rel = relative(root, target);
  if (rel.startsWith("..") || rel.includes(`..${sep}`)) return undefined;
  return existsSync(target) ? target : undefined;
}

/** 读取本地副本字节；不存在则 undefined（由调用方决定是回源还是报错）。 */
export function readVendoredOfficialAsset(url: string): Buffer | undefined {
  const path = resolveVendoredOfficialAssetPath(url);
  if (!path) return undefined;
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}
