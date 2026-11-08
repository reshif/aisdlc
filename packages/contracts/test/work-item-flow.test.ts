import { describe, expect, it } from 'vitest';
import {
  BACK_EDGES,
  GATES,
  HANDOFF_EDGES,
  QUARANTINE_EDGES,
  RELANE_EDGES,
  STEPS,
  WorkItemPhaseValues,
  canTransitionWorkItem,
  type EdgeEndpoint,
  type WorkItemPhase,
} from '../src/index.js';

/** The phase an endpoint sits in: a phase, `'unknown'` (not tied to one) or `'none'` (not a phase). */
function phaseOf(e: EdgeEndpoint): WorkItemPhase | 'unknown' | 'none' {
  if (e in STEPS) {
    const step = STEPS[e as keyof typeof STEPS];
    if (e === '8.1') return 'G4'; // G4 review: the item waits in the G4 phase
    if (e === '8.2') return 'S8a'; // human merges: DM S8a "observe merge"
    return step.stage as WorkItemPhase;
  }
  if (e === 'D1' || e === 'D2' || e === 'D3') return 'Handoff';
  if (e === 'D4' || e === 'D5') return 'none';
  if (e === 'REQ' || e === 'Blocked' || e === 'ReleaseHeld' || e === 'SpikeReport') return 'none';
  if (e in GATES) {
    const map: Partial<Record<string, WorkItemPhase>> = {
      G0: 'S1',
      G1: 'S1',
      G1f: 'S2',
      G2: 'S3',
      G3: 'S5',
      G3s: 'S5',
      G3d: 'S4',
      G3o: 'S6',
      G4: 'G4',
      G5: 'G5',
      G6: 'G6',
      X1: 'S6',
      X3: 'S6',
      X2: 'S7',
      E4: 'Handoff',
      Q1: 'Quarantined',
      SECT: 'Quarantined',
    };
    return map[e] ?? 'unknown';
  }
  return (WorkItemPhaseValues as readonly string[]).includes(e) ? (e as WorkItemPhase) : 'none';
}

/** Edges left out of the check, each with the reason. Anything else that cannot be mapped fails. */
const EXCLUDED: Record<string, string> = {
  'B6:6.2>Blocked': 'Blocked is a named wait on S6, not a WorkItem phase',
  'B12:7.2>E6': 'E6 is a wait inside S7; E6 -> G3o -> S6 is covered by S7 -> S6 (B9, E2)',
  'B16:S8b>REQ': 'a NEW linked item, not a transition of this item',
  'B17:9.3>REQ': 'a NEW linked item, not a transition of this item',
  'B18:9.2>REQ': 'a NEW linked item, not a transition of this item',
  'B19:9.5>REQ': 'a NEW linked item, not a transition of this item',
  'B25:E2>4.1': 'E2 is raised from S4 (4.5) and from S7 (7.5); the source phase is not fixed',
  'B26:G5>ReleaseHeld': 'ReleaseHeld is a named wait on G5, not a WorkItem phase',
  'R4:S8b>REQ': 'a NEW linked item, not a transition of this item',
};

type Row = { key: string; from: EdgeEndpoint | null; to: EdgeEndpoint };

const rows: Row[] = [
  ...Object.entries(BACK_EDGES).flatMap(([id, e]) =>
    e.to.map((to) => ({ key: `${id}:${e.from}>${to}`, from: e.from, to })),
  ),
  ...[...HANDOFF_EDGES, ...RELANE_EDGES, ...QUARANTINE_EDGES].flatMap((e) =>
    e.to.map((to) => ({ key: `${e.id}:${e.from}>${to}`, from: e.from, to })),
  ),
];

describe('WorkItem phases cover the flow edges', () => {
  it('allows every stage-changing flow edge', () => {
    const skipped: string[] = [];
    let checked = 0;
    for (const r of rows) {
      if (r.from === null) {
        skipped.push(`${r.key} (no source)`);
        continue;
      }
      const from = phaseOf(r.from);
      const to = phaseOf(r.to);
      if (typeof EXCLUDED[r.key] === 'string') {
        skipped.push(r.key);
        continue;
      }
      expect(from, `${r.key}: source phase`).not.toMatch(/^(unknown|none)$/);
      expect(to, `${r.key}: target phase`).not.toMatch(/^(unknown|none)$/);
      if (from === to) continue; // inside one stage: not a phase change
      checked++;
      expect(
        canTransitionWorkItem(from as WorkItemPhase, to as WorkItemPhase),
        `${r.key}: ${from} -> ${to}`,
      ).toBe(true);
    }
    expect(checked).toBeGreaterThan(25);
    // Every exclusion listed is real, and the only edges without a source are B20 and B28; B21 has no target.
    expect(skipped.filter((k) => !k.endsWith('(no source)')).sort()).toEqual(
      Object.keys(EXCLUDED).sort(),
    );
    expect(
      skipped
        .filter((k) => k.endsWith('(no source)'))
        .map((k) => k.split(':')[0])
        .sort(),
    ).toEqual(['B20', 'B28']);
  });

  it('allows B20 (amend scope) into S3 from every active build-side phase', () => {
    for (const p of ['S2', 'S4', 'S5', 'Scheduling', 'S6', 'S7', 'G4'] as const) {
      expect(canTransitionWorkItem(p, 'S3'), p).toBe(true);
    }
  });

  it('lets every non-terminal phase but Draft be held and resume', () => {
    const live = WorkItemPhaseValues.filter(
      (p) =>
        ![
          'Draft',
          'Held',
          'Done',
          'Declined',
          'Abandoned',
          'Withdrawn',
          'HandedOverClosed',
          'Superseded',
          'Deferred',
        ].includes(p),
    );
    for (const p of live) {
      expect(canTransitionWorkItem(p, 'Held'), `${p} -> Held`).toBe(true);
      expect(canTransitionWorkItem('Held', p), `Held -> ${p}`).toBe(true);
    }
  });
});
