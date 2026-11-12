import type {
  AcceptanceSubject,
  EvidencePackSummary,
  MergeReviewSubject,
  MergeReviewUnitView,
  PullRequestLink,
  ReleaseSubject,
  StepStatusView,
} from '@aisdlc/contracts';
import type { GateContextWire } from '../api';
import { shortTime } from '../format';
import { StepStatusPill } from '../items/VerifyTab';
import { Link } from '../router';
import { Card, KeyValue, Pill, Table, type PillTone } from '../ui';

// The merge, release and acceptance gates on the decide screen (portal review §12 P1-3, P1-7; FL S8 8.1, S8b, S9 9.2):
// what G4, G5 and G6 decide, as core's gate context says it (the gate's own facts and the record around them). G4: the
// review mode and why, each PR with the Evidence Pack of exactly its head and its five steps, the diff by path with the
// sensitive and protected paths flagged, B13's rounds left. G5: what the release binds (merged commit to the pack's
// head to the target), the target now, the release evidence, gate-relay's deployment state. G6: the intent and its
// acceptance criteria against what merged. A fact the record does not have reads [unknown]: never a pass.

const short = (s: string | null | undefined, n = 12) => (s ? s.slice(0, n) : '[unknown]');

function PrLink({ pr }: { pr: PullRequestLink }) {
  return (
    <a href={pr.url} target="_blank" rel="noopener noreferrer" data-testid="pr-link">
      {pr.repo}#{pr.number}
    </a>
  );
}

function StepsLine({ steps }: { steps: readonly StepStatusView[] }) {
  if (steps.length === 0) return <span className="muted">[unknown]</span>;
  return (
    <ul className="plain s7-steps-line" aria-label="S7 steps of the head">
      {steps.map((s) => (
        <li key={s.step}>
          <code>{s.step}</code> <StepStatusPill status={s.status} />
        </li>
      ))}
    </ul>
  );
}

function PackFacts({ pack, item }: { pack: EvidencePackSummary | null; item: string }) {
  if (pack === null) {
    return (
      <p className="muted" data-testid="pack-missing">
        The Evidence Pack this binds is not in the record here: [unknown]. Do not decide on it.
      </p>
    );
  }
  return (
    <KeyValue
      label="Evidence Pack"
      rows={[
        ['Pack', <code key="p">{short(pack.pack_sha256, 16)}</code>],
        [
          'Signed',
          <span key="s">
            {pack.key_id} · {shortTime(pack.produced_at)}
          </span>,
        ],
        ['Head', <code key="h">{short(pack.head_sha)}</code>],
        [
          'Verdict',
          <Pill key="v" tone={pack.passing ? 'ok' : 'bad'}>
            {pack.passing ? 'passing' : `not passing (${pack.disposition.kind})`}
          </Pill>,
        ],
        [
          'Pack viewer',
          <Link key="l" to={`/items/${item}/evidence`}>
            Open the signed pack
          </Link>,
        ],
      ]}
    />
  );
}

// ---------------------------------------------------------------- G4

const REASON: Readonly<Record<string, string>> = {
  evidence_sufficient: 'every input is known and none asks for a codeowner',
  b14_unsure: 'the mode-E approver was unsure (B14)',
  sensitive_path: 'a changed path is sensitive or protected',
  paths_unknown: 'the changed paths are not in the record',
  codeowners_unreadable: 'CODEOWNERS could not be read',
  no_governing_prr: 'the repo has no governing readiness record',
  posture: 'the repo’s posture reviews every PR in mode C',
  autonomy_a0: 'the effective autonomy is A0',
  r3_zone: 'a changed path is in an area with a critical unknown (R3)',
  human_led: 'a person wrote the change',
  mode_e_suspended: 'mode E is suspended for the project (B19)',
};

function UnitDiff({ u }: { u: MergeReviewUnitView }) {
  if (u.paths === null) {
    return (
      <p className="muted" data-testid="paths-unknown">
        The changed paths of this head are not in the record: [unknown]. The review treats them as
        sensitive (mode C with the step-up).
      </p>
    );
  }
  return (
    <>
      <Table
        caption={`Changed paths of ${u.pr.repo}#${u.pr.number}`}
        rows={u.paths}
        rowKey={(p) => p.path}
        empty={<p className="muted">No changed paths.</p>}
        columns={[
          { key: 'path', header: 'Path', rowHeader: true, render: (p) => <code>{p.path}</code> },
          {
            key: 'flags',
            header: 'Flag',
            render: (p) => (
              <>
                {p.protected ? <Pill tone="bad">protected</Pill> : null}{' '}
                {p.sensitive ? <Pill tone="warn">sensitive</Pill> : null}
                {!p.protected && !p.sensitive ? <span className="muted">-</span> : null}
              </>
            ),
          },
        ]}
      />
      {u.paths_truncated ? <p className="s7-faint">The first 500 paths are shown.</p> : null}
    </>
  );
}

const STANDING: Readonly<Record<MergeReviewSubject['standing'], [string, PillTone]>> = {
  none: ['no G4', 'mute'],
  pending: ['open', 'gate'],
  approved: ['approved for these heads', 'ok'],
  changes_requested: ['changes requested', 'back'],
  rejected: ['rejected', 'bad'],
  ended: ['ended', 'mute'],
  head_moved: ['approved, but a PR head moved since', 'warn'],
};

export function MergeReviewMain({
  c,
  s,
  name,
}: {
  c: GateContextWire;
  s: MergeReviewSubject;
  name: (p: string) => string;
}) {
  const r = s.review;
  const [standing, tone] = STANDING[s.standing];
  const flagged = s.units.flatMap((u) => u.paths ?? []).filter((p) => p.protected || p.sensitive);
  return (
    <>
      <Card
        title="Review mode"
        actions={<Pill tone={r.mode === 'C' ? 'warn' : 'info'}>mode {r.mode}</Pill>}
        testId="review-mode"
      >
        <p>
          {r.mode === 'C'
            ? 'Mode C: a code owner of the changed paths reads the diff and decides.'
            : 'Mode E: an evidence approver decides on the Evidence Pack; 9.5 samples it later.'}
        </p>
        <ul className="s7-rules" aria-label="Why this mode">
          {r.reasons.map((x) => (
            <li key={x}>
              <code>{x}</code>: {REASON[x] ?? x}
            </li>
          ))}
        </ul>
        <KeyValue
          rows={[
            [
              'Who decides',
              r.deciders.basis === 'path_owners'
                ? `the code owners of the changed paths: ${r.deciders.principals.map(name).join(', ')}`
                : 'any holder of the g4 slot',
            ],
            [
              'CODEOWNERS',
              `${r.codeowners.read}${r.codeowners.at_sha ? ` at ${short(r.codeowners.at_sha, 7)} (the base)` : ''}${r.codeowners.unmapped.length > 0 ? ` · not mapped to a person: ${r.codeowners.unmapped.join(', ')}` : ''}`,
            ],
            [
              'Barred authors',
              r.authors.length > 0 ? r.authors.map(name).join(', ') : 'none besides the requester',
            ],
            ['Step-up', r.step_up ? 'required (D37): a sensitive path or unknown paths' : 'no'],
            [
              'This G4',
              <Pill key="st" tone={tone}>
                {standing}
              </Pill>,
            ],
            [
              'Changes requested (B13)',
              s.b13.limit === null
                ? `${s.b13.used} so far; no catalogue limit (the rework budget bounds it)`
                : `${s.b13.used} of ${s.b13.limit} rounds used · ${s.b13.left ?? 0} left${s.b13.exhausted_to ? `, then ${s.b13.exhausted_to}` : ''}`,
            ],
          ]}
        />
      </Card>
      {flagged.length > 0 ? (
        <p className="s7-banner s7-banner-bad" role="note" data-testid="sensitive-banner">
          <b>
            {flagged.length} sensitive or protected path{flagged.length === 1 ? '' : 's'}.
          </b>{' '}
          Read these first; deciding needs the step-up.
        </p>
      ) : null}
      {s.units.map((u) => (
        <Card
          key={u.unit_key}
          title={`Unit ${u.unit_key}`}
          actions={<PrLink pr={u.pr} />}
          testId={`unit-${u.unit_key}`}
        >
          <KeyValue
            rows={[
              ['Pull request', <PrLink key="pr" pr={u.pr} />],
              ['Branch', u.pr.head_ref ? <code key="b">{u.pr.head_ref}</code> : '[unknown]'],
              ['PR state', u.pr.state ?? '[unknown]'],
              ['Head', <code key="h">{short(u.head_sha)}</code>],
              ['Base', <code key="b2">{short(u.base_sha)}</code>],
              ['S7 steps', <StepsLine key="s" steps={u.steps} />],
            ]}
          />
          <PackFacts pack={u.pack} item={c.item_id} />
          {u.pack !== null && u.pack.head_sha !== u.head_sha ? (
            <p className="notice notice-bad" role="alert">
              The pack is for another head: G4 binds the pack of exactly the head.
            </p>
          ) : null}
          <UnitDiff u={u} />
        </Card>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- G5

const DEPLOY: Readonly<Record<ReleaseSubject['deployment']['state'], [string, PillTone]>> = {
  none: ['not consumed yet', 'mute'],
  intended: ['being released', 'info'],
  refused: ['refused by gate-relay', 'bad'],
  deployed: ['deployed, no verdict yet', 'info'],
  healthy: ['healthy', 'ok'],
  unhealthy: ['unhealthy: rolled back (B16)', 'bad'],
};

export function ReleaseMain({ c, s }: { c: GateContextWire; s: ReleaseSubject }) {
  const b = s.binding;
  const [dep, tone] = DEPLOY[s.deployment.state];
  const now = s.target_now;
  return (
    <>
      <Card title="What is released" testId="release-binding">
        {b === null ? (
          <p className="notice notice-bad" role="alert">
            The card carries no release binding: nothing is released whatever is decided.
          </p>
        ) : b.status === 'unbound' ? (
          <p className="notice notice-bad" role="alert" data-testid="unbound">
            Unbound (<code>{b.reason}</code>): gate-relay releases nothing for this card whatever is
            decided.
          </p>
        ) : (
          <KeyValue
            rows={[
              ['Deploy target', <code key="e">{b.environment}</code>],
              ['Merged commit', <code key="m">{short(b.merged_sha)}</code>],
              ['Pack head', <code key="h">{short(b.pack_head_sha)}</code>],
              ['Pull request', s.pr ? <PrLink key="pr" pr={s.pr} /> : `#${b.pr_number}`],
              ['Repository', b.repo],
            ]}
          />
        )}
        <p className="s7-faint">
          Target now:{' '}
          {now.state === 'unreadable'
            ? '[unknown]: the release setting cannot be read (unknown is not released)'
            : now.setting === null
              ? 'not chosen'
              : now.setting.mode === 'off'
                ? 'release off'
                : now.setting.environment}
        </p>
        {s.target_changed ? (
          <p className="notice notice-bad" role="alert" data-testid="target-changed">
            The project&rsquo;s release target changed since this card opened: gate-relay will
            refuse it (target_changed). A re-request opens G5 again.
          </p>
        ) : null}
      </Card>
      <Card title="Release evidence" testId="release-evidence">
        <PackFacts pack={s.pack} item={c.item_id} />
        <KeyValue rows={[['S7 steps of the head', <StepsLine key="s" steps={s.steps} />]]} />
      </Card>
      <Card
        title="gate-relay’s deployment"
        actions={<Pill tone={tone}>{dep}</Pill>}
        testId="deployment"
      >
        <KeyValue
          rows={[
            [
              'State',
              <span key="s" data-testid="deployment-state">
                {s.deployment.state}
              </span>,
            ],
            ...(s.deployment.refusal
              ? [['Refusal', <code key="r">{s.deployment.refusal}</code>] as const]
              : []),
            ...(s.deployment.marker
              ? [
                  [
                    'Deployment',
                    `#${s.deployment.marker.deployment_id} to ${s.deployment.marker.environment} · ${shortTime(s.deployment.marker.created_at)}`,
                  ] as const,
                ]
              : []),
          ]}
        />
        <p className="s7-faint">
          gate-relay creates the deployment once, through its own App, only for an approved G5 whose
          binding still holds. Core never deploys.
        </p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- G6

export function AcceptanceMain({ s, name }: { s: AcceptanceSubject; name: (p: string) => string }) {
  const i = s.intent;
  return (
    <>
      <Card title="What you asked for" testId="intent">
        {i === null ? (
          <p className="muted">No intent block is in the record for this item: [unknown].</p>
        ) : i.withheld ? (
          <p className="muted">The intent text needs data class D1.</p>
        ) : !i.intact ? (
          <p className="notice notice-bad" role="alert">
            The approved intent block is not intact in the store: do not decide on it.
          </p>
        ) : (
          <>
            <p className="s7-lead">{i.goal}</p>
            <p className="ui-eyebrow">Acceptance criteria</p>
            <ol data-testid="criteria">
              {i.acceptance_criteria.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ol>
            {i.non_goals.length > 0 ? (
              <>
                <p className="ui-eyebrow">Not part of it</p>
                <ul>
                  {i.non_goals.map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </>
            ) : null}
          </>
        )}
        {i !== null ? (
          <p className="s7-faint">
            intent <code>{short(i.sha256, 16)}</code> ·{' '}
            {i.bound_by ? 'approved at G0/G1' : 'not bound by an approved G0/G1'}
          </p>
        ) : null}
      </Card>
      <Card title="What merged" testId="merged">
        <KeyValue
          rows={[
            ['Merged commit', <code key="m">{short(s.acceptance?.merged_sha ?? null)}</code>],
            ['Requester', s.acceptance ? name(s.acceptance.requester) : '[unknown]'],
            [
              'Release',
              s.release === null
                ? 'nothing released (the project does not release)'
                : `${s.release.environment ?? '[unknown]'} · ${s.release.state}`,
            ],
          ]}
        />
        <Table
          caption="Pull requests of the item"
          rows={s.merged}
          rowKey={(m) => `${m.unit_key}-${m.pr.number}`}
          empty={<p className="muted">No pull request is in the record: [unknown].</p>}
          columns={[
            { key: 'pr', header: 'PR', rowHeader: true, render: (m) => <PrLink pr={m.pr} /> },
            { key: 'head', header: 'Head', render: (m) => <code>{short(m.head_sha, 7)}</code> },
            {
              key: 'pack',
              header: 'Evidence Pack',
              render: (m) =>
                m.pack ? <Pill tone="ok">passing</Pill> : <Pill tone="warn">[unknown]</Pill>,
            },
            { key: 'steps', header: 'S7 steps', render: (m) => <StepsLine steps={m.steps} /> },
          ]}
        />
        <p className="s7-faint">
          Compare each criterion with what merged: 7.3 is the spec conformance check of the head.
          Accept, or reject (B18: the item is done and a new linked item carries what is missing).
        </p>
      </Card>
    </>
  );
}
