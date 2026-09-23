import type { TuiPromptInput } from "@zcode/tui";
import type { CommandCenterDeps } from "./types.js";

export async function recordSlashCommandInHistory(
  deps: CommandCenterDeps,
  input: TuiPromptInput,
): Promise<void> {
  if (!deps.recordInputHistory) return;
  try {
    await deps.recordInputHistory(input, "slash_command");
  } catch {
    // Input history is recall UX; command execution must not depend on it.
  }
}
