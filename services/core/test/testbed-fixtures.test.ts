import { primaryAgentFor, validateOutput } from '@aisdlc/agents';
import type { ModelCompleteRequest, StepId } from '@aisdlc/contracts';
import {
  TESTBED_IMPLEMENTATION,
  TESTBED_IMPLEMENTATION_PATH,
  TESTBED_ORACLE_PATH,
  TESTBED_PLANNING,
  testbedFixtureReply,
} from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';

// The `testbed` answers of the local fake provider (the compose request-to-PR e2e): every planning answer is a valid
// output of its step's agent, the coding sessions write their file and then answer, and A5 passes the check it is asked.

const req = (messages: ModelCompleteRequest['messages']): ModelCompleteRequest => ({
  model: 'fake-model',
  max_tokens: 100,
  messages,
  metadata: {},
});
const MARKER = `// aisdlc-oracle id=o1 spec=${'a'.repeat(64)}`;

describe('the testbed fixtures of the local fake provider', () => {
  it('every planning step has the output its agent accepts, one Unit and one oracle', () => {
    for (const [step, out] of Object.entries(TESTBED_PLANNING)) {
      const agent = primaryAgentFor(step as StepId);
      const v = validateOutput(agent?.agent_id ?? 'A3', out);
      expect(v.ok, `${step}: ${v.ok ? '' : JSON.stringify(v.error.errors)}`).toBe(true);
    }
    expect((TESTBED_PLANNING['5.1'] as { units: unknown[] }).units).toHaveLength(1);
  });

  it('6.3: writes the oracle with the marker it was given, then answers', () => {
    const prompt = `Step 6.3: write the oracle tests for this Unit.\nThe FIRST line of each file is its marker:\n  ${MARKER}\n`;
    const first = testbedFixtureReply(req([{ role: 'user', content: prompt }]));
    const use = first?.tool_uses?.[0];
    expect(use?.name).toBe('Write');
    const input = use?.input as { file_path: string; content: string };
    expect(input.file_path).toBe(`/work/repo/${TESTBED_ORACLE_PATH}`);
    expect(input.content.split('\n')[0]).toBe(MARKER);
    const after = testbedFixtureReply(
      req([
        { role: 'user', content: prompt },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ]),
    );
    expect(JSON.parse(after?.text ?? '{}')).toMatchObject({ status: 'completed' });
  });

  it('6.4: writes the implementation, then answers with an implementation.v1 the coder contract accepts', () => {
    const prompt =
      'Task t1: farewell\n\nWork only inside the Unit scope. When you are done answer with ONE JSON object of the schema implementation.v1.';
    const use = testbedFixtureReply(req([{ role: 'user', content: prompt }]))?.tool_uses?.[0];
    expect(use?.input).toEqual({
      file_path: `/work/repo/${TESTBED_IMPLEMENTATION_PATH}`,
      content: TESTBED_IMPLEMENTATION,
    });
    const done = testbedFixtureReply(
      req([
        { role: 'user', content: prompt },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ]),
    );
    const v = validateOutput('coder', JSON.parse(done?.text ?? '{}'));
    expect(v.ok, v.ok ? '' : JSON.stringify(v.error.errors)).toBe(true);
  });

  it('7.3 and 7.5: A5 passes the check it is asked; anything else has no fixture', () => {
    for (const check of ['spec_conformance', 'constitution']) {
      const r = testbedFixtureReply(
        req([
          {
            role: 'user',
            content: `context\n\nStep 7.3: review the Unit head. Answer with ONE review.v1 JSON object whose "check" is "${check}".`,
          },
        ]),
      );
      const out = JSON.parse(r?.text ?? '{}');
      expect(out).toEqual({ kind: 'review', check, verdict: 'pass', findings: [] });
      const v = validateOutput('A5', out);
      expect(v.ok, v.ok ? '' : JSON.stringify(v.error.errors)).toBe(true);
    }
    expect(testbedFixtureReply(req([{ role: 'user', content: 'hi' }]))).toBeUndefined();
  });
});
