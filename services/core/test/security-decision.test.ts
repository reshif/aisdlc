import { randomUUID } from 'node:crypto';
import {
  FakeDecisionVerifier,
  FakePrincipalDirectory,
  LedgerDecisionVerifier,
  createKnowledgeApp,
  migrateKnowledge,
  type JobRunner,
} from '@aisdlc/knowledge';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpKnowledge, type KnowledgePort } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness, type Scn } from './harness.js';

// Closing the finding-state bypass (PLAN M7.4b). Knowledge's `POST /v1/security/findings/:id/state`
// accepts a change only with a reference to a decided, ledgered security-card decision for exactly
// that finding and state, verified against the ledger in the record database. The card path (the
// card layer applying a decided card) still works end to end through the real knowledge app; a
// direct call without a valid reference is refused. Real Postgres, real ledger writer and Notary.

let s: CoreStack;
let app: FastifyInstance;
let strictApp: FastifyInstance;
let url: string;
let strictUrl: string;
let lazyApp: FastifyInstance;
let lazyUrl: string;
let keyLookups = 0;
let keyAvailable = false;
const TOKEN = 'core-at-knowledge-'.padEnd(32, 'x');
const principals = new FakePrincipalDirectory()
  .add({ principal_id: 'alice', kind: 'human', status: 'active' })
  .add({ principal_id: 'bob', kind: 'human', status: 'active' });

beforeAll(async () => {
  s = await startCoreStack();
  await migrateKnowledge(s.record.pool);
  const common = {
    pool: s.record.pool,
    auth: new ServiceAuth({ core: TOKEN }),
    callers: { core: ['census', 'security'] as ('census' | 'security')[] },
    // The job runner is not used by the routes under test.
    runner: {} as unknown as JobRunner,
    principals,
  };
  app = createKnowledgeApp({
    ...common,
    decisions: new LedgerDecisionVerifier({ notaryKey: s.id.keys.notary }),
  });
  url = await listen(app);
  // The same service with the wrong public key: a signature that does not verify is refused.
  strictApp = createKnowledgeApp({
    ...common,
    decisions: new LedgerDecisionVerifier({ notaryKey: s.id.keys.witness }),
  });
  strictUrl = await listen(strictApp);
  // The key is fetched on first use (knowledge makes no network call at start); while it cannot
  // be fetched the check is `unavailable`, never "unchecked".
  lazyApp = createKnowledgeApp({
    ...common,
    decisions: new LedgerDecisionVerifier({
      keySource: async () => {
        keyLookups += 1;
        return keyAvailable ? s.id.keys.notary : null;
      },
    }),
  });
  lazyUrl = await listen(lazyApp);
});
afterAll(async () => {
  await app?.close();
  await strictApp?.close();
  await lazyApp?.close();
  await s.stop();
});
const h = makeHarness(() => s, 'sd');
const { scenario, sync, decideAs, ok, throughC1 } = h;

const post = async (base: string, path: string, body: unknown) => {
  const r = await fetch(new URL(path, base), {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const setState = (id: string, body: unknown, base = url) =>
  post(base, `/v1/security/findings/${id}/state`, body);
const stateOf = async (id: string) =>
  (
    await s.record.pool.query<{ state: string; state_changed_by: string | null }>(
      'SELECT state, state_changed_by FROM security_findings.finding WHERE finding_id = $1',
      [id],
    )
  ).rows[0];

/** A finding in the real Security store (what a scan writes), for the repo of the scenario. */
async function addFinding(repo: string): Promise<string> {
  const id = randomUUID();
  await s.record.pool.query(
    `INSERT INTO security_findings.finding
       (finding_id, repo, rule_id, fingerprint, state, first_job_id, first_commit, detected_at)
     VALUES ($1, $2, 'generic-api-key', $3, 'open', $4, NULL, now())`,
    [id, repo, randomUUID().replaceAll('-', '').repeat(2), randomUUID()],
  );
  return id;
}

/** Census with a secret in history (B1), the real knowledge for the findings, the fake for the rest. */
async function withFindings(n: number): Promise<{ c: Scn; ids: string[] }> {
  const c = await scenario({ census: { golden: 'b' } });
  const ids: string[] = [];
  for (let i = 0; i < n; i++) ids.push(await addFinding(c.repo));
  const http = new HttpKnowledge({ baseUrl: url, token: TOKEN });
  const hybrid: KnowledgePort = {
    startCensus: (r) => c.knowledge.startCensus(r),
    job: (j) => c.knowledge.job(j),
    latestCensus: (r) => c.knowledge.latestCensus(r),
    census: (r) => c.knowledge.census(r),
    securitySummary: (r) => c.knowledge.securitySummary(r),
    openFindings: (r) => http.openFindings(r),
    setFindingState: (f, req) => http.setFindingState(f, req),
  };
  return { c: { ...c, deps: { ...c.deps, knowledge: hybrid } }, ids };
}

/** Decides the security card of `finding` as `who`; returns the card and its ledger entry. */
async function decideSecr(c: Scn, finding: string, state: string, who = 'alice') {
  await sync(c);
  const cards = (await h.summaries(c)).filter((x) => x.card === 'SECR' && x.actionable);
  const { readCardState } = await import('@aisdlc/decisions');
  for (const card of cards) {
    const st = await readCardState(s.record.pool, card.card_id);
    if (!st?.open.key?.endsWith(`:${finding}`)) continue;
    const r = await decideAs(c, card.card_id, who, 'approve', {
      state,
      reason: 'rotated in the console',
    });
    return { card, r, st };
  }
  throw new Error(`no security card for ${finding}`);
}
const refOf = (
  card: { card_id: string },
  r: { value: { decision: { entries: ReadonlyArray<{ entry_id: string }> } } },
) => ({
  card_id: card.card_id,
  ledger_entry_id: r.value.decision.entries[0]?.entry_id as string,
});

describe('the card is the only path to a finding state', () => {
  it('the card path works: a decided, ledgered security-card decision sets the state through the real knowledge app', async () => {
    const { c, ids } = await withFindings(1);
    expect(await c.drive()).toBe('card');
    const { card, r } = await decideSecr(c, ids[0] as string, 'rotated');
    expect(ok(r).value.applied).toBe('applied');
    expect(await stateOf(ids[0] as string)).toEqual({
      state: 'rotated',
      state_changed_by: 'alice',
    });
    // the ledger holds the decision it rested on
    const entry = await s.record.pool.query(
      `SELECT decision, actor, body FROM ledger.ledger_entry WHERE entry_id = $1`,
      [ok(r).value.decision.entries[0]?.entry_id],
    );
    expect(entry.rows[0]).toMatchObject({
      decision: 'approve',
      actor: 'alice',
      body: { card_id: card.card_id },
    });
  });

  it('a direct call is refused: no reference is invalid; a reference to nothing, to the wrong card, finding, state, person or kind of entry changes nothing', async () => {
    const { c, ids } = await withFindings(3);
    expect(await c.drive()).toBe('card');
    const [a, b, open] = ids as [string, string, string];
    // Two security cards decided, for A (rotated) and for B (false_positive); C stays open.
    // (C's card exists but is never decided, so no ledger entry is behind it.)
    const da = await decideSecr(c, a, 'rotated');
    const db = await decideSecr(c, b, 'false_positive');
    const refA = refOf(da.card, ok(da.r));
    const refB = refOf(db.card, ok(db.r));
    expect((await stateOf(a))?.state).toBe('rotated');
    expect((await stateOf(b))?.state).toBe('false_positive');

    const body = (state: string, ref: unknown, who = 'alice') => ({
      state,
      principal_id: who,
      reason: 'a direct call',
      ...(ref === undefined ? {} : { decision_ref: ref }),
    });
    // 1. no reference at all
    expect((await setState(open, body('rotated', undefined))).status).toBe(400);
    // 2. a reference to nothing: neither card nor entry exist
    const nothing = await setState(
      open,
      body('rotated', { card_id: randomUUID(), ledger_entry_id: randomUUID() }),
    );
    expect(nothing).toMatchObject({ status: 403, json: { error: { code: 'decision_refused' } } });
    expect(JSON.stringify(nothing.json)).toMatch(/not on the ledger/);
    // 3. a real decision, for ANOTHER finding (B's decision does not move C)
    const other = await setState(open, body('false_positive', refB));
    expect(JSON.stringify(other.json)).toMatch(/another finding/);
    // 4. the right finding but ANOTHER state (B was decided false_positive, not rotated)
    const wrongState = await setState(b, body('rotated', refB));
    expect(wrongState.status).toBe(403);
    expect(JSON.stringify(wrongState.json)).toMatch(/another finding or another state|not the one/);
    // 5. the right decision attributed to someone who did not decide it
    const wrongWho = await setState(open, body('rotated', refA, 'bob'));
    expect(wrongWho.status).toBe(403);
    // 6. a card that is not a security card: card 1's decision (a real approved step entry)
    const c1 = await throughC1(c);
    const notSecr = await setState(
      open,
      body('rotated', {
        card_id: c1.card.card_id,
        ledger_entry_id: c1.r.value.decision.entries[0]?.entry_id,
      }),
    );
    expect(notSecr.status).toBe(403);
    expect(JSON.stringify(notSecr.json)).toMatch(/not a security card/);
    // 7. a ledger entry that is not a card step decision: the M1/M4-style gate decision type,
    //    here the bootstrap grant entry (a real, signed ledger entry about this record)
    const grant = await s.record.pool.query<{ entry_id: string }>(
      `SELECT entry_id FROM ledger.ledger_entry WHERE entry_type = 's0.bootstrap_grant' AND subject_id = $1`,
      [c.s0],
    );
    const notStep = await setState(
      open,
      body('rotated', { card_id: da.card.card_id, ledger_entry_id: grant.rows[0]?.entry_id }),
    );
    expect(notStep.status).toBe(403);
    // 8. the entry of A's card with B's card id
    const mixed = await setState(
      open,
      body('rotated', { card_id: db.card.card_id, ledger_entry_id: refA.ledger_entry_id }),
    );
    expect(mixed.status).toBe(403);
    // C is still open, nothing was written by any of them
    expect(await stateOf(open)).toEqual({ state: 'open', state_changed_by: null });
    expect(
      (
        await s.record.pool.query(
          `SELECT 1 FROM record.record_event WHERE type = 'finding.state_changed' AND body ->> 'finding_id' = $1`,
          [open],
        )
      ).rowCount,
    ).toBe(0);
  });

  it('a signature that does not verify is refused even when the entry, card and payload are right', async () => {
    const { c, ids } = await withFindings(1);
    expect(await c.drive()).toBe('card');
    const d = await decideSecr(c, ids[0] as string, 'rotated');
    const ref = refOf(d.card, ok(d.r));
    // it is already rotated by the card path; use a second finding bound to the same record
    const second = await addFinding(c.repo);
    const wrong = await setState(
      second,
      { state: 'rotated', principal_id: 'alice', reason: 'x', decision_ref: ref },
      strictUrl,
    );
    expect(wrong.status).toBe(403);
    // and it never matches the second finding anyway
    expect(
      JSON.stringify(
        (
          await setState(second, {
            state: 'rotated',
            principal_id: 'alice',
            reason: 'x',
            decision_ref: ref,
          })
        ).json,
      ),
    ).toMatch(/another finding/);
    expect((await stateOf(second))?.state).toBe('open');
    // the strict (wrong-key) service refuses the very reference that the right one accepted
    const again = await setState(
      ids[0] as string,
      { state: 'rotated', principal_id: 'alice', reason: 'x', decision_ref: ref },
      strictUrl,
    );
    expect(again.status).toBe(403);
    expect(JSON.stringify(again.json)).toMatch(/does not verify/);
  });

  it('the Notary key is fetched on first use; until it can be, a state change is unavailable, not unchecked', async () => {
    const { c, ids } = await withFindings(1);
    expect(await c.drive()).toBe('card');
    const d = await decideSecr(c, ids[0] as string, 'rotated');
    const ref = refOf(d.card, ok(d.r));
    const body = { state: 'rotated', principal_id: 'alice', reason: 'x', decision_ref: ref };
    expect(keyLookups).toBe(0);
    expect((await setState(ids[0] as string, body, lazyUrl)).status).toBe(503);
    expect(keyLookups).toBe(1);
    keyAvailable = true;
    // the finding is already rotated by the card path: a verified reference reaches the state machine
    expect((await setState(ids[0] as string, body, lazyUrl)).status).toBe(409);
    expect((await setState(ids[0] as string, body, lazyUrl)).status).toBe(409);
    expect(keyLookups).toBe(2); // fetched once more, then cached
  });

  it('a repeat of the card path is harmless: the finding is in the state already', async () => {
    const { c, ids } = await withFindings(1);
    expect(await c.drive()).toBe('card');
    const d = await decideSecr(c, ids[0] as string, 'accepted_test_fixture');
    const ref = refOf(d.card, ok(d.r));
    const again = await setState(ids[0] as string, {
      state: 'accepted_test_fixture',
      principal_id: 'alice',
      reason: 'again',
      decision_ref: ref,
    });
    expect(again.status).toBe(409); // not a new edge; core's client reads it as "already in that state"
    expect((await stateOf(ids[0] as string))?.state).toBe('accepted_test_fixture');
    void FakeDecisionVerifier;
  });
});
