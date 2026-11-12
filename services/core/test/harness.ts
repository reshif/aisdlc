import { S0_EVENT, s0Stream, type CardPayloadItem } from '@aisdlc/contracts';
import type { FakeStepUp } from '@aisdlc/decisions';
import type { FakeGitHub } from '@aisdlc/ports';
import { expect } from 'vitest';
import {
  FakeKnowledge,
  FakePrincipalLinks,
  cardDetail,
  decideOnboardingCard,
  driveS0,
  listCards,
  loadS0,
  prepareOnboardingCard,
  recordOnboardingEvidence,
  requestOnboarding,
  syncCards,
  type CardDeps,
} from '../src/index.js';
import {
  cardDeps,
  driverDeps,
  pid,
  pr,
  request,
  setSlots,
  type CoreStack,
} from '../src/testing.js';
import { cardHost, censusFixture, type CensusOptions, type HostOptions } from './cards-fixtures.js';

// The harness of the M7.4 to M7.6 tests: a project's onboarding driven through the real driver, the
// real cards, the real decision kernel and ledger, to the point a test cares about. The code host
// and knowledge are fakes behind their ports. One process-wide counter keeps projects apart.

// The views are JSON documents of the portal; they are asserted field by field.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

let n = 0;
export interface Scn {
  readonly s0: string;
  readonly project: string;
  readonly repo: string;
  readonly host: FakeGitHub;
  readonly knowledge: FakeKnowledge;
  readonly links: FakePrincipalLinks;
  readonly deps: CardDeps;
  readonly census: ReturnType<typeof censusFixture>;
  /** The intake's answer (`bootstrap` says whether a provisional admin was granted). */
  readonly intake: Awaited<ReturnType<typeof requestOnboarding>> & { ok: true };
  drive(): Promise<string>;
}

export interface ScenarioOptions {
  readonly level?: 'census' | 'light' | 'full';
  readonly census?: CensusOptions;
  readonly host?: HostOptions;
  readonly findings?: number;
  /** Who holds each slot for the FakeEligibility (the decision kernel's port); default: alice everywhere. */
  readonly slots?: Parameters<typeof setSlots>[2] | 'none';
  readonly tier?: 'T0' | 'T1' | 'T2' | null;
  /** The project id to use (default a fresh one). */
  readonly project?: string;
  readonly repo?: string;
  /** Turns on the bootstrap decider in the card layer. */
  readonly bootstrap?: boolean;
  readonly requester?: string;
  readonly attestations?: NonNullable<Parameters<typeof request>[0]>['attestations'];
}

export function makeHarness(stack: () => CoreStack, prefix: string) {
  const s = (): CoreStack => stack();

  async function scenario(o: ScenarioOptions = {}): Promise<Scn> {
    n += 1;
    const project = o.project ?? `${prefix}-${n}`;
    const repo = o.repo ?? `acme/${prefix}-${n}`;
    if (o.slots !== 'none') {
      setSlots(
        s(),
        project,
        o.slots ?? { admin: ['alice'], sec: ['alice'], m4: ['alice'], intent: ['alice'] },
        o.tier === undefined ? 'T1' : o.tier,
      );
    }
    const host = cardHost(repo, o.host);
    const census = censusFixture(repo, o.census);
    const b1 = census.census.blockers.find((b) => b.id === 'B1')?.status === 'blocked';
    const knowledge = new FakeKnowledge().withCensus((_r, jobId) => ({
      census_id: census.census_id,
      census_hash: census.census_hash,
      job_id: jobId,
      b1_blocked: b1,
      secrets_not_met: b1,
    }));
    knowledge.setCensusRecord(repo, census);
    knowledge.auto = 'done';
    if (o.findings) knowledge.addFindings(repo, o.findings);
    const links = new FakePrincipalLinks().link('alice-gh', 'alice').link('bob-gh', 'bob');
    const r = await requestOnboarding(
      s().deps,
      request({
        project_id: pid(project),
        repo,
        level: o.level ?? 'census',
        on_behalf_of: pr(o.requester ?? 'alice'),
        ...(o.attestations ? { attestations: o.attestations } : {}),
      }),
      // Full is only a level-up of a Light repo (user decision 2026-11-12): a Full scenario stands for that path
      o.level === 'full' ? { levelUp: { from_version: 1, from_level: 'light' } } : {},
    );
    if (!r.ok) throw new Error(r.error.message);
    const s0 = r.value.s0_id;
    const d = driverDeps(s(), host, knowledge);
    return {
      s0,
      project,
      repo,
      host,
      knowledge,
      links,
      census,
      intake: r as never,
      deps: cardDeps(s(), host, knowledge, {
        links,
        ...(o.bootstrap ? { bootstrap: true } : {}),
      }),
      async drive() {
        for (let i = 0; i < 8; i++) {
          await driveS0(d, s0);
          if ((await loadS0(s().record.pool, s0))?.s0.record.status === 'card') break;
        }
        return (await loadS0(s().record.pool, s0))?.s0.record.status ?? 'gone';
      },
    };
  }

  const sync = async (c: Scn) => {
    const r = await syncCards(c.deps, c.s0);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const summaries = async (c: Scn) => {
    const r = await listCards(c.deps, c.s0);
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  /** The one actionable card of `kind`. */
  async function actionable(c: Scn, kind: string) {
    const hit = (await summaries(c)).filter((x) => x.card === kind && x.actionable);
    if (hit.length !== 1) throw new Error(`${hit.length} actionable ${kind} cards`);
    return hit[0] as (typeof hit)[number];
  }
  const detail = async (
    c: Scn,
    cardId: string,
  ): Promise<{
    view: Json;
    evidence_hash: string;
    deciders: Json;
    m4_deciders: Json;
    decision_schema: Json;
    summary: Json;
  }> => {
    const r = await cardDetail(c.deps, cardId);
    if (!r.ok) throw new Error(r.error.message);
    return r.value as never;
  };

  /** prepare, evidence viewed, decide: what the portal does for one person (a step-up proof where M4 needs one). */
  async function decideAs(
    c: Scn,
    cardId: string,
    principal: string,
    decision: string,
    content?: unknown,
    reason?: string,
    o: { stepUpFor?: string } = {},
  ) {
    const p = await prepareOnboardingCard(c.deps, { card_id: cardId, principal: pr(principal) });
    if (!p.ok) return p;
    const e = await recordOnboardingEvidence(c.deps, {
      nonce: p.value.nonce,
      evidence_hash: p.value.evidence_hash,
    });
    if (!e.ok) return e;
    const stepUp = p.value.step_up?.required
      ? {
          proof: (s().config.stepUp as FakeStepUp).issue(
            o.stepUpFor ?? p.value.step_up.bound_hash,
            principal,
          ),
        }
      : undefined;
    return decideOnboardingCard(c.deps, {
      card_id: cardId,
      principal: pr(principal),
      nonce: p.value.nonce,
      decision,
      ...(content === undefined ? {} : { content }),
      ...(reason === undefined ? {} : { reason }),
      ...(stepUp ? { step_up: stepUp } : {}),
    });
  }

  const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
    if (!r.ok) throw new Error(JSON.stringify((r as never as { error: unknown }).error));
    return r as never;
  };

  /** The default content of card 1: the floor tier (T0 attested), every gap as its default. */
  function c1Content(view: Json, over: Record<string, unknown> = {}) {
    return {
      owners: ['alice'],
      tier: view.tier.floor,
      t0_attestation: true,
      gaps: view.gaps.map((g: Json) => ({ gap_id: g.gap_id, disposition: g.default_disposition })),
      ...over,
    };
  }

  function c4Content(view: Json, over: Record<string, unknown> = {}) {
    return {
      controls_report_hash: view.controls_report.report_hash,
      attestations: {
        bypass_has_no_factory_app: true,
        app_scope_selected: true,
        github_token_readonly: true,
        actions_cannot_approve_prs: true,
        fork_pr_approval_required: true,
        secret_scanning: 'on',
        plan: 'free',
      },
      role_map: view.role_map.proposed,
      two_person_enabled: true,
      gating_profile: {
        gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
        schedule: 'auto',
        tier_floor_applied: true,
      },
      kill_delegations: [],
      ...over,
    };
  }

  /** Drives to card 1 and decides it (alice by default). */
  async function throughC1(c: Scn, over: Record<string, unknown> = {}, as = 'alice') {
    expect(await c.drive()).toBe('card');
    await sync(c);
    const card = await actionable(c, 'C1');
    const d = await detail(c, card.card_id);
    const r = ok(await decideAs(c, card.card_id, as, 'approve', c1Content(d.view, over)));
    return { card, d, r };
  }
  async function throughC4(c: Scn, over: Record<string, unknown> = {}, as = 'alice') {
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C4');
    const d = await detail(c, card.card_id);
    const r = ok(await decideAs(c, card.card_id, as, 'approve', c4Content(d.view, over)));
    return { card, d, r };
  }
  /** Drives to card 5, opened. */
  async function toC5(c: Scn) {
    await c.drive();
    await sync(c);
    const card = await actionable(c, 'C5');
    return { card, d: await detail(c, card.card_id) };
  }

  const events = async (c: Scn, type: string) =>
    (
      await s().record.pool.query<{ body: Json }>(
        `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
        [s0Stream(c.s0), type],
      )
    ).rows.map((x) => x.body);
  const stateOf = async (c: Scn) =>
    (await loadS0(s().record.pool, c.s0))?.s0 as NonNullable<
      Awaited<ReturnType<typeof loadS0>>
    >['s0'];

  return {
    scenario,
    sync,
    summaries,
    actionable,
    detail,
    decideAs,
    ok,
    c1Content,
    c4Content,
    throughC1,
    throughC4,
    toC5,
    events,
    stateOf,
  };
}

export type { CardPayloadItem };
export { S0_EVENT };
