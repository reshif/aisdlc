import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { noise } from '@aisdlc/codehost/testing';
import { b2Reasons, type BundleManifest } from '@aisdlc/contracts';
import { RULES, RULES_VERSION, makeCanary } from '@aisdlc/secrets-rules';
import {
  FileBundleSource,
  FixtureRepo,
  kmsHmacKeyOf,
  scratchDir,
  startKnowledgeStack,
  type KnowledgeStack,
  type StackOptions,
} from '../src/testing.js';

// M6.2: the secret scan. SEC-OB-2: every way the scan can fail or be cut short is an error or a
// truncation, never a clean result.

const scratch = scratchDir();
afterAll(() => scratch.dispose());

let seq = 0;
/** A repo with a planted canary added in commit 2 and deleted in commit 3: it is not at the head. */
function plantedHistory(name: string) {
  const canary = makeCanary(`planted-${name}`);
  const r = new FixtureRepo(scratch.dir, name);
  r.write('README.md', '# app\n');
  const c1 = r.commit('init');
  r.write('config/settings.txt', `# settings\nmode = prod\nkey = ${canary}\n`);
  const c2 = r.commit('add settings');
  r.remove('config/settings.txt');
  const c3 = r.commit('remove settings');
  return { r, canary, c1, c2, c3 };
}

async function withStack<T>(
  bundle: { file: string; manifest: BundleManifest },
  opts: Partial<StackOptions>,
  fn: (s: KnowledgeStack, logs: string[]) => Promise<T>,
): Promise<T> {
  const logs: string[] = [];
  const s = await startKnowledgeStack({
    source: new FileBundleSource(bundle.file, bundle.manifest),
    log: (l) => logs.push(l),
    ...opts,
  });
  try {
    return await fn(s, logs);
  } finally {
    await s.stop();
  }
}

const bundleOf = (r: FixtureRepo, refs: 'all' | 'default_only' = 'all') =>
  r.bundle(join(scratch.dir, `b-${++seq}.bundle`), refs);

/** A git wrapper that runs `body` (shell) for the calls whose arguments contain `verb`. */
function wrapper(verb: string, body: string): string {
  const f = join(scratch.dir, `w-${++seq}.sh`);
  writeFileSync(
    f,
    `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "${verb}" ]; then\n${body}\n  fi\ndone\nexec git "$@"\n`,
  );
  chmodSync(f, 0o755);
  return f;
}

const findings = async (s: KnowledgeStack) =>
  (await s.call(s.tokens.security, 'GET', '/v1/security/findings')).json as {
    findings: Array<{
      finding_id: string;
      rule_id: string;
      fingerprint: string;
      state: string;
      first_commit: string | null;
      locations: Array<{
        blob_id: string;
        paths: string[];
        line: number;
        first_commit: string | null;
      }>;
    }>;
  };

/** Everything the service wrote or said outside the Security store: the text a secret must not be in. */
async function outsideSecurityStore(s: KnowledgeStack, logs: string[]): Promise<string> {
  const events = await s.db.pool.query(
    'SELECT stream, type, body, actor FROM record.record_event ORDER BY global_seq',
  );
  const jobs = await s.db.pool.query('SELECT * FROM knowledge.knowledge_job');
  const api = [
    await s.call(s.tokens.both, 'GET', '/v1/repos/acme/app/security-summary'),
    ...(await Promise.all(
      jobs.rows.map((j) =>
        s.call(s.tokens.census, 'GET', `/v1/jobs/${(j as { job_id: string }).job_id}`),
      ),
    )),
  ].map((r) => r.text);
  return JSON.stringify([events.rows, jobs.rows, api, logs]);
}

describe('a secret planted in history and deleted at the head', () => {
  it('is found with the right first commit, path and line; open counts say so; the value is nowhere', async () => {
    const { r, canary, c2, c3 } = plantedHistory('planted');
    expect(r.git('ls-tree', '-r', '--name-only', 'HEAD')).toBe('README.md');
    await withStack(bundleOf(r), {}, async (s, logs) => {
      const job = await s.runJob();
      expect(job.state).toBe('done');
      const res = job.result;
      expect(res?.scan_status).toBe('ok');
      expect(res?.scan_error).toBeNull();
      expect(res?.scan_coverage).toMatchObject({
        refs_covered: 'all',
        ref_count: 1,
        commits_scanned: 3,
        truncated: false,
        cap_reached: false,
        lfs_unscanned: 0,
        submodules_listed: 0,
        rules_version: RULES_VERSION,
      });
      expect(res?.scan_coverage.blobs_scanned).toBe(2);
      expect(res?.finding_counts).toEqual({
        open: 1,
        rotated: 0,
        false_positive: 0,
        accepted_test_fixture: 0,
      });
      expect(res?.security_summary.history_scan).toEqual({
        status: 'ok',
        refs_covered: 'all',
        commits_scanned: 3,
        truncated: false,
        open: 1,
        rotated: 0,
        false_positive: 0,
        accepted_test_fixture: 0,
        rules_version: RULES_VERSION,
      });

      const f = (await findings(s)).findings;
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({ rule_id: 'aisdlc-canary', state: 'open', first_commit: c2 });
      expect(f[0]?.locations).toEqual([
        {
          blob_id: expect.stringMatching(/^[0-9a-f]{40}$/),
          paths: ['config/settings.txt'],
          line: 3,
          first_commit: c2,
        },
      ]);
      // Not c3: the commit that removed it is not where it was first seen.
      expect(f[0]?.first_commit).not.toBe(c3);

      // The value appears in no output the Security store does not own, and in no Security API body either.
      const outside = await outsideSecurityStore(s, logs);
      expect(outside).not.toContain(canary);
      const fp = f[0]?.fingerprint ?? '';
      expect(fp).toMatch(/^[0-9a-f]{64}$/);
      // Not even the fingerprint is outside the Security store.
      expect(outside).not.toContain(fp);
      const api = await s.call(s.tokens.security, 'GET', '/v1/security/findings');
      expect(api.text).not.toContain(canary);
      const dump = await s.db.pool.query('SELECT * FROM security_findings.finding_location');
      expect(JSON.stringify(dump.rows)).not.toContain(canary);

      // The summary the census reads: B1 blocked (an open finding), B2 met (complete scan of all refs).
      const sum = (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary'))
        .json as Record<string, unknown>;
      expect(sum).toMatchObject({
        scanned: true,
        b1_blocked: true,
        b2_reasons: [],
        finding_counts: { open: 1 },
      });
    });
  });

  it('has a fingerprint that is the HMAC kms-local holds, identical across two scans, and does not duplicate the finding', async () => {
    const { r, canary } = plantedHistory('twice');
    await withStack(bundleOf(r), {}, async (s) => {
      const key = kmsHmacKeyOf(s.kms);
      const expected = createHmac('sha256', key).update(canary).digest('hex');
      expect((await s.runJob()).state).toBe('done');
      const first = (await findings(s)).findings;
      expect(first[0]?.fingerprint).toBe(expected);
      // The same through the port: the key is only ever used by kms-local.
      const viaKms = await s.kms
        .custodyFor('knowledge')
        .hmac('dev:fingerprint-hmac', Buffer.from(canary));
      expect(viaKms.ok && viaKms.value).toBe(expected);

      expect((await s.runJob()).state).toBe('done');
      const second = (await findings(s)).findings;
      expect(second).toHaveLength(1);
      expect(second[0]?.fingerprint).toBe(expected);
      expect(second[0]?.finding_id).toBe(first[0]?.finding_id);
      // One detected event for it, not two.
      const ev = await s.db.pool.query(
        `SELECT count(*)::int AS n FROM record.record_event WHERE type = 'finding.detected'`,
      );
      expect(ev.rows[0]?.n).toBe(1);
    });
  });

  it('is not weakened by a different secret value: another canary has another fingerprint', async () => {
    const a = plantedHistory('fp-a');
    const b = plantedHistory('fp-b');
    const fps: string[] = [];
    for (const x of [a, b]) {
      await withStack(bundleOf(x.r), {}, async (s) => {
        await s.runJob();
        fps.push((await findings(s)).findings[0]?.fingerprint ?? '');
      });
    }
    expect(fps[0]).not.toBe(fps[1]);
  });
});

describe('what is covered', () => {
  it('finds secrets on every ref and the head tree, deduplicates by blob, and reads binary files', async () => {
    const r = new FixtureRepo(scratch.dir, 'refs');
    r.write('README.md', '# x\n');
    r.commit('init');
    const onDev = makeCanary('dev-only');
    const inPull = makeCanary('pull-only');
    const inTag = makeCanary('tag-only');
    const inBinary = makeCanary('binary');
    const same = makeCanary('same-everywhere');
    r.checkout('dev', true).write('dev.env', `X=${onDev}\n`).commit('dev secret');
    r.checkout('main');
    r.checkout('pr', true).write('pr.txt', `\n\nY=${inPull}\n`).commit('pr secret');
    r.git('update-ref', 'refs/pull/7/head', r.head());
    r.checkout('main').git('branch', '-D', 'pr');
    r.checkout('rel', true).write('rel.txt', `Z=${inTag}\n`).commit('tag secret');
    r.tag('v9');
    r.checkout('main').git('branch', '-D', 'rel');
    r.write(
      'data.bin',
      Buffer.concat([noise('a', 500), Buffer.from(`\0${inBinary}\0`), noise('b', 500)]),
    );
    r.write('one.txt', `S=${same}\n`)
      .write('copy/one.txt', `S=${same}\n`)
      .write('copy2/one.txt', `S=${same}\n`);
    r.commit('head secrets');
    await withStack(bundleOf(r), {}, async (s, logs) => {
      const job = await s.runJob();
      expect(job.state).toBe('done');
      expect(job.result?.scan_status).toBe('ok');
      const f = (await findings(s)).findings;
      const paths = f.flatMap((x) => x.locations.flatMap((l) => l.paths)).sort();
      expect(paths).toEqual([
        'copy/one.txt',
        'copy2/one.txt',
        'data.bin',
        'dev.env',
        'one.txt',
        'pr.txt',
        'rel.txt',
      ]);
      expect(f.map((x) => x.rule_id).every((id) => id === 'aisdlc-canary')).toBe(true);
      // The same blob at three paths is one blob, one location, one finding.
      const sameF = f.filter((x) => x.locations.some((l) => l.paths.includes('one.txt')));
      expect(sameF).toHaveLength(1);
      expect(sameF[0]?.locations).toHaveLength(1);
      expect(sameF[0]?.locations[0]?.paths.sort()).toEqual([
        'copy/one.txt',
        'copy2/one.txt',
        'one.txt',
      ]);
      expect(f).toHaveLength(5);
      // The line of the pull-ref secret.
      const pr = f.find((x) => x.locations.some((l) => l.paths.includes('pr.txt')));
      expect(pr?.locations[0]?.line).toBe(3);
      expect(await outsideSecurityStore(s, logs)).not.toContain(inPull);
    });
  });

  it('a default_only bundle misses the other refs and says so: refs_covered is recorded and B2 blocks', async () => {
    const r = new FixtureRepo(scratch.dir, 'default-only');
    r.write('a.txt', 'a\n').commit('init');
    r.checkout('dev', true)
      .write('dev.env', `X=${makeCanary('hidden-on-dev')}\n`)
      .commit('dev');
    r.checkout('main');
    await withStack(bundleOf(r, 'default_only'), {}, async (s) => {
      const job = await s.runJob('default_only');
      expect(job.result?.scan_coverage.refs_covered).toBe('default_only');
      expect(job.result?.finding_counts.open).toBe(0);
      expect(b2Reasons(job.result as NonNullable<typeof job.result>)).toEqual([
        'refs_default_only',
      ]);
      const sum = (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary'))
        .json as { b2_reasons: string[] };
      expect(sum.b2_reasons).toEqual(['refs_default_only']);
    });
  });

  it('every rule of the shared ruleset fires on its own fixture inside a real repository', async () => {
    const r = new FixtureRepo(scratch.dir, 'allrules');
    RULES.forEach((rule, i) => {
      rule.fixtures.positive().forEach((text, j) => r.write(`fx/${rule.id}-${j}.txt`, `${text}\n`));
      void i;
    });
    r.commit('fixtures');
    await withStack(bundleOf(r), {}, async (s) => {
      const job = await s.runJob();
      expect(job.result?.scan_status).toBe('ok');
      const ids = new Set((await findings(s)).findings.map((f) => f.rule_id));
      for (const rule of RULES) expect(ids.has(rule.id), rule.id).toBe(true);
    });
  });

  it('a clean repository is ok with zero findings and a complete coverage record', async () => {
    const r = new FixtureRepo(scratch.dir, 'clean');
    r.write('a.txt', 'nothing here\n').commit('1');
    r.write('b.txt', 'nor here\n').commit('2');
    await withStack(bundleOf(r), {}, async (s) => {
      const job = await s.runJob();
      expect(job.result).toMatchObject({
        scan_status: 'ok',
        finding_counts: { open: 0 },
        scan_coverage: {
          commits_scanned: 2,
          blobs_scanned: 2,
          truncated: false,
          cap_reached: false,
        },
      });
      expect(b2Reasons(job.result as NonNullable<typeof job.result>)).toEqual([]);
    });
  });
});

describe('SEC-OB-2: failure is never clean', () => {
  /** What every failure must look like to the census. */
  const notClean = (job: Awaited<ReturnType<KnowledgeStack['runJob']>>) => {
    expect(job.state).toBe('done');
    const r = job.result as NonNullable<typeof job.result>;
    expect(r.scan_status).toBe('error');
    expect(r.scan_error).not.toBeNull();
    expect(r.scan_coverage.truncated).toBe(true);
    expect(r.security_summary.history_scan.status).toBe('error');
    expect(r.security_summary.history_scan.truncated).toBe(true);
    expect(b2Reasons(r)).toContain('scan_error');
    return r;
  };

  it('git failing mid-scan (log dies after a partial answer) is scan_status error', async () => {
    const { r } = plantedHistory('fail-log');
    const gitBin = wrapper('log', `    git "$@" | head -c 200; exit 128`);
    await withStack(bundleOf(r), { gitBin }, async (s) => {
      const res = notClean(await s.runJob());
      expect(res.scan_error?.code).toMatch(/git_failed|parse_failed/);
      // And the census sees B2, not "no findings".
      const sum = (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary'))
        .json as { b2_reasons: string[] };
      expect(sum.b2_reasons).toContain('scan_error');
    });
  });

  it('git failing mid-scan (cat-file dies with requests outstanding) is scan_status error', async () => {
    const { r } = plantedHistory('fail-cat');
    // The reader answers nothing and dies, as git does on an object it cannot read.
    const gitBin = wrapper('--batch', `    read -r first; exit 3`);
    await withStack(bundleOf(r), { gitBin }, async (s) => {
      const res = notClean(await s.runJob());
      expect(res.scan_error?.code).toMatch(/unreadable_object|git_failed|parse_failed/);
    });
  });

  it('rev-list failing (the all-objects pass) is scan_status error', async () => {
    const { r } = plantedHistory('fail-revlist');
    const gitBin = wrapper('--objects', `    echo "fatal: simulated" >&2; exit 128`);
    await withStack(bundleOf(r), { gitBin }, async (s) => {
      notClean(await s.runJob());
    });
  });

  it('output git log cannot be parsed is scan_status error (parse_failed)', async () => {
    const { r } = plantedHistory('garbage-log');
    const gitBin = wrapper('log', `    printf 'this is not a log\\0'; exit 0`);
    await withStack(bundleOf(r), { gitBin }, async (s) => {
      const res = notClean(await s.runJob());
      expect(res.scan_error?.code).toBe('parse_failed');
    });
  });

  it('an unreadable object (a corrupt blob in the mirror) is scan_status error with an unreadable_object coverage item', async () => {
    const { r } = plantedHistory('corrupt-blob');
    let corrupted = '';
    await withStack(
      bundleOf(r),
      {
        afterMirror: (mirrorDir) => {
          // Overwrite bytes inside one blob of the pack: rev-list, ls-tree and log do not read blob
          // contents, so only the read of that object can notice. (fsck already passed.)
          const packs = join(mirrorDir, 'objects', 'pack');
          const idx = readdirSync(packs).find((f) => f.endsWith('.idx')) as string;
          const out = execFileSync(
            'git',
            [`--git-dir=${mirrorDir}`, 'verify-pack', '-v', join(packs, idx)],
            {
              encoding: 'utf8',
            },
          );
          // The largest blob in the pack, so that the bytes written stay inside its own data.
          const blobs = out
            .split('\n')
            .filter((l) => / blob /.test(l))
            .map((l) => l.trim().split(/\s+/))
            .sort((x, y) => Number(y[3]) - Number(x[3]));
          const [id, , , inPack, offset] = blobs[0] as string[];
          corrupted = id as string;
          const n = Math.min(8, Number(inPack) - 4);
          const pack = join(packs, idx.replace(/\.idx$/, '.pack'));
          chmodSync(pack, 0o644);
          const fd = openSync(pack, 'r+');
          writeSync(fd, noise('corrupt', n), 0, n, Number(offset) + 3);
          closeSync(fd);
        },
      },
      async (s) => {
        const res = notClean(await s.runJob());
        expect(corrupted).toMatch(/^[0-9a-f]{40}$/);
        expect(res.scan_error?.code).toBe('unreadable_object');
        expect(res.coverage_items.filter((i) => i.kind === 'unreadable_object')).toHaveLength(1);
        expect(res.coverage_counts.unreadable_object).toBe(1);
      },
    );
  });

  it('a timeout during the scan is scan_status error with a time_cap coverage item, and its processes are gone', async () => {
    const { r } = plantedHistory('slow-scan');
    const gitBin = wrapper('log', `    sleep 30`);
    await withStack(bundleOf(r), { gitBin, jobTimeoutMs: 2500 }, async (s) => {
      const t = performance.now();
      const res = notClean(await s.runJob());
      expect(performance.now() - t).toBeLessThan(20_000);
      expect(res.scan_error?.code).toBe('timeout');
      expect(res.coverage_items.map((i) => i.kind)).toContain('time_cap');
      expect(existsSync(s.workRoot) ? readdirSync(s.workRoot) : []).toEqual([]);
    });
  }, 40_000);

  it('a fingerprint that cannot be made (kms-local down) is scan_status error and stores no finding', async () => {
    const { r } = plantedHistory('kms-down');
    await withStack(bundleOf(r), {}, async (s) => {
      await s.kms.stop();
      const res = notClean(await s.runJob());
      expect(res.scan_error?.code).toBe('fingerprint_unavailable');
      const rows = await s.db.pool.query('SELECT 1 FROM security_findings.finding');
      expect(rows.rowCount).toBe(0);
    });
  });

  it('the commit cap is recorded as truncated and cap_reached, never silent; the head tree is still scanned', async () => {
    const r = new FixtureRepo(scratch.dir, 'many-commits');
    const old = makeCanary('old-and-deleted');
    r.write('old.txt', `K=${old}\n`).commit('c1 old secret');
    r.remove('old.txt').commit('c2 remove');
    for (let i = 3; i <= 12; i++) r.write(`f${i}.txt`, `${i}\n`).commit(`c${i}`);
    const atHead = makeCanary('still-at-head');
    r.write('head.txt', `H=${atHead}\n`).commit('c13 head secret');
    await withStack(bundleOf(r), { commitCap: 5 }, async (s) => {
      const job = await s.runJob();
      expect(job.state).toBe('done');
      const res = job.result as NonNullable<typeof job.result>;
      expect(res.scan_status).toBe('ok');
      expect(res.scan_coverage).toMatchObject({
        commits_scanned: 5,
        truncated: true,
        cap_reached: true,
      });
      expect(res.security_summary.history_scan).toMatchObject({
        status: 'ok',
        truncated: true,
        commits_scanned: 5,
      });
      expect(res.coverage_items.map((i) => i.kind)).toContain('commit_cap');
      expect(b2Reasons(res)).toEqual(['cap_reached', 'truncated']);
      // Beyond the cap the old secret is not seen (that is what truncated means), the head one is.
      const f = (await findings(s)).findings;
      expect(f.map((x) => x.locations[0]?.paths[0])).toEqual(['head.txt']);
      const sum = (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary'))
        .json as { b2_reasons: string[] };
      expect(sum.b2_reasons).toEqual(['cap_reached', 'truncated']);
    });
  });

  it('with the default cap (50000) a normal repository is not truncated', async () => {
    const { r } = plantedHistory('default-cap');
    await withStack(bundleOf(r), {}, async (s) => {
      const job = await s.runJob();
      expect(job.result?.scan_coverage).toMatchObject({ truncated: false, cap_reached: false });
    });
  });

  it('no job and no summary at all is B2 (no_scan), never clean', async () => {
    const { r } = plantedHistory('no-job');
    await withStack(bundleOf(r), {}, async (s) => {
      const sum = (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary'))
        .json;
      expect(sum).toMatchObject({ scanned: false, b2_reasons: ['no_scan'] });
    });
  });

  it('an intake that errors leaves the previous good scan as the latest, and the new job is an error', async () => {
    const { r } = plantedHistory('refused-after-good');
    const good = bundleOf(r);
    await withStack(good, {}, async (s) => {
      expect((await s.runJob()).state).toBe('done');
      s.source.set(good.file, { ...good.manifest, head_sha: 'f'.repeat(40) });
      const bad = await s.runJob();
      expect(bad.state).toBe('error');
      expect(bad.result).toBeNull();
    });
  });
});
