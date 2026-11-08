import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BACK_EDGES,
  BackEdgeIdValues,
  GateIdValues,
  HANDOFF_DESCRIPTIONS,
  HandoffIdValues,
  RELANE_DESCRIPTIONS,
  RelaneIdValues,
  STEPS,
  StageIdValues,
  StepIdValues,
  TRIGGER_DESCRIPTIONS,
  TriggerIdValues,
  type StageId,
} from '../src/index.js';

const mmd = readFileSync(
  fileURLToPath(new URL('../../../docs/specs/flow-corrected.mmd', import.meta.url)),
  'utf8',
);
/** Comments (`%%`) are the change log, not the diagram: ids are read from the diagram body only. */
const body = mmd
  .split('\n')
  .filter((l) => !l.trim().startsWith('%%'))
  .join('\n');
/** Node text with line breaks as spaces, for substring checks. */
const flat = body.replaceAll('<br/>', ' ').replace(/\s+/g, ' ');

const uniq = (xs: Iterable<string>) => [...new Set(xs)].sort();
const found = (re: RegExp) => uniq([...body.matchAll(re)].map((m) => m[0]));

// Gate ids: G0 G1 G2 G3 G3d G3o G3s G4 G5 G6, X1-4, E1-6, M1-6, Q1, SECT. `\b` keeps D37, MM-2,
// G0G1 (a node id) and F1..F15 (change-log tags) out.
const GATE_RE = /\b(?:G\d[a-z]?|X\d|E\d|M\d|Q\d|SECT)\b/g;
const STEP_RE = /\b(?:\d\.\d[b]?|S8b)\b/g;

const mentioned = {
  gates: found(GATE_RE),
  backEdges: found(/\bB\d+/g),
  triggers: found(/\bET\d+\b/g),
  handoffs: found(/\bD\d\b/g),
  relanes: found(/\bR\d\b/g),
  steps: found(STEP_RE),
  stages: found(/\bS\d[ab]?\b/g),
};

describe('flow-corrected.mmd resolves to contract values', () => {
  it('finds ids at all', () => {
    expect(mentioned.gates.length).toBeGreaterThan(20);
    expect(mentioned.steps.length).toBeGreaterThan(50);
  });

  it('resolves every gate id', () => {
    expect(mentioned.gates.filter((g) => !(GateIdValues as readonly string[]).includes(g))).toEqual(
      [],
    );
  });

  it('resolves every back-edge id, and the flow draws B1..B28 in full', () => {
    const ids = uniq(mentioned.backEdges.map((b) => b.replace(/(\d+)[a-z]$/, '$1')));
    expect(ids.filter((b) => !(BackEdgeIdValues as readonly string[]).includes(b))).toEqual([]);
    expect(ids).toEqual(uniq(BackEdgeIdValues));
  });

  it('resolves every ET, handoff, re-lane and stage id', () => {
    const missing = (xs: string[], vs: readonly string[]) => xs.filter((x) => !vs.includes(x));
    expect(missing(mentioned.triggers, TriggerIdValues)).toEqual([]);
    expect(missing(mentioned.handoffs, HandoffIdValues)).toEqual([]);
    expect(missing(mentioned.relanes, RelaneIdValues)).toEqual([]);
    expect(missing(mentioned.stages, StageIdValues)).toEqual([]);
  });

  it('resolves every step number', () => {
    expect(mentioned.steps.filter((s) => !(StepIdValues as readonly string[]).includes(s))).toEqual(
      [],
    );
  });

  it('draws every step node with the stage and actor the contract has', () => {
    const nodeRe = /\b(s\w+)\["((?:\d\.\d[b]?|S8b)) [^"]*"\]:::(\w+)/g;
    const stageOfSubgraph = new Map<string, string>();
    let current: string | null = null;
    for (const line of body.split('\n')) {
      const open = /^\s*subgraph (\w+)\[/.exec(line);
      if (open) current = open[1] ?? null;
      else if (/^\s*end\s*$/.test(line)) current = null;
      for (const m of line.matchAll(nodeRe)) {
        if (current !== null) stageOfSubgraph.set(m[2] ?? '', current);
      }
    }
    let nodes = 0;
    for (const m of body.matchAll(/\b(s\w+)\["([^"]*)"\]:::(\w+)/g)) {
      const text = (m[2] ?? '').split('<br/>');
      const num = /^(\d\.\d[b]?|S8b) /.exec(text[0] ?? '')?.[1];
      if (num === undefined) continue;
      nodes++;
      const id = num as keyof typeof STEPS;
      const second = text[1] ?? '';
      const actor =
        /^(D\+A|A\+H|D\+H|D|A|H)(?![\w+])/.exec(second)?.[1] ??
        /·\s*(D\+A|A\+H|D\+H|D|A|H)$/.exec(second)?.[1] ??
        (m[3] === 'H' ? 'H' : undefined);
      expect(STEPS[id], num).toBeDefined();
      expect(STEPS[id].actor, `actor of ${num}`).toBe(actor);
      const box = stageOfSubgraph.get(num);
      const expectedStage: StageId = num === 'S8b' ? 'S8b' : (`S${num.split('.')[0]}` as StageId);
      expect(STEPS[id].stage, `stage of ${num}`).toBe(expectedStage);
      if (box !== undefined && num !== 'S8b') expect(box, `box of ${num}`).toBe(STEPS[id].stage);
    }
    expect(nodes).toBe(StepIdValues.length);
  });

  it('quotes the flow for every back-edge description', () => {
    for (const id of BackEdgeIdValues) {
      for (const part of BACK_EDGES[id].description.split(' | ')) {
        const label = /^B\d+[ab] /.test(part) ? part : `${id} ${part}`;
        expect(flat, `${id}: ${label}`).toContain(label);
      }
    }
  });

  it('quotes the flow for every trigger description', () => {
    for (const id of TriggerIdValues) {
      for (const part of (TRIGGER_DESCRIPTIONS[id] ?? '').split(' | ').filter(Boolean)) {
        expect(flat.toLowerCase(), `${id}: ${part}`).toContain(part.toLowerCase());
      }
    }
  });

  it('quotes the flow for handoff and re-lane descriptions', () => {
    for (const [table, ids] of [
      [HANDOFF_DESCRIPTIONS, HandoffIdValues],
      [RELANE_DESCRIPTIONS, RelaneIdValues],
    ] as const) {
      for (const id of ids) {
        expect(flat, id).toContain(`${id} ${(table as Record<string, string>)[id]}`);
      }
    }
  });

  it('names the terminals and waits the flow draws', () => {
    for (const word of [
      'PARKED',
      'BLOCKED',
      'DECLINED',
      'ABANDONED',
      'DONE',
      'SPIKE REPORT',
      'RELEASE HELD',
    ]) {
      expect(flat).toContain(word);
    }
  });

  it('reports contract ids the flow never mentions', () => {
    const unmentioned = {
      gates: GateIdValues.filter((g) => !mentioned.gates.includes(g)),
      backEdges: BackEdgeIdValues.filter((b) => !mentioned.backEdges.includes(b)),
      triggers: TriggerIdValues.filter((t) => !mentioned.triggers.includes(t)),
      handoffs: HandoffIdValues.filter((d) => !mentioned.handoffs.includes(d)),
      relanes: RelaneIdValues.filter((r) => !mentioned.relanes.includes(r)),
      steps: StepIdValues.filter((s) => !mentioned.steps.includes(s)),
      stages: StageIdValues.filter((s) => !mentioned.stages.includes(s)),
    };
    console.info(`contract ids the flow never mentions: ${JSON.stringify(unmentioned)}`);
    // G1f is the flow's "G1 Intent acceptance, FINAL" (step 2.5); S8a exists only in DM 6.1.
    expect(unmentioned).toEqual({
      gates: ['G1f'],
      backEdges: [],
      triggers: [],
      handoffs: [],
      relanes: [],
      steps: [],
      stages: ['S8a'],
    });
  });
});
