import {
  DRIFT_EVENT,
  PRR_EVENT,
  PrrActivatedPayload,
  PrrProposedPayload,
  bypassListHash,
  driftStream,
  inboundFactStream,
  prrRecordHash,
  prrStream,
  repoIdOf,
  type MergeBypassConfig,
} from '@aisdlc/contracts';
import type { FakeStepUp } from '@aisdlc/decisions';
import { sha256Hex } from '@aisdlc/kernel';
import { FakeGitHub, emptySeed, gitBlobSha, type CodeHostSeed } from '@aisdlc/ports';
import { rawRules } from '@aisdlc/ports/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkDrift,
  coreInbox,
  expireRecord,
  inCoreTx,
  laneEligibility,
  loadDrift,
  lockKeys,
  projectDriftView,
  reaffirmInstruction,
  reaffirmView,
  recheckRepo,
  requestOnboarding,
  requestVersion,
  restoreRecord,
  type DriftActionDeps,
} from '../src/index.js';
import { pid, pr, request, setSlots, startCoreStack, type CoreStack } from '../src/testing.js';
import { built, inputs, loadReports } from './prr-fixtures.js';

// After onboarding on the real record, ledger and Notary (PLAN M16; OB §4.2, §8; DEC-21(b)): the files poll at the
// recorded head (record-first), the drift fold, a re-affirmation with step-up, a loosened protect-main that suspends
// the record (recorded and ledgered) and closes the agent lanes, the one-click restore with the bypass re-attestation,
// a CODEOWNERS change, expiry with the re-sign, and the level-up request. The code host is the in-memory FakeGitHub.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const okv = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const H4 = '4'.repeat(40);
const ORIGINAL = '# agents\n';
const AFFIRMED = '# Agents\n\n## Commands\n\n- test: `npm test`\n';
const CODEOWNERS = '* @alice-gh\n';

const goodRules = () => [
  rawRules.pr({}),
  rawRules.checks([{ context: 'gate-check', integration_id: 99 }], false),
  rawRules.simple('non_fast_forward'),
  rawRules.simple('deletion'),
];

interface Head {
  sha: string;
  files: Record<string, string>;
  rules?: ReturnType<typeof goodRules>;
}

function seedOf(repo: string, heads: readonly Head[]): CodeHostSeed {
  const last = heads.at(-1) as Head;
  return emptySeed({
    installation: {
      installation_id: 4242,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'read', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: repo, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo, branch: 'main', sha: last.sha }],
    files: heads.flatMap((h) =>
      Object.entries(h.files).map(([path, content]) => ({ repo, sha: h.sha, path, content })),
    ),
    rules: [{ repo, branch: 'main', rules: last.rules ?? goodRules() }],
  });
}

let n = 0;
interface World {
  project: string;
  repo: string;
  host: FakeGitHub;
  heads: Head[];
  d: DriftActionDeps;
  bypass: { cfg: MergeBypassConfig | null };
  /** Moves the default branch to a new head (and the rules with it). */
  push(h: Head): void;
}

/** A Light repo with an ACTIVE readiness record whose AGENTS.md section was affirmed (drafted from `ORIGINAL`). */
async function world(): Promise<World> {
  n += 1;
  const project = `dr-${n}`;
  const repo = `acme/dr-${n}`;
  const deps = { pool: s.record.pool, clock: s.clock };
  const r = okv(
    await requestOnboarding(
      deps,
      request({ project_id: pid(project), repo, level: 'light', on_behalf_of: pr('alice') }),
    ),
  );
  const made = built(inputs({ tier: 'T1', level: 'light', over: { project_id: project } }));
  const withText = {
    ...made,
    affirmed: {
      ...made.affirmed,
      instructions: [
        {
          area: '*',
          path: 'AGENTS.md',
          text_sha256: sha256Hex(AFFIRMED),
          source_blob_sha: gitBlobSha(ORIGINAL),
          lint_report_hash: sha256Hex('lint'),
          step_up_ref: null,
          sod_waiver: true,
        },
      ],
    },
  } as typeof made;
  const prr = { ...withText, record_hash: prrRecordHash(withText) };
  const w = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`project:${project}`, `repo:${repo}`]);
    const stream = prrStream(project, repoIdOf(repo));
    const p = await j.emit(
      stream,
      PRR_EVENT.proposed,
      PrrProposedPayload.parse({ s0_id: r.s0_id, prr }),
      'test',
    );
    if (!p.ok) return p;
    return j.emit(
      stream,
      PRR_EVENT.activated,
      PrrActivatedPayload.parse({
        s0_id: r.s0_id,
        version: 1,
        record_hash: prr.record_hash,
        m4: {
          ledger_entry_id: '00000000-0000-4000-8000-000000000001',
          decision_hash: sha256Hex('m4'),
        },
      }),
      'test',
    );
  });
  if (!w.ok) throw new Error(w.error.message);
  setSlots(s, project, { admin: ['alice'], m4: ['alice'] });
  const heads: Head[] = [
    { sha: H1, files: { 'AGENTS.md': ORIGINAL, '.github/CODEOWNERS': CODEOWNERS } },
  ];
  const host = new FakeGitHub(seedOf(repo, heads));
  const bypass = {
    cfg: { [repo]: [{ login: 'carol', principal_id: 'carol' }] } as MergeBypassConfig | null,
  };
  const d: DriftActionDeps = {
    ...s.deps,
    ledger: s.config.ledger,
    source: host,
    eligibility: s.config.eligibility,
    stepUp: s.config.stepUp,
    bypass: () => bypass.cfg,
  };
  return {
    project,
    repo,
    host,
    heads,
    d,
    bypass,
    push(h: Head) {
      heads.push(h);
      host.load(seedOf(repo, heads));
    },
  };
}

const q = <T extends object>(sql: string, args: unknown[] = []) =>
  s.record.pool.query<T>(sql, args).then((x) => x.rows);
const statusOf = async (w: World) => (await loadDrift(s.record.pool, w.repo))?.governing?.status;
const poll = async (w: World) => {
  okv(await recheckRepo(w.d, w.repo));
  return okv(await checkDrift(w.d, w.repo));
};
const bypassShown = (logins: string[]) => ({ logins, list_hash: bypassListHash(logins) });
const ATTEST = { bypass_matches_list: true, bypass_has_no_app: true } as const;

describe('the files poll and the fold: record-first, deterministic', () => {
  it('an affirmed file still at the text it was drafted from is a pending projection, not drift; a second poll writes nothing', async () => {
    const w = await world();
    const c = await poll(w);
    expect(c?.findings).toEqual([]);
    const facts = await q<{ body: { value: { sha: string; files: unknown[] } } }>(
      'SELECT body FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [inboundFactStream('affirmed_files', w.repo)],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]?.body.value.sha).toBe(H1);
    const again = await poll(w);
    expect(again?.recorded).toBe(false);
    expect(
      await q('SELECT 1 FROM record.record_event WHERE stream = $1', [
        inboundFactStream('affirmed_files', w.repo),
      ]),
    ).toHaveLength(1);
    const v = await projectDriftView(s.record.pool, pid(w.project), {
      clock: s.clock,
      bypass: w.d.bypass,
    });
    expect(v.repos[0]?.files).toEqual([
      expect.objectContaining({ path: 'AGENTS.md', state: 'pending_projection' }),
    ]);
    expect(v.repos[0]?.prr?.status).toBe('active');
    expect(v.repos[0]?.level_up).toEqual(['full']);
  });

  it('once the pack is merged the file is affirmed; a later edit is drift: re-affirm, never a suspension', async () => {
    const w = await world();
    w.push({ sha: H2, files: { 'AGENTS.md': AFFIRMED, '.github/CODEOWNERS': CODEOWNERS } });
    expect((await poll(w))?.findings).toEqual([]);
    const v1 = await projectDriftView(s.record.pool, pid(w.project), {
      clock: s.clock,
      bypass: w.d.bypass,
    });
    expect(v1.repos[0]?.files[0]?.state).toBe('affirmed');
    const EDITED = `${AFFIRMED}\n## Notes\n\nUse pnpm.\n`;
    w.push({ sha: H3, files: { 'AGENTS.md': EDITED, '.github/CODEOWNERS': CODEOWNERS } });
    const c = await poll(w);
    expect(c?.findings).toEqual([
      {
        kind: 'instruction_text',
        effect: 'reaffirm',
        subject: 'AGENTS.md',
        reasons: ['file_changed'],
        expected: sha256Hex(AFFIRMED),
        observed: sha256Hex(EDITED),
      },
    ]);
    expect(c?.suspended).toBe(false);
    expect(await statusOf(w)).toBe('active');
    // the inbox has a re-affirm item for the admin slot
    const inbox = await coreInbox({
      cards: { pool: s.record.pool, decisions: s.config } as never,
      clock: s.clock,
    });
    expect(inbox.filter((i) => i.id === w.repo).map((i) => i.kind)).toEqual(['drift_reaffirm']);
    // the view serves the affirmed text and shows the drift
    const v = await projectDriftView(s.record.pool, pid(w.project), {
      clock: s.clock,
      bypass: w.d.bypass,
    });
    expect(v.repos[0]?.files[0]).toMatchObject({
      state: 'drift',
      served_sha256: sha256Hex(AFFIRMED),
      observed_sha256: sha256Hex(EDITED),
    });
    // a deletion after the file was in sync is drift too
    w.push({ sha: H4, files: { '.github/CODEOWNERS': CODEOWNERS } });
    expect((await poll(w))?.findings[0]).toMatchObject({
      reasons: ['file_deleted'],
      observed: null,
    });
  });
});

describe('re-affirmation (OB §4.2): the repo text into the record, step-up bound to its hash, ledgered', () => {
  it('the card shows both texts; a person with the slot re-affirms; the finding clears; the wrong proof and a stranger are refused', async () => {
    const w = await world();
    w.push({ sha: H2, files: { 'AGENTS.md': AFFIRMED, '.github/CODEOWNERS': CODEOWNERS } });
    await poll(w);
    const NEW = `${AFFIRMED}\n## Style\n\nTwo spaces.\n`;
    w.push({ sha: H3, files: { 'AGENTS.md': NEW, '.github/CODEOWNERS': CODEOWNERS } });
    await poll(w);
    const view = okv(await reaffirmView(w.d, pid(w.project), w.repo, 'AGENTS.md'));
    expect(view).toMatchObject({
      head_sha: H3,
      affirmed_sha256: sha256Hex(AFFIRMED),
      repo_text: NEW,
      repo_sha256: sha256Hex(NEW),
      secret_hit: false,
      bound_hash: sha256Hex(NEW),
      why_not: null,
    });
    const stepUp = s.config.stepUp as FakeStepUp;
    const req = (who: string, proof: string) => ({
      repo: w.repo as never,
      path: 'AGENTS.md',
      text_sha256: sha256Hex(NEW) as never,
      step_up: { proof },
      on_behalf_of: pr(who),
    });
    expect(
      await reaffirmInstruction(
        w.d,
        pid(w.project),
        req('mallory', stepUp.issue(sha256Hex(NEW), 'mallory')),
      ),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(
      await reaffirmInstruction(
        w.d,
        pid(w.project),
        req('alice', stepUp.issue(sha256Hex('other'), 'alice')),
      ),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    const r = okv(
      await reaffirmInstruction(
        w.d,
        pid(w.project),
        req('alice', stepUp.issue(sha256Hex(NEW), 'alice')),
      ),
    );
    expect(r.text_sha256).toBe(sha256Hex(NEW));
    // the record holds the text (the copy agents receive); the ledger holds the hash, never the text
    const ev = await q<{ body: { text: string; text_sha256: string; by: string } }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [driftStream(w.repo), DRIFT_EVENT.reaffirmed],
    );
    expect(ev[0]?.body).toMatchObject({ text: NEW, text_sha256: sha256Hex(NEW), by: 'alice' });
    const led = await q<{ subject_hash: string; actor: string; body: Record<string, unknown> }>(
      `SELECT subject_hash, actor, body FROM ledger.ledger_entry WHERE entry_id = $1`,
      [r.ledger_entry_id],
    );
    expect(led[0]).toMatchObject({ subject_hash: sha256Hex(NEW), actor: 'alice' });
    expect(JSON.stringify(led[0]?.body)).not.toContain('Two spaces');
    const after = okv(await checkDrift(w.d, w.repo));
    expect(after?.findings).toEqual([]);
    const v = await projectDriftView(s.record.pool, pid(w.project), {
      clock: s.clock,
      bypass: w.d.bypass,
    });
    expect(v.repos[0]?.files[0]).toMatchObject({
      state: 'affirmed',
      served_sha256: sha256Hex(NEW),
    });
    expect(v.repos[0]?.history.map((h) => h.type)).toContain('reaffirmed');
  });

  it('a text with a secret in it is never shown and never affirmed', async () => {
    const w = await world();
    w.push({ sha: H2, files: { 'AGENTS.md': AFFIRMED, '.github/CODEOWNERS': CODEOWNERS } });
    await poll(w);
    const LEAK = `${AFFIRMED}\naws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"\n`;
    w.push({ sha: H3, files: { 'AGENTS.md': LEAK, '.github/CODEOWNERS': CODEOWNERS } });
    await poll(w);
    const view = okv(await reaffirmView(w.d, pid(w.project), w.repo, 'AGENTS.md'));
    expect(view).toMatchObject({ secret_hit: true, repo_text: null, bound_hash: null });
    const stepUp = s.config.stepUp as FakeStepUp;
    expect(
      await reaffirmInstruction(w.d, pid(w.project), {
        repo: w.repo as never,
        path: 'AGENTS.md',
        text_sha256: sha256Hex(LEAK) as never,
        step_up: { proof: stepUp.issue(sha256Hex(LEAK), 'alice') },
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
  });
});

describe('a loosened control suspends (DEC-21): recorded, ledgered, lanes closed, pushes refused; restore is a person’s', () => {
  it('protect-main loosened -> suspended -> L8 and no agent push; the restore needs the re-check, the slot and the exact bypass list', async () => {
    const w = await world();
    await poll(w);
    // gate-check unpinned from its App and the PR rule dropped
    w.push({
      sha: H2,
      files: { 'AGENTS.md': ORIGINAL, '.github/CODEOWNERS': CODEOWNERS },
      rules: [rawRules.checks([{ context: 'gate-check' }], false), rawRules.simple('deletion')],
    });
    const c = await poll(w);
    expect(c?.suspended).toBe(true);
    expect(c?.findings.map((f) => `${f.kind}:${f.reasons.join(',')}`)).toEqual([
      'protect_main:no_pull_request_rule,gate_check_not_pinned,force_push_allowed',
      'required_check:check_unpinned',
    ]);
    expect(await statusOf(w)).toBe('suspended');
    // recorded (the PRR event and drift.suspended) and ledgered (prr.suspended, subject the S0 record)
    const prrEv = await q<{ body: { to: string; actor: string; cause: string } }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [prrStream(w.project, repoIdOf(w.repo)), PRR_EVENT.status_changed],
    );
    expect(prrEv.map((e) => e.body)).toEqual([
      expect.objectContaining({ to: 'suspended', actor: 'mechanical', cause: 'drift.controls' }),
    ]);
    const led = await q<{ subject_kind: string; entry_type: string }>(
      `SELECT subject_kind, entry_type FROM ledger.ledger_entry WHERE entry_type = 'prr.suspended'
          AND body ->> 'repo' = $1`,
      [w.repo],
    );
    expect(led).toEqual([{ subject_kind: 's0_record', entry_type: 'prr.suspended' }]);
    // a second check suspends nothing more
    expect((await checkDrift(w.d, w.repo)).ok).toBe(true);
    expect(
      await q(
        "SELECT 1 FROM ledger.ledger_entry WHERE entry_type = 'prr.suspended' AND body ->> 'repo' = $1",
        [w.repo],
      ),
    ).toHaveLength(1);
    // new work: L8 through the 1.4 rule
    expect(await laneEligibility(s.record.pool, w.repo, 'L2', s.clock)).toMatchObject({
      eligible: false,
      route: 'l8',
      reason: 'prr_suspended',
    });
    // the inbox offers the restore
    const inbox = await coreInbox({
      cards: { pool: s.record.pool, decisions: s.config } as never,
      clock: s.clock,
    });
    expect(inbox.filter((i) => i.id === w.repo).map((i) => i.kind)).toEqual(['prr_restore']);

    // a restore while it is still loosened is refused, and so is one by a stranger or with a stale list
    expect(
      await restoreRecord(w.d, pid(w.project), {
        repo: w.repo as never,
        bypass: bypassShown(['carol']),
        attestation: ATTEST,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    w.push({
      sha: H3,
      files: { 'AGENTS.md': ORIGINAL, '.github/CODEOWNERS': CODEOWNERS },
    });
    expect(
      await restoreRecord(w.d, pid(w.project), {
        repo: w.repo as never,
        bypass: bypassShown(['carol']),
        attestation: ATTEST,
        on_behalf_of: pr('mallory'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(
      await restoreRecord(w.d, pid(w.project), {
        repo: w.repo as never,
        bypass: bypassShown([]),
        attestation: ATTEST,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    w.bypass.cfg = null;
    expect(
      await restoreRecord(w.d, pid(w.project), {
        repo: w.repo as never,
        bypass: bypassShown(['carol']),
        attestation: ATTEST,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    w.bypass.cfg = { [w.repo]: [{ login: 'carol', principal_id: 'carol' }] } as MergeBypassConfig;
    expect(await statusOf(w)).toBe('suspended');
    // nothing automatic: the fixed rules alone do not lift it
    await poll(w);
    expect(await statusOf(w)).toBe('suspended');

    const done = okv(
      await restoreRecord(w.d, pid(w.project), {
        repo: w.repo as never,
        bypass: bypassShown(['carol']),
        attestation: ATTEST,
        on_behalf_of: pr('alice'),
      }),
    );
    expect(done).toMatchObject({ status: 'active', prr_version: 1 });
    expect(await statusOf(w)).toBe('active');
    const restored = await q<{
      body: { by: string; bypass: { logins: string[] }; recheck: { head_sha: string } };
    }>('SELECT body FROM record.record_event WHERE stream = $1 AND type = $2', [
      driftStream(w.repo),
      DRIFT_EVENT.restored,
    ]);
    expect(restored[0]?.body).toMatchObject({
      by: 'alice',
      bypass: { logins: ['carol'] },
      recheck: { head_sha: H3 },
    });
    const rled = await q<{ actor: string; body: { attestation: unknown } }>(
      'SELECT actor, body FROM ledger.ledger_entry WHERE entry_id = $1',
      [done.ledger_entry_id],
    );
    expect(rled[0]).toMatchObject({ actor: 'alice', body: { attestation: ATTEST } });
    expect(await laneEligibility(s.record.pool, w.repo, 'L2', s.clock)).toMatchObject({
      route: 'normal',
    });
    const v = await projectDriftView(s.record.pool, pid(w.project), {
      clock: s.clock,
      bypass: w.d.bypass,
    });
    expect(v.repos[0]?.suspension).toBeNull();
    expect(v.repos[0]?.history.map((h) => h.type)).toEqual(
      expect.arrayContaining(['suspended', 'restored', 'activated']),
    );
  });

  it('a CODEOWNERS change suspends; the restore accepts the new file as the baseline once it reads clean', async () => {
    const w = await world();
    await poll(w);
    w.push({ sha: H2, files: { 'AGENTS.md': ORIGINAL, '.github/CODEOWNERS': '* @bob-gh\n' } });
    const c = await poll(w);
    expect(c?.findings).toEqual([
      expect.objectContaining({
        kind: 'codeowners',
        effect: 'suspend',
        reasons: ['codeowners_changed'],
      }),
    ]);
    expect(await statusOf(w)).toBe('suspended');
    okv(
      await restoreRecord(w.d, pid(w.project), {
        repo: w.repo as never,
        bypass: bypassShown(['carol']),
        attestation: ATTEST,
        on_behalf_of: pr('alice'),
      }),
    );
    expect((await checkDrift(w.d, w.repo).then(okv))?.findings).toEqual([]);
    // deleting it later suspends again: the baseline is the file the restore accepted
    w.push({ sha: H3, files: { 'AGENTS.md': ORIGINAL } });
    expect((await poll(w))?.findings[0]).toMatchObject({ reasons: ['codeowners_deleted'] });
    expect(await statusOf(w)).toBe('suspended');
  });
});

describe('expiry, re-sign and level-up (OB §8)', () => {
  it('a level-up asks for a new S0 record at the higher level; the governing version stays in force', async () => {
    const w = await world();
    const r = okv(
      await requestVersion(s.deps, pid(w.project), {
        repo: w.repo as never,
        reason: 'level_up',
        level: 'full',
        on_behalf_of: pr('alice'),
      }),
    );
    expect(r).toMatchObject({ level: 'full', reason: 'level_up', duplicate: false });
    const again = okv(
      await requestVersion(s.deps, pid(w.project), {
        repo: w.repo as never,
        reason: 'level_up',
        level: 'full',
        on_behalf_of: pr('alice'),
      }),
    );
    expect(again).toMatchObject({ s0_id: r.s0_id, duplicate: true });
    const s0 = await q<{ body: { requested_level: string } }>(
      "SELECT body FROM record.record_event WHERE stream = $1 AND type = 's0.requested'",
      [`s0:${r.s0_id}`],
    );
    expect(JSON.stringify(s0[0]?.body)).toContain('full');
    // the ONE path to Full (user decision 2026-11-12): the new record opens the Full baseline and card 3
    const asked = await q<{ body: { opens: string[]; from_level: string; level: string } }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [driftStream(w.repo), DRIFT_EVENT.version_requested],
    );
    expect(asked.map((e) => e.body)).toEqual([
      expect.objectContaining({ from_level: 'light', level: 'full', opens: ['0.3', 'C3'] }),
    ]);
    const steps = await q<{ body: { step: string; state: string } }>(
      "SELECT body FROM record.record_event WHERE stream = $1 AND type = 's0.requested'",
      [`s0:${r.s0_id}`],
    );
    expect(JSON.stringify(steps[0]?.body)).not.toContain('"0.3":"skip"');
    expect(await statusOf(w)).toBe('active');
    // not a level-up: the same level, or a re-sign of a record that has not expired
    expect(
      await requestVersion(s.deps, pid(w.project), {
        repo: w.repo as never,
        reason: 'level_up',
        level: 'light',
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    expect(
      await requestVersion(s.deps, pid(w.project), {
        repo: w.repo as never,
        reason: 're_sign',
        level: 'light',
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
  });

  // last: it moves the stack's clock past every record's `fresh_until`
  it('past fresh_until the sweep expires the record (Census-only behaviour), the inbox offers the re-sign, and no restore can lift it', async () => {
    const w = await world();
    const g = (await loadDrift(s.record.pool, w.repo))?.governing;
    s.clock.set(new Date(Date.parse(g?.prr.fresh_until ?? '') + 1000));
    expect(okv(await expireRecord(s.deps, w.repo))).toBe(true);
    expect(okv(await expireRecord(s.deps, w.repo))).toBe(false);
    expect(await statusOf(w)).toBe('expired');
    expect(await laneEligibility(s.record.pool, w.repo, 'L2', s.clock)).toMatchObject({
      reason: 'prr_expired',
    });
    const inbox = await coreInbox({
      cards: { pool: s.record.pool, decisions: s.config } as never,
      clock: s.clock,
    });
    expect(inbox.filter((i) => i.id === w.repo).map((i) => i.kind)).toEqual(['prr_resign']);
    expect(
      await requestVersion(s.deps, pid(w.project), {
        repo: w.repo as never,
        reason: 'level_up',
        level: 'full',
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
    const r = okv(
      await requestVersion(s.deps, pid(w.project), {
        repo: w.repo as never,
        reason: 're_sign',
        level: 'light',
        on_behalf_of: pr('alice'),
      }),
    );
    expect(r.reason).toBe('re_sign');
    expect(
      await restoreRecord(w.d, pid(w.project), {
        repo: w.repo as never,
        bypass: bypassShown(['carol']),
        attestation: ATTEST,
        on_behalf_of: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const v = await projectDriftView(s.record.pool, pid(w.project), {
      clock: s.clock,
      bypass: w.d.bypass,
    });
    expect(v.repos[0]?.prr).toMatchObject({ status: 'expired', expired: true });
    expect(v.repos[0]?.level_up).toEqual([]);
    expect(v.repos[0]?.history.map((h) => h.type)).toEqual(
      expect.arrayContaining(['expired', 'version_requested']),
    );
  });
});
