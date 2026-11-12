import { taskContractOf } from '@aisdlc/build';
import type { VerifyCheckResult, VerifyRunRequest, VerifyStep } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { SandboxPort } from '@aisdlc/ports';
import { checkConformance } from './conformance.js';
import { checkConstitution } from './constitution.js';
import { DEFAULT_VERIFY_POLICY, type CheckContext, type VerifyPolicy } from './context.js';
import { checkDeterministic } from './deterministic.js';
import { finding, resultOf, type ResultParts } from './finding.js';
import { checkIntegrity } from './integrity.js';
import { TransientKitError } from './kits.js';
import type { HoldoutPort, RepoFilesPort, ReviewerPort } from './ports.js';
import { checkSecretsDependencies } from './secrets-deps.js';
import { filesOf, treeOf } from './tree.js';

// The check runner (PLAN M14.3): one step's check over one Unit head. It reads the repo at the base commit and at the
// head through the code host, runs the check (its kits in sandbox sessions, its reviewer through the gateway) and
// answers a result. It never answers a pass it did not see: a head it cannot read, a kit with no verdict, a reviewer
// with no valid answer are all `unknown`. The only error is TRANSIENT (`unavailable`): nothing could be decided now
// (the code host, the sandbox or the gateway could not be reached), and the step is asked again with the same key.

export interface VerifyRunnerDeps {
  readonly sandbox: SandboxPort;
  readonly files: RepoFilesPort;
  readonly holdouts: HoldoutPort;
  readonly reviewer: ReviewerPort;
  /** The locked prompt text of a prompt ref (`@aisdlc/agents/files` `readPrompt`). */
  readonly prompt: (ref: string) => string;
  readonly policy?: Partial<VerifyPolicy>;
  /** Seconds per test session (default: the O profile's ceiling). */
  readonly testTimeS?: number;
}

export interface VerifyRunError {
  readonly code: 'unavailable';
  readonly message: string;
}

const CHECKS: Readonly<Record<VerifyStep, (c: CheckContext) => Promise<ResultParts>>> = {
  '7.1': checkDeterministic,
  '7.2': checkIntegrity,
  '7.3': checkConformance,
  '7.4': checkSecretsDependencies,
  '7.5': checkConstitution,
};

export class VerifyRunner {
  constructor(private readonly d: VerifyRunnerDeps) {}

  async run(req: VerifyRunRequest): Promise<Result<VerifyCheckResult, VerifyRunError>> {
    const unknown = (detail: string): VerifyCheckResult =>
      resultOf(req, {
        findings: [finding('kit_error', 'high', { message: detail })],
        kits: [
          {
            kit: 'repo-read',
            class: null,
            session_id: null,
            status: 'error',
            exit_code: null,
            detail: detail.slice(0, 200),
          },
        ],
        raised: null,
        verdict: 'unknown',
      });
    const base = await this.d.files.files(req.repo, req.base_sha);
    const head = await this.d.files.files(req.repo, req.head_sha);
    for (const r of [base, head]) {
      if (!r.ok) {
        if (r.error.code === 'unavailable')
          return err({ code: 'unavailable', message: `the repo: ${r.error.message}` });
        return ok(unknown(`the repo could not be read: ${r.error.message}`));
      }
    }
    if (!base.ok || !head.ok) throw new Error('unreachable');
    const baseTree = treeOf(base.value);
    const c: CheckContext = {
      req,
      base: baseTree,
      head: treeOf(head.value),
      contract: taskContractOf(filesOf(baseTree)),
      kit: {
        sandbox: this.d.sandbox,
        grant: req.grant,
        repo: req.repo,
        item_id: req.item_id,
        command_key: req.command_key,
        step: req.step,
        ...(this.d.testTimeS !== undefined ? { time_s: this.d.testTimeS } : {}),
      },
      holdouts: this.d.holdouts,
      reviewer: this.d.reviewer,
      prompt: this.d.prompt,
      policy: { ...DEFAULT_VERIFY_POLICY, ...this.d.policy },
    };
    try {
      return ok(resultOf(req, await CHECKS[req.step](c)));
    } catch (e) {
      if (e instanceof TransientKitError) return err({ code: 'unavailable', message: e.message });
      // anything else is a bug or a broken kit: recorded as a check with no verdict, never a pass
      return ok(unknown(`the check failed to run: ${(e as Error).message ?? 'error'}`));
    }
  }
}
