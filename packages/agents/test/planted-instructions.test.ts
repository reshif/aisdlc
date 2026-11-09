import { AgentIdValues } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { AGENT_DEFINITIONS, SAMPLE_OUTPUTS, validateOutput } from '../src/index.js';

// Planted instructions (FL FIX 15; PLAN M11.1, M11.4): text in a request, a repo file or a dependency
// can try to make an agent set the lane, a gate, its tools, network egress or its budget. The defence
// is the schema: those fields do not exist in any OutputSchema, so an output that carries one is refused.

/** The words no output field may be. Compared by token, so `gate_needed` and `delegates` count/do not. */
const FORBIDDEN = [
  'lane',
  'lanes',
  'gate',
  'gates',
  'tool',
  'tools',
  'egress',
  'budget',
  'budgets',
];
const tokens = (name: string): string[] =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/** Every property name anywhere in a JSON Schema document (objects, unions, arrays, definitions). */
function propertyNames(node: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(node)) {
    for (const n of node) propertyNames(n, out);
  } else if (node !== null && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if (k === 'properties' && v !== null && typeof v === 'object' && !Array.isArray(v)) {
        for (const p of Object.keys(v)) out.add(p);
      }
      if (k === 'required' && Array.isArray(v)) for (const p of v) out.add(String(p));
      propertyNames(v, out);
    }
  }
  return out;
}

describe('planted-instruction fields', () => {
  it('no OutputSchema of any agent has a field that names a lane, gate, tools, egress or budget', () => {
    for (const d of AGENT_DEFINITIONS) {
      const names = propertyNames(d.contract.output_schema);
      expect(names.size, d.agent_id).toBeGreaterThan(1);
      const bad = [...names].filter((n) => tokens(n).some((t) => FORBIDDEN.includes(t)));
      expect(bad, `${d.agent_id} output schema has ${bad.join(', ')}`).toEqual([]);
    }
  });

  it('the proposal a classifier makes is `candidate`, not a lane field', () => {
    const names = propertyNames(
      AGENT_DEFINITIONS.find((d) => d.agent_id === 'A1')?.contract.output_schema,
    );
    expect(names.has('candidate')).toBe(true);
    expect(names.has('lane')).toBe(false);
  });

  it('every schema is strict: it refuses an unknown key at the top and inside a nested object', () => {
    for (const id of AgentIdValues) {
      for (const sample of SAMPLE_OUTPUTS[id]) {
        const r = validateOutput(id, { ...sample, extra_field: 1 });
        expect(r.ok, `${id} accepts an unknown key`).toBe(false);
      }
    }
  });

  it('an output that tries to set lane, gate, tools, egress or budget is refused, naming the field', () => {
    const planted: Array<[string, unknown]> = [
      ['lane', 'L0'],
      ['gate', 'G4'],
      ['gates', ['G4']],
      ['tools', ['Bash']],
      ['allowed_tools', ['Bash']],
      ['egress', ['evil.example.com']],
      ['budget', { max_tokens: 1e12 }],
    ];
    for (const id of AgentIdValues) {
      for (const sample of SAMPLE_OUTPUTS[id]) {
        for (const [field, value] of planted) {
          const r = validateOutput(id, { ...sample, [field]: value });
          expect(r.ok, `${id} accepted \`${field}\``).toBe(false);
          if (!r.ok) {
            expect(r.error.errors.map((e) => e.path)).toContain(field);
            expect(r.error.errors.find((e) => e.path === field)?.code).toBe('unrecognized_keys');
          }
        }
      }
    }
  });

  it('refuses the same fields planted inside a nested object', () => {
    const review = SAMPLE_OUTPUTS.A5[1] as { findings: Array<Record<string, unknown>> };
    const r = validateOutput('A5', {
      ...review,
      findings: [{ ...(review.findings[0] ?? {}), lane: 'L0', tools: ['Bash'] }],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.errors.map((e) => e.path)).toEqual(
        expect.arrayContaining(['findings[0].lane', 'findings[0].tools']),
      );
    }
  });

  it('the factory, not the agent, fixes the key: the contract holds the tools and the budget', () => {
    for (const d of AGENT_DEFINITIONS) {
      expect(Array.isArray(d.contract.tools)).toBe(true);
      expect(d.contract.budget.max_tokens).toBeGreaterThan(0);
    }
  });
});
