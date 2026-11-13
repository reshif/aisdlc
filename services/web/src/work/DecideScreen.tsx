import { useQuery } from '@tanstack/react-query';
import {
  label,
  lookupTerm,
  term,
  type CheckVerdict,
  type PortalInboxItem,
} from '@aisdlc/contracts';
import { Component, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  ApiError,
  api,
  type GateArtefactsWire,
  type GateCardWire,
  type GateContextWire,
  type Me,
} from '../api';
import { useAccess } from '../access';
import { GateMain } from './GateFacts';
import { OnboardingCard } from '../pages/CardPage';
import { RequestTab } from '../items/RequestTab';
import { Link, useNavigate } from '../router';
import {
  Card,
  CodeChip,
  DecisionRail,
  ErrorState,
  EvidenceGrid,
  PageHeader,
  Pill,
  VerdictPill,
  type EvidenceTile,
  type RailAccess,
} from '../ui';
import { copyOf } from './gateCopy';
import { Forbidden, renderCrumb } from './HomeScreen';
import { inboxOrder } from './InboxScreen';
import { useGateDecision } from './useGateDecision';
import {
  ago,
  dueText,
  fullTime,
  gateName,
  inboxHref,
  itemNo,
  listText,
  showsCodes,
  wire,
} from './words';
import './work.css';

// Decide an approval (screen-map §2.3, skeleton screen 2): evidence first, the decision rail beside it (a bottom
// sheet on a phone). 1 What exactly you approve, bound by hash; 2 the evidence, each tile opening its detail; 3 what
// the factory could not check (unknown is never a pass); 4 the detail; then the earlier decisions. J and K walk the
// inbox; after a decision the page moves on to the next one. Onboarding cards keep their own forms here.

export function DecideScreen({ id, me, csrf }: { id: string; me: Me; csrf: string }) {
  const kind = useQuery({
    queryKey: ['card-kind', id],
    queryFn: () => api.cardKind(id),
    staleTime: Infinity,
    retry: false,
  });
  if (kind.isPending) return <p className="wk-muted">Loading the approval…</p>;
  if (kind.isError) return <Refused e={kind.error} />;
  return kind.data.kind === 'work_gate' ? (
    <WorkDecide id={id} me={me} csrf={csrf} />
  ) : (
    <OnboardingCard id={id} csrf={csrf} me={me.principal.principal_id} />
  );
}

function Refused({ e }: { e: unknown }) {
  if (e instanceof ApiError && e.status === 403) return <Forbidden reason={e.message} />;
  if (e instanceof ApiError && e.status === 404) {
    return <ErrorState status={404} action={<Link to="/inbox">Back to the inbox</Link>} />;
  }
  return (
    <p role="alert" className="wk-bad">
      The approval could not load. Nothing was decided; try again in a moment.
    </p>
  );
}

/** The factory admin holds `factory.admin` on the whole factory, in force. */
function useIsFactoryAdmin(): boolean {
  const a = useAccess();
  return (
    a.data?.bindings.some(
      (b) => b.role_id === 'factory.admin' && b.scope.kind === 'fleet' && b.blockers.length === 0,
    ) ?? false
  );
}

/** Prev and next in my inbox (the order the inbox shows), for J and K and after a decision. */
function useNeighbours(id: string): {
  prev: PortalInboxItem | null;
  next: PortalInboxItem | null;
  at: number;
  of: number;
} {
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => api.inbox() });
  return useMemo(() => {
    const rows = inboxOrder(inbox.data?.decide ?? []).filter(
      (i) => i.kind === 'work_gate' || i.kind === 'onboarding_card',
    );
    const i = rows.findIndex((r) => (r.card_id ?? r.id) === id);
    const at = i;
    const others = rows.filter((_, n) => n !== i);
    return {
      prev: i > 0 ? (rows[i - 1] ?? null) : null,
      next: i >= 0 ? (rows[i + 1] ?? null) : (others[0] ?? null),
      at,
      of: rows.length,
    };
  }, [inbox.data, id]);
}

/** The approvals that decide documents an agent wrote (the others decide an action, a change or a release). */
const DOC_GATES = new Set(['G0', 'G1', 'G1f', 'G2', 'G3d', 'G3s', 'G3', 'E1']);

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'unknown');

/** A bound fact of the subject in plain words: what it is, never a 64-character hash (glossary §1). */
function bindText(b: { label: string; value: string }): string | null {
  if (b.label === 'item' || b.label === 'station' || b.label.startsWith('gates approved')) {
    return null;
  }
  if (b.label === 'base commit') return `Commit ${short(b.value)}`;
  if (b.label === 'lane profile') return 'The track and its approvals, as set for this project';
  if (b.label === 'request text') return 'The request text, exactly as kept';
  if (b.label === 'Handoff Pack') return 'Why the agents stopped (the handover notes)';
  if (b.label === 'quarantine evidence') return 'The evidence of the security hold';
  if (b.label === 'G4 review') return 'The pull requests and their checks';
  if (b.label === 'release binding') return 'What merged and where it is released';
  if (b.label === 'acceptance') return 'What merged and was released';
  if (b.label === 'stage report') return 'What the agent reported';
  const doc = /^\d+\.\d+[a-z]? (\w+)$/.exec(b.label);
  if (doc) return lookupTerm('document', doc[1] as string)?.label ?? 'A document';
  return 'A fact of this approval';
}

function WorkDecide({ id, me, csrf }: { id: string; me: Me; csrf: string }) {
  const navigate = useNavigate();
  const card = useQuery({
    queryKey: ['gate-card', id],
    queryFn: () => api.gateCard(id),
    refetchOnWindowFocus: false,
    staleTime: 0,
    retry: false,
  });
  const ctx = useQuery({
    queryKey: ['gate-context', id],
    queryFn: () => api.gateContext(id),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const arts = useQuery({
    queryKey: ['card-artefacts', id],
    queryFn: () => api.cardArtefacts(id),
    refetchOnWindowFocus: false,
    retry: false,
  });
  const itemId = card.data?.item_id ?? null;
  const verify = useQuery({
    queryKey: ['item-verify', itemId],
    queryFn: () => api.itemVerify(itemId as string),
    enabled: itemId !== null,
    retry: false,
  });
  const nb = useNeighbours(id);
  const admin = useIsFactoryAdmin();
  const [open, setOpen] = useState<string | null>(null);
  const [asAdmin, setAsAdmin] = useState(false);

  const c = card.data;
  const gates = c?.gates.map((g) => g.gate) ?? [];
  const main = gates[0] === 'Q1' ? 'SECT' : (gates.find((g) => g !== 'G3s') ?? gates[0] ?? '');
  const copy = copyOf(main);
  // a gate that decides documents is decided only on them, intact; an action gate binds its facts in the context
  const decidesDocs = gates.some((g) => DOC_GATES.has(g));
  const artsOk = decidesDocs
    ? arts.data !== undefined && arts.data.intact && arts.data.artefacts.length > 0
    : true;
  const isOpen = c ? c.status === 'open' && c.gates.some((g) => g.status === 'pending') : false;
  const overrideNeeded = c?.why_not?.code === 'not_slot_holder' && admin && isOpen;
  const override = asAdmin && overrideNeeded;
  // a two-person approval: the first approver is never the second
  const iApproved =
    ctx.data?.decisions.some(
      (d) => d.decision === 'approve' && d.actor === me.principal.principal_id,
    ) ?? false;
  const decision = useGateDecision({
    id,
    csrf,
    card: c,
    decidable: c?.may_decide === true && isOpen && artsOk && !ctx.isPending && !iApproved,
    override,
  });

  // J / K walk the inbox (not while typing); after a decision, the next one opens after a moment
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT'))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'j' && nb.next) navigate(inboxHref(nb.next));
      if (e.key === 'k' && nb.prev) navigate(inboxHref(nb.prev));
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [nb.next, nb.prev, navigate]);
  useEffect(() => {
    if (!decision.receipt || !nb.next) return;
    const t = window.setTimeout(() => navigate(inboxHref(nb.next as PortalInboxItem)), 4000);
    return () => window.clearTimeout(t);
  }, [decision.receipt, nb.next, navigate]);

  if (card.isPending) return <p className="wk-muted">Loading the approval…</p>;
  if (card.isError || !c) return <Refused e={card.error} />;

  const codes = showsCodes(me.actions.fleet);
  const names = { ...(ctx.data?.principal_names ?? {}), ...c.principal_names };
  const who = (p: string) => names[p] ?? 'someone';
  const item = c.item_id ? `item ${itemNo(c.item_id)}` : 'this record';
  const title = c.gates.map((g) => gateName(g.gate)).join(' and ');
  const context = ctx.data ?? null;

  // ------------------------------------------------ evidence tiles
  const tiles: Array<EvidenceTile & { body: ReactNode }> = [];
  if (gates.some((g) => g === 'G0' || g === 'G1')) {
    tiles.push({
      id: 'request',
      title: label('document', 'request'),
      detail: c.injection_suspected
        ? 'Possible prompt injection: read as data'
        : 'Marked untrusted',
      body: c.item_id ? <RequestTab id={c.item_id} /> : null,
    });
  }
  for (const a of arts.data?.artefacts ?? []) {
    tiles.push({
      id: `doc:${a.step}:${a.sha256}`,
      title: wire('document', a.type),
      ...(a.intact ? {} : { verdict: 'failed' as CheckVerdict }),
      detail: a.intact
        ? a.version === null
          ? 'The version this approval binds'
          : `Version ${a.version}`
        : 'Not intact: do not approve',
      body: <ArtefactBody a={a} />,
    });
  }
  const steps = verify.data?.steps ?? [];
  if (gates.some((g) => ['G4', 'G5', 'G6', 'X2', 'X3', 'E6', 'Q1', 'SECT', 'E2'].includes(g))) {
    for (const s of steps) {
      const v: CheckVerdict = s.verdict ?? 'unknown';
      tiles.push({
        id: `check:${s.check}`,
        title: wire('verifyCheck', s.check),
        verdict: v,
        detail:
          s.findings.total === 0
            ? 'No findings'
            : `${s.findings.total} ${s.findings.total === 1 ? 'finding' : 'findings'}, ${s.findings.failing} failing`,
        body: <CheckBody s={s} />,
      });
    }
    const pack = verify.data?.pack ?? null;
    tiles.push({
      id: 'pack',
      title: label('concept', 'evidence_pack'),
      ...(pack
        ? { verdict: (pack.passing ? 'passed' : 'failed') as CheckVerdict }
        : { verdict: 'unknown' as CheckVerdict }),
      detail: pack
        ? `${label('concept', 'notary_signature')} for commit ${short(pack.head_sha)}`
        : 'None signed yet',
      body: c.item_id ? (
        <p>
          {pack
            ? `Signed by the factory for commit ${short(pack.head_sha)}, ${ago(pack.produced_at)}.`
            : 'No evidence pack is signed for this commit yet: treated as not passed.'}{' '}
          <Link to={`/items/${encodeURIComponent(c.item_id)}/evidence`}>
            Open the evidence pack
          </Link>
        </p>
      ) : null,
    });
  }
  if (
    context &&
    (context.subject !== null ||
      // these always decide a subject: one that is missing is said in the detail, never skipped
      ['G4', 'G5', 'G6', 'X1', 'G3o'].includes(main) ||
      context.dependencies.length > 0 ||
      context.patch ||
      context.quarantine ||
      context.constitution ||
      context.handoff)
  ) {
    tiles.push({
      id: 'context',
      title: 'What this approval is about',
      detail: copy?.read ?? 'The facts this approval binds',
      body: <GateMain c={context} name={who} />,
    });
  }

  // ------------------------------------------------ uncertainty
  const doubts: string[] = [];
  for (const s of steps) {
    if (s.verdict === null || s.verdict === 'unknown') {
      doubts.push(
        `${wire('verifyCheck', s.check)}: ${label('status', 'unknown')}, treated as not passed.`,
      );
    }
  }
  if (arts.data && !arts.data.intact) {
    doubts.push('A document this approval binds is missing or changed. Do not approve it.');
  }
  if (c.injection_suspected) {
    doubts.push(
      'The request text looks like it tries to instruct the factory. It was read as data and not obeyed.',
    );
  }
  if (ctx.isError) {
    doubts.push(
      'Part of the evidence needs a higher view level than yours, so it is not shown here.',
    );
  }
  if (decision.needsProof)
    doubts.push(`${label('decideWord', 'step_up')}: this approval asks you to sign in again.`);

  // ------------------------------------------------ the rail
  const holders = c.deciders.holders;
  const slots = c.deciders.slots.map((s) => wire('roleSlot', s));
  const whoText = (
    <>
      <p data-testid="deciders">
        Decided by:{' '}
        {holders.length === 0 ? (
          <span className="wk-bad">nobody holds this role yet</span>
        ) : (
          listText(holders.map(who))
        )}
        <span className="wk-muted"> ({listText(slots)})</span>
      </p>
      {c.may_decide && isOpen ? <p>You may decide this.</p> : null}
      {decision.needsProof && !decision.proof && (c.may_decide || override) ? (
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={decision.busy || !decision.prepared}
          onClick={decision.confirmIdentity}
        >
          {label('decideWord', 'step_up')}
        </button>
      ) : null}
      {decision.proof ? <p role="status">{decision.note ?? 'It is you: decide now.'}</p> : null}
      {decision.problem ? (
        <div role="alert" className="wk-bad" data-testid="decide-problem">
          <p>{decision.problem.text}</p>
          {decision.problem.reload ? (
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
  const holderNames = listText(holders.map(who));
  const access: RailAccess = !isOpen
    ? {
        state: 'deny',
        reason: `This approval is ${wire('cardStatus', c.status).toLowerCase()}; nothing more is decided on it.${c.decision_reason ? ` The reason given: ${c.decision_reason}` : ''}`,
      }
    : override
      ? { state: 'allow' }
      : !c.may_decide
        ? {
            state: 'deny',
            reason:
              c.why_not?.code === 'pdp_denied'
                ? `None of your roles lets you decide this approval on ${c.project_id}.${holders.length > 0 ? ` Ask ${holderNames}.` : ''}`
                : `Only the ${listText(slots).toLowerCase()} can decide this.${holders.length > 0 ? ` Ask ${holderNames}.` : ''}`,
            request: (
              <p>
                {overrideNeeded ? (
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    onClick={() => setAsAdmin(true)}
                  >
                    {label('decideWord', 'admin_override')}
                  </button>
                ) : (
                  <Link to="/me/access">Request access</Link>
                )}
              </p>
            ),
          }
        : iApproved
          ? {
              state: 'deny',
              reason: `You approved first (1 of ${context?.quorum_required ?? 2}). A different person must approve second.`,
            }
          : !artsOk
            ? {
                state: 'deny',
                reason:
                  'The evidence of this approval is not intact, so it cannot be decided here.',
              }
            : decision.ready
              ? { state: 'allow' }
              : { state: 'pending' };
  const approvals = context?.decisions.filter((d) => d.decision === 'approve') ?? [];
  const b13 = context?.subject?.kind === 'merge_review' ? context.subject.b13 : null;
  const sendBack =
    b13 && b13.left !== null && b13.limit !== null
      ? b13.left > 0
        ? `${b13.left} of ${b13.limit} tries left`
        : 'none left, goes to a person'
      : undefined;

  return (
    <div className="wk-page" data-testid="decide" data-gate={main}>
      <PageHeader
        crumbs={[
          { label: label('screen', 'inbox'), to: '/inbox' },
          { label: c.project_id, to: `/projects/${encodeURIComponent(c.project_id)}` },
          ...(c.item_id
            ? [
                {
                  label: `Item ${itemNo(c.item_id)}`,
                  to: `/items/${encodeURIComponent(c.item_id)}`,
                },
              ]
            : []),
          { label: title },
        ]}
        renderLink={renderCrumb}
        title={title}
        status={
          <>
            {codes ? c.gates.map((g) => <CodeChip key={g.gate} code={g.gate} />) : null}
            <Pill tone={isOpen ? 'gate' : 'mute'}>{wire('cardStatus', c.status)}</Pill>
            {main === 'G4' ? (
              <Pill tone="info">{label('decideWord', 'always_required')}</Pill>
            ) : null}
          </>
        }
        meta={
          <>
            {c.project_id}
            {c.item_id ? ` · Item ${itemNo(c.item_id)}` : ''}
            {c.proposed_lane
              ? ` · ${label('concept', 'lane')}: ${wire('lane', c.proposed_lane)}`
              : ''}
            <NeighbourMeta id={id} />
          </>
        }
        actions={
          <span className="wk-row" aria-label="Move through your inbox">
            {nb.prev ? (
              <Link className="ui-btn ui-btn-sm" to={inboxHref(nb.prev)} aria-keyshortcuts="k">
                Previous{' '}
                <span className="ui-kbd" aria-hidden="true">
                  K
                </span>
              </Link>
            ) : null}
            {nb.next ? (
              <Link className="ui-btn ui-btn-sm" to={inboxHref(nb.next)} aria-keyshortcuts="j">
                Next{' '}
                <span className="ui-kbd" aria-hidden="true">
                  J
                </span>
              </Link>
            ) : null}
          </span>
        }
      />

      <div className="ui-decide">
        <div className="wk-page">
          <Card title="1 · What you are approving" testId="what">
            <p className="wk-lead">
              {copy ? copy.what.replace('{item}', item) : term('gate', main as never)?.explain}
            </p>
            {c.base_sha ? <p>Based on commit {short(c.base_sha)}.</p> : null}
            {context?.head_sha ? <p>For commit {short(context.head_sha)}.</p> : null}
            {context ? (
              <>
                <p className="wk-muted">
                  This decision is bound to exactly these, by their fingerprint:
                </p>
                <ul className="wk-binds" data-testid="binds">
                  {[
                    ...new Set(context.binds.map(bindText).filter((x): x is string => x !== null)),
                  ].map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <p className="wk-muted">
              If any of them changes, this approval opens again and this decision no longer counts.
            </p>
          </Card>

          <Card title="2 · Evidence" testId="evidence">
            {tiles.length === 0 ? (
              <p className="wk-muted">
                {arts.isPending || ctx.isPending
                  ? 'Loading the evidence…'
                  : 'No evidence is shown for this approval.'}
              </p>
            ) : (
              <EvidenceGrid
                tiles={tiles}
                selected={open}
                onOpen={(t) => setOpen((o) => (o === t ? null : t))}
                label="Evidence"
              />
            )}
            {open ? (
              <section className="wk-detail" aria-label="Detail" data-testid="detail">
                <h3>{tiles.find((t) => t.id === open)?.title}</h3>
                <DetailBoundary key={open}>{tiles.find((t) => t.id === open)?.body}</DetailBoundary>
              </section>
            ) : tiles.length > 0 ? (
              <p className="wk-muted">Open a tile to read its detail here.</p>
            ) : null}
          </Card>

          <Card title="3 · What the factory could not check" testId="doubts">
            {doubts.length === 0 ? (
              <p>Every check has a result. Nothing reads unknown.</p>
            ) : (
              <ul className="wk-list">
                {doubts.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            )}
            {copy ? (
              <p className="wk-muted">
                Read {copy.read} before you decide. After approval: {copy.after}
              </p>
            ) : null}
          </Card>

          <Card title="Earlier decisions" testId="history">
            {!context || context.decisions.length === 0 ? (
              <p className="wk-muted">Nobody has decided this approval yet.</p>
            ) : (
              <ul className="wk-list">
                {context.decisions.map((d) => (
                  <li key={d.ledger_seq}>
                    <span>{who(d.actor)}</span>
                    <span>{wire('decision', d.decision)}</span>
                    <span className="wk-muted" title={fullTime(d.at)}>
                      {ago(d.at)} · decision log entry {d.ledger_seq}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <DecisionRail
          who={whoText}
          access={access}
          {...(context && context.quorum_required > 1
            ? {
                twoPerson: {
                  have: approvals.length,
                  need: context.quorum_required,
                  by: approvals.map((a) => who(a.actor)),
                },
              }
            : {})}
          stepUp={decision.needsProof}
          {...(sendBack ? { sendBack } : {})}
          {...(copy ? { rejectTo: copy.rejectTo } : {})}
          {...(copy?.allowed ? { allowed: copy.allowed } : {})}
          adminOverride={override}
          {...(c.decision_reason !== null && isOpen ? { fixedReason: c.decision_reason } : {})}
          busy={decision.busy}
          {...(decision.receipt
            ? {
                result: (
                  <Decided
                    receipt={decision.receipt}
                    project={c.project_id}
                    after={copy?.after}
                    next={nb.next}
                  />
                ),
              }
            : {})}
          onDecide={decision.decide}
        />
      </div>
    </div>
  );
}

/** " · due in 2 h" from the inbox entry of this card, when it is one. */
function NeighbourMeta({ id }: { id: string }) {
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => api.inbox() });
  const mine = [...(inbox.data?.decide ?? []), ...(inbox.data?.view ?? [])].find(
    (i) => (i.card_id ?? i.id) === id,
  );
  if (!mine) return null;
  return <> · {dueText(mine.sla_due_at, mine.overdue)}</>;
}

function Decided({
  receipt,
  project,
  after,
  next,
}: {
  receipt: ReadonlyArray<{ ledger_seq: number; decision: string | null }>;
  project: string;
  after: string | undefined;
  next: PortalInboxItem | null;
}) {
  const first = receipt[0];
  return (
    <div data-testid="receipt">
      <p>
        <strong>Recorded.</strong>{' '}
        {first
          ? `${wire('decision', first.decision)}, decision log entry ${first.ledger_seq}.`
          : ''}
      </p>
      {after ? <p>{after}</p> : null}
      <p>
        <Link to={`/projects/${encodeURIComponent(project)}/ledger`}>Open the decision log</Link>
      </p>
      {next ? (
        <p>
          Opening the next one in your inbox… <Link to={inboxHref(next)}>Go now</Link>
        </p>
      ) : (
        <p>
          Nothing else waits on you. <Link to="/inbox">Back to the inbox</Link>
        </p>
      )}
    </div>
  );
}

function ArtefactBody({ a }: { a: GateArtefactsWire['artefacts'][number] }) {
  if (!a.intact) {
    return (
      <p className="wk-bad">
        This document is missing or its content changed after the approval opened.
      </p>
    );
  }
  if (a.markdown === null) {
    return <p className="wk-muted">The text needs a higher data class than yours.</p>;
  }
  // the agent's own words: shown as text, never as markup
  return <pre className="wk-pre">{a.markdown}</pre>;
}

function CheckBody({ s }: { s: NonNullable<GateContextWire['check']> }) {
  return (
    <>
      <p>
        <VerdictPill verdict={s.verdict ?? 'unknown'} />{' '}
        {s.recorded_at
          ? `Checked ${ago(s.recorded_at)}.`
          : 'Not checked yet: treated as not passed.'}
      </p>
      {s.findings.items.length === 0 ? (
        <p className="wk-muted">No findings.</p>
      ) : (
        <ul className="wk-list">
          {s.findings.items.map((f, n) => (
            <li key={n}>
              <Pill tone={f.severity === 'high' || f.severity === 'critical' ? 'bad' : 'warn'}>
                {f.severity}
              </Pill>
              <span>{f.path ?? 'the change'}</span>
              <span>{f.message ?? 'Withheld: needs a higher data class.'}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export type { GateCardWire };

/**
 * One evidence detail that cannot be drawn (facts in a shape this portal does not know) says so in its own pane and
 * leaves the rest of the page, the rail included: it is never read as evidence that passed.
 */
class DetailBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? (
      <p role="alert" className="wk-bad" data-testid="detail-failed">
        This part of the evidence could not be shown. Treat it as not checked: do not approve on
        what you cannot read.
      </p>
    ) : (
      this.props.children
    );
  }
}
