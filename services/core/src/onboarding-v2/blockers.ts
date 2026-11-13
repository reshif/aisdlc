import {
  S0_EVENT,
  S0CardRequiredPayload,
  OnboardingBlockers,
  gatePolicy,
  levelRank,
  type PrincipalId,
  type SignoffFeasibility,
  type Tier,
  type TwoPerson,
} from '@aisdlc/contracts';
import { signoffFeasibility } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import { explainS0, type ExplainInput } from '@aisdlc/onboarding';
import { lightFloorsOf } from '../cards/floors.js';
import type { CardDeps } from '../cards/model.js';
import { latestProbe } from '../cards/probe.js';
import { loadS0, s0Cards } from '../cards/read.js';
import { c1Context, c4Context, maxTier } from '../cards/views.js';
import { coreError, type CoreError } from '../errors.js';
import { latestProposal } from './agent.js';
import { liveCards, onboardingSummary } from './summary.js';

// "Why is it stuck" for one S0 record (onboarding console P0): reads what the record, knowledge and the code host say
// now and hands it to the pure `explainS0`. A read: nothing is written, nothing is decided.

const DEFAULT_TWO_PERSON = (tier: Tier): TwoPerson => ({
  enabled: true,
  default: 'on_if_2plus',
  locked_on: tier === 'T2',
});

/**
 * Whether the onboarding signer gate could be decided at `tier` by who holds the m4 slot in `roleMap`, for this
 * requester. `null` when the map names nobody by principal (the code-owners form is only valid for g4).
 */
export function signoffOf(i: {
  readonly tier: Tier;
  readonly twoPerson: TwoPerson | null;
  readonly m4: ReadonlyArray<PrincipalId> | null;
  readonly requester: PrincipalId | null;
}): SignoffFeasibility | null {
  if (i.m4 === null) return null;
  return signoffFeasibility({
    tier: i.tier,
    twoPerson: i.twoPerson ?? DEFAULT_TWO_PERSON(i.tier),
    holders: i.m4,
    requester: i.requester,
  });
}

export async function onboardingBlockers(
  d: Pick<CardDeps, 'pool'> & CardDeps,
  s0Id: string,
): Promise<Result<OnboardingBlockers, CoreError>> {
  const loaded = await loadS0(d.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const { s0 } = loaded;
  const cards = await s0Cards(d.pool, s0Id);
  const live = liveCards(loaded, cards);
  const requested = loaded.events.find((e) => e.type === S0_EVENT.requested);
  const requestedBy = ((requested?.payload as { requested_by?: string } | undefined)
    ?.requested_by ?? 'unknown') as PrincipalId;
  const censusReady = s0.census !== null;
  const proposal = s0.census ? await latestProposal(d.pool, s0Id, s0.census.census_hash) : null;
  const light = levelRank(s0.record.requested_level) >= levelRank('light');

  let blockersOpen: string[] = [];
  let floor: Tier | null = null;
  if (s0.census) {
    const c1 = await c1Context(d, loaded);
    if (c1.ok) {
      floor = c1.value.floor;
      blockersOpen = c1.value.census.blockers
        .filter((b) => b.status === 'blocked' || b.status === 'unknown')
        .map((b) => b.id);
    }
  }

  let controlsOpen: string[] | null = null;
  let signoff: SignoffFeasibility | null = null;
  if (s0.census) {
    const raised = [...loaded.events]
      .reverse()
      .find(
        (e) =>
          e.type === S0_EVENT.card_required && S0CardRequiredPayload.parse(e.payload).card === 'C4',
      );
    const reduced = raised
      ? S0CardRequiredPayload.parse(raised.payload).reduced
      : s0.record.requested_level === 'census';
    const c4 = await c4Context(d, loaded, cards, requestedBy, reduced);
    if (c4.ok) {
      controlsOpen = [...c4.value.report.blocking_open];
      const map = c4.value.current?.settings.role_map ?? c4.value.proposal.role_map;
      const m4 = map[gatePolicy('M4').slot];
      signoff = signoffOf({
        tier: maxTier(c4.value.tier, floor),
        twoPerson: c4.value.current?.settings.two_person ?? null,
        m4: m4?.kind === 'principals' ? m4.principals : null,
        requester: requestedBy,
      });
    }
  }

  const findings = s0.census ? await d.knowledge.openFindings(s0.repo) : null;
  let floors: ExplainInput['floors'] = null;
  let probe: ExplainInput['probe'] = null;
  if (s0.census && light) {
    const f = await lightFloorsOf(d, s0Id);
    floors = f.ok ? f.value : null;
    const latest = await d.knowledge.census(s0.repo);
    const head =
      latest.ok && latest.value && latest.value.census_hash === s0.census.census_hash
        ? { census_hash: s0.census.census_hash, baseline_sha: latest.value.census.baseline_sha }
        : undefined;
    const p = head ? await latestProbe(d.pool, s0Id, head) : null;
    probe = p ? { outcome: p.result.outcome, detail: p.result.detail ?? null } : null;
  }

  const sum = s0.census ? await onboardingSummary({ cards: d }, s0Id, null) : null;
  const fixes = sum && sum.ok ? sum.value.fixes : [];
  const reading = explainS0({
    status: s0.record.status,
    requested_level: s0.record.requested_level,
    census_ready: censusReady,
    census_blockers_open: blockersOpen,
    open_secret_findings: !s0.census ? 0 : findings && findings.ok ? findings.value.length : null,
    cards: live.map(({ card, live: l }) => ({
      card: card.kind,
      status: card.state.status,
      live: l,
      finding_id: card.finding_id ?? null,
      card_id: card.card_id,
    })),
    fixes: fixes.map((f) => ({
      title: f.title,
      state: f.state,
      approval: f.approval ? { card_id: f.approval.card_id, status: f.approval.status } : null,
    })),
    controls_blocking_open: controlsOpen,
    floors,
    probe,
    signoff,
    proposal_ready: proposal !== null,
  });
  return ok(OnboardingBlockers.parse({ s0_id: s0Id, ...reading }));
}
