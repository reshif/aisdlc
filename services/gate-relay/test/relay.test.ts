import { randomUUID } from 'node:crypto';
import {
  EVIDENCE_BUCKET,
  GATE_CHECK_APP_PERMISSIONS,
  foldReleaseStatus,
  gateRelayStream,
} from '@aisdlc/contracts';
import { StaticNotaryKey } from '@aisdlc/gate-check';
import { hashCanonical, sha256Hex } from '@aisdlc/kernel';
import { readUnknown } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RecordGateRelayStore, RelayRetry, rebuildGateRelay, releasesOf } from '../src/index.js';
import {
  ENV,
  REPO,
  binding,
  g5,
  publishRelease,
  recordMerge,
  releasable,
  signPack,
  startWorld,
  type World,
} from './fixture.js';

// PLAN M15.3: gate-relay consumes an approved G5 exactly once into a deployment of the merged commit (DeployMarker),
// refuses what its card does not bind (RELHOLD in core), never releases on unknown, and rolls an unhealthy release
// back (B16) to the environment's last healthy release.

let w: World;
beforeAll(async () => {
  w = await startWorld();
  await publishRelease(w, { mode: 'target', environment: ENV });
});
afterAll(async () => {
  await w.stop();
});

const events = async (item: string) =>
  (
    await w.db.pool.query<{ type: string; body: unknown }>(
      'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [gateRelayStream(item)],
    )
  ).rows;
const deploymentsOf = (gate: string) =>
  w.fake.deploymentsOf(REPO).filter((d) => d.tag?.aisdlc.gate_instance_id === gate);

describe('an approved G5 is released once', () => {
  it('creates ONE deployment of the merged commit through gate-relay’s App, and records the DeployMarker', async () => {
    const r = await releasable(w);
    const relay = w.relay();
    const out = await relay.consume(r.gate);
    expect(out).toMatchObject({ kind: 'released', reused: false });
    const deps = deploymentsOf(r.gate);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ sha: r.merged, environment: ENV, app_id: 3003 });
    expect(deps[0]?.tag?.aisdlc).toMatchObject({ item_id: r.item, kind: 'release' });
    const st = foldReleaseStatus(await events(r.item), r.gate);
    expect(st).toMatchObject({
      state: 'deployed',
      marker: {
        merged_sha: r.merged,
        pack_sha256: r.pack.pack_sha256,
        environment: ENV,
        gate_instance_id: r.gate,
        binding_sha256: hashCanonical(r.binding),
      },
    });
    // the intent came first (record-first), then the marker
    expect((await events(r.item)).map((e) => e.type)).toEqual([
      'gaterelay.release_intended',
      'gaterelay.deployment_created',
    ]);
    // answered: not consumed again, nothing more on the host
    const again = await relay.consumeAll();
    expect(again.filter((x) => x.kind === 'released')).toEqual([]);
    expect(deploymentsOf(r.gate)).toHaveLength(1);
  });

  it('after a crash between the host and the record, the deployment on the host is the one recorded (no second)', async () => {
    const r = await releasable(w);
    // the deployment is made, then the process dies before the marker is recorded (the intent is there)
    const store = new RecordGateRelayStore(w.rolePool, w.clock);
    const lost = w.relay({
      store: {
        intend: (p) => store.intend(p),
        refuse: (p) => store.refuse(p),
        marker: async () => {
          throw new Error('crashed');
        },
        health: (t, p) => store.health(t, p),
      },
    });
    await expect(lost.consume(r.gate)).rejects.toThrow('crashed');
    expect(deploymentsOf(r.gate)).toHaveLength(1);
    const out = await w.relay().consume(r.gate);
    expect(out).toMatchObject({ kind: 'released', reused: true });
    expect(deploymentsOf(r.gate)).toHaveLength(1);
  });

  it('a pending, denied or unknown G5 releases nothing', async () => {
    const pending = await releasable(w, { outcome: 'pending' });
    const denied = await releasable(w, { outcome: 'reject' });
    const relay = w.relay();
    expect(await relay.consume(pending.gate)).toMatchObject({
      kind: 'skipped',
      why: 'status_pending',
    });
    expect(await relay.consume(denied.gate)).toMatchObject({ kind: 'skipped' });
    expect(await relay.consume(randomUUID())).toMatchObject({ kind: 'skipped', why: 'no_gate' });
    expect(deploymentsOf(pending.gate)).toHaveLength(0);
    expect(deploymentsOf(denied.gate)).toHaveLength(0);
    expect(await events(denied.item)).toEqual([]);
  });
});

describe('what the card does not bind is refused (and recorded): nothing is deployed', () => {
  const refusedFor = async (gate: string, item: string) => {
    const out = await w.relay().consume(gate);
    expect(deploymentsOf(gate)).toHaveLength(0);
    return { out, status: foldReleaseStatus(await events(item), gate) };
  };

  it('an unbound card', async () => {
    const item = randomUUID();
    const gate = await g5(
      w,
      {
        status: 'unbound',
        item_id: item as never,
        project_id: 'acme-gr' as never,
        repo: REPO,
        reason: 'no_passing_pack',
      },
      'approve',
    );
    const r = await refusedFor(gate, item);
    expect(r.out).toEqual({ kind: 'refused', reason: 'unbound' });
    expect(r.status).toEqual({ state: 'refused', reason: 'unbound' });
  });

  it('a subject hash that is not the binding’s (the card is not what was decided)', async () => {
    const item = randomUUID();
    const head = 'd'.repeat(40);
    const pack = await signPack(w, item, head);
    const b = binding({ item, pr: 1, head, merged: 'e'.repeat(40), pack: pack.pack_sha256 });
    const gate = await g5(w, b, 'approve', { subjectHash: sha256Hex('something else') });
    expect((await refusedFor(gate, item)).out).toEqual({
      kind: 'refused',
      reason: 'subject_mismatch',
    });
  });

  it('a merged commit gate-check did not record as the gated merge of the pack’s head', async () => {
    // no merge at all
    const item = randomUUID();
    const head = sha256Hex(`h-${item}`).slice(0, 40);
    const merged = sha256Hex(`m-${item}`).slice(0, 40);
    const pack = await signPack(w, item, head);
    const g = await g5(
      w,
      binding({ item, pr: 1, head, merged, pack: pack.pack_sha256 }),
      'approve',
    );
    expect((await refusedFor(g, item)).out).toEqual({
      kind: 'refused',
      reason: 'merged_content_mismatch',
    });
    // a gated merge, but of other content (another merge commit)
    const i2 = randomUUID();
    const p2 = await signPack(w, i2, head);
    await recordMerge(w, { item: i2, pr: 1, head, merged: 'f'.repeat(40) });
    const g2 = await g5(
      w,
      binding({ item: i2, pr: 1, head, merged, pack: p2.pack_sha256 }),
      'approve',
    );
    expect((await refusedFor(g2, i2)).out).toMatchObject({ reason: 'merged_content_mismatch' });
    // the right commit, but a bypass merge (aisdlc/gate did not pass)
    const i3 = randomUUID();
    const p3 = await signPack(w, i3, head);
    await recordMerge(w, { item: i3, pr: 1, head, merged, cls: 'bypass' });
    const g3 = await g5(
      w,
      binding({ item: i3, pr: 1, head, merged, pack: p3.pack_sha256 }),
      'approve',
    );
    expect((await refusedFor(g3, i3)).out).toMatchObject({ reason: 'merged_content_mismatch' });
  });

  it('a pack that does not verify, or is not passing', async () => {
    const r = await releasable(w);
    // the stored bytes are replaced by other bytes under another key: the row's key no longer reads
    await w.db.pool.query(`UPDATE core.evidence_pack SET object_key = $2 WHERE pack_sha256 = $1`, [
      r.pack.pack_sha256,
      sha256Hex('nothing here'),
    ]);
    expect((await refusedFor(r.gate, r.item)).out).toEqual({
      kind: 'refused',
      reason: 'pack_invalid',
    });
    const item = randomUUID();
    const head = sha256Hex(`np-${item}`).slice(0, 40);
    const merged = sha256Hex(`npm-${item}`).slice(0, 40);
    const pack = await signPack(w, item, head, false);
    await recordMerge(w, { item, pr: 1, head, merged });
    const g = await g5(
      w,
      binding({ item, pr: 1, head, merged, pack: pack.pack_sha256 }),
      'approve',
    );
    expect((await refusedFor(g, item)).out).toMatchObject({ reason: 'pack_invalid' });
  });

  it('a target that changed since the card was opened (another environment)', async () => {
    const item = randomUUID();
    const head = sha256Hex(`t-${item}`).slice(0, 40);
    const merged = sha256Hex(`tm-${item}`).slice(0, 40);
    const pack = await signPack(w, item, head);
    await recordMerge(w, { item, pr: 1, head, merged });
    const g = await g5(
      w,
      binding({ item, pr: 1, head, merged, pack: pack.pack_sha256, env: 'staging' }),
      'approve',
    );
    expect((await refusedFor(g, item)).out).toEqual({ kind: 'refused', reason: 'target_changed' });
  });

  it('the Push Broker’s or gate-check’s credential cannot deploy: the host refuses, and that is recorded', async () => {
    const r = await releasable(w);
    const out = await w
      .relay({
        host: w.fake.asDeployApp({ app_id: 2002, permissions: GATE_CHECK_APP_PERMISSIONS }),
      })
      .consume(r.gate);
    expect(out).toEqual({ kind: 'refused', reason: 'host_refused' });
    expect(
      w.fake.deploymentsOf(REPO).filter((d) => d.tag?.aisdlc.gate_instance_id === r.gate),
    ).toEqual([]);
    const r2 = await releasable(w);
    expect(await w.relay({ host: w.fake.asDeployApp(w.fake.pushApp) }).consume(r2.gate)).toEqual({
      kind: 'refused',
      reason: 'host_refused',
    });
  });
});

describe('unknown is not released (and not refused): it is asked again', () => {
  it('no Notary key, or no answer from the host: nothing recorded, nothing deployed', async () => {
    const r = await releasable(w);
    await expect(
      w.relay({ notaryKey: new StaticNotaryKey(null) }).consume(r.gate),
    ).rejects.toBeInstanceOf(RelayRetry);
    expect(await events(r.item)).toEqual([]);
    w.fake.breakChecksApi(readUnknown('server_error', 'down'));
    try {
      await expect(w.relay().consume(r.gate)).rejects.toBeInstanceOf(RelayRetry);
    } finally {
      w.fake.unbreak();
    }
    expect(deploymentsOf(r.gate)).toHaveLength(0);
    expect(foldReleaseStatus(await events(r.item), r.gate).state).toBe('intended');
    // the host answers again: released once
    expect(await w.relay().consume(r.gate)).toMatchObject({ kind: 'released' });
    expect(deploymentsOf(r.gate)).toHaveLength(1);
  });

  it('a project whose release is off or not chosen now releases nothing', async () => {
    const r = await releasable(w);
    await publishRelease(w, { mode: 'off' });
    try {
      expect(await w.relay().consume(r.gate)).toEqual({
        kind: 'refused',
        reason: 'target_changed',
      });
    } finally {
      await publishRelease(w, { mode: 'target', environment: ENV });
    }
  });
});

describe('health: a healthy release is released; an unhealthy one is rolled back (B16)', () => {
  it('records success as healthy and failure as unhealthy, rolling back to the last healthy release', async () => {
    const relay = w.relay();
    const good = await releasable(w);
    const g = await relay.consume(good.gate);
    if (g.kind !== 'released') throw new Error('not released');
    // nothing reported yet: pending, no verdict
    expect(await relay.observeAll()).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ marker_id: g.marker.marker_id })]),
    );
    w.fake.setDeploymentStatus(REPO, g.marker.deployment_id, 'in_progress');
    w.fake.setDeploymentStatus(REPO, g.marker.deployment_id, 'success');
    await relay.observeAll();
    expect(foldReleaseStatus(await events(good.item), good.gate).state).toBe('healthy');

    const bad = await releasable(w);
    const b = await relay.consume(bad.gate);
    if (b.kind !== 'released') throw new Error('not released');
    w.fake.setDeploymentStatus(REPO, b.marker.deployment_id, 'failure');
    await relay.observeAll();
    const st = foldReleaseStatus(await events(bad.item), bad.gate);
    expect(st.state).toBe('unhealthy');
    const rollbackId = st.state === 'unhealthy' ? st.rollback_marker_id : null;
    expect(rollbackId).not.toBeNull();
    // the rollback deploys the last healthy release's merged commit to the same environment
    const rb = w.fake
      .deploymentsOf(REPO)
      .filter(
        (d) => d.tag?.aisdlc.gate_instance_id === bad.gate && d.tag.aisdlc.kind === 'rollback',
      );
    expect(rb).toHaveLength(1);
    expect(rb[0]).toMatchObject({ sha: good.merged, environment: ENV });
    const view = await releasesOf(w.rolePool, bad.item);
    expect(view.markers.map((m) => [m.kind, m.rollback_of])).toEqual([
      ['release', null],
      ['rollback', b.marker.marker_id],
    ]);
    // a later success on the unhealthy release does not undo the verdict
    w.fake.setDeploymentStatus(REPO, b.marker.deployment_id, 'success');
    await relay.observeAll();
    expect(foldReleaseStatus(await events(bad.item), bad.gate).state).toBe('unhealthy');
  });
});

describe('record and role', () => {
  it('the read models are rebuilt from the record alone', async () => {
    const snap = async () =>
      (
        await w.db.pool.query(
          `SELECT (SELECT count(*) FROM gaterelay.intent) AS i, (SELECT count(*) FROM gaterelay.refusal) AS r,
                  (SELECT count(*) FROM gaterelay.deploy_marker) AS m, (SELECT count(*) FROM gaterelay.deploy_health) AS h,
                  (SELECT string_agg(marker_id::text || payload::text, ',' ORDER BY marker_id) FROM gaterelay.deploy_marker) AS p`,
        )
      ).rows[0];
    const before = await snap();
    expect(Number(before?.m)).toBeGreaterThan(0);
    await rebuildGateRelay(w.db.pool);
    expect(await snap()).toEqual(before);
  });

  it('its role reads no item stream and no other core table, appends only its own streams, and never updates', async () => {
    const q = (sql: string, args: unknown[] = []) => w.rolePool.query(sql, args);
    const items = await q(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream LIKE 'item:%'`,
    );
    expect(items.rows[0]?.n).toBe(0);
    await expect(q('SELECT 1 FROM core.pull_request LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(q('SELECT 1 FROM core.repo LIMIT 1')).rejects.toThrow(/permission denied/);
    await expect(q(`UPDATE gaterelay.deploy_marker SET deployment_id = 1`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(q(`DELETE FROM gaterelay.refusal`)).rejects.toThrow(/permission denied/);
    await expect(
      q(`UPDATE core.evidence_pack SET passing = true WHERE bucket = $1`, [EVIDENCE_BUCKET]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe('the booted service', () => {
  it('releases through its loops as its own role and serves the releases to a caller with scope read', async () => {
    const { bootGateRelay } = await import('../src/boot.js');
    const { dbUrlRef } = await import('@aisdlc/db/testing');
    const r = await releasable(w);
    const token = 'c'.repeat(48);
    const svc = await bootGateRelay(
      {
        ...dbUrlRef('GATE_RELAY_DATABASE_URL', w.roleDbUrl),
        GATE_RELAY_CALLERS: JSON.stringify({ bff: { token_ref: 'env:GR_TOK', scopes: ['read'] } }),
        GR_TOK: token,
        GATE_RELAY_CONSUME_INTERVAL_MS: '100',
        GATE_RELAY_HEALTH_INTERVAL_MS: '200',
      },
      {
        host: w.host,
        packs: w.objects,
        notaryKey: new StaticNotaryKey(w.notaryKey),
        log: () => undefined,
      },
    );
    try {
      for (let i = 0; i < 100 && deploymentsOf(r.gate).length === 0; i++) {
        await new Promise((res) => setTimeout(res, 50));
      }
      expect(deploymentsOf(r.gate)).toHaveLength(1);
      let body: { markers: Array<{ gate_instance_id: string }> } = { markers: [] };
      for (let i = 0; i < 40 && body.markers.length === 0; i++) {
        const res = await fetch(new URL(`/v1/releases?item=${r.item}`, svc.url), {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        body = (await res.json()) as typeof body;
        if (body.markers.length === 0) await new Promise((res2) => setTimeout(res2, 50));
      }
      expect(body.markers[0]?.gate_instance_id).toBe(r.gate);
      expect((await fetch(new URL(`/v1/releases?item=${r.item}`, svc.url))).status).toBe(401);
      const h = await fetch(new URL('/healthz', svc.url));
      const report = (await h.json()) as { loops: Array<{ name: string }> };
      expect(report.loops.map((l) => l.name).sort()).toEqual([
        'gate_relay_consume',
        'gate_relay_health',
      ]);
    } finally {
      await svc.close();
    }
  });
});
