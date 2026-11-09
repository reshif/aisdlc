import { AgentIdValues, type AgentId } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { OUTPUT_SCHEMAS, SAMPLE_OUTPUTS, agentDefinition, validateOutput } from '../src/index.js';

/** The `kind` literals of a schema (a discriminated union's members, or the one object). */
function kindsOf(id: AgentId): string[] {
  const schema = OUTPUT_SCHEMAS[
    agentDefinition(id).contract.output_schema_id as keyof typeof OUTPUT_SCHEMAS
  ] as unknown as {
    options?: Array<{ shape: { kind: { value: string } } }>;
    shape?: { kind: { value: string } };
  };
  if (schema.options) return schema.options.map((o) => o.shape.kind.value);
  return [schema.shape?.kind.value as string];
}

describe('validateOutput (PLAN M11.1: every agent output validates against its OutputSchema)', () => {
  it('accepts a sample of every kind of every agent', () => {
    for (const id of AgentIdValues) {
      expect(SAMPLE_OUTPUTS[id].length, id).toBeGreaterThan(0);
      for (const sample of SAMPLE_OUTPUTS[id]) {
        const r = validateOutput(id, sample);
        expect(r.ok, `${id} ${String(sample['kind'])}: ${JSON.stringify(r)}`).toBe(true);
      }
    }
  });

  it('has a sample for every kind of every schema, so none goes untested', () => {
    for (const id of AgentIdValues) {
      const sampled = [...new Set(SAMPLE_OUTPUTS[id].map((s) => s['kind']))].sort();
      expect(sampled, id).toEqual(kindsOf(id).sort());
    }
  });

  it('refuses output that is not an object, is empty, or has an unknown kind, with a field-level error', () => {
    for (const bad of [null, 'text', 3, [], {}, { kind: 'nope' }]) {
      const r = validateOutput('A3', bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error._tag).toBe('OutputInvalid');
        expect(r.error.agent_id).toBe('A3');
        expect(r.error.errors.length).toBeGreaterThan(0);
      }
    }
  });

  it('refuses an unknown agent (fail closed)', () => {
    const r = validateOutput('A99', SAMPLE_OUTPUTS.A1[0]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.errors[0]).toMatchObject({ path: '$', code: 'unknown_agent' });
  });

  it('names the field of each problem', () => {
    const r = validateOutput('A9', {
      kind: 'reverse_engineering',
      depth: 'deep',
      claims: [{ claim_id: 'c1', text: 'x', confidence: 'high', evidence: [] }],
      unknowns: [],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const paths = r.error.errors.map((e) => e.path);
    expect(paths).toContain('depth');
    expect(paths).toContain('claims[0].evidence');
  });

  it('a claim without evidence is a fabrication and is refused; a bad commit SHA too', () => {
    const noEvidence = validateOutput('A9', {
      kind: 'reverse_engineering',
      depth: 'shallow',
      claims: [{ claim_id: 'c1', text: 'x', confidence: 'low', evidence: [] }],
      unknowns: [],
    });
    expect(noEvidence.ok).toBe(false);
    const badSha = validateOutput('A12', {
      kind: 'extraction',
      items: [
        {
          item_kind: 'living_spec_seed',
          title: 't',
          evidence: [{ path: 'a.ts', commit_sha: 'main' }],
        },
      ],
    });
    expect(badSha.ok).toBe(false);
    if (!badSha.ok) expect(badSha.error.errors[0]?.path).toBe('items[0].evidence[0].commit_sha');
  });

  it('keeps the cross-field rules: a pass has no findings; blocked needs a blocker; recommended is an option', () => {
    expect(
      validateOutput('A5', {
        kind: 'review',
        check: 'spec_review',
        verdict: 'pass',
        findings: [{ severity: 'low', location: { path: 'a' }, message: 'm' }],
      }).ok,
    ).toBe(false);
    expect(
      validateOutput('coder', {
        kind: 'implementation',
        status: 'blocked',
        summary: 's',
        files_changed: [],
        checks_run: [],
      }).ok,
    ).toBe(false);
    const options = SAMPLE_OUTPUTS.A3[1] as Record<string, unknown>;
    expect(validateOutput('A3', { ...options, recommended: 4 }).ok).toBe(false);
  });

  it('an A4 and a coder output are the same schema', () => {
    expect(agentDefinition('A4').contract.output_schema).toEqual(
      agentDefinition('coder').contract.output_schema,
    );
  });
});
