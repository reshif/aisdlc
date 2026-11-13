import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CONSOLE_MESSAGE_MAX,
  label,
  pdpResource,
  type ConsoleSessionState,
  type ConsoleSessionView,
  type ConsoleStateCause,
  type OnboardingSummaryView,
} from '@aisdlc/contracts';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Guarded } from '../access';
import { describeError } from '../format';
import { Card, EmptyState, KeyValue, Pill, type PillTone } from '../ui';
import { Blockers } from './Blockers';
import { onboardApi } from './api';
import { Proposals } from './Proposals';

// The onboarding console (docs/design/onboarding-console.md, P3): one place to work an onboarding with the onboarder.
// Three panes: the PLAN (what is in the way and whose move it is, from the deterministic blocker graph), the
// CONVERSATION (what you and the onboarder said, and what the factory observed), and the EVIDENCE (what the factory
// read). The onboarder reads, explains and proposes; it decides nothing. Every decision is still yours, in the
// "Summary and sign-off" tab and the approval cards. Nothing here changes a gate.

const STATE_WORD: Readonly<Record<ConsoleSessionState, { text: string; tone: PillTone }>> = {
  running: { text: 'Working', tone: 'agent' },
  awaiting_person: { text: 'Waiting for you', tone: 'human' },
  paused: { text: 'Paused', tone: 'warn' },
  stopped: { text: 'Stopped', tone: 'mute' },
  done: { text: 'Done', tone: 'ok' },
};

const CAUSE_WORD: Readonly<Record<ConsoleStateCause, string>> = {
  person: 'by a person',
  agent_asked: 'the onboarder asked',
  record_changed: 'something changed',
  kill_switch: 'an emergency stop is on',
  budget: 'its budget is spent',
  disabled: 'it is switched off',
  onboarding_closed: 'the onboarding is over',
  error: 'something went wrong',
};

const WHO: Readonly<Record<string, string>> = {
  person: 'You',
  agent: 'Onboarder',
  observation: 'The factory noticed',
};

export function stateWord(s: ConsoleSessionState): string {
  return STATE_WORD[s].text;
}

export function ConsoleTab({ v, csrf }: { v: OnboardingSummaryView; csrf: string }) {
  const id = v.s0_id;
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['console', id],
    queryFn: () => onboardApi.console(id),
    retry: false,
    refetchInterval: (x) => {
      const s = x.state.data?.state;
      return s === 'running' ? 4000 : s === 'awaiting_person' || s === 'paused' ? 15000 : false;
    },
  });
  const set = (view: ConsoleSessionView) => {
    qc.setQueryData(['console', id], view);
    // what is in the way may have moved with it
    void qc.invalidateQueries({ queryKey: ['onboard-blockers', id] });
  };
  const start = useMutation({
    mutationFn: () => onboardApi.consoleStart(id, csrf),
    onSuccess: set,
  });

  if (q.isPending) return <p className="ui-help">Opening the console…</p>;
  if (q.isError) {
    return (
      <EmptyState title="The console is not available">
        {describeError(q.error)} The summary and sign-off tab works without it.
      </EmptyState>
    );
  }
  return (
    <div className="ui-split oc-grid" data-testid="console">
      <section className="oc-plan" aria-label="Plan">
        <h2 className="oc-h">Plan</h2>
        <PlanPane id={id} />
      </section>
      <section className="oc-chat" aria-label="Conversation">
        {q.data === null ? (
          <Card title="Work this onboarding with the onboarder" testId="console-start">
            <p>
              The onboarder reads what the factory found, says what is in the way and whose move it
              is, and proposes what to do. It never decides: you decide, in the approval cards.
            </p>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              onClick={() => start.mutate()}
              disabled={start.isPending}
            >
              {start.isPending ? 'Starting…' : 'Start the console'}
            </button>
            {start.isError ? (
              <p role="alert" className="ui-help">
                {describeError(start.error)}
              </p>
            ) : null}
          </Card>
        ) : (
          <Conversation view={q.data} csrf={csrf} onView={set} />
        )}
      </section>
      <section className="oc-evidence" aria-label="Evidence">
        <h2 className="oc-h">Evidence</h2>
        <EvidencePane v={v} />
      </section>
    </div>
  );
}

function PlanPane({ id }: { id: string }) {
  const q = useQuery({
    queryKey: ['onboard-blockers', id],
    queryFn: () => onboardApi.blockers(id),
    retry: false,
    refetchInterval: 15000,
  });
  if (q.isPending) return <p className="ui-help">Reading what is in the way…</p>;
  if (!q.data) return <p className="ui-help">What is in the way could not be read.</p>;
  if (q.data.blockers.length === 0) {
    return (
      <p data-testid="plan-clear">
        {q.data.ready
          ? 'Nothing is in the way.'
          : 'Nothing is listed yet; the factory is still reading the repo.'}
      </p>
    );
  }
  return <Blockers id={id} />;
}

function Conversation({
  view,
  csrf,
  onView,
}: {
  view: ConsoleSessionView;
  csrf: string;
  onView: (v: ConsoleSessionView) => void;
}) {
  const id = view.s0_id;
  const inputId = useId();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement | null>(null);
  const say = useMutation({
    mutationFn: (t: string) => onboardApi.consoleSay(id, t, csrf),
    onSuccess: (r) => {
      setText('');
      onView(r);
    },
  });
  const steer = useMutation({
    mutationFn: (a: 'pause' | 'resume' | 'stop') => onboardApi.consoleSteer(id, a, csrf),
    onSuccess: onView,
  });
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [view.turns.length]);

  const state = STATE_WORD[view.state];
  const closed = view.state === 'stopped' || view.state === 'done';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (t !== '' && !say.isPending) say.mutate(t);
  };
  const resource = pdpResource.project(view.project_id);
  return (
    <>
      <div className="oc-bar">
        <span data-testid="console-state" data-state={view.state}>
          <Pill tone={state.tone}>{state.text}</Pill>
        </span>
        {view.cause !== null && view.state !== 'awaiting_person' ? (
          <span className="ui-help">{CAUSE_WORD[view.cause]}</span>
        ) : null}
        <span className="oc-spacer" />
        {view.state === 'paused' ? (
          <Guarded action="onboarding.console.steer" resource={resource} label="Resume">
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              onClick={() => steer.mutate('resume')}
              disabled={steer.isPending}
            >
              Resume
            </button>
          </Guarded>
        ) : null}
        {view.state === 'running' || view.state === 'awaiting_person' ? (
          <Guarded action="onboarding.console.steer" resource={resource} label="Pause">
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              onClick={() => steer.mutate('pause')}
              disabled={steer.isPending}
            >
              Pause
            </button>
          </Guarded>
        ) : null}
        {!closed ? (
          <Guarded action="onboarding.console.steer" resource={resource} label="Stop">
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              onClick={() => steer.mutate('stop')}
              disabled={steer.isPending}
            >
              Stop
            </button>
          </Guarded>
        ) : null}
      </div>
      {steer.isError ? (
        <p role="alert" className="ui-help">
          {describeError(steer.error)}
        </p>
      ) : null}
      <div className="oc-log" role="log" aria-live="polite" aria-label="Conversation" tabIndex={0}>
        {view.turns.length === 0 ? <p className="ui-help">Nothing said yet.</p> : null}
        {view.turns.map((t) => (
          <article key={t.seq} className={`oc-turn oc-${t.role}`} data-role={t.role}>
            <h3 className="oc-who">{WHO[t.role] ?? t.role}</h3>
            <p className="oc-text">{t.text}</p>
            <Proposals
              s0={id}
              items={view.proposals.filter((p) => p.turn_seq === t.seq && p.state !== 'superseded')}
              csrf={csrf}
              onView={onView}
            />
          </article>
        ))}
        {say.isPending || view.state === 'running' ? (
          <p className="ui-help" data-testid="console-working">
            The onboarder is looking…
          </p>
        ) : null}
        <div ref={end} />
      </div>
      <form className="oc-composer" onSubmit={submit}>
        <label className="ui-label" htmlFor={inputId}>
          Tell the onboarder
        </label>
        <textarea
          id={inputId}
          className="ui-input"
          rows={3}
          value={text}
          maxLength={CONSOLE_MESSAGE_MAX}
          disabled={closed}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
          }}
        />
        <div className="oc-bar">
          <span className="ui-help">
            It may ask you things and explain; it never decides for you. Do not paste secrets.
          </span>
          <span className="oc-spacer" />
          <button
            type="submit"
            className="ui-btn ui-btn-primary"
            disabled={closed || say.isPending || text.trim() === ''}
          >
            {say.isPending ? 'Sending…' : 'Send'}
          </button>
        </div>
        {say.isError ? (
          <p role="alert" className="ui-help">
            {describeError(say.error)}
          </p>
        ) : null}
      </form>
    </>
  );
}

function EvidencePane({ v }: { v: OnboardingSummaryView }) {
  return (
    <div className="oc-ev">
      {v.census ? (
        <Card title="What the factory read" testId="evidence-census">
          <KeyValue
            rows={[
              ['Scan result', v.census.posture],
              ['Lowest risk allowed', label('tier', v.census.tier_floor)],
              ['Commit read', <code key="c">{v.census.baseline_sha.slice(0, 7)}</code>],
              ['Gaps', String(v.census.gaps.length)],
            ]}
          />
        </Card>
      ) : (
        <p className="ui-help">The factory has not read the repo yet.</p>
      )}
      {v.controls ? (
        <Card title="GitHub controls" testId="evidence-controls">
          <ul className="ob-list">
            {v.controls.rows.map((c) => (
              <li key={c.id}>
                <span>
                  {c.id.replaceAll('_', ' ')}{' '}
                  <Pill tone={c.status === 'met' ? 'ok' : c.blocking ? 'bad' : 'warn'}>
                    {c.status}
                  </Pill>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {v.fixes.length > 0 ? (
        <Card title="Proposed fixes" testId="evidence-fixes">
          <ul className="ob-list">
            {v.fixes.map((f) => (
              <li key={f.fix_id}>
                <strong>{f.title}</strong>
                <span className="ui-help">{f.state.replaceAll('_', ' ')}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      {v.agent ? (
        <Card title="What the agent found" testId="evidence-agent">
          <p>{v.agent.summary}</p>
        </Card>
      ) : null}
    </div>
  );
}
