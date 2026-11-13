import { useMutation } from '@tanstack/react-query';
import { label, lookupTerm, type ConsoleSessionView, type Tier } from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { describeError } from '../format';
import { Pill, type PillTone } from '../ui';
import { onboardApi } from './api';

// The onboarder's proposals as chips under the turn that explains them (docs/design/onboarding-console.md, P4): each one
// reads in plain words and the person accepts it, edits it or rejects it. The answer is the person's, recorded as theirs;
// an accepted chip is a default for the sign-off (or, for a test command, the command the tests probe will run). A chip
// never decides a gate: approvals are still decided in their own cards.

type Proposal = ConsoleSessionView['proposals'][number];

const STATE: Readonly<Record<Proposal['state'], { text: string; tone: PillTone }>> = {
  open: { text: 'Waiting for you', tone: 'human' },
  accepted: { text: 'Accepted', tone: 'ok' },
  edited: { text: 'Changed and accepted', tone: 'ok' },
  rejected: { text: 'Rejected', tone: 'mute' },
  superseded: { text: 'Replaced', tone: 'mute' },
};

const term = (family: Parameters<typeof lookupTerm>[0], v: string) =>
  lookupTerm(family, v)?.label ?? v;

type V = Record<string, unknown>;

/** What a proposal says, in words. */
export function sayProposal(p: Pick<Proposal, 'kind' | 'target' | 'value'>): string {
  const v = (p.value ?? {}) as V;
  switch (p.kind) {
    case 'tier':
      return `Risk: ${label('tier', String(v['tier']) as Tier)}`;
    case 'gap_disposition':
      return `For this gap: ${term('gapDisposition', String(v['disposition']))}`;
    case 'role_map': {
      const who = (v['principals'] as string[] | undefined) ?? [];
      return `Who holds “${p.target}”: ${who.length > 0 ? who.join(', ') : 'nobody'}`;
    }
    case 'settings':
      return `Two-person approval: ${v['two_person_enabled'] === true ? 'on' : 'off'}`;
    case 'claim':
      return `${{ affirm: 'Confirm', correct: 'Correct', unknown: 'Mark as unknown' }[String(v['stance'])] ?? 'Claim'}${typeof v['text'] === 'string' ? `: ${v['text']}` : ''}`;
    case 'instruction_text':
      return `Text for ${p.target}`;
    case 'fix_file':
      return `A file in the fix pull request: ${String(v['path'])}`;
    case 'manual_step':
      return String(v['text']);
    case 'test_command':
      return `Run the tests with: ${String(v['command'])}${typeof v['setup'] === 'string' ? ` (after: ${v['setup']})` : ''}`;
    case 'act':
      return `Go ahead and run: ${String(v['act']).replaceAll('_', ' ')}`;
  }
}

const code = (p: Proposal): string | null => {
  const v = (p.value ?? {}) as V;
  return p.kind === 'instruction_text'
    ? String(v['text'])
    : p.kind === 'fix_file'
      ? String(v['content'])
      : null;
};

/** The person's edit as the kind's own value, from what they typed. */
function editedValue(p: Proposal, f: { a: string; b: string; c: boolean }): unknown {
  const v = (p.value ?? {}) as V;
  switch (p.kind) {
    case 'tier':
      return { tier: f.a };
    case 'gap_disposition':
      return { disposition: f.a };
    case 'role_map':
      return {
        principals: f.a
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean),
      };
    case 'settings':
      return { two_person_enabled: f.c };
    case 'claim':
      return { stance: f.a, ...(f.b ? { text: f.b } : {}) };
    case 'instruction_text':
      return { text: f.a };
    case 'fix_file':
      return { path: String(v['path']), content: f.a };
    case 'manual_step':
      return { text: f.a };
    case 'test_command':
      return { command: f.a, ...(f.b ? { setup: f.b } : {}) };
    case 'act':
      return p.value;
  }
}

const initialEdit = (p: Proposal): { a: string; b: string; c: boolean } => {
  const v = (p.value ?? {}) as V;
  switch (p.kind) {
    case 'tier':
      return { a: String(v['tier']), b: '', c: false };
    case 'gap_disposition':
      return { a: String(v['disposition']), b: '', c: false };
    case 'role_map':
      return { a: ((v['principals'] as string[] | undefined) ?? []).join(', '), b: '', c: false };
    case 'settings':
      return { a: '', b: '', c: v['two_person_enabled'] === true };
    case 'claim':
      return {
        a: String(v['stance']),
        b: typeof v['text'] === 'string' ? v['text'] : '',
        c: false,
      };
    case 'instruction_text':
      return { a: String(v['text']), b: '', c: false };
    case 'fix_file':
      return { a: String(v['content']), b: '', c: false };
    case 'manual_step':
      return { a: String(v['text']), b: '', c: false };
    case 'test_command':
      return {
        a: String(v['command']),
        b: typeof v['setup'] === 'string' ? v['setup'] : '',
        c: false,
      };
    case 'act':
      return { a: '', b: '', c: false };
  }
};

export function Proposals({
  s0,
  items,
  csrf,
  onView,
}: {
  s0: string;
  items: readonly Proposal[];
  csrf: string;
  onView: (v: ConsoleSessionView) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="oc-chips" aria-label="Proposals">
      {items.map((p) => (
        <Chip key={p.proposal_id} s0={s0} p={p} csrf={csrf} onView={onView} />
      ))}
    </ul>
  );
}

function Chip({
  s0,
  p,
  csrf,
  onView,
}: {
  s0: string;
  p: Proposal;
  csrf: string;
  onView: (v: ConsoleSessionView) => void;
}) {
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [f, setF] = useState(() => initialEdit(p));
  const decide = useMutation({
    mutationFn: (b: { decision: 'accept' | 'edit' | 'reject'; edited_value?: unknown }) =>
      onboardApi.consoleDecide(
        s0,
        p.proposal_id,
        { ...b, proposal_sha256: p.proposal_sha256 },
        csrf,
      ),
    onSuccess: (v) => {
      setEditing(false);
      onView(v);
    },
  });
  const st = STATE[p.state];
  const open = p.state === 'open';
  const body = code(p);
  return (
    <li className="oc-chip" data-testid="proposal" data-kind={p.kind} data-state={p.state}>
      <div className="oc-bar">
        <strong>{p.title}</strong>
        <span className="oc-spacer" />
        <Pill tone={st.tone}>{st.text}</Pill>
      </div>
      <p className="oc-text">{sayProposal(p)}</p>
      {body ? <pre className="oc-code">{body}</pre> : null}
      <p className="ui-help">{p.why}</p>
      {open && editing ? (
        <div className="oc-edit">
          <label className="ui-label" htmlFor={`${id}-a`}>
            {p.kind === 'tier' || p.kind === 'gap_disposition' || p.kind === 'claim'
              ? 'Your choice'
              : p.kind === 'role_map'
                ? 'People (comma separated)'
                : p.kind === 'test_command'
                  ? 'Command'
                  : 'Text'}
          </label>
          {p.kind === 'tier' || p.kind === 'gap_disposition' || p.kind === 'claim' ? (
            <select
              id={`${id}-a`}
              className="ui-select"
              value={f.a}
              onChange={(e) => setF({ ...f, a: e.target.value })}
            >
              {(p.kind === 'tier'
                ? ['T0', 'T1', 'T2']
                : p.kind === 'gap_disposition'
                  ? ['file_issue', 'track_only', 'waive']
                  : ['affirm', 'correct', 'unknown']
              ).map((o) => (
                <option key={o} value={o}>
                  {p.kind === 'tier'
                    ? label('tier', o as Tier)
                    : p.kind === 'gap_disposition'
                      ? term('gapDisposition', o)
                      : { affirm: 'Confirm', correct: 'Correct', unknown: 'Unknown' }[o]}
                </option>
              ))}
            </select>
          ) : p.kind === 'settings' ? (
            <input
              id={`${id}-a`}
              type="checkbox"
              checked={f.c}
              onChange={(e) => setF({ ...f, c: e.target.checked })}
            />
          ) : p.kind === 'instruction_text' || p.kind === 'fix_file' || p.kind === 'manual_step' ? (
            <textarea
              id={`${id}-a`}
              className="ui-input"
              rows={6}
              value={f.a}
              onChange={(e) => setF({ ...f, a: e.target.value })}
            />
          ) : (
            <input
              id={`${id}-a`}
              className="ui-input"
              value={f.a}
              onChange={(e) => setF({ ...f, a: e.target.value })}
            />
          )}
          {p.kind === 'test_command' || p.kind === 'claim' ? (
            <>
              <label className="ui-label" htmlFor={`${id}-b`}>
                {p.kind === 'test_command' ? 'Setup command (optional)' : 'Your words (optional)'}
              </label>
              <input
                id={`${id}-b`}
                className="ui-input"
                value={f.b}
                onChange={(e) => setF({ ...f, b: e.target.value })}
              />
            </>
          ) : null}
          <div className="oc-bar">
            <button
              type="button"
              className="ui-btn ui-btn-sm ui-btn-primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: 'edit', edited_value: editedValue(p, f) })}
            >
              Use my version
            </button>
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {open && !editing ? (
        <div className="oc-bar">
          <button
            type="button"
            className="ui-btn ui-btn-sm ui-btn-primary"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: 'accept' })}
          >
            Accept
          </button>
          {p.kind === 'act' || p.kind === 'manual_step' ? null : (
            <button
              type="button"
              className="ui-btn ui-btn-sm"
              disabled={decide.isPending}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
          )}
          <button
            type="button"
            className="ui-btn ui-btn-sm"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: 'reject' })}
          >
            Reject
          </button>
        </div>
      ) : null}
      {decide.isError ? (
        <p role="alert" className="ui-help">
          {describeError(decide.error)}
        </p>
      ) : null}
    </li>
  );
}
