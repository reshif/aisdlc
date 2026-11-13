import { label, term, type CheckVerdict } from '@aisdlc/contracts';
import { useId, useState, type ReactNode } from 'react';
import { Pill, type PillTone } from './tags';

// Deciding an approval (skeleton screen 2): the evidence first, in a grid of tiles that each open their detail, and
// the decision rail beside it, sticky on a desktop and a bottom sheet on a phone. The three verbs are always
// Approve · Request changes · Reject, in that order (glossary §1).

// ---------------------------------------------------------------- Evidence

export interface EvidenceTile {
  readonly id: string;
  /** A glossary label ("Build and tests", "Evidence pack", "Factory check"). */
  readonly title: string;
  /** A check's result; `unknown` reads "Unknown (not passed)" and is never a tick. Omit for a document. */
  readonly verdict?: CheckVerdict;
  /** One line of detail ("5 of 5 passed", "Signed for commit 3f2a91c"). */
  readonly detail?: ReactNode;
}

const VERDICT_TONE: Readonly<Record<CheckVerdict, PillTone>> = {
  passed: 'ok',
  failed: 'bad',
  unknown: 'warn',
};

export function VerdictPill({ verdict }: { verdict: CheckVerdict }) {
  const t = term('verdict', verdict);
  return (
    <span title={t.explain}>
      <Pill tone={VERDICT_TONE[verdict]}>{t.label}</Pill>
    </span>
  );
}

/** The evidence of an approval; a tile with `onOpen` is a button that opens its detail below the grid. */
export function EvidenceGrid({
  tiles,
  selected,
  onOpen,
  label: name = 'Evidence',
}: {
  tiles: readonly EvidenceTile[];
  selected?: string | null;
  onOpen?: (id: string) => void;
  label?: string;
}) {
  return (
    <ul className="ui-evidence" aria-label={name}>
      {tiles.map((t) => {
        const body = (
          <>
            <span className="ui-evidence-t">{t.title}</span>
            {t.verdict ? <VerdictPill verdict={t.verdict} /> : null}
            {t.detail ? <span className="ui-evidence-d">{t.detail}</span> : null}
          </>
        );
        return (
          <li key={t.id}>
            {onOpen ? (
              <button
                type="button"
                className="ui-evidence-tile"
                aria-pressed={selected === t.id}
                onClick={() => onOpen(t.id)}
              >
                {body}
              </button>
            ) : (
              <div className="ui-evidence-tile">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- Decision rail

export type DecisionVerb = 'approve' | 'request_changes' | 'reject';

export type RailAccess =
  | { readonly state: 'pending' }
  | { readonly state: 'allow' }
  /** The policy's reason in words, and who to ask (glossary §1: "say who and why when something is locked"). */
  | { readonly state: 'deny'; readonly reason: string; readonly request?: ReactNode };

export function DecisionRail({
  who,
  access,
  twoPerson,
  stepUp = false,
  sendBack,
  rejectTo,
  unsure,
  adminOverride = false,
  busy = false,
  result,
  inline = false,
  allowed,
  fixedReason,
  onDecide,
}: {
  /** Who decides this approval and why ("Alex Rivera, Code reviewer"). */
  who: ReactNode;
  access: RailAccess;
  /** "Needs two people": how many approvals it has of how many it needs, and from whom. */
  twoPerson?: { readonly have: number; readonly need: number; readonly by?: readonly string[] };
  /** "Confirm it's you" before the decision. */
  stepUp?: boolean;
  /** What "Request changes" leaves ("1 of 2 tries left"). */
  sendBack?: string;
  /** Where "Reject" sends the work. */
  rejectTo?: string;
  /** Light review only: "I'm not sure" asks for a full review. */
  unsure?: () => void;
  /** The factory admin deciding outside the normal rules: said, and the reason is required. */
  adminOverride?: boolean;
  busy?: boolean;
  /** After deciding: the decision log entry. */
  result?: ReactNode;
  /** In the flow of the page, not sticky and not a bottom sheet (the /design review page). */
  inline?: boolean;
  /** The verbs this approval offers (default all three, always in the same order). */
  allowed?: readonly DecisionVerb[];
  /** A reason already bound into the decision (a two-person approval's second approver binds the first one's). */
  fixedReason?: string;
  onDecide: (verb: DecisionVerb, reason: string) => void;
}) {
  const [typed, setReason] = useState('');
  const reason = fixedReason ?? typed;
  const [open, setOpen] = useState(false);
  const [missing, setMissing] = useState(false);
  const id = useId();
  const rid = useId();
  const sheet = useId();
  const may = access.state === 'allow';
  const offers = (v: DecisionVerb) => allowed === undefined || allowed.includes(v);
  const decide = (v: DecisionVerb) => {
    // a send-back and a refusal say why; so does every decision outside the normal rules
    if ((v !== 'approve' || adminOverride) && reason.trim() === '') {
      setMissing(true);
      return;
    }
    setMissing(false);
    onDecide(v, reason.trim());
  };
  return (
    <aside
      className={`ui-rail${open ? ' ui-rail-open' : ''}${inline ? ' ui-rail-inline' : ''}`}
      aria-labelledby={id}
    >
      <div className="ui-rail-hd">
        <h2 id={id} className="ui-rail-h">
          Your decision
        </h2>
        {/* phone only: the rail is a bottom sheet this opens and closes */}
        <button
          type="button"
          className="ui-rail-toggle"
          aria-expanded={open}
          aria-controls={sheet}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? 'Hide' : 'Decide'}
        </button>
      </div>
      <div id={sheet} className="ui-rail-body">
        <div className="ui-rail-who">{who}</div>
        {twoPerson ? (
          <p className="ui-rail-two" title={term('decideWord', 'two_person').explain}>
            {label('decideWord', 'two_person')}: {twoPerson.have} of {twoPerson.need}
            {twoPerson.by && twoPerson.by.length > 0
              ? ` (approved by ${twoPerson.by.join(', ')})`
              : ''}
          </p>
        ) : null}
        {adminOverride ? (
          <p className="ui-rail-admin">
            <strong>{label('decideWord', 'admin_override')}</strong>.{' '}
            {term('decideWord', 'admin_override').explain}
          </p>
        ) : null}
        {result ? (
          <div className="ui-rail-result" role="status">
            {result}
          </div>
        ) : access.state === 'deny' ? (
          <div className="ui-rail-deny" role="note">
            <p>{access.reason}</p>
            {access.request}
          </div>
        ) : (
          <>
            <label htmlFor={rid} className="ui-label">
              {label('decideWord', 'reason')}
            </label>
            <textarea
              id={rid}
              className="ui-input ui-rail-reason"
              rows={3}
              value={reason}
              readOnly={fixedReason !== undefined}
              aria-describedby={`${rid}-h`}
              aria-invalid={missing}
              onChange={(e) => setReason(e.target.value)}
            />
            <p id={`${rid}-h`} className={missing ? 'ui-help ui-help-bad' : 'ui-help'}>
              {missing
                ? 'Say why: a reason is saved with this decision.'
                : fixedReason !== undefined
                  ? 'The first approver gave this reason; your approval binds the same one.'
                  : term('decideWord', 'reason').explain}
            </p>
            {stepUp ? (
              <p className="ui-rail-stepup" title={term('decideWord', 'step_up').explain}>
                {label('decideWord', 'step_up')}: {term('decideWord', 'step_up').explain}
              </p>
            ) : null}
            <div className="ui-rail-verbs">
              <button
                type="button"
                className="ui-btn ui-btn-primary ui-btn-block"
                disabled={!may || busy}
                onClick={() => decide('approve')}
              >
                {label('decision', 'approve')}
              </button>
              {offers('request_changes') ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-block"
                  disabled={!may || busy}
                  onClick={() => decide('request_changes')}
                >
                  {label('decision', 'request_changes')}
                  {sendBack ? <span className="ui-rail-sub">: {sendBack}</span> : null}
                </button>
              ) : null}
              {offers('reject') ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-danger ui-btn-block"
                  disabled={!may || busy}
                  onClick={() => decide('reject')}
                >
                  {label('decision', 'reject')}
                  {rejectTo ? <span className="ui-rail-sub">: {rejectTo}</span> : null}
                </button>
              ) : null}
              {unsure ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost ui-btn-block"
                  disabled={!may || busy}
                  title={term('decideWord', 'unsure').explain}
                  onClick={unsure}
                >
                  {label('decideWord', 'unsure')}
                </button>
              ) : null}
            </div>
            {access.state === 'pending' ? (
              <p className="ui-help" role="status">
                Checking whether you may decide…
              </p>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}
