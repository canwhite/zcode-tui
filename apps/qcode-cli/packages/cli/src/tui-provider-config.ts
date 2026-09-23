import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";
import type { CommandCenterApiKeyOptions } from "./command-center/types.js";

/**
 * 非登录的厂商配置写入：把用户提供的 API Key 交给 `configureCodingPlanApiKey` 落盘。
 *
 * 这是**不依赖账号**的配置路径，与已移除的登录/登出无关，因此保留。
 * 其 TUI 入口原先挂在 `/login *-api-key` 上，随该命令一并移除；
 * 当前由 CLI 子命令 `zcode configure --api-key` 使用（见计划 F-005）。
 */
export async function configureApiKeyForTui(
  deps: RunDependencies,
  options: CommandCenterApiKeyOptions,
) {
  const configure =
    deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
  return await configure({
    apiKey: options.apiKey,
    env: deps.env ?? process.env,
    providerId: options.providerId,
  });
}
