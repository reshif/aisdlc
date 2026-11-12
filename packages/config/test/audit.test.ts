import { AUDIT_RETENTION_CONFIG_KEY, DEFAULT_AUDIT_RETENTION } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { ConfigRegistry, registerAuditConfig } from '../src/index.js';

// PLAN M19: `audit.retention` is a factory key (M1-gated like every revision) whose default erases nothing.

describe('audit.retention', () => {
  const r = registerAuditConfig(new ConfigRegistry());

  it('is registered once, factory only, and keeps everything by default', () => {
    expect(registerAuditConfig(r)).toBe(r);
    expect(r.defaults()[AUDIT_RETENTION_CONFIG_KEY]).toEqual(DEFAULT_AUDIT_RETENTION);
    expect(DEFAULT_AUDIT_RETENTION.classes.conversation_payload.days).toBeNull();
    const set = { classes: { conversation_payload: { days: 365 } } };
    expect(r.validate('factory', { [AUDIT_RETENTION_CONFIG_KEY]: set }).ok).toBe(true);
    const p = r.validate('project', { [AUDIT_RETENTION_CONFIG_KEY]: set });
    expect(!p.ok && p.error.code).toBe('not_overridable');
  });

  it('refuses a zero or negative period, an unknown class, and a class for the record or the ledger', () => {
    for (const bad of [
      { classes: { conversation_payload: { days: 0 } } },
      { classes: { conversation_payload: { days: -1 } } },
      { classes: { conversation_payload: { days: 30 }, record_event: { days: 30 } } },
      { classes: { ledger: { days: 30 } } },
      { classes: {} },
    ]) {
      const v = r.validate('factory', { [AUDIT_RETENTION_CONFIG_KEY]: bad });
      expect(!v.ok && v.error.code, JSON.stringify(bad)).toBe('invalid_value');
    }
  });
});
