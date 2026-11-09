import { makeCanary } from '@aisdlc/secrets-rules';
import { describe, expect, it } from 'vitest';
import { envCredentialProblems } from '../src/index.js';

describe('envCredentialProblems (the environment assertion the driver runs on what it sends and on what the daemon made)', () => {
  it('passes plain variables and the wrapper set', () => {
    expect(
      envCredentialProblems(
        [
          'PATH=/usr/bin',
          'HOME=/work',
          'AISDLC_REPO_MODE=ro',
          'AISDLC_OUT_MARK=abc',
          'NODE_VERSION=22.23.4',
        ],
        false,
      ),
    ).toEqual([]);
  });
  it('flags a credential by name, by value and a canary', () => {
    expect(envCredentialProblems(['GITHUB_TOKEN=x'], false)).toHaveLength(1);
    expect(envCredentialProblems(['NOTE=' + makeCanary('v')], false).join()).toMatch(/value/);
    expect(envCredentialProblems(['AWS_SECRET_ACCESS_KEY=x'], false)).not.toEqual([]);
  });
  it('allows the gateway key pair only where the class has a key', () => {
    expect(
      envCredentialProblems(
        ['AISDLC_GATEWAY_KEY=vk_x', 'AISDLC_GATEWAY_URL=http://gateway:8410'],
        true,
      ),
    ).toEqual([]);
    expect(envCredentialProblems(['AISDLC_GATEWAY_KEY=vk_x'], false)).toHaveLength(1);
  });
});
