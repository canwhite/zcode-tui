import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters";
import type { EnvRecord } from "@zcode/adapters/model";
import {
  NodeModelSelectionConfigRepository,
  NodePersonalProviderConfigRepository,
  PERSONAL_PROVIDER_CONFIG_FILE_NAME,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { readLegacyCliPersonalProviderConfig } from "./app/legacy-cli-personal-provider-config-importer.js";
import { dirname, join } from "node:path";
import {
  createStandaloneAccountIdentityFromSecret,
  resolveStandaloneCodingPlanProvider,
  standaloneAccountIdentityCredentialKey,
  standaloneAccountProviderCredentialKey,
  type StandaloneCodingPlanProvider,
} from "./app/standalone-account-provider-runtime.js";

/**
 * Coding Plan 的**非登录**配置写入。
 *
 * 本模块刻意不含任何浏览器授权、OAuth、令牌轮询或登出逻辑：套餐 key 由用户在套餐
 * 控制台自行取得，经 `zcode configure --api-key` 直接写入凭据库，全程无需账号登录。
 *
 * 工具的「登录 / 鉴权 / 登出」已整体移除，见
 * `docs/plan-remove-login-zai-coupling.md`；本文件是唯一被保留的套餐配置路径。
 */

export type CodingPlanProviderId = "bigmodel" | "zai";

export interface ConfigureCodingPlanApiKeyOptions {
  apiKey: string;
  credentialStore?: SharedZCodeCredentialStore;
  env?: EnvRecord;
  personalProviderConfigPath?: string;
  providerId: CodingPlanProviderId;
  /**
   * 用户声明的模型（`.env` 的 `QCODE_VENDOR_MODEL`）。缺省时退回套餐清单首个模型。
   *
   * 契约见 `docs/plan-vendor-config-contract.md`：「显式字段优先于模板值，模板只补空缺」。
   * 不传等于放弃这个优先级——`make install` 写的默认模型就会与 `.env` 声明不一致。
   */
  modelId?: string;
}

export interface ConfigureCodingPlanApiKeyResult {
  configPath: string;
  model: string;
  providerId: CodingPlanProviderId;
}

export class ZCodeCliProviderConfigError extends Error {
  readonly code: "config_update_failed";

  constructor(
    code: ZCodeCliProviderConfigError["code"],
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ZCodeCliProviderConfigError";
    this.code = code;
  }
}

export async function configureCodingPlanApiKey(
  options: ConfigureCodingPlanApiKeyOptions,
): Promise<ConfigureCodingPlanApiKeyResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ZCodeCliProviderConfigError("config_update_failed", "API key must not be empty.");
  }
  const credentialStore =
    options.credentialStore ?? createSharedZCodeCredentialStore({ env: options.env });
  const configPatch = await persistStandaloneCodingPlanConnection({
    accountIdentity: createStandaloneAccountIdentityFromSecret(apiKey),
    apiKey,
    credentialStore,
    env: options.env ?? process.env,
    personalProviderConfigPath: options.personalProviderConfigPath,
    providerId: options.providerId,
    ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
  });
  return {
    configPath: configPatch.path,
    model: configPatch.mainModel,
    providerId: options.providerId,
  };
}

interface StandaloneCodingPlanPersistenceResult {
  readonly mainModel: string;
  readonly path: string;
}

/**
 * 用户声明的模型优先于模板默认值。
 *
 * 越界必须报错而不是回落到模板值：静默换模型正是"我明明写了却没生效"那一类问题，
 * 而这里写下去的是**默认模型**，写错会在用户毫无察觉的情况下改变每次请求。
 */
function resolveCodingPlanModelId(
  provider: StandaloneCodingPlanProvider,
  requested: string | undefined,
): string {
  const wanted = requested?.trim();
  if (!wanted) return provider.modelId;
  if (!provider.modelIds.includes(wanted)) {
    throw new ZCodeCliProviderConfigError(
      "config_update_failed",
      `套餐 ${provider.providerId} 不支持模型 ${wanted}；可用模型：${provider.modelIds.join(", ")}`,
    );
  }
  return wanted;
}

/**
 * 取出该模型实际支持的最高思考档位。
 *
 * **不能用常量**（历史实现写的是 `"enabled"`）：档位取值由内置模型规则按模型匹配决定，
 * 并不是所有模型都是 `["disabled","enabled"]` —— GLM-5.3 / GLM-5.3-Flash 是
 * `["low","high","max"]`，写 `"enabled"` 会被判 `reasoning-level-not-supported`。
 * 取最高档与运行期的 `completeNewModelSelection`（`.values.at(-1)`）保持一致。
 */
function resolveCodingPlanReasoningLevel(
  provider: StandaloneCodingPlanProvider,
  modelId: string,
): string {
  const modelConfig = provider.modelRules.resolve({
    providerId: provider.providerId,
    modelId,
    apiType: provider.apiType,
    baseUrl: provider.baseUrl,
  });
  const reasoningLevel = modelConfig.optionSpecs?.reasoningLevel?.values?.at(-1);
  if (!reasoningLevel) {
    // 没有档位的模型无法构成一个合法选择：运行期 `validateModelSelectionOptions`
    // 对缺档位无条件判 `reasoning-level-missing`。此时宁可不写，也不能写一个不可选的默认值。
    throw new ZCodeCliProviderConfigError(
      "config_update_failed",
      `模型 ${provider.providerId}/${modelId} 没有可用的思考档位，无法作为默认模型`,
    );
  }
  return reasoningLevel;
}

async function persistStandaloneCodingPlanConnection(input: {
  readonly accountIdentity: string;
  readonly apiKey: string;
  readonly credentialStore: SharedZCodeCredentialStore;
  readonly env: EnvRecord;
  readonly personalProviderConfigPath?: string;
  readonly providerId: CodingPlanProviderId;
  readonly modelId?: string;
}): Promise<StandaloneCodingPlanPersistenceResult> {
  const configuredProvider = await resolveStandaloneCodingPlanProvider(input.providerId, input.env);
  const providerId = configuredProvider.providerId;
  const modelId = resolveCodingPlanModelId(configuredProvider, input.modelId);
  const reasoningLevel = resolveCodingPlanReasoningLevel(configuredProvider, modelId);
  const credentialKey = standaloneAccountProviderCredentialKey({
    providerId,
    accountIdentity: input.accountIdentity,
  });
  await input.credentialStore.saveMany({
    [standaloneAccountIdentityCredentialKey(providerId)]: input.accountIdentity,
    [credentialKey]: input.apiKey,
  });
  const path =
    input.personalProviderConfigPath ??
    input.env[ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim() ??
    join(dirname(input.credentialStore.filePath), PERSONAL_PROVIDER_CONFIG_FILE_NAME);
  // 配置写入与运行时共享文件和事务；首次写入仍先保留旧用户 Provider，不能仅写默认值。
  const personalRepository = new NodePersonalProviderConfigRepository({
    filePath: path,
    importLegacy: () => readLegacyCliPersonalProviderConfig({}),
    pollingIntervalMs: false,
  });
  const repository = new NodeModelSelectionConfigRepository({ personalRepository });
  try {
    // 必须带 options.reasoningLevel：运行期 `validateModelSelectionOptions` 对缺档位的
    // selection 无条件判 `reasoning-level-missing`，而 `resolveInitialModelSelection` 遇到
    // 不可选的默认值**不报错**，直接回退到 Registry 顺序里的第一个模型。
    // 少写这一个字段，等于写了一个永远不会生效的默认模型。
    await repository.saveConfiguredDefault({ providerId, modelId, options: { reasoningLevel } });
  } finally {
    repository.dispose();
    personalRepository.dispose();
  }
  return {
    mainModel: `${providerId}/${modelId}`,
    path,
  };
}
