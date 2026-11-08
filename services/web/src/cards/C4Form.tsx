import { useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_GATING_PROFILE,
  GATES,
  LaneValues,
  ProjectToggleGroupValues,
  RepoPlan,
  ROLE_CATALOGUE,
  RoleSlotValues,
  T2_GATING_FLOOR,
  gatingFloorViolations,
  type ControlsReport,
  type GatingProfile,
  type KillDelegation,
  type ProjectToggleGroup,
  type RoleSlot,
  type Tier,
} from '@aisdlc/contracts';
import { useMemo, useState } from 'react';
import { api, type CardDetailWire } from '../api';
import { Badge } from '../components/Badge';
import { ErrorNote } from '../components/Notice';
import { DecideShell } from './DecideShell';
import { Check, DecidersLine, Hash, PRINCIPAL_RE, Section, TextField, ids } from './shared';

// Card 4 as the person meets it (OB §1A, §5.5, §6.2 row 0.4): the controls report with each control
// met, not met or unknown (unknown is never met), the attestations for the settings only
// Administration can read, in the words of OB §5.5, the role map for the ten slots, the two-person
// setting (locked on at T2), the gating profile inside the T2 floor, kill delegations, and the
// re-check button. The factory fixes nothing on GitHub; the person does, and re-checks.

/** The sentences of OB §5.5 ("Settings that only Administration can read are human-attested"). */
export const ATTESTATION_TEXT = {
  bypass_has_no_factory_app: 'the bypass list has no factory App',
  app_scope_selected: 'the factory App is installed on selected repositories only (App scope)',
  github_token_readonly: 'the default GITHUB_TOKEN is read-only',
  actions_cannot_approve_prs: '“Actions may create/approve PRs” is off',
  fork_pr_approval_required: 'fork-PR approval is required',
  operations_md: 'operations.md is in place and describes how this project is run',
} as const;
export const SECRET_SCANNING_TEXT = {
  on: 'secret scanning and push protection are on where the plan allows',
  plan_unavailable: 'secret scanning is not available on this repository’s plan',
} as const;

/** The plan question (OB §5.5, §9.1 row 2): the App cannot read the plan, so the owner states it. */
export const PLAN_QUESTION = 'Which GitHub plan is the owner of this repository on?';
export const PLAN_TEXT: Readonly<Record<RepoPlan, string>> = {
  free: 'Free',
  pro: 'Pro',
  team: 'Team',
  enterprise: 'Enterprise',
  unknown: 'I do not know (the plan stays unattested)',
};
export const PLAN_FREE_NOTE =
  'A private repository on the Free plan cannot enforce rulesets (protect-main), so the factory could not write to it. A read-only Census can still be signed.';

type AttestKey = keyof typeof ATTESTATION_TEXT;

interface RoleSlotValue {
  kind: 'principals' | 'codeowners';
  principals?: string[];
}
type RoleMapWire = Record<RoleSlot, RoleSlotValue>;

interface C4View {
  reduced: boolean;
  controls_report: ControlsReport;
  instructions: Array<{ control: string; status: string; text: string }>;
  can_decide: boolean;
  attestations: { required: string[]; secret_scanning_values: string[] };
  tier: Tier;
  role_map: {
    proposed: RoleMapWire;
    basis: {
      codeowners_read: string;
      collaborators_read: string;
      unmapped_logins: string[];
      fallback_admin_used: boolean;
    };
    current: RoleMapWire | null;
  };
  two_person: {
    locked_on: boolean;
    current: { enabled: boolean } | null;
    default: { enabled: boolean };
  };
  gating_profile: {
    current: GatingProfile | null;
    t2_floor_applies: boolean;
    project_deploys: boolean | null;
  };
  kill_delegations: { current: KillDelegation[] };
}

const CONTROL_NAME: Readonly<Record<string, string>> = {
  B4a: 'App permissions (no administration, workflows or statuses)',
  B4b: 'Required checks pinned to the factory App',
  B4c: 'Other App permission findings',
  protect_main: 'protect-main on the default branch',
  app_scope: 'App installation scope',
  codeowners: 'CODEOWNERS',
  instructions: 'Instruction files (AGENTS.md, CLAUDE.md)',
};
const STATUS_TEXT = {
  met: { label: 'Met', tone: 'good' },
  not_met: { label: 'Not met', tone: 'bad' },
  unknown: { label: 'Unknown (counts as not met)', tone: 'attention' },
  recorded: { label: 'Recorded', tone: 'neutral' },
} as const;

const slotDescription = (slot: RoleSlot): string =>
  ROLE_CATALOGUE.find((r) => r.slot === slot)?.description ?? slot;
const groupTitle = (g: ProjectToggleGroup): string =>
  Object.values(GATES)
    .filter((x) => x.projectToggle === g)
    .map((x) => x.title)
    .join(', ') || g;

const liveDelegations = (xs: KillDelegation[]) => xs.filter((d) => d.revoked_at === null);

export function C4Form({ card, csrf, me }: { card: CardDetailWire; csrf: string; me: string }) {
  const v = card.view as unknown as C4View;
  const qc = useQueryClient();
  const report = v.controls_report;
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<unknown>(null);

  const [attest, setAttest] = useState<Record<AttestKey, boolean>>({
    bypass_has_no_factory_app: false,
    app_scope_selected: false,
    github_token_readonly: false,
    actions_cannot_approve_prs: false,
    fork_pr_approval_required: false,
    operations_md: false,
  });
  const [plan, setPlan] = useState<RepoPlan | ''>('');
  const [scanning, setScanning] = useState<'on' | 'plan_unavailable' | ''>('');

  const startMap = v.role_map.current ?? v.role_map.proposed;
  const [slots, setSlots] = useState<Record<RoleSlot, string>>(
    () =>
      Object.fromEntries(
        RoleSlotValues.map((s) => {
          const val = startMap[s];
          return [s, val.kind === 'principals' ? (val.principals ?? []).join(', ') : ''];
        }),
      ) as Record<RoleSlot, string>,
  );
  const [g4Owners, setG4Owners] = useState(startMap.g4.kind === 'codeowners');

  const t2 = v.tier === 'T2';
  const [twoPerson, setTwoPerson] = useState(
    t2 ? true : (v.two_person.current?.enabled ?? v.two_person.default.enabled),
  );
  const [profile, setProfile] = useState<GatingProfile>(
    v.gating_profile.current ?? DEFAULT_GATING_PROFILE,
  );
  const [kills, setKills] = useState<
    Array<{ delegate: string; kind: 'project' | 'lane'; lane: string }>
  >(() =>
    liveDelegations(v.kill_delegations.current).map((d) => ({
      delegate: d.delegate,
      kind: d.scope.kind === 'lane' ? 'lane' : 'project',
      lane: d.scope.kind === 'lane' ? (d.scope.ref.split('/')[1] ?? 'L4') : 'L4',
    })),
  );
  const project = card.summary.project_id;

  const needsOps = v.attestations.required.includes('operations_md');
  const floorLocked = (g: ProjectToggleGroup): boolean =>
    t2 &&
    ((T2_GATING_FLOOR.groups as readonly string[]).includes(g) ||
      (g === T2_GATING_FLOOR.deployGroup && v.gating_profile.project_deploys !== false));

  const roleMap = useMemo(
    () =>
      Object.fromEntries(
        RoleSlotValues.map((s) => [
          s,
          s === 'g4' && g4Owners
            ? { kind: 'codeowners' }
            : { kind: 'principals', principals: ids(slots[s]) },
        ]),
      ) as RoleMapWire,
    [slots, g4Owners],
  );

  const blocked = useMemo(() => {
    const out: string[] = [];
    if (report.blocking_open.length > 0) {
      out.push(
        `Blocking controls are not met (${report.blocking_open.join(', ')}). Fix them on GitHub, then re-check.`,
      );
    }
    for (const k of Object.keys(ATTESTATION_TEXT) as AttestKey[]) {
      if (k === 'operations_md' && !needsOps) continue;
      if (!attest[k]) out.push(`Attest: ${ATTESTATION_TEXT[k]}.`);
    }
    if (plan === '') out.push('Say which GitHub plan the owner is on (or that you do not know).');
    if (scanning === '') out.push('Say whether secret scanning and push protection are on.');
    for (const s of RoleSlotValues) {
      const val = roleMap[s];
      if (val.kind === 'principals' && (val.principals ?? []).some((p) => !PRINCIPAL_RE.test(p))) {
        out.push(`The ${s} slot has a person id that is not valid.`);
      }
    }
    for (const s of ['admin', 'm4'] as const) {
      const val = roleMap[s];
      if (val.kind !== 'principals' || (val.principals ?? []).length === 0) {
        out.push(`The ${s} slot needs at least one person.`);
      }
    }
    for (const k of kills) {
      if (!PRINCIPAL_RE.test(k.delegate.trim()))
        out.push('A kill delegation needs a valid person id.');
    }
    const floor = gatingFloorViolations(profile, {
      tier: v.tier,
      deploys: v.gating_profile.project_deploys,
    });
    out.push(...floor);
    return [...new Set(out)];
  }, [
    report,
    attest,
    plan,
    scanning,
    roleMap,
    kills,
    profile,
    needsOps,
    v.tier,
    v.gating_profile.project_deploys,
  ]);

  const content = {
    controls_report_hash: report.report_hash,
    attestations: {
      bypass_has_no_factory_app: attest.bypass_has_no_factory_app,
      app_scope_selected: attest.app_scope_selected,
      github_token_readonly: attest.github_token_readonly,
      actions_cannot_approve_prs: attest.actions_cannot_approve_prs,
      fork_pr_approval_required: attest.fork_pr_approval_required,
      secret_scanning: scanning,
      plan,
      ...(needsOps ? { operations_md: attest.operations_md } : {}),
    },
    role_map: roleMap,
    two_person_enabled: twoPerson,
    gating_profile: profile,
    kill_delegations: kills.map((k) => ({
      delegate: k.delegate.trim(),
      scope:
        k.kind === 'lane'
          ? { kind: 'lane', ref: `${project}/${k.lane}` }
          : { kind: 'project', ref: project },
    })),
  };

  async function recheck() {
    setChecking(true);
    setCheckError(null);
    try {
      await api.recheck(card.summary.card_id, csrf);
      await qc.invalidateQueries({ queryKey: ['card', card.summary.card_id] });
    } catch (e) {
      setCheckError(e);
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <p className="muted">
        Card 4 checks the repository&rsquo;s settings and asks you to confirm who can do what. The
        factory changes nothing on GitHub: where something is missing, you fix it there and press
        re-check.
        {v.reduced
          ? ' This is the reduced 0.4 of a Census onboarding: protect-main is recorded, not blocking.'
          : ''}
      </p>
      <DecidersLine who={card.deciders} names={card.principal_names} what="this card" />

      <Section title="Controls report" id="c4-controls">
        <p>
          Report <Hash value={report.report_hash} label="controls report hash" />
          {report.branch ? (
            <>
              {' '}
              on <code>{report.branch}</code>
              {report.head_sha ? (
                <>
                  {' '}
                  at <code>{report.head_sha.slice(0, 12)}</code>
                </>
              ) : null}
            </>
          ) : null}
          .
        </p>
        <table className="table" aria-label="Controls">
          <thead>
            <tr>
              <th scope="col">Control</th>
              <th scope="col">State</th>
              <th scope="col">Blocks signing</th>
              <th scope="col">What to do</th>
            </tr>
          </thead>
          <tbody>
            {report.controls.map((c) => {
              const st = STATUS_TEXT[c.status];
              return (
                <tr key={c.id} data-control={c.id} data-status={c.status}>
                  <th scope="row">{CONTROL_NAME[c.id] ?? c.id}</th>
                  <td>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </td>
                  <td>{c.blocking ? 'yes' : 'no'}</td>
                  <td>
                    {c.instruction ? (
                      <p>{c.instruction}</p>
                    ) : (
                      <span className="muted">nothing to do</span>
                    )}
                    {c.reasons.length > 0 ? <p className="muted">{c.reasons.join('; ')}</p> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {report.blocking_open.length > 0 ? (
          <p className="notice notice-attention">
            {report.blocking_open.length} blocking control
            {report.blocking_open.length === 1 ? ' is' : 's are'} open. This card cannot be approved
            until they are met.
          </p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn btn-quiet"
            onClick={() => void recheck()}
            disabled={checking || !card.may_decide}
          >
            Re-check
          </button>
          <span className="muted">
            Reads the settings from GitHub again. It changes nothing there.
          </span>
        </div>
        {checkError ? <ErrorNote error={checkError} /> : null}
      </Section>

      <Section title="What only you can attest" id="c4-attest">
        <p className="muted">
          GitHub does not show these to the factory. Tick each one only if you have checked it.
        </p>
        {(Object.keys(ATTESTATION_TEXT) as AttestKey[])
          .filter((k) => k !== 'operations_md' || needsOps)
          .map((k) => (
            <Check
              key={k}
              checked={attest[k]}
              onChange={(x) => setAttest((c) => ({ ...c, [k]: x }))}
            >
              {ATTESTATION_TEXT[k]}
            </Check>
          ))}
        <fieldset className="options">
          <legend>{PLAN_QUESTION}</legend>
          {RepoPlan.options.map((k) => (
            <label key={k} className="radio">
              <input
                type="radio"
                name="github-plan"
                value={k}
                checked={plan === k}
                onChange={() => setPlan(k)}
              />{' '}
              {PLAN_TEXT[k]}
            </label>
          ))}
          <p className="muted">
            GitHub does not tell the factory the plan, so it asks you. {PLAN_FREE_NOTE}
          </p>
        </fieldset>
        <fieldset className="options">
          <legend>Secret scanning</legend>
          {(['on', 'plan_unavailable'] as const).map((k) => (
            <label key={k} className="radio">
              <input
                type="radio"
                name="secret-scanning"
                value={k}
                checked={scanning === k}
                onChange={() => setScanning(k)}
              />{' '}
              {SECRET_SCANNING_TEXT[k]}
            </label>
          ))}
        </fieldset>
      </Section>

      <Section title="Who can do what" id="c4-roles">
        <p>
          Proposed from CODEOWNERS and the repository&rsquo;s collaborators
          {v.role_map.basis.fallback_admin_used
            ? '. No linked collaborator has admin rights, so you stand in as admin'
            : ''}
          . Name people by their person id, separated by commas. The admin and M4 slots need
          someone.
        </p>
        {v.role_map.basis.unmapped_logins.length > 0 ? (
          <p className="notice notice-attention">
            These GitHub logins have no person in the factory yet and were left out:{' '}
            {v.role_map.basis.unmapped_logins.join(', ')}.
          </p>
        ) : null}
        <div className="roles">
          {RoleSlotValues.map((s) => (
            <div key={s} className="role" data-slot={s}>
              {s === 'g4' ? (
                <Check
                  checked={g4Owners}
                  onChange={setG4Owners}
                  hint="Merge review is done by the code owners on GitHub."
                >
                  g4: the code owners on GitHub review merges
                </Check>
              ) : null}
              <TextField
                label={`${s}: ${slotDescription(s)}`}
                value={slots[s]}
                disabled={s === 'g4' && g4Owners}
                onChange={(x) => setSlots((c) => ({ ...c, [s]: x }))}
              />
            </div>
          ))}
        </div>
        <p className="muted">
          You, {me}, can put yourself in any slot. A slot with one person is decided by that person
          alone and the ledger says so.
        </p>
      </Section>

      <Section title="Two-person rule" id="c4-two">
        <Check
          checked={twoPerson}
          disabled={t2}
          onChange={setTwoPerson}
          hint={
            t2
              ? 'This project is T2, so the rule is locked on.'
              : 'Where a role has two or more people, a second person must agree.'
          }
        >
          Require a second person where a role has two or more people
        </Check>
      </Section>

      <Section title="Gating profile" id="c4-gating">
        <p className="muted">
          Which human gates stay on for this project.
          {t2
            ? ' At T2 the gates for design and plan stay on for lanes L4 to L6, and release stays on where the project deploys.'
            : ''}
        </p>
        <fieldset className="options">
          <legend>Gates</legend>
          {ProjectToggleGroupValues.map((g) => (
            <Check
              key={g}
              checked={profile.gates[g] === 'on'}
              disabled={floorLocked(g)}
              hint={floorLocked(g) ? 'Locked on by the T2 floor.' : undefined}
              onChange={(x) =>
                setProfile((p) => ({ ...p, gates: { ...p.gates, [g]: x ? 'on' : 'off' } }))
              }
            >
              {groupTitle(g)} ({g}) is on
            </Check>
          ))}
        </fieldset>
        <fieldset className="options">
          <legend>Schedule</legend>
          {(['auto', 'human'] as const).map((m) => (
            <label key={m} className="radio">
              <input
                type="radio"
                name="schedule"
                checked={profile.schedule === m}
                onChange={() => setProfile((p) => ({ ...p, schedule: m }))}
              />{' '}
              {m === 'auto' ? 'The factory schedules work itself' : 'A person schedules work'}
            </label>
          ))}
        </fieldset>
      </Section>

      <Section title="Kill delegations" id="c4-kill">
        <p className="muted">
          People who may stop this project or one lane. Leaving a person out revokes the delegation.
        </p>
        {kills.map((k, i) => (
          <div key={i} className="kill">
            <TextField
              label={`Delegation ${i + 1}: person id`}
              value={k.delegate}
              onChange={(x) =>
                setKills((c) => c.map((y, j) => (j === i ? { ...y, delegate: x } : y)))
              }
            />
            <div className="field">
              <label htmlFor={`kill-kind-${i}`}>Delegation {i + 1}: covers</label>
              <select
                id={`kill-kind-${i}`}
                value={k.kind}
                onChange={(e) =>
                  setKills((c) =>
                    c.map((y, j) =>
                      j === i ? { ...y, kind: e.target.value as 'project' | 'lane' } : y,
                    ),
                  )
                }
              >
                <option value="project">the whole project</option>
                <option value="lane">one lane</option>
              </select>
            </div>
            {k.kind === 'lane' ? (
              <div className="field">
                <label htmlFor={`kill-lane-${i}`}>Delegation {i + 1}: lane</label>
                <select
                  id={`kill-lane-${i}`}
                  value={k.lane}
                  onChange={(e) =>
                    setKills((c) => c.map((y, j) => (j === i ? { ...y, lane: e.target.value } : y)))
                  }
                >
                  {LaneValues.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setKills((c) => c.filter((_, j) => j !== i))}
            >
              Remove delegation {i + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setKills((c) => [...c, { delegate: '', kind: 'project', lane: 'L4' }])}
        >
          Add a kill delegation
        </button>
      </Section>

      <DecideShell
        card={card}
        csrf={csrf}
        content={content}
        blocked={blocked}
        approveLabel="Approve card 4"
      />
    </>
  );
}
