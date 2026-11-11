import { B1_BLOCKED_CLASSES, SANDBOX_PROFILES } from '@aisdlc/contracts';
import type { SandboxClass } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  sandboxError,
  type SandboxError,
  type SandboxPort,
  type SandboxRun,
  type SandboxSpec,
} from './sandbox.js';

// Who may start a session (PLAN M13.4 B1 over classes; DEC-18 as decided 2026-11-09).
//
//   1. DEC-18: a class that runs repo code (`profile.exec`: W, K-exec, O) runs only for a repo on the owner
//      allow-list (config `sandbox.exec_allowed_repos`, M1-gated). Any other repo is REFUSED with
//      `exec_not_allowed`, never skipped silently. An allow-list that cannot be read allows nothing.
//   2. B1 (onboarding-roadmap §5.2): an open secret finding for the repo blocks P, W, O, V and K-exec sessions.
//      K (the scanners) is exempt: it is how a finding gets fixed (fix #5). Whether a finding is open that
//      cannot be told is open (fail closed).
//
// One function, used by the coding stage port before any session and by `GuardedSandbox` in front of every
// session of every caller, so a caller that forgets to check is still stopped.

export interface SessionGuardDeps {
  /** The owner allow-list now in force; `null` when it cannot be read (nothing is allowed). */
  readonly execAllowedRepos: () => readonly string[] | null;
  /** Whether the repo has an open secret finding. An error means "cannot tell": B1 blocks. */
  readonly hasOpenSecretFinding: (repo: string) => Promise<Result<boolean, { message: string }>>;
}

export async function checkSessionAllowed(
  d: SessionGuardDeps,
  repo: string | undefined,
  cls: SandboxClass,
): Promise<Result<void, SandboxError>> {
  const profile = SANDBOX_PROFILES[cls];
  const execs = profile?.exec === true;
  const b1 = B1_BLOCKED_CLASSES.includes(cls);
  if (!execs && !b1) return ok(undefined);
  if (repo === undefined || repo === '') {
    return err(
      sandboxError('refused', `class ${cls} needs the repository named: no repo, no session`),
    );
  }
  if (execs) {
    const allowed = d.execAllowedRepos();
    if (allowed === null || !allowed.includes(repo)) {
      return err(
        sandboxError(
          'exec_not_allowed',
          `${repo} is not on the owner allow-list (sandbox.exec_allowed_repos): its code does not run`,
        ),
      );
    }
  }
  if (b1) {
    const open = await d.hasOpenSecretFinding(repo);
    if (!open.ok || open.value) {
      return err(
        sandboxError(
          'b1_blocked',
          open.ok
            ? `${repo} has an open secret finding (B1): class ${cls} does not start`
            : `B1 could not be checked (${open.error.message}): class ${cls} does not start`,
        ),
      );
    }
  }
  return ok(undefined);
}

/** A `SandboxPort` that checks `checkSessionAllowed` before every session and starts nothing on a refusal. */
export class GuardedSandbox implements SandboxPort {
  constructor(
    private readonly inner: SandboxPort,
    private readonly guard: SessionGuardDeps,
  ) {}

  async run(spec: SandboxSpec): Promise<Result<SandboxRun, SandboxError>> {
    const ok_ = await checkSessionAllowed(this.guard, spec.repo_full_name, spec.class);
    if (!ok_.ok) return ok_;
    return this.inner.run(spec);
  }
}
