/**
 * pp10 repro harness: does the TUI command center dispatch a first-class skill
 * command (`/pain-decomposition <task>`) the way it advertises?
 *
 * Uses the REAL skill discovery + REAL custom-command loader, so the input list
 * is byte-identical to what the TUI shows in its slash-command suggestions.
 *
 * Run: pnpm exec tsx test/repro-pp10-skill-command.mts
 */
import { listZCodeSkills } from "../apps/zcode-cli/packages/bootstrap/src/skills.js";
import { loadZCodeCustomCommand } from "../apps/zcode-cli/packages/bootstrap/src/custom-commands.js";
import { createCommandCenter } from "../apps/zcode-cli/packages/cli/src/command-center/create.js";

const WORKING_DIRECTORY = process.argv[2] ?? process.cwd();
const SKILL_NAME = "pain-decomposition";

const submitted: string[] = [];
const app = {
  submitPrompt: async (prompt: unknown) => {
    submitted.push(typeof prompt === "string" ? prompt : JSON.stringify(prompt));
    return { response: "[app.submitPrompt reached]" };
  },
} as never;

const outcomes = await Promise.all([
  listZCodeSkills({ workingDirectory: WORKING_DIRECTORY }),
  (async () => {
    try {
      return await loadZCodeCustomCommand({ name: "__pp10_probe__", workingDirectory: WORKING_DIRECTORY });
    } catch {
      return undefined;
    }
  })(),
]);
const skillOutcome = outcomes[0];

const deps = {
  getApp: async () => app,
  getMode: () => "build" as const,
  listCustomCommands: async () => ({ commands: [], diagnostics: [], totalDiscovered: 0 }),
  listSkills: async () => ({
    skills: skillOutcome.skills.map((skill) => ({
      description: skill.description,
      name: skill.name,
      path: skill.path,
      scope: skill.scope,
      source: skill.source,
    })),
    totalDiscovered: skillOutcome.totalDiscovered,
  }),
  loadCustomCommand: async (name: string) =>
    await loadZCodeCustomCommand({ name, workingDirectory: WORKING_DIRECTORY }),
  recordInputHistory: async () => undefined,
  resumeApp: async () => app,
} as never;

const commandCenter = createCommandCenter(deps);

const advertised = skillOutcome.skills.some((skill) => skill.name === SKILL_NAME);
console.log(`skills discovered: ${skillOutcome.skills.length}; /${SKILL_NAME} advertised: ${advertised}`);

let failed = false;
for (const input of [`/${SKILL_NAME} 你能读到pain decomposition吗`, "/no-useEffect task", "/skill pain-decomposition task"]) {
  submitted.length = 0;
  const result = await commandCenter(input, {});
  const firstLine = String(result.response).split("\n")[0]!.slice(0, 80);
  console.log(`\nIN   ${input}\nOUT  ${firstLine}\nAPP  ${submitted.length} call(s)`);
  if (submitted.length === 1) {
    const name = /`([^`]+)`/.exec(submitted[0]!)?.[1];
    console.log(`NAME passed to Skill tool: ${JSON.stringify(name)}`);
  }
  if (input.startsWith("/skill")) continue; // the known-good baseline
  if (submitted.length === 0) {
    console.error(`  -> FAIL: never reached app.submitPrompt`);
    failed = true;
  }
}

if (failed) {
  console.error("\nFAIL (pp10 reproduced): skill advertised as an available command, rejected as unknown");
  process.exit(1);
}
console.log("\nPASS: every advertised skill command dispatched to the app");
