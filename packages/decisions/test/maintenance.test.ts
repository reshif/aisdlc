import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideCard, openCard, prepare, sweepExpired, sweepSla } from '../src/index.js';
import { castVote } from '../src/vote.js';
import {
  decideAs,
  hash,
  ledgerCount,
  open,
  pr,
  setupProject,
  startStack,
  uuid,
  type Stack,
} from './helpers.js';

// MM-2 maintenance (PLAN M9.3, FL `MM`): timers frozen, decisions disabled, drafts kept. One probe on
// the kernel's deps: every decide path refuses, and the gate-expiry and SLA sweeps do nothing, until
// the flag is off. A probe that cannot answer counts as "on".

const DAY = 86_400_000;
let s: Stack;
let on = false;
let broken = false;
beforeAll(async () => {
  s = await startStack();
  setupProject(s, 'mm', {
    tier: 'T1',
    slots: { g4: ['ann', 'bob'], admin: ['root'], intent: ['ann'] },
  });
});
afterAll(async () => {
  await s.stop();
});
const mm = () => ({
  ...s.deps,
  maintenance: () => {
    if (broken) throw new Error('config unreadable');
    return on;
  },
});

describe('MM-2: decisions disabled, timers frozen, drafts kept', () => {
  it('refuses every decide path while on; what was opened and prepared is kept and decides after', async () => {
    const g = await open(s, 'mm', 'G4');
    // a draft: a prepared decision, taken before the maintenance
    const prepared = await prepare(mm(), {
      gate_instance_id: g.gate_instance_id,
      principal: pr('ann'),
    });
    expect(prepared.ok).toBe(true);
    on = true;
    const before = await ledgerCount(s);
    // the PreparedDecision path
    const viaNonce = await decideAs(s, g.gate_instance_id, 'ann', 'approve', { deps: mm() });
    expect(!viaNonce.ok && viaNonce.error.code).toBe('maintenance');
    // the direct vote path
    const vote = await castVote(mm(), {
      gate_instance_id: g.gate_instance_id,
      voter: pr('ann'),
      decision: 'approve',
      evidence: {
        evidence_hash: hash('x'),
        evidence_viewed_at: s.clock.now().toISOString(),
        nonce_sha256: hash('n'),
        step_up: null,
      },
    } as never);
    expect(!vote.ok && vote.error.code).toBe('maintenance');
    // the card path
    const card = await openCard(s.deps, {
      project_id: 'mm' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [{ gate_id: 'G4', subject_hash: hash(`c-${Math.random()}`) }],
      requester: pr('zed'),
    });
    expect(card.ok).toBe(true);
    const viaCard = await decideCard(mm(), {
      card_id: (card.ok ? card.value.card_id : '') as never,
      votes: [],
    } as never);
    expect(!viaCard.ok && viaCard.error.code).toBe('maintenance');
    expect(await ledgerCount(s)).toBe(before);
    // opening and preparing (drafts) still work under maintenance
    const draft = await prepare(mm(), {
      gate_instance_id: g.gate_instance_id,
      principal: pr('bob'),
    });
    expect(draft.ok).toBe(true);
    // maintenance over: the same gate decides
    on = false;
    const after = await decideAs(s, g.gate_instance_id, 'ann', 'approve', { deps: mm() });
    expect(after.ok).toBe(true);
  });

  it('freezes the gate expiry sweep and the B21 SLA sweep, and they run when it ends', async () => {
    const at = new Date(s.clock.nowMs() + 60_000).toISOString();
    const g = await open(s, 'mm', 'G4', { facts: { expires_at: at } });
    const card = await openCard(s.deps, {
      project_id: 'mm' as never,
      subject_kind: 'item',
      subject_id: uuid(),
      gates: [{ gate_id: 'G4', subject_hash: hash(`s-${Math.random()}`) }],
      requester: pr('zed'),
    });
    expect(card.ok).toBe(true);
    s.clock.advance(5 * DAY);
    on = true;
    const e = await sweepExpired(mm());
    expect(e.ok && e.value).toEqual({ expired: [], skipped: [], failed: [] });
    const sla = await sweepSla(mm());
    expect(sla.ok && sla.value).toEqual({ escalated: [], skipped: [], failed: [] });
    on = false;
    const e2 = await sweepExpired(mm());
    expect(e2.ok && e2.value.expired).toContain(g.gate_instance_id);
    const sla2 = await sweepSla(mm());
    expect(sla2.ok && sla2.value.escalated.length).toBeGreaterThan(0);
  });

  it('a probe that cannot answer is maintenance: unknown means unmet', async () => {
    const g = await open(s, 'mm', 'G4');
    broken = true;
    const r = await decideAs(s, g.gate_instance_id, 'ann', 'approve', { deps: mm() });
    expect(!r.ok && r.error.code).toBe('maintenance');
    const e = await sweepExpired(mm());
    expect(e.ok && e.value.expired).toEqual([]);
    broken = false;
  });
});
