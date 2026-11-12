import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigRegistry,
  configProjection,
  configPublish,
  proposeRevision,
  registerReleaseConfig,
  type ConfigDeps,
} from '@aisdlc/config';
import {
  EVIDENCE_BUCKET,
  EVIDENCE_EVENT,
  EVIDENCE_PACK_FORMAT,
  EvidencePack,
  EvidencePackSignedPayload,
  G5_ENGINE_HASH_KEY,
  G5_FACTS_KEY,
  GATE_RELAY_APP_PERMISSIONS,
  MergeObservedPayload,
  PrincipalId,
  ProjectId,
  RELEASE_CONFIG_KEY,
  SIGNED_EVIDENCE_PACK_CONTENT_TYPE,
  SIGNED_EVIDENCE_PACK_FORMAT,
  evidencePackId,
  evidenceStream,
  g5SubjectHash,
  mergeSubjectId,
  signedEvidencePackBytes,
  type ReleaseBinding,
  type ReleaseSetting,
  type RoleSlot,
} from '@aisdlc/contracts';
import { releasedCatalogues } from '@aisdlc/catalogue';
import { applyEvidenceEvent } from '@aisdlc/core';
import { createPool, migrate, withTransaction } from '@aisdlc/db';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  openCards,
  prepare,
  recordEvidenceViewed,
  type DecisionDeps,
} from '@aisdlc/decisions';
import { RecordGateCheckStore, StaticNotaryKey } from '@aisdlc/gate-check';
import { manualClock, sha256Hex, type Jwk, type ManualClock } from '@aisdlc/kernel';
import { startTestKms } from '@aisdlc/kms-local/testing';
import { startTestNotary, type TestNotary } from '@aisdlc/notary/testing';
import { FakeGitHub, FakeObjectStore, emptySeed, type GateRelayHostPort } from '@aisdlc/ports';
import { appendEvents, runProjection, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';
import { GateRelay, RecordGateRelayStore, RecordRelayFacts, type RelayDeps } from '../src/index.js';

// The world of the gate-relay tests (PLAN M15.3): ONE real Postgres with the WHOLE migrate plan, the real Notary (its
// key in kms-local) signing every pack and every ledger decision, the decision kernel opening G5 with the binding core
// puts on the card and the release approver deciding it with a step-up, the project's release setting published as an
// M1-gated project-layer revision, gate-check's merge record written by gate-check's own store, and the in-memory fake
// GitHub's deployment view for gate-relay's App. gate-relay reads all of it as its own least-privilege role.

export const REPO = 'acme/gr';
export const PROJECT = 'acme-gr';
export const ENV = 'production';
export const GR_APP = { app_id: 3003, permissions: GATE_RELAY_APP_PERMISSIONS };
const CATALOGUE_REF = releasedCatalogues().at(-1) as { version: string; hash: string };
const BASE = 'c'.repeat(40);
const STEPS = [
  ['7.1', 'deterministic'],
  ['7.2', 'test_integrity'],
  ['7.3', 'spec_conformance'],
  ['7.4', 'secrets_dependencies'],
  ['7.5', 'constitution'],
] as const;
const pr = (s: string): PrincipalId => PrincipalId.parse(s);
const planDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'migrate');

export interface World {
  readonly db: TestDatabase;
  readonly rolePool: pg.Pool;
  readonly roleName: string;
  /** The least-privilege role's connection URL (it carries a password: tests only). */
  readonly roleDbUrl: string;
  readonly clock: ManualClock;
  readonly notary: TestNotary;
  readonly notaryKey: Jwk;
  readonly decisions: DecisionDeps;
  readonly config: ConfigDeps;
  readonly fake: FakeGitHub;
  readonly objects: FakeObjectStore;
  readonly host: GateRelayHostPort;
  relay(over?: Partial<RelayDeps>): GateRelay;
  stop(): Promise<void>;
}

const roleUrl = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

export async function startWorld(): Promise<World> {
  const stoppers: Array<() => Promise<void>> = [];
  const kms = await startTestKms();
  stoppers.push(() => kms.stop());
  const db = await createTestDatabase();
  stoppers.push(() => db.drop());
  const plan = JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')) as {
    databases: { record: Array<{ scope: string; dir: string }> };
  };
  for (const e of plan.databases.record)
    await migrate(db.pool, { scope: e.scope, dir: join(planDir, e.dir) });
  const clock = manualClock('2026-11-12T10:00:00.000Z');
  const notary = await startTestNotary({ custody: kms.custodyFor('notary'), clock });
  stoppers.push(() => notary.stop());
  const k = await kms.custodyFor('witness').publicKey('dev:notary');
  if (!k.ok) throw new Error(k.error.message);
  const elig = new FakeEligibility();
  const holders: Partial<Record<RoleSlot, string[]>> = { admin: ['root'], g5: ['gail'] };
  for (const project of ['factory', PROJECT]) {
    elig.setPolicy(ProjectId.parse(project), { tier: 'T1', two_person: { enabled: false } });
    for (const slot of [
      'admin',
      'requesters',
      'intent',
      'design',
      'g4',
      'g5',
      'x',
      'sec',
      'm4',
      'kill',
    ] as RoleSlot[]) {
      elig.setHolders(
        ProjectId.parse(project),
        slot,
        (holders[slot] ?? []).map((h) => pr(h)),
      );
    }
  }
  const decisions: DecisionDeps = {
    pool: db.pool,
    ledger: { notary: notary.clientFor('core'), notaryKey: k.value },
    eligibility: elig,
    stepUp: new FakeStepUp(),
    clock,
  };
  const config: ConfigDeps = {
    ...decisions,
    registry: registerReleaseConfig(new ConfigRegistry()),
  };
  const roleName = `gr_lp_${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await db.pool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${pw}' IN ROLE aisdlc_gaterelay`);
  await db.pool.query(`GRANT CONNECT ON DATABASE "${db.name}" TO ${roleName}`);
  const roleDbUrl = roleUrl(db.url, roleName, pw);
  const rolePool = createPool(roleDbUrl, 3);
  stoppers.push(() => rolePool.end());
  const fake = new FakeGitHub(
    emptySeed({
      installation: {
        installation_id: 7,
        account_login: 'acme',
        repository_selection: 'selected',
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
        suspended: false,
      },
      repos: [{ full_name: REPO, default_branch: 'main', private: true, archived: false }],
      heads: [{ repo: REPO, branch: 'main', sha: BASE }],
    }),
  );
  const objects = new FakeObjectStore();
  const host = fake.asDeployApp(GR_APP);
  return {
    db,
    rolePool,
    roleName,
    roleDbUrl,
    clock,
    notary,
    notaryKey: k.value,
    decisions,
    config,
    fake,
    objects,
    host,
    relay: (over = {}) =>
      new GateRelay({
        host,
        facts: new RecordRelayFacts(rolePool),
        packs: objects,
        notaryKey: new StaticNotaryKey(k.value),
        store: new RecordGateRelayStore(rolePool, clock),
        clock,
        ...over,
      }),
    stop: async () => {
      for (const s of stoppers.reverse()) await s().catch(() => undefined);
      const { default: pgmod } = await import('pg');
      const c = new pgmod.Pool({
        connectionString: new URL('/postgres', db.url).toString(),
        max: 1,
      });
      await c.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => undefined);
      await c.end();
    },
  };
}

/** Publishes the project's release setting as an M1-approved project-layer revision (core folds the view). */
export async function publishRelease(w: World, value: ReleaseSetting | null): Promise<void> {
  const p = await proposeRevision(w.config, {
    layer: 'project',
    scope: { kind: 'project', ref: PROJECT },
    proposed_by: pr('dev'),
    doc: { [RELEASE_CONFIG_KEY]: value },
  });
  if (!p.ok) throw new Error(p.error.message);
  await decideAs(w, p.value.gate_instance_id, 'root', 'approve');
  const pub = await configPublish(w.config, { rev_hash: p.value.rev_hash });
  if (!pub.ok) throw new Error(pub.error.message);
  const r = await runProjection(w.db.pool, configProjection);
  if (!r.ok) throw new Error('projection');
}

export async function decideAs(
  w: World,
  gate: string,
  who: string,
  decision: 'approve' | 'reject',
): Promise<void> {
  const p = await prepare(w.decisions, { gate_instance_id: gate, principal: pr(who) });
  if (!p.ok) throw new Error(p.error.message);
  const v = await recordEvidenceViewed(w.decisions, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) throw new Error(v.error.message);
  const proof = p.value.step_up.required
    ? (w.decisions.stepUp as FakeStepUp).issue(p.value.step_up.bound_hash, who)
    : null;
  const d = await decide(w.decisions, {
    nonce: p.value.nonce,
    decision,
    ...(proof ? { step_up: { proof } } : {}),
  });
  if (!d.ok) throw new Error(d.error.message);
}

/** 7.6 for the head: the pack built, signed by the real Notary, stored write-once, recorded (event + core's fold). */
export async function signPack(w: World, item: string, head: string, passing = true) {
  const pack = EvidencePack.parse({
    format: EVIDENCE_PACK_FORMAT,
    item_id: item,
    project_id: PROJECT,
    repo: REPO,
    lane: 'L3',
    tier: 'T1',
    profile_sha256: sha256Hex('profile'),
    catalogue_ref: CATALOGUE_REF,
    units: [{ unit_key: 'main' }],
    base_sha: BASE,
    head_sha: head,
    disposition: passing
      ? { kind: 'passed' }
      : { kind: 'rework', edge: 'B9', loop: 'et3_rounds', reason_code: 'tests_failed' },
    passing,
    steps: STEPS.map(([step, check], i) => ({
      step,
      check,
      result_sha256: sha256Hex(`${head}:${step}`),
      verdict: passing || i > 0 ? 'passed' : 'failed',
      inputs_sha256: sha256Hex(`in:${step}`),
      raised: null,
      gate_approved: null,
      met: passing || i > 0,
      mutation: null,
      rules_version: null,
      findings: { total: 0, failing: 0, items: [] },
    })),
    gates: [],
    push_receipt: {
      receipt_id: 'rcpt-1',
      patch_hash: sha256Hex('patch'),
      head_sha: head,
      pr_number: 1,
    },
    oracle_locks: {},
    produced_at: '2026-11-12T10:05:00.000Z',
  });
  const pack_sha256 = evidencePackId(pack);
  const sig = await w.notary
    .clientFor('core')
    .signEvidencePack({ pack_sha256, item_id: item, head_sha: head });
  if (!sig.ok) throw new Error(sig.error.message);
  const bytes = signedEvidencePackBytes({
    format: SIGNED_EVIDENCE_PACK_FORMAT,
    pack_sha256,
    pack,
    signature: sig.value,
  });
  const d = await w.objects.declareBucket(EVIDENCE_BUCKET, 'write_once');
  if (!d.ok) throw new Error(d.error.message);
  const put = await w.objects.put(EVIDENCE_BUCKET, bytes, {
    contentType: SIGNED_EVIDENCE_PACK_CONTENT_TYPE,
  });
  if (!put.ok) throw new Error(put.error.message);
  const payload = EvidencePackSignedPayload.parse({
    command_key: `7.6:${item}:${pack_sha256}`,
    item_id: item,
    unit_key: 'main',
    base_sha: BASE,
    head_sha: head,
    pack_sha256,
    bucket: EVIDENCE_BUCKET,
    object_key: put.value.sha256,
    disposition: pack.disposition,
    passing,
    key_id: sig.value.key_id,
    handoff_pack_sha256: null,
    handoff_object_key: null,
    produced_at: pack.produced_at,
  });
  await withTransaction(w.db.pool, async (tx) => {
    const a = await appendEvents(tx, evidenceStream(item), 0, [
      {
        type: EVIDENCE_EVENT.pack_signed,
        body: payload as unknown as JsonObject,
        actor: 'system.test',
        idempotency_key: `evidence:${payload.command_key}`,
      },
    ]);
    if (!a.ok) throw new Error(a.error._tag);
    await applyEvidenceEvent(tx as never, {
      type: EVIDENCE_EVENT.pack_signed,
      payload,
      global_seq: a.value.events[0]?.global_seq ?? 0,
    });
  });
  return { pack_sha256, object_key: put.value.sha256 };
}

/** gate-check's record of a merge of the item's PR (written by gate-check's own store, as gate-check does). */
export async function recordMerge(
  w: World,
  o: { item: string; pr: number; head: string; merged: string; cls?: 'gated' | 'bypass' },
): Promise<void> {
  await new RecordGateCheckStore(w.db.pool, w.clock).recordMerge(
    MergeObservedPayload.parse({
      merge_id: mergeSubjectId(REPO, o.pr, o.head),
      repo: REPO,
      project_id: PROJECT,
      pr_number: o.pr,
      head_sha: o.head,
      head_ref: `agent/${o.item}/main`,
      merge_commit_sha: o.merged,
      merged_by: 'mona',
      merged_at: '2026-11-12T11:00:00Z',
      author: { login: 'aisdlc-push[bot]', type: 'Bot' },
      class: o.cls ?? 'gated',
      bypass_person: o.cls === 'bypass' ? { login: 'mona', principal_id: 'mona' } : null,
      last_verdict: { outcome: 'success', reason: 'passed', profile: 'agent' },
      host_check: 'success',
      item_id: o.item,
    }),
  );
}

export function binding(o: {
  item: string;
  pr: number;
  head: string;
  merged: string;
  pack: string;
  env?: string;
}): ReleaseBinding {
  return {
    status: 'bound',
    item_id: o.item as never,
    project_id: PROJECT as never,
    repo: REPO,
    pr_number: o.pr,
    unit_key: 'main',
    merged_sha: o.merged,
    pack_sha256: o.pack,
    pack_head_sha: o.head,
    environment: o.env ?? ENV,
  };
}

/** Opens G5 on the item with the binding on its card (as core's work driver does) and, unless pending, decides it. */
export async function g5(
  w: World,
  b: ReleaseBinding,
  outcome: 'approve' | 'reject' | 'pending',
  o: { subjectHash?: string } = {},
): Promise<string> {
  const engine = sha256Hex(`engine-${b.item_id}-${randomUUID()}`);
  const cards = await openCards(w.decisions, {
    project_id: ProjectId.parse(PROJECT),
    requester: pr('alice'),
    subject_kind: 'item',
    subject_id: b.item_id,
    gates: [
      {
        gate_id: 'G5',
        subject_hash: o.subjectHash ?? g5SubjectHash(engine, b),
        facts: { [G5_FACTS_KEY]: b as unknown as JsonObject, [G5_ENGINE_HASH_KEY]: engine },
      },
    ],
  });
  if (!cards.ok) throw new Error(cards.error.message);
  const id = cards.value[0]?.gate_instance_ids[0] as string;
  if (outcome !== 'pending') await decideAs(w, id, 'gail', outcome);
  return id;
}

/** A whole releasable item: its pack, gate-check's gated merge, its approved G5 bound to them. */
export async function releasable(
  w: World,
  o: { outcome?: 'approve' | 'reject' | 'pending'; merged?: string; head?: string } = {},
) {
  const item = randomUUID();
  const head = o.head ?? sha256Hex(`head-${item}`).slice(0, 40);
  const merged = o.merged ?? sha256Hex(`merged-${item}`).slice(0, 40);
  const pack = await signPack(w, item, head);
  await recordMerge(w, { item, pr: 1, head, merged });
  const b = binding({ item, pr: 1, head, merged, pack: pack.pack_sha256 });
  const gate = await g5(w, b, o.outcome ?? 'approve');
  return { item, head, merged, pack, binding: b, gate };
}
