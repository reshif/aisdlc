import { primaryAgentFor, buildContext } from '@aisdlc/agents';
import { readPrompt } from '@aisdlc/agents/files';
import {
  AGENT_EVENT,
  PLANNING_EVENT,
  planningStream,
  agentStream,
  type StageRequest,
  type StepId,
} from '@aisdlc/contracts';
import type { TestGateway } from '@aisdlc/gateway/testing';
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  artefactByHash,
  latestArtefact,
  listAgentRuns,
  listArtefacts,
  readItem,
  storeArtefact,
} from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import {
  MERGED,
  OUTPUTS,
  REQUEST_TEXT,
  planningRig,
  reply,
  sharedProvider,
  specV,
  startPlanningGateway,
  type PlanningRig,
  type Seen,
} from './planning.js';
import { loadReports, runItem } from './work-fixtures.js';

// PLAN M12.1 (S2 Shape) and M12.2 (S3 Specify) with the REAL planning port: the real gateway, a provider
// scripted per step with realistic JSON outputs, the real decision kernel and ledger, real Postgres. No
// real model call exists anywhere in this file.

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

const atS4 = (st: { underlying: string }) => st.underlying === 'S4';
const events = (itemId: string, stream: string, type?: string) =>
  rows(
    `SELECT type, body FROM record.record_event WHERE stream = $1 ${type ? 'AND type = $2' : ''} ORDER BY seq`,
    type ? [stream, type] : [stream],
  );
const proposals = (itemId: string) =>
  events(itemId, planningStream(itemId), PLANNING_EVENT.proposal_recorded);
const stored = (itemId: string) =>
  events(itemId, planningStream(itemId), PLANNING_EVENT.artefact_stored);

/** The StageRequest of a command the driver ran at `step` (rebuilt from the dispatch the driver recorded). */
async function requestOf(rig: PlanningRig, step: StepId): Promise<StageRequest> {
  const d = (await events(rig.itemId, agentStream(rig.itemId), AGENT_EVENT.run_dispatched)).find(
    (e) => e.body.step === step,
  )?.body;
  const item = await readItem(s.record.pool, rig.itemId);
  if (!d || !item) throw new Error(`no dispatch of ${step}`);
  return {
    command_key: d.command_key,
    item_id: rig.itemId,
    project_id: d.project_id,
    repo: rig.repo,
    lane: d.lane,
    step,
    attempt: d.attempt,
    approved_gates: [],
    denied_gates: [],
    catalogue_ref: item.state.catalogue_ref,
    agent: d.binding,
  } as unknown as StageRequest;
}

const gateOpens = async (itemId: string, gate: string) =>
  rows(
    `SELECT body FROM record.record_event
      WHERE type = 'gate.opened' AND body ->> 'subject_id' = $1 AND body ->> 'gate_id' = $2 ORDER BY global_seq`,
    [itemId, gate],
  );

describe('L4: S2 -> S3 -> G2 -> S4 entry, artefacts stored and hash-bound', () => {
  let rig: PlanningRig;
  let item: Awaited<ReturnType<typeof runItem>>;
  let seen: Seen[] = [];
  const of = (step: StepId) => seen.filter((c) => c.step === step);
  beforeAll(async () => {
    provider.reset();
    rig = await planningRig(s, gw, { lane: 'L4' });
    // the model asks the knowledge tool once before it answers at 2.1b
    provider.on('2.1b', {
      tool_uses: [
        {
          name: 'KnowledgeSearch',
          input: { query: 'audit', repo: 'evil/other', sha: 'f'.repeat(40) },
        },
      ],
    });
    item = await runItem(s, rig.d, rig.itemId, { stop: atS4, passes: 120 });
    seen = [...provider.seen];
  });

  it('reaches S4 with S2 and S3 done by agents, and 2.4 (L6 only) skipped', async () => {
    expect(item?.state.underlying).toBe('S4');
    const asked = seen.map((c) => c.step);
    for (const step of ['2.1', '2.1b', '2.2', '2.3', '3.1', '3.2', '3.4', '3.5'] as StepId[]) {
      expect(asked, step).toContain(step);
    }
    expect(asked).not.toContain('2.4');
    expect(item?.state.outputs['3.3']).toMatch(/^[0-9a-f]{64}$/); // 3.3 is code: no model call for it
    expect(asked).not.toContain('3.3');
  });

  it('every artefact is content-addressed: sha256 of the canonical JSON, with one record event carrying the hash', async () => {
    const all = await listArtefacts(s.record.pool, rig.itemId);
    const types = all.map((a) => a.type).sort();
    expect(types).toEqual(
      [
        'affected_requirements',
        'context_brief',
        'decision_brief',
        'impact',
        'intent_block',
        'oracle_specs',
        'reverse_engineering',
        'spec_delta',
        'spec_review',
        'validation_report',
      ].sort(),
    );
    const ev = await stored(rig.itemId);
    expect(ev).toHaveLength(all.length);
    for (const a of all) {
      const row = (
        await rows('SELECT content, sha256 FROM core.artefact WHERE item_id = $1 AND sha256 = $2', [
          rig.itemId,
          a.sha256,
        ])
      )[0];
      expect(sha256Hex(canonicalJson(JSON.parse(row?.content)))).toBe(a.sha256);
      expect(ev.some((e) => e.body.sha256 === a.sha256 && e.body.type === a.type)).toBe(true);
      expect(a.markdown.length).toBeGreaterThan(20);
    }
    // the step's output hash IS the artefact hash
    const spec = await latestArtefact(s.record.pool, rig.itemId, 'spec_delta');
    expect(item?.state.outputs['3.2']).toBe(spec?.row.sha256);
    const oracles = await latestArtefact(s.record.pool, rig.itemId, 'oracle_specs');
    expect(item?.state.outputs['3.4']).toBe(oracles?.row.sha256);
  });

  it('a Proposal links item, step, run and artefact hash for every agent answer', async () => {
    const p = await proposals(rig.itemId);
    const accepted = p.filter((x) => x.body.status === 'accepted');
    expect(accepted.map((x) => x.body.step).sort()).toEqual(
      ['2.1', '2.1b', '2.2', '2.3', '3.1', '3.2', '3.4', '3.5'].sort(),
    );
    const runs = await listAgentRuns(s.record.pool, rig.itemId);
    for (const pr_ of accepted) {
      expect(pr_.body.item_id).toBe(rig.itemId);
      expect(runs.some((r) => r.run_id === pr_.body.run_id && r.step === pr_.body.step)).toBe(true);
      expect(
        await artefactByHash(s.record.pool, rig.itemId, pr_.body.artefact_sha256),
      ).not.toBeNull();
      expect(pr_.body.output_sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // the run of 3.2 is the run the artefact event names
    const specEvent = (await stored(rig.itemId)).find((e) => e.body.type === 'spec_delta');
    expect(runs.find((r) => r.run_id === specEvent?.body.run_id)?.step).toBe('3.2');
  });

  it('G2 was opened with the spec, the oracle specs and the review bound by hash, and the subject hash binds them', async () => {
    const [g2] = await gateOpens(rig.itemId, 'G2');
    const refs = g2?.body.facts.artefacts as Array<{ step: string; type: string; sha256: string }>;
    expect(refs.map((r) => r.type)).toEqual(['spec_delta', 'oracle_specs', 'spec_review']);
    expect(refs[0]?.sha256).toBe(item?.state.outputs['3.2']);
    expect(refs[1]?.sha256).toBe(item?.state.outputs['3.4']);
    // the card page reads the same list and the same bytes back
    const card = (
      await rows(
        `SELECT substring(stream from 6) AS id FROM record.record_event WHERE type = 'card.opened' AND body ->> 'subject_id' = $1 AND body::text LIKE '%G2%'`,
        [rig.itemId],
      )
    )[0]?.id as string;
    const { gateArtefactsView } = await import('../src/index.js');
    const view = await gateArtefactsView(s.record.pool, card);
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.value.intact).toBe(true);
    expect(view.value.subject_hash).toBe(g2?.body.subject_hash);
    expect(view.value.artefacts.map((a) => a.sha256)).toEqual(refs.map((r) => r.sha256));
    expect(view.value.artefacts[0]?.markdown).toContain('REQ-12');
    expect(view.value.artefacts[1]?.markdown).toContain('o1');
  });

  it('a command delivered again is answered from its stored artefact: the same outcome, no model call, no new key', async () => {
    const before = provider.inner.calls.length;
    const minted = rig.keys.minted.length;
    for (const step of ['2.1', '3.2', '3.5'] as StepId[]) {
      const again = await rig.port.run(await requestOf(rig, step));
      expect(again.ok).toBe(true);
      if (again.ok && again.value.outcome === 'completed') {
        expect(again.value.output_hash).toBe(item?.state.outputs[step]);
      }
    }
    expect(provider.inner.calls.length).toBe(before);
    expect(rig.keys.minted.length).toBe(minted);
  });

  it('the G2 decision is in the ledger and the item moved on to S4 on it', async () => {
    const led = await rows(
      `SELECT decision FROM ledger.ledger_entry WHERE entry_type = 'decision' AND gate_id = 'G2' AND subject_id = $1`,
      [rig.itemId],
    );
    expect(led.map((l) => l.decision)).toEqual(['approve']);
  });

  it("the model asked the knowledge tool once; the repository and commit were the factory's, whatever it asked for", async () => {
    expect(rig.search.calls).toHaveLength(1);
    expect(rig.search.calls[0]).toMatchObject({ repo: rig.repo, sha: MERGED, query: 'audit' });
    // the tool result went back to the model as fenced data
    const second = of('2.1b')[1];
    expect(JSON.stringify(second?.req.messages)).toMatch(/<<<DATA [0-9a-f]{16} /);
    expect(JSON.stringify(second?.req.messages)).toContain('src/audit.ts');
  });

  it("every call went out under the run's own key, with the locked prompt and only the tools the port can run", async () => {
    for (const c of seen) {
      const def = primaryAgentFor(c.step);
      expect(c.req.system).toBe(readPrompt(def?.prompt.ref ?? ''));
      for (const t of c.req.tools ?? []) expect(t.name).toBe('KnowledgeSearch');
    }
    const runs = await listAgentRuns(s.record.pool, rig.itemId);
    const planning = runs.filter((r) =>
      ['2.1', '2.1b', '2.2', '2.3', '3.1', '3.2', '3.4', '3.5'].includes(r.step),
    );
    expect(new Set(planning.map((r) => r.vkey_id)).size).toBe(planning.length); // one key per command
    for (const r of planning) {
      expect(r.calls).toBeGreaterThanOrEqual(1);
      expect(r.state).toBe('finished');
    }
    // 2.1b made two calls (the tool round trip)
    expect(runs.find((r) => r.step === '2.1b')?.calls).toBe(2);
  });

  it('the key secrets reached the port in memory only: in no event, outbox row, read model or log, and the vault is empty', async () => {
    expect(rig.keys.secrets.length).toBeGreaterThan(5);
    const dump = JSON.stringify([
      await rows('SELECT body FROM record.record_event'),
      await rows('SELECT payload FROM record.outbox'),
      await rows('SELECT * FROM core.agent_run'),
      await rows('SELECT content FROM core.artefact'),
    ]);
    for (const secret of rig.keys.secrets) expect(dump).not.toContain(secret);
    expect(rig.vault.size).toBe(0);
    expect(JSON.stringify(rig.vault)).toBe('{"vault":"run-key","held":0}');
    // the per-job keys were ended once their commands were answered
    expect(rig.keys.revoked.length).toBeGreaterThan(5);
    const at = await gw.admin().vkey(rig.keys.revoked[0] as string);
    expect(at.ok && at.value.revoked_at).not.toBeNull();
  });

  it("never stores prompt text: the gateway's record has hashes, and nothing of the request text or the prompt", async () => {
    const calls = await rows(
      `SELECT body FROM record.record_event WHERE type = 'gateway.model_call' AND body ->> 'item_id' = $1`,
      [rig.itemId],
    );
    expect(calls.length).toBeGreaterThanOrEqual(9);
    for (const c of calls) {
      expect(c.body.request_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(c.body.response_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    const everything = JSON.stringify([
      calls,
      await rows(`SELECT body FROM record.record_event WHERE stream = ANY($1)`, [
        [planningStream(rig.itemId), agentStream(rig.itemId)],
      ]),
      await rows('SELECT * FROM core.agent_run'),
    ]);
    expect(everything).not.toContain('Ignore all previous');
    expect(everything).not.toContain('You are the factory');
  });

  it("the item's assumptions came from the agents' outputs, one shape, hashed", async () => {
    const a = item?.state.assumptions.filter((x) => x.origin === 'agent_output') ?? [];
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(a.every((x) => /^[0-9a-f]{64}$/.test(x.text_hash))).toBe(true);
  });
});

describe('invalid output: recorded, retried up to B3 auto_rounds, then ET8 -> handoff', () => {
  it('three invalid answers (not JSON, a planted `lane`, the wrong kind) are three rejected proposals, then ET8; nothing is stored', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '2.2',
      { text: 'Sure! Here is the impact: it is large.' },
      reply({ ...(OUTPUTS['2.2'] as object), lane: 'L0' }),
      reply(OUTPUTS['2.1']), // valid, but the context brief is not the impact step's output
    );
    const item = await runItem(s, rig.d, rig.itemId, {
      stop: (st) => st.waiting?.kind === 'handoff',
    });
    expect(item?.state.waiting).toMatchObject({ kind: 'handoff' });
    expect(item?.state.handoffs.at(-1)).toMatchObject({ status: 'open', trigger: 'ET8' });

    expect(rig.provider.of('2.2')).toHaveLength(3); // the third attempt was the last, there is no fourth
    const rejected = (await proposals(rig.itemId)).filter((p) => p.body.step === '2.2');
    expect(rejected.map((p) => p.body.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(rejected.map((p) => p.body.attempt)).toEqual([1, 2, 3]);
    expect(rejected.every((p) => p.body.artefact_sha256 === null)).toBe(true);
    expect(rejected[0]?.body.reasons).toEqual([{ path: '$', code: 'not_json' }]);
    expect(rejected[1]?.body.reasons).toContainEqual({ path: 'lane', code: 'unrecognized_keys' });
    expect(rejected[2]?.body.reasons).toContainEqual({ path: 'kind', code: 'wrong_kind_for_step' });
    expect(JSON.stringify(rejected)).not.toContain('Sure! Here is the impact');

    const failed = await events(rig.itemId, agentStream(rig.itemId), AGENT_EVENT.run_failed);
    expect(failed.filter((f) => f.body.code === 'output_invalid')).toHaveLength(3);
    expect(await latestArtefact(s.record.pool, rig.itemId, 'impact')).toBeNull();
    // the field errors were named to the model on the retry (paths and codes only, never its text)
    const retry = JSON.stringify(rig.provider.of('2.2')[1]?.req.messages);
    expect(retry).toContain('refused by the factory');
    expect(retry).toContain('$ not_json');
    expect(retry).not.toContain('it is large');
    // the run that failed is a failed run in the read model, with its code
    const runs = await listAgentRuns(s.record.pool, rig.itemId);
    expect(runs.find((r) => r.step === '2.2')?.outcome.triggers).toContain('ET8');
  });

  it('a command delivered again after ET8 (the answer was lost) is answered from the record: no model call, no key', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('2.2', { text: 'no' }, { text: 'no' }, { text: 'no' });
    await runItem(s, rig.d, rig.itemId, { stop: (st) => st.waiting?.kind === 'handoff' });
    const calls = provider.of('2.2').length;
    expect(calls).toBe(3);
    const again = await rig.port.run(await requestOf(rig, '2.2'));
    expect(again).toEqual({
      ok: true,
      value: { outcome: 'trigger', trigger: 'ET8', reason_code: 'output_invalid' },
    });
    expect(provider.of('2.2')).toHaveLength(3);
    expect(rig.vault.size).toBe(0);
  });
});

describe('a secret in a model output is refused before storage', () => {
  it('the gateway redacts it, the port refuses the redaction mark, nothing is stored; the retry succeeds', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const secret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    const leaky = {
      ...(OUTPUTS['2.2'] as Record<string, unknown>),
      sections: [{ heading: 'Keys', text: `The deploy key is ${secret} and it is checked in.` }],
    };
    provider.on('2.2', reply(leaky));
    const item = await runItem(s, rig.d, rig.itemId, { stop: atS4, passes: 120 });
    expect(item?.state.underlying).toBe('S4');
    const p = (await proposals(rig.itemId)).filter((x) => x.body.step === '2.2');
    expect(p.map((x) => [x.body.status, x.body.attempt])).toEqual([
      ['rejected', 1],
      ['accepted', 2],
    ]);
    expect(p[0]?.body.reasons).toEqual([{ path: '$', code: 'secret_in_output' }]);
    // no row, no event, no read model holds it
    const dump = JSON.stringify([
      await rows('SELECT content FROM core.artefact'),
      await rows('SELECT body FROM record.record_event'),
    ]);
    expect(dump).not.toContain(secret);
    expect(dump).not.toContain('REDACTED');
    const failed = await events(rig.itemId, agentStream(rig.itemId), AGENT_EVENT.run_failed);
    expect(failed.map((f) => f.body.code)).toEqual(['secret_in_output']);
  });

  it('with a route that does not redact, the shared ruleset refuses the raw answer; the store refuses a secret too', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const secret = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
    // a gateway that hands the answer back as it got it (no redaction on this route)
    const raw = JSON.stringify({ ...(OUTPUTS['2.2'] as object), title: `key ${secret}` });
    const { AgentPlanningPort } = await import('../src/index.js');
    const port = new AgentPlanningPort({
      pool: s.record.pool,
      clock: s.clock,
      gateway: {
        baseUrl: 'http://gateway.invalid',
        fetchImpl: (async () =>
          new Response(
            JSON.stringify({
              id: 'msg_1',
              model: 'fake-model',
              content: [{ type: 'text', text: raw }],
              stop_reason: 'end_turn',
              usage: { input_tokens: 5, output_tokens: 5 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )) as typeof fetch,
      },
      keys: { lend: async (_r, use) => use('aisk_not_a_real_key') },
      grounding: rig.grounding,
      fallback: rig.base.planning,
      prompt: readPrompt,
    });
    // drive the item to 2.2 with the real driver, but with this port in front of it
    const d = { ...rig.d, ports: { ...rig.d.ports, planning: port } };
    const item = await runItem(s, d, rig.itemId, { stop: (st) => st.waiting?.kind === 'handoff' });
    expect(item?.state.handoffs.at(-1)).toMatchObject({ trigger: 'ET8' });
    const p = (await proposals(rig.itemId)).filter((x) => x.body.status === 'rejected');
    expect(p.length).toBeGreaterThanOrEqual(3);
    expect(p.every((x) => x.body.reasons[0].code === 'secret_in_output')).toBe(true);
    expect(JSON.stringify(await rows('SELECT content FROM core.artefact'))).not.toContain(secret);

    // the store, on its own: a secret in content is refused and nothing is written
    const before = (await rows('SELECT count(*)::int AS n FROM core.artefact'))[0]?.n;
    const w = await storeArtefact(s.deps, {
      item_id: rig.itemId,
      project_id: rig.project,
      type: 'impact',
      step: '2.2',
      command_key: 'direct-secret',
      run_id: null,
      content: { kind: 'document', title: `key ${secret}` },
    });
    expect(w.ok).toBe(false);
    if (!w.ok) expect(w.error).toMatchObject({ _tag: 'ArtefactRefused', code: 'secret_in_output' });
    expect((await rows('SELECT count(*)::int AS n FROM core.artefact'))[0]?.n).toBe(before);
  });
});

describe('3.5 reviews in a clean context', () => {
  it('its context holds the artefacts and nothing of the drafting run: not its conversation, prompt, request text or validator findings', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const draft = specV('The audit log can be exported as CSV (draft marker QX7).');
    provider.on('3.2', reply(draft));
    await runItem(s, rig.d, rig.itemId, { stop: atS4, passes: 120 });
    const review = rig.provider.of('3.5')[0];
    const drafting = rig.provider.of('3.2')[0];
    const sent = JSON.stringify(review?.req);
    expect(review?.req.messages).toHaveLength(1);
    expect(review?.req.messages[0]?.role).toBe('user');
    // A5's own locked prompt, never the drafter's
    expect(review?.req.system).toBe(readPrompt(primaryAgentFor('3.5')?.prompt.ref ?? ''));
    expect(sent).not.toContain('A2 intent agent');
    // the drafter's conversation: its prompt, its context and the raw JSON it answered with
    expect(sent).not.toContain(JSON.stringify(draft));
    expect(sent).not.toContain(drafting?.req.system ?? 'x');
    expect(sent).not.toContain('Ignore all previous'); // the request text is not given to the reviewer
    expect(sent).not.toContain('validation'); // 3.3's report is not either
    // what it does get: the two artefacts, as fenced data with their hashes in the provenance header
    expect(sent).toContain('draft marker QX7');
    const spec = await latestArtefact(s.record.pool, rig.itemId, 'spec_delta');
    expect(sent).toContain(`artefact:spec_delta@${spec?.row.sha256.slice(0, 16)}`);
    expect(sent).toMatch(/artefact:oracle_specs@/);
    expect(sent).not.toMatch(/artefact:(context_brief|impact|decision_brief|validation_report)@/);
    // and its key is its own
    const runs = await listAgentRuns(s.record.pool, rig.itemId);
    expect(runs.find((r) => r.step === '3.5')?.vkey_id).not.toBe(
      runs.find((r) => r.step === '3.2')?.vkey_id,
    );
  });
});

describe('planted instructions: repo and request text are fenced data in the stored request', () => {
  it('the request text appears only inside a DATA fence behind a flagged provenance header; tools, key and level 1 are untouched', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    await runItem(s, rig.d, rig.itemId, { stop: atS4, passes: 120 });
    const first = rig.provider.of('2.1')[0];
    const user =
      JSON.stringify(first?.req.messages[0]?.content).length > 0
        ? String((first?.req.messages[0] as { content: string }).content)
        : '';
    const at = user.indexOf('Ignore all previous');
    expect(at).toBeGreaterThan(0);
    const fenceOpen = user.lastIndexOf('<<<DATA ', at);
    const fenceClose = user.indexOf('<<<END DATA ', at);
    expect(fenceOpen).toBeGreaterThan(-1);
    expect(fenceClose).toBeGreaterThan(at);
    expect(user.slice(fenceOpen, user.indexOf('\n', fenceOpen))).toContain('lint_flagged');
    expect(user.slice(0, fenceOpen)).not.toContain('Ignore all previous');
    expect(first?.req.system).not.toContain('Ignore all previous');
    // the factory's own words, level 1 and 2, are the only unfenced text, and carry nothing of it
    const control = user.slice(user.indexOf('== FACTORY CONTROL'), user.indexOf('== DATA'));
    expect(control).toContain('Factory policy');
    expect(control).not.toContain('Ignore all previous');
    // the accepted intent block is level 2 control, with the gate that accepted it
    expect(control).toMatch(/\[level 2 [0-9a-f]{12}\] .*"affirmation_ref":"gate:/);
    // what the key carries is the contract's, whatever the text asked for
    for (const m of rig.keys.minted) {
      const def = primaryAgentFor(m.mint.step as StepId);
      expect(m.mint.tools).toEqual(def?.contract.tools);
      expect(m.mint.lane).toBe('L4');
    }
    const item = await readItem(s.record.pool, rig.itemId);
    expect(item?.state.proposed_lane).toBe('L4');
    expect(item?.state.lane).toBe('L4');
    // the same inputs to the context builder give the same text and hash: nothing in it is random
    const again = buildContext({
      agent_id: 'A3',
      purpose: 'item',
      merged_sha: MERGED,
      policy: [{ text: 'x' }],
      intent: null,
      artefacts: [{ type: 'request', sha256: sha256Hex(REQUEST_TEXT), text: REQUEST_TEXT }],
    });
    expect(again.pieces.find((p) => p.level === 6)?.tags).toContain('lint_flagged');
  });

  it('an output that cites a commit that is not the merged head is refused as not grounded', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const stale = {
      ...(OUTPUTS['2.1'] as Record<string, unknown>),
      citations: [{ path: 'src/audit.ts', commit_sha: 'c'.repeat(40) }],
    };
    provider.on('2.1', reply(stale));
    await runItem(s, rig.d, rig.itemId, { stop: (st) => st.underlying === 'S3' });
    const p = (await proposals(rig.itemId)).filter((x) => x.body.step === '2.1');
    expect(p[0]?.body).toMatchObject({ status: 'rejected' });
    expect(p[0]?.body.reasons).toContainEqual({
      path: 'citations[0].commit_sha',
      code: 'not_grounded',
    });
    expect(p[1]?.body.status).toBe('accepted');
  });
});
