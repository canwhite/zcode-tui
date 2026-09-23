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
import {
  ApiKeyAccessConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderApiType,
} from "@zcode/provider";
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
 * 默认档位。取值依据：内置 modelConfigRules 对通用模型的
 * `optionSpecs.reasoningLevel.values` 为 `["disabled", "enabled"]`，
 * 而 `completeNewModelSelection` 取 `.at(-1)` 作为最高档 —— 即 `enabled`。
 * 选用完全相同的取值，保证与运行期的补全结果一致。
 */
const DEFAULT_REASONING_LEVEL = "enabled";

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

  // 文件不存在时用 codec 亲手生成一份空文档，而不是手写 JSON 常量——
  // modelConfigRules 必须同时含 providerModelRules 与 manualProviderModelRules 两个数组，
  // 少一个就会让整份文件解码失败。
  const raw = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, "utf8")) as unknown)
    : encodeProviderConfigFile({
        providers: ProviderConfigMap.empty(),
        models: ModelConfigRules.empty(),
        providerOrder: [],
      } as Parameters<typeof encodeProviderConfigFile>[0]);

  // 复用同一个 codec 解码，保证我们看到的与运行期看到的结构一致。
  const current = decodeProviderConfigFile(raw);
  const existing = current.providers.getRule(providerId);

  // 模型清单取并集而非覆盖：用户先配了 A 模型、后配 B，A 不应被抹掉。
  const existingModels = (existing?.config.personalModelIds ?? []) as readonly string[];
  const personalModelIds = Array.from(new Set([...existingModels, input.model]));

  const personalConfig = new ProviderConfig({
    group: "standard-personal",
    access: new ApiKeyAccessConfig({ type: "api-key", apiKey: input.apiKey }),
    api: new ProviderApiConfig({
      type: (input.apiType ?? DEFAULT_API_TYPE) as ProviderApiType,
      baseUrl: input.baseUrl,
    }),
    // 个人层承载模型清单的字段是 personalModelIds——builtinModelIds 会被 schema 拒绝。
    personalModelIds,
    modelOrder: personalModelIds,
  });

  const providers = current.providers.setRule({
    providerId,
    providerName: existing?.providerName ?? providerId.replace(/^personal:/, ""),
    config: personalConfig,
  });

  // 必须交给 codec 编码，而不是手拼 JSON：它负责把领域对象规范化为磁盘格式。
  // 手工拼装会绕过这层规范化，产出解码不了的文档——repository 遇到解码失败会
  // **静默降级为空配置**，表现为"写入成功但运行期完全看不到这个厂商"。
  const nextFile = encodeProviderConfigFile({
    providers,
    models: current.models,
    providerOrder: [...(current.providerOrder ?? []), ...(current.providerOrder?.includes(providerId) ? [] : [providerId])],
    // 必须改写生效指针指向刚写入的厂商：只写记录不改指针，用户会以为换成了新厂商，
    // 实际仍跑在旧厂商上，且整个过程不报错。
    //
    // 且**必须带 options.reasoningLevel**：`validateModelSelectionOptions` 对缺失档位的
    // selection 直接判 `reasoning-level-missing` 不可选，而启动时的
    // `isSelectable` 正是走这条校验。写一条没有档位的 selection，等于写了一条
    // 永远"不可选"的默认值——运行期会静默回退到别的厂商。
    // 这里与运行期的 `completeNewModelSelection` 保持一致：取该模型支持档位的最高档。
    defaultModelSelection: {
      providerId,
      modelId: input.model,
      options: { reasoningLevel: DEFAULT_REASONING_LEVEL },
    },
  } as Parameters<typeof encodeProviderConfigFile>[0]);

  // 写前先让 codec 解析一遍：格式不对就在这里失败，不落盘半成品。
  decodeProviderConfigFile(nextFile);

  // 明文 key 落盘：与共享凭据库一致地收紧到仅属主可读。
  await atomicWritePrivateTextFile(configPath, JSON.stringify(nextFile, null, 2));

  return { providerId, configPath, updated: Boolean(existing) };
}
