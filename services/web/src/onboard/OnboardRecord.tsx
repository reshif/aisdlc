import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_GATING_PROFILE,
  ProjectToggleGroupValues,
  RepoPlan,
  RoleSlotValues,
  explain,
  type GatingProfile,
  type RoleMap,
  type RoleSlot,
  label,
  lookupTerm,
  type OnboardingSummaryView,
  type SignOffResult,
  type SummaryFix,
  type Tier,
} from '@aisdlc/contracts';
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Me } from '../api';
import { OnboardingAssistant } from '../assistant/OnboardingAssistant';
import { useStepUp } from '../cards/StepUp';
import { describeError } from '../format';
import { Link } from '../router';
import { Card, EmptyState, KeyValue, PageHeader, Pill, Stepper, Tabs, type PillTone } from '../ui';
import { ConsoleTab } from './Console';
import { Blockers } from './Blockers';
import { onboardApi, type SignOffBody } from './api';
import { ONBOARD_STEPS } from './OnboardStart';
import './onboard.css';

// Onboard a repo, steps 2 to 4 (screen-map §2.10; intent §4): the onboarding agent's live checklist and what it
// learned, the fix PRs it proposes and their state on GitHub, what only a person can do there, ONE summary to adjust
// in place, and ONE sign-off. The cards underneath (owners and risk, GitHub protection and people, the sign-off) are
// decided by the factory as this person, one by one, when the person signs: each is still a ledger entry, and the
// scorecard still needs "confirm it's you". The factory never merges: the fix PRs are merged by a person on GitHub.

export const POLL_MS = 3000;

const TIER_RANK: Readonly<Record<Tier, number>> = { T0: 0, T1: 1, T2: 2 };
const TIERS: readonly Tier[] = ['T0', 'T1', 'T2'];

const ATTEST: ReadonlyArray<readonly [string, string]> = [
  ['bypass_has_no_factory_app', 'Nobody on the bypass list of main is a factory App'],
  ['app_scope_selected', 'The factory App is installed on selected repositories only'],
  ['github_token_readonly', 'The default GITHUB_TOKEN of workflows is read-only'],
  ['actions_cannot_approve_prs', 'GitHub Actions may not create or approve pull requests'],
  ['fork_pr_approval_required', 'Workflows from fork pull requests need approval'],
];

const FIX_TONE: Readonly<Record<SummaryFix['state'], PillTone>> = {
  awaiting_approval: 'warn',
  opening: 'info',
  pr_open: 'info',
  pr_merged: 'ok',
  pr_closed: 'mute',
  refused: 'bad',
  manual: 'human',
};
const SIGN_TONE: Readonly<Record<OnboardingSummaryView['sign_off']['state'], PillTone>> = {
  not_ready: 'agent',
  ready: 'info',
  in_progress: 'info',
  needs_step_up: 'warn',
  waiting: 'warn',
  done: 'ok',
  closed: 'mute',
};

const STEP_TEXT: Readonly<Record<string, string>> = {
  '0.1': 'Read the repo and its owners (read only)',
  '0.2': 'Repo facts, agent instructions and a test run',
  '0.3': 'Code map and locked tests',
  '0.4': 'GitHub protection, the App and who decides',
  '0.5': 'Sign-off and the readiness scorecard',
};

const termOr = (family: Parameters<typeof lookupTerm>[0], v: string) =>
  lookupTerm(family, v)?.label ?? 'Unknown';

/** Where the person is in the four steps of the page. */
function stepOf(v: OnboardingSummaryView): number {
  const s = v.sign_off.state;
  if (s === 'done') return 4;
  if (s === 'not_ready') return 1;
  if (s === 'ready') return 2;
  return 3;
}

/** The person's adjustments, prefilled from what the agent and the factory propose. */
interface Draft {
  tier: Tier;
  t0: boolean;
  regulatory: boolean;
  criticality: boolean;
  gaps: Record<string, string>;
  attest: Record<string, boolean>;
  secretScanning: '' | 'on' | 'plan_unavailable';
  plan: '' | RepoPlan;
  operationsMd: boolean;
  roleMap: RoleMap;
  twoPerson: boolean;
  gating: GatingProfile;
}

function initialDraft(v: OnboardingSummaryView, me: string): Draft {
  const floor = v.census?.tier_floor ?? 'T0';
  return {
    tier: floor,
    t0: false,
    regulatory: false,
    criticality: false,
    gaps: Object.fromEntries((v.census?.gaps ?? []).map((g) => [g.gap_id, g.suggested])),
    attest: Object.fromEntries(ATTEST.map(([k]) => [k, false])),
    secretScanning: '',
    plan: '',
    operationsMd: false,
    roleMap:
      v.role_map?.proposed ??
      (Object.fromEntries(
        RoleSlotValues.map((sl) => [
          sl,
          { kind: 'principals', principals: sl === 'admin' ? [me] : [] },
        ]),
      ) as RoleMap),
    twoPerson: (v.role_map?.tier ?? floor) === 'T2',
    gating: DEFAULT_GATING_PROFILE,
  };
}

/** Whether a card of the sign-off is already decided (then what it asks is not asked again). */
const decidedCard = (v: OnboardingSummaryView, k: string) =>
  v.cards.some((c) => c.card === k && c.status === 'decided');

/** What still stops the sign-off, in words (the server checks it all again). */
function problemsOf(v: OnboardingSummaryView, d: Draft): string[] {
  const out: string[] = [];
  if (!decidedCard(v, 'C1')) {
    if (d.tier === 'T0' && v.census?.t0_required && !d.t0) {
      out.push('Low risk needs your statement: no production use, no real data, no dependants.');
    }
    if (v.census?.attest.includes('regulatory') && !d.regulatory) {
      out.push('Say that the repo has no regulatory obligation (or choose a higher risk).');
    }
    if (v.census?.attest.includes('criticality') && !d.criticality) {
      out.push('Confirm how critical the repo is.');
    }
  }
  if (!decidedCard(v, 'C4')) {
    for (const [k, text] of ATTEST) if (!d.attest[k]) out.push(`Confirm on GitHub: ${text}.`);
    if (d.secretScanning === '') out.push('Say whether secret scanning is on.');
    if (d.plan === '') out.push('Say which GitHub plan the owner is on (or that you do not know).');
    if (v.controls?.operations_md && !d.operationsMd) {
      out.push('Confirm that operations.md says how this project is run.');
    }
    if ((v.controls?.blocking_open.length ?? 0) > 0) {
      out.push('Something on GitHub must be fixed first; see "What only a person can do".');
    }
  }
  return out;
}

function bodyOf(v: OnboardingSummaryView, d: Draft, me: string): SignOffBody {
  const c1Open = !decidedCard(v, 'C1');
  const c4Open = !decidedCard(v, 'C4');
  return {
    summary_hash: v.summary_hash,
    ...(c1Open ? { c1: c1Of(v, d, me) } : {}),
    ...(c4Open ? { c4: c4Of(v, d) } : {}),
  };
}

function c1Of(v: OnboardingSummaryView, d: Draft, me: string): NonNullable<SignOffBody['c1']> {
  return {
    owners: [me as never],
    tier: d.tier,
    ...(d.tier === 'T0' && d.t0 ? { t0_attestation: true } : {}),
    ...(d.regulatory ? { regulatory_attested: true } : {}),
    ...(d.criticality ? { criticality_attested: true } : {}),
    gaps: (v.census?.gaps ?? []).map((g) => ({
      gap_id: g.gap_id,
      disposition: (d.gaps[g.gap_id] ?? g.suggested) as never,
    })),
  };
}

function c4Of(v: OnboardingSummaryView, d: Draft): NonNullable<SignOffBody['c4']> {
  return {
    controls_report_hash: v.controls?.report_hash as never,
    attestations: {
      bypass_has_no_factory_app: true,
      app_scope_selected: true,
      github_token_readonly: true,
      actions_cannot_approve_prs: true,
      fork_pr_approval_required: true,
      secret_scanning: d.secretScanning as 'on',
      plan: d.plan as RepoPlan,
      ...(v.controls?.operations_md ? { operations_md: true } : {}),
    },
    role_map: d.roleMap as never,
    two_person_enabled: d.twoPerson,
    gating_profile: d.gating as never,
    kill_delegations: [],
    // releases through the factory start off (merged is done); a project turns them on later in Settings
    release: { mode: 'off' },
  };
}

export function OnboardRecord({
  id,
  me,
  pollMs = POLL_MS,
}: {
  id: string;
  me: Me;
  pollMs?: number;
}) {
  const csrf = me.csrf_token;
  const who = me.principal.principal_id;
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['onboard-summary', id],
    queryFn: () => onboardApi.summary(id),
    refetchInterval: (x) =>
      x.state.data && ['done', 'closed'].includes(x.state.data.sign_off.state) ? false : pollMs,
  });
  if (q.isPending) return <p className="ui-help">Reading the onboarding…</p>;
  if (q.isError) {
    return (
      <EmptyState title="The onboarding could not be read">
        {describeError(q.error)}{' '}
        <button type="button" className="ui-btn ui-btn-sm" onClick={() => void q.refetch()}>
          Try again
        </button>
      </EmptyState>
    );
  }
  return (
    <Summary
      v={q.data}
      me={me}
      who={who}
      csrf={csrf}
      refresh={() => void qc.invalidateQueries({ queryKey: ['onboard-summary', id] })}
    />
  );
}

function Summary({
  v,
  me,
  who,
  csrf,
  refresh,
}: {
  v: OnboardingSummaryView;
  me: Me;
  who: string;
  csrf: string;
  refresh: () => void;
}) {
  const [tab, setTab] = useState('console');
  const [draft, setDraft] = useState<Draft>(() => initialDraft(v, who));
  const set = <K extends keyof Draft>(k: K, x: Draft[K]) => setDraft((d) => ({ ...d, [k]: x }));
  const problems = useMemo(() => problemsOf(v, draft), [v, draft]);
  const step = stepOf(v);
  const so = v.sign_off;
  const status = lookupTerm('onboarding', v.status);

  return (
    <>
      <PageHeader
        title={`Onboarding of ${v.repo}`}
        crumbs={[
          { label: 'Projects', to: '/projects' },
          { label: v.project_id, to: `/projects/${v.project_id}` },
          { label: 'Onboarding' },
        ]}
        renderLink={(to, l) => <Link to={to}>{l}</Link>}
        meta={`${label('level', v.requested_level)} · ${label('level', v.requested_level) === label('level', v.signable_level) ? 'can be signed at this level' : `can be signed at ${label('level', v.signable_level)}`}`}
        status={
          <span data-testid="onboarding-status" data-status={v.status}>
            <Pill tone={SIGN_TONE[so.state]}>{status?.label ?? 'Unknown'}</Pill>
          </span>
        }
      />
      <Stepper label="Onboarding steps" steps={ONBOARD_STEPS(step)} />
      <Tabs
        label="Onboarding"
        tabs={[
          { id: 'console', label: 'Console' },
          { id: 'summary', label: 'Summary and sign-off' },
        ]}
        selected={tab}
        onSelect={setTab}
      >
        {tab === 'console' ? <ConsoleTab v={v} csrf={csrf} /> : null}
        {tab === 'summary' ? (
          <div className="ui-split ob-split">
            <div className="ob-main">
              <Blockers id={v.s0_id} />
              <AgentWorks v={v} csrf={csrf} />
              <Fixes v={v} />
              <PersonMust v={v} refresh={refresh} />
              <Owners v={v} d={draft} set={set} />
              <GitHub v={v} d={draft} set={set} />
              <People v={v} d={draft} set={set} />
              <Readiness v={v} />
              <OtherApprovals v={v} />
            </div>
            <div className="ob-rail">
              <SignOff
                v={v}
                me={me}
                who={who}
                csrf={csrf}
                draft={draft}
                problems={problems}
                refresh={refresh}
              />
              <div className="ui-card ob-assist">
                <OnboardingAssistant
                  s0Id={v.s0_id}
                  projectId={v.project_id}
                  repo={v.repo}
                  csrf={csrf}
                  who={me.principal.display_name}
                />
              </div>
            </div>
          </div>
        ) : null}
      </Tabs>
    </>
  );
}

// ---------------------------------------------------------------- 2. the agent works

function AgentWorks({ v, csrf }: { v: OnboardingSummaryView; csrf: string }) {
  const again = useMutation({ mutationFn: () => onboardApi.runAgent(v.s0_id, csrf) });
  return (
    <Card
      title="What the onboarding agent did"
      actions={
        v.agent ? (
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            onClick={() => again.mutate()}
            disabled={again.isPending}
          >
            Ask the agent again
          </button>
        ) : null
      }
      testId="agent-works"
    >
      <ol className="ob-check" aria-label="Checklist">
        {v.steps.map((s) => (
          <li key={s.step} data-step={s.step} data-state={s.state}>
            <Pill
              tone={
                s.state === 'done'
                  ? 'ok'
                  : s.state === 'blocked'
                    ? 'bad'
                    : s.state === 'skip'
                      ? 'mute'
                      : s.state === 'card'
                        ? 'warn'
                        : 'agent'
              }
            >
              {s.state === 'done'
                ? 'Done'
                : s.state === 'skip'
                  ? 'Not needed'
                  : s.state === 'blocked'
                    ? 'Blocked'
                    : s.state === 'card'
                      ? 'Needs your review'
                      : s.state === 'running'
                        ? 'Working'
                        : 'Not started'}
            </Pill>{' '}
            {STEP_TEXT[s.step] ?? 'A step'}
          </li>
        ))}
      </ol>
      {v.waiting ? <p className="ui-help">Waiting: {v.waiting}</p> : null}
      {v.agent ? (
        <>
          <p data-testid="agent-summary">{v.agent.summary}</p>
          <ul className="ob-list" aria-label="What it learned">
            {v.agent.learned.map((l) => (
              <li key={l.topic}>
                <strong>{termOr('onboardingTopic', l.topic)}</strong>{' '}
                <Pill tone={l.status === 'ok' ? 'ok' : l.status === 'needs_fix' ? 'warn' : 'mute'}>
                  {termOr('learnedStatus', l.status)}
                </Pill>
                <span className="ob-text">{l.text}</span>
                {l.evidence.length > 0 ? (
                  <span className="ui-help">Evidence: {l.evidence.join(', ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
          {v.agent.claims.length > 0 ? (
            <>
              <h3 className="ob-h3">Repo facts it claims</h3>
              <ul className="ob-list" aria-label="Repo facts">
                {v.agent.claims.map((c) => (
                  <li key={c.claim_id}>
                    <span className="ob-text">{c.text}</span>
                    <span className="ui-help">Evidence: {c.evidence.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {v.agent.questions.length > 0 ? (
            <>
              <h3 className="ob-h3">Its questions</h3>
              <ul className="ob-list">
                {v.agent.questions.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
              <p className="ui-help">Answer them in the onboarding assistant beside this page.</p>
            </>
          ) : null}
          {v.agent.dropped > 0 ? (
            <p className="ui-help">
              {v.agent.dropped} proposed file(s) were left out: the factory writes only the files a
              fix of that kind may write, never a secret, never over a file the repo has.
            </p>
          ) : null}
        </>
      ) : (
        <p className="ui-help" data-testid="agent-working">
          The agent is reading the repo. This page updates by itself.
        </p>
      )}
      {again.isError ? (
        <p className="ui-help ui-help-bad" role="alert">
          {describeError(again.error)}
        </p>
      ) : null}
    </Card>
  );
}

function Fixes({ v }: { v: OnboardingSummaryView }) {
  if (!v.agent) return null;
  return (
    <Card title="Proposed fixes (PRs)" testId="fixes">
      {v.fixes.length === 0 ? (
        <p className="ui-help">Nothing needs a fix PR.</p>
      ) : (
        <ul className="ob-list" aria-label="Proposed fixes">
          {v.fixes.map((f) => (
            <li key={f.fix_id} data-fix={f.fix_kind} data-state={f.state}>
              <strong>{f.title}</strong>{' '}
              <Pill tone={FIX_TONE[f.state]}>{termOr('fixState', f.state)}</Pill>
              <span className="ob-text">{f.why}</span>
              {f.paths.length > 0 ? (
                <span className="ui-help">Files: {f.paths.join(', ')}</span>
              ) : null}
              {f.pr ? (
                <span className="ob-text">
                  <a href={f.pr.url ?? '#'} rel="noreferrer" target="_blank">
                    Pull request #{f.pr.number} on GitHub
                  </a>{' '}
                  <span className="ui-help">A person reviews and merges it there.</span>
                </span>
              ) : f.state === 'awaiting_approval' ? (
                f.approval ? (
                  <span className="ob-text">
                    {f.approval.may_decide ? (
                      <Link to={`/decide/${f.approval.card_id}`}>Approve opening this PR</Link>
                    ) : (
                      'The exceptions approver approves opening it.'
                    )}
                  </span>
                ) : (
                  <span className="ui-help">
                    Opens once someone may approve exceptions: set it in &ldquo;Who decides
                    what&rdquo;, then sign off.
                  </span>
                )
              ) : null}
              {f.manual_steps.length > 0 ? (
                <ol className="ob-steps" aria-label={`Steps for ${f.title}`}>
                  {f.manual_steps.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="ui-help">The factory never merges a PR.</p>
    </Card>
  );
}

function PersonMust({ v, refresh }: { v: OnboardingSummaryView; refresh: () => void }) {
  const rows = (v.controls?.rows ?? []).filter((r) => r.status !== 'met' && r.instruction);
  if (!v.controls) return null;
  return (
    <Card
      title="What only a person can do on GitHub"
      actions={
        <button type="button" className="ui-btn ui-btn-sm" onClick={refresh}>
          Re-check
        </button>
      }
      testId="person-must"
    >
      {rows.length === 0 ? (
        <p className="ui-help">Nothing: GitHub is set up the way agents need.</p>
      ) : (
        <ul className="ob-list">
          {rows.map((r) => (
            <li key={r.id} data-control={r.id} data-status={r.status}>
              <strong>{termOr('control', r.id)}</strong>{' '}
              {r.blocking ? <Pill tone="bad">Must be fixed first</Pill> : null}
              <span className="ob-text">{r.instruction}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- 3. the summary, adjustable in place

type SetDraft = <K extends keyof Draft>(k: K, x: Draft[K]) => void;

function Check({
  checked,
  onChange,
  children,
  testId,
}: {
  checked: boolean;
  onChange: (x: boolean) => void;
  children: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <div className="ob-check-row">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        {...(testId ? { 'data-testid': testId } : {})}
      />
      <label htmlFor={id}>{children}</label>
    </div>
  );
}

function Owners({ v, d, set }: { v: OnboardingSummaryView; d: Draft; set: SetDraft }) {
  const id = useId();
  if (!v.census) return null;
  const floor = v.census.tier_floor;
  return (
    <Card title="Owners and risk" testId="owners-risk">
      <KeyValue
        rows={[
          ['Scan result', termOr('posture', v.census.posture)],
          ['Lowest risk allowed', label('tier', floor)],
          ['Commit read', <code key="c">{v.census.baseline_sha.slice(0, 7)}</code>],
        ]}
      />
      <label className="ui-label" htmlFor={`${id}-tier`}>
        Risk
      </label>
      <select
        id={`${id}-tier`}
        className="ui-select"
        value={d.tier}
        onChange={(e) => set('tier', e.target.value as Tier)}
      >
        {TIERS.filter((t) => TIER_RANK[t] >= TIER_RANK[floor]).map((t) => (
          <option key={t} value={t}>
            {label('tier', t)}
          </option>
        ))}
      </select>
      {v.role_map?.m4_by_tier?.[d.tier]?.state === 'infeasible' ? (
        <p className="ui-help" role="alert" data-testid="tier-infeasible">
          At {label('tier', d.tier)} the scorecard could not be signed by the people named for it:{' '}
          {v.role_map.m4_by_tier[d.tier]?.reason}. The risk only ever goes up, so name more people
          below, or keep a lower risk if the repo allows it.
        </p>
      ) : null}
      {d.tier === 'T0' && v.census.t0_required ? (
        <Check checked={d.t0} onChange={(x) => set('t0', x)}>
          I confirm: no production use, no real data, no dependants
        </Check>
      ) : null}
      {v.census.attest.includes('regulatory') ? (
        <Check checked={d.regulatory} onChange={(x) => set('regulatory', x)}>
          I confirm the repo has no regulatory obligation
        </Check>
      ) : null}
      {v.census.attest.includes('criticality') ? (
        <Check checked={d.criticality} onChange={(x) => set('criticality', x)}>
          I confirm how critical the repo is
        </Check>
      ) : null}
      <h3 className="ob-h3">Gaps ({v.census.gaps.length})</h3>
      {v.census.gaps.length === 0 ? (
        <p className="ui-help">No gaps for this level.</p>
      ) : (
        <ul className="ob-list" aria-label="Gaps">
          {v.census.gaps.map((g) => (
            <li key={g.gap_id} data-gap={g.gap_id}>
              <label className="ui-label" htmlFor={`${id}-g-${g.gap_id}`}>
                {termOr('lightFloor', g.criterion) === 'Unknown'
                  ? `Gap ${g.gap_id.slice(0, 8)}`
                  : termOr('lightFloor', g.criterion)}{' '}
                {g.severity === 'blocking' ? '(blocks this level)' : ''}
              </label>
              <select
                id={`${id}-g-${g.gap_id}`}
                className="ui-select"
                value={d.gaps[g.gap_id] ?? g.suggested}
                onChange={(e) => set('gaps', { ...d.gaps, [g.gap_id]: e.target.value })}
              >
                {g.allowed.map((a) => (
                  <option key={a} value={a}>
                    {termOr('gapDisposition', a)}
                  </option>
                ))}
              </select>
              {g.why ? <span className="ui-help">The agent suggests: {g.why}</span> : null}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function GitHub({ v, d, set }: { v: OnboardingSummaryView; d: Draft; set: SetDraft }) {
  const id = useId();
  if (!v.controls) return null;
  return (
    <Card title="GitHub protection and the App" testId="github">
      <p className="ui-help">The factory cannot read these settings; confirm each one on GitHub.</p>
      {ATTEST.map(([k, text]) => (
        <Check
          key={k}
          checked={d.attest[k] ?? false}
          onChange={(x) => set('attest', { ...d.attest, [k]: x })}
        >
          {text}
        </Check>
      ))}
      {v.controls.operations_md ? (
        <Check checked={d.operationsMd} onChange={(x) => set('operationsMd', x)}>
          operations.md says how this project is run
        </Check>
      ) : null}
      <label className="ui-label" htmlFor={`${id}-scan`}>
        Secret scanning
      </label>
      <select
        id={`${id}-scan`}
        className="ui-select"
        value={d.secretScanning}
        onChange={(e) => set('secretScanning', e.target.value as Draft['secretScanning'])}
      >
        <option value="">Choose…</option>
        <option value="on">On, with push protection</option>
        <option value="plan_unavailable">Not available on this plan</option>
      </select>
      <label className="ui-label" htmlFor={`${id}-plan`}>
        GitHub plan
      </label>
      <select
        id={`${id}-plan`}
        className="ui-select"
        value={d.plan}
        onChange={(e) => set('plan', e.target.value as Draft['plan'])}
      >
        <option value="">Choose…</option>
        {RepoPlan.options.map((p) => (
          <option key={p} value={p}>
            {p === 'unknown' ? 'I do not know' : p[0]?.toUpperCase() + p.slice(1)}
          </option>
        ))}
      </select>
    </Card>
  );
}

const idsOf = (t: string): string[] => [
  ...new Set(
    t
      .split(/[\s,]+/)
      .map((x) => x.trim())
      .filter(Boolean),
  ),
];

function SlotField({
  slot,
  value,
  onChange,
}: {
  slot: RoleSlot;
  value: RoleMap[RoleSlot];
  onChange: (v: RoleMap[RoleSlot]) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value.kind === 'principals' ? value.principals.join(', ') : '');
  const owners = value.kind === 'codeowners';
  return (
    <div className="ob-slot" data-slot={slot}>
      <label className="ui-label" htmlFor={id}>
        {label('roleSlot', slot)}
      </label>
      <input
        id={id}
        className="ui-input"
        value={text}
        disabled={owners}
        aria-describedby={`${id}-d`}
        onChange={(e) => {
          setText(e.target.value);
          onChange({ kind: 'principals', principals: idsOf(e.target.value) as never });
        }}
      />
      <p className="ui-help" id={`${id}-d`}>
        {explain('roleSlot', slot)}
      </p>
      {slot === 'g4' ? (
        <Check
          checked={owners}
          onChange={(x) =>
            onChange(
              x ? { kind: 'codeowners' } : { kind: 'principals', principals: idsOf(text) as never },
            )
          }
        >
          The code owners on GitHub review merges
        </Check>
      ) : null}
    </div>
  );
}

function People({ v, d, set }: { v: OnboardingSummaryView; d: Draft; set: SetDraft }) {
  const tier = d.tier;
  return (
    <Card title="Who decides what" testId="who-decides">
      <p className="ui-help">
        Proposed from CODEOWNERS and the repo&rsquo;s collaborators; people are named by their
        factory id, comma separated. It comes into force when you sign off.
        {v.role_map && v.role_map.unmapped_logins.length > 0
          ? ` These GitHub logins have no person in the factory yet: ${v.role_map.unmapped_logins.join(', ')}.`
          : ''}
      </p>
      <div className="ob-row">
        {RoleSlotValues.map((sl) => (
          <SlotField
            key={sl}
            slot={sl}
            value={d.roleMap[sl]}
            onChange={(x) => set('roleMap', { ...d.roleMap, [sl]: x })}
          />
        ))}
      </div>
      <Check checked={d.twoPerson || tier === 'T2'} onChange={(x) => set('twoPerson', x)}>
        Approvals that can need two people need two people here
      </Check>
      <h3 className="ob-h3">Which approvals are on</h3>
      {ProjectToggleGroupValues.map((g) => (
        <Check
          key={g}
          checked={d.gating.gates[g] === 'on'}
          onChange={(x) =>
            set('gating', { ...d.gating, gates: { ...d.gating.gates, [g]: x ? 'on' : 'off' } })
          }
        >
          {label('toggleGroup', g)}
        </Check>
      ))}
      <p className="ui-help">Off means the approval is not asked for, never that it is approved.</p>
      <p className="ui-help">
        Releases through the factory start off: a merged change is done. Turn them on later in the
        project&rsquo;s settings.
      </p>
    </Card>
  );
}

function Readiness({ v }: { v: OnboardingSummaryView }) {
  const prr = v.readiness.prr;
  return (
    <Card title="Readiness it will sign" testId="readiness">
      <KeyValue
        rows={[
          ['Level', label('level', v.readiness.level)],
          [
            'Readiness scorecard',
            prr ? `Readiness ${String(prr.composite)} of 4` : 'Built when the last step opens',
          ],
          ...(prr
            ? ([
                [
                  'Pillars',
                  prr.pillars
                    .map((p) => `${termOr('pillar', p.pillar)} ${String(p.level)}`)
                    .join(', '),
                ],
                [
                  'Tracks agents may then use',
                  prr.lanes.length === 0
                    ? 'None'
                    : prr.lanes.map((l) => termOr('lane', l)).join(', '),
                ],
              ] as const)
            : []),
        ]}
      />
    </Card>
  );
}

function OtherApprovals({ v }: { v: OnboardingSummaryView }) {
  const other = v.cards.filter((c) => !c.by_sign_off && c.live);
  if (other.length === 0) return null;
  return (
    <Card title="Other approvals this needs">
      <ul className="ob-list">
        {other.map((c) => (
          <li key={c.card_id}>
            <Link to={`/decide/${c.card_id}`}>{termOr('card', c.card)}</Link>{' '}
            <span className="ui-help">Decided by its own approver.</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ---------------------------------------------------------------- 4. sign off

function SignOff({
  v,
  me,
  who,
  csrf,
  draft,
  problems,
  refresh,
}: {
  v: OnboardingSummaryView;
  me: Me;
  who: string;
  csrf: string;
  draft: Draft;
  problems: readonly string[];
  refresh: () => void;
}) {
  const so = v.sign_off;
  const admin = me.actions.fleet.includes('project.delete');
  const [reason, setReason] = useState('');
  const [last, setLast] = useState<SignOffResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const stepUp = useStepUp(so.step_up?.bound_hash ?? null, csrf);
  const reasonId = useId();
  const mine = so.started_by === who;
  const override = !so.may_sign && admin && reason.trim().length > 0 ? reason.trim() : undefined;

  const send = async (body: SignOffBody) => {
    setBusy(true);
    setError(null);
    try {
      setLast(await onboardApi.signOff(v.s0_id, body, csrf, override));
      refresh();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  // continue the sign-off while the factory opens the next step (each call is this person's own request)
  const inflight = useRef(false);
  useEffect(() => {
    if (!mine || so.state !== 'in_progress' || busy || inflight.current) return;
    inflight.current = true;
    void send({}).finally(() => {
      inflight.current = false;
    });
  }, [v, mine, so.state]);
  // back from confirming it's you: send the proof once
  useEffect(() => {
    if (!mine || so.state !== 'needs_step_up' || !stepUp.proof || !so.step_up || busy) return;
    const proof = stepUp.proof;
    stepUp.clear();
    void send({ step_up: { proof, bound_hash: so.step_up.bound_hash } });
  }, [stepUp.proof, so.state, mine]);

  const canStart =
    (so.state === 'ready' || (so.state === 'waiting' && mine)) &&
    (so.may_sign || override !== undefined) &&
    problems.length === 0;
  return (
    <Card title="Sign off" testId="sign-off">
      <p>
        <span data-testid="sign-off-state" data-state={so.state}>
          <Pill tone={SIGN_TONE[so.state]}>{termOr('signOffState', so.state)}</Pill>
        </span>
      </p>
      {so.note ? <p className="ui-help">{so.note}</p> : null}
      {so.state === 'ready' || so.state === 'not_ready' || (so.state === 'waiting' && mine) ? (
        <>
          <p className="ui-help">
            One sign-off decides every step of this onboarding as you, each recorded in the decision
            log. The readiness scorecard asks you to confirm it&rsquo;s you.
          </p>
          {problems.length > 0 && so.state === 'ready' ? (
            <ul className="ob-list" aria-label="Still to do before you sign">
              {problems.map((p) => (
                <li key={p} className="ui-help">
                  {p}
                </li>
              ))}
            </ul>
          ) : null}
          {!so.may_sign ? (
            admin ? (
              <>
                <label className="ui-label" htmlFor={reasonId}>
                  Sign off as factory admin: your reason
                </label>
                <textarea
                  id={reasonId}
                  className="ui-input"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  rows={2}
                />
                <p className="ui-help">
                  You are signing outside the normal rules. Your name and reason are recorded.
                </p>
              </>
            ) : (
              <p className="ui-help" data-testid="may-not-sign">
                Only the person onboarding this repo, or the project&rsquo;s admin, can sign off.
              </p>
            )
          ) : null}
          <button
            type="button"
            className="ui-btn ui-btn-primary ui-btn-block"
            disabled={!canStart || busy}
            onClick={() => void send(bodyOf(v, draft, who))}
          >
            {busy ? 'Signing…' : so.state === 'waiting' ? 'Sign again' : 'Sign off'}
          </button>
        </>
      ) : null}
      {so.state === 'needs_step_up' && mine ? (
        <>
          <p className="ui-help">
            Sign in again at your identity provider for this sign-off only. You come back here and
            the sign-off goes on.
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-primary ui-btn-block"
            disabled={stepUp.busy || busy}
            onClick={() => void stepUp.confirm()}
          >
            Confirm it&rsquo;s you
          </button>
          {stepUp.note ? <p className="ui-help">{stepUp.note}</p> : null}
        </>
      ) : null}
      {so.state === 'in_progress' && !mine && so.started_by ? (
        <p className="ui-help">Someone else is signing this onboarding.</p>
      ) : null}
      {so.state === 'done' ? (
        <p>
          <Link to={`/projects/${v.project_id}`}>Open the project</Link>
        </p>
      ) : null}
      {last && last.decided.length > 0 ? (
        <ul className="ob-list" aria-label="Recorded just now" data-testid="receipt">
          {last.decided.map((x) => (
            <li key={x.card_id}>
              {x.card === 'M1' ? 'Who decides what, in force' : termOr('card', x.card)}: recorded in
              the decision log{x.ledger_seqs.length > 0 ? ` (#${x.ledger_seqs.join(', #')})` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {error || stepUp.error ? (
        <p className="ui-help ui-help-bad" role="alert">
          {describeError(error ?? stepUp.error)}
        </p>
      ) : null}
    </Card>
  );
}
