import { TASK_CONTRACT_NAMES, taskNameFor, type TaskContractName } from '@aisdlc/contracts';
import type { RepoFile } from '@aisdlc/ports';
import type { TaskContract } from './source.js';

// The task contract of a repo as argv, from the same names the census detectors map (`taskNameFor`, shared in
// contracts): package.json scripts and Makefile targets. Names only are read, never a script body, and nothing
// here runs anything; the argv is what the sandbox is asked to run.

const text = (f: RepoFile): string =>
  typeof f.content === 'string' ? f.content : Buffer.from(f.content).toString('utf8');

export function taskContractOf(files: readonly RepoFile[]): TaskContract {
  const out: Partial<Record<TaskContractName, readonly string[] | null>> = {};
  for (const n of TASK_CONTRACT_NAMES) out[n] = null;
  const found = new Map<TaskContractName, { argv: string[]; exact: boolean }>();
  const offer = (name: TaskContractName, argv: string[], exact: boolean) => {
    const have = found.get(name);
    if (!have || (exact && !have.exact)) found.set(name, { argv, exact });
  };
  const pkg = files.find((f) => f.path === 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(text(pkg)) as { scripts?: Record<string, unknown> };
      for (const key of Object.keys(j.scripts ?? {})) {
        const name = taskNameFor(key);
        if (name) offer(name, key === 'test' ? ['npm', 'test'] : ['npm', 'run', key], key === name);
      }
    } catch {
      /* an unreadable package.json has no scripts */
    }
  }
  const mk = files.find((f) => f.path === 'Makefile');
  if (mk) {
    for (const m of text(mk).matchAll(/^([A-Za-z][\w.-]*):(?!=)/gm)) {
      const name = taskNameFor(m[1] as string);
      if (name) offer(name, ['make', m[1] as string], m[1] === name);
    }
  }
  for (const [n, v] of found) out[n] = v.argv;
  return out;
}

/** The argv that runs ONE test file: the task contract's `test` plus the file (`npm test -- file` for npm). */
export function testOneArgv(test: readonly string[], file: string): string[] {
  if (test[0] === 'npm' || test[0] === 'pnpm' || test[0] === 'yarn') return [...test, '--', file];
  return [...test, file];
}
