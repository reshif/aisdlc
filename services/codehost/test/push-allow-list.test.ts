import { CODEHOST_ROLE_PERMISSIONS, forbiddenPermissionsIn } from '@aisdlc/contracts';
import { FakePushGuards } from '@aisdlc/ports';
import {
  WRITE_BRANCH,
  WRITE_ITEM,
  WRITE_UNIT,
  writeRequest,
  writeSeed,
} from '@aisdlc/ports/testing';
import { patchHashOf, patchSetOf } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { replanCommentOf } from '@aisdlc/contracts';
import {
  ALLOW_LIST,
  CONVERT_TO_DRAFT_MUTATION,
  PUSH_ALLOW_LIST,
  checkRequest,
} from '../src/allow-list.js';
import { startTestCodeHost } from '../src/testing.js';

const R = '/repos/acme/app';
const push = (method: string, target: string, body?: unknown) =>
  checkRequest('push', method, target, body);
const A = '0'.repeat(40);

describe('the Push Broker allow-list rows (push mode)', () => {
  it('has exactly the rows the broker needs, every write with a body check and the docs role', () => {
    expect(PUSH_ALLOW_LIST.map((r) => `${r.method} ${r.template}`)).toEqual([
      'GET /repos/{owner}/{repo}/git/commits/{sha}',
      'GET /repos/{owner}/{repo}/pulls',
      'GET /repos/{owner}/{repo}/pulls/{number}',
      'POST /repos/{owner}/{repo}/git/blobs',
      'POST /repos/{owner}/{repo}/git/trees',
      'POST /repos/{owner}/{repo}/git/commits',
      'POST /repos/{owner}/{repo}/git/refs',
      'PATCH /repos/{owner}/{repo}/git/refs/heads/agent/{item}/{unit}',
      'POST /repos/{owner}/{repo}/pulls',
      'GET /repos/{owner}/{repo}/issues/{number}/comments',
      'POST /repos/{owner}/{repo}/issues/{number}/comments',
      'POST /graphql',
      'PATCH /repos/{owner}/{repo}/pulls/{number}',
    ]);
    for (const r of PUSH_ALLOW_LIST.filter((x) => x.method !== 'GET')) {
      expect(r.auth, r.id).toBe('docs');
      expect(r.body, r.id).toBeTypeOf('function');
    }
    // the census list is untouched: every row a GET
    expect(ALLOW_LIST.every((r) => r.method === 'GET')).toBe(true);
  });

  it('the docs role is contents:write and pull_requests:write, and never a forbidden permission', () => {
    expect(CODEHOST_ROLE_PERMISSIONS.docs).toEqual({
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
    expect(forbiddenPermissionsIn(CODEHOST_ROLE_PERMISSIONS.docs)).toEqual([]);
  });

  it('writes are refused in census mode, whatever the row', () => {
    for (const [m, t, b] of [
      ['POST', `${R}/git/blobs`, { content: 'eA==', encoding: 'base64' }],
      ['POST', `${R}/pulls`, { title: 't', head: 'agent/x', base: 'main', body: '', draft: true }],
    ] as const) {
      const v = checkRequest('census', m, t, b);
      expect(!v.ok && v.code).toBe('method_refused');
    }
  });

  it('allows the broker writes with the bodies it sends', () => {
    expect(push('POST', `${R}/git/blobs`, { content: 'eA==', encoding: 'base64' }).ok).toBe(true);
    expect(
      push('POST', `${R}/git/trees`, {
        base_tree: A,
        tree: [
          { path: 'a', mode: '100644', type: 'blob', sha: A },
          { path: 'b', mode: '100755', type: 'blob', sha: null },
        ],
      }).ok,
    ).toBe(true);
    expect(
      push('POST', `${R}/git/commits`, {
        message: 'm',
        tree: A,
        parents: [A],
        author: {},
        committer: {},
      }).ok,
    ).toBe(true);
    expect(push('POST', `${R}/git/refs`, { ref: `refs/heads/${WRITE_BRANCH}`, sha: A }).ok).toBe(
      true,
    );
    expect(push('PATCH', `${R}/git/refs/heads/${WRITE_BRANCH}`, { sha: A, force: false }).ok).toBe(
      true,
    );
    expect(push('PATCH', `${R}/git/refs/heads/${WRITE_BRANCH}`, { sha: A }).ok).toBe(true);
    expect(
      push('POST', `${R}/pulls`, {
        title: 't',
        head: WRITE_BRANCH,
        base: 'main',
        body: 'b',
        draft: true,
      }).ok,
    ).toBe(true);
    expect(push('PATCH', `${R}/pulls/7`, { title: 't', body: 'b' }).ok).toBe(true);
  });

  it('refuses every forbidden verb as a request, before the network (no row exists)', () => {
    const none: Array<[string, string, unknown?]> = [
      ['PUT', `${R}/pulls/7/merge`, { merge_method: 'squash' }],
      ['POST', `${R}/merges`, { base: 'main', head: 'agent/x' }],
      ['POST', `${R}/pulls/7/reviews`, { event: 'APPROVE' }],
      ['PUT', `${R}/pulls/7/reviews/1/dismissals`, {}],
      ['POST', `${R}/pulls/7/requested_reviewers`, { reviewers: ['x'] }],
      ['PUT', `${R}/pulls/7/update-branch`, {}],
      ['DELETE', `${R}/git/refs/heads/${WRITE_BRANCH}`],
      ['DELETE', `${R}/branches/${WRITE_BRANCH}`],
      ['POST', `${R}/rulesets`, {}],
      ['PUT', `${R}/rulesets/1`, {}],
      ['PUT', `${R}/branches/main/protection`, {}],
      ['POST', `${R}/actions/workflows/ci.yml/dispatches`, {}],
      ['PUT', `${R}/actions/secrets/X`, {}],
      ['POST', `${R}/statuses/${A}`, { state: 'success' }],
      ['POST', `${R}/check-runs`, {}],
      ['POST', `${R}/issues`, { title: 'x' }],
      ['POST', `${R}/issues/7/comments`, { body: 'x' }],
      ['POST', `${R}/issues/7/labels`, { labels: ['automerge'] }],
      ['PUT', `${R}/collaborators/x`, {}],
      ['POST', `${R}/hooks`, {}],
      ['POST', `${R}/keys`, {}],
      ['POST', `${R}/git/tags`, {}],
      ['PATCH', `${R}`, { default_branch: 'x' }],
      ['POST', `${R}/pulls/7/comments`, {}],
      ['PUT', `${R}/contents/a.txt`, { message: 'x', content: 'eA==' }],
      ['POST', '/graphql', { query: 'mutation { markPullRequestReadyForReview }' }],
    ];
    for (const [m, t, b] of none) {
      const v = push(m, t, b);
      expect(v.ok, `${m} ${t}`).toBe(false);
    }
  });

  it('refuses the allowed endpoints with a body that would widen them', () => {
    const bad: Array<[string, string, unknown]> = [
      // a ref outside agent/**, created or updated
      ['POST', `${R}/git/refs`, { ref: 'refs/heads/main', sha: A }],
      ['POST', `${R}/git/refs`, { ref: 'refs/tags/v1', sha: A }],
      ['POST', `${R}/git/refs`, { ref: 'refs/heads/agent/../main', sha: A }],
      // a force push
      ['PATCH', `${R}/git/refs/heads/${WRITE_BRANCH}`, { sha: A, force: true }],
      // a PR that is not a draft, or not from agent/**
      [
        'POST',
        `${R}/pulls`,
        { title: 't', head: WRITE_BRANCH, base: 'main', body: 'b', draft: false },
      ],
      ['POST', `${R}/pulls`, { title: 't', head: WRITE_BRANCH, base: 'main', body: 'b' }],
      ['POST', `${R}/pulls`, { title: 't', head: 'feature', base: 'main', body: 'b', draft: true }],
      [
        'POST',
        `${R}/pulls`,
        {
          title: 't',
          head: WRITE_BRANCH,
          base: 'main',
          body: 'b',
          draft: true,
          maintainer_can_modify: true,
        },
      ],
      // closing a PR, moving its base, marking it ready
      ['PATCH', `${R}/pulls/7`, { state: 'closed' }],
      ['PATCH', `${R}/pulls/7`, { base: 'release' }],
      ['PATCH', `${R}/pulls/7`, { draft: false }],
      ['PATCH', `${R}/pulls/7`, {}],
      // a symlink, a submodule or a subtree in a tree; a signed or merge commit
      [
        'POST',
        `${R}/git/trees`,
        { base_tree: A, tree: [{ path: 'l', mode: '120000', type: 'blob', sha: A }] },
      ],
      [
        'POST',
        `${R}/git/trees`,
        { base_tree: A, tree: [{ path: 'l', mode: '160000', type: 'commit', sha: A }] },
      ],
      [
        'POST',
        `${R}/git/trees`,
        { base_tree: A, tree: [{ path: 'd', mode: '040000', type: 'tree', sha: A }] },
      ],
      ['POST', `${R}/git/commits`, { message: 'm', tree: A, parents: [A, A] }],
      ['POST', `${R}/git/commits`, { message: 'm', tree: A, parents: [A], signature: 'x' }],
      ['POST', `${R}/git/blobs`, { content: 'x', encoding: 'utf-8' }],
    ];
    for (const [m, t, b] of bad) {
      const v = push(m, t, b);
      expect(!v.ok && v.code, `${m} ${t} ${JSON.stringify(b)}`).toBe('bad_body');
    }
    // updating a ref that is not agent/<item>/<unit> has no row at all
    for (const ref of ['main', 'agent/x/y', 'agent/../main', 'tags/v1']) {
      const v = push('PATCH', `${R}/git/refs/heads/${ref}`, { sha: A });
      expect(!v.ok && v.code, ref).toMatch(/not_allow_listed|bad_path/);
    }
  });
});

describe('the re-plan rows (owner decision 2026-11-13): the PR back to draft and ONE ids-only comment', () => {
  const comment = replanCommentOf(WRITE_ITEM, 'main', 4);

  it('allows exactly the re-plan comment and the convert-to-draft mutation', () => {
    expect(push('POST', `${R}/issues/7/comments`, { body: comment }).ok).toBe(true);
    expect(push('GET', `${R}/issues/7/comments?per_page=100&page=1`).ok).toBe(true);
    expect(
      push('POST', '/graphql', {
        query: CONVERT_TO_DRAFT_MUTATION,
        variables: { id: 'PR_kwDOAbc' },
      }).ok,
    ).toBe(true);
  });

  it('refuses any other comment text, field, mutation or variable', () => {
    const bad: Array<[string, string, unknown]> = [
      ['POST', `${R}/issues/7/comments`, { body: 'x' }],
      ['POST', `${R}/issues/7/comments`, { body: `${comment} @everyone` }],
      ['POST', `${R}/issues/7/comments`, { body: `${comment}\nlgtm` }],
      ['POST', `${R}/issues/7/comments`, { body: comment.replace(WRITE_ITEM, 'not-an-id') }],
      ['POST', `${R}/issues/7/comments`, { body: comment, title: 'x' }],
      ['POST', '/graphql', { query: 'mutation { markPullRequestReadyForReview }' }],
      [
        'POST',
        '/graphql',
        {
          query: CONVERT_TO_DRAFT_MUTATION.replace('convertPullRequestToDraft', 'mergePullRequest'),
          variables: { id: 'x' },
        },
      ],
      ['POST', '/graphql', { query: CONVERT_TO_DRAFT_MUTATION, variables: { id: 'x', other: 1 } }],
      ['POST', '/graphql', { query: CONVERT_TO_DRAFT_MUTATION, variables: { id: 'a b' } }],
      ['POST', '/graphql', { query: CONVERT_TO_DRAFT_MUTATION }],
      ['POST', '/graphql', { query: `${CONVERT_TO_DRAFT_MUTATION} `, variables: { id: 'x' } }],
    ];
    for (const [m, t, b] of bad) {
      const v = push(m, t, b);
      expect(!v.ok && v.code, `${m} ${t} ${JSON.stringify(b)}`).toBe('bad_body');
    }
    // never in census mode, and no other GraphQL path or comment endpoint
    expect(checkRequest('census', 'POST', `${R}/issues/7/comments`, { body: comment }).ok).toBe(
      false,
    );
    expect(
      push('POST', '/api/graphql', { query: CONVERT_TO_DRAFT_MUTATION, variables: { id: 'x' } }).ok,
    ).toBe(false);
    expect(push('POST', `${R}/pulls/7/comments`, { body: comment }).ok).toBe(false);
    expect(push('PATCH', `${R}/issues/comments/1`, { body: comment }).ok).toBe(false);
  });
});

describe('a push over the fake GitHub: what reached the network', () => {
  it('the request log has only allowed writes, and the docs token is the only one that wrote', async () => {
    const guards = new FakePushGuards().setLease(WRITE_ITEM, WRITE_UNIT, {
      held: true,
      epoch: 3,
      lane: 'L4',
    });
    const t = await startTestCodeHost({ seed: writeSeed(), mode: 'push', guards });
    try {
      const patch = [
        { op: 'put' as const, path: 'src/a.js', mode: '100644' as const, content_b64: 'eA==' },
      ];
      const r = await t.rest.apply_patch(writeRequest(patch));
      expect(r.state).toBe('ok');
      const writes = t.server.apiRequests.filter((q) => q.method !== 'GET');
      expect(writes.map((q) => `${q.method} ${q.path.replace(/[0-9a-f-]{36}/g, '<id>')}`)).toEqual([
        'POST /repos/acme/app/git/blobs',
        'POST /repos/acme/app/git/trees',
        'POST /repos/acme/app/git/commits',
        'POST /repos/acme/app/git/refs',
        'POST /repos/acme/app/pulls',
      ]);
      // the token minted for the writes carries exactly the docs role, never a forbidden permission
      const docs = t.server.issued.find((i) => i.permissions['pull_requests'] === 'write');
      expect(docs?.permissions).toEqual(CODEHOST_ROLE_PERMISSIONS.docs);
      for (const i of t.server.issued) expect(forbiddenPermissionsIn(i.permissions)).toEqual([]);
      // no secret in anything the server saw: the tokens are headers, never in a path or the log
      for (const l of t.logs) expect(l).not.toMatch(/ghs_/);
      expect(patchHashOf(patchSetOf(patch))).toBe((r.state === 'ok' && r.value.patch_hash) || '');
      // the commit is the factory's (the App identity) with the trailers
      const c = t.server.objects.commit('acme/app', r.state === 'ok' ? r.value.commit_sha : '');
      expect(c?.author.name).toBe('aisdlc[bot]');
      expect(c?.committer.name).toBe('aisdlc[bot]');
      expect(c?.message).toContain(`Aisdlc-Item: ${WRITE_ITEM}`);
      expect(c?.message).toContain('Aisdlc-Lease-Epoch: 3');
      expect(c?.parents).toHaveLength(1);
      // the PR is a draft, with a body built from facts
      const pr = t.server.pulls[0];
      expect(pr?.draft).toBe(true);
      expect(pr?.body).toContain('Draft pull request opened by the factory');
    } finally {
      await t.stop();
    }
  });

  it('a census-mode host that is asked to push refuses at the allow-list and writes nothing', async () => {
    const guards = new FakePushGuards().setLease(WRITE_ITEM, WRITE_UNIT, {
      held: true,
      epoch: 3,
      lane: 'L4',
    });
    const t = await startTestCodeHost({ seed: writeSeed(), mode: 'census', guards });
    try {
      const r = await t.rest.apply_patch(
        writeRequest([{ op: 'put', path: 'a.txt', mode: '100644', content_b64: 'eA==' }]),
      );
      expect(r.state).not.toBe('ok');
      expect(t.server.apiRequests.every((q) => q.method === 'GET')).toBe(true);
      expect(t.server.issued.every((i) => i.permissions['contents'] !== 'write')).toBe(true);
    } finally {
      await t.stop();
    }
  });
});
