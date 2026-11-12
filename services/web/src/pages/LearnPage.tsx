import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LearnProposalView, LearnSignal } from '@aisdlc/contracts';
import { api } from '../api';
import { ErrorNote } from '../components/Notice';
import { Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, GateTag, KeyValue, PageHead, Pill, Table, type Column } from '../ui';

// 9.4 Learn for one project (M15.5): the proposals the factory made from its close-out records, each decided on its
// META gate (M1, M2, M3, M5, M6) by that gate's slot like any gate, the autonomy an approved M5 earned, and B19's
// mode-E suspension with the way to ask for its lift (an M5). Reading is `audit.read` on the project; running 9.4
// now and asking for the lift are `learn.propose`. Nothing here decides: the card of each META gate does.

const SIGNAL_TEXT: Readonly<Record<LearnSignal, string>> = {
  break_glass_repeat: 'break-glass merges repeat',
  rework_variance: 'rework varies more than the catalogue expects',
  edge_hotspot: 'one back-edge is taken again and again',
  clean_streak: 'a clean streak of close-outs',
  clean_since_suspension: 'clean since mode E was suspended',
  requested: 'a person asked',
  single_approver: 'one approver decided the whole streak',
};

const COLS: ReadonlyArray<Column<LearnProposalView>> = [
  {
    key: 'g',
    header: 'Gate',
    rowHeader: true,
    render: (p) => <GateTag gate={p.proposal.meta_gate} />,
  },
  { key: 'k', header: 'Proposal', render: (p) => p.proposal.kind.replace(/_/g, ' ') },
  { key: 's', header: 'Why', render: (p) => SIGNAL_TEXT[p.proposal.signal] },
  {
    key: 'e',
    header: 'Evidence',
    align: 'right',
    render: (p) => `${p.proposal.evidence.length} close-out(s)`,
  },
  {
    key: 'st',
    header: 'State',
    render: (p) =>
      p.status === 'pending' ? (
        <Pill tone="warn">waiting for its gate</Pill>
      ) : (
        <Pill tone={p.outcome === 'approve' ? 'ok' : 'mute'}>
          {p.outcome ?? 'settled'}
          {p.effect && p.effect !== 'none' ? ` · ${p.effect.replace(/_/g, ' ')}` : ''}
        </Pill>
      ),
  },
  {
    key: 'c',
    header: 'Decide',
    render: (p) =>
      p.card_id && p.status === 'pending' ? (
        <Link to={`/cards/${p.card_id}`}>Open the card</Link>
      ) : (
        <ShortHash hash={p.proposal_id} />
      ),
  },
  { key: 'at', header: 'Proposed', render: (p) => shortTime(p.proposed_at) },
];

export function LearnPage({ project, csrf }: { project: string; csrf: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['learn', project], queryFn: () => api.learn(project) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['learn', project] });
  const run = useMutation({ mutationFn: () => api.learnRun(project, csrf), onSuccess: refresh });
  const lift = useMutation({
    mutationFn: () => api.learnModeELift(project, csrf),
    onSuccess: refresh,
  });
  return (
    <Read q={q} what="the learn proposals">
      {(v) => (
        <>
          <PageHead
            eyebrow="Learn · 9.4"
            title={`What ${project} has learned`}
            crumbs={[{ label: project, to: `/projects/${project}` }, { label: 'learn' }]}
            renderLink={(to, label) => <Link to={to}>{label}</Link>}
            sub="The factory reads the close-out records and proposes changes into its META gates. Each is decided like any gate, by that gate's slot, on the ledger; only an approved M5 changes what the project may do."
            actions={
              v.may_propose ? (
                <button
                  type="button"
                  className="ui-btn"
                  disabled={run.isPending}
                  onClick={() => run.mutate()}
                >
                  Run 9.4 now
                </button>
              ) : null
            }
          />
          {run.data ? (
            <p role="status">
              {run.data.proposed.length} new proposal(s), {run.data.settled.length} settled from the
              ledger.
            </p>
          ) : null}
          {run.isError ? <ErrorNote error={run.error} /> : null}
          <div className="pg-split">
            <Card title="Autonomy" testId="learn-autonomy">
              <KeyValue
                rows={[
                  [
                    'Earned',
                    v.earned_autonomy ? (
                      <span key="a">
                        <b>{v.earned_autonomy.level}</b> by an approved M5 (ledger entry{' '}
                        <code>{v.earned_autonomy.ledger_entry_id}</code>)
                      </span>
                    ) : (
                      'none yet: the probation cap applies'
                    ),
                  ],
                  [
                    'Mode E',
                    v.mode_e_suspended ? (
                      <Pill key="s" tone="bad">
                        suspended (B19)
                      </Pill>
                    ) : (
                      <Pill key="s" tone="ok">
                        allowed
                      </Pill>
                    ),
                  ],
                ]}
              />
            </Card>
            {v.mode_e_suspended ? (
              <Card title="Lift the mode-E suspension" testId="learn-lift">
                <p>
                  9.5 found too many gate misses among audited mode-E merges, so G4 is reviewed by a
                  codeowner (mode C) for this project. Lifting it is an M5 the project&rsquo;s
                  admins decide, on the close-outs since the suspension.
                </p>
                {v.may_propose ? (
                  <button
                    type="button"
                    className="ui-btn"
                    disabled={lift.isPending}
                    onClick={() => lift.mutate()}
                  >
                    Ask for the lift (M5)
                  </button>
                ) : (
                  <p className="muted">Asking for the lift needs learn.propose on this project.</p>
                )}
                {lift.data ? (
                  <p role="status">
                    {lift.data.duplicate ? 'The lift is already asked for' : 'The M5 is open'}: its
                    card is in the deciders&rsquo; inbox.
                  </p>
                ) : null}
                {lift.isError ? <ErrorNote error={lift.error} /> : null}
              </Card>
            ) : null}
          </div>
          <Card title="Proposals" flush>
            <Table
              caption={`Learn proposals of ${project}`}
              captionHidden
              columns={COLS}
              rows={v.proposals}
              rowKey={(p) => p.proposal_id}
              empty={
                <EmptyState title="No proposal yet">
                  9.4 proposes once close-out records show a pattern worth a decision.
                </EmptyState>
              }
            />
          </Card>
        </>
      )}
    </Read>
  );
}
