import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigReader,
  ConfigRegistry,
  configProjection,
  configPublish,
  proposeRevision,
  registerGateCheckConfig,
  type ConfigDeps,
} from '@aisdlc/config';
import {
  EVIDENCE_BUCKET,
  EVIDENCE_EVENT,
  EVIDENCE_PACK_FORMAT,
  EvidencePack,
  EvidencePackSignedPayload,
  GATE_CHECK_APP_PERMISSIONS,
  ITEM_EVENT,
  ItemCreatedPayload,
  PrrGatingProfile,
  itemStream,
  MERGE_BYPASS_CONFIG_KEY,
  PUSH_EVENT,
  PrincipalId,
  ProjectId,
  PushReceipt,
  SIGNED_EVIDENCE_PACK_CONTENT_TYPE,
  SIGNED_EVIDENCE_PACK_FORMAT,
  evidencePackId,
  evidenceStream,
  pushStream,
  signedEvidencePackBytes,
  type Lane,
  type RoleSlot,
  type SignedEvidencePack,
} from '@aisdlc/contracts';
import { releasedCatalogues } from '@aisdlc/catalogue';
import { applyEvidenceEvent, applyPushEvent } from '@aisdlc/core';
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
import { hashCanonical, manualClock, sha256Hex, type Jwk } from '@aisdlc/kernel';
import { startTestKms } from '@aisdlc/kms-local/testing';
import { startTestNotary, type TestNotary } from '@aisdlc/notary/testing';
import {
  FAKE_PUSH_BROKER_LOGIN,
  FakeGitHub,
  FakeObjectStore,
  FakePushGuards,
  emptySeed,
  type GateCheckHostPort,
} from '@aisdlc/ports';
import { writeRequest } from '@aisdlc/ports/testing';
import { appendEvents, runProjection, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';
import {
  GateChecker,
  RecordFacts,
  RecordGateCheckStore,
  StaticNotaryKey,
  bypassFrom,
  type CheckerDeps,
  type RepoRow,
} from '../src/index.js';

// The world of the gate-check tests (PLAN M14.5): ONE real Postgres with the WHOLE migrate plan, the real Notary
// (its key in kms-local) signing every pack and every ledger decision, the decision kernel opening and deciding G3 on
// the item, the in-memory fake GitHub with the Push Broker's real preflight writing the agent PRs and people opening
// theirs, a fake write-once object store holding the signed packs. core's read models are written by core's own folds
// (`applyPushEvent`, `applyEvidenceEvent`) next to the record events they fold. gate-check reads all of it as its own
// least-privilege role, and writes check runs through its own App's view of the host.

export const REPO = 'acme/gc';
export const S0_REPO = 'acme/onboarding';
export const PROJECT = 'acme-gc';
export const BASE = 'c'.repeat(40);
export const GC_APP = { app_id: 2002, permissions: GATE_CHECK_APP_PERMISSIONS };
/** A released catalogue (the newest): what items pin and packs carry. */
export const CATALOGUE_REF = releasedCatalogues().at(-1) as { version: string; hash: string };

/** A gating profile with every group on, or the G3 group off. */
export const profileOf = (g3: 'on' | 'off' = 'on'): PrrGatingProfile =>
  PrrGatingProfile.parse({
    gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: g3, g5: 'on', g6: 'on' },
    schedule: 'auto',
    tier_floor_applied: true,
    project_deploys: false,
  });

const pr = (s: string): PrincipalId => PrincipalId.parse(s);
const planDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'migrate');

export interface World {
  readonly db: TestDatabase;
  readonly rolePool: pg.Pool;
  readonly roleName: string;
  /** The least-privilege role's connection URL (it carries a password: tests only). */
  readonly roleDbUrl: string;
  readonly notary: TestNotary;
  readonly notaryKey: Jwk;
  readonly decisions: DecisionDeps;
  readonly config: ConfigDeps;
  readonly reader: ConfigReader;
  readonly fake: FakeGitHub;
  readonly guards: FakePushGuards;
  readonly objects: FakeObjectStore;
  readonly host: GateCheckHostPort;
  readonly repo: RepoRow;
  readonly s0repo: RepoRow;
  checker(over?: Partial<CheckerDeps>): GateChecker;
  stop(): Promise<void>;
}

export interface AgentPr {
  readonly item: string;
  readonly number: number;
  readonly head: string;
  readonly g3: string | null;
  readonly pack: SignedEvidencePack | null;
  readonly receipt_id: string;
  readonly patch_hash: string;
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
  const holders: Partial<Record<RoleSlot, string[]>> = {
    admin: ['root'],
    design: ['dana'],
    x: ['xena', 'carol'],
  };
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
  const registry = registerGateCheckConfig(new ConfigRegistry());
  const decisions: DecisionDeps = {
    pool: db.pool,
    ledger: { notary: notary.clientFor('core'), notaryKey: k.value },
    eligibility: elig,
    stepUp: new FakeStepUp(),
    clock,
  };
  const config: ConfigDeps = { ...decisions, registry };
  const roleName = `gc_lp_${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await db.pool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${pw}' IN ROLE aisdlc_gatecheck`);
  await db.pool.query(`GRANT CONNECT ON DATABASE "${db.name}" TO ${roleName}`);
  const roleDbUrl = roleUrl(db.url, roleName, pw);
  const rolePool = createPool(roleDbUrl, 3);
  stoppers.push(() => rolePool.end());
  const reader = await ConfigReader.create({
    pool: rolePool,
    registry,
    catchUp: false,
    pollIntervalMs: 0,
  });
  await reader.start();
  stoppers.push(() => reader.stop());

  for (const [repo, level] of [
    [REPO, 'light'],
    [S0_REPO, 'none'],
  ] as const) {
    const [owner, name] = repo.split('/') as [string, string];
    await db.pool.query(
      `INSERT INTO core.repo (repo_key, repo_id, repo_ref, project_id, host, owner, name, visibility, owner_type, plan,
         default_branch, stack, onboarding_level)
       VALUES (lower($1), $2, $3, $4, 'github', $5, $6, 'private', 'org', null, 'main', null, $7)`,
      [repo, `id-${name}`, `github:${repo}`, PROJECT, owner, name, level],
    );
  }
  const guards = new FakePushGuards();
  const fake = new FakeGitHub(
    emptySeed({
      installation: {
        installation_id: 7,
        account_login: 'acme',
        repository_selection: 'selected',
        permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
        suspended: false,
      },
      repos: [REPO, S0_REPO].map((full_name) => ({
        full_name,
        default_branch: 'main',
        private: true,
        archived: false,
      })),
      heads: [REPO, S0_REPO].map((repo) => ({ repo, branch: 'main', sha: BASE })),
    }),
    { guards },
  );
  const objects = new FakeObjectStore();
  const host = fake.asApp(GC_APP);
  const repo: RepoRow = { repo: REPO, project_id: PROJECT, onboarding_level: 'light' };
  const s0repo: RepoRow = { repo: S0_REPO, project_id: PROJECT, onboarding_level: 'none' };
  return {
    db,
    rolePool,
    roleName,
    roleDbUrl,
    notary,
    notaryKey: k.value,
    decisions,
    config,
    reader,
    fake,
    guards,
    objects,
    host,
    repo,
    s0repo,
    checker: (over = {}) =>
      new GateChecker({
        host,
        facts: new RecordFacts(rolePool),
        packs: objects,
        notaryKey: new StaticNotaryKey(k.value),
        brokerLogin: FAKE_PUSH_BROKER_LOGIN,
        bypass: bypassFrom(reader),
        store: new RecordGateCheckStore(rolePool, clock),
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

/** Appends one event to `stream` and folds it, in one transaction (as core does). */
async function appendFold(
  w: World,
  stream: string,
  type: string,
  body: unknown,
  key: string,
  fold: (tx: pg.PoolClient, gseq: number) => Promise<void>,
): Promise<void> {
  await withTransaction(w.db.pool, async (tx) => {
    const head = await tx.query<{ seq: string }>(
      'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
      [stream],
    );
    const a = await appendEvents(tx, stream, Number(head.rows[0]?.seq ?? 0), [
      { type, body: body as JsonObject, actor: 'system.test', idempotency_key: key },
    ]);
    if (!a.ok) throw new Error(a.error._tag);
    await fold(tx, a.value.events[0]?.global_seq ?? 0);
  });
}

/** The item's `item.created` (what the engine records at intake): its catalogue pin, gating profile and tier. */
export async function recordItem(
  w: World,
  item: string,
  lane: Lane,
  profile: PrrGatingProfile,
): Promise<void> {
  const p = ItemCreatedPayload.parse({
    item_id: item,
    project_id: PROJECT,
    request_id: randomUUID(),
    repo: REPO,
    requester: 'alice',
    channel: 'N1',
    catalogue_ref: CATALOGUE_REF,
    gating_profile: profile,
    tier: 'T1',
    prr: { version: 1, record_hash: sha256Hex('prr') },
    proposed_lane: lane,
    intake: {
      text_sha256: sha256Hex(`text-${item}`),
      injection: null,
      dedupe_links: [],
      conflict_candidates: [],
      route: 'normal',
      eligibility_reason: 'eligible',
    },
    origin: null,
  });
  await appendFold(w, itemStream(item), ITEM_EVENT.created, p, `created:${item}`, async () => {});
}

/** Opens G3 on the item (as the work engine would at 5.7) and, unless `pending`, has `dana` decide it. */
export async function g3(
  w: World,
  item: string,
  outcome: 'approve' | 'reject' | 'pending',
): Promise<string> {
  const cards = await openCards(w.decisions, {
    project_id: ProjectId.parse(PROJECT),
    requester: pr('alice'),
    subject_kind: 'item',
    subject_id: item,
    gates: [{ gate_id: 'G3', subject_hash: sha256Hex(`plan-${item}-${randomUUID()}`) }],
  });
  if (!cards.ok) throw new Error(cards.error.message);
  const id = cards.value[0]?.gate_instance_ids[0] as string;
  if (outcome === 'pending') return id;
  const p = await prepare(w.decisions, { gate_instance_id: id, principal: pr('dana') });
  if (!p.ok) throw new Error(p.error.message);
  const v = await recordEvidenceViewed(w.decisions, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) throw new Error(v.error.message);
  const d = await decide(w.decisions, { nonce: p.value.nonce, decision: outcome });
  if (!d.ok) throw new Error(d.error.message);
  return id;
}

/** The Push Broker writes the Unit's patch (its real preflight) and core records the receipt (event + fold). */
export async function brokerPush(
  w: World,
  o: { item: string; lane: Lane; epoch: number; expected_head: string | null; n: number },
): Promise<{ head: string; number: number; receipt_id: string; patch_hash: string }> {
  w.guards.setLease(o.item, 'main', { held: true, epoch: o.epoch, lane: o.lane });
  const req = writeRequest(
    [
      {
        op: 'put',
        path: `src/f${o.n}.js`,
        mode: '100644',
        content_b64: Buffer.from(`export const v = ${o.n};\n`).toString('base64'),
      },
    ],
    {
      repo: REPO,
      item_id: o.item as never,
      lane: o.lane,
      lease_epoch: o.epoch,
      branch: `agent/${o.item}/main`,
      base_sha: BASE,
      expected_head: o.expected_head,
    },
  );
  const r = await w.fake.apply_patch(req);
  if (r.state !== 'ok') throw new Error(`${r.reason}: ${r.message}`);
  const receipt = PushReceipt.parse({
    receipt_id: `rcpt-${sha256Hex(`${o.item}:${r.value.commit_sha}`).slice(0, 32)}`,
    item_id: o.item,
    unit_key: 'main',
    repo: REPO,
    branch: req.branch,
    lease_epoch: o.epoch,
    patch_hash: r.value.patch_hash,
    status: 'applied',
    code: null,
    base_sha: BASE,
    head_sha: r.value.commit_sha,
    pr_number: r.value.pr.number,
    files: 1,
    at: '2026-11-12T10:00:00.000Z',
  });
  await appendFold(
    w,
    pushStream(o.item),
    PUSH_EVENT.receipt_recorded,
    receipt,
    `receipt:${receipt.receipt_id}`,
    (tx, gseq) =>
      applyPushEvent(tx as never, {
        type: PUSH_EVENT.receipt_recorded,
        payload: receipt,
        global_seq: gseq,
      }),
  );
  return {
    head: r.value.commit_sha,
    number: r.value.pr.number,
    receipt_id: receipt.receipt_id,
    patch_hash: receipt.patch_hash,
  };
}

const STEPS = [
  ['7.1', 'deterministic'],
  ['7.2', 'test_integrity'],
  ['7.3', 'spec_conformance'],
  ['7.4', 'secrets_dependencies'],
  ['7.5', 'constitution'],
] as const;

/** 7.6 for the head: the pack built, signed by the real Notary, stored write-once, recorded (event + fold). */
export async function signPack(
  w: World,
  o: {
    item: string;
    head: string;
    number: number;
    lane: Lane;
    passing: boolean;
    g3: string | null;
    receipt_id: string;
    patch_hash: string;
    /** Change the pack after it was signed (a forgery: the signature no longer matches). */
    tamper?: (p: EvidencePack) => EvidencePack;
    repo?: string;
    profile?: PrrGatingProfile;
    catalogue_ref?: { version: string; hash: string };
  },
): Promise<SignedEvidencePack> {
  const pack = EvidencePack.parse({
    format: EVIDENCE_PACK_FORMAT,
    item_id: o.item,
    project_id: PROJECT,
    repo: o.repo ?? REPO,
    lane: o.lane,
    tier: 'T1',
    profile_sha256: hashCanonical((o.profile ?? profileOf()) as never),
    catalogue_ref: o.catalogue_ref ?? CATALOGUE_REF,
    units: [{ unit_key: 'main' }],
    base_sha: BASE,
    head_sha: o.head,
    disposition: o.passing
      ? { kind: 'passed' }
      : { kind: 'rework', edge: 'B9', loop: 'et3_rounds', reason_code: 'tests_failed' },
    passing: o.passing,
    steps: STEPS.map(([step, check], i) => ({
      step,
      check,
      result_sha256: sha256Hex(`${o.head}:${step}`),
      verdict: o.passing || i > 0 ? 'passed' : 'failed',
      inputs_sha256: sha256Hex(`in:${step}`),
      raised: null,
      gate_approved: null,
      met: o.passing || i > 0,
      mutation: null,
      rules_version: null,
      findings: { total: 0, failing: 0, items: [] },
    })),
    gates:
      o.g3 === null
        ? []
        : [
            {
              gate: 'G3',
              gate_instance_id: o.g3,
              station: '5.7',
              status: 'decided',
              outcome: 'approve',
              decisions: [],
            },
          ],
    push_receipt: {
      receipt_id: o.receipt_id,
      patch_hash: o.patch_hash,
      head_sha: o.head,
      pr_number: o.number,
    },
    oracle_locks: {},
    produced_at: '2026-11-12T10:05:00.000Z',
  });
  const pack_sha256 = evidencePackId(pack);
  const sig = await w.notary.clientFor('core').signEvidencePack({
    pack_sha256,
    item_id: o.item,
    head_sha: o.head,
  });
  if (!sig.ok) throw new Error(sig.error.message);
  let signed: SignedEvidencePack = {
    format: SIGNED_EVIDENCE_PACK_FORMAT,
    pack_sha256,
    pack,
    signature: sig.value,
  };
  if (o.tamper) {
    const forged = EvidencePack.parse(o.tamper(pack));
    signed = { ...signed, pack: forged, pack_sha256: evidencePackId(forged) };
  }
  const bytes = signedEvidencePackBytes(signed);
  const d = await w.objects.declareBucket(EVIDENCE_BUCKET, 'write_once');
  if (!d.ok) throw new Error(d.error.message);
  const put = await w.objects.put(EVIDENCE_BUCKET, bytes, {
    contentType: SIGNED_EVIDENCE_PACK_CONTENT_TYPE,
  });
  if (!put.ok) throw new Error(put.error.message);
  const payload = EvidencePackSignedPayload.parse({
    command_key: `7.6:${o.item}:${signed.pack_sha256}`,
    item_id: o.item,
    unit_key: 'main',
    base_sha: BASE,
    head_sha: signed.pack.head_sha,
    pack_sha256: signed.pack_sha256,
    bucket: EVIDENCE_BUCKET,
    object_key: put.value.sha256,
    disposition: signed.pack.disposition,
    passing: signed.pack.passing,
    key_id: sig.value.key_id,
    handoff_pack_sha256: null,
    handoff_object_key: null,
    produced_at: signed.pack.produced_at,
  });
  await appendFold(
    w,
    evidenceStream(o.item),
    EVIDENCE_EVENT.pack_signed,
    payload,
    `evidence:${payload.command_key}`,
    (tx, gseq) =>
      applyEvidenceEvent(tx as never, {
        type: EVIDENCE_EVENT.pack_signed,
        payload,
        global_seq: gseq,
      }),
  );
  return signed;
}

let pushes = 0;

/** A whole agent PR as the factory makes it: push, G3, 7.6. */
export async function agentPr(
  w: World,
  o: {
    lane?: Lane;
    g3?: 'approve' | 'reject' | 'pending' | 'none';
    pack?: 'passing' | 'not_passing' | 'none';
    profile?: PrrGatingProfile;
    catalogue_ref?: { version: string; hash: string };
  } = {},
): Promise<AgentPr> {
  const item = randomUUID();
  const lane = o.lane ?? 'L3';
  const profile = o.profile ?? profileOf();
  await recordItem(w, item, lane, profile);
  pushes += 1;
  const p = await brokerPush(w, { item, lane, epoch: 1, expected_head: null, n: pushes });
  const g = o.g3 === undefined || o.g3 !== 'none' ? await g3(w, item, o.g3 ?? 'approve') : null;
  const kind = o.pack ?? 'passing';
  const pack =
    kind === 'none'
      ? null
      : await signPack(w, {
          item,
          head: p.head,
          number: p.number,
          lane,
          passing: kind === 'passing',
          g3: g,
          receipt_id: p.receipt_id,
          patch_hash: p.patch_hash,
          profile,
          ...(o.catalogue_ref ? { catalogue_ref: o.catalogue_ref } : {}),
        });
  return { item, g3: g, pack, ...p };
}

/** The PR as gate-check's App reads it. */
export async function pullOf(w: World, repo: string, number: number) {
  const r = await w.host.list_pulls({ repo, state: 'open' });
  if (r.state !== 'ok') throw new Error(r.message);
  const p = r.value.find((x) => x.number === number);
  if (!p) throw new Error(`no open PR ${number}`);
  return p;
}

/** Proposes the bypass list, has root decide its M1 gate (approve or not) and publishes an approved one. */
export async function proposeBypass(w: World, value: unknown, approve: boolean) {
  const p = await proposeRevision(w.config, {
    layer: 'factory',
    proposed_by: pr('dev'),
    doc: { [MERGE_BYPASS_CONFIG_KEY]: value },
  });
  if (!p.ok) return p;
  if (approve) {
    const prep = await prepare(w.decisions, {
      gate_instance_id: p.value.gate_instance_id,
      principal: pr('root'),
    });
    if (!prep.ok) throw new Error(prep.error.message);
    const v = await recordEvidenceViewed(w.decisions, {
      nonce: prep.value.nonce,
      evidence_hash: prep.value.evidence_hash,
    });
    if (!v.ok) throw new Error(v.error.message);
    const d = await decide(w.decisions, { nonce: prep.value.nonce, decision: 'approve' });
    if (!d.ok) throw new Error(d.error.message);
    const pub = await configPublish(w.config, { rev_hash: p.value.rev_hash });
    if (!pub.ok) throw new Error(pub.error.message);
  }
  // gate-check's role may not fold the config read model: core does (here, the owner)
  const r = await runProjection(w.db.pool, configProjection);
  if (!r.ok) throw new Error('projection');
  await w.reader.refresh();
  return p;
}
