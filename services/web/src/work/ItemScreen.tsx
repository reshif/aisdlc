import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LaneValues,
  label,
  lookupTerm,
  type GateId,
  type Lane,
  type PortalItemView,
  type StageId,
} from '@aisdlc/contracts';
import { useState, type ReactNode } from 'react';
import { ApiError, api, type Me } from '../api';
import { useAccess } from '../access';
import { DegradedBanners } from '../components/Degraded';
import { describeError } from '../format';
import { AgentRunsTab } from '../items/AgentRunsTab';
import { DocumentsTab, IntentTab } from '../items/DocumentsTab';
import { ItemGovernance } from '../items/Governance';
import { HandoffPanel, showsHandoff } from '../items/HandoffPanel';
import { PlanForm } from '../items/PlanForm';
import { RequestTab } from '../items/RequestTab';
import { TimelineTab } from '../items/TimelineTab';
import { VerifyTab } from '../items/VerifyTab';
import { newKey } from '../items/waiting';
import { Link } from '../router';
import {
  Card,
  CodeChip,
  ErrorState,
  PageHeader,
  Pill,
  PropertiesPanel,
  StageStrip,
  Tabs,
  type StageMark,
  type TabDef,
} from '../ui';
import { Forbidden, renderCrumb } from './HomeScreen';
import {
  dateText,
  gateName,
  inboxHref,
  itemNo,
  showsCodes,
  stageOfPhase,
  STRIP_STAGES,
  waitingSentence,
  wire,
} from './words';
import './work.css';

// A work item (screen-map §2.4, skeleton screen 3): above the tabs the Now box (what is happening in one sentence and
// the one thing this viewer can do), the stage strip (skipped stages grey), the approvals of this item's route only
// (its project's settings at the time it started); then the tabs, and beside them its properties and what I may do.
// Every button shows only when the bff says the person may, and the server decides again.

type Item = PortalItemView;

/** The stages of the item's track in its pinned process version; `null` while unknown. */
function useRouteStages(item: Item | undefined): readonly StageId[] | null {
  const cat = useQuery({
    queryKey: ['catalogue'],
    queryFn: () => api.catalogue(),
    staleTime: 300_000,
    retry: false,
  });
  if (!item || !cat.data) return null;
  const v = cat.data.versions.find((x) => x.ref.version === item.catalogue_ref.version);
  const lane = v?.lanes.find((l) => l.lane === (item.lane ?? item.proposed_lane));
  return lane ? lane.stages : null;
}

export function ItemScreen({ id, me, csrf }: { id: string; me: Me; csrf: string }) {
  const q = useQuery({
    queryKey: ['item', id],
    queryFn: () => api.item(id),
    refetchInterval: 5_000,
    retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
  });
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: () => api.inbox() });
  const stages = useRouteStages(q.data);
  if (q.isPending) return <p className="wk-muted">Loading the work item…</p>;
  if (q.isError) {
    const e = q.error;
    if (e instanceof ApiError && e.status === 403) return <Forbidden reason={e.message} />;
    if (e instanceof ApiError && e.status === 404) {
      return <ErrorState status={404} action={<Link to="/items">Back to items</Link>} />;
    }
    return (
      <p role="alert" className="wk-bad">
        The work item could not load. Try again in a moment.
      </p>
    );
  }
  const it = q.data;
  const lane = it.lane ?? it.proposed_lane;
  const codes = showsCodes(me.actions.fleet);
  const current = it.terminal === null ? stageOfPhase(it.phase) : null;
  const route = stages ?? STRIP_STAGES;
  const marks: Partial<Record<StageId, StageMark>> = {};
  if (stages) for (const s of STRIP_STAGES) if (!stages.includes(s)) marks[s] = 'skipped';
  if (it.terminal === 'Done') for (const s of route) marks[s] = 'done';
  // the one thing I can decide on this item now, from my inbox
  const mine = (inbox.data?.decide ?? []).find((i) => i.item_id === it.item_id);
  const status = it.terminal !== null ? wire('phase', it.terminal) : wire('phase', it.phase);
  return (
    <div className="wk-page" data-testid="item">
      <PageHeader
        crumbs={[
          { label: it.project_id, to: `/projects/${encodeURIComponent(it.project_id)}` },
          { label: label('screen', 'items'), to: '/items' },
          { label: `Item ${itemNo(it.item_id)}` },
        ]}
        renderLink={renderCrumb}
        title={`Item ${itemNo(it.item_id)}`}
        status={
          <>
            <Pill tone={it.terminal !== null ? 'mute' : it.holds.length > 0 ? 'warn' : 'info'}>
              {status}
            </Pill>
            {it.pull_requests.map((p) => (
              <a
                key={`${p.repo}#${p.number}`}
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                Pull request #{p.number}
              </a>
            ))}
          </>
        }
        meta={
          <>
            {it.repo} · {label('concept', 'lane')}: {wire('lane', lane)}
            {it.lane === null ? ' (proposed)' : ''}
          </>
        }
      />

      <DegradedBanners projects={[it.project_id]} readModels={['work_item']} />

      <Card title="Now" className="wk-now" testId="item-now">
        <p className="wk-lead" data-testid="item-waiting">
          {waitingSentence(it.waiting, it.terminal)}
        </p>
        {it.holds.length > 0 ? (
          <p>
            {label('status', 'held')}: {it.holds.map((h) => wire('hold', h.reason)).join(', ')}. It
            goes on by itself when this clears.
          </p>
        ) : null}
        {it.injection_suspected ? (
          <p className="wk-bad">
            The request text looks like it tries to instruct the factory. It is read as data and was
            not obeyed.
          </p>
        ) : null}
        {mine ? (
          <p>
            <Link className="ui-btn ui-btn-primary" to={inboxHref(mine)} data-testid="now-decide">
              Decide: {gateName(mine.gate)}
            </Link>
          </p>
        ) : null}
      </Card>

      <StageStrip
        stages={STRIP_STAGES}
        current={current && route.includes(current) ? current : null}
        marks={marks}
        {...(it.waiting?.startsWith('gates:') ? { waitingOn: 'waiting for an approval' } : {})}
      />

      <RouteApprovals item={it} codes={codes} />

      <div className="ui-split">
        <ItemTabs item={it}>
          <NowActions item={it} csrf={csrf} lane={lane} />
        </ItemTabs>
        <PropertiesPanel
          rows={[
            { label: label('concept', 'lane'), value: wire('lane', lane) },
            { label: label('concept', 'repo'), value: it.repo },
            {
              label: label('concept', 'catalogue'),
              value: it.catalogue_ref.version,
            },
            {
              label: 'Pull requests',
              value:
                it.pull_requests.length === 0 ? (
                  'None yet'
                ) : (
                  <span data-testid="item-prs">
                    {it.pull_requests.map((p) => (
                      <span key={p.number} className="wk-row">
                        <a href={p.url} target="_blank" rel="noopener noreferrer">
                          #{p.number}
                        </a>
                        <span className="wk-muted">
                          {p.draft ? 'draft' : p.state} · commit {p.head_sha.slice(0, 7)}
                        </span>
                      </span>
                    ))}
                  </span>
                ),
            },
            {
              label: 'Approvals',
              value: `${it.gates.filter((g) => g.status === 'decided').length} decided, ${it.gates.filter((g) => g.status === 'pending').length} waiting`,
            },
            { label: 'Rework', value: `${it.rework_total} sent back` },
            {
              label: 'Questions',
              value:
                it.questions.length === 0
                  ? 'None'
                  : `${it.questions.filter((x) => x.answered).length} of ${it.questions.length} answered`,
            },
          ]}
          actionsTitle="What you can do"
          actions={<MayList item={it} decide={mine ? gateName(mine.gate) : null} />}
        />
      </div>
    </div>
  );
}

/** What this person may do on the item, in words (each is on the Now tab). */
function MayList({ item, decide }: { item: Item; decide: string | null }) {
  const may: string[] = [];
  if (decide) may.push(`Decide: ${decide}`);
  if (item.may.answer && item.questions.some((q) => !q.answered)) may.push('Answer the questions');
  if (item.may.ready) may.push('Say it is ready');
  if (item.may.observe) may.push('Raise a concern about the spec');
  if (item.may.plan) may.push('Write the plan');
  return may.length === 0 ? (
    <p className="wk-muted">Nothing for you to do on this item right now.</p>
  ) : (
    <ul className="wk-list">
      {may.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

/** The approvals on this item's route only: waiting, decided (how), not reached yet, raised by a step, or off. */
function RouteApprovals({ item, codes }: { item: Item; codes: boolean }) {
  const pg = item.profile_gates;
  const latest = new Map<string, Item['gates'][number]>();
  for (const g of item.gates) latest.set(g.gate, g);
  const order: GateId[] = [...(pg?.on ?? [])];
  for (const g of item.gates) if (!order.includes(g.gate)) order.push(g.gate);
  return (
    <section aria-label="Approvals of this item" data-testid="item-gates">
      <ul className="wk-gates">
        {order.map((g) => {
          const at = latest.get(g);
          const state = !at
            ? 'later'
            : at.status === 'pending'
              ? 'waiting'
              : at.outcome === 'approve'
                ? 'approved'
                : 'refused';
          const text =
            state === 'later'
              ? 'Not reached yet'
              : state === 'waiting'
                ? label('gateStatus', 'pending')
                : (lookupTerm('decision', at?.outcome ?? '')?.label ??
                  label('gateStatus', 'decided'));
          return (
            <li key={g} data-gate={g} data-state={state} title={lookupTerm('gate', g)?.explain}>
              <span>{gateName(g)}</span>
              {codes ? <CodeChip code={g} /> : null}
              <Pill
                tone={
                  state === 'approved'
                    ? 'ok'
                    : state === 'waiting'
                      ? 'gate'
                      : state === 'refused'
                        ? 'bad'
                        : 'mute'
                }
              >
                {text}
              </Pill>
              {state === 'waiting' && at?.card_id ? (
                <Link to={`/decide/${encodeURIComponent(at.card_id)}`}>
                  Open<span className="ui-sr">: {gateName(g)}</span>
                </Link>
              ) : null}
            </li>
          );
        })}
        {(pg?.off ?? []).map((g) => (
          <li
            key={`off-${g}`}
            data-gate={g}
            data-state="off"
            title={lookupTerm('decideWord', 'switched_off')?.explain}
          >
            <span>{gateName(g)}</span>
            <span>{label('decideWord', 'switched_off')}</span>
          </li>
        ))}
      </ul>
      {pg === null ? (
        <p className="wk-muted" data-testid="route-gates-unknown">
          Which approvals this item's track has is unknown: its process version cannot be read.
        </p>
      ) : null}
    </section>
  );
}

const TAB_NOW = 'now';

/**
 * The tabs: Now, Request, Documents, Agent console, Verify, Timeline. Documents and Verify are the content of the
 * work: offered at view level "Content" and above on the project (a hint; the bff refuses the read below it whatever
 * this shows, and cuts the text to the person's data class).
 */
function ItemTabs({ item, children }: { item: Item; children: ReactNode }) {
  const access = useAccess();
  const level = access.data?.projects.find((p) => p.project_id === item.project_id)?.view_level;
  const fleet = access.data?.fleet.view_level ?? null;
  const content = [level, fleet].some((l) => l === 'V2' || l === 'V3');
  const [tab, setTab] = useState<string>(TAB_NOW);
  const tabs: TabDef[] = [
    { id: TAB_NOW, label: 'Now' },
    { id: 'request', label: 'Request' },
    ...(content ? [{ id: 'documents', label: 'Documents' }] : []),
    { id: 'console', label: 'Agent console' },
    ...(content ? [{ id: 'verify', label: 'Verify' }] : []),
    { id: 'timeline', label: 'Timeline' },
  ];
  const id = item.item_id;
  const panel =
    tab === 'request' ? (
      <RequestTab id={id} />
    ) : tab === 'documents' && content ? (
      <div className="wk-page">
        <IntentTab id={id} />
        <DocumentsTab id={id} />
      </div>
    ) : tab === 'console' ? (
      <AgentRunsTab id={id} />
    ) : tab === 'verify' && content ? (
      <VerifyTab id={id} />
    ) : tab === 'timeline' ? (
      <TimelineTab id={id} />
    ) : (
      children
    );
  return (
    <div className="wk-page">
      {!content && access.isSuccess ? (
        <p className="wk-muted" data-testid="verify-hidden">
          The documents and the checks are the content of the work: they need the view level{' '}
          {label('viewLevel', 'V2').toLowerCase()} on this project.{' '}
          <Link to="/me/access">See my access</Link>
        </p>
      ) : null}
      <Tabs label="Work item" tabs={tabs} selected={tab} onSelect={setTab}>
        {panel}
      </Tabs>
    </div>
  );
}

/** The Now tab: questions, ready, a concern during design review, the plan by hand, the handover, release. */
function NowActions({ item, csrf, lane }: { item: Item; csrf: string; lane: Lane }) {
  const any =
    showsHandoff(item) ||
    item.questions.length > 0 ||
    item.may.ready ||
    item.may.observe ||
    item.may.plan;
  return (
    <div className="wk-page">
      {!any ? (
        <p className="wk-muted" data-testid="now-nothing">
          {item.terminal !== null
            ? 'This item has ended. Its final record is below when there is one.'
            : 'Nothing is asked of you here now. This page follows the item as it moves.'}
        </p>
      ) : null}
      {showsHandoff(item) ? <HandoffPanel id={item.item_id} csrf={csrf} /> : null}
      <Questions item={item} csrf={csrf} />
      {item.may.ready ? <Ready id={item.item_id} csrf={csrf} /> : null}
      {item.may.observe ? <Observe id={item.item_id} lane={lane} csrf={csrf} /> : null}
      {item.may.plan ? <PlanForm id={item.item_id} csrf={csrf} /> : null}
      <ItemGovernance item={item} csrf={csrf} />
    </div>
  );
}

function Questions({ item, csrf }: { item: Item; csrf: string }) {
  if (item.questions.length === 0) return null;
  const c = item.clarify;
  return (
    <Card title="Questions from the factory" testId="item-questions">
      {c ? (
        <p data-testid="clarify-round" className={c.then === 'abandons' ? 'wk-bad' : 'wk-muted'}>
          {c.then === 'parks'
            ? `Round ${c.round}${c.rounds_max === null ? '' : ` of ${c.rounds_max}`}. If nobody answers${c.deadline === null ? '' : ` by ${dateText(c.deadline)}`}, the item pauses.`
            : `Paused after round ${c.round}. It ends if nobody answers${c.deadline === null ? ' in time' : ` by ${dateText(c.deadline)}`}.`}
        </p>
      ) : null}
      <ul className="wk-list">
        {item.questions.map((q) => (
          <li key={q.question_id} data-testid="question" style={{ display: 'grid' }}>
            <p>
              <strong>{q.text}</strong>{' '}
              <Pill tone={q.material === 'blocking' ? 'warn' : 'neutral'}>
                {q.material === 'blocking' ? 'Needed to go on' : 'Nice to know'}
              </Pill>
            </p>
            {q.answered ? (
              <p className="wk-muted">
                Answered.
                {q.answer_flagged
                  ? ' The answer looks like it tries to instruct the factory; it is read as data, not obeyed.'
                  : ''}
              </p>
            ) : item.may.answer ? (
              <AnswerForm id={item.item_id} question={q.question_id} csrf={csrf} />
            ) : (
              <p className="wk-muted">Waiting for the requester to answer.</p>
            )}
          </li>
        ))}
      </ul>
    </Card>
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
    <div className="wk-field">
      <label htmlFor={`answer-${question}`} className="ui-label">
        Your answer
      </label>
      <textarea
        id={`answer-${question}`}
        className="ui-input"
        rows={3}
        maxLength={20000}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {send.isError ? (
        <p role="alert" className="wk-bad">
          {describeError(send.error)}
        </p>
      ) : null}
      <div className="wk-actions">
        <button
          type="button"
          className="ui-btn ui-btn-primary"
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
    <Card title="Is this ready?" testId="item-ready">
      <p className="wk-muted">
        The factory has sized the request and written its goal. Saying it is ready sends it to its
        first approvals ({label('gate', 'G0')}, {label('gate', 'G1').toLowerCase()}); it approves
        nothing itself.
      </p>
      {send.isError ? (
        <p role="alert" className="wk-bad">
          {describeError(send.error)}
        </p>
      ) : null}
      <button
        type="button"
        className="ui-btn ui-btn-primary"
        disabled={send.isPending}
        onClick={() => send.mutate()}
      >
        Say it is ready
      </button>
    </Card>
  );
}

/** Tracks lighter than the current one ("Allow a lighter track" only ever goes down). */
const LIGHTER = (lane: Lane): Lane[] =>
  LaneValues.filter((l) => l !== 'L0' && l !== 'L7' && l !== 'L8' && l < lane);

function Observe({ id, lane, csrf }: { id: string; lane: Lane; csrf: string }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState<'spec_gap' | 'spec_ambiguous'>('spec_gap');
  const lighter = LIGHTER(lane);
  const [to, setTo] = useState<Lane | ''>(lighter.at(-1) ?? '');
  const done = () => void qc.invalidateQueries({ queryKey: ['item', id] });
  const gap = useMutation({
    mutationFn: () => api.itemObserve(id, { edge: 'B4', reason_code: reason, key: newKey() }, csrf),
    onSuccess: done,
  });
  const down = useMutation({
    mutationFn: () =>
      api.itemObserve(
        id,
        { edge: 'R2', to_lane: to as Lane, reason_code: 'smaller_than_lane', key: newKey() },
        csrf,
      ),
    onSuccess: done,
  });
  return (
    <Card title="Raise a concern" testId="item-observe">
      <p className="wk-muted">
        While the design is under review you can tell the factory what you saw. Neither button
        decides the design: it stays open for its own decision.
      </p>
      <fieldset className="plain-fieldset">
        <legend>The design shows a gap in the spec</legend>
        <div className="wk-field">
          <label htmlFor="b4-reason" className="ui-label">
            What is wrong with the spec
          </label>
          <select
            id="b4-reason"
            className="ui-input ui-select"
            value={reason}
            onChange={(e) => setReason(e.target.value as typeof reason)}
          >
            <option value="spec_gap">Something the design needs is missing from it</option>
            <option value="spec_ambiguous">It can be read two ways</option>
          </select>
        </div>
        {gap.isError ? (
          <p role="alert" className="wk-bad">
            {describeError(gap.error)}
          </p>
        ) : null}
        {gap.isSuccess ? (
          <p role="status">Sent: the spec goes back to be fixed (once only).</p>
        ) : null}
        <button
          type="button"
          className="ui-btn"
          disabled={gap.isPending}
          onClick={() => gap.mutate()}
        >
          Send the spec back
        </button>
      </fieldset>
      <fieldset className="plain-fieldset">
        <legend>The work is smaller than its track</legend>
        {lighter.length === 0 ? (
          <p className="wk-muted">There is no lighter track to move this to.</p>
        ) : (
          <>
            <div className="wk-field">
              <label htmlFor="r2-lane" className="ui-label">
                Move it to
              </label>
              <select
                id="r2-lane"
                className="ui-input ui-select"
                value={to}
                onChange={(e) => setTo(e.target.value as Lane)}
              >
                {lighter.map((l) => (
                  <option key={l} value={l}>
                    {wire('lane', l)}
                  </option>
                ))}
              </select>
            </div>
            <p className="wk-muted">
              The exception approver decides {label('gate', 'E1').toLowerCase()}; only if they
              approve is the track picked again.
            </p>
            {down.isError ? (
              <p role="alert" className="wk-bad">
                {describeError(down.error)}
              </p>
            ) : null}
            {down.isSuccess ? <p role="status">Sent: waiting for the exception approver.</p> : null}
            <button
              type="button"
              className="ui-btn"
              disabled={down.isPending || to === ''}
              onClick={() => down.mutate()}
            >
              Ask for a lighter track
            </button>
          </>
        )}
      </fieldset>
    </Card>
  );
}
