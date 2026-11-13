import { GithubAppReport } from '@aisdlc/contracts';
import { contractSeed } from '@aisdlc/ports/testing';
import { FakeIdentityLinks } from '../src/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKENS, startCodeHostApp, type CodeHostTestApp } from './stack.js';

// `GET /v1/app` (the portal's GitHub Apps panel, through core): which App the codehost holds, whether its key loaded,
// and the installation as GitHub shows it to the App now. Never the key.

let t: CodeHostTestApp | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

const facts = {
  main: {
    job: 'read' as const,
    app_id: '123456',
    installation_id: 4242,
    login: null,
    key_loaded: true,
    last_ok_at: null,
  },
  tracker: {
    job: 'tracker' as const,
    app_id: '123456',
    installation_id: 4242,
    login: 'aisdlc-factory-abc[bot]',
    key_loaded: true,
    last_ok_at: null,
  },
};

describe('GET /v1/app', () => {
  it('reports the App, the key as loaded, and the installation GitHub shows (posture or status)', async () => {
    t = await startCodeHostApp(
      new FakeIdentityLinks(),
      contractSeed(),
      undefined,
      undefined,
      undefined,
      facts,
    );
    const r = await t.call(TOKENS.posture, 'GET', '/v1/app');
    expect(r.status).toBe(200);
    const body = GithubAppReport.parse(r.json);
    expect(body.reports.map((x) => x.job)).toEqual(['read', 'tracker']);
    expect(body.reports[0]?.installation).toEqual({
      state: 'ok',
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'read', metadata: 'read', statuses: 'write' },
      suspended: false,
    });
    expect(body.reports[1]?.installation).toEqual({ state: 'unknown', reason: 'not_read' });
    expect(r.text).not.toMatch(/PRIVATE KEY|ghs_|eyJ/);
    expect((await t.call(TOKENS.census, 'GET', '/v1/app')).status).toBe(403);
  });

  it('reads the installation as unknown when GitHub does not answer, never ok', async () => {
    t = await startCodeHostApp(
      new FakeIdentityLinks(),
      contractSeed(),
      undefined,
      undefined,
      undefined,
      facts,
    );
    t.gh.server.answerWith(503);
    const r = await t.call(TOKENS.posture, 'GET', '/v1/app');
    expect(r.status).toBe(200);
    expect(GithubAppReport.parse(r.json).reports[0]?.installation.state).not.toBe('ok');
  });
});
