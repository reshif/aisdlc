import {
  CONSTITUTION_CONFIG_KEY,
  Constitution,
  DEFAULT_CONSTITUTION,
  type StepId,
} from '@aisdlc/contracts';
import type { TestGateway } from '@aisdlc/gateway/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  constitutionFrom,
  gateArtefactsView,
  latestArtefact,
  listArtefacts,
  observeRelane,
  readItem,
  requestRework,
} from '../src/index.js';
import { pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  OUTPUTS,
  planningRig,
  reply,
  type Seen,
  sharedProvider,
  specV,
  startPlanningGateway,
  type PlanningRig,
} from './planning.js';
import { loadReports, runItem } from './work-fixtures.js';

// PLAN M12.3, S4 Design with the real planning port: 4.1 decisions, 4.2 contracts (an agent proposes, a
// deterministic checker parses), 4.3 data and migration, 4.4 NFR, threat and ops, 4.5 the constitution check
// (the factory's rules and A5's review), 4.6 the design review (G3d), E2 and its grant and denial paths, B4,
// B24, B25 and R2 from 4.6. The provider is scripted; no real model call.

let s: CoreStack;
let gw: TestGateway;
const provider = sharedProvider();
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startPlanningGateway(s);
});
afterAll(async () => {
  await gw.stop();
  await s.stop();
});
beforeEach(() => provider.reset());

const rows = async (sql: string, args: unknown[] = []) =>
  (await s.record.pool.query(sql, args)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
type St = NonNullable<Awaited<ReturnType<typeof readItem>>>['state'];
const pending = (gate: string) => (st: St) =>
  st.gates.some((g) => g.gate === gate && g.status === 'pending');
const handoff = (st: St) => st.waiting?.kind === 'handoff';
const asked = (step: StepId) => provider.of(step);
const gateOpens = (itemId: string, gate: string) =>
  rows(
    `SELECT body FROM record.record_event WHERE type = 'gate.opened' AND body ->> 'subject_id' = $1 AND body ->> 'gate_id' = $2 ORDER BY global_seq`,
    [itemId, gate],
  );
const decisions = (itemId: string, gate: string) =>
  rows(
    `SELECT decision FROM ledger.ledger_entry WHERE entry_type = 'decision' AND gate_id = $1 AND subject_id = $2 ORDER BY created_at`,
    [gate, itemId],
  ).then((r) => r.map((x) => x.decision as string));
const versions = async (rig: PlanningRig, type: string) =>
  (
    await rows(
      'SELECT version FROM core.artefact WHERE item_id = $1 AND type = $2 ORDER BY version',
      [rig.itemId, type],
    )
  ).map((r) => r.version as number);
const holdG3d = (g: string) => (g === 'G3d' ? ('hold' as const) : ('approve' as const));
const holdE2 = (g: string) => (g === 'E2' ? ('hold' as const) : ('approve' as const));
const cardOf = async (itemId: string, gate: string) =>
  (
    await rows(
      `SELECT substring(stream from 6) AS id FROM record.record_event WHERE type = 'card.opened' AND body ->> 'subject_id' = $1 AND body::text LIKE $2 ORDER BY global_seq DESC`,
      [itemId, `%${gate}%`],
    )
  )[0]?.id as string;
const withCalls = (calls: unknown[]) =>
  reply({ ...(OUTPUTS['4.4'] as object), network_calls: calls });
const withMigrations = (migrations: unknown[]) =>
  reply({ ...(OUTPUTS['4.3'] as object), migrations });
const unapproved = [{ host: 'api.analytics.example', purpose: 'send export statistics' }];

describe('L4: S4 reaches the design review with its artefacts bound by hash (G3d)', () => {
  let rig: PlanningRig;
  let item: Awaited<ReturnType<typeof runItem>>;
  let seen: Seen[] = [];
  beforeAll(async () => {
    provider.reset();
    rig = await planningRig(s, gw, { lane: 'L4' });
    item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3d,
      stop: pending('G3d'),
      passes: 150,
    });
    seen = [...provider.seen];
  });

  it('runs 4.1 to 4.5 in order, each once, by the agents the registry binds (A3, and A5 at 4.5)', async () => {
    const steps = seen.map((c) => c.step).filter((x) => x.startsWith('4.'));
    expect(steps).toEqual(['4.1', '4.2', '4.3', '4.4', '4.5']);
    expect(item?.state.underlying).toBe('S4');
    for (const step of ['4.1', '4.2', '4.3', '4.4', '4.5'] as StepId[]) {
      expect(item?.state.outputs[step], step).toMatch(/^[0-9a-f]{64}$/);
    }
    const dispatched = await rows(
      `SELECT body ->> 'step' AS step, body -> 'binding' ->> 'agent_id' AS agent FROM record.record_event
        WHERE stream = $1 AND type = 'agent.run_dispatched' AND body ->> 'step' LIKE '4.%' ORDER BY seq`,
      [`agent:${rig.itemId}`],
    );
    expect(dispatched.map((d) => [d.step, d.agent])).toEqual([
      ['4.1', 'A3'],
      ['4.2', 'A3'],
      ['4.3', 'A3'],
      ['4.4', 'A3'],
      ['4.5', 'A5'],
    ]);
  });

  it('each design step reads the ones before it as data, and the constitution check sees only the design', async () => {
    const text = (step: StepId) => JSON.stringify(seen.find((c) => c.step === step)?.req.messages);
    expect(text('4.2')).toContain('adr@');
    expect(text('4.3')).toContain('contracts@');
    expect(text('4.4')).toContain('data_migration@');
    const review = text('4.5');
    for (const t of ['adr@', 'contracts@', 'data_migration@', 'nfr_threat_ops@']) {
      expect(review, t).toContain(t);
    }
    // clean context: no request, no spec, no impact for the reviewer
    for (const t of ['request@', 'spec_delta@', 'impact@', 'context_brief@']) {
      expect(review, t).not.toContain(t);
    }
  });

  it('G3d binds the five design artefacts by hash, in its card and in the subject hash, and the card page reads the same bytes', async () => {
    const [g3d] = await gateOpens(rig.itemId, 'G3d');
    const refs = g3d?.body.facts.artefacts as Array<{ step: string; type: string; sha256: string }>;
    expect(refs.map((r) => r.type)).toEqual([
      'adr',
      'contracts',
      'data_migration',
      'nfr_threat_ops',
      'constitution_report',
    ]);
    for (const r of refs) expect(item?.state.outputs[r.step]).toBe(r.sha256);
    const view = await gateArtefactsView(s.record.pool, await cardOf(rig.itemId, 'G3d'));
    expect(view.ok && view.value.intact).toBe(true);
    if (view.ok) {
      expect(view.value.gates).toContain('G3d');
      expect(view.value.artefacts.at(-1)?.markdown).toContain('# Constitution check: pass');
      expect(view.value.artefacts[1]?.markdown).toContain('export.schema.json');
    }
  });

  it('a different design is a different subject: nothing of S5 starts until a person approves, and an approval moves the item on', async () => {
    expect(seen.some((c) => c.step.startsWith('5.'))).toBe(false);
    expect(await decisions(rig.itemId, 'G3d')).toEqual([]);
    await runItem(s, rig.d, rig.itemId, {
      stop: pending('G3'),
      decide: (g) => (g === 'G3' ? 'hold' : 'approve'),
      passes: 80,
    });
    expect(await decisions(rig.itemId, 'G3d')).toEqual(['approve']);
    expect(provider.seen.some((c) => c.step === '5.1')).toBe(true);
  });
});

describe('4.2: an agent proposes the contracts, a deterministic checker parses them', () => {
  const file = (content: string, format = 'json_schema', path = 'docs/c.json') => ({
    path,
    format,
    content,
  });
  const contracts = (files: unknown[]) =>
    reply({ ...(OUTPUTS['4.2'] as object), contract_files: files });

  it('a file that does not parse, an unresolved $ref and a bad OpenAPI are refused field by field and the step is asked again (B3)', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '4.2',
      contracts([file('{ not json')]),
      contracts([
        file(JSON.stringify({ type: 'object', properties: { a: { $ref: '#/$defs/missing' } } })),
      ]),
      contracts([
        file(JSON.stringify({ openapi: '2.0', info: {}, paths: { nope: {} } }), 'openapi'),
      ]),
    );
    const item = await runItem(s, rig.d, rig.itemId, { stop: handoff, passes: 120 });
    // three automatic rounds, then ET8: the fourth is never made
    expect(asked('4.2')).toHaveLength(3);
    expect(item?.state.handoffs.at(-1)).toMatchObject({ status: 'open', trigger: 'ET8' });
    expect(await versions(rig, 'contracts')).toEqual([]);
    const refused = await rows(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'proposal.recorded' AND body ->> 'step' = '4.2' ORDER BY seq`,
      [`planning:${rig.itemId}`],
    );
    expect(refused.map((r) => r.body.status)).toEqual(['rejected', 'rejected', 'rejected']);
    const codes = refused.map((r) => r.body.reasons.map((x: { code: string }) => x.code));
    expect(codes[0]).toContain('parse_error');
    expect(codes[1]).toContain('unresolved_ref');
    expect(codes[2]).toEqual(
      expect.arrayContaining(['bad_openapi_version', 'bad_info', 'bad_route']),
    );
    // 4.3 never ran: the design is not accepted on a contract nobody could parse
    expect(asked('4.3')).toHaveLength(0);
  });

  it('a valid OpenAPI and JSON Schema pass; a path outside the repository does not', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const openapi = JSON.stringify({
      openapi: '3.1.0',
      info: { title: 'Audit', version: '1' },
      paths: { '/export': { get: { responses: { '200': { description: 'CSV' } } } } },
      components: { schemas: { Row: { type: 'object', properties: { id: { type: 'string' } } } } },
    });
    provider.on(
      '4.2',
      contracts([file('{}', 'json_schema', '../../etc/passwd')]),
      contracts([file(openapi, 'openapi', 'docs/openapi.json')]),
    );
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3d,
      stop: pending('G3d'),
      passes: 120,
    });
    expect(item?.state.underlying).toBe('S4');
    expect(asked('4.2')).toHaveLength(2);
    expect(await versions(rig, 'contracts')).toEqual([1]);
  });
});

describe('4.5: the constitution check (deterministic rules from config, and the A5 review), and E2', () => {
  it('config: the constitution is a registered, factory-only key whose default has the egress and migration rules', async () => {
    expect(Constitution.safeParse(DEFAULT_CONSTITUTION).success).toBe(true);
    expect(DEFAULT_CONSTITUTION.rules.map((r) => r.rule_id)).toEqual(['C-EGRESS', 'C-MIGRATION']);
    expect(s.registry.get(CONSTITUTION_CONFIG_KEY)).toMatchObject({ overridable: false });
    // a published value that is not a constitution reads as unreadable (`null`): the check fails, never passes
    const reader = {
      current: () => ({ rejected: [CONSTITUTION_CONFIG_KEY], get: () => undefined }),
    };
    expect(constitutionFrom(reader as never)()).toBeNull();
    const ok = { current: () => ({ rejected: [], get: () => undefined }) };
    expect(constitutionFrom(ok as never)()).toEqual(DEFAULT_CONSTITUTION);
  });

  it('a network call with no approval reference violates C-EGRESS: E2 opens with the report bound, and the design waits there', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('4.4', withCalls(unapproved));
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdE2,
      stop: pending('E2'),
      passes: 120,
    });
    expect(item?.state.waiting).toMatchObject({
      kind: 'gates',
      conditional: { step: '4.5', gate: 'E2' },
    });
    const report = await latestArtefact(s.record.pool, rig.itemId, 'constitution_report');
    expect(report?.content).toMatchObject({
      verdict: 'violation',
      constitution_version: 1,
      deterministic: [{ rule_id: 'C-EGRESS', severity: 'high' }],
      review: { verdict: 'pass' },
    });
    expect(report?.markdown).toContain('[C-EGRESS]');
    const [e2] = await gateOpens(rig.itemId, 'E2');
    expect(e2?.body.facts.artefacts).toEqual([
      { step: '4.5', type: 'constitution_report', sha256: report?.row.sha256 },
    ]);
    expect(item?.state.gates.some((g) => g.gate === 'G3d')).toBe(false); // no design review until E2 is decided
  });

  it('E2 granted: the design goes on to its review at 4.6 with the violation in front of the reviewer, and nothing is redesigned', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('4.4', withCalls(unapproved));
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3d,
      stop: pending('G3d'),
      passes: 150,
    });
    expect(await decisions(rig.itemId, 'E2')).toEqual(['approve']);
    expect(asked('4.1')).toHaveLength(1);
    expect(item?.state.rework.by_edge['B25']).toBeUndefined();
    const [g3d] = await gateOpens(rig.itemId, 'G3d');
    const report = await latestArtefact(s.record.pool, rig.itemId, 'constitution_report');
    const bound = (g3d?.body.facts.artefacts as Array<{ type: string; sha256: string }>).find(
      (r) => r.type === 'constitution_report',
    );
    expect(bound?.sha256).toBe(report?.row.sha256);
    expect((report?.content as { verdict: string }).verdict).toBe('violation');
  });

  it('E2 denied: B25 redesigns once (4.1 is told the finding), and a clean redesign reaches G3d', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('4.4', withCalls(unapproved));
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'E2' ? 'reject' : holdG3d(g)),
      stop: pending('G3d'),
      passes: 200,
    });
    expect(await decisions(rig.itemId, 'E2')).toEqual(['reject']);
    expect(item?.state.rework.by_edge['B25']).toBe(1);
    expect(asked('4.1')).toHaveLength(2);
    expect(JSON.stringify(asked('4.1')[0]?.req.messages)).not.toContain('constitution_report@');
    expect(JSON.stringify(asked('4.1')[1]?.req.messages)).toContain('constitution_report@');
    expect(JSON.stringify(asked('4.1')[1]?.req.messages)).toContain('C-EGRESS');
    expect(await versions(rig, 'constitution_report')).toEqual([1, 2]);
    expect(item?.state.underlying).toBe('S4');
    expect(item?.state.handoffs).toEqual([]);
  });

  it('E2 denied twice: B25 allows one redesign, so the second denial is E4, a person decides', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('4.4', withCalls(unapproved), withCalls(unapproved));
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'E2' ? 'reject' : 'approve'),
      stop: handoff,
      passes: 250,
    });
    expect(await decisions(rig.itemId, 'E2')).toEqual(['reject', 'reject']);
    expect(item?.state.handoffs.at(-1)).toMatchObject({
      status: 'open',
      code: 'E4',
      trigger: 'B25',
    });
    expect(item?.state.gates.some((g) => g.gate === 'G3d')).toBe(false);
  });

  it('an irreversible migration that is neither reversible nor flagged violates C-MIGRATION; flagged, it does not', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('4.3', withMigrations([{ name: '0042_drop_audit_column', reversible: false }]));
    const held = await runItem(s, rig.d, rig.itemId, {
      decide: holdE2,
      stop: pending('E2'),
      passes: 120,
    });
    expect(held?.state.waiting).toMatchObject({ conditional: { gate: 'E2' } });
    const r = await latestArtefact(s.record.pool, rig.itemId, 'constitution_report');
    expect(r?.content).toMatchObject({ deterministic: [{ rule_id: 'C-MIGRATION' }] });
    expect(r?.markdown).toContain('0042_drop_audit_column');

    const rig2 = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '4.3',
      withMigrations([
        { name: '0042_drop_audit_column', reversible: false, irreversible_flagged: true },
      ]),
    );
    const item2 = await runItem(s, rig2.d, rig2.itemId, {
      decide: holdG3d,
      stop: pending('G3d'),
      passes: 150,
    });
    expect(item2?.state.underlying).toBe('S4');
    expect(await decisions(rig2.itemId, 'E2')).toEqual([]);
    expect(
      (await latestArtefact(s.record.pool, rig2.itemId, 'constitution_report'))?.content,
    ).toMatchObject({
      verdict: 'pass',
      deterministic: [],
    });
  });

  it("A5's own findings are a violation too (the review is half of 4.5), even when the rules find nothing", async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '4.5',
      reply({
        kind: 'review',
        check: 'constitution',
        verdict: 'findings',
        findings: [
          {
            severity: 'high',
            rule_id: 'C-EGRESS',
            location: { path: 'docs/contracts/export.schema.json' },
            message: 'The design reads a secret from the environment.',
          },
        ],
      }),
    );
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdE2,
      stop: pending('E2'),
      passes: 120,
    });
    expect(item?.state.waiting).toMatchObject({ conditional: { gate: 'E2' } });
    expect(
      (await latestArtefact(s.record.pool, rig.itemId, 'constitution_report'))?.content,
    ).toMatchObject({
      deterministic: [],
      review: { verdict: 'findings' },
      verdict: 'violation',
    });
  });

  it('a host the constitution allows needs no approval; an approval reference makes a call pass', async () => {
    const rig = await planningRig(s, gw, {
      lane: 'L4',
      port: {
        constitution: () => ({
          version: 7,
          rules: [
            {
              rule_id: 'C-EGRESS',
              kind: 'no_unapproved_egress',
              title: 'No new external egress',
              allow_hosts: ['api.analytics.example'],
            },
          ],
        }),
      },
    });
    provider.on(
      '4.4',
      withCalls([
        ...unapproved,
        { host: 'api.partner.example', purpose: 'partner sync', approval_ref: 'DEC-31 by bob' },
      ]),
    );
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3d,
      stop: pending('G3d'),
      passes: 150,
    });
    expect(item?.state.underlying).toBe('S4');
    expect(
      (await latestArtefact(s.record.pool, rig.itemId, 'constitution_report'))?.content,
    ).toMatchObject({
      constitution_version: 7,
      verdict: 'pass',
    });
  });

  it('an unreadable constitution is a violation (unknown means unmet), never a pass', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4', port: { constitution: () => null } });
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdE2,
      stop: pending('E2'),
      passes: 120,
    });
    expect(item?.state.waiting).toMatchObject({ conditional: { gate: 'E2' } });
    expect(
      (await latestArtefact(s.record.pool, rig.itemId, 'constitution_report'))?.content,
    ).toMatchObject({
      constitution_version: null,
      deterministic: [{ rule_id: 'CONSTITUTION' }],
    });
  });
});

describe('4.6 and G3d: B24 (rejected twice, then E4), B4 (a spec gap goes back to 3.2 once), R2', () => {
  it('B24: a rejected design goes back to 4.1; the second rejection goes back again; the third is E4', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'G3d' ? 'reject' : 'approve'),
      stop: handoff,
      passes: 300,
    });
    expect(await decisions(rig.itemId, 'G3d')).toEqual(['reject', 'reject', 'reject']);
    expect(item?.state.rework.by_edge['B24']).toBe(3);
    expect(asked('4.1')).toHaveLength(3);
    expect(item?.state.handoffs.at(-1)).toMatchObject({
      status: 'open',
      code: 'E4',
      trigger: 'B24',
    });
    expect(await versions(rig, 'adr')).toEqual([1, 2, 3]);
  });

  it('B4: while G3d is open the reviewer finds a gap in the spec: back to 3.2 (and G2 again); a second time is over the limit of one', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    await runItem(s, rig.d, rig.itemId, {
      decide: holdG3d,
      stop: pending('G3d'),
      passes: 150,
    });
    expect(asked('3.2')).toHaveLength(1);
    const first = await requestRework({ pool: s.record.pool, clock: s.clock }, rig.itemId, {
      edge: 'B4',
      step: null,
      reason_code: 'design_reveals_spec_gap',
      by: pr('bob'),
      key: '1',
    });
    expect(first.ok).toBe(true);
    provider.on('3.2', reply(specV('The audit log can be exported as CSV, with a header row.')));
    let item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3d,
      stop: (st) => st.gates.filter((g) => g.gate === 'G3d').length >= 2 && pending('G3d')(st),
      passes: 250,
    });
    expect(item?.state.rework.by_edge['B4']).toBe(1);
    expect(asked('3.2')).toHaveLength(2);
    expect((await gateOpens(rig.itemId, 'G2')).length).toBe(2); // the redrafted spec is approved again
    expect((await gateOpens(rig.itemId, 'G3d')).length).toBe(2);
    expect(await versions(rig, 'spec_delta')).toEqual([1, 2]);
    // B4 is limited to once; the second request is counted and the flow names no exit, so a person decides (E4)
    const second = await requestRework({ pool: s.record.pool, clock: s.clock }, rig.itemId, {
      edge: 'B4',
      step: null,
      reason_code: 'design_reveals_spec_gap',
      by: pr('bob'),
      key: '2',
    });
    expect(second.ok).toBe(true);
    item = await readItem(s.record.pool, rig.itemId);
    expect(item?.state.rework.by_edge['B4']).toBe(2);
    expect(item?.state.handoffs.at(-1)).toMatchObject({
      status: 'open',
      code: 'E4',
      trigger: 'B4',
    });
  });

  it('B4 is observed at the design review only: asked anywhere else it is refused and counts for nothing', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    await runItem(s, rig.d, rig.itemId, { decide: () => 'hold', stop: pending('G0'), passes: 60 });
    const r = await requestRework({ pool: s.record.pool, clock: s.clock }, rig.itemId, {
      edge: 'B4',
      step: null,
      reason_code: 'x',
      by: pr('bob'),
      key: 'early',
    });
    expect(r.ok).toBe(true);
    const item = await readItem(s.record.pool, rig.itemId);
    expect(item?.state.rework.by_edge['B4']).toBeUndefined();
    expect(item?.state.ignored.some((i) => i.includes('B4') && i.includes('not_at_4.6'))).toBe(
      true,
    );
  });

  it('R2 from 4.6: E1 approved goes back to 1.3 and G0 on the lower lane; denied, the design review goes on', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    await runItem(s, rig.d, rig.itemId, { decide: holdG3d, stop: pending('G3d'), passes: 150 });
    const asked21 = await observeRelane({ pool: s.record.pool, clock: s.clock }, rig.itemId, {
      to_lane: 'L3',
      reason_code: 'smaller_than_lane',
      by: pr('bob'),
      key: '1',
    });
    expect(asked21.ok).toBe(true);
    // E1 is open next to G3d; a denial returns to the review
    let item = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'E1' ? 'reject' : 'hold'),
      stop: (st) =>
        st.waiting?.kind === 'gates' &&
        st.waiting.conditional === null &&
        st.relanes.length === 0 &&
        st.gates.some((g) => g.gate === 'E1' && g.status === 'decided'),
      passes: 60,
    });
    expect(item?.state.relanes).toEqual([]);
    expect(item?.state.lane).toBe('L4');
    expect(item?.state.waiting).toMatchObject({ kind: 'gates' });
    expect(pending('G3d')(item!.state)).toBe(true);
    // asked again and approved: the lane moves down and G0 is decided again
    await observeRelane({ pool: s.record.pool, clock: s.clock }, rig.itemId, {
      to_lane: 'L3',
      reason_code: 'smaller_than_lane',
      by: pr('bob'),
      key: '2',
    });
    item = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'G3d' ? 'hold' : 'approve'),
      stop: (st) => st.relanes.length > 0 && pending('G0')(st),
      passes: 80,
    });
    expect(item?.state.relanes).toMatchObject([
      { edge: 'R2', from_lane: 'L4', to_lane: 'L3', step: '4.6' },
    ]);
    expect(await decisions(rig.itemId, 'E1')).toEqual(['reject', 'approve']);
  });
});

describe('S4 artefacts are listed for the audit with their renderings', () => {
  it('every design artefact is content-addressed and rendered as markdown with its facts', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '4.3',
      withMigrations([
        {
          name: '0042_drop_col',
          reversible: false,
          irreversible_flagged: true,
          note: 'data is exported first',
        },
      ]),
    );
    await runItem(s, rig.d, rig.itemId, { decide: holdG3d, stop: pending('G3d'), passes: 150 });
    const all = await listArtefacts(s.record.pool, rig.itemId);
    const md = (t: string) => all.find((a) => a.type === t)?.markdown ?? '';
    expect(md('data_migration')).toContain('IRREVERSIBLE (flagged)');
    expect(md('contracts')).toContain('```json');
    expect(md('adr')).toContain('# Decisions');
    expect(md('classification')).toContain('# Classification');
  });
});
