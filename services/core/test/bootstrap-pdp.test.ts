import {
  CARD_EVENT,
  CardOpenedPayload,
  S0_EVENT,
  cardStream,
  pdpResource,
  type PdpResource,
} from '@aisdlc/contracts';
import { newId } from '@aisdlc/kernel';
import { createPool } from '@aisdlc/db';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { grantFleetRole, seedPrincipals, settingsOf } from '@aisdlc/identity/testing';
import { BootstrapPdpEntities } from '@aisdlc/onboarding';
import { Pdp, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inCoreTx } from '../src/index.js';
import { publishSettings, setAdmins, startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness } from './harness.js';

// The bootstrap grant as the PDP sees it (PLAN M8.3, closing the gap M8.1 found). The requester of a
// project's first onboarding is a bare `factory.admin`, which holds no project role, so the PDP
// denied them `card.decide` on the very cards the bootstrap decision made theirs. `BootstrapPdpEntities`
// gives the live grantee the project admin role for the one request in front of the PDP, and only
// for cards 1, 4 and 5 of the record that holds the grant and for the M1 gate over a config revision.

let s: CoreStack;
let ownPool: pg.Pool;
let plain: Pdp;
let withGrant: Pdp;

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice', 'bob', 'carol']);
  await grantFleetRole(s.id.deps, 'alice', 'factory.admin');
  await grantFleetRole(s.id.deps, 'bob', 'factory.admin');
  ownPool = createPool(s.record.url, 3);
  const mk = (e: ConstructorParameters<typeof Pdp>[0]['entities']) =>
    new Pdp({ source: new StaticBundleSource(buildBundle()), entities: e, clock: s.clock });
  plain = mk(new IdentityPdpEntities({ pool: ownPool }));
  withGrant = mk(
    new BootstrapPdpEntities(new IdentityPdpEntities({ pool: ownPool }), { db: s.record.pool }),
  );
});
afterAll(async () => {
  await ownPool?.end();
  await s.stop();
});

const h = makeHarness(() => s, 'bpdp');
const { scenario, sync, actionable, detail, ok, c1Content, c4Content, events } = h;

const allowed = async (pdp: Pdp, who: string, action: string, resource: PdpResource) =>
  (await pdp.decide({ principal: who, action, resource }, { log: false })).decision === 'allow';
const decideCard = (pdp: Pdp, who: string, project: string, card: string) =>
  allowed(pdp, who, 'card.decide', pdpResource.card(project, card));

describe('the bootstrap grant in the PDP', () => {
  it('the grantee decides cards 1 and 4 of their S0 record; without the grant the same request is denied', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    expect(await c.drive()).toBe('card');
    await sync(c);
    const c1 = await actionable(c, 'C1');
    // the gap: a bare factory.admin
    expect(await decideCard(plain, 'alice', c.project, c1.card_id)).toBe(false);
    expect(await decideCard(withGrant, 'alice', c.project, c1.card_id)).toBe(true);
    // only the grantee
    expect(await decideCard(withGrant, 'bob', c.project, c1.card_id)).toBe(false);
    expect(await decideCard(withGrant, 'carol', c.project, c1.card_id)).toBe(false);

    const d1 = await detail(c, c1.card_id);
    ok(await h.decideAs(c, c1.card_id, 'alice', 'approve', c1Content(d1.view)));
    await c.drive();
    await sync(c);
    const c4 = await actionable(c, 'C4');
    expect(await decideCard(withGrant, 'alice', c.project, c4.card_id)).toBe(true);
    expect(await decideCard(withGrant, 'bob', c.project, c4.card_id)).toBe(false);
  });

  it('card 5 and the M1 gate of the role map follow; M4 and everything else do not', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await h.throughC1(c);
    await c.drive();
    await sync(c);
    const c4 = await actionable(c, 'C4');
    const d4 = await detail(c, c4.card_id);
    const rm = {
      ...d4.view.role_map.proposed,
      admin: { kind: 'principals', principals: ['alice', 'bob'] },
      m4: { kind: 'principals', principals: ['alice', 'bob'] },
    };
    ok(await h.decideAs(c, c4.card_id, 'alice', 'approve', c4Content(d4.view, { role_map: rm })));
    const applied = (await events(c, S0_EVENT.card_applied)).at(-1);
    const m1 = applied.refs.m1_gate_instance_id as string;

    // the first M1 config gate of this project
    const gate = pdpResource.gate(c.project, m1, 'M1');
    expect(await allowed(plain, 'alice', 'gate.decide', gate)).toBe(false);
    expect(await allowed(withGrant, 'alice', 'gate.decide', gate)).toBe(true);
    expect(await allowed(withGrant, 'bob', 'gate.decide', gate)).toBe(false);
    // not another gate, not a made-up M1 id, not M4
    expect(
      await allowed(
        withGrant,
        'alice',
        'gate.decide',
        pdpResource.gate(c.project, '0199a1a1-0000-7000-8000-000000000001', 'M1'),
      ),
    ).toBe(false);
    expect(
      await allowed(withGrant, 'alice', 'gate.decide', pdpResource.gate(c.project, m1, 'M4')),
    ).toBe(false);
    expect(
      await allowed(withGrant, 'alice', 'gate.decide', pdpResource.gate(c.project, m1, 'M2')),
    ).toBe(false);
    // nothing else of the admin role comes with it: no kill, no kill release, no settings edit by the role
    for (const action of ['kill.request', 'kill.release'] as const) {
      expect(await allowed(withGrant, 'alice', action, pdpResource.project(c.project))).toBe(
        await allowed(plain, 'alice', action, pdpResource.project(c.project)),
      );
    }

    // Card 5 opens only after the revision is published, which ends the grant, so it cannot be
    // reached end to end; the same rule is shown on a card 5 opened on the record as the driver
    // would open it (and on an M4-labelled one that is not on the list).
    const opened = async (label: string) => {
      const id = newId();
      const w = await inCoreTx(s.deps, (j) =>
        j.emit(
          cardStream(id),
          CARD_EVENT.opened,
          CardOpenedPayload.parse({
            card_id: id,
            project_id: c.project,
            subject_kind: 's0_record',
            subject_id: c.s0,
            group: 'single',
            label,
            role: 'admin',
            targets: [{ target: 'step', step: '0.5', slot: 'admin' }],
            requester: 'alice',
            sla_due_at: s.clock.now().toISOString(),
            opened_by: 'system.test',
            key: `${c.s0}:${label}:9`,
          }),
          'system.test',
        ),
      );
      ok(w);
      return id;
    };
    const c5 = await opened('C5');
    expect(await decideCard(plain, 'alice', c.project, c5)).toBe(false);
    expect(await decideCard(withGrant, 'alice', c.project, c5)).toBe(true);
    expect(await decideCard(withGrant, 'bob', c.project, c5)).toBe(false);
    for (const label of ['SECR', 'C2', 'C3', 'BATCH']) {
      expect(await decideCard(withGrant, 'alice', c.project, await opened(label))).toBe(false);
    }
  });

  it('never the security card, and never a card of another record or another project', async () => {
    const c = await scenario({
      slots: 'none',
      bootstrap: true,
      level: 'light',
      census: { golden: 'b' },
      findings: 2,
    });
    expect(await c.drive()).toBe('card');
    await sync(c);
    const c1 = await actionable(c, 'C1');
    const secr = (await h.summaries(c)).filter((x) => x.card === 'SECR');
    expect(secr.length).toBeGreaterThan(0);
    for (const x of secr) {
      expect(await decideCard(withGrant, 'alice', c.project, x.card_id)).toBe(false);
    }
    // the right card on the wrong project
    expect(await decideCard(withGrant, 'alice', 'some-other-project', c1.card_id)).toBe(false);
    // another project's own first onboarding, by someone else: alice has no grant there
    const other = await scenario({ slots: 'none', bootstrap: true, requester: 'bob' });
    await other.drive();
    await sync(other);
    const o1 = await actionable(other, 'C1');
    expect(await decideCard(withGrant, 'bob', other.project, o1.card_id)).toBe(true);
    expect(await decideCard(withGrant, 'alice', other.project, o1.card_id)).toBe(false);
    expect(await decideCard(withGrant, 'bob', c.project, c1.card_id)).toBe(false);
  });

  it('a second onboarding of the same project does not inherit the grant', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await c.drive();
    await sync(c);
    const second = await scenario({
      slots: 'none',
      bootstrap: true,
      project: c.project,
      repo: 'acme/bpdp-second-repo',
      requester: 'carol',
    });
    await second.drive();
    await sync(second);
    const c1 = await actionable(second, 'C1');
    expect(await decideCard(withGrant, 'carol', second.project, c1.card_id)).toBe(false);
    expect(await decideCard(withGrant, 'alice', second.project, c1.card_id)).toBe(false);
  });

  it("is over when card 4's role map is published", async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await c.drive();
    await sync(c);
    const c1 = await actionable(c, 'C1');
    expect(await decideCard(withGrant, 'alice', c.project, c1.card_id)).toBe(true);
    setAdmins(s, c.project, ['bob']);
    await publishSettings(
      s,
      c.project,
      { role_map: settingsOf('x', { admin: ['bob'] }).role_map },
      'bob',
    );
    expect(await decideCard(withGrant, 'alice', c.project, c1.card_id)).toBe(false);
  });

  it('fails closed: a record that cannot be read leaves the base answer', async () => {
    const c = await scenario({ slots: 'none', bootstrap: true });
    await c.drive();
    await sync(c);
    const c1 = await actionable(c, 'C1');
    const broken = new Pdp({
      source: new StaticBundleSource(buildBundle()),
      entities: new BootstrapPdpEntities(new IdentityPdpEntities({ pool: ownPool }), {
        db: {
          query: () => Promise.reject(new Error('record down')),
        } as never,
      }),
      clock: s.clock,
    });
    expect(await decideCard(broken, 'alice', c.project, c1.card_id)).toBe(false);
  });
});
