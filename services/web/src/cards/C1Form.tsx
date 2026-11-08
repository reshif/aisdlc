import {
  GapDispositionValues,
  MAX_WAIVER_DAYS,
  TierValues,
  type GapDisposition,
  type Tier,
} from '@aisdlc/contracts';
import { useMemo, useState } from 'react';
import type { CardDetailWire } from '../api';
import { Badge } from '../components/Badge';
import { DecideShell } from './DecideShell';
import {
  Check,
  DecidersLine,
  Hash,
  PRINCIPAL_RE,
  Section,
  TextField,
  countsText,
  ids,
} from './shared';

// Card 1 as the person meets it (OB §1A, §6.2 row 0.1): what the factory found, the tier floor with
// the evidence it rests on, the posture and blockers, the gap list with one disposition per gap, the
// owners, and the attestations. The rules of the spec are in the controls: a blocking gap cannot be
// waived, a security gap is tracked and nothing else, a waiver has a reason and ends within 90 days,
// the tier only goes up, T0 needs the positive sentence. The server enforces every one of them again.

export const T0_TEXT = 'no prod, no real data, no dependants';

interface Signal {
  signal: string;
  criterion: string;
  floor: Tier;
  raised_by: string;
  evidence: Array<{ ref: string; path?: string }>;
}
interface GapView {
  gap_id: string;
  criterion: string;
  severity: 'blocking' | 'tracked';
  blocks_level: string | null;
  visibility_class: string;
  default_disposition: GapDisposition;
  allowed_dispositions: GapDisposition[];
}
interface C1View {
  repo: string;
  requested_level: string;
  signable_level: string;
  census: { census_id: string; census_hash: string; baseline_sha: string; refs_covered: string };
  tier: {
    floor: Tier;
    detector_floor: Tier;
    project_attested_floor: Tier | null;
    floor_basis: string;
    signals: Signal[];
    regulatory: string;
    criticality: string;
    t0: string;
    blocks_m4_reasons: string[];
  };
  t0_attestation: { required: boolean; text: string };
  posture: { state: string; reasons: Array<Record<string, unknown>> };
  blockers: Array<{ id: string; status: string; reasons: string[]; notes: string[] }>;
  security: Record<string, unknown> | null;
  gap_counts: { total: number; blocking: number; tracked: number; private_only: number };
  gaps: GapView[];
  max_waiver_days: number;
}

interface GapState {
  disposition: GapDisposition;
  reason: string;
  expires: string;
}

const DISPOSITION_TEXT: Readonly<Record<GapDisposition, string>> = {
  file_issue: 'Fix now: file a GitHub issue',
  track_only: 'Fix later: track it in the factory',
  waive: 'Accept the risk: waive it',
};

const DAY = 24 * 3600 * 1000;
/** A date input value (UTC day) `days` from now. */
const dateIn = (days: number): string =>
  new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const TONE = { blocked: 'bad', unknown: 'attention', met: 'good', unmet: 'bad' } as const;

function Evidence({ items }: { items: Array<{ ref: string; path?: string }> }) {
  if (items.length === 0) return <span className="muted">no evidence listed</span>;
  return (
    <ul className="plain inline">
      {items.map((e, i) => (
        <li key={`${e.ref}-${i}`}>
          <code>{e.ref}</code>
          {e.path ? <span className="muted"> {e.path}</span> : null}
        </li>
      ))}
    </ul>
  );
}

export function C1Form({ card, csrf, me }: { card: CardDetailWire; csrf: string; me: string }) {
  const v = card.view as unknown as C1View;
  const floor = v.tier.floor;
  const [ownersText, setOwnersText] = useState(me);
  const [tier, setTier] = useState<Tier>(floor);
  const [t0, setT0] = useState(false);
  const [regulatory, setRegulatory] = useState(false);
  const [criticality, setCriticality] = useState(false);
  const [disputes, setDisputes] = useState<Array<{ ref: string; note: string }>>([]);
  const [gaps, setGaps] = useState<Record<string, GapState>>(() =>
    Object.fromEntries(
      v.gaps.map((g) => [
        g.gap_id,
        { disposition: g.default_disposition, reason: '', expires: dateIn(30) },
      ]),
    ),
  );

  const needsRegulatory = v.tier.blocks_m4_reasons.includes('regulatory_unattested');
  const needsCriticality = v.tier.blocks_m4_reasons.includes('criticality_unattested');
  const owners = ids(ownersText);
  const rank = (t: Tier) => TierValues.indexOf(t);

  const blocked = useMemo(() => {
    const out: string[] = [];
    if (owners.length === 0) out.push('Name at least one owner.');
    if (owners.some((o) => !PRINCIPAL_RE.test(o))) out.push('An owner is not a valid person id.');
    if (rank(tier) < rank(floor)) out.push(`The tier cannot be below the floor (${floor}).`);
    if (tier === 'T0' && v.t0_attestation.required && !t0) {
      out.push(`For T0, attest: ${T0_TEXT}.`);
    }
    if (needsRegulatory && !regulatory) out.push('Attest the regulatory statement.');
    if (needsCriticality && !criticality) out.push('Attest the criticality statement.');
    for (const g of v.gaps) {
      const s = gaps[g.gap_id];
      if (s?.disposition !== 'waive') continue;
      if (s.reason.trim() === '') out.push(`${g.gap_id}: say why it is waived.`);
      const days = (Date.parse(`${s.expires}T00:00:00.000Z`) - Date.now()) / DAY;
      if (!(days > 0)) out.push(`${g.gap_id}: the waiver must end in the future.`);
      if (days > MAX_WAIVER_DAYS)
        out.push(`${g.gap_id}: a waiver lasts at most ${MAX_WAIVER_DAYS} days.`);
    }
    for (const d of disputes) {
      if (d.ref.trim() === '' || d.note.trim() === '')
        out.push('A dispute needs a reference and a note.');
    }
    return [...new Set(out)];
  }, [owners.join(','), tier, t0, regulatory, criticality, gaps, disputes]);

  const content = {
    owners,
    tier,
    ...(tier === 'T0' && v.t0_attestation.required ? { t0_attestation: t0 } : {}),
    ...(needsRegulatory ? { regulatory_attested: regulatory } : {}),
    ...(needsCriticality ? { criticality_attested: criticality } : {}),
    ...(disputes.length > 0
      ? { disputes: disputes.map((d) => ({ ref: d.ref.trim(), note: d.note.trim() })) }
      : {}),
    gaps: v.gaps.map((g) => {
      const s = gaps[g.gap_id] as GapState;
      return {
        gap_id: g.gap_id,
        disposition: s.disposition,
        ...(s.disposition === 'waive'
          ? { waiver: { reason: s.reason.trim(), expires_at: `${s.expires}T00:00:00.000Z` } }
          : {}),
      };
    }),
  };

  const setGap = (id: string, patch: Partial<GapState>) =>
    setGaps((cur) => ({ ...cur, [id]: { ...(cur[id] as GapState), ...patch } }));

  return (
    <>
      <p className="muted">
        Card 1 is the first of the three cards of a Census onboarding. It covers {v.repo}, asked for{' '}
        {v.requested_level}; the factory can sign up to {v.signable_level}.
      </p>
      <DecidersLine who={card.deciders} names={card.principal_names} what="this card" />

      <Section title="What the factory found" id="c1-census">
        <dl className="facts facts-wide">
          <div>
            <dt>Census</dt>
            <dd>
              <Hash value={v.census.census_hash} label="census hash" />
            </dd>
          </div>
          <div>
            <dt>Baseline commit</dt>
            <dd>
              <code>{v.census.baseline_sha.slice(0, 12)}</code>
            </dd>
          </div>
          <div>
            <dt>History covered</dt>
            <dd>{v.census.refs_covered === 'all' ? 'all branches' : 'default branch only'}</dd>
          </div>
        </dl>
      </Section>

      <Section title="Risk tier" id="c1-tier">
        <p>
          The factory&rsquo;s floor is <strong>{floor}</strong>
          {v.tier.floor_basis === 'incomplete'
            ? ' (a lower bound: a detector could not finish)'
            : ''}
          . You can raise the tier; you cannot lower it below the floor.
        </p>
        {v.tier.signals.length === 0 ? (
          <p className="muted">No signal raised the floor above T0.</p>
        ) : (
          <table className="table" aria-label="Signals behind the tier floor">
            <thead>
              <tr>
                <th scope="col">Signal</th>
                <th scope="col">Floor</th>
                <th scope="col">Evidence</th>
              </tr>
            </thead>
            <tbody>
              {v.tier.signals.map((s) => (
                <tr key={s.signal}>
                  <td>
                    {s.signal} <span className="muted">({s.criterion})</span>
                  </td>
                  <td>{s.floor}</td>
                  <td>
                    <Evidence items={s.evidence} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <fieldset className="options">
          <legend>Tier you sign</legend>
          {TierValues.map((t) => (
            <label key={t} className="radio">
              <input
                type="radio"
                name="tier"
                value={t}
                checked={tier === t}
                disabled={rank(t) < rank(floor)}
                onChange={() => setTier(t)}
              />{' '}
              {t}
              {rank(t) < rank(floor) ? ' (below the floor)' : ''}
            </label>
          ))}
        </fieldset>
        {tier === 'T0' ? (
          <Check
            checked={t0}
            onChange={setT0}
            hint="DEC-4: T0 is signed only with your positive statement."
          >
            {T0_TEXT}
          </Check>
        ) : null}
        {needsRegulatory ? (
          <Check
            checked={regulatory}
            onChange={setRegulatory}
            hint="Any “yes” means stop: tell the factory admin instead of signing."
          >
            There is no regulatory obligation on this project (regulatory attestation)
          </Check>
        ) : null}
        {needsCriticality ? (
          <Check checked={criticality} onChange={setCriticality}>
            I attest the criticality of this project (criticality attestation)
          </Check>
        ) : null}
      </Section>

      <Section title="Posture and blockers" id="c1-posture">
        <p>
          Posture:{' '}
          <Badge
            tone={
              v.posture.state === 'green' ? 'good' : v.posture.state === 'red' ? 'bad' : 'attention'
            }
          >
            {v.posture.state}
          </Badge>
        </p>
        {v.blockers.length === 0 ? null : (
          <ul className="plain" aria-label="Blockers">
            {v.blockers.map((b) => (
              <li key={b.id}>
                <strong>{b.id}</strong>{' '}
                <Badge tone={TONE[b.status as keyof typeof TONE] ?? 'neutral'}>{b.status}</Badge>
                {b.reasons.length > 0 ? (
                  <span className="muted"> {b.reasons.join(', ')}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {v.security ? (
          <p className="muted">
            Secret scan of the history (counts only): {countsText(v.security)}
          </p>
        ) : null}
      </Section>

      <Section title="Gaps" id="c1-gaps">
        <p>
          {v.gap_counts.total} gap{v.gap_counts.total === 1 ? '' : 's'}: {v.gap_counts.blocking}{' '}
          blocking, {v.gap_counts.tracked} to fix later
          {v.gap_counts.private_only > 0 ? `, ${v.gap_counts.private_only} private (security)` : ''}
          . Decide each one.
        </p>
        <ul className="plain gaps">
          {v.gaps.map((g) => {
            const s = gaps[g.gap_id] as GapState;
            const priv = g.visibility_class === 'private_only';
            return (
              <li key={g.gap_id} className="gap" data-gap={g.gap_id}>
                <fieldset>
                  <legend>
                    <code>{g.gap_id}</code>{' '}
                    <Badge tone={g.severity === 'blocking' ? 'bad' : 'neutral'}>{g.severity}</Badge>
                    {g.blocks_level ? (
                      <span className="muted"> blocks {g.blocks_level}</span>
                    ) : null}
                  </legend>
                  {GapDispositionValues.map((d) => {
                    const allowed = g.allowed_dispositions.includes(d);
                    const why =
                      d === 'waive' && g.severity === 'blocking'
                        ? 'A blocking gap cannot be waived: fix it, or sign a lower level.'
                        : priv
                          ? 'A security gap is tracked privately: never filed, never waived.'
                          : '';
                    return (
                      <div key={d} className="radio">
                        <label>
                          <input
                            type="radio"
                            name={`gap-${g.gap_id}`}
                            value={d}
                            checked={s.disposition === d}
                            disabled={!allowed}
                            aria-describedby={!allowed ? `why-${g.gap_id}-${d}` : undefined}
                            onChange={() => setGap(g.gap_id, { disposition: d })}
                          />{' '}
                          {DISPOSITION_TEXT[d]}
                        </label>
                        {!allowed ? (
                          <span id={`why-${g.gap_id}-${d}`} className="muted hint">
                            {' '}
                            {why}
                          </span>
                        ) : null}
                      </div>
                    );
                  })}
                  {s.disposition === 'waive' ? (
                    <div className="waiver">
                      <TextField
                        label={`Why ${g.gap_id} is waived`}
                        value={s.reason}
                        onChange={(x) => setGap(g.gap_id, { reason: x })}
                      />
                      <TextField
                        label={`${g.gap_id} waiver ends on (UTC, at 00:00)`}
                        type="date"
                        value={s.expires}
                        min={dateIn(1)}
                        max={dateIn(MAX_WAIVER_DAYS)}
                        onChange={(x) => setGap(g.gap_id, { expires: x })}
                        hint={`At most ${MAX_WAIVER_DAYS} days from today.`}
                      />
                    </div>
                  ) : null}
                </fieldset>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title="Owners and disputes" id="c1-owners">
        <TextField
          label="Owners (person ids, separated by commas)"
          value={ownersText}
          onChange={setOwnersText}
          hint="Who answers for this project. You can name more than one."
        />
        <h3>Dispute something the factory found</h3>
        {disputes.map((d, i) => (
          <div key={i} className="dispute">
            <TextField
              label={`Dispute ${i + 1}: evidence reference`}
              value={d.ref}
              onChange={(x) =>
                setDisputes((c) => c.map((y, j) => (j === i ? { ...y, ref: x } : y)))
              }
            />
            <TextField
              label={`Dispute ${i + 1}: your note`}
              value={d.note}
              onChange={(x) =>
                setDisputes((c) => c.map((y, j) => (j === i ? { ...y, note: x } : y)))
              }
            />
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setDisputes((c) => c.filter((_, j) => j !== i))}
            >
              Remove dispute {i + 1}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setDisputes((c) => [...c, { ref: '', note: '' }])}
        >
          Add a dispute
        </button>
      </Section>

      <DecideShell
        card={card}
        csrf={csrf}
        content={content}
        blocked={blocked}
        approveLabel="Approve card 1"
      />
    </>
  );
}
