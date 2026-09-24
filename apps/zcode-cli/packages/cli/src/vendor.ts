import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import type { CliEnv } from "./env.js";

/**
 * 厂商解析：把 .env 的四字段（VENDOR / BASE_URL / API_KEY / MODEL）解析为一组确定性事实。
 *
 * 设计要点：
 *   - **本模块的任何函数都不抛异常**。.env 在每次 CLI 启动时被入口读取，
 *     解析抛错会把"配置写错"升级成"整个 zcode 不可用"，连 doctor 都起不来。
 *     解析只产出 ok/error 结果，由调用方决定何时上报。
 *   - **不猜**。厂商名找不到、端点与厂商不自洽、端点命中多个模板——一律报错，
 *     绝不回退到"随便选一个"，因为静默换厂商是最难排查的一类问题。
 */

export const VENDOR_ENV_KEYS = {
  vendor: "QCODE_VENDOR",
  baseUrl: "QCODE_VENDOR_BASE_URL",
  apiKey: "QCODE_VENDOR_API_KEY",
  model: "QCODE_VENDOR_MODEL",
} as const;

export type VendorKind = "coding-plan" | "api-key";

/** 内置配置里的一条厂商定义（模板或 account 型 provider）。 */
export interface BuiltinVendor {
  /** 展示与配置用的标识。 */
  id: string;
  kind: VendorKind;
  baseUrl: string;
  apiType: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  /** 该厂商声明的模型清单；自定义场景下不存在。 */
  modelIds: readonly string[];
  /** account 型 provider 的 providerId（仅 coding-plan），如 `account:bigmodel-individual-coding-plan`。 */
  accountProviderId?: string;
  /**
   * 套餐的账号族，取自内置配置的 `access.accountType`（如 `bigmodel` / `zai`）。
   *
   * 这是凭据层要的值：它按 family 在账号 Overlay 里定位 Provider。
   * **不要**从 `accountProviderId` 里切分推导——那依赖 id 的拼写格式，
   * 遇到含连字符的族名会静默切错。
   */
  family?: string;
  /** 供用户手写的短名，如 `bigmodel` / `moonshot`。 */
  alias?: string;
}

/**
 * 短名映射。键是用户手写的值，值必须能唯一命中内置配置里的一条厂商。
 *
 * 默认指向"最常用"的那一条：裸 `bigmodel` / `zai` 给个人套餐，
 * 因为用户手里那张 Coding Plan 就属于这一类；要普通 API Key 用 `-standard` 后缀。
 * 映射表是显式的——不做任何基于前缀或包含关系的猜测。
 */
const VENDOR_ALIASES: Record<string, string> = {
  bigmodel: "bigmodel-individual-coding-plan",
  "bigmodel-standard": "bigmodel-standard-api",
  zai: "zai-individual-coding-plan",
  "zai-standard": "zai-standard-api",
  "bigmodel-team-plan": "bigmodel-team-coding-plan",
  "zai-team-plan": "zai-team-coding-plan",
  moonshot: "moonshot-kimi",
  qwen: "qwen-alibaba-model-studio-cn",
  "qwen-cn": "qwen-alibaba-model-studio-cn",
  "qwen-intl": "qwen-alibaba-model-studio-intl",
  xiaomi: "xiaomi-mimo",
  kimi: "moonshot-kimi",
};

/**
 * 收集当前内置配置下可用的短名。
 * 映射表里指向不存在厂商的条目会被剔除——内置配置更新后，失效的短名应当
 * 从"可选值"里消失并走到"未识别厂商"的报错，而不是静默指向别处。
 */
export function availableAliases(vendors: readonly BuiltinVendor[]): string[] {
  const ids = new Set(vendors.map((vendor) => vendor.id));
  return Object.entries(VENDOR_ALIASES)
    .filter(([, target]) => ids.has(target))
    .map(([alias]) => alias)
    .sort();
}

export interface ResolvedVendor {
  vendor: BuiltinVendor | { id: string; kind: "api-key"; baseUrl: string; apiType: undefined; modelIds: readonly [] };
  isCustom: boolean;
  model: string;
}

export type VendorConfigResult =
  | { ok: true; config: { vendorName?: string; baseUrl?: string; apiKey: string; model: string } }
  | { ok: false; reason: string; fix?: string; notConfigured?: boolean };

/** 去掉尾斜杠并小写主机名，仅用于比较，不改变写回配置的值。 */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
}

/**
 * 读取随包/仓库内置配置的原始文档（未解析）。
 *
 * 本模块自己只需要其中的厂商清单；写入默认模型时还要用到模型规则，故导出给
 * `personal-vendor.ts` 复用同一套定位逻辑——两处各找一次路径必然分叉。
 */
export function readBuiltinConfigDocument(explicitPath?: string): unknown | undefined {
  return readBuiltinConfigFile(explicitPath);
}

function readBuiltinConfigFile(explicitPath?: string): unknown | undefined {
  const candidates: string[] = [];
  const add = (candidate: string | undefined) => {
    if (candidate && !candidates.includes(candidate)) candidates.push(candidate);
  };

  add(explicitPath?.trim());

  // 运行期（打包/SEA）优先用入口旁边的随包配置，与 provider-runtime-env 的解析保持一致。
  // 注意：开发态（tsx）下 process.argv[1] 指向 tsx 自身，不能依赖它定位仓库，
  // 因此这里只把它当"其中一种可能"，真正兜底的是下面的 cwd 向上找仓库根。
  const entrypoint = process.argv[1] ? resolve(process.argv[1]) : undefined;
  if (entrypoint) {
    const entryDirectory = dirname(realpathSync(entrypoint));
    add(join(entryDirectory, "provider", "zcode-builtin.json"));
  }

  // 从 cwd 向上找仓库根（有 pnpm-workspace.yaml 的目录），覆盖本地开发与 tsx 运行。
  const repoRoot = findRepoRootFrom(process.cwd());
  if (repoRoot) add(join(repoRoot, "config", "provider", "zcode-builtin.json"));

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      return JSON.parse(readFileSync(candidate, "utf8")) as unknown;
    } catch {
      // 损坏的内置配置不能阻断启动；交由调用方报"未定位到内置配置"。
      return undefined;
    }
  }
  return undefined;
}

function findRepoRootFrom(startDir: string): string | undefined {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, "pnpm-workspace.yaml"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

interface RawRule {
  providerId?: string;
  templateId?: string;
  config?: {
    group?: string;
    builtinModelIds?: string[] | null;
    access?: { type?: string; accountType?: string } | null;
    api?: { type?: string; baseUrl?: string } | null;
  };
}

/** 从内置配置构建厂商清单。内置配置不可读时返回空数组，不抛错。 */
export function readBuiltinVendors(explicitPath?: string): BuiltinVendor[] {
  const parsed = readBuiltinConfigFile(explicitPath) as
    | { config?: { providerConfigRules?: { templateRules?: RawRule[]; providerRules?: RawRule[] } } }
    | undefined;
  const rules = parsed?.config?.providerConfigRules;
  if (!rules) return [];

  const vendors: BuiltinVendor[] = [];
  for (const rule of rules.templateRules ?? []) {
    const api = rule.config?.api;
    if (!rule.templateId || !api?.baseUrl || !api.type) continue;
    // 模板一律归为 api-key：它们的 access 是 `api-key` 或 `zhipu-coding-plan-api-key`，
    // 两者都是"用户直接提供一串 key"，落点都是个人 Provider 配置，
    // 区别只在鉴权方式（后者需要 id.secret 形态），不走账号凭据库。
    // 只有 providerRules 里的 `zhipu-account` 型才需要走凭据库——那条在下面单独处理。
    vendors.push({
      id: rule.templateId,
      kind: "api-key",
      baseUrl: api.baseUrl,
      apiType: api.type as BuiltinVendor["apiType"],
      modelIds: rule.config?.builtinModelIds ?? [],
    });
  }
  for (const rule of rules.providerRules ?? []) {
    const api = rule.config?.api;
    if (!rule.providerId || !api?.baseUrl || !api.type) continue;
    if (rule.config?.access?.type !== "zhipu-account") continue;
    vendors.push({
      // 去掉 `account:` 前缀作为用户可写的取值：`account:` 前缀不允许出现在
      // 个人层 providerId 里，也不适合让用户手写；原始值保留在 accountProviderId。
      id: rule.providerId.replace(/^account:/, ""),
      kind: "coding-plan",
      baseUrl: api.baseUrl,
      apiType: api.type as BuiltinVendor["apiType"],
      modelIds: rule.config?.builtinModelIds ?? [],
      accountProviderId: rule.providerId,
      // 直接取配置里的账号族，不从 providerId 反推。
      ...(rule.config?.access?.accountType ? { family: rule.config.access.accountType } : {}),
    });
  }
  return vendors;
}

/**
 * 按厂商名定位内置厂商。名字可以是 templateId（`moonshot-kimi`），
 * 也可以是去掉 `account:` 前缀的 providerId（`bigmodel-individual-coding-plan`）。
 */
export function findVendorByName(name: string, vendors: readonly BuiltinVendor[]): BuiltinVendor | undefined {
  const normalized = name.trim().toLowerCase();
  // 先按完整 id 找，再解析短名——短名只是别名，不覆盖 id 本身。
  const target = VENDOR_ALIASES[normalized] ?? normalized;
  const matches = vendors.filter((vendor) => vendor.id.toLowerCase() === target.toLowerCase());
  // 同名多条属于内置配置问题；要求唯一命中，否则视为未找到。
  return matches.length === 1 ? matches[0] : undefined;
}

/** 按端点定位内置厂商。命中多条时返回全部候选，交由调用方报错。 */
export function findVendorsByBaseUrl(
  baseUrl: string,
  vendors: readonly BuiltinVendor[],
): BuiltinVendor[] {
  const target = normalizeBaseUrl(baseUrl);
  return vendors.filter((vendor) => normalizeBaseUrl(vendor.baseUrl) === target);
}

/**
 * 解析 .env 的厂商四字段。
 *
 * 全部为空 → 返回 ok:false 且 reason 为 `not-configured`，由调用方决定是否静默跳过
 * （未配置厂商是合法状态，不是错误）。
 */
export function parseVendorConfig(env: CliEnv): VendorConfigResult {
  const vendorName = env[VENDOR_ENV_KEYS.vendor]?.trim() || undefined;
  const baseUrl = env[VENDOR_ENV_KEYS.baseUrl]?.trim() || undefined;
  const apiKey = env[VENDOR_ENV_KEYS.apiKey]?.trim() || undefined;
  const model = env[VENDOR_ENV_KEYS.model]?.trim() || undefined;

  if (!vendorName && !baseUrl && !apiKey && !model) {
    return { ok: false, reason: "not-configured", notConfigured: true };
  }

  if (!vendorName && !baseUrl) {
    return {
      ok: false,
      reason: `需要 ${VENDOR_ENV_KEYS.vendor} 或 ${VENDOR_ENV_KEYS.baseUrl} 至少其一`,
      fix: "内置厂商写 VENDOR 即可（端点自动带出）；自建端点写 BASE_URL 并留空 VENDOR",
    };
  }
  if (baseUrl) {
    try {
      new URL(baseUrl);
    } catch {
      return { ok: false, reason: `${VENDOR_ENV_KEYS.baseUrl} 不是合法 URL：${baseUrl}` };
    }
  }
  if (!apiKey) {
    return { ok: false, reason: `${VENDOR_ENV_KEYS.apiKey} 未填写` };
  }
  if (!model) {
    return { ok: false, reason: `${VENDOR_ENV_KEYS.model} 未填写` };
  }

  return { ok: true, config: { vendorName, baseUrl, apiKey, model } };
}

/**
 * 把解析出的配置与内置清单对齐，得到确定性的厂商事实。
 * 自定义厂商（未提供厂商名）放行，不做清单校验——它本就没有内置清单。
 */
/**
 * 判断用户填写的端点是否是某个**账号型**套餐的端点。
 *
 * 这是分流写入的唯一判据：命中 → 走加密凭据库（个人层禁止声明其 access）；
 * 未命中 → 走个人 Provider 配置，key 内联。
 *
 * **必须精确匹配，不能做后缀匹配**：Moonshot / DeepSeek / Minimax / Qwen-cn /
 * Xiaomi 的普通端点同样以 `/anthropic` 结尾，任何"像 anthropic 就当套餐"的
 * 判断都会把它们误写进凭据库链路。
 * 多个账号型套餐共用同一端点时（如 individual 与 team），取该端点上的唯一 family。
 */
export function findCodingPlanByBaseUrl(
  baseUrl: string,
  vendors: readonly BuiltinVendor[],
): BuiltinVendor | undefined {
  const target = normalizeBaseUrl(baseUrl);
  const matches = vendors.filter(
    (vendor) =>
      vendor.kind === "coding-plan" &&
      Boolean(vendor.family) &&
      normalizeBaseUrl(vendor.baseUrl) === target,
  );
  if (matches.length === 0) return undefined;
  // 同端点同 family 视为同一条链路；取第一条即可，family 相同则落点相同。
  return matches[0];
}

/**
 * 在厂商模型清单里定位用户写的模型，返回**清单中的规范写法**。
 *
 * 精确匹配优先；不中时退一步做唯一的大小写不敏感匹配（`GLM-5.3-flash` → `GLM-5.3-Flash`）。
 * 这与同文件 `findVendorByName` 对厂商名的处理一致——厂商名大小写不敏感，模型名没有理由更严。
 * 命中多条（清单里真有只差大小写的两项）视为歧义，返回 undefined 交由调用方报错：不猜。
 */
function matchListedModel(modelIds: readonly string[], model: string): string | undefined {
  if (modelIds.includes(model)) return model;
  const lowered = model.toLowerCase();
  const matches = modelIds.filter((candidate) => candidate.toLowerCase() === lowered);
  return matches.length === 1 ? matches[0] : undefined;
}

export function resolveVendor(
  config: { vendorName?: string; baseUrl?: string; model: string },
  vendors: readonly BuiltinVendor[],
): { ok: true; resolved: ResolvedVendor } | { ok: false; reason: string; fix?: string } {
  // 无厂商名 = 自建端点：BASE_URL 必填（由 parseVendorConfig 保证到达这里时有值）。
  if (!config.vendorName) {
    return {
      ok: true,
      resolved: {
        vendor: {
          id: "custom",
          kind: "api-key",
          baseUrl: config.baseUrl ?? "",
          apiType: undefined,
          modelIds: [],
        },
        isCustom: true,
        model: config.model,
      },
    };
  }

  const vendor = findVendorByName(config.vendorName, vendors);
  if (!vendor) {
    const available = [...vendors.map((candidate) => candidate.id), ...availableAliases(vendors)].sort();
    return {
      ok: false,
      reason: `未识别的厂商名：${config.vendorName}`,
      fix: `可用取值：${available.join(", ")}`,
    };
  }

  // BASE_URL 选填。填了就与厂商端点比对：不一致时报错，不以任意一方为准——
  // 静默取其一属于最难排查的一类问题。未填则直接用厂商端点。
  if (config.baseUrl && normalizeBaseUrl(vendor.baseUrl) !== normalizeBaseUrl(config.baseUrl)) {
    return {
      ok: false,
      reason: `厂商 ${vendor.id} 的端点应为 ${vendor.baseUrl}，但配置的是 ${config.baseUrl}`,
      fix: "两者不一致时不做猜测：请修正 BASE_URL，或去掉 VENDOR 按自定义厂商配置",
    };
  }

  // 有清单但不含该模型 = 用户写错；没有清单 = 自定义场景，放行。
  const listedModel = matchListedModel(vendor.modelIds, config.model);
  if (vendor.modelIds.length > 0 && listedModel === undefined) {
    return {
      ok: false,
      reason: `厂商 ${vendor.id} 不支持模型 ${config.model}`,
      fix: `可用模型：${vendor.modelIds.join(", ")}`,
    };
  }

  // 命中时把**清单里的规范写法**传下去，而不是用户原文：模型名会被写进 Provider 配置
  // 与默认模型选择，规范化后落盘、doctor 显示与请求用的是同一个串。
  return { ok: true, resolved: { vendor, isCustom: false, model: listedModel ?? config.model } };
}
