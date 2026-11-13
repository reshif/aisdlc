import { ItemGovernance } from '../items/Governance';
import { LaneValues, type Lane } from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { useAccess } from '../access';
import { VerifyTab } from '../items/VerifyTab';
import { Tabs, type TabDef } from '../ui';
import { api } from '../api';
import { Badge } from '../components/Badge';
import { Callout, PageError, Loading } from '../components/Notice';
import { describeError } from '../format';
import { ItemGates } from '../items/ItemGates';
import { PlanForm } from '../items/PlanForm';
import { HandoffPanel, showsHandoff } from '../items/HandoffPanel';
import { newKey, waitingText } from '../items/waiting';
import { Link } from '../router';
import { DegradedBanners } from '../components/Degraded';
import { ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { AgentRunsTab } from '../items/AgentRunsTab';
import { DocumentsTab, IntentTab } from '../items/DocumentsTab';
import { RequestTab } from '../items/RequestTab';
import { TimelineTab } from '../items/TimelineTab';

// One work item and what the signed-in person may do with it now (PLAN M12.5): answer S1's questions, give the
// Ready decision (1.6), raise B4 or R2 while the design review (G3d) is open, write the plan after B5. Every
// button is shown only when the bff says the person may (the PDP's yes AND where the item is), pressing one
// sends one signal and nothing happens on its own. The decisions these lead to (G0, E1, G3) are decided on
// their cards, by their own roles, and are in the ledger.

export function ItemPage({ id, csrf }: { id: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['item', id],
    queryFn: () => api.item(id),
    refetchInterval: 5_000,
  });
  if (q.isPending) return <Loading what="the work item" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const it = q.data;
  const lane = it.lane ?? it.proposed_lane;
  return (
    <>
      <p className="crumbs">
        <Link to={`/projects/${it.project_id}`}>{it.project_id}</Link> / work item
      </p>
      <DegradedBanners projects={[it.project_id]} readModels={['work_item']} />
      <h1>Work item</h1>
      <dl className="facts facts-wide">
        <div>
          <dt>Repo</dt>
          <dd>
            <code>{it.repo}</code>
          </dd>
        </div>
        <div>
          <dt>Lane</dt>
          <dd data-testid="item-lane">
            {lane}
            {it.lane === null ? ' (proposed, not yet approved)' : ''}
          </dd>
        </div>
        {it.pull_requests.length > 0 ? (
          <div>
            <dt>Pull request{it.pull_requests.length === 1 ? '' : 's'}</dt>
            <dd data-testid="item-prs">
              {it.pull_requests.map((p) => (
                <span key={`${p.repo}#${p.number}`} className="item-pr">
                  <a href={p.url} target="_blank" rel="noopener noreferrer">
                    #{p.number}
                  </a>{' '}
                  <Badge tone={p.state === 'open' ? 'active' : 'neutral'}>
                    {p.draft ? 'draft' : p.state}
                  </Badge>{' '}
                  head <ShortHash hash={p.head_sha} />
                  {it.pull_requests.length > 1 ? (
                    <span className="muted"> (Unit {p.unit_key})</span>
                  ) : null}{' '}
                </span>
              ))}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>Where it is</dt>
          <dd data-testid="item-phase">
            {it.terminal !== null ? (
              <Badge tone="neutral">{it.terminal}</Badge>
            ) : (
              <Badge tone="active">{it.phase}</Badge>
            )}
          </dd>
        </div>
      </dl>
      {it.terminal === null ? (
        <p data-testid="item-waiting">{waitingText(it.waiting)}</p>
      ) : (
        <p>This item ended{it.terminal_cause ? ` (${it.terminal_cause})` : ''}.</p>
      )}
      {it.holds.length > 0 ? (
        <p className="muted">
          Held: {it.holds.map((h) => h.reason).join(', ')}. It goes on when the hold clears.
        </p>
      ) : null}
      {it.injection_suspected ? (
        <Callout title="The request text looks like it is trying to instruct the factory">
          <p>It is treated as data and was not obeyed.</p>
        </Callout>
      ) : null}

      <ItemGates item={it} />

      <ItemTabs item={it}>
        {showsHandoff(it) ? <HandoffPanel id={id} csrf={csrf} /> : null}
        <Questions item={it} csrf={csrf} />
        {it.may.ready ? <Ready id={id} csrf={csrf} /> : null}
        {it.may.observe ? <Observe id={id} lane={lane} csrf={csrf} /> : null}
        {it.may.plan ? <PlanForm id={id} csrf={csrf} /> : null}
        <ItemGovernance item={it} csrf={csrf} />
      </ItemTabs>
    </>
  );
}

const S7_ON = new Set(['S7', 'S8', 'S8b', 'S9', 'Quarantined']);

/**
 * The item's tabs (P2-1, portal-coverage §2 `item-<KEY>`): what the person may do now, the request as kept, the intent,
 * the documents, the timeline, the agent runs and Verify (S7). The intent, the documents and Verify are content of the
 * work: offered at view level V2 and above on the project (a hint; the bff refuses the read below V2 whatever this
 * shows, and cuts the text to the person's data class). A tab reads its own data only when it is opened.
 */
function ItemTabs({ item, children }: { item: Item; children: ReactNode }) {
  const access = useAccess();
  const level = access.data?.projects.find((p) => p.project_id === item.project_id)?.view_level;
  const fleet = access.data?.fleet.view_level ?? null;
  const v2 = [level, fleet].some((l) => l === 'V2' || l === 'V3');
  const inS7 = S7_ON.has(item.phase);
  const [tab, setTab] = useState<string | null>(null);
  const selected = tab ?? (v2 && inS7 ? 'verify' : 'now');
  const tabs: TabDef[] = [
    { id: 'now', label: 'Now' },
    { id: 'request', label: 'Request' },
    ...(v2 ? [{ id: 'intent', label: 'Intent' }] : []),
    ...(v2 ? [{ id: 'documents', label: 'Documents' }] : []),
    { id: 'timeline', label: 'Timeline' },
    { id: 'runs', label: 'Agent runs' },
    ...(v2 ? [{ id: 'verify', label: 'Verify' }] : []),
  ];
  const id = item.item_id;
  const panel =
    selected === 'request' ? (
      <RequestTab id={id} />
    ) : selected === 'intent' && v2 ? (
      <IntentTab id={id} />
    ) : selected === 'documents' && v2 ? (
      <DocumentsTab id={id} />
    ) : selected === 'timeline' ? (
      <TimelineTab id={id} />
    ) : selected === 'runs' ? (
      <AgentRunsTab id={id} />
    ) : selected === 'verify' && v2 ? (
      <VerifyTab id={id} />
    ) : (
      children
    );
  return (
    <>
      {!v2 && access.isSuccess ? (
        <p className="s7-faint" data-testid="verify-hidden">
          The intent, the documents, S7 results and the Evidence Pack are content of the work: they
          need view level V2 on this project. <Link to="/me/access">See my access</Link>
        </p>
      ) : null}
      <Tabs label="Work item" tabs={tabs} selected={selected} onSelect={setTab}>
        {panel}
      </Tabs>
    </>
  );
}

type Item = Awaited<ReturnType<typeof api.item>>;

function Questions({ item, csrf }: { item: Item; csrf: string }) {
  if (item.questions.length === 0) return null;
  return (
    <section aria-label="Questions">
      <h2>Questions from the factory</h2>
      {item.clarify ? <ClarifyRound c={item.clarify} /> : null}
      <ul className="plain">
        {item.questions.map((q) => (
          <li key={q.question_id} data-testid="question">
            <p>
              <strong>{q.text}</strong>{' '}
              <Badge tone={q.material === 'blocking' ? 'attention' : 'neutral'}>{q.material}</Badge>
            </p>
            {q.answered ? (
              <p className="muted">
                Answered.
                {q.answer_flagged
                  ? ' The answer looks like it tries to instruct the factory; it is read as data, not obeyed.'
                  : ''}
              </p>
            ) : item.may.answer ? (
              <AnswerForm id={item.item_id} question={q.question_id} csrf={csrf} />
            ) : (
              <p className="muted">Waiting for the requester to answer.</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** P2-16 (B1): the round asked, the catalogue's limit, and the date the requester's silence runs to. */
function ClarifyRound({ c }: { c: NonNullable<Item['clarify']> }) {
  const of = c.rounds_max === null ? '' : ` of ${c.rounds_max}`;
  const when = c.deadline === null ? null : shortTime(c.deadline);
  return (
    <p
      data-testid="clarify-round"
      className={c.then === 'abandons' ? 'notice notice-bad' : 'muted'}
    >
      {c.then === 'parks' ? (
        <>
          Round {c.round}
          {of}.{' '}
          {when === null
            ? 'If nobody answers, the item parks.'
            : `If nobody answers, the item parks on ${when}.`}
        </>
      ) : (
        <>
          Parked after round {c.round}
          {of}.{' '}
          {when === null
            ? 'It is abandoned if nobody answers in time.'
            : `It is abandoned on ${when} if nobody answers.`}
        </>
      )}
    </p>
  );
}

function AnswerForm({ id, question, csrf }: { id: string; question: string; csrf: string }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: () => api.itemAnswer(id, { question_id: question, text: text.trim() }, csrf),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['item', id] }),
  });
  return (
    <div className="field">
      <label htmlFor={`answer-${question}`}>Your answer</label>
      <textarea
        id={`answer-${question}`}
        rows={3}
        maxLength={20000}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {send.isError ? (
        <p role="alert" className="notice notice-bad">
          {describeError(send.error)}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={send.isPending || text.trim() === ''}
          onClick={() => send.mutate()}
        >
          Send answer
        </button>
      </div>
    </div>
  );
}

function Ready({ id, csrf }: { id: string; csrf: string }) {
  const qc = useQueryClient();
  const send = useMutation({
    mutationFn: () => api.itemReady(id, csrf),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['item', id] }),
  });
  return (
    <section aria-label="Ready decision" className="decide">
      <h2>Is this ready?</h2>
      <p className="muted">
        The factory has classified the request and written its intent. Saying it is ready sends it
        to the first approval (G0 and G1); it does not approve anything.
      </p>
      {send.isError ? (
        <p role="alert" className="notice notice-bad">
          {describeError(send.error)}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={send.isPending}
          onClick={() => send.mutate()}
        >
          Say it is ready
        </button>
      </div>
    </section>
  );
}

/** Lanes below the current one: R2 only ever goes to a smaller lane. */
const SMALLER = (lane: Lane): Lane[] =>
  LaneValues.filter((l) => l !== 'L0' && l !== 'L7' && l !== 'L8' && l < lane);

function Observe({ id, lane, csrf }: { id: string; lane: Lane; csrf: string }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<'spec_gap' | 'spec_ambiguous'>('spec_gap');
  const smaller = SMALLER(lane);
  const [to, setTo] = useState<Lane | ''>(smaller.at(-1) ?? '');
  const done = () => void qc.invalidateQueries({ queryKey: ['item', id] });
  const b4 = useMutation({
    mutationFn: () => api.itemObserve(id, { edge: 'B4', reason_code: reason, key: newKey() }, csrf),
    onSuccess: done,
  });
  const r2 = useMutation({
    mutationFn: () =>
      api.itemObserve(
        id,
        { edge: 'R2', to_lane: to as Lane, reason_code: 'smaller_than_lane', key: newKey() },
        csrf,
      ),
    onSuccess: done,
  });
  return (
    <section aria-label="What the design review found" className="decide">
      <h2>What the design review found</h2>
      <p className="muted">
        While the design is under review you can tell the factory what you saw. Neither button
        decides the design: it stays open for its own decision.
      </p>
      <fieldset className="plain-fieldset">
        <legend>The design shows a gap in the spec</legend>
        <div className="field">
          <label htmlFor="b4-reason">What is wrong with the spec</label>
          <select
            id="b4-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
          >
            <option value="spec_gap">Something the design needs is missing from it</option>
            <option value="spec_ambiguous">It can be read two ways</option>
          </select>
        </div>
        {b4.isError ? (
          <p role="alert" className="notice notice-bad">
            {describeError(b4.error)}
          </p>
        ) : null}
        {b4.isSuccess ? (
          <p role="status">Sent: the spec goes back to be fixed (once only).</p>
        ) : null}
        <div className="actions">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={b4.isPending}
            onClick={() => b4.mutate()}
          >
            Send the spec back (B4)
          </button>
        </div>
      </fieldset>
      <fieldset className="plain-fieldset">
        <legend>The work is smaller than its lane</legend>
        {smaller.length === 0 ? (
          <p className="muted">There is no smaller lane to move this to.</p>
        ) : (
          <>
            <div className="field">
              <label htmlFor="r2-lane">Move it to lane</label>
              <select id="r2-lane" value={to} onChange={(e) => setTo(e.target.value as Lane)}>
                {smaller.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </div>
            <p className="muted">
              This asks the exception approver (E1) to agree. Only if they approve does the item go
              back to classification.
            </p>
            {r2.isError ? (
              <p role="alert" className="notice notice-bad">
                {describeError(r2.error)}
              </p>
            ) : null}
            {r2.isSuccess ? <p role="status">Sent: waiting for the E1 decision.</p> : null}
            <div className="actions">
              <button
                type="button"
                className="btn btn-quiet"
                disabled={r2.isPending || to === ''}
                onClick={() => r2.mutate()}
              >
                Ask for a smaller lane (R2)
              </button>
            </div>
          </>
        )}
      </fieldset>
    </section>
  );
}
