import {
  b2Reasons,
  type AmberCode,
  type CensusBlocker,
  type CensusEvidence,
  type CensusPosture,
  type BlockerId,
} from '@aisdlc/contracts';
import type { CensusContext } from './context.js';
import { factEvidence, ref, tidyEvidence, uniqSorted } from './context.js';

// Blockers B1-B6 and the posture (OB §5.1-§5.2). B1-B5 decide the posture; B6 blocks L5 only and B3
// is not decided at Census (protect-main is RECORDED there, OB §6.2 note "Census at 0.4"). An
// unknown blocker is OPEN for the posture (fail closed): the Census never reads "could not tell"
// as "clear". B7 (the probe) is `pending`: only a K-exec run counts, and nothing here ran anything.

export interface Blockers {
  readonly list: CensusBlocker[];
  readonly byId: ReadonlyMap<BlockerId, CensusBlocker>;
  readonly posture: CensusPosture;
}

const mk = (
  id: BlockerId,
  status: CensusBlocker['status'],
  reasons: string[],
  evidence: CensusEvidence[],
  notes: string[] = [],
): CensusBlocker => ({
  id,
  status,
  reasons: uniqSorted(reasons),
  notes: uniqSorted(notes),
  evidence: tidyEvidence(evidence),
});

export function assembleBlockers(c: CensusContext): Blockers {
  const r = c.r;
  // An error, a cap or a cut-short walk only gives a lower bound on what is open.
  const scanOk =
    r.scan_status === 'ok' && !r.scan_coverage.truncated && !r.scan_coverage.cap_reached;

  // B1: any finding not rotated, false_positive or accepted_test_fixture. An incomplete scan only
  // gives a lower bound on the open count, so "none open" is then unknown, never met.
  const countsEv = [ref('scan', 'scan:finding_counts')];
  const b1 =
    r.finding_counts.open > 0
      ? mk('B1', 'blocked', ['open_findings'], countsEv)
      : scanOk
        ? mk('B1', 'met', [], countsEv)
        : mk('B1', 'unknown', ['scan_incomplete'], countsEv);

  // B2: scan incomplete (error, cap, truncated, a ref class unscanned). `default_only` blocks at
  // Light and Full; at Census it is a note the M4 card shows ("refs/pull/* not scanned").
  const all = b2Reasons(r);
  const reasons2 = all.filter((x) => x !== 'refs_default_only' || c.level !== 'census');
  const notes2 =
    all.includes('refs_default_only') && c.level === 'census' ? ['refs_default_only'] : [];
  const b2 = mk(
    'B2',
    reasons2.length > 0 ? 'blocked' : 'met',
    reasons2,
    [ref('scan', 'scan:coverage')],
    notes2,
  );

  // B3: read at the reduced 0.4 at Light and Full; RECORDED, not decided, at Census.
  const att = c.att;
  let b3: CensusBlocker;
  if (c.level === 'census') {
    b3 = mk('B3', 'not_evaluated', [], [], ['protect_main_recorded_at_census']);
  } else if (att.protect_main === false) {
    b3 = mk(
      'B3',
      'blocked',
      ['protect_main_not_effective'],
      [ref('codehost', 'codehost:protect_main')],
    );
  } else if (att.protect_main === true && att.bypass_attested === true) {
    b3 = mk('B3', 'met', [], [ref('codehost', 'codehost:protect_main')]);
  } else {
    b3 = mk(
      'B3',
      'unknown',
      [att.protect_main === true ? 'bypass_unattested' : 'protect_main_unknown'],
      [],
    );
  }

  // B4: from the code host. Not supplied is unknown (fail closed).
  const inst = att.installation;
  let b4: CensusBlocker;
  let b4c = false;
  if (inst === undefined) {
    b4 = mk('B4', 'unknown', ['installation_unknown'], []);
  } else {
    const codes: string[] = [];
    const unknownCodes: string[] = [];
    const perms = Object.keys(inst.permissions);
    if (perms.includes('administration') || perms.includes('workflows')) codes.push('B4a');
    if (perms.includes('statuses')) {
      const checks = att.required_checks;
      if (checks === undefined || checks === null) unknownCodes.push('B4b_required_checks_unknown');
      else if (checks.some((k) => k.integration_id === undefined)) codes.push('B4b');
      else b4c = true;
    }
    const ev = [ref('codehost', 'codehost:installation')];
    b4 =
      codes.length > 0
        ? mk('B4', 'blocked', [...codes, ...unknownCodes], ev)
        : unknownCodes.length > 0
          ? mk('B4', 'unknown', unknownCodes, ev)
          : mk('B4', 'met', [], ev, b4c ? ['B4c_statuses_pinned'] : []);
  }

  // B5: dangerous workflow reachable by an agent PR (detector b5_workflows).
  let b5: CensusBlocker;
  const d = c.d;
  if (d === null) {
    b5 = mk('B5', 'unknown', ['detectors_missing'], []);
  } else {
    const red = c.facts('workflow_finding').filter((f) => f.severity === 'red');
    if (d.b5.status === 'blocked') {
      b5 = mk(
        'B5',
        'blocked',
        red.map((f) => f.rule),
        red.flatMap(factEvidence),
      );
    } else if (d.b5.status === 'unknown' || !c.ok('b5_workflows')) {
      b5 = mk(
        'B5',
        'unknown',
        [d.b5.workflows_unanalysed > 0 ? 'workflows_unanalysed' : 'b5_detector_incomplete'],
        [ref('detector', 'detector:b5_workflows')],
      );
    } else {
      b5 = mk('B5', 'met', [], [ref('detector', 'detector:b5_workflows')]);
    }
  }

  // B6: apply-on-merge detected without an attested operations.md (blocks L5 only; not in posture).
  let b6: CensusBlocker;
  if (d === null || !c.ok('b6_apply_on_merge')) {
    b6 = mk('B6', 'unknown', ['b6_detector_incomplete'], []);
  } else if (d.b6.detected && att.operations_attested !== true) {
    b6 = mk(
      'B6',
      'blocked',
      ['apply_on_merge_unattested'],
      c.facts('apply_on_merge').flatMap(factEvidence),
    );
  } else {
    b6 = mk(
      'B6',
      'met',
      [],
      [ref('detector', 'detector:b6_apply_on_merge')],
      d.b6.detected ? ['apply_on_merge_attested'] : [],
    );
  }

  const list = [b1, b2, b3, b4, b5, b6];
  const byId = new Map(list.map((b) => [b.id, b]));

  // Posture: red on any B1-B5 open (blocked or unknown); amber on a high-severity remediable item.
  const reasons: CensusPosture['reasons'] = [];
  for (const b of [b1, b2, b3, b4, b5]) {
    if (b.status === 'blocked' || b.status === 'unknown') {
      reasons.push({
        kind: 'blocker',
        blocker: b.id as 'B1' | 'B2' | 'B3' | 'B4' | 'B5',
        status: b.status,
        codes: b.reasons,
        evidence: b.evidence,
      });
    }
  }
  const amber = (code: AmberCode, count: number, evidence: CensusEvidence[]): void => {
    if (count > 0) reasons.push({ kind: 'amber', code, count, evidence: tidyEvidence(evidence) });
  };
  if (d !== null) {
    const am = c.facts('workflow_finding').filter((f) => f.severity === 'amber');
    amber('b5_amber_workflow', d.b5.amber, am.flatMap(factEvidence));
    const noLock = c
      .facts('lockfile')
      .filter((f) => f.state === 'absent' || f.frozen_install === 'infeasible');
    amber('no_lockfile', noLock.length, noLock.flatMap(factEvidence));
  }
  amber('b4c_statuses_pinned', b4c ? 1 : 0, [ref('codehost', 'codehost:installation')]);

  const red = reasons.some((x) => x.kind === 'blocker');
  const hasAmber = reasons.some((x) => x.kind === 'amber');
  return {
    list,
    byId,
    posture: {
      state: red ? 'red' : hasAmber ? 'amber' : 'green',
      reasons,
      b7: 'probe_pending',
    },
  };
}
