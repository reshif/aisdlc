import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from '../src/index.js';
import { SCHEMAS, generateJsonSchema, generateJsonSchemaText } from '../src/json-schema.js';

describe('JSON Schema', () => {
  it('covers every exported Zod schema', () => {
    const exported = Object.entries(contracts)
      .filter(([, v]) => v instanceof z.ZodType)
      .map(([k]) => k)
      .sort();
    expect(Object.keys(SCHEMAS).sort()).toEqual(exported);
  });

  it('is draft 2020-12 with one def per schema', () => {
    const doc = generateJsonSchema() as { $schema: string; $defs: Record<string, unknown> };
    expect(doc.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
    expect(Object.keys(doc.$defs).sort()).toEqual(Object.keys(SCHEMAS).sort());
    expect(doc.$defs['Lane']).toMatchObject({ type: 'string', enum: contracts.LaneValues });
  });

  // Stale-file check: `npm run gen -w @aisdlc/contracts` rewrites it (vitest -u).
  it('matches the committed generated file', async () => {
    await expect(generateJsonSchemaText()).toMatchFileSnapshot(
      '../generated/contracts.schema.json',
    );
  });
});
