import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigRegistry } from '../src/index.js';
import { makeRegistry } from './helpers.js';

describe('ConfigRegistry', () => {
  const r = makeRegistry();

  it('validates a full document and returns the parsed values', () => {
    const v = r.validate('factory', { 'gateway.budget_usd': 5, 'ops.kill.enabled': false });
    expect(v.ok && v.value).toEqual({ 'gateway.budget_usd': 5, 'ops.kill.enabled': false });
  });

  it('refuses an unknown key', () => {
    const v = r.validate('factory', { 'gateway.budget': 5 });
    expect(!v.ok && v.error.code).toBe('unknown_key');
  });

  it('refuses a value its schema refuses, and lists every problem', () => {
    const v = r.validate('factory', {
      'gateway.budget_usd': -1,
      'catalogue.pin': 'latest',
      'ops.kill.enabled': 'yes',
    });
    expect(!v.ok && v.error.code).toBe('invalid_value');
    expect(!v.ok && v.error.message).toMatch(/gateway.budget_usd.*catalogue.pin.*ops.kill.enabled/);
  });

  it('a project layer may only set keys marked overridable', () => {
    expect(r.validate('project', { 'gateway.budget_usd': 5, 'ops.beta': true }).ok).toBe(true);
    const v = r.validate('project', { 'catalogue.pin': '1.2.3' });
    expect(!v.ok && v.error.code).toBe('not_overridable');
    const f = r.validate('project', { 'ops.kill.enabled': false });
    expect(!f.ok && f.error.code).toBe('not_overridable');
  });

  it('refuses a document that is not an object', () => {
    for (const d of [null, [], 'x', 3]) {
      const v = r.validate('factory', d);
      expect(!v.ok && v.error.code).toBe('invalid_input');
    }
  });

  it('refuses a bad key, a duplicate and a default its own schema refuses', () => {
    expect(() =>
      new ConfigRegistry().opsFlag({ key: 'Bad Key', default: true, description: '' }),
    ).toThrow();
    expect(() =>
      new ConfigRegistry()
        .opsFlag({ key: 'a.b', default: true, description: '' })
        .opsFlag({ key: 'a.b', default: false, description: '' }),
    ).toThrow(/twice/);
    expect(() =>
      new ConfigRegistry().setting({
        key: 'a.b',
        schema: z.number(),
        default: 'x' as never,
        description: '',
      }),
    ).toThrow(/default/);
  });

  it('defaults are exposed and keys are listed', () => {
    expect(r.defaults()['gateway.budget_usd']).toBe(100);
    expect(r.keys()).toContain('ops.kill.enabled');
  });
});
