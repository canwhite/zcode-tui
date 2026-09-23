export const QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV = "QCODE_BUILTIN_PROVIDER_CONFIG_FILE";
export const QCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE_ENV =
  "QCODE_BUILTIN_PROVIDER_BUNDLED_CONFIG_FILE";
export const QCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV = "QCODE_PERSONAL_PROVIDER_CONFIG_FILE";
export const PERSONAL_PROVIDER_CONFIG_FILE_NAME = "provider_config.json";

export interface NodeProviderRuntimePaths {
  readonly qcodeBuiltinFilePath: string;
  readonly personalFilePath: string;
}

export function createNodeProviderRuntimePathEnv(
  paths: NodeProviderRuntimePaths,
): Record<string, string> {
  return {
    [QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: paths.qcodeBuiltinFilePath,
    [QCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: paths.personalFilePath,
  };
}

export function resolveNodeProviderRuntimePaths(
  env: Readonly<Record<string, string | undefined>>,
): NodeProviderRuntimePaths | null {
  const qcodeBuiltinFilePath = env[QCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]?.trim();
  const personalFilePath = env[QCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]?.trim();
  if (!qcodeBuiltinFilePath && !personalFilePath) return null;
  if (!qcodeBuiltinFilePath || !personalFilePath) {
    throw new Error("ZCode Built-in 与 Personal Provider Config 路径必须同时提供");
  }
  return Object.freeze({ qcodeBuiltinFilePath, personalFilePath });
}
