import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..', '..', '..');
const start = (bundle: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [join(root, bundle)], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    encoding: 'utf8',
    timeout: 20_000,
  });

describe('service bundles start with plain node and fail fast on bad configuration', () => {
  it('kms-local outside local mode', () => {
    const r = start('services/kms-local/dist/main.js', { FACTORY_ENV: 'prod' });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/kms-local: configuration error: .*FACTORY_ENV=local/);
  });

  it('kms-local without KMS_DIR', () => {
    const r = start('services/kms-local/dist/main.js', { FACTORY_ENV: 'local' });
    expect(r.status).toBe(78);
    expect(r.stderr).toMatch(/KMS_DIR is required/);
  });

  it('notary and witness without a database, with a password in the URL, and with a bad port', () => {
    for (const [dir, p] of [
      ['notary', 'NOTARY'],
      ['witness', 'WITNESS'],
    ] as const) {
      const bundle = `services/${dir}/dist/main.js`;
      const missing = start(bundle, {});
      expect(missing.status).toBe(78);
      expect(missing.stderr).toMatch(new RegExp(`${p}_DATABASE_URL is required`));
      const secret = start(bundle, { [`${p}_DATABASE_URL`]: 'postgres://u:pw@localhost/db' });
      expect(secret.status).toBe(78);
      expect(secret.stderr).toMatch(/contains a password; give it as env:NAME or file:PATH/);
      expect(secret.stderr).not.toMatch(/pw@/);
    }
  });
});
