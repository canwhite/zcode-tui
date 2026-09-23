import type {
  AiSdkModelExecutionConfig,
  AiSdkNetworkConfig,
  EnvRecord,
} from "@zcode/adapters/model";
import {
  resolveRuntimeZCodeEnv,
  resolveRuntimeZCodeEndpointOrigin,
  ZCODE_APP_VERSION_ENV,
} from "@zcode/shared";
import {
  createRuntimePlatformHeaders,
  normalizePrintableHeaderValue,
} from "./runtime-platform-headers.js";

export type ModelProviderSourceTitle = "cli" | "electron";

interface RuntimeExecutionConfigOptions {
  appVersion?: string;
  network?: AiSdkNetworkConfig;
  sourceTitle?: ModelProviderSourceTitle;
}

export function createRuntimeAiSdkModelExecutionConfig(
  env: EnvRecord = process.env,
  options: RuntimeExecutionConfigOptions = {},
): AiSdkModelExecutionConfig {
  const network = normalizeAiSdkNetworkConfig(options.network);
  return {
    defaultHeaders: buildCliZCodeSourceHeaders(env, options),
    env,
    ...(network ? { network } : {}),
  };
}

function normalizeAiSdkNetworkConfig(
  network: AiSdkNetworkConfig | undefined,
): AiSdkNetworkConfig | undefined {
  if (!network?.caCertFile && !network?.httpProxy && !network?.noProxy) return undefined;
  return {
    ...(network.caCertFile ? { caCertFile: network.caCertFile } : {}),
    ...(network.httpProxy ? { httpProxy: network.httpProxy } : {}),
    ...(network.noProxy ? { noProxy: network.noProxy } : {}),
  };
}

function buildCliZCodeSourceHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion" | "sourceTitle"> = {},
): Record<string, string> {
  const sourceTitle = options.sourceTitle ?? detectDefaultProviderSourceTitle();
  const appVersion = resolveAppVersionForHeaders(env, options);
  const locale = normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().locale);
  const timezone = normalizePrintableHeaderValue(Intl.DateTimeFormat().resolvedOptions().timeZone);
  // HTTP-Referer 原先经 resolveRuntimeZCodeEndpointOrigin 缺省回落到
  // DEFAULT_ZCODE_ENDPOINT_ORIGIN（https://zcode.z.ai），等于**每个模型请求都隐式声明
  // 该来源**——这正是不希望存在的隐式回连。现改为只在用户显式配置了端点
  // （ZCODE_BASE_URL / ZCODE_ENDPOINT_ORIGIN）时才发送该头。
  const refererOrigin = resolveConfiguredEndpointOrigin(env);
  return {
    ...(refererOrigin ? { "HTTP-Referer": refererOrigin } : {}),
    "User-Agent": `ZCode/${appVersion ?? "unknown"}`,
    ...(appVersion ? { "X-ZCode-App-Version": appVersion } : {}),
    "X-Title": `Z Code@${sourceTitle}`,
    "X-Release-Channel": resolveRuntimeZCodeEnv(env),
    "X-Client-Language": locale ?? "unknown",
    "X-Client-Timezone": timezone ?? "unknown",
    "X-ZCode-Agent": "glm",
    ...createRuntimePlatformHeaders(),
  };
}

/**
 * 只在用户**显式配置**端点时返回其 origin；未配置则返回 `undefined`（不发送
 * `HTTP-Referer`）。用于避免隐式回落到内置默认端点。
 */
function resolveConfiguredEndpointOrigin(env: EnvRecord): string | undefined {
  const explicit = env.ZCODE_BASE_URL?.trim() || env.ZCODE_ENDPOINT_ORIGIN?.trim();
  if (!explicit) return undefined;
  try {
    return resolveRuntimeZCodeEndpointOrigin(env);
  } catch {
    // 端点非法时已由厂商配置层报错；这里静默不发该头，不额外制造失败。
    return undefined;
  }
}

function resolveAppVersionForHeaders(
  env: EnvRecord,
  options: Pick<RuntimeExecutionConfigOptions, "appVersion">,
): string | undefined {
  return normalizePrintableHeaderValue(env[ZCODE_APP_VERSION_ENV] ?? options.appVersion);
}

function detectDefaultProviderSourceTitle(): ModelProviderSourceTitle {
  return process.argv.includes("app-server") || process.argv.includes("agent-server")
    ? "electron"
    : "cli";
}
