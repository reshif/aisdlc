import {
  STEPS,
  type GateCheckRunsView,
  type ItemVerifyView,
  type VerifyFindingView,
  type VerifyStepView,
} from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import {
  ActorGlyph,
  Card,
  EmptyState,
  GateTag,
  KeyValue,
  Pill,
  Stat,
  Stats,
  Table,
  type PillTone,
} from '../ui';

// The Verify tab of the item page (PLAN M14.6, prototype `views-m14.js` verifyTab): the checks 7.1 to 7.5 of the Unit
// head with their facts and findings, the raised gate, the 7.6 Evidence Pack and gate-check's run on the PR. Every
// fact is the record's (the verify service's results by hash, the pack, gate-check's verdicts); a step with no result
// is "not run", unknown is unmet, and a gate-check that cannot be asked reads "unknown", never success.

const short = (sha: string | null, n = 7) => (sha === null ? '-' : sha.slice(0, n));

const STATUS: Readonly<Record<VerifyStepView['status'], { text: string; tone: PillTone }>> = {
  passed: { text: 'passed', tone: 'ok' },
  failed: { text: 'failed', tone: 'bad' },
  unknown: { text: 'unknown (unmet)', tone: 'warn' },
  raised: { text: 'raised', tone: 'gate' },
  not_run: { text: 'not run', tone: 'mute' },
};

/** A step's status as a pill (the gate cards show a head's five steps this way). */
export function StepStatusPill({ status }: { status: VerifyStepView['status'] }) {
  const st = STATUS[status];
  return <Pill tone={st.tone}>{st.text}</Pill>;
}

export function StepVerdict({ s }: { s: VerifyStepView }) {
  const st = STATUS[s.status];
  return (
    <span className="s7-verdict">
      <Pill tone={st.tone}>{st.text}</Pill>
      {s.raised?.kind === 'gate' ? <GateTag gate={s.raised.gate} /> : null}
      {s.raised?.kind === 'trigger' ? <GateTag gate="Q1" /> : null}
    </span>
  );
}

/** The facts a step's result carries, as a person reads them. */
export function stepFacts(s: VerifyStepView): Array<readonly [string, string]> {
  if (s.status === 'not_run') return [];
  const rows: Array<readonly [string, string]> = [];
  rows.push(['verdict', s.verdict ?? '-']);
  rows.push(['kits', `${s.kits.answered} of ${s.kits.total} answered`]);
  if (s.mutation) {
    const m = s.mutation;
    const score = m.total === 0 ? '-' : (m.killed / m.total).toFixed(2);
    rows.push([
      'mutation score',
      `${m.killed} of ${m.total} killed · ${score} (min ${m.min_score})${m.unknown > 0 ? ` · ${m.unknown} unknown` : ''}`,
    ]);
  }
  if (s.rules_version) rows.push(['secret rules', s.rules_version]);
  rows.push(['findings', `${s.findings.total} (${s.findings.failing} failing)`]);
  if (s.raised) {
    rows.push([
      'raised',
      s.raised.kind === 'gate'
        ? `${s.raised.gate}: ${s.raised.reason_code}`
        : `${s.raised.trigger} (Q1): ${s.raised.reason_code}`,
    ]);
  }
  return rows;
}

export function FindingsTable({
  step,
  items,
}: {
  step: string;
  items: readonly VerifyFindingView[];
}) {
  if (items.length === 0) return null;
  return (
    <Table
      caption={`Findings of ${step}`}
      columns={[
        { key: 'kind', header: 'Finding', rowHeader: true, render: (f) => <code>{f.kind}</code> },
        {
          key: 'sev',
          header: 'Severity',
          render: (f) => (
            <Pill
              tone={f.severity === 'critical' ? 'bad' : f.severity === 'high' ? 'warn' : 'neutral'}
            >
              {f.severity}
            </Pill>
          ),
        },
        { key: 'class', header: 'Class', render: (f) => <code>{f.repair_class}</code> },
        { key: 'rule', header: 'Rule', render: (f) => <code>{f.rule_id ?? '-'}</code> },
        {
          key: 'where',
          header: 'Where',
          render: (f) => (
            <code>
              {f.path ?? '-'}
              {f.line !== null ? `:${f.line}` : ''}
            </code>
          ),
        },
        {
          key: 'msg',
          header: 'Message',
          render: (f) =>
            f.withheld ? (
              <span className="muted" data-testid="withheld">
                hidden: needs a higher data class
              </span>
            ) : (
              <span>{f.message ?? ''}</span>
            ),
        },
      ]}
      rows={items}
      rowKey={(f) => `${f.kind}:${f.path ?? ''}:${f.line ?? ''}:${f.rule_id ?? ''}`}
    />
  );
}

function CheckRow({ s }: { s: VerifyStepView }) {
  const info = STEPS[s.step];
  const facts = stepFacts(s);
  return (
    <details
      className="s7-chk"
      open={s.status !== 'passed'}
      data-step={s.step}
      data-status={s.status}
    >
      <summary>
        <code>{s.step}</code>
        <b>{info.title}</b>
        <ActorGlyph actor={info.actor} />
        <span className="s7-sp" />
        <StepVerdict s={s} />
      </summary>
      <div className="s7-body">
        {facts.length === 0 ? (
          <p className="muted">No result for this head yet: it waits for the step before it.</p>
        ) : (
          <KeyValue rows={facts} label={`Facts of ${s.step}`} />
        )}
        <FindingsTable step={s.step} items={s.findings.items} />
        {s.gate ? (
          <p className="s7-gate">
            <GateTag gate={s.gate.gate} /> is {s.gate.status}
            {s.gate.outcome ? ` (${s.gate.outcome})` : ''}.{' '}
            {s.gate.card_id ? (
              <Link to={`/cards/${s.gate.card_id}`}>Open {s.gate.gate}</Link>
            ) : null}
          </p>
        ) : null}
        {s.result_sha256 ? (
          <p className="s7-faint">
            result <code title={s.result_sha256}>{s.result_sha256.slice(0, 12)}</code> ·{' '}
            {shortTime(s.recorded_at)}
            {s.runs > 1 ? ` · latest of ${s.runs} results for this head` : ''}
          </p>
        ) : null}
      </div>
    </details>
  );
}

const GC_TONE: Readonly<Record<string, PillTone>> = {
  success: 'ok',
  failure: 'bad',
  action_required: 'warn',
  pending: 'info',
};

/** gate-check's newest run on the PR head; `unknown` when gate-check cannot be asked. */
export function GateCheckSummary({ id, head }: { id: string; head: string | null }) {
  const q = useQuery({
    queryKey: ['item-gate-check', id],
    queryFn: () => api.itemGateCheck(id),
    staleTime: 15_000,
  });
  if (q.isPending) return <Loading what="the gate-check status" />;
  if (q.isError) return <GateCheckUnknown why="the factory could not be asked" />;
  return <GateCheckBody v={q.data} head={head} />;
}

function GateCheckUnknown({ why }: { why: string }) {
  return (
    <p data-testid="gate-check-status" data-outcome="unknown">
      <code>aisdlc/gate</code> <Pill tone="mute">unknown</Pill>{' '}
      <span className="muted">{why}. Unknown is never a pass.</span>
    </p>
  );
}

export function GateCheckBody({ v, head }: { v: GateCheckRunsView; head: string | null }) {
  if (v.status !== 'ok') return <GateCheckUnknown why="gate-check did not answer" />;
  const latest = v.verdicts[0];
  if (!latest) {
    return (
      <p data-testid="gate-check-status" data-outcome="none">
        <code>aisdlc/gate</code> <Pill tone="mute">no run yet</Pill>{' '}
        <span className="muted">gate-check has not seen a pull request of this item.</span>
      </p>
    );
  }
  return (
    <div>
      <p data-testid="gate-check-status" data-outcome={latest.outcome}>
        <code>aisdlc/gate</code>{' '}
        <Pill tone={GC_TONE[latest.outcome] ?? 'neutral'}>{latest.outcome}</Pill>{' '}
        <span>
          on <code>{short(latest.head_sha)}</code> · {latest.reason}
          {head !== null && latest.head_sha !== head ? ' · not the head shown here' : ''}
        </span>
      </p>
      <p className="s7-faint">
        {latest.repo}#{latest.pr_number}. Written on the head commit by gate-check&rsquo;s own App
        (checks:write only). A new push makes an old pass not apply (head_moved).
      </p>
    </div>
  );
}

export function VerifyTab({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['item-verify', id],
    queryFn: () => api.itemVerify(id),
    refetchInterval: 10_000,
  });
  if (q.isPending) return <Loading what="the S7 checks" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  return <VerifyBody v={q.data} />;
}

export function VerifyBody({ v }: { v: ItemVerifyView }) {
  if (v.lane === 'L7') {
    return (
      <EmptyState title="Spikes never reach S7">
        <p>6.5 ends in a spike report, the branch is archived and nothing is pushed.</p>
      </EmptyState>
    );
  }
  const started = v.heads.length > 0;
  const passed = v.steps.filter((s) => s.status === 'passed').length;
  const raised = v.steps.find((s) => s.status === 'raised');
  const pack = v.pack;
  return (
    <div className="s7">
      {!started ? (
        <p className="s7-banner s7-banner-info" role="status">
          S7 has not started: the item is at {v.step ?? v.phase}. It runs 7.1 to 7.5 on the Unit
          head in O sessions, then 7.6 signs the Evidence Pack.
        </p>
      ) : null}
      <Stats label="S7 at a glance">
        <Stat
          label="Checks passed"
          value={`${passed} of 5`}
          detail="latest result per step for this head"
          {...(passed === 5 ? { tone: 'ok' as const } : {})}
        />
        <Stat
          label="Unit head"
          value={<code>{short(v.head_sha)}</code>}
          detail={`Unit ${v.unit_key ?? '-'} · base ${short(v.base_sha)} (bound by G3)`}
        />
        <Stat
          label="7.6 Evidence Pack"
          value={
            pack
              ? pack.passing
                ? 'signed'
                : 'signed, not passing'
              : raised
                ? 'blocked'
                : 'not yet'
          }
          detail={
            pack
              ? `pack ${pack.pack_sha256.slice(0, 10)}… · Notary evidence scope`
              : raised
                ? `${raised.gate?.gate ?? 'the gate'} must be approved at ${raised.step}`
                : 'needs every step 7.1–7.5 passed'
          }
          {...(pack?.passing ? { tone: 'ok' as const } : raised ? { tone: 'warn' as const } : {})}
        />
      </Stats>
      {raised ? (
        <div
          className={`s7-banner ${raised.raised?.kind === 'trigger' ? 's7-banner-bad' : 's7-banner-gate'}`}
          data-testid="raised-banner"
        >
          <span>
            <b>
              {raised.step} raised{' '}
              {raised.raised?.kind === 'trigger' ? 'ET10 (Q1)' : (raised.gate?.gate ?? '')}.
            </b>{' '}
            {raised.raised?.kind === 'trigger'
              ? 'ET10 before anything else ran: the session is tainted; security triage comes before any handoff.'
              : 'The result’s hash is bound into the gate; the item goes on to 7.6 only when it is approved at that step.'}
          </span>
          {raised.gate?.card_id ? (
            <Link className="ui-btn ui-btn-sm" to={`/cards/${raised.gate.card_id}`}>
              Open {raised.raised?.kind === 'trigger' ? 'Q1' : raised.gate.gate}
            </Link>
          ) : null}
        </div>
      ) : null}
      <Card
        title="S7 checks"
        actions={<span className="s7-faint">verify service · never the coder</span>}
        flush
      >
        {v.steps.map((s) => (
          <CheckRow key={s.step} s={s} />
        ))}
        <details className="s7-chk" data-step="7.6">
          <summary>
            <code>7.6</code>
            <b>{STEPS['7.6'].title}</b>
            <ActorGlyph actor={STEPS['7.6'].actor} />
            <span className="s7-sp" />
            {pack ? (
              <Pill tone={pack.passing ? 'ok' : 'warn'}>
                {pack.passing ? 'signed' : pack.disposition.kind}
              </Pill>
            ) : (
              <Pill tone="mute">waiting</Pill>
            )}
          </summary>
          <div className="s7-body">
            <p className="muted">
              Every step met: the passing pack. A failed check goes back by B9 (to 6.4) or B11 (to
              5.1) while the pinned catalogue leaves the edge a round, else D2; a check with no
              verdict is D2 (ET4); a raised gate not approved is D2 (ET6).
            </p>
          </div>
        </details>
      </Card>
      {v.heads.length > 1 ? (
        <p className="s7-faint">
          Earlier heads with results:{' '}
          {v.heads
            .filter((h) => h.head_sha !== v.head_sha)
            .map((h) => `${short(h.head_sha)} (${h.results})`)
            .join(', ')}
          .
        </p>
      ) : null}
      <div className="s7-grid">
        <Card
          title="Evidence Pack"
          footer={
            pack ? (
              <Link className="ui-btn ui-btn-sm ui-btn-primary" to={`/items/${v.item_id}/evidence`}>
                Open the pack
              </Link>
            ) : null
          }
        >
          {pack ? (
            <KeyValue
              rows={[
                ['Pack id', <code key="p">{pack.pack_sha256.slice(0, 16)}…</code>],
                ['Format', <code key="f">aisdlc-evidence-pack/1</code>],
                ['Head', <code key="h">{short(pack.head_sha)}</code>],
                ['Signed', `Notary · evidence scope · ${pack.key_id}`],
                ['Passing', pack.passing ? 'yes' : `no (${pack.disposition.kind})`],
              ]}
            />
          ) : (
            <p className="muted">
              7.6 signs a pack only when the latest result of every step 7.1–7.5 for the Unit head
              passed and every gate a check raised was approved.
            </p>
          )}
        </Card>
        <Card title="gate-check on the PR">
          <GateCheckSummary id={v.item_id} head={v.head_sha} />
        </Card>
      </div>
    </div>
  );
}
