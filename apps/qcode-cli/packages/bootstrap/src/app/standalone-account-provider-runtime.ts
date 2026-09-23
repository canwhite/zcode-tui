import { createHash } from "node:crypto";
import type { SharedZCodeCredentialStore } from "@qcode/adapters/auth";
import type { ProviderRuntimeHeadersPort } from "@qcode/core";
import {
  createAccountProviderConfigSnapshot,
  ProviderConfig,
  ProviderConfigMap,
  ZhipuAccountAccessConfig,
  type AccountProviderConfigSnapshot,
  type ProviderConfigLayerSnapshot,
} from "@qcode/provider";
import {
  NodeZCodeBuiltinProviderConfigSource,
  QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
} from "@qcode/provider-node";
import type { ProviderFamilyDomain } from "@qcode/shared";

interface StandaloneCodingPlanProvider {
  readonly family: ProviderFamilyDomain;
  readonly modelId: string;
  readonly providerId: string;
}

export async function readStandaloneCodingPlanProviders(
  env: Readonly<Record<string, string | undefined>>,
): Promise<readonly StandaloneCodingPlanProvider[]> {
  return (await readStandaloneCodingPlanCatalog(env)).providers;
}

async function readStandaloneCodingPlanCatalog(
  env: Readonly<Record<string, string | undefined>>,
  config?: Pick<ProviderConfigLayerSnapshot, "revision" | "providers">,
): Promise<{
  readonly zcodeBuiltinRevision: string;
  readonly providers: readonly StandaloneCodingPlanProvider[];
}> {
  if (config)
    return {
      zcodeBuiltinRevision: config.revision,
      providers: config.providers.entries().flatMap(([providerId, provider]) => {
        const access = provider.access;
        const modelId = provider.builtinModelIds?.find((candidate) => candidate.trim())?.trim();
        return access?.type === "zhipu-account" &&
          access.mode === "individual-coding-plan" &&
          access.accountType &&
          modelId
          ? [{ family: access.accountType, modelId, providerId }]
          : [];
      }),
    };
  const filePath = env[QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!filePath) {
    throw new Error(`${QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV} is required to resolve the built-in provider config`);
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
            "请改用普通 API Key：在 .env 中设置 QCODE_VENDOR / QCODE_VENDOR_API_KEY / " +
            "QCODE_VENDOR_MODEL / QCODE_VENDOR_BASE_URL，或运行 " +
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
            "或在 .env 中设置 QCODE_VENDOR_* 四字段，改用普通 API Key。",
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
            "或在 .env 中设置 QCODE_VENDOR_* 四字段。",
        );
      }
      return {
        headersApplied: true,
        requestAuth: { apiKey },
      };
    },
  };
}
