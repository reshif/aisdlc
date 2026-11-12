import type { GateId } from '@aisdlc/contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  type GateCardPreparedWire,
  type GateCardWire,
  type GateContextWire,
  type LedgerReceipt,
} from '../api';
import { reasonText } from '../access';
import { Loading, PageError } from '../components/Notice';
import { shortTime } from '../format';
import { FindingsTable, StepVerdict, stepFacts } from '../items/VerifyTab';
import { explainDecideError, type DecideProblem } from '../lib/decideErrors';
import { Link } from '../router';
import { Card, GateTag, KeyValue, PageHead, Pill } from '../ui';
import { Receipt } from './DecideShell';

// The gate screens S7 (and S6, and 4.5) raise (PLAN M14.6; prototype `views-m14.js` g.Q1, g.E6, g.X2, g.X3, g.E2 on the
// decide shell of `views-decide.js`): Q1 (the quarantine, decided through its security triage SECT), E6 (a locked test
// must change), X2 (a protected path, two people), X3 (a new package) and E2 (the constitution). Each shows what the
// decision binds (the subject hash and what it is made of), who may decide and why not this person (the PDP's reason
// first), the two-person state, a step-up where the gate needs one, and decide or deny with a reason. The reason is
// the card payload's `decision_reason`: its hash goes into every ledger entry of the decision. Nothing is sent on its
// own; the kernel checks the slot, the requester rule, the two-person rule and the step-up again.

type Decision = 'approve' | 'request_changes' | 'reject';

/** The gates this screen decides (Q1 is the quarantine: its decision is the SECT triage). */
export const EXCEPTION_GATES: readonly GateId[] = ['SECT', 'Q1', 'E6', 'X2', 'X3', 'E2', 'E4'];

interface Copy {
  readonly shown: GateId;
  readonly eyebrow: string;
  readonly title: string;
  readonly sub: string;
  readonly sentence: (c: GateContextWire) => ReactNode;
  readonly readWhat: string;
  readonly labels: Readonly<Record<Decision, string>>;
  readonly after: string;
  /** Q1: the person chooses a finding; the choice is the decision. */
  readonly choice?: ReadonlyArray<{ id: Decision; label: string; desc: string }>;
}

const item = (c: GateContextWire) => <code>{c.item_id.slice(0, 8)}</code>;

const COPY: Readonly<Partial<Record<GateId, Copy>>> = {
  SECT: {
    shown: 'Q1',
    eyebrow: 'Q1 · quarantine · security triage (SECT)',
    title: 'Test integrity quarantine',
    sub: 'S7 7.2 found that the tests were bent to pass (ET10). The session is tainted; security triage comes before any handoff.',
    sentence: (c) => (
      <>
        Is the ET10 at {c.quarantine?.origin_step ?? '7.2'} on {item(c)} a real test-integrity
        breach?
      </>
    ),
    readWhat: 'the 7.2 result and the quarantine evidence',
    labels: {
      approve: 'Record my finding',
      reject: 'Record my finding',
      request_changes: 'Record my finding',
    },
    after:
      'Confirmed: the branch is quarantined and the item goes to L8 human-led with no hand-back. False positive: a cold rebuild in a new session. Nothing is auto-approved.',
    choice: [
      {
        id: 'reject',
        label: 'Confirmed: bent tests',
        desc: 'Keep the session tainted; the branch is quarantined and the item goes human-led (L8).',
      },
      {
        id: 'approve',
        label: 'False positive',
        desc: 'The oracle or the probe was wrong: a cold rebuild and a new session.',
      },
    ],
  },
  E6: {
    shown: 'E6',
    eyebrow: 'E6 · exception · Test Change Request',
    title: 'Locked test change',
    sub: 'A locked oracle must change because the spec it was written from was changed and approved again at G2 (B12). Only an E6 lets a locked test change.',
    sentence: (c) => <>May a locked oracle test change on {item(c)}?</>,
    readWhat: 'the test integrity result and the spec change',
    labels: {
      approve: 'Approve the test change',
      request_changes: 'Ask for a smaller change',
      reject: 'Reject (D2)',
    },
    after:
      'Approved: G3o (the oracle deviation) opens for the design approvers; the test is re-locked with its new hash and 7.2 runs again.',
  },
  X2: {
    shown: 'X2',
    eyebrow: 'X2 · action gate · two-person',
    title: 'Protected-path change',
    sub: 'The head changes a protected path (DEFAULT_PROTECTED_GLOBS). Two different approvers decide X2; the patch hash binds exactly this diff.',
    sentence: (c) => (
      <>
        May the protected-path change in{' '}
        <code>{c.head_sha ? c.head_sha.slice(0, 7) : 'the Unit head'}</code> go on?
      </>
    ),
    readWhat: 'the diff and its patch hash',
    labels: { approve: 'Approve', request_changes: 'Request changes', reject: 'Reject' },
    after:
      'With the last approval the step records X2 approved and goes on (at 6.6 the push runs again under it). A later push changes the patch hash and needs X2 again.',
  },
  X3: {
    shown: 'X3',
    eyebrow: 'X3 · action gate · new dependency',
    title: 'New dependency',
    sub: 'The Unit adds a dependency that no X3 approved. You decide whether the factory may take it.',
    sentence: (c) => <>May {item(c)} add a new package as a dependency?</>,
    readWhat: 'the package facts',
    labels: {
      approve: 'Approve the dependency',
      request_changes: 'Ask for an alternative (1×)',
      reject: 'Reject',
    },
    after: 'Approved: the step runs again with the dependency approved.',
  },
  E4: {
    shown: 'E4',
    eyebrow: 'E4 · exception · owner of record',
    title: 'Handoff to the owner of record',
    sub: 'The factory stopped and handed the item to a person (D1 from S6, D2 from S7, D3 from G4, or straight to E4). As its owner of record you take the handoff; then you record what happens next on the item page.',
    sentence: (c) => (
      <>
        Do you take the handoff of {item(c)}
        {c.handoff ? (
          <>
            {' '}
            ({c.handoff.code}, trigger <code>{c.handoff.trigger}</code>)
          </>
        ) : null}{' '}
        as its owner of record?
      </>
    ),
    readWhat: 'the handoff and its Handoff Pack',
    labels: {
      approve: 'Take the handoff',
      request_changes: 'Ask for more facts',
      reject: 'Not mine to take',
    },
    after:
      'Approved: you choose on the item page (resume, an extension, re-plan, re-spec, a developer takes over, close or abandon). Anything else, or expiry, opens E4 again: nothing is chosen on its own.',
  },
  E2: {
    shown: 'E2',
    eyebrow: 'E2 · exception · two-person',
    title: 'Constitution exception',
    sub: 'The factory constitution ran on the design (4.5) or the code (7.5) beside A5’s review. A rule is violated, so the item stops until an exception is decided (two people).',
    sentence: (c) => (
      <>
        May {item(c)} go on although it breaks the factory constitution at {c.step ?? 'its step'}?
      </>
    ),
    readWhat: 'the constitution report',
    labels: {
      approve: 'Approve the exception',
      request_changes: 'Redesign (B25)',
      reject: 'Reject',
    },
    after:
      'With the last approval the step continues with the exception bound to it; the constitution itself is not changed (that is a factory.constitution revision, M1).',
  },
};

const short = (s: string, n = 12) => `${s.slice(0, n)}…`;

/** A work-item gate card decided on this screen. */
export function ExceptionGate({
  id,
  csrf,
  me,
  card,
}: {
  id: string;
  csrf: string;
  me: string;
  card: GateCardWire;
}) {
  const ctx = useQuery({
    queryKey: ['gate-context', id],
    queryFn: () => api.gateContext(id),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  if (ctx.isPending) return <Loading what="what this gate decides" />;
  if (ctx.isError) return <PageError error={ctx.error} retry={() => void ctx.refetch()} />;
  return <ExceptionGateBody id={id} csrf={csrf} me={me} card={card} c={ctx.data} />;
}

export function ExceptionGateBody({
  id,
  csrf,
  me,
  card,
  c,
}: {
  id: string;
  csrf: string;
  me: string;
  card: GateCardWire;
  c: GateContextWire;
}) {
  const copy = COPY[c.gate === 'Q1' ? 'SECT' : c.gate];
  if (!copy) return <p className="muted">The portal does not show this kind of gate yet.</p>;
  const name = (p: string) => c.principal_names[p] ?? card.principal_names[p] ?? p;
  const crumbs = [
    { label: 'Inbox', to: '/inbox' },
    { label: 'Work item', to: `/items/${c.item_id}` },
    { label: copy.shown },
  ];
  return (
    <div className="s7" data-gate={c.gate}>
      <PageHead
        crumbs={crumbs}
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
        eyebrow={copy.eyebrow}
        title={copy.title}
        sub={copy.sub}
        actions={
          <Link className="ui-btn ui-btn-sm" to={`/items/${c.item_id}`}>
            Open item
          </Link>
        }
      />
      {c.gate === 'SECT' ? (
        <p className="s7-banner s7-banner-bad" role="note">
          <b>Quarantined.</b> No handoff, push or merge until this is decided. The coder&rsquo;s key
          is revoked; its session is a security matter.
        </p>
      ) : null}
      <div className="s7-split">
        <div className="s7-stack">
          <Card title="What is being decided" testId="what">
            <p className="s7-lead">
              <GateTag gate={copy.shown} /> {copy.sentence(c)}
            </p>
            <p className="ui-eyebrow">
              Subject hash · {c.binds.length} binding{c.binds.length === 1 ? '' : 's'}
            </p>
            <p>
              <code className="s7-wrap" data-testid="subject-hash">
                sha256:{c.subject_hash}
              </code>
            </p>
            <KeyValue
              label="What the subject hash binds"
              rows={c.binds.map((b) => [
                b.label,
                /^[0-9a-f]{40,64}$/.test(b.value) ? (
                  <code title={b.value}>{short(b.value, 16)}</code>
                ) : (
                  <code>{b.value}</code>
                ),
              ])}
            />
          </Card>
          <Card title="Facts">
            <KeyValue
              rows={[
                [
                  'Work item',
                  <Link key="i" to={`/items/${c.item_id}`}>
                    {c.item_id}
                  </Link>,
                ],
                ['Station', <code key="s">{c.station}</code>],
                [
                  'Raised at',
                  c.step ?? (c.quarantine ? `${c.quarantine.origin_step} (ET10)` : '-'),
                ],
                [
                  'Unit head',
                  c.head_sha ? <code key="h">{c.head_sha.slice(0, 12)}</code> : '[unknown]',
                ],
                ['Requester', c.requester ? name(c.requester) : 'nobody named'],
                ['Approvals needed', String(c.quorum_required)],
              ]}
            />
          </Card>
          <GateMain c={c} />
        </div>
        <aside className="s7-stack">
          <DecisionPanel id={id} csrf={csrf} me={me} card={card} c={c} copy={copy} name={name} />
        </aside>
      </div>
    </div>
  );
}

/** The gate-specific evidence. */
function GateMain({ c }: { c: GateContextWire }) {
  const check = c.check;
  const checkCard = check ? (
    <Card title={`What ${check.step} found`} actions={<StepVerdict s={check} />} testId="check">
      <KeyValue rows={stepFacts(check)} label={`Facts of ${check.step}`} />
      <FindingsTable step={check.step} items={check.findings.items} />
      {check.result_sha256 ? (
        <p className="s7-faint">
          result <code>{check.result_sha256.slice(0, 16)}</code> · {shortTime(check.recorded_at)}
        </p>
      ) : null}
    </Card>
  ) : (
    <Card title="The check that raised it" testId="check">
      <p className="muted">
        No S7 result is recorded for the current head{c.step ? ` at ${c.step}` : ''}: the facts
        below are what the gate opened with. Unknown is never a pass.
      </p>
    </Card>
  );
  switch (c.gate) {
    case 'SECT':
      return (
        <>
          {checkCard}
          <Card title="Why it is a quarantine">
            {c.quarantine ? (
              <KeyValue
                rows={[
                  ['Quarantine', `#${c.quarantine.n}`],
                  ['Cause', <code key="c">{c.quarantine.cause}</code>],
                  ['From', `${c.quarantine.origin_phase} at ${c.quarantine.origin_step}`],
                  [
                    'Evidence',
                    c.quarantine.pack_sha256 ? (
                      <code key="e">{short(c.quarantine.pack_sha256, 16)}</code>
                    ) : (
                      '[unknown]'
                    ),
                  ],
                ]}
              />
            ) : null}
            <ul className="s7-rules">
              <li>
                A locked oracle that passes on the base with only the head&rsquo;s test files on it
                no longer tests the change; a locked-test edit or a stub test is the same breach.
              </li>
              <li>
                The finding&rsquo;s class is quarantine (REPAIR_CLASS_OF_FINDING): never a repair.
                The result&rsquo;s hash is the quarantine&rsquo;s evidence.
              </li>
            </ul>
          </Card>
        </>
      );
    case 'X2':
      return (
        <>
          <Card title="The protected-path patch" testId="patch">
            {c.patch ? (
              <KeyValue
                rows={[
                  [
                    'Patch hash',
                    <code key="p" className="s7-wrap" data-testid="patch-hash">
                      {c.patch.patch_hash}
                    </code>,
                  ],
                  [
                    'Bound',
                    c.patch.bound
                      ? 'yes: the subject hash binds this patch (6.6)'
                      : 'shown from the Push Broker’s receipt for the head; the subject hash binds the station and the head’s approvals',
                  ],
                ]}
              />
            ) : (
              <p className="muted">
                Patch hash: [unknown]. No patch artefact or push receipt is recorded for this head.
              </p>
            )}
          </Card>
          {checkCard}
        </>
      );
    case 'X3':
      return (
        <>
          <Card title="The package" testId="package">
            {c.dependencies.length === 0 ? (
              <KeyValue
                rows={[
                  ['Package', '[unknown]'],
                  ['Licence', '[unknown]'],
                  ['Advisories', '[unknown]: no advisory database is wired yet'],
                ]}
              />
            ) : (
              c.dependencies.map((d) => (
                <KeyValue
                  key={d.name}
                  rows={[
                    ['Package', <code key="n">{d.name}</code>],
                    ['Where', d.manifest ? <code key="m">{d.manifest}</code> : '[unknown]'],
                    ['Licence', d.licence ?? '[unknown]'],
                    ['Advisories', d.advisories ?? '[unknown]: no advisory database is wired yet'],
                  ]}
                />
              ))
            )}
            <ul className="s7-rules">
              <li>The factory checks only what was added and whether X3 approved it.</li>
              <li>An alternative may be asked for once; after that the item hands off (D1).</li>
            </ul>
          </Card>
          {c.check ? checkCard : null}
        </>
      );
    case 'E2':
      return (
        <>
          {c.constitution ? (
            <Card title="Constitution report" testId="constitution">
              <p className="s7-faint">
                sha256 <code>{short(c.constitution.sha256, 16)}</code> ·{' '}
                {c.constitution.intact ? 'intact' : 'NOT intact: do not decide'}
              </p>
              {c.constitution.markdown !== null ? (
                <pre className="code">{c.constitution.markdown}</pre>
              ) : (
                <p className="muted">The report text needs data class D1.</p>
              )}
            </Card>
          ) : null}
          {c.step === '7.5' || !c.constitution ? checkCard : null}
        </>
      );
    case 'E4':
      return (
        <Card title="The handoff" testId="handoff">
          {c.handoff ? (
            <>
              <KeyValue
                label="What was handed off"
                rows={[
                  ['Handoff', `${c.handoff.code} (#${c.handoff.n})`],
                  ['Trigger', <code key="t">{c.handoff.trigger}</code>],
                  [
                    'From',
                    `${c.handoff.origin_phase}${c.handoff.origin_step ? ` at ${c.handoff.origin_step}` : ''}`,
                  ],
                  [
                    'Handoff Pack',
                    <span key="p">
                      <code>{c.handoff.pack.pack_id}</code>{' '}
                      <code title={c.handoff.pack.content_sha256}>
                        {short(c.handoff.pack.content_sha256, 16)}
                      </code>
                    </span>,
                  ],
                  [
                    'State',
                    c.handoff.status === 'open'
                      ? 'open'
                      : `chosen: ${c.handoff.choice ?? '[unknown]'}`,
                  ],
                ]}
              />
              <p className="ui-eyebrow">The choices the flow allowed when E4 opened</p>
              {c.handoff.valid_choices.length === 0 ? (
                <p className="muted">[unknown]: the item page shows the ones open now.</p>
              ) : (
                <ul className="s7-rules" aria-label="Choices">
                  {c.handoff.valid_choices.map((x) => (
                    <li key={x}>
                      <code>{x}</code>
                    </li>
                  ))}
                </ul>
              )}
            </>
          ) : (
            <p className="muted">
              The handoff of this gate is [unknown]: do not decide it until the item shows it.
            </p>
          )}
        </Card>
      );
    default:
      return checkCard;
  }
}

function DecisionPanel({
  id,
  csrf,
  me,
  card,
  c,
  copy,
  name,
}: {
  id: string;
  csrf: string;
  me: string;
  card: GateCardWire;
  c: GateContextWire;
  copy: Copy;
  name: (p: string) => string;
}) {
  const qc = useQueryClient();
  const [prep, setPrep] = useState<GateCardPreparedWire | null>(null);
  const [evidence, setEvidence] = useState(false);
  const [renew, setRenew] = useState(0);
  const [prepProblem, setPrepProblem] = useState<DecideProblem | null>(null);
  const [proof, setProof] = useState<string | null>(null);
  const [stepNote, setStepNote] = useState<string | null>(null);
  const [read, setRead] = useState(false);
  const [choice, setChoice] = useState<Decision | null>(null);
  const firstReason = card.decision_reason;
  const [reason, setReason] = useState(firstReason ?? '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<DecideProblem | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<readonly LedgerReceipt[] | null>(null);

  const approvals = c.decisions.filter((d) => d.decision === 'approve');
  const iApproved = approvals.some((d) => d.actor === me);
  const iRequested = c.requester === me;
  const open = card.status === 'open' && card.gates.some((g) => g.status === 'pending');
  const decidable = card.may_decide && open && !iApproved && receipt === null;

  // 1. prepare: one nonce per pending gate, bound to the subject this page shows
  useEffect(() => {
    if (!decidable) return;
    let dead = false;
    setPrep(null);
    setEvidence(false);
    setPrepProblem(null);
    api
      .prepareGateCard(id, csrf)
      .then((got) => {
        if (dead) return;
        if (got.gates.some((g) => g.subject_hash !== c.subject_hash)) {
          setPrepProblem({
            kind: 'stale',
            text: 'The gate changed while this page was opening. Reload the page to see the current version.',
            reload: true,
          });
          return;
        }
        setPrep(got);
      })
      .catch((e: unknown) => {
        if (!dead) setPrepProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [decidable, id, csrf, c.subject_hash, renew]);

  // 2. evidence viewed: after the evidence above was rendered (an effect runs after the paint)
  useEffect(() => {
    if (!prep) return;
    let dead = false;
    api
      .gateCardEvidence(
        id,
        prep.gates.map((g) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })),
        csrf,
      )
      .then(() => {
        if (!dead) setEvidence(true);
      })
      .catch((e: unknown) => {
        if (!dead) setPrepProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [prep, id, csrf]);

  // 3. back from the identity provider: collect the step-up proof, once
  const collected = useRef(false);
  useEffect(() => {
    if (collected.current) return;
    const attempt = new URLSearchParams(window.location.search).get('step_up');
    if (!attempt) return;
    collected.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    api
      .stepUpCollect(attempt)
      .then((got) => {
        setProof(got.proof);
        setStepNote('Your identity is confirmed. Choose what you decide below.');
      })
      .catch(() =>
        setStepNote(
          'The identity confirmation could not be collected (it can be used once). Confirm again.',
        ),
      );
  }, []);

  const needsProof = prep?.gates.some((g) => g.step_up.required) ?? c.step_up.required;
  const confirmIdentity = useCallback(async () => {
    const bound = prep?.gates.find((g) => g.step_up.required)?.step_up.bound_hash;
    if (!bound) return;
    setBusy(true);
    try {
      const got = await api.stepUpStart(
        { subject_hash: bound, return_to: window.location.pathname },
        csrf,
      );
      if (got.status === 'redirect') {
        window.location.assign(got.authorize_url);
        return;
      }
      setProof(got.proof);
      setStepNote('Your identity is confirmed. Choose what you decide below.');
    } catch (e) {
      setProblem(explainDecideError(e));
    } finally {
      setBusy(false);
    }
  }, [prep, csrf]);

  async function send(decision: Decision) {
    if (!prep) return;
    setProblem(null);
    const why: string[] = [];
    if (!read) why.push('Tick that you have read the evidence first.');
    if (reason.trim() === '') why.push('Say why, in a sentence: the reason goes on the ledger.');
    if (needsProof && !proof) why.push('Confirm your identity first (step-up).');
    setIssues(why);
    if (why.length > 0) return;
    setBusy(true);
    try {
      const got = await api.decideGateCard(
        id,
        {
          decision,
          reason: reason.trim(),
          votes: prep.gates.map((g) => ({
            nonce: g.nonce,
            ...(g.step_up.required && proof ? { step_up: { proof } } : {}),
          })),
        },
        csrf,
      );
      setReceipt(got.entries);
      setProof(null);
      void qc.invalidateQueries({ queryKey: ['gate-card', id] });
      void qc.invalidateQueries({ queryKey: ['gate-context', id] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (e) {
      const ex = explainDecideError(e);
      setProblem(ex);
      if (ex.kind === 'expired') setRenew((n) => n + 1);
      if (ex.kind === 'step_up') setProof(null);
    } finally {
      setBusy(false);
    }
  }

  if (receipt) {
    return (
      <Card title="Decision recorded on the ledger" testId="decided">
        <Receipt entries={receipt} project={c.project_id} />
        <p>
          <b>What happens now.</b> {copy.after}
        </p>
      </Card>
    );
  }

  // can this person decide it? the PDP's reason first, then the rules the kernel applies
  const cant: string[] = [];
  if (!open) {
    cant.push(
      `This gate is ${card.status.replace('_', ' ')}; nothing more is decided on it.${card.decision_reason ? ` The reason given: ${card.decision_reason}` : ''}`,
    );
  } else if (card.why_not?.code === 'pdp_denied') {
    cant.push(reasonText('card.decide', card.why_not.reasons));
  } else if (card.why_not?.code === 'not_slot_holder' || !card.may_decide) {
    cant.push(
      `You do not hold the ${card.deciders.slots.join(', ')} slot on ${c.project_id}, which decides ${copy.shown}.`,
    );
  }
  if (open && iApproved) {
    cant.push(
      `You approved first (1 of ${c.quorum_required}). The two-person rule needs a different second person.`,
    );
  }
  const can = cant.length === 0;
  const holders = card.deciders.holders;
  return (
    <Card
      title={can ? 'Your decision' : 'Decision'}
      actions={<Pill tone={open ? 'gate' : 'mute'}>{open ? 'open' : card.status}</Pill>}
      testId="decision"
    >
      <section aria-label="Can you decide this">
        <p className="ui-eyebrow">Can you decide this? · as {name(me)}</p>
        {can ? (
          <ul className="s7-rules">
            <li>
              The policy lets you decide {copy.shown} on {c.project_id}.
            </li>
            {iRequested ? (
              <li>
                You asked for this work: the requester decides only when they are the only holder of
                the slot (the entry is stamped sod_waiver).
              </li>
            ) : null}
          </ul>
        ) : (
          <div className="s7-cant" data-testid="cant-decide">
            <p>
              <b>You can&rsquo;t decide this.</b>
            </p>
            {cant.map((t) => (
              <p key={t}>{t}</p>
            ))}
            <p className="muted">
              You can read everything your data class allows; the decision form is only shown to
              someone the policy lets decide. <Link to="/me/access">See my access</Link>
            </p>
          </div>
        )}
      </section>
      <section aria-label="Who can decide">
        <p className="ui-eyebrow">
          Who can decide · {card.deciders.slots.join(', ')} slot on {c.project_id}
        </p>
        {holders.length === 0 ? (
          <p className="muted">
            Nobody holds this slot. A project admin adds one in the role map (M1, plus M6 for an
            approver).
          </p>
        ) : (
          <ul className="plain s7-who" data-testid="deciders">
            {holders.map((h) => (
              <li key={h}>
                {name(h)} {h === me ? <Pill tone="info">you</Pill> : null}
                {h === c.requester ? <Pill tone="mute">requester</Pill> : null}
                {approvals.some((a) => a.actor === h) ? (
                  <Pill tone="ok">approved · 1 of {c.quorum_required}</Pill>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
      {c.quorum_required > 1 ? (
        <section aria-label="Two-person rule" data-testid="two-person">
          <p className="ui-eyebrow">Two-person rule · DEC-28</p>
          <p>
            {approvals.length} of {c.quorum_required} approvals.{' '}
            {approvals[0]
              ? `${name(approvals[0].actor)} approved first (ledger #${approvals[0].ledger_seq}, ${shortTime(approvals[0].at)}). A different holder makes it ${approvals.length + 1} of ${c.quorum_required}.`
              : 'Two different holders must approve; the first approval keeps the gate open.'}
          </p>
        </section>
      ) : null}
      {needsProof ? (
        <section aria-label="Step-up" className="stepup">
          <p className="ui-eyebrow">Step-up</p>
          <p>
            This decision asks you to confirm it is you again (D37); the proof is bound to{' '}
            <code>{c.step_up.bound_hash.slice(0, 10)}</code>.
          </p>
          {stepNote ? <p role="status">{stepNote}</p> : null}
          {can && !proof ? (
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              disabled={busy || prep === null}
              onClick={() => void confirmIdentity()}
            >
              Confirm my identity
            </button>
          ) : null}
          {proof ? <p data-testid="stepup-ready">Identity confirmed for this decision.</p> : null}
        </section>
      ) : null}
      <section aria-label="If nobody decides">
        <p className="ui-eyebrow">If nobody decides</p>
        <p className="muted">
          The gate stays open and the backup approver is told. <b>Expiry never approves.</b>
        </p>
      </section>
      {can ? (
        <DecideForm
          copy={copy}
          read={read}
          setRead={setRead}
          reason={reason}
          setReason={setReason}
          reasonLocked={firstReason !== null}
          choice={choice}
          setChoice={setChoice}
          ready={prep !== null && evidence && !busy}
          busy={busy}
          prepProblem={prepProblem}
          problem={problem}
          issues={issues}
          allowed={card.decisions_allowed}
          send={(d) => void send(d)}
        />
      ) : null}
    </Card>
  );
}

function DecideForm(p: {
  copy: Copy;
  read: boolean;
  setRead: (v: boolean) => void;
  reason: string;
  setReason: (v: string) => void;
  reasonLocked: boolean;
  choice: Decision | null;
  setChoice: (v: Decision) => void;
  ready: boolean;
  busy: boolean;
  prepProblem: DecideProblem | null;
  problem: DecideProblem | null;
  issues: readonly string[];
  allowed: readonly string[];
  send: (d: Decision) => void;
}) {
  const { copy } = p;
  const may = (d: Decision) => p.allowed.includes(d);
  return (
    <section aria-label="Decide" className="s7-form">
      {p.prepProblem ? (
        <div className="notice notice-bad" role="alert">
          <p>{p.prepProblem.text}</p>
          {p.prepProblem.reload ? (
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              onClick={() => window.location.reload()}
            >
              Reload the page
            </button>
          ) : null}
        </div>
      ) : !p.ready && !p.busy ? (
        <p role="status" className="muted">
          Getting the decision form ready…
        </p>
      ) : null}
      {copy.choice ? (
        <fieldset className="s7-choice">
          <legend>Choose one</legend>
          {copy.choice.map((ch) => (
            <label key={ch.id}>
              <input
                type="radio"
                name="gate-choice"
                value={ch.id}
                checked={p.choice === ch.id}
                disabled={!may(ch.id)}
                onChange={() => p.setChoice(ch.id)}
              />
              <span>
                <b>{ch.label}</b> <small>{ch.desc}</small>
              </span>
            </label>
          ))}
        </fieldset>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={p.read} onChange={(e) => p.setRead(e.target.checked)} /> I
        have read the evidence: {copy.readWhat}.
      </label>
      <div className="field">
        <label htmlFor="gate-reason">Reason (required, goes on the ledger)</label>
        <textarea
          id="gate-reason"
          rows={3}
          maxLength={1000}
          value={p.reason}
          readOnly={p.reasonLocked}
          aria-describedby={p.reasonLocked ? 'gate-reason-note' : undefined}
          onChange={(e) => p.setReason(e.target.value)}
        />
        {p.reasonLocked ? (
          <p id="gate-reason-note" className="s7-faint">
            The first decision recorded this reason; a second approver decides the same payload, so
            it is bound again as it is.
          </p>
        ) : null}
      </div>
      {p.problem ? (
        <div className="notice notice-bad" role="alert" data-testid="decide-problem">
          <p>{p.problem.text}</p>
        </div>
      ) : null}
      {p.issues.length > 0 ? (
        <div className="notice notice-bad" role="alert" data-testid="decide-issues">
          <ul>
            {p.issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="actions">
        {copy.choice ? (
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={!p.ready || p.choice === null || !p.read}
            onClick={() => p.choice && p.send(p.choice)}
          >
            {copy.labels.approve}
          </button>
        ) : (
          <>
            {may('approve') ? (
              <button
                type="button"
                className="ui-btn ui-btn-primary"
                disabled={!p.ready || !p.read}
                onClick={() => p.send('approve')}
              >
                {copy.labels.approve}
              </button>
            ) : null}
            {may('request_changes') ? (
              <button
                type="button"
                className="ui-btn"
                disabled={!p.ready}
                onClick={() => p.send('request_changes')}
              >
                {copy.labels.request_changes}
              </button>
            ) : null}
            {may('reject') ? (
              <button
                type="button"
                className="ui-btn btn-danger"
                disabled={!p.ready}
                onClick={() => p.send('reject')}
              >
                {copy.labels.reject}
              </button>
            ) : null}
          </>
        )}
      </div>
      <p className="s7-faint">
        <Pill tone="mute">never automatic</Pill> Nothing is decided until you press one of these
        buttons.
      </p>
    </section>
  );
}
