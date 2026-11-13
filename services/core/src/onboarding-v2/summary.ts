import {
  ONBOARDING_AGENT_EVENT,
  ONBOARDING_FIXES_UNIT,
  OnboardingSignOffStartedPayload,
  OnboardingSummaryView,
  S0CardRequiredPayload,
  S0_EVENT,
  gatePolicy,
  onboardingAgentStream,
  onboardingSummaryHash,
  type OnboardingSignOffStartedPayload as StartedPayload,
  type PrincipalId,
  type SignOffState,
  type SummaryFix,
} from '@aisdlc/contracts';
import { readCardState, readGateState } from '@aisdlc/decisions';
import type { ConfigDeps } from '@aisdlc/config';
import { err, ok, type Result } from '@aisdlc/kernel';
import { listPushReceipts } from '../build/push.js';
import { cardDetail } from '../cards/api.js';
import { decisionsFor, type CardDeps } from '../cards/model.js';
import { loadS0, s0Cards, type LoadedS0, type OnboardingCard } from '../cards/read.js';
import { isLive } from '../cards/sync.js';
import { c1Context, c4Context } from '../cards/views.js';
import { coreError, type CoreError } from '../errors.js';
import { prrByHash } from '../m4.js';
import { revisionOfS0 } from '../portal-reads.js';
import { gapChoices, latestProposal } from './agent.js';

// The one onboarding summary (portal v2, N12; screen-map §2.10 step 3): everything the agent found and proposes and
// everything the cards underneath will decide, on one page, read from the record and the code host. A pure read:
// nothing is written. `summary_hash` is what the one sign-off binds to.

/** The cards the one sign-off decides; the others (C3, the security card, X2) are their own approvals. */
export const SIGN_OFF_CARDS = ['C1', 'C2', 'C4', 'C5'] as const;
const bySignOff = (k: string): boolean => (SIGN_OFF_CARDS as readonly string[]).includes(k);
const ORDER: Record<string, number> = { C1: 1, C2: 2, C3: 3, C4: 4, C5: 5, SECR: 0 };

export interface SummaryDeps {
  readonly cards: CardDeps;
  /** The decision kernel of settings revisions (card 4's M1). */
  readonly config?: ConfigDeps;
}

/** The newest card of each kind, and whether the record waits for it. */
export function liveCards(loaded: LoadedS0, cards: readonly OnboardingCard[]) {
  const newest = new Map<string, OnboardingCard>();
  for (const c of cards) {
    const k = c.kind === 'SECR' ? `SECR:${c.finding_id ?? ''}` : c.kind;
    const prev = newest.get(k);
    if (!prev || prev.occurrence < c.occurrence) newest.set(k, c);
  }
  return [...newest.values()]
    .sort((a, b) => (ORDER[a.kind] ?? 9) - (ORDER[b.kind] ?? 9))
    .map((c) => ({ card: c, live: c.state.status === 'open' && isLive(loaded, c) }));
}

/** The newest sign-off this person started on the record, or `null`. */
export async function startedBy(
  d: Pick<CardDeps, 'pool'>,
  s0Id: string,
  principal?: string,
): Promise<StartedPayload | null> {
  const q = await d.pool.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2
        AND ($3::text IS NULL OR body ->> 'by' = $3) ORDER BY seq DESC LIMIT 1`,
    [onboardingAgentStream(s0Id), ONBOARDING_AGENT_EVENT.sign_off_started, principal ?? null],
  );
  const b = q.rows[0]?.body;
  return b ? OnboardingSignOffStartedPayload.parse(b) : null;
}

async function fixesOf(
  d: SummaryDeps,
  s0Id: string,
  repo: string,
  viewer: string | null,
  out: NonNullable<Awaited<ReturnType<typeof latestProposal>>>['output'] | null,
): Promise<SummaryFix[]> {
  if (!out) return [];
  const pool = d.cards.pool;
  const row = (
    await pool.query<{
      files: Array<{ path: string }>;
      x2_card_id: string | null;
      patch_hash: string;
    }>(
      `SELECT files, x2_card_id, patch_hash FROM core.onboarding_pack
        WHERE s0_id = $1 AND kind = 'fixes' ORDER BY event_gseq DESC LIMIT 1`,
      [s0Id],
    )
  ).rows[0];
  const inPatch = new Set((row?.files ?? []).map((f) => f.path));
  const receipts = row
    ? (await listPushReceipts(pool, s0Id)).filter(
        (r) => r.unit_key === ONBOARDING_FIXES_UNIT && r.patch_hash === row.patch_hash,
      )
    : [];
  const applied = receipts.find((r) => r.status === 'applied');
  const refused = receipts.find((r) => r.status !== 'applied');
  const pr = applied?.pr_number
    ? (
        await pool.query<{ state: string; head_ref: string; merged: boolean | null }>(
          `SELECT state, head_ref, NULL::boolean AS merged FROM core.pull_request
            WHERE item_id = $1 AND unit_key = $2 AND number = $3 LIMIT 1`,
          [s0Id, ONBOARDING_FIXES_UNIT, applied.pr_number],
        )
      ).rows[0]
    : undefined;
  let approval: SummaryFix['approval'] = null;
  let x2: string | null = null;
  if (row?.x2_card_id) {
    const st = await readCardState(pool, row.x2_card_id);
    const gate = st?.gates[0]?.state;
    x2 = gate ? (gate.status === 'pending' ? 'pending' : (gate.outcome ?? gate.status)) : null;
    let may = false;
    if (viewer && st) {
      const h = await decisionsFor(d.cards, s0Id).eligibility.holders(
        st.open.project_id,
        gatePolicy('X2').slot,
      );
      may = h.ok && h.value.includes(viewer as PrincipalId);
    }
    approval = { card_id: row.x2_card_id, status: x2 ?? 'unknown', may_decide: may };
  }
  return out.fixes.map((f) => {
    const paths = f.files.map((x) => x.path).filter((p) => inPatch.has(p));
    const opened = paths.length > 0;
    const state: SummaryFix['state'] = !opened
      ? 'manual'
      : applied
        ? pr?.state === 'merged'
          ? 'pr_merged'
          : pr?.state === 'closed'
            ? 'pr_closed'
            : 'pr_open'
        : refused || x2 === 'reject' || x2 === 'request_changes'
          ? 'refused'
          : x2 === 'approve'
            ? 'opening'
            : 'awaiting_approval';
    return {
      fix_id: f.fix_id,
      fix_kind: f.fix_kind,
      title: f.title,
      why: f.why,
      paths,
      manual_steps: f.manual_steps,
      state,
      pr:
        opened && applied?.pr_number
          ? {
              number: applied.pr_number,
              url: `https://github.com/${repo}/pull/${applied.pr_number}`,
              branch: applied.branch,
            }
          : null,
      approval: opened ? approval : null,
    };
  });
}

/** Builds the summary as `viewer` sees it (`may_sign` is theirs). */
export async function onboardingSummary(
  d: SummaryDeps,
  s0Id: string,
  viewer: string | null,
): Promise<Result<OnboardingSummaryView, CoreError>> {
  const deps = d.cards;
  const loaded = await loadS0(deps.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const { s0 } = loaded;
  const cards = await s0Cards(deps.pool, s0Id);
  const live = liveCards(loaded, cards);
  const requested = loaded.events.find((e) => e.type === S0_EVENT.requested);
  const requestedBy = ((requested?.payload as { requested_by?: string } | undefined)
    ?.requested_by ?? 'unknown') as PrincipalId;
  const proposal = s0.census ? await latestProposal(deps.pool, s0Id, s0.census.census_hash) : null;

  // the census and the gaps (card 1's view)
  let census: OnboardingSummaryView['census'] = null;
  if (s0.census) {
    const c1 = await c1Context(deps, loaded);
    if (c1.ok) {
      const sugg = new Map((proposal?.output.gap_suggestions ?? []).map((g) => [g.gap_id, g]));
      census = {
        census_hash: s0.census.census_hash as never,
        baseline_sha: c1.value.census.baseline_sha as never,
        posture: c1.value.census.posture.state,
        tier_floor: c1.value.floor,
        blockers_open: c1.value.census.blockers
          .filter((b) => b.status === 'blocked' || b.status === 'unknown')
          .map((b) => b.id),
        gaps: c1.value.gaps.map((g) => {
          const ch = gapChoices(g);
          const s = sugg.get(g.gap_id);
          const suggested = s && ch.allowed.includes(s.disposition) ? s.disposition : ch.default;
          return {
            gap_id: g.gap_id,
            criterion: g.criterion,
            severity: g.severity,
            allowed: ch.allowed,
            suggested,
            why: s?.why ?? null,
          };
        }),
      };
    }
  }

  // the controls and the role map (card 4's context; read from the code host now)
  let controls: OnboardingSummaryView['controls'] = null;
  let roleMap: OnboardingSummaryView['role_map'] = null;
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
    const c4 = await c4Context(deps, loaded, cards, requestedBy, reduced);
    if (c4.ok) {
      const r = c4.value.report;
      controls = {
        report_hash: r.report_hash as never,
        blocking_open: [...r.blocking_open],
        rows: r.controls.map((c) => ({
          id: c.id,
          status: c.status,
          blocking: c.blocking,
          instruction: c.instruction,
        })),
        attestations_required: [
          'bypass_has_no_factory_app',
          'app_scope_selected',
          'github_token_readonly',
          'actions_cannot_approve_prs',
          'fork_pr_approval_required',
          'secret_scanning',
          'plan',
          ...(c4.value.level_needs_operations ? ['operations_md'] : []),
        ],
        operations_md: c4.value.level_needs_operations,
      };
      roleMap = {
        proposed: c4.value.current?.settings.role_map ?? c4.value.proposal.role_map,
        unmapped_logins: [...c4.value.proposal.basis.unmapped_logins],
        tier: c4.value.tier,
      };
    }
  }

  // card 2's proposal (Light), when its card is open
  let light: OnboardingSummaryView['light'] = null;
  const c2 = live.find((x) => x.card.kind === 'C2' && x.live);
  if (c2) {
    const det = await cardDetail(deps, c2.card.card_id);
    if (det.ok)
      light = { card_id: c2.card.card_id, ...(det.value.view as Record<string, unknown>) };
  }

  // the readiness scorecard card 5 will sign
  let prr: OnboardingSummaryView['readiness']['prr'] = null;
  const c5 = live.find((x) => x.card.kind === 'C5');
  const c5Hash = c5?.card.state.gates[0]?.state.open.payload.subject_hash;
  if (c5Hash) {
    const found = await prrByHash(deps.pool, s0.record.project_id, s0.record.repo_id, c5Hash);
    if (found) {
      prr = {
        record_hash: found.prr.record_hash as never,
        composite: found.prr.composite,
        pillars: found.prr.pillars.map((p) => ({ pillar: p.pillar, level: p.level })),
        lanes: [...found.prr.autonomy.lanes_eligible],
      };
    }
  }

  const fixes = await fixesOf(d, s0Id, s0.repo, viewer, proposal?.output ?? null);
  const so = await signOffStateOf(d, loaded, live, viewer, proposal !== null);

  const view = {
    s0_id: s0Id as never,
    project_id: s0.record.project_id,
    repo: s0.repo as never,
    status: s0.record.status,
    requested_level: s0.record.requested_level,
    signable_level: s0.record.signable_level,
    steps: [...s0.steps]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([step, p]) => ({ step, state: p.state, cause: p.blocked_cause ?? null })),
    waiting: s0.waiting ?? null,
    agent: proposal
      ? {
          output_hash: proposal.output_hash as never,
          model: proposal.model,
          proposed_at: proposal.proposed_at,
          summary: proposal.output.summary,
          learned: proposal.output.learned.map((l) => ({
            topic: l.topic,
            status: l.status,
            text: l.text,
            evidence: l.evidence.map((e) => `${e.path}${e.lines ? `:${e.lines}` : ''}`),
          })),
          claims: proposal.output.claims.map((c) => ({
            claim_id: c.claim_id,
            text: c.text,
            confidence: c.confidence,
            evidence: c.evidence.map((e) => `${e.path}${e.lines ? `:${e.lines}` : ''}`),
          })),
          questions: [...proposal.output.questions],
          dropped: proposal.dropped.length,
        }
      : null,
    fixes,
    census,
    controls,
    role_map: roleMap,
    light,
    readiness: { level: s0.record.signable_level, prr },
    cards: live.map(({ card, live: l }) => ({
      card: card.kind,
      card_id: card.card_id,
      status: card.state.status,
      live: l,
      by_sign_off: bySignOff(card.kind),
    })),
    sign_off: so,
    summary_hash: '0'.repeat(64) as never,
  };
  const hashed = { ...view, summary_hash: onboardingSummaryHash(view as never) as never };
  return ok(OnboardingSummaryView.parse(hashed));
}

/** Where the one sign-off stands for `viewer`, from the record alone. */
export async function signOffStateOf(
  d: SummaryDeps,
  loaded: LoadedS0,
  live: ReturnType<typeof liveCards>,
  viewer: string | null,
  proposed: boolean,
): Promise<OnboardingSummaryView['sign_off']> {
  const { s0 } = loaded;
  const s0Id = s0.record.s0_id;
  let maySign = false;
  if (viewer) {
    const h = await decisionsFor(d.cards, s0Id).eligibility.holders(
      s0.record.project_id as never,
      gatePolicy('M1').slot,
    );
    maySign = h.ok && h.value.includes(viewer as PrincipalId);
  }
  const started = viewer ? await startedBy(d.cards, s0Id, viewer) : await startedBy(d.cards, s0Id);
  const base = { may_sign: maySign, step_up: null, started_by: started?.by ?? null };
  const at = (state: SignOffState, note: string | null) => ({ ...base, state, note });
  if (s0.record.status === 'done')
    return at('done', 'Onboarded: the readiness scorecard is in force.');
  if (['rejected', 'withdrawn', 'superseded'].includes(s0.record.status)) {
    return at('closed', `The onboarding is ${s0.record.status}.`);
  }
  const c1 = live.find((x) => x.card.kind === 'C1');
  if (!proposed || !c1) {
    return at('not_ready', 'The onboarding agent is still reading the repo.');
  }
  if (!started) return at('ready', null);
  const open = live.filter((x) => x.live && bySignOff(x.card.kind));
  const c5 = open.find((x) => x.card.kind === 'C5');
  if (c5) {
    const g = c5.card.state.gates[0]?.state.open.payload;
    if (g?.step_up.required || (g?.quorum.required ?? 1) >= 2) {
      return {
        ...base,
        state: 'needs_step_up',
        note: 'Confirm it’s you to sign the readiness scorecard.',
        step_up: { bound_hash: g?.step_up.bound_hash ?? g?.subject_hash, card: 'C5' } as never,
      };
    }
  }
  if (open.length > 0) return at('in_progress', 'Signing: recording your decisions.');
  if (d.config) {
    const rev = await revisionOfS0({ pool: d.cards.pool, config: d.config }, s0Id);
    if (rev.ok && rev.value.revision && !rev.value.revision.published) {
      if (rev.value.revision.status === 'pending') {
        return at('in_progress', 'Signing: putting who decides what into force.');
      }
      const st = await readGateState(d.cards.pool, rev.value.revision.gate_instance_id);
      if (st?.outcome !== 'approve') {
        return at('waiting', 'The settings this onboarding proposed were not approved.');
      }
      return at('in_progress', 'Signing: publishing the settings.');
    }
  }
  const others = live.filter((x) => x.live && !bySignOff(x.card.kind));
  if (others.length > 0) {
    return at(
      'waiting',
      `Waiting for another approval first: ${others.map((x) => (x.card.kind === 'SECR' ? 'a secret found' : x.card.kind === 'C3' ? 'the code map and tests' : 'an approval')).join(', ')}.`,
    );
  }
  if (s0.record.status === 'blocked') {
    return at('waiting', 'Something must be fixed on GitHub first; see what a person must do.');
  }
  return at('in_progress', 'Signing: the factory is preparing the next step.');
}
