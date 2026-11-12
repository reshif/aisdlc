import { failingNames } from '@aisdlc/build';
import type { SandboxGrantRef, VerifyKitRun } from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import type { SandboxPort } from '@aisdlc/ports';
import { filesOf, type Tree } from './tree.js';

// A kit is one sandbox session of S7 (PLAN M14.3): the repo's own commands over a tree in an O session (no key, no
// secret, the package mirror only), named by the item's live admission grant so the sandbox-controller starts it.
// A session that could not start for a reason that passes (`busy`, `unavailable`) is TRANSIENT: the step is asked
// again. Every other refusal, and every void run (time, memory, output, a canary in the output), is an answer with no
// verdict: the check is `unknown`, which is unmet.

/** The sandbox could not take the session now: the whole step is delivered again with the same key. */
export class TransientKitError extends Error {}

export interface KitContext {
  readonly sandbox: SandboxPort;
  readonly grant: SandboxGrantRef | null;
  readonly repo: string;
  readonly item_id: string;
  readonly command_key: string;
  readonly step: string;
  /** Seconds per test session (never above the O profile's ceiling: the preflight refuses more). */
  readonly time_s?: number;
}

export interface KitAnswer {
  readonly kit: VerifyKitRun;
  /** The session answered with exit 0. */
  readonly green: boolean;
  /** It answered (exited, no canary): `exit` and `failing` are a verdict. */
  readonly answered: boolean;
  readonly exit: number | null;
  readonly failing: string[];
}

const hex = (s: string, n: number): string => sha256Hex(s).slice(0, n);

/** `s7-<step>-<item>-<command>-<tag>`: `[a-z0-9-]`, at most 48 characters. */
export const kitSessionId = (c: KitContext, tag: string): string =>
  `s7-${c.step.replace('.', '')}-${hex(c.item_id, 8)}-${hex(c.command_key, 8)}-${hex(tag, 10)}`;

export async function runKit(
  c: KitContext,
  kit: string,
  tree: Tree,
  argv: readonly string[],
): Promise<KitAnswer> {
  const session_id = kitSessionId(c, kit);
  const r = await c.sandbox.run({
    session_id,
    class: 'O',
    command: argv,
    repo: filesOf(tree),
    repo_full_name: c.repo,
    ...(c.time_s !== undefined ? { limits: { time_s: c.time_s } } : {}),
    ...(c.grant ? { grant: c.grant } : {}),
  });
  const base = { kit: kit.slice(0, 64), class: 'O' as const, session_id };
  if (!r.ok) {
    if (r.error.code === 'busy' || r.error.code === 'unavailable') {
      throw new TransientKitError(`sandbox ${r.error.code}`);
    }
    return {
      kit: {
        ...base,
        status: r.error.code === 'driver_failure' ? 'error' : 'refused',
        exit_code: null,
        detail: r.error.code,
      },
      green: false,
      answered: false,
      exit: null,
      failing: [],
    };
  }
  const run = r.value;
  const void_ =
    run.status !== 'exited' ||
    run.quarantined ||
    run.exit_code === 125 ||
    run.exit_code === 126 ||
    run.exit_code === 127;
  if (void_) {
    return {
      kit: {
        ...base,
        status: 'void',
        exit_code: run.exit_code,
        detail: run.quarantined ? 'canary_in_output' : run.status,
      },
      green: false,
      answered: false,
      exit: run.exit_code,
      failing: [],
    };
  }
  return {
    kit: { ...base, status: 'answered', exit_code: run.exit_code, detail: null },
    green: run.exit_code === 0,
    answered: true,
    exit: run.exit_code,
    failing: run.exit_code === 0 ? [] : failingNames(`${run.stdout}\n${run.stderr}`, run.exit_code),
  };
}
