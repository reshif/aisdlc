import { PRR_EVENT, prrStream, type HumanWaitCause } from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';
import { readGoverning, repoIdentity } from '../prr-store.js';
import { evaluateDrift, securityFindings } from './evaluate.js';
import { inputsOf, loadDrift } from './state.js';

// What holds the agent work of a repo after onboarding (PLAN M16 part 3; OB §8 rows "protect-main loosened ...",
// "Installation scope widened", "New history secret"): its governing readiness record is `suspended` for drift, or a
// security event is open (the fold of the newest facts says so: an installation wider than the record or the last
// confirmation saw, an open secret finding the record did not know of). A suspension sends new items to L8 (the 1.4 rule) and the
// Push Broker refuses an agent push; for a session already in flight HUMAN-WAIT applies: `syncUnits` releases the
// lease and the coding slot, keeps the snapshot and pauses the envelope clock, and no S6 command is admitted again
// (6.0 or a re-admission) while the hold lasts. The restore (a person, DEC-21(b)) lifts it; the next S6 command then
// re-admits with the snapshot, as after a gate.
//
// Read from the record only (the PRR stream), never a projection, so a lagging read model can neither keep nor
// release a session.

export interface AgentWorkHold {
  readonly cause: Exclude<HumanWaitCause, 'gate'>;
  /** The record event (or ledger entry) the hold is for: the wait's key and its reference on the record. */
  readonly ref: string;
  readonly why: string;
}

/**
 * The hold on an item's session: the repo's hold, except on L8 (human-led work is not stopped by a suspension: it is
 * where new work goes, OB §8).
 */
export async function itemWorkHold(
  db: Executor,
  s: { readonly repo: string; readonly lane: string | null; readonly proposed_lane: string },
): Promise<AgentWorkHold | null> {
  if ((s.lane ?? s.proposed_lane) === 'L8') return null;
  return agentWorkHold(db, s.repo);
}

/** The hold on a repo's agent work now, or `null` (no record governs it: nothing here holds it). */
export async function agentWorkHold(db: Executor, repo: string): Promise<AgentWorkHold | null> {
  const g = await readGoverning(db, repo);
  const v = g?.governing;
  if (!g || !v) return null;
  if (v.status === 'suspended') {
    const id = await repoIdentity(db, repo);
    const q = id
      ? await db.query<{ event_id: string }>(
          `SELECT event_id::text AS event_id FROM record.record_event
            WHERE stream = $1 AND type = $2 AND body ->> 'to' = 'suspended'
            ORDER BY seq DESC LIMIT 1`,
          [prrStream(id.project_id, id.repo_id), PRR_EVENT.status_changed],
        )
      : { rows: [] };
    return {
      cause: 'prr_suspended',
      ref: q.rows[0]?.event_id ?? `prr:${v.prr.record_hash}:suspended`,
      why: `the readiness record of ${g.repo_ref} is suspended: agent work waits for the restore`,
    };
  }
  // OB §8: a security event holds agent jobs until a person deals with it
  const l = await loadDrift(db, repo);
  const inputs = l ? inputsOf(l) : null;
  const sec = inputs ? securityFindings(evaluateDrift(inputs)) : [];
  if (l && sec.length > 0) {
    const raised = [...l.drift.security_raised].reverse().find((x) => x.prr_version === v.version);
    const what = sec.some((f) => f.kind === 'installation')
      ? 'the App installation is wider than the record saw (the security slot confirms it)'
      : 'an open secret finding the record did not know of (B1, until it is resolved)';
    return {
      cause: 'security_hold',
      ref:
        raised?.ledger_entry_id ??
        `findings:${sec.map((f) => f.subject ?? '').join(',')}`.slice(0, 200),
      why: `a security event holds agent work on ${g.repo_ref}: ${what}`,
    };
  }
  return null;
}
