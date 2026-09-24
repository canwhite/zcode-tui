import { createHash } from "node:crypto";
import type { SharedZCodeCredentialStore } from "@zcode/adapters/auth";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import {
  createAccountProviderConfigSnapshot,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
} from "@zcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import type { ProviderFamilyDomain } from "@zcode/shared";

export interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  /** 模板默认模型：`builtinModelIds` 里首个非空项。用户未声明 MODEL 时用它。 */
  readonly modelId: string;
  /** 该套餐声明的完整模型清单；用于校验用户显式声明的 MODEL，不能只看首个。 */
  readonly modelIds: readonly string[];
  readonly providerId: string;
  /**
   * 解析某个模型的实际配置（如思考档位）所需的两样东西：内置模型规则 + 该 provider 的
   * 解析身份。**不要**在调用方另写一份档位判断——档位取值来自 modelRules 的匹配结果，
   * 不同模型并不相同（如 GLM-5.3 系是 `["low","high","max"]`，通用规则是
   * `["disabled","enabled"]`），写死任何常量都会写出一个不可选的默认模型。
   */
  readonly modelRules: ModelConfigRules;
  readonly apiType: string;
  readonly baseUrl: string;
}

export async function readStandaloneCodingPlanProviders(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return (await readStandaloneCodingPlanCatalog(env)).providers;
}

async function readStandaloneCodingPlanCatalog(
  env: Readonly<Record<string, string | undefined>>,
  // `models` 可选：运行期只按 provider 清单构建账号状态，不需要模型规则；
  // 需要在写入默认模型前解析档位的调用方（`configure`）必须传入。
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers"> &
    Partial<Pick<ProviderConfigLayerSnapshot, "models">>,
): Promise<{
  readonly zcodeBuiltinRevision: string;
  readonly providers: readonly StandaloneCodingPlanProvider[];
}> {
  if (config)
    return {
      zcodeBuiltinRevision: config.revision,
      providers: config.providers.entries().flatMap(([providerId, provider]) => {
        const access = provider.access;
        const modelIds = (provider.builtinModelIds ?? [])
          .map((candidate) => candidate.trim())
          .filter((candidate) => candidate.length > 0);
        const api = provider.api;
        return access?.type === "zhipu-account" &&
          access.mode === "individual-coding-plan" &&
          access.accountType &&
          api?.type &&
          modelIds.length > 0
          ? [
              {
                family: access.accountType,
                modelId: modelIds[0]!,
                modelIds,
                providerId,
                // 套餐型 provider 在内置配置里不声明 templateId，故模板规则不参与解析。
                modelRules: config.models ?? ModelConfigRules.empty(),
                apiType: api.type,
                baseUrl: api.baseUrl ?? "",
              },
            ]
          : [];
      }),
    };
  const filePath = env[ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(`${ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required to resolve the built-in provider config`);
  }
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath: filePath,
    watch: false,
  });
  try {
    const snapshot = await source.read();
    return readStandaloneCodingPlanCatalog(env, snapshot);
  } finally {
    source.dispose();
  }
}

export async function resolveStandaloneCodingPlanProvider(
  family: ProviderFamilyDomain,
  env: Readonly<Record<string, string | undefined>>,
): Promise<StandaloneCodingPlanProvider> {
  const matches = (await readStandaloneCodingPlanProviders(env)).filter(
    (provider) => provider.family === family,
  );
  if (matches.length !== 1) {
    throw new Error(
      `ZCode Built-in Config 必须为 ${family} 声明唯一 Individual Coding Plan Provider`,
    );
  }
  return matches[0]!;
}

export function standaloneAccountIdentityCredentialKey(providerId: string): string {
  const normalized = providerId.trim();
  if (!normalized) throw new Error("Standalone Account Provider ID 不能为空");
  return `account-provider:${normalized}:identity`;
}

/** Standalone Credential Store 私有键；不得进入 Provider Config、Model 或 Protocol。 */
export function standaloneAccountProviderCredentialKey(input: {
  readonly providerId: string;
  readonly accountIdentity: string;
}): string {
  const providerId = input.providerId.trim();
  const accountIdentity = input.accountIdentity.trim();
  if (!providerId) throw new Error("Standalone Account Provider ID 不能为空");
  if (!accountIdentity) throw new Error("Standalone Account Identity 不能为空");
  return `account-provider:coding-plan:${providerId}:account:${encodeURIComponent(accountIdentity)}:api-key`;
}

/** 没有账号 Profile 的手工 Key 登录使用稳定、不可逆的连接身份。 */
export function createStandaloneAccountIdentityFromSecret(secret: string): string {
  const normalized = secret.trim();
  if (!normalized) throw new Error("Standalone Account Secret 不能为空");
  return `key-${createHash("sha256").update(normalized).digest("hex").slice(0, 24)}`;
}

export async function readStandaloneAccountProviderConfigSnapshot(
  credentialStore: Pick<SharedZCodeCredentialStore, "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<AccountProviderConfigSnapshot> {
  const catalog = await readStandaloneCodingPlanCatalog(env, config);
  const configuredProviders = catalog.providers;
  const identityKeys = configuredProviders.map(({ providerId }) =>
    standaloneAccountIdentityCredentialKey(providerId),
  );
  const identities = await credentialStore.loadMany(identityKeys);
  const candidates = configuredProviders.flatMap(({ family, providerId }) => {
    const accountIdentity = identities[standaloneAccountIdentityCredentialKey(providerId)]?.trim();
    if (!accountIdentity) return [];
    const credentialKey = standaloneAccountProviderCredentialKey({
      providerId,
      accountIdentity,
    });
    return [{ accountIdentity, credentialKey, family, providerId }] as const;
  });
  const apiKeyByCredentialKey = await credentialStore.loadMany(
    candidates.map(({ credentialKey }) => credentialKey),
  );
  const candidateByProviderId = new Map(
    candidates.map((candidate) => [candidate.providerId, candidate]),
  );
  const providers = new ProviderConfigMap(
    configuredProviders.map(({ family, providerId }) => {
      const candidate = candidateByProviderId.get(providerId);
      const apiKey = candidate ? apiKeyByCredentialKey[candidate.credentialKey]?.trim() : undefined;
      if (!candidate || !apiKey) {
        // 账号 Overlay 缺少成员表示“不覆盖”，不能表达账号已断开；必须显式
        // entitled=false，才能让 Built-in 账号 Provider 在凭据删除后从 Registry 退出。
        return [
          providerId,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({ entitled: false }),
          }),
        ] as const;
      }
      return [
        providerId,
        new ProviderConfig({
          access: new ZhipuAccountAccessConfig({ entitled: true }),
        }),
      ] as const;
    }),
  );
  return createAccountProviderConfigSnapshot(catalog.zcodeBuiltinRevision, providers);
}


export function createStandaloneProviderRuntimeHeadersPort(
  credentialStore: Pick<SharedZCodeCredentialStore, "load" | "loadMany">,
  env: Readonly<Record<string, string | undefined>>,
): ProviderRuntimeHeadersPort {
  return {
    shouldRefreshBeforeModelRequest() {
      return true;
    },
    async refreshBeforeModelRequest(input) {
      input.abortSignal?.throwIfAborted();
      const providerId = input.providerId.trim();
      const access = input.accountAccess;
      if (!access || access.mode !== "individual-coding-plan") {
        throw new Error(
          `Provider ${providerId} 的套餐模式暂不支持（仅支持 individual-coding-plan）。` +
            "请改用普通 API Key：在 .env 中设置 ZCODE_VENDOR / ZCODE_VENDOR_API_KEY / " +
            "ZCODE_VENDOR_MODEL / ZCODE_VENDOR_BASE_URL，或运行 " +
            "`zcode configure --provider <厂商> --api-key <key> --configure-model <模型>`。",
        );
      }
      const currentIdentity = (
        await credentialStore.load(standaloneAccountIdentityCredentialKey(providerId))
      )?.trim();
      if (!currentIdentity)
        throw new Error(
          `Provider ${providerId} 在凭据库中没有账号身份。` +
            "请运行 `zcode configure --provider <厂商> --api-key <套餐 key> --configure-model <模型>` 写入凭据；" +
            "或在 .env 中设置 ZCODE_VENDOR_* 四字段，改用普通 API Key。",
        );
      const apiKey = (
        await credentialStore.load(
          standaloneAccountProviderCredentialKey({
            providerId,
            accountIdentity: currentIdentity,
          }),
        )
      )?.trim();
      if (!apiKey) {
        throw new Error(
          `Provider ${providerId} 缺少请求凭据。` +
            "请运行 `zcode configure --provider <厂商> --api-key <套餐 key> --configure-model <模型>` 写入 API Key；" +
            "或在 .env 中设置 ZCODE_VENDOR_* 四字段。",
        );
      }
      return {
        headersApplied: true,
        requestAuth: { apiKey },
      };
    },
  };
}
