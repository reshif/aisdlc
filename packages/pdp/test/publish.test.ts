import {
  PDP_CONFIG_KEY,
  PdpDecisionRecord,
  pdpResource,
  policyBundleHash,
} from '@aisdlc/contracts';
import { ConfigReader, ConfigRegistry, configPublish, proposeRevision } from '@aisdlc/config';
import { FakePdpEntities } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigBundleSource,
  Pdp,
  RecordDecisionLog,
  buildBundle,
  proposeBundle,
  registerPdpConfig,
} from '../src/index.js';
import { decideGate, factoryAdmins, newRegistry, pr, startStack, type Stack } from './stack.js';
import { FLEET, proj } from './helpers.js';

let s: Stack;
let reader: ConfigReader;
let pdp: Pdp;
const entities = new FakePdpEntities();

beforeAll(async () => {
  s = await startStack(newRegistry());
  factoryAdmins(s, ['root']);
  reader = await ConfigReader.create({
    pool: s.record.pool,
    registry: s.deps.registry,
    listen: false,
    pollIntervalMs: 0,
  });
  pdp = new Pdp({
    source: new ConfigBundleSource(reader),
    entities,
    log: new RecordDecisionLog({ pool: s.record.pool, clock: s.clock }),
  });
  entities.addPrincipal('alice').bind('alice', 'project.admin', proj('p1'));
  entities.addPrincipal('root').bind('root', 'factory.admin', FLEET);
});
afterAll(async () => {
  await reader.stop();
  await s.stop();
});

const P1 = pdpResource.project('p1');
const ask = (action = 'project.settings.edit', resource = P1, who = 'alice') =>
  pdp.decide({ principal: who, action, resource });

/** Proposes through the helper, approves the M1 gate as root, publishes, and refreshes the reader. */
async function publish(bundle: ReturnType<typeof buildBundle>) {
  const p = await proposeBundle(s.deps, bundle, pr('root'));
  if (!p.ok) throw new Error(`propose: ${JSON.stringify(p.error)}`);
  const d = await decideGate(s, p.value.gate_instance_id, 'root', 'approve');
  if (!d.ok) throw new Error(`decide: ${JSON.stringify(d.error)}`);
  const r = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
  if (!r.ok) throw new Error(`publish: ${JSON.stringify(r.error)}`);
  await reader.refresh();
  return p.value;
}

describe('a bundle published through config_publish', () => {
  it('no bundle published: everything is denied', async () => {
    const d = await ask();
    expect(d).toMatchObject({ decision: 'deny', reasons: ['no_bundle'], bundle_version: null });
  });

  it('a proposed bundle is not effective until its M1 gate is decided and it is published', async () => {
    const b = buildBundle();
    const p = await proposeBundle(s.deps, b, pr('root'));
    expect(p.ok).toBe(true);
    await reader.refresh();
    expect((await ask()).reasons).toEqual(['no_bundle']);
    if (!p.ok) return;
    // Decided but not published: still not effective.
    const d = await decideGate(s, p.value.gate_instance_id, 'root', 'approve');
    expect(d.ok).toBe(true);
    await reader.refresh();
    expect((await ask()).reasons).toEqual(['no_bundle']);
    const r = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
    expect(r.ok).toBe(true);
    await reader.refresh();
    expect(await ask()).toMatchObject({
      decision: 'allow',
      bundle_version: b.bundle_version,
      bundle_hash: b.bundle_hash,
    });
  });

  it('a swap through config_publish takes effect on the same Pdp without a restart', async () => {
    // Version 2 drops project.admin's right to edit settings.
    const base = buildBundle();
    const policies = { ...base.policies };
    delete policies['role/project.admin/project.settings.edit'];
    const v2base = { schema: base.schema, policies, bundle_version: 'pdp-test-2' };
    const v2 = { ...v2base, bundle_hash: policyBundleHash(v2base) };
    expect((await ask()).decision).toBe('allow');
    await publish(v2);
    const after = await ask();
    expect(after).toMatchObject({
      decision: 'deny',
      bundle_version: 'pdp-test-2',
      bundle_hash: v2.bundle_hash,
    });
    expect(after.reasons).toEqual(['no_policy_permits']);
    // Roll forward again with the full bundle.
    const v3 = buildBundle({ bundle_version: 'pdp-test-3' });
    await publish(v3);
    expect(await ask()).toMatchObject({ decision: 'allow', bundle_version: 'pdp-test-3' });
  });

  it('other factory keys are carried over when a bundle is published', async () => {
    const effective = reader.current();
    expect(effective.get(PDP_CONFIG_KEY)).toMatchObject({ bundle_version: 'pdp-test-3' });
    expect(effective.revisions.factory).not.toBeNull();
  });

  it('the helper refuses a bundle that does not verify, before any gate opens', async () => {
    const good = buildBundle();
    const bad = {
      ...good,
      policies: { ...good.policies, x: 'permit (principal, action, resource);' },
    };
    const r = await proposeBundle(s.deps, bad, pr('root'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe('bundle_hash_mismatch');
  });

  it('a tampered bundle that reaches the config layer anyway is denied by the evaluator', async () => {
    // Straight through proposeRevision (the registry checks structure, not the hash): the M1
    // approvers saw a revision, and the content does not match the hash it declares.
    const good = buildBundle({ bundle_version: 'pdp-test-4' });
    const tampered = {
      ...good,
      policies: { ...good.policies, evil: 'permit (principal, action, resource);' },
    };
    const prev = reader.current();
    const doc = { [PDP_CONFIG_KEY]: tampered };
    const p = await proposeRevision(s.deps, { layer: 'factory', doc, proposed_by: pr('root') });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect((await decideGate(s, p.value.gate_instance_id, 'root', 'approve')).ok).toBe(true);
    expect((await configPublish(s.deps, { rev_hash: p.value.rev_hash })).ok).toBe(true);
    await reader.refresh();
    expect(reader.current().token).not.toBe(prev.token);
    const d = await ask();
    expect(d).toMatchObject({ decision: 'deny', reasons: ['bundle_hash_mismatch'] });
    // Nothing is allowed under it, not even what the tampering did not touch.
    expect((await ask('project.view')).decision).toBe('deny');
    expect((await ask('kill.request', pdpResource.fleet(), 'root')).decision).toBe('deny');
  });

  it('decisions are in the record as pdp.decision events: every deny, and the decide/kill/config allows', async () => {
    const rows = await s.record.pool.query<{ body: unknown; stream: string }>(
      "SELECT stream, body FROM record.record_event WHERE type = 'pdp.decision' ORDER BY global_seq",
    );
    expect(rows.rows.length).toBeGreaterThan(4);
    const recs = rows.rows.map((r) => PdpDecisionRecord.parse(r.body));
    for (const r of recs) {
      expect(
        r.decision === 'deny' ||
          [
            'gate.decide',
            'kill.request',
            'kill.release',
            'config.propose',
            'project.settings.edit',
            'project.onboard',
          ].includes(r.action),
      ).toBe(true);
    }
    expect(recs.some((r) => r.decision === 'allow' && r.action === 'project.settings.edit')).toBe(
      true,
    );
    expect(
      recs.some((r) => r.decision === 'deny' && r.reasons.includes('bundle_hash_mismatch')),
    ).toBe(true);
    expect(recs.some((r) => r.decision === 'deny' && r.reasons.includes('no_bundle'))).toBe(true);
    expect(rows.rows.every((r) => r.stream.startsWith('pdp_decision:'))).toBe(true);
  });

  it('pdp.bundle is factory-only: a project layer cannot set it', () => {
    const r = new ConfigRegistry();
    registerPdpConfig(r);
    expect(r.validate('project', { [PDP_CONFIG_KEY]: null }).ok).toBe(false);
    expect(r.validate('factory', { [PDP_CONFIG_KEY]: null }).ok).toBe(true);
  });
});
