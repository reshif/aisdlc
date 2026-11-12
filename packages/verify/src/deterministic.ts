import type { TaskContract } from '@aisdlc/build';
import type { TaskContractName, VerifyFinding, VerifyKitRun } from '@aisdlc/contracts';
import type { CheckContext } from './context.js';
import { finding, verdictOf, type ResultParts } from './finding.js';
import { runKit, type KitAnswer } from './kits.js';

// 7.1 Deterministic checks (FL S7 "7.1 Deterministic checks, D"): the repo's own commands of the task contract, each
// once over the Unit head in an O session. A command that fails is a high finding; a session with no verdict is
// `unknown`; a repo with no `test` command cannot be verified and fails (nothing is taken as green by default).

/** The commands 7.1 runs, in this order (`setup` and `test-fast` are not checks; `check` is "am I done?"). */
export const DETERMINISTIC_COMMANDS: readonly TaskContractName[] = [
  'build',
  'typecheck',
  'lint',
  'format-check',
  'test',
  'check',
];

/** The distinct commands of the contract, in order: the same argv under two names runs once. */
export function commandsOf(
  contract: TaskContract,
): Array<{ name: TaskContractName; argv: readonly string[] }> {
  const out: Array<{ name: TaskContractName; argv: readonly string[] }> = [];
  const seen = new Set<string>();
  for (const name of DETERMINISTIC_COMMANDS) {
    const argv = contract[name];
    if (!argv || argv.length === 0) continue;
    const k = JSON.stringify(argv);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ name, argv });
  }
  return out;
}

/** The findings of the command runs (pure). */
export function judgeCommands(
  contract: TaskContract,
  runs: ReadonlyArray<{ name: TaskContractName; argv: readonly string[]; answer: KitAnswer }>,
): VerifyFinding[] {
  const out: VerifyFinding[] = [];
  if (!contract.test || contract.test.length === 0) {
    out.push(
      finding('no_test_command', 'high', {
        message: 'the repo has no test command: the head cannot be verified',
      }),
    );
  }
  for (const r of runs) {
    if (!r.answer.answered) {
      out.push(
        finding('command_void', 'medium', {
          rule_id: r.name,
          message: `${r.name} (${r.argv.join(' ')}) gave no verdict: ${r.answer.kit.detail ?? r.answer.kit.status}`,
        }),
      );
    } else if (!r.answer.green) {
      out.push(
        finding('command_failed', 'high', {
          rule_id: r.name,
          message: `${r.name} (${r.argv.join(' ')}) failed with exit ${r.answer.exit}: ${r.answer.failing.slice(0, 5).join('; ')}`,
        }),
      );
    }
  }
  return out;
}

export async function checkDeterministic(c: CheckContext): Promise<ResultParts> {
  const runs: Array<{ name: TaskContractName; argv: readonly string[]; answer: KitAnswer }> = [];
  for (const cmd of commandsOf(c.contract)) {
    runs.push({ ...cmd, answer: await runKit(c.kit, `cmd-${cmd.name}`, c.head, cmd.argv) });
  }
  const findings = judgeCommands(c.contract, runs);
  const kits: VerifyKitRun[] = runs.map((r) => r.answer.kit);
  return { findings, kits, raised: null, verdict: verdictOf(findings, kits) };
}
