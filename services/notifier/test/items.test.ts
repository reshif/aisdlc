import { currentCatalogueRef } from '@aisdlc/catalogue';
import {
  BREAKER_EVENT,
  CONTROL_EVENT,
  DEFAULT_GATING_PROFILE,
  GATERELAY_EVENT,
  ITEM_EVENT,
  OPS_ALERT_EVENT,
  breakerStream,
  controlStream,
  gateRelayStream,
  itemStream,
  opsAlertStream,
  type ItemCommand,
  type NotificationKind,
  type StepId,
} from '@aisdlc/contracts';
import { deterministicId, newId, sha256Hex } from '@aisdlc/kernel';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import { addBusinessDays } from '@aisdlc/decisions';
import { clarifyState, foldItem, type ItemState } from '@aisdlc/work';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deliverOnce } from '../src/deliver.js';
import { NOTIFIER_CALENDAR } from '../src/items.js';
import { raiseOnce } from '../src/raise.js';
import { listNotifications } from '../src/store.js';
import { PROJECT, startWorld, type World } from './fixture.js';

// RC-HAI-2, RC-NOT-1, RC-NOT-3 on a real Postgres: items driven through the work engine's own interpreter by
// appending the events core would append, and the notifier, as its least-privilege role, folding them the same way
// and telling the requester what the factory needs from them (questions with the rounds left and the PARK date,
// PARK, Ready, G6, a handoff) and the owners what happened (done, ended), plus a halt, the breaker, a failed release
// and a factory alert for the factory admins.

let w: World;
beforeAll(async () => {
  w = await startWorld();
  expect((await raiseOnce(w.raiseDeps())).read).toBe(0);
}, 120_000);
afterAll(async () => w?.stop());

const REQUESTER = 'dana';
const drain = async () => {
  let total = 0;
  for (;;) {
    const r = await raiseOnce(w.raiseDeps());
    total += r.raised;
    if (r.read === 0) return total;
  }
};
const kindsOf = async (p: string): Promise<NotificationKind[]> =>
  (await listNotifications(w.rolePool, p)).map((n) => n.content.kind);

async function stateOf(item: string): Promise<ItemState> {
  const r = await w.db.pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [itemStream(item)],
  );
  const f = foldItem(r.rows.map(toRecordEvent));
  if (f === null) throw new Error('no item');
  return f.state;
}

async function createItem(name: string): Promise<string> {
  const item = deterministicId(`notifier-items:${name}`);
  await w.append(itemStream(item), ITEM_EVENT.created, {
    item_id: item,
    project_id: PROJECT,
    request_id: deterministicId(`notifier-items:${name}:req`),
    repo: 'acme/app',
    requester: REQUESTER,
    channel: 'N1',
    catalogue_ref: currentCatalogueRef(),
    gating_profile: { ...DEFAULT_GATING_PROFILE, project_deploys: false },
    tier: 'T1',
    prr: { version: 1, record_hash: sha256Hex('prr') },
    proposed_lane: 'L4',
    intake: {
      text_sha256: sha256Hex(`text:${name}`),
      injection: null,
      dedupe_links: [],
      conflict_candidates: [],
      route: 'normal',
      eligibility_reason: 'eligible',
    },
    origin: null,
  });
  await w.append(itemStream(item), ITEM_EVENT.submitted, {});
  return item;
}

type Script = (step: StepId, c: Extract<ItemCommand, { type: 'run_stage' }>) => object | null;

/** Answers the item's commands the way the deterministic fakes do, until `stop` says so or nothing is left. */
async function drive(
  item: string,
  stop: (s: ItemState) => boolean,
  o: { script?: Script; pendingGates?: readonly string[] } = {},
): Promise<ItemState> {
  const put = (type: string, body: object) => w.append(itemStream(item), type, body);
  for (let i = 0; i < 400; i++) {
    const s = await stateOf(item);
    if (stop(s)) return s;
    const c = s.outstanding[0];
    if (c) {
      switch (c.type) {
        case 'run_stage': {
          const custom = o.script?.(c.step, c);
          if (custom) {
            await put((custom as { type: string }).type, (custom as { body: object }).body);
            break;
          }
          await put(ITEM_EVENT.stage_completed, {
            command_key: c.key,
            step: c.step,
            output_hash: sha256Hex(`out:${c.key}`),
            ...(c.step === '1.3' ? { lane: c.lane } : {}),
            ...(c.step === '6.0' ? { lease_epoch: 1 } : {}),
          });
          break;
        }
        case 'check_eligibility':
          await put(ITEM_EVENT.eligibility_checked, {
            command_key: c.key,
            lane: c.lane,
            route: 'normal',
            eligible: true,
            reason: 'eligible',
            prr_version: 1,
          });
          break;
        case 'open_gates':
          await put(ITEM_EVENT.gates_opened, {
            command_key: c.key,
            gates: c.gates.map((g) => ({
              gate: g,
              gate_instance_id: deterministicId(`${item}:${c.key}:${g}`),
            })),
            card_ids: [deterministicId(`card:${c.key}`)],
            subject_hash: c.subject_hash,
          });
          break;
        case 'spawn_item':
          throw new Error('not in these tests');
        default:
          await put(ITEM_EVENT.command_done, { command_key: c.key });
      }
      continue;
    }
    const g = s.gates.find(
      (x) => x.status === 'pending' && x.consumed !== true && !o.pendingGates?.includes(x.gate),
    );
    if (g) {
      await put(ITEM_EVENT.gate_decided, {
        gate_instance_id: g.gate_instance_id,
        gate: g.gate,
        outcome: 'approve',
        ledger_entry_id: newId(),
      });
      continue;
    }
    if (s.waiting?.kind === 'human') {
      const what = s.waiting.what;
      if (what === 'ready') await put(ITEM_EVENT.ready_decided, { by: REQUESTER });
      else if (what === 'schedule') await put(ITEM_EVENT.scheduled, { by: REQUESTER });
      else if (what === 'merge') await put(ITEM_EVENT.merge_observed, { merged_sha: 'abcdef1234' });
      else await put(ITEM_EVENT.human_work_done, { by: REQUESTER });
      continue;
    }
    return s;
  }
  throw new Error('the item did not settle');
}

const questions =
  (round: number): Script =>
  (step, c) =>
    step === '1.5'
      ? {
          type: ITEM_EVENT.questions_raised,
          body: {
            command_key: c.key,
            step,
            round,
            questions: [
              { question_id: `q-${round}-${c.key}`, text: 'Which env?', material: 'blocking' },
            ],
          },
        }
      : null;

describe('the requester is told what the factory needs from them (RC-HAI-2)', () => {
  it('questions with the rounds left and the PARK date, then the PARK with the ABANDON date, then the end', async () => {
    const item = await createItem('questions');
    const s = await drive(item, (x) => x.waiting?.kind === 'questions', { script: questions(1) });
    expect(s.rounds).toBe(1);
    // the requester, nobody else, and nothing of the question's text
    expect(await drain()).toBe(1);
    const [q] = await listNotifications(w.rolePool, REQUESTER);
    expect(q?.reason).toBe('requester');
    expect(q?.content).toMatchObject({
      kind: 'questions_waiting',
      project_id: PROJECT,
      item_id: item,
      round: 1,
      rounds_left: 1,
      link_path: `/items/${item}`,
    });
    // B1: 5 business days of silence park it; the clock started when the questions were raised (a Thursday)
    expect(q?.content.due_at).toBe('2026-11-19T10:00:00.000Z');
    await deliverOnce(w.deliverDeps());
    const slack = w.slack.received.at(-1)?.text ?? '';
    expect(slack).toContain('1 more round of questions may follow');
    expect(slack).not.toContain('Which env?');

    w.clock.advance(7 * 86_400_000); // to the PARK date
    await w.append(itemStream(item), ITEM_EVENT.timer_fired, {
      timer: 'clarify_silence',
      since: (await stateOf(item)).clarify?.since,
      due_at: '2026-11-19T10:00:00.000Z',
      frozen_ms: 0,
    });
    expect((await stateOf(item)).waiting?.kind).toBe('parked');
    expect(await drain()).toBe(1);
    const [p] = await listNotifications(w.rolePool, REQUESTER);
    expect(p?.content).toMatchObject({ kind: 'item_parked', item_id: item });
    // parked on Thursday the 19th: abandoned 5 business days later
    expect(p?.content.due_at).toBe('2026-11-26T10:00:00.000Z');

    w.clock.advance(7 * 86_400_000);
    await w.append(itemStream(item), ITEM_EVENT.timer_fired, {
      timer: 'park',
      since: (await stateOf(item)).park?.since,
      due_at: '2026-11-26T10:00:00.000Z',
      frozen_ms: 0,
    });
    expect((await stateOf(item)).terminal).toBe('Abandoned');
    // the requester and the project's admin
    expect(await drain()).toBe(2);
    const [e] = await listNotifications(w.rolePool, 'root');
    expect(e?.content).toMatchObject({ kind: 'item_ended', outcome: 'Abandoned', item_id: item });
    expect(e?.reason).toBe('project_admin');
    expect((await listNotifications(w.rolePool, REQUESTER))[0]?.content.kind).toBe('item_ended');
    await deliverOnce(w.deliverDeps());
  });

  it('B1: the second round of questions is told again, as the last round, with the PARK date the item page says (P2-16)', async () => {
    const item = await createItem('questions-b1');
    let asked = 0;
    const ask: Script = (step, c) => (step === '1.5' ? questions(++asked)(step, c) : null);
    await drive(item, (x) => x.waiting?.kind === 'questions', { script: ask });
    expect(await drain()).toBe(1);
    const [q1] = await listNotifications(w.rolePool, REQUESTER);
    expect(q1?.content).toMatchObject({
      kind: 'questions_waiting',
      item_id: item,
      round: 1,
      rounds_left: 1,
    });
    // the requester answers; 1.5 asks again (B1's second round)
    w.clock.advance(86_400_000);
    for (const q of (await stateOf(item)).questions.filter((x) => x.state === 'open')) {
      await w.append(itemStream(item), ITEM_EVENT.question_answered, {
        question_id: q.question_id,
        answer: {
          text: 'staging',
          taint: 'untrusted',
          origin: 'answer',
          provenance: {
            channel: 'N1',
            source: 'portal_ask',
            received_at: w.clock.now().toISOString(),
            submitted_by: REQUESTER,
            raw_sha256: 'a'.repeat(64),
            normalised_sha256: 'b'.repeat(64),
          },
          flags: [],
        },
        by: REQUESTER,
      });
    }
    const s = await drive(item, (x) => x.waiting?.kind === 'questions' && x.rounds === 2, {
      script: ask,
    });
    expect(await drain()).toBe(1);
    const [q2] = await listNotifications(w.rolePool, REQUESTER);
    expect(q2?.content).toMatchObject({
      kind: 'questions_waiting',
      item_id: item,
      round: 2,
      rounds_left: 0,
    });
    // the same round, limit and date as the item page's (`ItemView.clarify`, one function: `clarifyState`)
    const page = clarifyState(s, (from, bd) => addBusinessDays(NOTIFIER_CALENDAR, from, bd));
    expect(page).toMatchObject({ round: 2, rounds_max: 2, then: 'parks' });
    expect(q2?.content.due_at).toBe(page?.deadline);
    expect(q2?.content.due_at).not.toBe(q1?.content.due_at);
    await deliverOnce(w.deliverDeps());
    const slack = w.slack.received.at(-1)?.text ?? '';
    expect(slack).toContain('This is round 2 of 2.');
    expect(slack).toContain('This is the last round');
  });

  it('Ready, then G6 acceptance, then done for the requester and the project admin', async () => {
    const item = await createItem('accept');
    await drive(item, (x) => x.waiting?.kind === 'human' && x.waiting.what === 'ready');
    expect(await drain()).toBe(1);
    expect((await listNotifications(w.rolePool, REQUESTER))[0]?.content).toMatchObject({
      kind: 'ready_waiting',
      item_id: item,
    });
    const s = await drive(
      item,
      (x) => x.waiting?.kind === 'gates' && x.waiting.gates.includes('G6'),
      { pendingGates: ['G6'] },
    );
    expect(s.terminal).toBeNull();
    await drain();
    const kinds = await kindsOf(REQUESTER);
    expect(kinds).toContain('acceptance_waiting');
    const done = await drive(item, (x) => x.terminal !== null);
    expect(done.terminal).toBe('Done');
    await drain();
    expect((await listNotifications(w.rolePool, REQUESTER))[0]?.content).toMatchObject({
      kind: 'item_done',
      outcome: 'Done',
    });
    expect((await listNotifications(w.rolePool, 'root'))[0]?.content).toMatchObject({
      kind: 'item_done',
      item_id: item,
    });
    // nothing raised twice when the record is read again
    await w.db.pool.query('UPDATE notifier.source_cursor SET last_global_seq = 0');
    expect(await drain()).toBe(0);
  });

  it('a handoff (D1 on ET1) is told to the requester', async () => {
    const item = await createItem('handoff');
    const s = await drive(item, (x) => x.handoffs.some((h) => h.status === 'open'), {
      script: (step, c) =>
        step === '6.1'
          ? {
              type: ITEM_EVENT.trigger_fired,
              body: { command_key: c.key, step, trigger: 'ET1', reason_code: 'budget_exhausted' },
            }
          : null,
    });
    expect(s.handoffs.at(-1)?.code).toBe('D1');
    await drain();
    const kinds = await kindsOf(REQUESTER);
    expect(kinds[0]).toBe('handoff');
  });
});

describe('owners and factory admins are told what happened (RC-NOT-1, RC-NOT-3)', () => {
  it('a halt, the breaker, a failed release and rollback, and a factory alert; a hold is not a halt', async () => {
    const halt = newId();
    const control = (kind: string, id: string, scope: object) => ({
      control_id: id,
      kind,
      scope,
      origin_kind: 'operator',
      state: 'active',
      expires_at: null,
      params: {},
      created_by_action: newId(),
      created_at: '2026-11-12T10:00:00.000Z',
      lifted_at: null,
    });
    await w.append(
      controlStream(halt),
      CONTROL_EVENT.control_applied,
      control('halt', halt, { kind: 'project', ref: PROJECT }),
    );
    const hold = newId();
    await w.append(
      controlStream(hold),
      CONTROL_EVENT.control_applied,
      control('hold', hold, { kind: 'project', ref: PROJECT }),
    );
    await w.append(breakerStream(PROJECT, 'L3'), BREAKER_EVENT.tripped, {
      project_id: PROJECT,
      lane: 'L3',
      count: 3,
      threshold: 3,
    });
    const item = await createItem('release');
    await w.append(gateRelayStream(item), GATERELAY_EVENT.release_refused, {
      item_id: item,
      project_id: PROJECT,
      gate_instance_id: newId(),
      reason: 'unbound',
      detail: 'none',
      refused_at: '2026-11-12T10:00:00.000Z',
    });
    await w.append(gateRelayStream(item), GATERELAY_EVENT.deploy_unhealthy, {
      item_id: item,
      marker_id: newId(),
      deployment_id: 7,
      state: 'failure',
      observed_at: '2026-11-12T10:00:00.000Z',
      rollback_marker_id: newId(),
    });
    await w.append(opsAlertStream('service.notary'), OPS_ALERT_EVENT.raised, {
      alert_id: newId(),
      subject: 'service.notary',
      kind: 'service_down',
      detail_code: 'unreachable',
      since: '2026-11-12T09:58:00.000Z',
    });
    await drain();
    const root = await listNotifications(w.rolePool, 'root');
    const byKind = (k: string) => root.filter((n) => n.content.kind === k);
    expect(byKind('control_halt')).toHaveLength(1);
    expect(byKind('breaker_tripped')[0]?.content.lane).toBe('L3');
    expect(
      byKind('release_failed')
        .map((n) => n.content.release)
        .sort(),
    ).toEqual(['refused', 'rolled_back']);
    // the alert is the fleet's: the factory admin (fran), not the project admin
    expect(byKind('factory_alert')).toHaveLength(0);
    const [a] = await listNotifications(w.rolePool, 'fran');
    expect(a?.content).toMatchObject({
      kind: 'factory_alert',
      alert_kind: 'service_down',
      alert_subject: 'service.notary',
      link_path: '/health',
    });
    expect(a?.reason).toBe('factory_admin');
    await deliverOnce(w.deliverDeps());
    expect(w.slack.received.map((r) => r.text).join('\n')).toContain(
      'service down on service.notary',
    );
  });
});
