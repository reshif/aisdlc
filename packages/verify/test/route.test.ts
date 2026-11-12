import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ITEM, SYNTH_BASE_SHA } from '@aisdlc/build';
import {
  EVIDENCE_PACK_FORMAT,
  EvidencePack,
  FindingKind,
  REPAIR_CLASS_OF_FINDING,
  SIGNED_EVIDENCE_PACK_FORMAT,
  VerifyCheckResult,
  checkSignedEvidencePack,
  evidencePackId,
  repairClassOf,
  signedEvidencePackBytes,
  type S7Disposition,
  type SignedEvidencePack,
  type VerifyFinding,
  type VerifyStep,
} from '@aisdlc/contracts';
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { FakeNotary, fakeKeyCustody } from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';
import {
  decide76,
  decideStep,
  evidenceSteps,
  finding,
  outcomeOf76,
  staleLockFindings,
  treeOf,
  verifyPackMain,
  type EdgeRoom,
} from '../src/index.js';
import { HEAD_SHA, check, world } from './fixtures.js';

// M14.4: where a failed S7 check sends the item (B9 to B12, D2), the Evidence Pack's step view, the pack's offline check
// and the `aisdlc-verify-pack` CLI (in-process and as the bundle `npm run build` makes).

const STEPS: VerifyStep[] = ['7.1', '7.2', '7.3', '7.4', '7.5'];
const CHECK = {
  '7.1': 'deterministic',
  '7.2': 'test_integrity',
  '7.3': 'spec_conformance',
  '7.4': 'secrets_dependencies',
  '7.5': 'constitution',
} as const;

const res = (
  step: VerifyStep,
  o: Partial<Pick<VerifyCheckResult, 'verdict' | 'findings' | 'raised'>> = {},
): VerifyCheckResult =>
  VerifyCheckResult.parse({
    schema: 'verify-check-result/1',
    item_id: ITEM,
    unit_key: 'main',
    step,
    check: CHECK[step],
    repo: 'acme/synth',
    lane: 'L3',
    base_sha: SYNTH_BASE_SHA,
    head_sha: HEAD_SHA,
    inputs_sha256: sha256Hex(step),
    verdict: o.verdict ?? 'passed',
    findings: o.findings ?? [],
    kits: [],
    raised: o.raised ?? null,
    mutation: null,
    rules_version: null,
  });

const all = (over: Partial<Record<VerifyStep, VerifyCheckResult>> = {}) =>
  STEPS.map((s) => over[s] ?? res(s));
const room: EdgeRoom = () => true;
const noRoom: EdgeRoom = () => false;
const none = () => false;
const high = (kind: FindingKind, rule_id: string | null = null): VerifyFinding =>
  finding(kind, 'high', { message: kind, rule_id });

describe('repair classes (deterministic from the finding kind)', () => {
  it('every finding kind has a class; misbehaviour is quarantine, never a repair', () => {
    for (const k of FindingKind.options) expect(REPAIR_CLASS_OF_FINDING[k]).toBeDefined();
    expect(REPAIR_CLASS_OF_FINDING.locked_test_edit).toBe('quarantine');
    expect(REPAIR_CLASS_OF_FINDING.secret_new).toBe('hard_fail');
    expect(REPAIR_CLASS_OF_FINDING.locked_test_stale).toBe('locked_test_change');
    expect(REPAIR_CLASS_OF_FINDING.command_failed).toBe('repairable');
  });

  it("A5's rule ids narrow a review finding only at the steps they belong to", () => {
    const amb = high('conformance_review', 'spec_ambiguous');
    expect(repairClassOf(amb, '7.3')).toBe('spec_ambiguous');
    expect(repairClassOf({ ...amb, kind: 'constitution_review' }, '7.5')).toBe('repairable');
    const wrong = high('constitution_review', 'approach_wrong');
    expect(repairClassOf(wrong, '7.5')).toBe('approach_wrong');
    // a rule id on a deterministic finding changes nothing
    expect(repairClassOf(high('secret_new', 'approach_wrong'), '7.4')).toBe('hard_fail');
  });
});

describe('decideStep: 7.2 (B12) and 7.3 (B10)', () => {
  const e6 = res('7.2', {
    verdict: 'failed',
    findings: [high('locked_test_stale')],
    raised: { kind: 'gate', gate: 'E6', reason_code: 'locked_test_must_change' },
  });
  it('E6 while B12 has a round, else D2 (ET3)', () => {
    expect(decideStep(e6, room)).toMatchObject({
      kind: 'outcome',
      outcome: { outcome: 'gate_needed', gate: 'E6' },
    });
    expect(decideStep(e6, noRoom)).toEqual({
      kind: 'handoff',
      trigger: 'ET3',
      reason_code: 'b12_limit',
    });
  });
  it('B10 for a spec found ambiguous at 7.3, else D2 (ET3); any other failure completes the step', () => {
    const amb = res('7.3', {
      verdict: 'failed',
      findings: [high('conformance_review', 'spec_ambiguous')],
    });
    expect(decideStep(amb, room)).toEqual({
      kind: 'outcome',
      outcome: { outcome: 'rework', edge: 'B10', reason_code: 'spec_ambiguous' },
    });
    expect(decideStep(amb, noRoom)).toMatchObject({ kind: 'handoff', reason_code: 'b10_limit' });
    const plain = res('7.3', { verdict: 'failed', findings: [high('oracle_failing')] });
    expect(decideStep(plain, room)).toMatchObject({
      kind: 'outcome',
      outcome: { outcome: 'completed' },
    });
  });
});

describe('decide76', () => {
  const d = (
    rs: VerifyCheckResult[],
    r: EdgeRoom = room,
    approved: Parameters<typeof decide76>[1] = none,
  ) => decide76(rs, approved, r);
  const disp = (x: ReturnType<typeof decide76>): S7Disposition | null =>
    x.kind === 'decided' ? x.disposition : null;

  it('every step met is the only pass; a missing step is incomplete (nothing signed, nothing repaired)', () => {
    expect(disp(d(all()))).toEqual({ kind: 'passed' });
    expect(d(all().slice(1))).toEqual({ kind: 'incomplete', missing: ['7.1'] });
    // the latest result of a step counts
    expect(
      disp(d([...all(), res('7.1', { verdict: 'failed', findings: [high('command_failed')] })])),
    ).toMatchObject({ kind: 'rework', edge: 'B9' });
  });

  it('B9 under the limit (counted against et3_rounds), D2 (ET3) when it is spent', () => {
    const rs = all({
      '7.1': res('7.1', { verdict: 'failed', findings: [high('command_failed')] }),
    });
    expect(disp(d(rs))).toEqual({
      kind: 'rework',
      edge: 'B9',
      loop: 'et3_rounds',
      reason_code: 'repairable_7.1',
    });
    expect(disp(d(rs, noRoom))).toEqual({
      kind: 'handoff',
      trigger: 'ET3',
      step: '7.6',
      reason_code: 'b9_limit',
    });
  });

  it('B11 for an approach found wrong, before B9; D2 (ET3) when spent', () => {
    const rs = all({
      '7.1': res('7.1', { verdict: 'failed', findings: [high('command_failed')] }),
      '7.3': res('7.3', {
        verdict: 'failed',
        findings: [high('conformance_review', 'approach_wrong')],
      }),
    });
    expect(disp(d(rs))).toMatchObject({ kind: 'rework', edge: 'B11', loop: null });
    expect(disp(d(rs, (e) => e !== 'B11'))).toMatchObject({
      kind: 'handoff',
      reason_code: 'b11_limit',
    });
  });

  it('D2 at once: unknown (ET4) before a hard fail (ET5) before an unapproved gate (ET6)', () => {
    const unknown = res('7.2', { verdict: 'unknown', findings: [] });
    const secret = res('7.4', { verdict: 'failed', findings: [high('secret_new')] });
    const x2 = res('7.4', { raised: { kind: 'gate', gate: 'X2', reason_code: 'protected_path' } });
    const repairable = res('7.1', { verdict: 'failed', findings: [high('command_failed')] });
    expect(disp(d(all({ '7.1': repairable, '7.2': unknown, '7.4': secret })))).toMatchObject({
      kind: 'handoff',
      trigger: 'ET4',
      reason_code: 'unknown_7.2',
    });
    expect(disp(d(all({ '7.1': repairable, '7.4': secret })))).toMatchObject({
      trigger: 'ET5',
      reason_code: 'hard_fail_7.4',
    });
    expect(disp(d(all({ '7.4': x2 })))).toMatchObject({
      trigger: 'ET6',
      reason_code: 'unapproved_7.4',
    });
    expect(disp(d(all({ '7.4': x2 }), room, (g, s) => g === 'X2' && s === '7.4'))).toEqual({
      kind: 'passed',
    });
    // a failed result with no failing finding names nothing to repair
    expect(disp(d(all({ '7.5': res('7.5', { verdict: 'failed' }) })))).toMatchObject({
      trigger: 'ET5',
      reason_code: 'unexplained_7.5',
    });
  });

  it('the outcome a disposition asks for: a pass completes with the pack id, a handoff carries the D2 hash', () => {
    const pack = 'a'.repeat(64);
    expect(outcomeOf76({ kind: 'passed' }, pack, null)).toEqual({
      outcome: 'completed',
      output_hash: pack,
    });
    expect(
      outcomeOf76({ kind: 'rework', edge: 'B9', loop: 'et3_rounds', reason_code: 'r' }, pack, null),
    ).toEqual({ outcome: 'rework', edge: 'B9', loop: 'et3_rounds', reason_code: 'r' });
    expect(
      outcomeOf76(
        { kind: 'handoff', trigger: 'ET5', step: '7.6', reason_code: 'r' },
        pack,
        'b'.repeat(64),
      ),
    ).toEqual({
      outcome: 'trigger',
      trigger: 'ET5',
      reason_code: 'r',
      output_hash: 'b'.repeat(64),
    });
  });
});

describe('7.2: a locked test the approved spec moved away from (B12)', () => {
  it('staleLockFindings: an intact lock whose marker names a replaced spec hash; a bent lock is not stale', () => {
    const w = world();
    const head = treeOf([{ path: w.oraclePath, content: w.oracleCode }]);
    const locks = { [w.oraclePath]: sha256Hex(w.oracleCode) };
    const moved = [{ oracle_id: 'O1', requirement_id: 'REQ-1', spec_sha256: 'c'.repeat(64) }];
    expect(staleLockFindings(head, locks, moved, false).map((f) => f.kind)).toEqual([
      'locked_test_stale',
    ]);
    expect(staleLockFindings(head, locks, moved, true)).toEqual([]);
    expect(staleLockFindings(head, { [w.oraclePath]: 'd'.repeat(64) }, moved, false)).toEqual([]);
  });

  it('the check raises E6 and runs no kit', async () => {
    const w = world();
    const r = await check(w, '7.2', {
      oracles: [{ oracle_id: 'O1', requirement_id: 'REQ-1', spec_sha256: 'c'.repeat(64) }],
    });
    expect(r.verdict).toBe('failed');
    expect(r.raised).toEqual({ kind: 'gate', gate: 'E6', reason_code: 'locked_test_must_change' });
    expect(r.kits).toEqual([]);
  });
});

// ---------------------------------------------------------------- the pack and its offline check

const custody = fakeKeyCustody();
const notary = new FakeNotary(custody);

async function signedPack(
  rs: VerifyCheckResult[],
  disposition: S7Disposition = { kind: 'passed' },
): Promise<{ signed: SignedEvidencePack; bytes: Uint8Array }> {
  const pack = EvidencePack.parse({
    format: EVIDENCE_PACK_FORMAT,
    item_id: ITEM,
    project_id: 'acme',
    repo: 'acme/synth',
    lane: 'L3',
    tier: 'T1',
    profile_sha256: sha256Hex('profile'),
    catalogue_ref: { version: '1.0.0', hash: 'e'.repeat(64) },
    units: [{ unit_key: 'main' }],
    base_sha: SYNTH_BASE_SHA,
    head_sha: HEAD_SHA,
    disposition,
    passing: disposition.kind === 'passed',
    steps: evidenceSteps(rs, none),
    gates: [],
    push_receipt: null,
    oracle_locks: { 'test/oracle-add.test.js': 'f'.repeat(64) },
    produced_at: '2026-11-12T00:00:00.000Z',
  });
  const pack_sha256 = evidencePackId(pack);
  const sig = await notary.signEvidencePack({ pack_sha256, item_id: ITEM, head_sha: HEAD_SHA });
  if (!sig.ok) throw new Error(sig.error.message);
  const signed: SignedEvidencePack = {
    format: SIGNED_EVIDENCE_PACK_FORMAT,
    pack_sha256,
    pack,
    signature: sig.value,
  };
  return { signed, bytes: signedEvidencePackBytes(signed) };
}

const notaryKey = async () => {
  const k = await custody.publicKey('dev:notary');
  if (!k.ok) throw new Error('no key');
  return k.value;
};

describe('the Evidence Pack', () => {
  it('a passing pack cannot be built over an unmet step (the contract refuses it)', () => {
    const steps = evidenceSteps(all({ '7.2': res('7.2', { verdict: 'unknown' }) }), none);
    expect(steps[1]?.met).toBe(false);
    expect(() =>
      EvidencePack.parse({
        format: EVIDENCE_PACK_FORMAT,
        item_id: ITEM,
        project_id: 'acme',
        repo: 'acme/synth',
        lane: 'L3',
        tier: 'T1',
        profile_sha256: sha256Hex('p'),
        catalogue_ref: { version: '1.0.0', hash: 'e'.repeat(64) },
        units: [{ unit_key: 'main' }],
        base_sha: SYNTH_BASE_SHA,
        head_sha: HEAD_SHA,
        disposition: { kind: 'passed' },
        passing: true,
        steps,
        gates: [],
        push_receipt: null,
        oracle_locks: {},
        produced_at: '2026-11-12T00:00:00.000Z',
      }),
    ).toThrow(/every step met/);
  });

  it('steps carry the result hash, the verdict and the failing findings classed (no message)', () => {
    const steps = evidenceSteps(
      all({ '7.4': res('7.4', { verdict: 'failed', findings: [high('secret_new')] }) }),
      none,
    );
    expect(steps[3]).toMatchObject({ verdict: 'failed', met: false, findings: { failing: 1 } });
    expect(steps[3]?.findings.items[0]).toMatchObject({
      kind: 'secret_new',
      repair_class: 'hard_fail',
    });
    expect(Object.keys(steps[3]?.findings.items[0] ?? {})).not.toContain('message');
  });

  it('verifies offline with the public key alone; tampering, another head, another key, another item all fail', async () => {
    const key = await notaryKey();
    const { bytes, signed } = await signedPack(all());
    const ok = await checkSignedEvidencePack(bytes, key, {
      head_sha: HEAD_SHA,
      item_id: ITEM,
      object_key: sha256Hex(bytes),
    });
    expect(ok.ok).toBe(true);
    const code = async (
      b: Uint8Array,
      o: Partial<Parameters<typeof checkSignedEvidencePack>[2]> = {},
      k = key,
    ) => {
      const r = await checkSignedEvidencePack(b, k, { head_sha: HEAD_SHA, ...o });
      return r.ok ? 'ok' : r.code;
    };
    expect(await code(bytes, { head_sha: 'c'.repeat(40) })).toBe('head_mismatch');
    expect(await code(bytes, { item_id: '01890000-0000-7000-8000-00000000ffff' })).toBe(
      'item_mismatch',
    );
    expect(await code(bytes, { object_key: 'c'.repeat(64) })).toBe('object_key_mismatch');
    const other = await fakeKeyCustody({ seed: 'other' }).publicKey('dev:notary');
    expect(await code(bytes, {}, other.ok ? other.value : {})).toBe('bad_signature');
    expect(await code(bytes, {}, { ...key, kid: 'dev:someone' })).toBe('wrong_key_id');
    const enc = (o: unknown) => new TextEncoder().encode(canonicalJson(o as never));
    const flipped = structuredClone(signed);
    (flipped.pack.steps[0] as { verdict: string }).verdict = 'failed';
    expect(await code(enc(flipped))).toBe('pack_hash_mismatch');
    flipped.pack_sha256 = evidencePackId(flipped.pack);
    expect(await code(enc(flipped))).toBe('bad_signature');
    expect(await code(new TextEncoder().encode(JSON.stringify(signed, null, 2)))).toBe(
      'not_canonical',
    );
    expect(await code(new TextEncoder().encode('{nope'))).toBe('not_json');
    expect(await code(enc({ ...signed, format: 'other' }))).toBe('bad_format');
  });

  it('a not-passing pack verifies only when the caller allows it', async () => {
    const key = await notaryKey();
    const { bytes } = await signedPack(
      all({ '7.1': res('7.1', { verdict: 'failed', findings: [high('command_failed')] }) }),
      {
        kind: 'handoff',
        trigger: 'ET3',
        step: '7.6',
        reason_code: 'b9_limit',
      },
    );
    expect((await checkSignedEvidencePack(bytes, key, { head_sha: HEAD_SHA })).ok).toBe(false);
    expect(
      (await checkSignedEvidencePack(bytes, key, { head_sha: HEAD_SHA, require_passing: false }))
        .ok,
    ).toBe(true);
  });

  it('the Notary fake signs a pack once and refuses its id for another head', async () => {
    const n = new FakeNotary(custody);
    const req = { pack_sha256: 'a'.repeat(64), item_id: ITEM, head_sha: HEAD_SHA };
    const a = await n.signEvidencePack(req);
    expect(await n.signEvidencePack(req)).toEqual(a);
    const b = await n.signEvidencePack({ ...req, head_sha: 'c'.repeat(40) });
    expect(!b.ok && b.error.code).toBe('invalid_request');
    expect(n.signedPacks).toBe(1);
  });
});

describe('aisdlc-verify-pack', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const files = async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-verify-pack-'));
    const { bytes } = await signedPack(all());
    writeFileSync(join(dir, 'pack.json'), bytes);
    writeFileSync(join(dir, 'notary.jwk'), JSON.stringify(await notaryKey()));
    return {
      dir,
      pack: join(dir, 'pack.json'),
      key: join(dir, 'notary.jwk'),
      sha: sha256Hex(bytes),
    };
  };

  it('in process: 0 verified, 1 failed, 2 bad usage', async () => {
    const f = await files();
    try {
      const out: string[] = [];
      const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
      expect(
        await verifyPackMain(
          ['--pack', f.pack, '--notary-key', f.key, '--head', HEAD_SHA, '--object-key', f.sha],
          io,
        ),
      ).toBe(0);
      expect(out.join('\n')).toMatch(/evidence pack OK/);
      expect(
        await verifyPackMain(
          ['--pack', f.pack, '--notary-key', f.key, '--head', 'c'.repeat(40)],
          io,
        ),
      ).toBe(1);
      expect(await verifyPackMain(['--pack', f.pack, '--head', HEAD_SHA], io)).toBe(2);
      writeFileSync(
        f.key,
        JSON.stringify({ kty: 'EC', crv: 'P-256', x: 'a', y: 'b', d: 'secret' }),
      );
      expect(
        await verifyPackMain(['--pack', f.pack, '--notary-key', f.key, '--head', HEAD_SHA], io),
      ).toBe(2);
      expect(out.at(-1)).toMatch(/private key/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });

  it('the bundle runs with plain node and no network', async () => {
    const f = await files();
    const out = join(f.dir, 'dist');
    try {
      execFileSync(
        process.execPath,
        [join(root, 'scripts', 'bundle.mjs'), `--outdir=${out}`, 'verify-pack'],
        {
          cwd: join(root, 'packages', 'verify'),
          stdio: 'pipe',
        },
      );
      const run = (head: string) =>
        spawnSync(
          process.execPath,
          [join(out, 'verify-pack.js'), '--pack', f.pack, '--notary-key', f.key, '--head', head],
          { env: { PATH: process.env['PATH'] ?? '' }, encoding: 'utf8', timeout: 20_000 },
        );
      const good = run(HEAD_SHA);
      expect(good.status, good.stderr).toBe(0);
      expect(good.stdout).toMatch(/evidence pack OK/);
      const bad = run('c'.repeat(40));
      expect(bad.status).toBe(1);
      expect(bad.stderr).toMatch(/head_mismatch/);
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  }, 60_000);
});
