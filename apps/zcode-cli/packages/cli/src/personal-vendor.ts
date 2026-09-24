import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
  decodeProviderConfigFile,
  decodeZCodeBuiltinRelease,
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
import { DATA_BASE_DIR_ENV_KEYS, readRenamedEnv } from "@zcode/shared";
import { atomicWritePrivateTextFile } from "@zcode/shared/node";
import type { CliEnv } from "./env.js";
import { readBuiltinConfigDocument } from "./vendor.js";

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
  // 与凭据库、遥测状态同一套读取规则（新名优先、旧名兜底），否则只设一个键时
  // 这几种数据会落到不同的根目录。
  const dataBaseDir = readRenamedEnv(env, DATA_BASE_DIR_ENV_KEYS) ?? homedir();
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
 * 取该模型实际支持的最高思考档位；解析不出来时返回 undefined。
 *
 * 取值必须与运行期同源：内置模型规则 ++ 个人精确规则（`composeEffective`），再按身份解析，
 * 最后取 `.at(-1)` —— 也就是 `completeNewModelSelection` 的口径。
 *
 * **不能写常量**。历史实现写死 `"enabled"`，依据是"通用模型档位是 `["disabled","enabled"]`"；
 * 但档位是**按模型**匹配的，GLM-5.3 系的规则给出的是 `["low","high","max"]`，于是写下去的
 * `"enabled"` 被判 `reasoning-level-not-supported`，该默认模型在运行期被静默丢弃、回退到
 * Registry 顺序 —— 用户看到的就是"配了却没生效"。
 */
function resolvePersonalReasoningLevel(input: {
  providerId: string;
  modelId: string;
  apiType: string;
  baseUrl: string;
  personalModels: ModelConfigRules;
}): string | undefined {
  try {
    const document = readBuiltinConfigDocument();
    if (document === undefined) return undefined;
    const rules = ModelConfigRules.composeEffective(
      decodeZCodeBuiltinRelease(document).config.modelConfigRules,
      input.personalModels,
    );
    return rules
      .resolve({
        providerId: input.providerId,
        modelId: input.modelId,
        apiType: input.apiType,
        baseUrl: input.baseUrl,
      })
      .optionSpecs?.reasoningLevel?.values?.at(-1);
  } catch {
    // 内置配置不可读或格式不符时退化为"不写档位"：安装链路不能因此失败。
    // 宁可不写（运行期自行回退），也不能写一个该模型不支持的档位。
    return undefined;
  }
}

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
  const reasoningLevel = resolvePersonalReasoningLevel({
    providerId,
    modelId: input.model,
    apiType: (input.apiType ?? DEFAULT_API_TYPE) as ProviderApiType,
    baseUrl: input.baseUrl,
    personalModels: current.models,
  });

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
    // 档位取自该模型的实际规则（见 `resolvePersonalReasoningLevel`）；解析不出来时不写，
    // 而不是填一个可能不被支持的档位。
    defaultModelSelection: {
      providerId,
      modelId: input.model,
      ...(reasoningLevel ? { options: { reasoningLevel } } : {}),
    },
  } as Parameters<typeof encodeProviderConfigFile>[0]);

  // 写前先让 codec 解析一遍：格式不对就在这里失败，不落盘半成品。
  decodeProviderConfigFile(nextFile);

  // 明文 key 落盘：与共享凭据库一致地收紧到仅属主可读。
  await atomicWritePrivateTextFile(configPath, JSON.stringify(nextFile, null, 2));

  return { providerId, configPath, updated: Boolean(existing) };
}
