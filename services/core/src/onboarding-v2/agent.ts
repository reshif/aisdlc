import {
  ONBOARDING_AGENT_ACTOR,
  ONBOARDING_AGENT_EVENT,
  ONBOARDING_PACK_RENDERER,
  OnboardingAgentProposedPayload,
  onboardingAgentStream,
  patchHashOf,
  patchSetOf,
  protectedPushPath,
  type ControlsReport,
  type Gap,
  type PackFile,
  type PatchFile,
} from '@aisdlc/contracts';
import {
  agentDefinition,
  agentKeyRequest,
  buildContext,
  validateOutput,
  type OnboardingFixKind,
} from '@aisdlc/agents';
import { err, hashCanonical, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import type { AgentKeyPort, ModelCallOptions } from '@aisdlc/ports';
import { RunKeyVault, callMessages } from '@aisdlc/ports';
import { scanText } from '@aisdlc/secrets-rules';
import type { Tx } from '@aisdlc/record';
import type { LoopContext, LoopSpec } from '@aisdlc/loops';
import { activeS0Ids } from '../queries.js';
import type pg from 'pg';
import type { z } from 'zod';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys } from '../journal.js';
import { buildControlsReport } from '../cards/controls.js';
import { allowedDispositions, defaultDisposition } from '../cards/gaps.js';
import type { CardDeps } from '../cards/model.js';
import { advancePack, type PackDeps } from '../cards/pack.js';
import { loadS0, s0Cards, type LoadedS0 } from '../cards/read.js';
import { proposeRoleMap } from '../cards/roles.js';
import type { OnboardingOutput } from '@aisdlc/agents';
import { readPrompt } from '@aisdlc/agents/files';

// The onboarding agent's run for one S0 record (portal v2, intent §4; screen-map §2.10 step 2). Once the census is in
// and card 1 is open, the factory gives the agent what it read (the census by counts, the controls report, the role
// proposal) and the agent PROPOSES: what it learned, claims with evidence, fixes, gap dispositions. The factory then:
//
//   1. validates the output (`validateOutput`, `onboarding.v1`); invalid output is refused and nothing is recorded;
//   2. drops every fix file outside its kind's paths, any file the repo already has (the factory never replaces a
//      person's file) and any file the secret ruleset hits, and records the proposal FIRST
//      (`onboarding_agent.proposed` on `onboarding-agent:<s0>`, folded into `core.onboarding_proposal`);
//   3. renders the remaining files as ONE patch and hands it to the pack path (`advancePack`, kind `fixes`): recorded,
//      bound to its own X2 (the `x` slot, or the factory admin's override) and pushed by the Push Broker as a draft PR
//      only once that X2 is approved in the ledger. A person merges it on GitHub; the factory never merges.
//
// The agent decides nothing and its actor is never a person: the one sign-off is a person's (`sign-off.ts`).

export type OnboardingAgentOutput = z.infer<typeof OnboardingOutput>;

/** What the agent is given: what the factory read, never more. */
export interface OnboardingAgentInput {
  readonly s0_id: string;
  readonly project_id: string;
  readonly repo: string;
  readonly level: string;
  readonly base_sha: string;
  readonly census: {
    readonly census_hash: string;
    readonly posture: string;
    readonly tier_floor: string;
    readonly blockers: ReadonlyArray<{ id: string; status: string }>;
    readonly gaps: ReadonlyArray<{ gap_id: string; criterion: string; severity: string }>;
    readonly secret_findings: number;
  };
  readonly controls: ControlsReport | null;
  readonly owners: readonly string[];
}

export interface OnboardingAgentAnswer {
  readonly output: unknown;
  readonly model: string;
  readonly prompt_sha256: string;
}

/** The onboarding agent behind a port: the gateway in a deployment, a deterministic fake in tests and local compose. */
export interface OnboardingAgentPort {
  propose(input: OnboardingAgentInput): Promise<Result<OnboardingAgentAnswer, CoreError>>;
}

const DEF = agentDefinition('onboarding');

/** Where each kind of fix may write. Anything else is dropped. */
export const FIX_PATHS: Readonly<Record<OnboardingFixKind, readonly string[]>> = {
  codeowners: ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'],
  agents_md: ['AGENTS.md'],
  claude_md: ['CLAUDE.md'],
  protect_main_ruleset: ['.github/rulesets/protect-main.json'],
  // the task-contract detector reads these (services/knowledge detectors/task-contract.ts): a `test` target
  test_command: ['Makefile', 'justfile'],
};

const control = (r: ControlsReport | null, id: string) => r?.controls.find((c) => c.id === id);

/** The ruleset a person imports on GitHub (Settings › Rules › Rulesets › Import): PRs, one approval, the factory check. */
export function protectMainRuleset(checkName: string): string {
  return `${JSON.stringify(
    {
      name: 'protect-main',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            require_code_owner_review: true,
            dismiss_stale_reviews_on_push: true,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            required_status_checks: [{ context: checkName }],
          },
        },
      ],
      bypass_actors: [],
    },
    null,
    2,
  )}\n`;
}

/**
 * The deterministic onboarding agent: the same facts give the same proposal, byte for byte. It proposes only what
 * the facts show (no CODEOWNERS: one naming the owners found; no AGENTS.md: one with what is known; main not
 * protected: the ruleset to import and the steps), and suggests each gap's default disposition.
 */
export class FakeOnboardingAgent implements OnboardingAgentPort {
  readonly calls: OnboardingAgentInput[] = [];
  constructor(private readonly o: { checkName?: string; model?: string } = {}) {}

  async propose(i: OnboardingAgentInput): Promise<Result<OnboardingAgentAnswer, CoreError>> {
    this.calls.push(i);
    return ok({
      output: fakeOnboardingOutput(i, this.o.checkName ?? 'aisdlc/gate'),
      model: this.o.model ?? 'fake-onboarding',
      prompt_sha256: DEF.prompt.sha256,
    });
  }
}

export function fakeOnboardingOutput(
  i: OnboardingAgentInput,
  checkName: string,
): OnboardingAgentOutput {
  const r = i.controls;
  const ev = (path: string) => [{ path, commit_sha: i.base_sha }];
  const codeownersPresent = r?.codeowners.path !== null && r?.codeowners.path !== undefined;
  const agentsMd = r?.instructions.agents_md ?? 'unknown';
  const claudeMd = r?.instructions.claude_md ?? 'unknown';
  const protect = control(r, 'protect_main');
  const appScope = control(r, 'app_scope');
  const owners = [...new Set(i.owners)].sort();
  const fixes: OnboardingAgentOutput['fixes'] = [];
  if (!codeownersPresent) {
    fixes.push({
      fix_id: 'codeowners',
      fix_kind: 'codeowners',
      title: 'Add a code owners file',
      why: 'Code review needs an owner for every path; the repo has no CODEOWNERS file.',
      files:
        owners.length > 0
          ? [
              {
                path: '.github/CODEOWNERS',
                content: `# Proposed by the factory's onboarding agent. Review it, then merge it on GitHub.\n* ${owners.map((l) => `@${l}`).join(' ')}\n`,
              },
            ]
          : [],
      manual_steps:
        owners.length > 0
          ? []
          : ['Add a CODEOWNERS file naming who reviews each folder (no owner could be found).'],
    });
  }
  if (agentsMd === 'absent') {
    fixes.push({
      fix_id: 'agents-md',
      fix_kind: 'agents_md',
      title: 'Add agent instructions (AGENTS.md)',
      why: 'Agents follow only the instructions a person approved; the repo has none yet.',
      files: [
        {
          path: 'AGENTS.md',
          content: [
            `# AGENTS.md`,
            '',
            `Instructions for coding agents working on ${i.repo}. Proposed by the factory's onboarding agent from`,
            'what it read; a person reviews and merges it.',
            '',
            '## Rules',
            '',
            '- Work on a branch and open a pull request; never push to the default branch.',
            '- Run the tests before you open a pull request, and say in the PR what you ran.',
            '- Do not change files under `.factory/` or `.github/`, or the CODEOWNERS file.',
            '- Never commit secrets, tokens or credentials.',
            '',
          ].join('\n'),
        },
      ],
      manual_steps: [],
    });
  }
  if (claudeMd === 'absent' && agentsMd === 'absent') {
    fixes.push({
      fix_id: 'claude-md',
      fix_kind: 'claude_md',
      title: 'Point Claude at the agent instructions (CLAUDE.md)',
      why: 'Claude reads CLAUDE.md; one line makes it read AGENTS.md too.',
      files: [{ path: 'CLAUDE.md', content: '@AGENTS.md\n' }],
      manual_steps: [],
    });
  }
  if (protect && protect.status !== 'met') {
    fixes.push({
      fix_id: 'protect-main',
      fix_kind: 'protect_main_ruleset',
      title: 'Protect the main branch',
      why: 'Agents may only open pull requests into a branch that needs a review and the factory check. The factory cannot set this itself: its GitHub App never holds administration.',
      files: [
        { path: '.github/rulesets/protect-main.json', content: protectMainRuleset(checkName) },
      ],
      manual_steps: [
        'On GitHub, open the repo’s Settings, then Rules, then Rulesets.',
        'Choose New ruleset, then Import a ruleset, and pick .github/rulesets/protect-main.json from this PR.',
        'Save it, then press Re-check here.',
      ],
    });
  }
  const learned: OnboardingAgentOutput['learned'] = [
    {
      topic: 'owners',
      status: codeownersPresent ? 'ok' : 'needs_fix',
      text: codeownersPresent
        ? `A CODEOWNERS file is at ${r?.codeowners.path}.`
        : owners.length > 0
          ? `No CODEOWNERS file; the people with admin rights are ${owners.join(', ')}.`
          : 'No CODEOWNERS file, and no owner could be found.',
      evidence: codeownersPresent && r?.codeowners.path ? ev(r.codeowners.path) : [],
    },
    {
      topic: 'branch_protection',
      status: !protect ? 'unknown' : protect.status === 'met' ? 'ok' : 'needs_fix',
      text: !protect
        ? 'Branch protection could not be read.'
        : protect.status === 'met'
          ? 'The default branch needs a pull request, a review and the factory check.'
          : 'The default branch is not protected the way agents need.',
      evidence: [],
    },
    {
      topic: 'app_permissions',
      status: !appScope ? 'unknown' : appScope.status === 'met' ? 'ok' : 'needs_fix',
      text:
        appScope?.status === 'met'
          ? 'The GitHub App is installed on selected repos only, with read access.'
          : 'The GitHub App’s access needs a look.',
      evidence: [],
    },
    {
      topic: 'secrets',
      status: i.census.secret_findings > 0 ? 'needs_fix' : 'ok',
      text:
        i.census.secret_findings > 0
          ? `${i.census.secret_findings} possible secrets were found; the security approver decides each one.`
          : 'No secrets were found in the files or the history.',
      evidence: [],
    },
    {
      topic: 'instructions',
      status: agentsMd === 'present' ? 'ok' : agentsMd === 'absent' ? 'needs_fix' : 'unknown',
      text:
        agentsMd === 'present'
          ? 'AGENTS.md exists.'
          : agentsMd === 'absent'
            ? 'There are no agent instructions yet.'
            : 'Whether agent instructions exist could not be read.',
      evidence: agentsMd === 'present' ? ev('AGENTS.md') : [],
    },
  ];
  const blocking = i.census.gaps.filter((g) => g.severity === 'blocking').length;
  return {
    kind: 'onboarding',
    summary:
      `${i.repo} was read at commit ${i.base_sha.slice(0, 7)}. ` +
      `${i.census.gaps.length} gaps were found (${blocking} must be fixed for this level). ` +
      (fixes.length > 0
        ? `${fixes.length} fixes are proposed; the ones with files open as one draft PR once approved.`
        : 'Nothing needs a fix PR.'),
    learned,
    claims:
      codeownersPresent && r?.codeowners.path
        ? [
            {
              claim_id: 'codeowners',
              text: `Code owners are declared in ${r.codeowners.path}.`,
              confidence: 'high',
              evidence: ev(r.codeowners.path),
            },
          ]
        : [],
    fixes,
    questions: ['Does a merge to the default branch deploy anywhere?'],
    gap_suggestions: i.census.gaps.map((g) => ({
      gap_id: g.gap_id,
      disposition: g.severity === 'blocking' ? ('file_issue' as const) : ('track_only' as const),
      why:
        g.severity === 'blocking'
          ? 'It blocks the level asked for: fix it now.'
          : 'It does not block this level: track it.',
    })),
  };
}

/** The real agent: one call through the gateway under a per-record key built from the contract and nothing else. */
export class GatewayOnboardingAgent implements OnboardingAgentPort {
  constructor(
    private readonly d: {
      readonly keys: AgentKeyPort;
      readonly gateway: ModelCallOptions;
      /** The prompt file by its reference; default: the registry's file on disk. */
      readonly prompt?: (ref: string) => string;
      readonly now?: () => Date;
    },
  ) {}

  async propose(i: OnboardingAgentInput): Promise<Result<OnboardingAgentAnswer, CoreError>> {
    const now = this.d.now?.() ?? new Date();
    let system: string;
    try {
      system = (this.d.prompt ?? readPrompt)(DEF.prompt.ref);
    } catch {
      return err(coreError('unavailable', 'the onboarding prompt cannot be read'));
    }
    if (sha256Hex(system) !== DEF.prompt.sha256) {
      return err(coreError('unavailable', 'the onboarding prompt does not match its lock'));
    }
    const req = agentKeyRequest(DEF, {
      scope: { kind: 'job', ref: `onboarding:${i.s0_id}` },
      group: `onboarding:${i.s0_id}`,
      project_id: i.project_id as never,
      now,
    });
    const minted = await this.d.keys.mint(req);
    if (!minted.ok) return err(coreError('unavailable', `no key: ${minted.error.message}`));
    const vault = new RunKeyVault();
    const runId = `onboarding:${i.s0_id}`;
    vault.put(runId, minted.value.vkey.vkey_id, minted.value.secret);
    try {
      const facts = JSON.stringify({ ...i, controls: i.controls }, null, 2);
      const built = buildContext({
        agent_id: 'onboarding',
        purpose: 'onboarding',
        merged_sha: i.base_sha,
        policy: [
          {
            text: 'Propose the onboarding summary of ONE repository from the facts the factory read. Answer with one JSON object of schema onboarding.v1.',
          },
        ],
        intent: null,
        artefacts: [{ type: 'onboarding_facts', sha256: sha256Hex(facts), text: facts }],
      });
      let feedback = '';
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        const r = await vault.lend(runId, (secret) =>
          callMessages(this.d.gateway, secret, DEF.contract.data_class_max, {
            model: DEF.contract.models[0] ?? 'default',
            max_tokens: 8192,
            system,
            messages: [{ role: 'user', content: `${built.text}\n${feedback}` }],
          }),
        );
        if (r === null) return err(coreError('unavailable', 'the run key was lost'));
        if (!r.ok) return err(coreError('unavailable', `the gateway refused: ${r.error.code}`));
        let parsed: unknown;
        try {
          parsed = JSON.parse(r.value.text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
        } catch {
          feedback = 'Your previous answer was not one JSON object. Answer with JSON only.';
          continue;
        }
        const v = validateOutput('onboarding', parsed);
        if (v.ok) {
          return ok({ output: parsed, model: r.value.model, prompt_sha256: DEF.prompt.sha256 });
        }
        feedback = `Your previous answer was refused: ${JSON.stringify(v.error).slice(0, 2000)}`;
      }
      return err(coreError('refused', 'the onboarding agent gave no valid output'));
    } finally {
      vault.drop(runId);
      await this.d.keys.revoke?.(minted.value.vkey.vkey_id).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------- the record

export interface ProposalRow {
  readonly s0_id: string;
  readonly output_hash: string;
  readonly census_hash: string;
  readonly base_sha: string;
  readonly model: string;
  readonly output: OnboardingAgentOutput;
  readonly proposed_at: string;
  readonly dropped: ReadonlyArray<{ ref: string; why: string }>;
}

export async function applyProposalEvent(
  tx: Pick<Tx, 'query'>,
  e: { type: string; payload: unknown; global_seq: number },
): Promise<void> {
  if (e.type !== ONBOARDING_AGENT_EVENT.proposed) return;
  const p = OnboardingAgentProposedPayload.parse(e.payload);
  await tx.query(
    `INSERT INTO core.onboarding_proposal
       (s0_id, output_hash, census_hash, base_sha, agent_id, prompt_sha256, model, output, proposed_at, event_gseq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (s0_id, output_hash) DO NOTHING`,
    [
      p.s0_id,
      p.output_hash,
      p.census_hash,
      p.base_sha,
      p.agent_id,
      p.prompt_sha256,
      p.model,
      JSON.stringify({ output: p.output, dropped: p.dropped }),
      p.proposed_at,
      e.global_seq,
    ],
  );
}

/** The read model rebuilt from the record alone. */
export async function rebuildOnboardingProposals(
  d: Pick<CardDeps, 'pool' | 'clock'>,
  s0Id: string,
): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY global_seq`,
    [onboardingAgentStream(s0Id)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [onboardingAgentStream(s0Id)]);
    await tx.query('DELETE FROM core.onboarding_proposal WHERE s0_id = $1', [s0Id]);
    for (const e of q.rows) {
      await applyProposalEvent(tx, {
        type: e.type,
        payload: e.body,
        global_seq: Number(e.global_seq),
      });
    }
    return ok(q.rows.length);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

/** The newest proposal for the record's census, or `null`. */
export async function latestProposal(
  pool: Pick<pg.Pool, 'query'>,
  s0Id: string,
  censusHash?: string,
): Promise<ProposalRow | null> {
  const q = await pool.query<{
    s0_id: string;
    output_hash: string;
    census_hash: string;
    base_sha: string;
    model: string;
    output: { output: OnboardingAgentOutput; dropped: Array<{ ref: string; why: string }> };
    proposed_at: Date;
  }>(
    `SELECT s0_id, output_hash, census_hash, base_sha, model, output, proposed_at FROM core.onboarding_proposal
      WHERE s0_id = $1 AND ($2::text IS NULL OR census_hash = $2) ORDER BY event_gseq DESC LIMIT 1`,
    [s0Id, censusHash ?? null],
  );
  const r = q.rows[0];
  return r
    ? {
        s0_id: r.s0_id,
        output_hash: r.output_hash,
        census_hash: r.census_hash,
        base_sha: r.base_sha,
        model: r.model,
        output: r.output.output,
        dropped: r.output.dropped,
        proposed_at: r.proposed_at.toISOString(),
      }
    : null;
}

// ---------------------------------------------------------------- the run

export interface OnboardingAgentDeps {
  readonly cards: CardDeps;
  readonly agent: OnboardingAgentPort;
  /** The pack path (record, X2, Push Broker); absent: the fixes are proposed but not rendered. */
  readonly pack?: PackDeps;
}

/** The facts the agent is given, from the record and the code host. `null`: the census is not in yet. */
export async function agentInputOf(
  d: Pick<CardDeps, 'knowledge' | 'source' | 'links'>,
  loaded: LoadedS0,
  requestedBy: string,
): Promise<Result<OnboardingAgentInput | null, CoreError>> {
  const { s0 } = loaded;
  if (!s0.census) return ok(null);
  const latest = await d.knowledge.census(s0.repo);
  if (!latest.ok) return err(coreError('unavailable', `knowledge: ${latest.error.message}`));
  if (latest.value === null || latest.value.census_hash !== s0.census.census_hash) return ok(null);
  const census = latest.value.census;
  const [report, roles] = await Promise.all([
    buildControlsReport(d, s0.repo, { reduced: s0.record.requested_level === 'census' }),
    proposeRoleMap(d, s0.repo, requestedBy as never),
  ]);
  const owners = roles.basis.collaborators
    .filter((c) => c.permission === 'admin' || c.permission === 'maintain')
    .map((c) => c.login);
  return ok({
    s0_id: s0.record.s0_id,
    project_id: s0.record.project_id,
    repo: s0.repo,
    level: s0.record.requested_level,
    base_sha: census.baseline_sha,
    census: {
      census_hash: s0.census.census_hash,
      posture: census.posture.state,
      tier_floor: census.risk_category.tier_floor,
      blockers: census.blockers.map((b) => ({ id: b.id, status: b.status })),
      gaps: census.gaps.map((g: Gap) => ({
        gap_id: g.gap_id,
        criterion: g.criterion,
        severity: g.severity,
      })),
      secret_findings: Number(
        (census.security_summary.history_scan as { findings?: number } | undefined)?.findings ?? 0,
      ),
    },
    controls: report,
    owners: owners.length > 0 ? owners : [...roles.basis.codeowners_logins],
  });
}

/** Whether a Makefile or justfile defines a `test` recipe at column 0 (what the task-contract detector maps to `test`). */
export function definesTestTarget(path: string, content: string): boolean {
  return (path === 'Makefile' ? /^test\s*:(?![=:])/m : /^@?test(?:\s+[^:\n]*)?:(?!=)/m).test(
    content,
  );
}

/** The task files the census detectors saw at the census head (`null`: the facts could not be read). */
export async function existingTaskFiles(
  d: Pick<CardDeps, 'knowledge'>,
  jobId: string,
): Promise<ReadonlySet<string> | null> {
  const facts = await d.knowledge.detectorFacts(jobId);
  if (!facts.ok || facts.value === null) return null;
  return new Set(
    facts.value.flatMap((f) =>
      f.kind === 'task_command' && f.source !== null ? [f.source.split('#')[0] as string] : [],
    ),
  );
}

/** Keeps the files the factory accepts; says why each other one was dropped. */
export function acceptedFixFiles(
  out: OnboardingAgentOutput,
  report: ControlsReport | null,
  /** The task files the census saw (Makefile, justfile, ...); `null`: unknown, so none may be written (fail closed). */
  taskFiles: ReadonlySet<string> | null = null,
): {
  files: Array<{ fix_id: string; path: string; content: string }>;
  dropped: Array<{ ref: string; why: string }>;
} {
  const files: Array<{ fix_id: string; path: string; content: string }> = [];
  const dropped: Array<{ ref: string; why: string }> = [];
  const seen = new Set<string>();
  const present = (path: string): boolean =>
    (path === 'AGENTS.md' && report?.instructions.agents_md !== 'absent') ||
    (path === 'CLAUDE.md' && report?.instructions.claude_md !== 'absent') ||
    (FIX_PATHS.codeowners.includes(path) && report?.codeowners.path !== null) ||
    (FIX_PATHS.test_command.includes(path) && (taskFiles === null || taskFiles.has(path)));
  for (const f of out.fixes) {
    for (const file of f.files) {
      const ref = `${f.fix_id}:${file.path}`;
      if (!FIX_PATHS[f.fix_kind].includes(file.path)) {
        dropped.push({ ref, why: `${file.path} is not a path a ${f.fix_kind} fix may write` });
      } else if (seen.has(file.path)) {
        dropped.push({ ref, why: 'another fix already writes this path' });
      } else if (present(file.path)) {
        dropped.push({ ref, why: 'the repo already has this file: the factory never replaces it' });
      } else if (f.fix_kind === 'test_command' && !definesTestTarget(file.path, file.content)) {
        dropped.push({ ref, why: 'the file defines no `test` target the detector would read' });
      } else if (scanText(file.content).length > 0) {
        dropped.push({ ref, why: 'the file would hold a secret' });
      } else {
        seen.add(file.path);
        files.push({ fix_id: f.fix_id, path: file.path, content: file.content });
      }
    }
  }
  return { files, dropped };
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');

/** The accepted fix files as one patch, with a manifest naming the proposal it came from. */
export function renderFixes(
  s0Id: string,
  repo: string,
  baseSha: string,
  outputHash: string,
  files: ReadonlyArray<{ fix_id: string; path: string; content: string }>,
) {
  if (files.length === 0) return null;
  const manifest = `${JSON.stringify(
    {
      note: "Proposed by the factory's onboarding agent; a person reviews and merges this PR on GitHub. The factory never merges.",
      renderer: ONBOARDING_PACK_RENDERER,
      s0_record: s0Id,
      repo,
      base_sha: baseSha,
      proposal: outputHash,
      files: files.map((f) => ({ path: f.path, fix: f.fix_id, sha256: sha256Hex(f.content) })),
    },
    null,
    2,
  )}\n`;
  const all = [
    ...files.map((f) => ({ path: f.path, content: f.content })),
    { path: '.factory/onboarding-fixes.json', content: manifest },
  ];
  const patchFiles: PatchFile[] = all.map((f) => ({
    op: 'put',
    path: f.path,
    mode: '100644',
    content_b64: b64(f.content),
  }));
  const patch = patchSetOf(patchFiles);
  const metas: PackFile[] = all
    .map((f) => ({
      path: f.path,
      source:
        f.path === '.factory/onboarding-fixes.json'
          ? ('manifest' as const)
          : ('agent_fix' as const),
      sha256: sha256Hex(f.content),
      bytes: Buffer.byteLength(f.content, 'utf8'),
      protected_rule: protectedPushPath(f.path),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { patch, patch_hash: patchHashOf(patch), files: metas };
}

export type RunOutcome =
  | { readonly state: 'waiting'; readonly why: string }
  | {
      readonly state: 'proposed' | 'unchanged';
      readonly output_hash: string;
      readonly fixes: string;
    };

/**
 * Runs the agent for one record when its census is in and card 1 exists, unless the census already has a proposal
 * (`force`: run again, e.g. a person's "Ask the agent again"). Then moves the fixes pack as far as it can go.
 */
export async function runOnboardingAgent(
  d: OnboardingAgentDeps,
  s0Id: string,
  o: { force?: boolean } = {},
): Promise<Result<RunOutcome, CoreError>> {
  const pool = d.cards.pool;
  const loaded = await loadS0(pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const { s0 } = loaded;
  if (['done', 'rejected', 'withdrawn', 'superseded'].includes(s0.record.status)) {
    return ok({ state: 'waiting', why: `the onboarding is ${s0.record.status}` });
  }
  if (!s0.census) return ok({ state: 'waiting', why: 'the census is not in yet' });
  const cards = await s0Cards(pool, s0Id);
  const c1 = [...cards]
    .filter((c) => c.kind === 'C1')
    .sort((a, b) => b.occurrence - a.occurrence)[0];
  if (!c1) return ok({ state: 'waiting', why: 'card 1 is not open yet' });

  let row = await latestProposal(pool, s0Id, s0.census.census_hash);
  let state: 'proposed' | 'unchanged' = 'unchanged';
  if (!row || o.force) {
    const requested = loaded.events.find((e) => e.type === 's0.requested');
    const requestedBy = (requested?.payload as { requested_by?: string } | undefined)?.requested_by;
    const input = await agentInputOf(d.cards, loaded, requestedBy ?? 'unknown');
    if (!input.ok) return input;
    if (input.value === null) return ok({ state: 'waiting', why: 'the census moved on' });
    const answer = await d.agent.propose(input.value);
    if (!answer.ok) return answer;
    const v = validateOutput('onboarding', answer.value.output);
    if (!v.ok) {
      return err(
        coreError(
          'refused',
          `the onboarding agent's output is invalid: ${JSON.stringify(v.error).slice(0, 500)}`,
        ),
      );
    }
    const output = answer.value.output as OnboardingAgentOutput;
    // record nothing a secret rule hits, anywhere in the output (the fix files are checked one by one below)
    const prose = JSON.stringify({
      ...output,
      fixes: output.fixes.map((f) => ({ ...f, files: [] })),
    });
    if (scanText(prose).length > 0) {
      return err(
        coreError('refused', 'the onboarding agent wrote something that looks like a secret'),
      );
    }
    const { dropped } = acceptedFixFiles(
      output,
      input.value.controls,
      await existingTaskFiles(d.cards, s0.census.job_id),
    );
    const outputHash = hashCanonical(output);
    const payload = OnboardingAgentProposedPayload.parse({
      s0_id: s0Id,
      agent_id: 'onboarding',
      contract_version: DEF.contract.contract_version,
      prompt_sha256: answer.value.prompt_sha256,
      model: answer.value.model,
      census_hash: s0.census.census_hash,
      base_sha: input.value.base_sha,
      controls_report_hash: input.value.controls?.report_hash ?? null,
      output_hash: outputHash,
      output,
      dropped,
      proposed_at: clockOf(d.cards).now().toISOString(),
    });
    if (!row || row.output_hash !== outputHash) {
      const w = await inCoreTx(d.cards, async (j, tx) => {
        await lockKeys(tx, [onboardingAgentStream(s0Id)]);
        const e = await j.emit(
          onboardingAgentStream(s0Id),
          ONBOARDING_AGENT_EVENT.proposed,
          payload,
          ONBOARDING_AGENT_ACTOR,
        );
        if (!e.ok) return e;
        await applyProposalEvent(tx, {
          type: e.value.type,
          payload,
          global_seq: e.value.global_seq,
        });
        return ok(true);
      });
      if (!w.ok) return w;
      state = 'proposed';
    }
    row = await latestProposal(pool, s0Id, s0.census.census_hash);
  }
  if (!row) return err(coreError('database', 'the proposal row was not written'));
  // the console owns the fix pack while a session is running (it renders the accepted files plus this proposal's)
  const consoleOwns = await d.cards.pool.query(
    "SELECT 1 FROM core.console_session WHERE s0_id = $1 AND state <> 'stopped'",
    [s0Id],
  );
  const fixes =
    consoleOwns.rowCount && consoleOwns.rowCount > 0
      ? ok('console_owns_pack')
      : await projectFixes(d, loaded, c1.card_id, row);
  return ok({
    state,
    output_hash: row.output_hash,
    fixes: fixes.ok ? fixes.value : `not rendered: ${fixes.error.message}`,
  });
}

/** The fixes pack of the newest proposal, moved as far as it can go (record, X2, push). */
export async function projectFixes(
  d: OnboardingAgentDeps,
  loaded: LoadedS0,
  c1CardId: string,
  row: ProposalRow,
): Promise<Result<string, CoreError>> {
  if (!d.pack) return ok('no_pack_path');
  const report = await buildControlsReport(d.cards, loaded.s0.repo, {
    reduced: loaded.s0.record.requested_level === 'census',
  });
  const { files } = acceptedFixFiles(
    row.output,
    report,
    loaded.s0.census ? await existingTaskFiles(d.cards, loaded.s0.census.job_id) : null,
  );
  const rendered = renderFixes(
    loaded.s0.record.s0_id,
    loaded.s0.repo,
    row.base_sha,
    row.output_hash,
    files,
  );
  if (rendered === null) return ok('nothing_to_open');
  const v = await advancePack(d.pack, loaded, 'fixes', {
    card_id: c1CardId,
    payload_hash: row.output_hash,
    base_sha: row.base_sha,
    rendered,
  });
  return v.ok ? ok(v.value.state) : v;
}

/** Every allowed disposition of a census gap and the one the card would default to, for the summary. */
export const gapChoices = (g: Gap) => ({
  allowed: allowedDispositions(g),
  default: defaultDisposition(g),
});

/**
 * `onboarding_agent`: runs the onboarding agent for every active S0 record whose census is in and has no proposal
 * yet, then moves its fixes pack (record, X2, push once approved). A record still waiting is a no-op.
 */
export function onboardingAgentLoop(
  d: OnboardingAgentDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 20_000;
  return {
    name: 'onboarding_agent',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(10_000, intervalMs), maxMs: Math.max(intervalMs, 120_000) },
    async tick(ctx: LoopContext) {
      const ids = await activeS0Ids(d.cards.pool);
      return ctx.eachItem(
        ids,
        (id) => `onboarding agent ${id}`,
        async (id) => {
          const r = await runOnboardingAgent(d, id);
          if (!r.ok && r.error.code !== 'conflict') throw new Error(r.error.message);
        },
      );
    },
  };
}
