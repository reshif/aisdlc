import { AutonomyValues, type Autonomy, type Lane, type Tier } from '@aisdlc/contracts';
import { useState } from 'react';
import type { CardDetailWire } from '../api';
import { Badge } from '../components/Badge';
import { shortTime } from '../format';
import { DecideShell } from './DecideShell';
import { Check, DecidersLine, Hash, Section, countsText } from './shared';

// Card 5 as the person meets it (OB §1A, §6.2 row 0.5): the Project Readiness Record the factory
// assembled, in the words of what it lets the factory do, and the two decisions on one card: the
// sign-off and M4, which needs the person to sign in again (step-up) for this record's hash. Never
// auto-approved: the person ticks that they have read it, confirms their identity, then decides.

interface C5View {
  repo: string;
  requested_level: string;
  signed_level: string;
  owners: string[];
  tier: { value: Tier; floor: Tier; raised_by: string[] };
  m4_package: {
    census_hash: string;
    gap_ledger_hash: string;
    controls_report_hash: string;
    prr_record_hash: string;
  };
  prr: {
    record_id: string;
    version: number;
    record_hash: string;
    status: string;
    issued_at: string;
    fresh_until: string;
    review_by: string | null;
    baseline_sha: string;
    composite: number;
    pillars: Array<{ pillar: string; level: number }>;
    autonomy: {
      tier_cap: Autonomy;
      level_cap: Autonomy;
      readiness_cap: Autonomy;
      posture_cap: Autonomy | null;
      probation_until: string | null;
      effective: Autonomy;
      lanes_eligible: Lane[];
      r3_zones: string[];
    };
    writes: string;
    two_person: { enabled: boolean; locked_on: boolean };
    signer: { principal: string; role: string; mode: string; sod_waiver: boolean };
    security_summary: { history_scan: Record<string, unknown> };
    gaps: { total: number; blocking: number; waived: number };
  };
}

const rank = (a: Autonomy): number => AutonomyValues.indexOf(a);

/** The caps that hold the effective autonomy down (the lowest ones), or `probation`. */
export function bindingCaps(a: C5View['prr']['autonomy']): string[] {
  const caps: Array<[string, Autonomy | null]> = [
    ['tier', a.tier_cap],
    ['level', a.level_cap],
    ['readiness', a.readiness_cap],
    ['posture', a.posture_cap],
  ];
  const hits = caps.filter(([, c]) => c !== null && rank(c) === rank(a.effective)).map(([n]) => n);
  return hits.length > 0 ? hits : ['probation'];
}

const LANES_TEXT = (l: Lane[]): string => (l.length === 0 ? 'none' : l.join(', '));

export function C5Panel({ card, csrf }: { card: CardDetailWire; csrf: string }) {
  const v = card.view as unknown as C5View;
  const p = v.prr;
  const a = p.autonomy;
  const binds = bindingCaps(a);
  const [read, setRead] = useState(false);
  const blocked = read ? [] : ['Tick that you have read the readiness record.'];

  return (
    <>
      <p className="muted">
        Card 5 is the last of the onboarding. It carries two decisions: the sign-off of the
        readiness record below, and the M4 gate that makes it active. Neither is ever automatic.
      </p>
      <DecidersLine who={card.deciders} names={card.principal_names} what="the sign-off" />
      {card.m4_deciders ? (
        <DecidersLine who={card.m4_deciders} names={card.principal_names} what="the M4 gate" />
      ) : null}

      <Section title="Readiness record" id="c5-record">
        <dl className="facts facts-wide">
          <div>
            <dt>Level</dt>
            <dd data-testid="c5-level">
              {v.signed_level}
              {v.signed_level !== v.requested_level ? ` (asked for ${v.requested_level})` : ''}
            </dd>
          </div>
          <div>
            <dt>Tier</dt>
            <dd data-testid="c5-tier">
              {v.tier.value} (floor {v.tier.floor}
              {v.tier.raised_by.length > 0 ? `, raised by ${v.tier.raised_by.join(', ')}` : ''})
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>
              <Badge tone="attention">{p.status}</Badge> version {p.version}
            </dd>
          </div>
          <div>
            <dt>Record hash</dt>
            <dd>
              <Hash value={p.record_hash} label="record hash" />
            </dd>
          </div>
          <div>
            <dt>Fresh until</dt>
            <dd>{shortTime(p.fresh_until)}</dd>
          </div>
          <div>
            <dt>Review by</dt>
            <dd>{p.review_by ? shortTime(p.review_by) : 'no review date at this level'}</dd>
          </div>
          <div>
            <dt>Baseline commit</dt>
            <dd>
              <code>{p.baseline_sha.slice(0, 12)}</code>
            </dd>
          </div>
          <div>
            <dt>Writes</dt>
            <dd>{p.writes === 'none' ? 'none: a read-only Census' : p.writes}</dd>
          </div>
        </dl>
      </Section>

      <Section title="What the factory may do" id="c5-autonomy">
        <p>
          Effective autonomy is <strong>{a.effective}</strong>
          {a.probation_until && binds[0] === 'probation'
            ? `, held down by probation until ${shortTime(a.probation_until)}`
            : ''}
          . It can never be higher than any cap.
        </p>
        <table className="table" aria-label="Autonomy caps">
          <thead>
            <tr>
              <th scope="col">Cap</th>
              <th scope="col">Value</th>
              <th scope="col">Binds</th>
            </tr>
          </thead>
          <tbody>
            {(
              [
                ['tier', 'Tier', a.tier_cap],
                ['level', 'Level', a.level_cap],
                ['readiness', 'Readiness', a.readiness_cap],
                ['posture', 'Posture', a.posture_cap],
              ] as const
            ).map(([k, label, c]) => (
              <tr key={k} data-cap={k} data-binds={binds.includes(k) ? 'yes' : 'no'}>
                <th scope="row">{label}</th>
                <td>{c ?? 'none (green posture)'}</td>
                <td>
                  {binds.includes(k) ? <strong>binds</strong> : <span className="muted">no</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Lanes open for agent work:{' '}
          <strong data-testid="c5-lanes">{LANES_TEXT(a.lanes_eligible)}</strong>
          {a.r3_zones.length > 0 ? `. Areas with a critical unknown: ${a.r3_zones.join(', ')}` : ''}
          .
        </p>
        <p>
          Pillars (composite {p.composite}, the lowest of them):{' '}
          {p.pillars.map((x) => `${x.pillar} ${x.level}`).join(', ')}.
        </p>
      </Section>

      <Section title="Gaps and security" id="c5-gaps">
        <p>
          {p.gaps.total} gap{p.gaps.total === 1 ? '' : 's'}: {p.gaps.blocking} blocking,{' '}
          {p.gaps.waived} waived.
        </p>
        <p className="muted">
          Secret scan of the history (counts only): {countsText(p.security_summary.history_scan)}
        </p>
        <p>
          Signer: {p.signer.principal} ({p.signer.mode}
          {p.signer.sod_waiver ? ', deciding alone: sod_waiver' : ''}). Two-person is{' '}
          {p.two_person.enabled ? 'on' : 'off'}
          {p.two_person.locked_on ? ' (locked on)' : ''}.
        </p>
      </Section>

      <Section title="What M4 signs" id="c5-m4">
        <p className="muted">M4 is bound to the record hash above. The three hashes behind it:</p>
        <dl className="facts facts-wide">
          <div>
            <dt>Census</dt>
            <dd>
              <Hash value={v.m4_package.census_hash} label="census hash" />
            </dd>
          </div>
          <div>
            <dt>Gap ledger</dt>
            <dd>
              <Hash value={v.m4_package.gap_ledger_hash} label="gap ledger hash" />
            </dd>
          </div>
          <div>
            <dt>Controls report</dt>
            <dd>
              <Hash value={v.m4_package.controls_report_hash} label="controls report hash" />
            </dd>
          </div>
        </dl>
      </Section>

      <DecideShell
        card={card}
        csrf={csrf}
        content={{}}
        blocked={blocked}
        approveLabel="Sign off and approve M4"
      >
        <Check checked={read} onChange={setRead}>
          I have read this readiness record and I sign it
        </Check>
      </DecideShell>
    </>
  );
}
