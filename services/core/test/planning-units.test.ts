import { SAMPLE_OUTPUTS } from '@aisdlc/agents';
import { PLANNING_EVENT, planningStream, type StageRequest } from '@aisdlc/contracts';
import { canonicalJson, deterministicId, sha256Hex } from '@aisdlc/kernel';
import { FakeKnowledgeSearch } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CensusGrounding,
  FakeKnowledge,
  HttpKnowledgeSearch,
  PLANNING_STEPS,
  STEP_SPECS,
  artefactByHash,
  latestArtefact,
  listArtefacts,
  outcomeFor,
  recordProposal,
  renderArtefact,
  shallowerLane,
  storeArtefact,
  ungrounded,
  validateOracles,
  validateSpecDelta,
} from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { OUTPUTS } from './planning.js';
import { catalogueFor, currentCatalogueRef } from '@aisdlc/catalogue';

// The pure and store halves of the S2/S3 planning port (PLAN M12.1, M12.2).

describe('3.3 validator (code, not an agent)', () => {
  const affected = { requirements: [{ requirement_id: 'REQ-12' }, { requirement_id: 'REQ-13' }] };
  const delta = (entries: Array<Record<string, unknown>>) => ({
    kind: 'spec_delta',
    delta: entries,
    assumptions: [],
  });
  const e = (requirement_id: string, change = 'modified', text = 'text') => ({
    requirement_id,
    change,
    text,
  });
  const codes = (f: Array<{ code: string }>) => f.map((x) => x.code);

  it('a well-formed delta over located requirements has no findings', () => {
    expect(
      validateSpecDelta(delta([e('REQ-12'), e('REQ-14', 'added', 'New; see REQ-12.')]), affected),
    ).toEqual([]);
    expect(
      validateSpecDelta(OUTPUTS['3.2'], { requirements: [{ requirement_id: 'REQ-12' }] }),
    ).toEqual([]);
  });

  it('every requirement has an id, and it is an id', () => {
    expect(codes(validateSpecDelta(delta([e('   ')]), affected))).toEqual(['missing_id']);
    expect(codes(validateSpecDelta(delta([e('')]), affected))).toEqual(
      expect.arrayContaining(['schema', 'missing_id']),
    );
    expect(codes(validateSpecDelta(delta([e('12 ; drop')]), affected))).toContain('bad_id');
  });

  it('one id, one entry; an added requirement cannot take an existing id', () => {
    expect(codes(validateSpecDelta(delta([e('REQ-12'), e('REQ-12')]), affected))).toContain(
      'duplicate_id',
    );
    expect(codes(validateSpecDelta(delta([e('REQ-13', 'added')]), affected))).toContain(
      'id_collision',
    );
  });

  it('no orphan references: a modified or removed requirement must have been located; text may not point at nothing', () => {
    expect(codes(validateSpecDelta(delta([e('REQ-99', 'modified')]), affected))).toEqual([
      'orphan_requirement',
    ]);
    expect(codes(validateSpecDelta(delta([e('REQ-99', 'removed')]), affected))).toEqual([
      'orphan_requirement',
    ]);
    expect(
      codes(validateSpecDelta(delta([e('REQ-12', 'modified', 'Builds on REQ-77.')]), affected)),
    ).toEqual(['dangling_reference']);
    // a number with another prefix, an ISO standard and a version are not references
    expect(
      validateSpecDelta(
        delta([e('REQ-12', 'modified', 'Per ISO-8601 and UTF-8, v2.0, TLS-1.3.')]),
        affected,
      ),
    ).toEqual([]);
    // without a located list there is nothing to be an orphan of (the references still count)
    expect(validateSpecDelta(delta([e('REQ-99', 'modified')]), null)).toEqual([]);
  });

  it('a delta that is not a spec_delta is a schema finding, with the field named', () => {
    const f = validateSpecDelta({ kind: 'spec_delta', delta: [], lane: 'L0' }, affected);
    expect(f.map((x) => x.path)).toEqual(expect.arrayContaining(['delta', 'lane']));
  });

  it('every oracle spec maps to a requirement of the delta (a removed one has nothing to test)', () => {
    const d = delta([e('REQ-12'), e('REQ-13', 'removed')]);
    const o = (...ids: string[]) => ({
      kind: 'oracle_specs',
      oracles: ids.map((id, i) => ({ oracle_id: `o${i}`, requirement_id: id })),
    });
    expect(validateOracles(o('REQ-12'), d)).toEqual([]);
    expect(codes(validateOracles(o('REQ-404'), d))).toEqual(['orphan_oracle']);
    expect(codes(validateOracles(o('REQ-13'), d))).toEqual(['orphan_oracle']);
    expect(
      codes(
        validateOracles(
          {
            oracles: [
              { oracle_id: 'x', requirement_id: 'REQ-12' },
              { oracle_id: 'x', requirement_id: 'REQ-12' },
            ],
          },
          d,
        ),
      ),
    ).toEqual(['duplicate_oracle']);
  });
});

describe('rendering for humans', () => {
  it('renders every artefact type of S2 and S3 as markdown, deterministically, with the text on one line where it is a label', () => {
    const rendered = {
      context_brief: OUTPUTS['2.1'],
      reverse_engineering: OUTPUTS['2.1b'],
      impact: OUTPUTS['2.2'],
      decision_brief: OUTPUTS['2.3'],
      initiative: OUTPUTS['2.4'],
      affected_requirements: OUTPUTS['3.1'],
      spec_delta: OUTPUTS['3.2'],
      oracle_specs: OUTPUTS['3.4'],
      spec_review: OUTPUTS['3.5'],
    } as const;
    for (const [type, content] of Object.entries(rendered)) {
      const md = renderArtefact(type as never, content);
      expect(md, type).toBe(renderArtefact(type as never, structuredClone(content)));
      expect(md.startsWith('# '), type).toBe(true);
    }
    expect(renderArtefact('spec_delta', OUTPUTS['3.2'])).toBe(
      '# Spec delta\n\n## REQ-12 (modified)\n\nThe audit log can be exported as CSV.\n\n### Assumptions\n- (plan) CSV is enough\n',
    );
    expect(renderArtefact('decision_brief', OUTPUTS['2.3'])).toContain(
      '## Option 1: Extend the log (recommended)',
    );
    // a heading cannot be forged from a value
    expect(
      renderArtefact('affected_requirements', {
        requirements: [{ requirement_id: 'A\n# Forged', path: 'p', reason: 'r' }],
      }),
    ).not.toContain('\n# Forged');
    expect(
      renderArtefact('spec_review', {
        verdict: 'findings',
        findings: [{ severity: 'high', code: 'x', location: { path: 'a', line: 3 }, message: 'm' }],
      }),
    ).toContain('- (high) [x] `a:3` m');
    expect(renderArtefact('impact', 'not an object')).toContain('```json');
  });
});

describe('what a step answers', () => {
  const ctx = { lane: 'L4', shallower: 'L3' } as const;
  it('2.1 ambiguity is B2; 2.3 smaller is R2 toward the next rung down; 3.3 and 3.5 findings are B3; otherwise completed with the hash', () => {
    const sha = 'c'.repeat(64);
    expect(outcomeFor('2.1', { ambiguity: ['x'] }, sha, ctx)).toMatchObject({
      outcome: 'rework',
      edge: 'B2',
    });
    expect(outcomeFor('2.1', { ambiguity: [] }, sha, ctx)).toMatchObject({
      outcome: 'completed',
      output_hash: sha,
    });
    expect(outcomeFor('2.3', { sizing: 'smaller' }, sha, ctx)).toMatchObject({
      outcome: 'relane',
      edge: 'R2',
      to_lane: 'L3',
      trigger: 'smaller_than_lane',
    });
    expect(
      outcomeFor('2.3', { sizing: 'smaller' }, sha, { lane: 'L0', shallower: null }),
    ).toMatchObject({ outcome: 'completed' });
    expect(outcomeFor('2.3', { sizing: 'matches' }, sha, ctx)).toMatchObject({
      outcome: 'completed',
    });
    expect(outcomeFor('3.3', { verdict: 'findings' }, sha, ctx)).toMatchObject({
      outcome: 'rework',
      edge: 'B3',
    });
    expect(outcomeFor('3.5', { verdict: 'findings' }, sha, ctx)).toMatchObject({
      outcome: 'rework',
      edge: 'B3',
    });
    const done = outcomeFor(
      '3.2',
      { assumptions: [{ kind: 'plan', text: 'CSV is enough' }] },
      sha,
      ctx,
    );
    expect(done).toMatchObject({
      outcome: 'completed',
      assumptions: [{ kind: 'plan', text_hash: sha256Hex('CSV is enough') }],
    });
  });

  it('R2 goes to a lane with less planning, and nowhere from the bottom of the ladder', () => {
    const cat = catalogueFor(currentCatalogueRef());
    if (!cat.ok) throw new Error('no catalogue');
    const on = {
      gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
      schedule: 'auto',
      tier_floor_applied: true,
      project_deploys: true,
    } as never;
    expect(shallowerLane(cat.value, on, 'T1', 'L4')).toBe('L3');
    expect(shallowerLane(cat.value, on, 'T1', 'L0')).toBeNull();
    expect(shallowerLane(cat.value, on, 'T1', 'L8')).toBeNull();
  });

  it("every planning step has a spec whose artefact is the contracts' one, and the expected-kind check says what is wrong", () => {
    expect(PLANNING_STEPS).toHaveLength(10);
    expect(Object.values(STEP_SPECS).filter((x) => !x.agent)).toHaveLength(1);
    const sampleA3 = (SAMPLE_OUTPUTS.A3 ?? [])[0] as Record<string, unknown>;
    expect(STEP_SPECS['2.1'].expects(sampleA3)).toBe(true);
    expect(STEP_SPECS['2.2'].expects(sampleA3)).toBe(false);
  });

  it('grounding: only the merged head may be cited', () => {
    const m = 'a'.repeat(40);
    expect(
      ungrounded(
        { citations: [{ path: 'p', commit_sha: m }], claims: [{ evidence: [{ commit_sha: m }] }] },
        m,
      ),
    ).toEqual([]);
    const bad = ungrounded(
      { claims: [{ evidence: [{ path: 'p', commit_sha: 'b'.repeat(40) }] }] },
      m,
    );
    expect(bad).toEqual([
      {
        path: 'claims[0].evidence[0].commit_sha',
        code: 'not_grounded',
        message: expect.any(String),
      },
    ]);
  });
});

describe('ports and adapters', () => {
  it('CensusGrounding: the latest census baseline is the merged head; no census, no grounding', async () => {
    const k = new FakeKnowledge();
    const g = new CensusGrounding(k);
    const none = await g.ground('acme/app');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe('no_census');
    k.down = true;
    const down = await g.ground('acme/app');
    expect(down.ok).toBe(false);
  });

  it("HttpKnowledgeSearch maps knowledge's answers and never throws", async () => {
    const answer = (status: number, body: unknown) =>
      new HttpKnowledgeSearch({
        baseUrl: 'http://k.invalid',
        token: 't',
        fetchImpl: (async () => new Response(JSON.stringify(body), { status })) as typeof fetch,
      });
    const req = { repo: 'acme/app', sha: 'a'.repeat(40), query: 'audit' };
    const hit = {
      path: 'a',
      blob_sha: 'b'.repeat(40),
      commit_sha: 'a'.repeat(40),
      line_from: 1,
      line_to: 2,
      excerpt: 'x',
    };
    const okRes = await answer(200, { hits: [hit] }).search(req);
    expect(okRes.ok && okRes.value).toEqual([hit]);
    for (const [status, code] of [
      [404, 'not_indexed'],
      [409, 'stale_index'],
      [400, 'invalid'],
      [500, 'unavailable'],
    ] as const) {
      const r = await answer(status, {}).search(req);
      expect(!r.ok && r.error.code, String(status)).toBe(code);
    }
    expect((await answer(200, { nope: 1 }).search(req)).ok).toBe(false);
    const dead = new HttpKnowledgeSearch({
      baseUrl: 'http://k.invalid',
      token: 't',
      fetchImpl: (async () => {
        throw new Error('down');
      }) as typeof fetch,
    });
    expect((await dead.search(req)).ok).toBe(false);
  });

  it('FakeKnowledgeSearch is the contract the tool needs: the named commit or an error', async () => {
    const f = new FakeKnowledgeSearch({
      repo: 'Acme/App',
      sha: 'a'.repeat(40),
      files: { 'a.ts': 'one\ntwo audit\nthree' },
    });
    const ok = await f.search({ repo: 'acme/app', sha: 'a'.repeat(40), query: 'AUDIT' });
    expect(ok.ok && ok.value[0]).toMatchObject({ path: 'a.ts', line_from: 1, line_to: 3 });
    const stale = await f.search({ repo: 'acme/app', sha: 'b'.repeat(40), query: 'audit' });
    expect(!stale.ok && stale.error.code).toBe('stale_index');
  });
});

describe('the artefact store', () => {
  let s: CoreStack;
  beforeAll(async () => {
    s = await startCoreStack();
  });
  afterAll(async () => {
    await s.stop();
  });
  const item = deterministicId<'WorkItem'>('planning-units-item');
  const rows = async (sql: string, args: unknown[] = []) =>
    (await s.record.pool.query(sql, args)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const put = (
    command_key: string,
    content: unknown,
    type: 'spec_delta' | 'impact' = 'spec_delta',
  ) =>
    storeArtefact(s.deps, {
      item_id: item,
      project_id: 'p1',
      type,
      step: '3.2',
      command_key,
      run_id: null,
      content,
    });

  it('content-addressed: the hash is the sha256 of the canonical JSON, whatever the key order; versions count up per type', async () => {
    const a = await put('c1', { b: 1, a: [1, 2] });
    expect(a.ok && a.value).toMatchObject({
      version: 1,
      sha256: sha256Hex(canonicalJson({ a: [1, 2], b: 1 })),
      duplicate: false,
    });
    const b = await put('c2', { a: [1, 2], b: 1 }); // the same content from another command: version 2, same hash
    expect(b.ok && b.value).toMatchObject({ version: 2, duplicate: false });
    expect(b.ok && a.ok && b.value.sha256 === a.value.sha256).toBe(true);
    const other = await put('c3', { x: 1 }, 'impact');
    expect(other.ok && other.value.version).toBe(1);
  });

  it('a command stores at most one artefact of a type: a redelivery finds it and writes nothing', async () => {
    const before = (await rows('SELECT count(*)::int AS n FROM core.artefact'))[0]?.n;
    const events = (
      await rows('SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1', [
        planningStream(item),
      ])
    )[0]?.n;
    const again = await put('c1', { b: 1, a: [1, 2] });
    expect(again.ok && again.value.duplicate).toBe(true);
    expect((await rows('SELECT count(*)::int AS n FROM core.artefact'))[0]?.n).toBe(before);
    expect(
      (
        await rows('SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1', [
          planningStream(item),
        ])
      )[0]?.n,
    ).toBe(events);
  });

  it('reads check the hash and the record: a tampered body, or a row with no event, is not served', async () => {
    const good = await put('c9', { honest: true });
    if (!good.ok) throw new Error('store failed');
    expect(await artefactByHash(s.record.pool, item, good.value.sha256)).not.toBeNull();
    await s.record.pool.query(
      `UPDATE core.artefact SET content = '{"honest":false}' WHERE command_key = 'c9'`,
    );
    expect(await artefactByHash(s.record.pool, item, good.value.sha256)).toBeNull();
    expect(
      (await listArtefacts(s.record.pool, item)).some((x) => x.sha256 === good.value.sha256),
    ).toBe(false);
    // a row nobody recorded
    const text = canonicalJson({ ghost: 1 });
    await s.record.pool.query(
      `INSERT INTO core.artefact (item_id, type, version, sha256, project_id, step, command_key, content, bytes, stored_at)
       VALUES ($1,'impact',9,$2,'p1','2.2','ghost',$3,$4,now())`,
      [item, sha256Hex(text), text, text.length],
    );
    expect(await artefactByHash(s.record.pool, item, sha256Hex(text))).toBeNull();
    expect(await latestArtefact(s.record.pool, item, 'impact')).toBeNull();
  });

  it('a refused proposal is a hash and field paths, and the schema takes nothing else', async () => {
    const r = await recordProposal(s.deps, {
      proposal_id: 'run:1',
      item_id: item as never,
      project_id: 'p1' as never,
      step: '2.2',
      run_id: deterministicId<'AgentRun'>('r1') as never,
      command_key: 'k-rej',
      agent_id: 'A3',
      attempt: 1,
      kind: 'shape',
      status: 'rejected',
      artefact_sha256: null,
      output_sha256: sha256Hex('x') as never,
      reasons: [{ path: 'lane', code: 'unrecognized_keys' }],
    });
    expect(r.ok).toBe(true);
    const ev = await rows('SELECT body FROM record.record_event WHERE stream = $1 AND type = $2', [
      planningStream(item),
      PLANNING_EVENT.proposal_recorded,
    ]);
    expect(ev.at(-1)?.body.reasons).toEqual([{ path: 'lane', code: 'unrecognized_keys' }]);
    void ({} as StageRequest);
  });
});
