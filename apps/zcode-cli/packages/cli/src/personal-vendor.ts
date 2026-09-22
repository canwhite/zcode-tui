import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  decodeProviderConfigFile,
  encodeProviderConfigFile,
} from "@zcode/provider-node";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import type { CliEnv } from "./env.js";

/**
 * 把非套餐厂商写进个人 Provider 配置。
 *
 * 为什么自己读写而不经 ProviderConfigRuntime：这里是**只增改一条记录**的最小写入，
 * 走完整 runtime 会连带拉起内置配置的远端同步与监听，对一个安装期命令过重。
 * 格式与校验仍复用同一个 codec（decode / encode），不另写一份文件格式。
 */

export interface WritePersonalVendorInput {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 来自内置模板的协议；自定义端点无模板时为 undefined，默认用 anthropic-messages。 */
  apiType?: string;
  env: CliEnv;
}

export interface WritePersonalVendorResult {
  providerId: string;
  configPath: string;
  /** true 表示更新了已有条目，false 表示新建。用于验证幂等。 */
  updated: boolean;
}

export function resolvePersonalConfigPath(env: CliEnv): string {
  const explicit = env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (explicit) return explicit;
  const dataBaseDir = env.ZCODE_DATA_BASE_DIR?.trim() || homedir();
  return join(dataBaseDir, ".zcode", "v2", PERSONAL_PROVIDER_CONFIG_FILE_NAME);
}

/**
 * 由端点派生稳定的 providerId。
 *
 * 必须稳定：同一家厂商重复执行要命中同一条，否则每跑一次安装就多一条重复厂商。
 * 用主机名而非整个 URL——路径变化（如换协议）不应产生新厂商。
 */
export function providerIdFromBaseUrl(baseUrl: string): string {
  let host = baseUrl;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // 非法 URL 已在上游被拒；这里退化为对原文做稳定哈希，保证仍有确定性 id。
  }
  const slug = host.replace(/[^a-z0-9.-]/g, "-").replace(/^-+|-+$/g, "");
  if (slug) return `personal:${slug}`;
  return `personal:${createHash("sha256").update(baseUrl).digest("hex").slice(0, 12)}`;
}

const DEFAULT_API_TYPE = "anthropic-messages";

/**
 * 写入或更新一条个人厂商记录。
 *
 * 幂等：按 providerId 命中已有条目则**覆盖**，命中不到才新建。
 * 绝不无条件追加——那会让重复执行产生重复厂商。
 */
export async function writePersonalVendor(
  input: WritePersonalVendorInput,
): Promise<WritePersonalVendorResult> {
  const configPath = resolvePersonalConfigPath(input.env);
  const providerId = providerIdFromBaseUrl(input.baseUrl);

  const raw = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as unknown)
    : { schemaVersion: 1, config: { providerConfigRules: { providerRules: [] } } };

  // 复用同一个 codec 解码，保证我们看到的与运行期看到的结构一致。
  const current = decodeProviderConfigFile(raw);
  const currentRules = current.providers.toJSON() as unknown as Array<Record<string, unknown>> | [];
  const rules = Array.isArray(currentRules) ? currentRules : [];
  const existing = rules.find((rule) => rule.providerId === providerId);

  // 模型清单取并集而非覆盖：用户先配了 A 模型、后配 B，A 不应被抹掉。
  const existingModels =
    ((existing?.config as Record<string, unknown> | undefined)?.personalModelIds as
      | string[]
      | undefined) ?? [];
  const personalModelIds = Array.from(new Set([...existingModels, input.model]));

  const nextRule = {
    providerId,
    providerName: existing?.providerName ?? providerId.replace(/^personal:/, ""),
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey: input.apiKey },
      api: { type: input.apiType ?? DEFAULT_API_TYPE, baseUrl: input.baseUrl },
      // 个人层承载模型清单的字段是 personalModelIds——builtinModelIds 会被 schema 拒绝。
      personalModelIds,
      modelOrder: personalModelIds,
    },
  };

  const nextRules = existing
    ? rules.map((rule) => (rule.providerId === providerId ? { ...rule, ...nextRule } : rule))
    : [...rules, nextRule];

  const snapshot = encodeProviderConfigFile({
    providers: current.providers,
    models: current.models,
    providerOrder: current.providerOrder,
    // 必须改写生效指针指向刚写入的厂商：只写记录不改指针，用户会以为换成了新厂商，
    // 实际仍跑在旧厂商上，且整个过程不报错——这是本功能最难发现的一类失败。
    defaultModelSelection: { providerId, modelId: input.model },
  });
  const nextFile = {
    ...snapshot,
    config: {
      ...snapshot.config,
      providerConfigRules: { providerRules: nextRules },
    },
  };

  // 写前先让 codec 解析一遍：格式不对就在这里失败，不落盘半成品。
  decodeProviderConfigFile(nextFile);

  // 明文 key 落盘：与共享凭据库一致地收紧到仅属主可读。
  await atomicWritePrivateTextFile(configPath, JSON.stringify(nextFile, null, 2));

  return { providerId, configPath, updated: Boolean(existing) };
}
