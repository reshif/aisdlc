import {
  label,
  lookupTerm,
  type HandoffChoice,
  type HumanWorkReference,
  type PortalItemHandoffView,
} from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, KeyValue, Pill } from '../ui';
import { ago, wire } from '../work/words';
import { newKey } from './waiting';

// When the agents stop and hand the work to a person (glossary §9.2): why they stopped, the approval "Choose what
// happens next" that its owner takes first, the choices the flow allows once it is approved, and while a person does
// the work: "Mark my work done" with the PR or commit, and the one "Hand back". Every button is shown only when the
// bff says the person may; the server decides every write again (the PDP, then the decision log: only who approved
// the handover records the choice).

/** What each choice does, in words (the vocabulary is the contract's `HandoffChoice`). */
const CHOICE_TEXT: Readonly<Record<HandoffChoice, { label: string; desc: string }>> = {
  resume: {
    label: 'Answer and resume',
    desc: 'The agent builds again in a new sandbox, within the same budget.',
  },
  extend: {
    label: 'Ask for more budget',
    desc: 'Once only: an approver decides "Allow more budget", then the agent builds again.',
  },
  replan: { label: 'Re-plan', desc: 'Back to the plan; "Approve the plan" decides the new one.' },
  respec: {
    label: 'Rewrite spec',
    desc: 'Back to the spec; "Approve the spec" decides the new one.',
  },
  takeover: {
    label: 'Take over',
    desc: 'A person does the work ("Done by a person" track); it can be handed back once.',
  },
  hand_over_close: {
    label: 'Take it outside the factory',
    desc: 'A developer does the work outside the factory and the item closes here.',
  },
  abandon: { label: 'Stop the work', desc: 'The item ends as abandoned.' },
};

const handoffText = (code: string): string =>
  lookupTerm('handoff', code)?.label ?? 'Handed straight to its owner';
const triggerText = (t: string): string | null => lookupTerm('trigger', t)?.label ?? null;
const short = (h: string, n = 16) => `${h.slice(0, n)}…`;

/** Whether the item's view says the panel has something to show. */
export const showsHandoff = (it: { waiting: string | null; handoff: unknown | null }): boolean =>
  it.handoff !== null ||
  (it.waiting?.startsWith('handoff:') ?? false) ||
  it.waiting === 'human:human_led';

export function HandoffPanel({ id, csrf }: { id: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['item-handoff', id],
    queryFn: () => api.itemHandoff(id),
    refetchInterval: 5_000,
  });
  if (q.isPending) return <Loading what="the handover" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  return (
    <section aria-label="Handover" className="wk-page" data-testid="handoff-panel">
      {v.handoff ? <HandoffFacts v={v} /> : null}
      {v.handoff && v.handoff.status === 'open' ? <E4Card v={v} /> : null}
      {v.may.choose && v.handoff ? <ChooseForm v={v} csrf={csrf} /> : null}
      {v.human_led ? <HumanLed v={v} csrf={csrf} /> : null}
    </section>
  );
}

function HandoffFacts({ v }: { v: PortalItemHandoffView }) {
  const h = v.handoff;
  if (!h) return null;
  const why = triggerText(h.trigger);
  return (
    <Card
      title={handoffText(h.code)}
      actions={
        <Pill tone={h.status === 'open' ? 'warn' : 'mute'}>
          {h.status === 'open'
            ? 'Waiting for its owner'
            : `Chosen: ${h.choice ? CHOICE_TEXT[h.choice].label : 'unknown'}`}
        </Pill>
      }
      testId="handoff-facts"
    >
      <KeyValue
        label="Why the agents stopped"
        rows={[
          ['Why', why ?? 'The factory does not say why.'],
          [
            'Where',
            `${wire('phase', h.origin_phase)}${h.origin_step ? `: ${wire('step', h.origin_step)}` : ''}`,
          ],
          [
            'Handover notes',
            <span key="p">
              Kept and fingerprinted{' '}
              <code title={h.pack.content_sha256} data-testid="pack-sha">
                {short(h.pack.content_sha256)}
              </code>
            </span>,
          ],
          [
            'Since',
            <span key="o" title={shortTime(h.opened_at)}>
              {ago(h.opened_at)}
            </span>,
          ],
          ...(h.chosen_at ? ([['Chosen', ago(h.chosen_at)]] as const) : []),
        ]}
      />
    </Card>
  );
}

function E4Card({ v }: { v: PortalItemHandoffView }) {
  const e4 = v.e4;
  return (
    <Card title={<>{label('gate', 'E4')}</>} testId="handoff-e4">
      {e4 === null ? (
        <p className="muted">This approval has not opened yet. Nothing happens until it does.</p>
      ) : e4.status === 'pending' ? (
        <>
          <p>
            Its owner takes it first, then chooses here what happens next. Nothing is chosen if
            nobody decides.
          </p>
          {e4.card_id ? (
            <p>
              <Link to={`/decide/${e4.card_id}`}>
                {v.may.decide_e4 ? 'Decide it' : 'See the approval'}
              </Link>
            </p>
          ) : (
            <p className="muted">Its approval is not in the record yet.</p>
          )}
        </>
      ) : (
        <>
          <p>Decided: {wire('decision', e4.outcome)}.</p>
          {v.choices.length > 0 && !v.may.choose ? (
            <p className="muted" data-testid="choose-not-mine">
              Only who approved the handover chooses what happens next ({v.choices.length} open).
            </p>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ChooseForm({ v, csrf }: { v: PortalItemHandoffView; csrf: string }) {
  const qc = useQueryClient();
  const name = useId();
  const [choice, setChoice] = useState<HandoffChoice | null>(null);
  const max = v.extension_max_percent;
  const [percent, setPercent] = useState<string>(max === null ? '' : String(max));
  const h = v.handoff;
  const send = useMutation({
    mutationFn: () =>
      api.itemHandoffChoose(
        v.item_id,
        {
          handoff_id: h?.handoff_id as string,
          choice: choice as HandoffChoice,
          ...(choice === 'extend' ? { extension_percent: Number(percent) } : {}),
        },
        csrf,
      ),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['item-handoff', v.item_id] });
      void qc.invalidateQueries({ queryKey: ['item', v.item_id] });
    },
  });
  const pct = Number(percent);
  const badPercent =
    choice === 'extend' && (!(pct > 0) || max === null || pct > max || percent.trim() === '');
  return (
    <Card title="What happens next" testId="handoff-choose">
      <fieldset className="plain-fieldset">
        <legend>The choices open now</legend>
        {v.choices.map((c) => (
          <label key={c} className="choice">
            <input
              type="radio"
              name={name}
              value={c}
              checked={choice === c}
              onChange={() => setChoice(c)}
            />
            <strong>{CHOICE_TEXT[c].label}</strong>
            <p className="muted">{CHOICE_TEXT[c].desc}</p>
          </label>
        ))}
      </fieldset>
      {choice === 'extend' ? (
        <div className="field">
          <label htmlFor={`${name}-pct`}>
            How much more budget, in percent{max !== null ? ` (at most ${max})` : ''}
          </label>
          <input
            id={`${name}-pct`}
            type="number"
            min={1}
            {...(max !== null ? { max } : {})}
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
        </div>
      ) : null}
      {send.isError ? <ErrorNote error={send.error} /> : null}
      {send.isSuccess ? (
        <p role="status">Recorded: {choice ? CHOICE_TEXT[choice].label : ''}.</p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="ui-btn ui-btn-primary"
          disabled={choice === null || badPercent || send.isPending || send.isSuccess}
          onClick={() => send.mutate()}
        >
          Record my choice
        </button>
      </div>
    </Card>
  );
}

type RefKind = HumanWorkReference['kind'];

/** A reference as typed: a PR number, or a full commit SHA. `null`: not valid yet. */
export function parseReference(kind: RefKind, text: string): HumanWorkReference | null {
  const t = text.trim();
  if (kind === 'pr') {
    const n = /^#?(\d{1,10})$/.exec(t);
    const v = n ? Number(n[1]) : 0;
    return v >= 1 && v <= 1_000_000_000 ? { kind: 'pr', number: v } : null;
  }
  const sha = t.toLowerCase();
  return /^[0-9a-f]{40}$/.test(sha) ? { kind: 'commit', sha } : null;
}

function HumanLed({ v, csrf }: { v: PortalItemHandoffView; csrf: string }) {
  const hl = v.human_led;
  const qc = useQueryClient();
  const base = useId();
  const [kind, setKind] = useState<RefKind>('pr');
  const [text, setText] = useState('');
  const [planChanged, setPlanChanged] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['item-handoff', v.item_id] });
    void qc.invalidateQueries({ queryKey: ['item', v.item_id] });
  };
  const ref = parseReference(kind, text);
  const d5 = useMutation({
    mutationFn: () =>
      api.itemHumanDone(v.item_id, { key: newKey(), ...(ref ? { reference: ref } : {}) }, csrf),
    onSuccess: done,
  });
  const d4 = useMutation({
    mutationFn: () =>
      api.itemHandBack(v.item_id, { plan_changed: planChanged, key: newKey() }, csrf),
    onSuccess: done,
  });
  if (!hl) return null;
  return (
    <Card title={label('lane', 'L8')} testId="handoff-human-led">
      <p className="muted">
        The factory does not build this item: a person does. When the work is in a pull request or a
        commit, say so; the factory then checks it and a code owner reviews it. The factory never
        merges.
      </p>
      {v.may.human_done ? (
        <fieldset className="plain-fieldset" aria-label={label('decideWord', 'mark_done')}>
          <legend>{label('decideWord', 'mark_done')}</legend>
          <div className="field">
            <label htmlFor={`${base}-kind`}>Where the work is</label>
            <select
              id={`${base}-kind`}
              value={kind}
              onChange={(e) => setKind(e.target.value as RefKind)}
            >
              <option value="pr">A pull request (its number)</option>
              <option value="commit">A commit (its full 40-character SHA)</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${base}-ref`}>
              {kind === 'pr' ? 'Pull request number' : 'Commit SHA'}
            </label>
            <input
              id={`${base}-ref`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-invalid={text.trim() !== '' && ref === null}
              autoComplete="off"
            />
          </div>
          {text.trim() !== '' && ref === null ? (
            <p className="notice notice-bad" role="alert">
              {kind === 'pr'
                ? 'A pull request is named by its number, such as 42.'
                : 'A commit is named by its full SHA: 40 hexadecimal characters.'}
            </p>
          ) : null}
          {d5.isError ? <ErrorNote error={d5.error} /> : null}
          {d5.isSuccess ? <p role="status">Recorded: the factory checks the work next.</p> : null}
          <div className="actions">
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={ref === null || d5.isPending || d5.isSuccess}
              onClick={() => d5.mutate()}
            >
              {label('decideWord', 'mark_done')}
            </button>
          </div>
        </fieldset>
      ) : null}
      {hl.taken_over ? (
        v.may.hand_back ? (
          <fieldset className="plain-fieldset" aria-label={label('decideWord', 'hand_back')}>
            <legend>{label('decideWord', 'hand_back')} (once)</legend>
            <p className="muted">
              The item goes back to the{' '}
              {hl.lane_before ? wire('lane', hl.lane_before) : 'track it came from'} track with a
              new budget.
              {` ${hl.hand_backs_left} hand-back${hl.hand_backs_left === 1 ? '' : 's'} left.`}
            </p>
            <label className="choice">
              <input
                type="checkbox"
                checked={planChanged}
                onChange={(e) => setPlanChanged(e.target.checked)}
              />
              <span>The plan changed: it is approved again before the agent builds</span>
            </label>
            {d4.isError ? <ErrorNote error={d4.error} /> : null}
            {d4.isSuccess ? <p role="status">Handed back.</p> : null}
            <div className="actions">
              <button
                type="button"
                className="ui-btn"
                disabled={d4.isPending || d4.isSuccess}
                onClick={() => d4.mutate()}
              >
                {label('decideWord', 'hand_back')}
              </button>
            </div>
          </fieldset>
        ) : hl.hand_backs_left === 0 ? (
          <p className="muted">It was handed back once already; that is allowed once per item.</p>
        ) : null
      ) : null}
      {v.done.length > 0 ? (
        <KeyValue
          label="Marked done"
          rows={v.done.map((d) => [
            ago(d.at),
            <span key={d.at}>
              {d.reference === null ? (
                'no reference named'
              ) : d.reference.kind === 'pr' ? (
                <>pull request #{d.reference.number}</>
              ) : (
                <>
                  commit <code>{d.reference.sha.slice(0, 12)}</code>
                </>
              )}
            </span>,
          ])}
        />
      ) : null}
    </Card>
  );
}
