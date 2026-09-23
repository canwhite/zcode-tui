import { z } from "zod";
import type { CommandAgentSource } from "./command-types.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";

export const QCODE_AGENT_PROVIDER = "glm" satisfies ZCodeProvider;
export const QCODE_AGENT_PROVIDER_LABEL = "ZCode Agent";
export const QCODE_COMMAND_AGENT_SOURCE = "qcodeAgent" satisfies CommandAgentSource;

export const zcodeAgentProviderSchema = z.literal(QCODE_AGENT_PROVIDER);

export const QCODE_COMMAND_AGENT_SOURCES = [
  QCODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToZCodeAgent(
  _provider?: ZCodeProvider | null,
): ZCodeProvider {
  return QCODE_AGENT_PROVIDER;
}

export function isZCodeAgentProvider(
  provider: ZCodeProvider | null | undefined,
): provider is typeof QCODE_AGENT_PROVIDER {
  return provider === QCODE_AGENT_PROVIDER;
}
