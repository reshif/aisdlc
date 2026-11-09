import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { addCase, initStore } from '../src/authoring.js';
import { loadPinnedKey } from '../src/pinned.js';
import { resolveStorePath } from '../src/repo-guard.js';
import { EvalStore } from '../src/store.js';
import { KEY_ID, buildStore, cleanup, clock, custody, draftOf, mkTmp, SPECS } from './helpers.js';

afterAll(cleanup);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('where the store may be', () => {
  it('refuses a path inside the repo tree, wherever in it', async () => {
    for (const p of [REPO, join(REPO, 'packages'), join(REPO, 'packages', 'evals', 'src')]) {
      const r = await EvalStore.open(p);
      expect(!r.ok && r.error.code, p).toBe('inside_repo');
    }
  });

  it('refuses a path inside any git worktree (a .git directory or file above it)', () => {
    const wt = mkTmp('aisdlc-wt-');
    mkdirSync(join(wt, '.git'));
    const inner = join(wt, 'evals', 'store');
    mkdirSync(inner, { recursive: true });
    const r = resolveStorePath(inner);
    expect(!r.ok && r.error.code).toBe('inside_repo');
    const wt2 = mkTmp('aisdlc-wt2-');
    writeFileSync(join(wt2, '.git'), 'gitdir: /elsewhere');
    expect(resolveStorePath(wt2).ok).toBe(false);
  });

  it('refuses a symlink that leads into the repo', async () => {
    const { symlinkSync } = await import('node:fs');
    const d = mkTmp();
    symlinkSync(join(REPO, 'packages'), join(d, 'link'));
    const r = resolveStorePath(join(d, 'link'));
    expect(!r.ok && r.error.code).toBe('inside_repo');
  });

  it('refuses when there is no path or no such directory (fail closed)', async () => {
    for (const p of [undefined, '', '/nonexistent/aisdlc-eval-store']) {
      const r = await EvalStore.open(p);
      expect(!r.ok && r.error.code).toBe('missing');
    }
  });

  it('refuses to author into the repo tree too', async () => {
    const r = await initStore(join(REPO, 'packages', 'evals'), {
      store_id: 's',
      key_id: KEY_ID,
      custody: custody(),
    });
    expect(!r.ok && r.error.code).toBe('inside_repo');
    const a = addCase(join(REPO, 'packages', 'evals'), draftOf(SPECS[0]!));
    expect(!a.ok && a.error.code).toBe('inside_repo');
  });

  it('is happy with a directory outside it', async () => {
    const s = await buildStore();
    const o = await s.open();
    expect(o.ok).toBe(true);
    if (o.ok) {
      expect(o.value.store_id).toBe('test-store');
      expect(o.value.caseIds()).toEqual([
        't-exact',
        't-regex',
        't-schema',
        't-security',
        't-subset',
      ]);
    }
  });
});

describe('the signed manifest', () => {
  it('refuses a store whose manifest is gone or is not signed', async () => {
    const s = await buildStore();
    writeFileSync(join(s.path, 'manifest.json'), '{"manifest":{}}');
    const r = await s.open();
    expect(!r.ok && r.error.code).toBe('unsigned');
    const t = await buildStore();
    writeFileSync(join(t.path, 'manifest.json'), 'nope');
    expect((await t.open()).ok).toBe(false);
  });

  it('refuses a tampered manifest: a changed hash, an added file entry, a changed store id', async () => {
    const s = await buildStore();
    const file = join(s.path, 'manifest.json');
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    const edits: Array<(d: typeof doc) => void> = [
      (d) => {
        d.manifest.files['tasks/t-exact.json'] = 'f'.repeat(64);
      },
      (d) => {
        d.manifest.files['tasks/extra.json'] = 'e'.repeat(64);
      },
      (d) => {
        d.manifest.store_id = 'other';
      },
    ];
    for (const edit of edits) {
      const copy = structuredClone(doc);
      edit(copy);
      writeFileSync(file, JSON.stringify(copy));
      const r = await s.open();
      expect(!r.ok && r.error.code).toBe('bad_signature');
    }
    // a signature byte flipped
    const copy = structuredClone(doc);
    copy.signature.value =
      (copy.signature.value[0] === 'A' ? 'B' : 'A') + copy.signature.value.slice(1);
    writeFileSync(file, JSON.stringify(copy));
    expect((await s.open()).ok).toBe(false);
  });

  it('refuses a case file or a grader changed after signing, and a file added without signing', async () => {
    const s = await buildStore();
    const casePath = join(s.path, 'tasks', 't-exact.json');
    const original = readFileSync(casePath, 'utf8');
    writeFileSync(casePath, original.replace('request of', 'tampered'));
    const a = await s.open();
    expect(!a.ok && a.error.code).toBe('tampered');
    writeFileSync(casePath, original);
    expect((await s.open()).ok).toBe(true);

    const hidden = readFileSync(join(s.path, 'tasks', 't-exact.json'), 'utf8');
    const ref = JSON.parse(hidden).hidden_ref.slice('sha256:'.length);
    const hp = join(s.path, 'hidden', `${ref}.json`);
    const h = readFileSync(hp, 'utf8');
    writeFileSync(hp, h.replace('change', 'teleport'));
    const b = await s.open();
    expect(!b.ok && b.error.code).toBe('tampered');
    writeFileSync(hp, h);

    writeFileSync(join(s.path, 'tasks', 'sneaky.json'), '{}');
    const c = await s.open();
    expect(!c.ok && c.error.code).toBe('unlisted_file');
  });

  it('refuses a manifest signed by a key that is not the pinned one', async () => {
    const s = await buildStore({ seed: 'attacker' });
    const good = await buildStore({ seed: 'owner' });
    const r = await EvalStore.open(s.path, { pinned: good.pinned });
    expect(!r.ok && r.error.code).toBe('bad_signature');
  });

  it('with the repo-pinned key, a store signed by any other key is refused (the committed pin is a placeholder nobody holds)', async () => {
    const pin = loadPinnedKey();
    expect(pin.ok && pin.value.key_id).toBe('dev:eval-store');
    const s = await buildStore();
    const r = await EvalStore.open(s.path);
    expect(!r.ok && r.error.code).toBe('bad_signature');
  });

  it('serves nothing that changed after it was opened', async () => {
    const s = await buildStore();
    const o = await s.open();
    if (!o.ok) throw new Error('open');
    expect(o.value.loadCase('t-exact').ok).toBe(true);
    const p = join(s.path, 'tasks', 't-exact.json');
    writeFileSync(p, readFileSync(p, 'utf8').replace('request of', 'changed'));
    const again = o.value.loadCase('t-exact');
    expect(!again.ok && again.error.code).toBe('tampered');
  });

  it('keeps cases free of answers: a case file has an input and a hidden ref, never the expected value', async () => {
    const s = await buildStore();
    const o = await s.open();
    if (!o.ok) throw new Error('open');
    const c = o.value.loadCase('t-exact');
    expect(c.ok && Object.keys(c.value).sort()).toEqual(
      [
        'agent_id',
        'case_id',
        'hidden_ref',
        'input',
        'kind',
        'profile',
        'project_tag',
        'security_tagged',
        'suite_id',
      ].sort(),
    );
    const text = readFileSync(join(s.path, 'tasks', 't-exact.json'), 'utf8');
    expect(text).not.toContain('grader');
    expect(text).not.toContain('rationale');
  });

  it('refuses to add a case twice, and a schema grader with keywords it would not check', async () => {
    const s = await buildStore();
    expect(addCase(s.path, draftOf(SPECS[0]!)).ok).toBe(false);
    const bad = addCase(s.path, {
      ...draftOf(SPECS[0]!, { case_id: 'x-1' }),
      grader: { type: 'schema', schema: { type: 'object', oneOf: [] } },
    });
    expect(!bad.ok && bad.error.code).toBe('invalid');
    void clock;
  });
});
