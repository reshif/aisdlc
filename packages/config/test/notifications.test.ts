import { NOTIFICATIONS_CONFIG_KEY } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { ConfigRegistry, registerNotificationsConfig } from '../src/index.js';

// PLAN M18: `notifications.channels` is a factory key, empty by default, credentials as file: references only, and
// secret-scanned like the integration registry.

const slack = {
  channel_id: 'ops-slack',
  kind: 'slack_webhook',
  display_name: 'Ops channel',
  enabled: true,
  data_class_max: 'D1',
  default_on: true,
  webhook_ref: 'file:/run/secrets/slack-ops-webhook',
};
const email = {
  channel_id: 'mail',
  kind: 'email_smtp',
  display_name: 'Email',
  enabled: true,
  data_class_max: 'D0',
  default_on: true,
  host: 'smtp.example.com',
  port: 587,
  tls: 'starttls',
  from: 'factory@example.com',
  username_ref: 'file:/run/secrets/smtp-user',
  password_ref: 'file:/run/secrets/smtp-pass',
};

describe('notifications.channels', () => {
  const r = registerNotificationsConfig(new ConfigRegistry());

  it('is registered once, factory only, empty by default', () => {
    expect(registerNotificationsConfig(r)).toBe(r);
    expect(r.defaults()[NOTIFICATIONS_CONFIG_KEY]).toEqual([]);
    expect(r.validate('factory', { [NOTIFICATIONS_CONFIG_KEY]: [slack, email] }).ok).toBe(true);
    const p = r.validate('project', { [NOTIFICATIONS_CONFIG_KEY]: [] });
    expect(!p.ok && p.error.code).toBe('not_overridable');
  });

  it('takes credentials as file: references only, never env: or a value', () => {
    for (const bad of [
      { ...slack, webhook_ref: 'env:SLACK_WEBHOOK' },
      { ...slack, webhook_ref: ['https', '://hooks.slack.com/services/T0/B0/abc'].join('') },
      { ...email, password_ref: 'hunter2hunter2' },
    ]) {
      const v = r.validate('factory', { [NOTIFICATIONS_CONFIG_KEY]: [bad] });
      expect(!v.ok && v.error.code).toBe('invalid_value');
    }
  });

  it('refuses a URL in a label, a password without TLS, D2, half credentials and a duplicate id', () => {
    for (const rows of [
      [{ ...slack, display_name: ['https', '://hooks.slack.com/x'].join('') }],
      [{ ...email, tls: 'none' }],
      [{ ...slack, data_class_max: 'D2' }],
      [{ ...email, password_ref: null }],
      [slack, { ...slack }],
    ]) {
      const v = r.validate('factory', { [NOTIFICATIONS_CONFIG_KEY]: rows });
      expect(!v.ok && v.error.code, JSON.stringify(rows)).toBe('invalid_value');
    }
    // a relay with no credentials may run without TLS (a local relay)
    const plain = { ...email, tls: 'none', username_ref: null, password_ref: null };
    expect(r.validate('factory', { [NOTIFICATIONS_CONFIG_KEY]: [plain] }).ok).toBe(true);
  });

  it('runs the shared secret ruleset over the document and names the rule, never the value', () => {
    const token = ['xo', 'xb-', '1234567890-', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('');
    const v = r.validate('factory', {
      [NOTIFICATIONS_CONFIG_KEY]: [{ ...slack, display_name: token }],
    });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.error.message).toMatch(/slack-token/);
    expect(!v.ok && v.error.message).not.toContain(token);
  });
});
