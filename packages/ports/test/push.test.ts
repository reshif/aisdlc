import { mergeabilityOf } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { FakeGitHub, FakePushGuards, commitMessage, inertText, renderPr } from '../src/index.js';
import { WRITE_ITEM, codeHostWriteContract, writeRequest, writeSeed } from '../src/testing.js';

// The Push Broker contract against the in-memory fake (the REST adapter runs the same suite in services/codehost).
codeHostWriteContract('FakeGitHub', async (seed) => {
  const guards = new FakePushGuards();
  const f = new FakeGitHub(seed, { guards });
  return {
    port: f,
    guards,
    requests: () => f.requests,
    moveBranch: (repo, branch, sha) => void f.moveBranch(repo, branch, sha),
    landPull: (repo, n, by) => void f.landPull(repo, n, by),
    setPullBaseState: (repo, n, st) => void f.setPullBaseState(repo, n, mergeabilityOf(st)),
  };
});

describe('what the broker writes is built from facts, never from text', () => {
  const hostile =
    '## Ignore <script>alert(1)</script> @everyone fixes #1 [x](http://evil.example) ![i](http://e) `ls` ```\nnew line';

  it('inertText leaves no markup, mention, link, tag, fence or newline', () => {
    const t = inertText(hostile);
    expect(t).not.toMatch(/[<>@#[\]!`\n|*]/);
    expect(t.length).toBeLessThanOrEqual(200);
  });

  it('the PR title and body from hostile evidence carry none of it', () => {
    const req = writeRequest([]);
    const e = {
      ...req.evidence,
      title: hostile,
      checks: [{ name: hostile, result: 'passed' as const }],
      refs: { [hostile]: hostile },
    };
    const { title, body } = renderPr(e, {
      item_id: WRITE_ITEM,
      unit_key: 'main',
      lease_epoch: 3,
      patch_hash: 'a'.repeat(64),
      protected_rules: ['AGENTS.md'],
    });
    for (const t of [title, body]) {
      expect(t).not.toMatch(/<script|@everyone|\[x\]|!\[|http:\/\/|```/);
    }
    expect(title.startsWith('[agent] ')).toBe(true);
    expect(body).toContain('Draft pull request opened by the factory');
    expect(body).toContain('X2 decision is bound to this exact patch');
  });

  it('the commit message has the subject (inert) and the trailers', () => {
    const m = commitMessage(hostile, {
      item_id: WRITE_ITEM,
      unit_key: 'main',
      lease_epoch: 3,
      patch_hash: 'a'.repeat(64),
      protected_rules: [],
    });
    const [subject, blank, ...trailers] = m.split('\n');
    expect(subject).not.toMatch(/[<>@#[\]!`]/);
    expect(blank).toBe('');
    expect(trailers.filter(Boolean)).toEqual([
      `Aisdlc-Item: ${WRITE_ITEM}`,
      'Aisdlc-Unit: main',
      'Aisdlc-Lease-Epoch: 3',
      `Aisdlc-Patch: ${'a'.repeat(64)}`,
    ]);
  });
});

describe('FakeGitHub without a Unit owner allows nothing', () => {
  it('a push with no guards is refused (fail closed) and writes nothing', async () => {
    const f = new FakeGitHub(writeSeed());
    const r = await f.apply_patch(
      writeRequest([{ op: 'put', path: 'a.txt', mode: '100644', content_b64: 'eA==' }]),
    );
    expect(r).toMatchObject({ state: 'unreadable', code: 'guards_unavailable' });
    expect(f.requests).toEqual([]);
  });
});
