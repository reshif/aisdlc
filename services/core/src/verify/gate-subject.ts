import { readReleaseSetting } from '@aisdlc/config';
import { specHashOf } from '@aisdlc/build';
import {
  G4Review,
  G4_REVIEW_FACT,
  G5_FACTS_KEY,
  G6Acceptance,
  G6_ACCEPTANCE_FACT,
  GATE_NEEDED_FACT,
  GateArtefactRef,
  GateNeededDetail,
  ReleaseBinding,
  VERIFY_CHECK_OF_STEP,
  VERIFY_STEPS,
  foldReleaseStatus,
  gateRelayStream,
  type AcceptanceSubject,
  type ChangedPathView,
  type EvidencePackSignedPayload,
  type GateId,
  type GateSubjectView,
  type MergeReviewSubject,
  type MergeReviewUnitView,
  type OracleDeviationSubject,
  type PullRequestLink,
  type ReleaseStatus,
  type ReleaseSubject,
  type StepId,
  type StepStatusView,
} from '@aisdlc/contracts';
import { readGateState, readOpened } from '@aisdlc/decisions';
import { hashCanonical } from '@aisdlc/kernel';
import { DEFAULT_PROTECTED_GLOBS, matchesAny } from '@aisdlc/tripwires';
import { catalogueOfItem, effectiveLimit, type ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { z } from 'zod';
import { listPullRequests } from '../build/push.js';
import { stageGateNeededOf } from '../gate-needed.js';
import { artefactByHash, latestArtefact } from '../planning/store.js';
import { latestG5 } from '../release/binding.js';
import { DEFAULT_REVIEW_SENSITIVE_GLOBS, changedPaths, readG4Standing } from '../review/g4.js';
import { listEvidencePacks } from './evidence.js';
import { packSummaryOf, recordedResults } from './portal.js';

// The subject facts of G4, G5, G6, X1 and G3o for the portal (P1-3, P1-7, P1-8 of the portal review). Each is read
// from what the gate's own facts bind (the G4 review, the G5 binding, the G6 acceptance, the stage's gate-needed
// detail) and the record around it: the PRs, the recorded packs, the S7 results of each head, the push intents' paths,
// gate-relay's stream, the intent and oracle-spec artefacts. A fact the record does not have is said to be unknown,
// never filled in. Nothing here decides; the bff cuts the texts to the person's data class.

/** The code host's web page of a pull request (GitHub's; the factory's code host is GitHub). */
export const pullRequestUrl = (repo: string, n: number): string =>
  `https://github.com/${repo}/pull/${n}`;

type Recorded = Awaited<ReturnType<typeof recordedResults>>;
type Pull = Awaited<ReturnType<typeof listPullRequests>>[number];

function linkOf(repo: string, n: number, pulls: readonly Pull[]): PullRequestLink {
  const p = pulls.find((x) => x.number === n && x.repo.toLowerCase() === repo.toLowerCase());
  return {
    repo: (p?.repo ?? repo) as never,
    number: n,
    head_ref: p?.head_ref ?? null,
    state: p?.state === 'open' || p?.state === 'closed' ? p.state : null,
    url: pullRequestUrl(p?.repo ?? repo, n),
  };
}

/** Each S7 step of a head as its newest result reads (`raised` when it raised a gate; none: `not_run`). */
function stepsOf(all: Recorded, head: string): StepStatusView[] {
  return VERIFY_STEPS.map((step) => {
    const r = all.filter((x) => x.result.head_sha === head && x.result.step === step).at(-1);
    return {
      step,
      check: VERIFY_CHECK_OF_STEP[step],
      status: r === undefined ? 'not_run' : r.result.raised !== null ? 'raised' : r.result.verdict,
    };
  });
}

const packOf = (packs: readonly EvidencePackSignedPayload[], sha: string) => {
  const p = packs.filter((x) => x.pack_sha256 === sha).at(-1);
  return p ? packSummaryOf(p) : null;
};

export interface SubjectInput {
  readonly pool: pg.Pool;
  readonly item: ItemState;
  readonly gate: GateId;
  readonly gate_instance_id: string;
  readonly step: StepId | null;
  readonly facts: unknown;
}

/** The subject view of a G4, G5, G6, X1 or G3o card; `null` for any other gate (or a G4 with no review in its facts). */
export async function gateSubjectOf(i: SubjectInput): Promise<GateSubjectView | null> {
  const facts = (i.facts ?? {}) as Record<string, unknown>;
  switch (i.gate) {
    case 'G4':
      return mergeReview(i, facts);
    case 'G5':
      return release(i, facts);
    case 'G6':
      return acceptance(i, facts);
    case 'X1':
      return irreversible(i, facts);
    case 'G3o':
      return oracleDeviation(i, facts);
    default:
      return null;
  }
}

// ---------------------------------------------------------------- G4

const MAX_PATHS = 500;

async function mergeReview(
  i: SubjectInput,
  facts: Record<string, unknown>,
): Promise<MergeReviewSubject | null> {
  const parsed = G4Review.safeParse(facts[G4_REVIEW_FACT]);
  if (!parsed.success) return null;
  const review = parsed.data;
  const s = i.item;
  const [pulls, packs, all] = await Promise.all([
    listPullRequests(i.pool, s.item_id),
    listEvidencePacks(i.pool, s.item_id),
    recordedResults(i.pool, s.item_id),
  ]);
  const perUnit = await Promise.all(
    review.units.map((u) => changedPaths(i.pool, s.item_id, u.unit_key, u.head_sha)),
  );
  // the paths shown must be the paths the review bound (their hash): otherwise they are unknown, never guessed
  const union = perUnit.some((p) => p === null)
    ? null
    : [...new Set(perUnit.flatMap((p) => p ?? []))].sort();
  const same = union !== null && hashCanonical(union) === review.changed_paths.sha256;
  const sensitive = new Set(review.sensitive_paths);
  const flag = (path: string): ChangedPathView => ({
    path,
    sensitive: sensitive.has(path) || matchesAny(path, DEFAULT_REVIEW_SENSITIVE_GLOBS),
    protected: matchesAny(path, DEFAULT_PROTECTED_GLOBS),
  });
  const units: MergeReviewUnitView[] = review.units.map((u, n) => {
    const paths = same ? [...(perUnit[n] ?? [])].sort() : null;
    return {
      unit_key: u.unit_key,
      head_sha: u.head_sha,
      base_sha: u.base_sha,
      pack_sha256: u.pack_sha256,
      pr: linkOf(s.repo, u.pr_number, pulls),
      pack: packOf(packs, u.pack_sha256),
      steps: stepsOf(all, u.head_sha),
      paths: paths === null ? null : paths.slice(0, MAX_PATHS).map(flag),
      paths_truncated: paths !== null && paths.length > MAX_PATHS,
    };
  });
  const st = await readG4Standing(i.pool, s.item_id);
  const g = await readGateState(i.pool, i.gate_instance_id);
  const standing =
    st.gate_instance_id === i.gate_instance_id
      ? st.state
      : g?.status === 'pending'
        ? 'pending'
        : g?.status === 'decided' && g.outcome === 'request_changes'
          ? 'changes_requested'
          : g?.status === 'decided' && g.outcome === 'reject'
            ? 'rejected'
            : 'ended';
  // B13 under the item's PINNED catalogue (the engine counts it the same way: `countEdge`)
  const cat = catalogueOfItem(s);
  const lim = cat.back_edge_limits.B13;
  const l = lim.kind === 'limited' ? lim.limits[0] : undefined;
  const limit = l === undefined ? null : effectiveLimit(cat, l);
  const used = l === undefined ? 0 : (s.rework.by_loop[`B13:${l.key}`] ?? 0);
  return {
    kind: 'merge_review',
    review,
    units,
    standing,
    b13: {
      used,
      limit,
      left: limit === null ? null : Math.max(0, limit - used),
      exhausted_to: lim.kind === 'limited' && lim.then !== null ? String(lim.then) : null,
    },
  };
}

// ---------------------------------------------------------------- G5

async function relayStatus(pool: pg.Pool, itemId: string, gateId: string): Promise<ReleaseStatus> {
  const ev = await pool.query<{ type: string; body: unknown }>(
    'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
    [gateRelayStream(itemId)],
  );
  return foldReleaseStatus(ev.rows, gateId);
}

async function release(i: SubjectInput, facts: Record<string, unknown>): Promise<ReleaseSubject> {
  const s = i.item;
  const b = ReleaseBinding.safeParse(facts[G5_FACTS_KEY]);
  const binding = b.success ? b.data : null;
  const [now, pulls, packs, all, st] = await Promise.all([
    readReleaseSetting(i.pool, s.project_id),
    listPullRequests(i.pool, s.item_id),
    listEvidencePacks(i.pool, s.item_id),
    recordedResults(i.pool, s.item_id),
    relayStatus(i.pool, s.item_id, i.gate_instance_id),
  ]);
  const setting = now.state === 'ok' ? now.value : null;
  const bound = binding?.status === 'bound' ? binding : null;
  const target_changed =
    bound !== null && !(setting?.mode === 'target' && setting.environment === bound.environment);
  const marker = 'marker' in st ? st.marker : null;
  return {
    kind: 'release',
    binding,
    target_now: { state: now.state === 'ok' ? 'ok' : 'unreadable', setting },
    target_changed,
    pr: bound ? linkOf(bound.repo, bound.pr_number, pulls) : null,
    pack: bound ? packOf(packs, bound.pack_sha256) : null,
    steps: bound ? stepsOf(all, bound.pack_head_sha) : [],
    deployment: {
      state: st.state,
      refusal: st.state === 'refused' ? st.reason : null,
      marker: marker
        ? {
            marker_id: marker.marker_id,
            environment: marker.environment,
            merged_sha: marker.merged_sha,
            deployment_id: marker.deployment_id,
            created_at: marker.created_at,
          }
        : null,
      rollback_marker_id: st.state === 'unhealthy' ? st.rollback_marker_id : null,
    },
  };
}

// ---------------------------------------------------------------- G6

const IntentContent = z.looseObject({
  goal: z.string().optional(),
  acceptance_criteria: z.array(z.string()).optional(),
  non_goals: z.array(z.string()).optional(),
});

const ArtefactFacts = z.looseObject({ artefacts: z.array(GateArtefactRef).optional() });

/** The artefact of a type the newest approved gate among `gates` bound, with that gate; else `null`. */
async function boundByApproved(
  pool: pg.Pool,
  s: ItemState,
  gates: readonly GateId[],
  type: string,
): Promise<{ sha256: string; gate_instance_id: string } | null> {
  const approved = s.gates.filter(
    (g) => gates.includes(g.gate) && g.status === 'decided' && g.outcome === 'approve',
  );
  for (const g of [...approved].reverse()) {
    const o = await readOpened(pool, g.gate_instance_id);
    const f = ArtefactFacts.safeParse(o?.payload.facts);
    const ref = (f.success ? (f.data.artefacts ?? []) : []).find((r) => r.type === type);
    if (ref) return { sha256: ref.sha256, gate_instance_id: g.gate_instance_id };
  }
  return null;
}

async function acceptance(
  i: SubjectInput,
  facts: Record<string, unknown>,
): Promise<AcceptanceSubject> {
  const s = i.item;
  const a = G6Acceptance.safeParse(facts[G6_ACCEPTANCE_FACT]);
  // the intent the requester's G0/G1 approved; else the newest intent block (not bound: said so)
  const bound = await boundByApproved(i.pool, s, ['G0', 'G1'], 'intent_block');
  const loaded = bound
    ? await artefactByHash(i.pool, s.item_id, bound.sha256)
    : await latestArtefact(i.pool, s.item_id, 'intent_block');
  const sha = bound?.sha256 ?? loaded?.row.sha256 ?? null;
  const content = IntentContent.safeParse(loaded?.content);
  const c = content.success ? content.data : {};
  const [pulls, packs, all, g5] = await Promise.all([
    listPullRequests(i.pool, s.item_id),
    listEvidencePacks(i.pool, s.item_id),
    recordedResults(i.pool, s.item_id),
    latestG5(i.pool, s.item_id),
  ]);
  const merged = pulls.map((p) => {
    const pack = packs.filter((x) => x.head_sha === p.head_sha && x.passing).at(-1);
    return {
      unit_key: p.unit_key as never,
      pr: linkOf(p.repo, p.number, pulls),
      head_sha: p.head_sha as never,
      pack: pack ? packSummaryOf(pack) : null,
      steps: stepsOf(all, p.head_sha),
    };
  });
  let rel: AcceptanceSubject['release'] = null;
  if (g5) {
    const b = ReleaseBinding.safeParse(
      (g5.state.open.payload.facts as Record<string, unknown> | undefined)?.[G5_FACTS_KEY],
    );
    const st = await relayStatus(i.pool, s.item_id, g5.gate_instance_id);
    rel = {
      environment: b.success && b.data.status === 'bound' ? b.data.environment : null,
      state: st.state,
    };
  }
  return {
    kind: 'acceptance',
    acceptance: a.success ? a.data : null,
    intent:
      sha === null
        ? null
        : {
            sha256: sha as never,
            bound_by: bound ? `gate:${bound.gate_instance_id}` : null,
            intact: loaded !== null,
            goal: loaded ? (c.goal ?? '').slice(0, 1000) : null,
            acceptance_criteria: (loaded ? (c.acceptance_criteria ?? []) : [])
              .slice(0, 30)
              .map((x) => x.slice(0, 500)),
            non_goals: (loaded ? (c.non_goals ?? []) : []).slice(0, 20).map((x) => x.slice(0, 500)),
            withheld: false,
          },
    merged,
    release: rel,
  };
}

// ---------------------------------------------------------------- X1

async function irreversible(
  i: SubjectInput,
  facts: Record<string, unknown>,
): Promise<GateSubjectView> {
  const d = GateNeededDetail.safeParse(facts[GATE_NEEDED_FACT]);
  const raised =
    i.step === null ? null : await stageGateNeededOf(i.pool, i.item.item_id, 'X1', i.step);
  return {
    kind: 'irreversible_operation',
    reason_code: raised?.reason_code.slice(0, 64) ?? null,
    operation: d.success && d.data.kind === 'irreversible_operation' ? d.data : null,
    command_withheld: false,
  };
}

// ---------------------------------------------------------------- G3o

const OracleSpecs = z.looseObject({
  oracles: z.array(
    z.looseObject({
      oracle_id: z.string(),
      requirement_id: z.string().optional(),
      description: z.string().optional(),
      expected_failure: z.string().optional(),
    }),
  ),
});

async function oracleDeviation(
  i: SubjectInput,
  facts: Record<string, unknown>,
): Promise<OracleDeviationSubject> {
  const s = i.item;
  const d = GateNeededDetail.safeParse(facts[GATE_NEEDED_FACT]);
  const detail = d.success && d.data.kind === 'oracle_deviation' ? d.data : null;
  const raised = i.step === null ? null : await stageGateNeededOf(i.pool, s.item_id, 'G3o', i.step);
  const bound = await boundByApproved(i.pool, s, ['G2'], 'oracle_specs');
  const loaded = bound
    ? await artefactByHash(i.pool, s.item_id, bound.sha256)
    : await latestArtefact(i.pool, s.item_id, 'oracle_specs');
  const specs = OracleSpecs.safeParse(loaded?.content);
  const oracles = (specs.success ? specs.data.oracles : []).slice(0, 100).map((o) => ({
    oracle_id: o.oracle_id.slice(0, 64),
    requirement_id: o.requirement_id ? o.requirement_id.slice(0, 128) : null,
    spec_sha256: specHashOf({
      oracle_id: o.oracle_id,
      requirement_id: o.requirement_id ?? '',
      description: o.description ?? '',
      expected_failure: o.expected_failure ?? '',
    }) as never,
    description: o.description?.slice(0, 2000) ?? null,
    expected_failure: o.expected_failure?.slice(0, 2000) ?? null,
  }));
  const deviations = detail?.deviations ?? [];
  const known = detail !== null;
  const ids = new Set(oracles.map((o) => o.oracle_id));
  const diff: OracleDeviationSubject['diff'] = [];
  for (const o of oracles) {
    const mine = deviations.filter((x) => x.oracle_id === o.oracle_id);
    if (mine.length === 0) {
      diff.push({ oracle_id: o.oracle_id, path: null, status: known ? 'as_approved' : 'unknown' });
    } else {
      for (const x of mine) diff.push({ oracle_id: o.oracle_id, path: x.path, status: x.kind });
    }
  }
  for (const x of deviations) {
    if (x.oracle_id !== null && ids.has(x.oracle_id)) continue;
    diff.push({ oracle_id: x.oracle_id, path: x.path, status: x.kind });
  }
  return {
    kind: 'oracle_deviation',
    reason_code: raised?.reason_code.slice(0, 64) ?? null,
    chained_from: i.step !== null && i.step !== '6.3' && raised === null ? 'E6' : null,
    approved: {
      gate_instance_id: bound?.gate_instance_id ?? null,
      sha256: (bound?.sha256 ?? loaded?.row.sha256 ?? null) as never,
      intact: loaded !== null,
      oracles,
    },
    diff: diff.slice(0, 200),
    deviations_known: known,
    text_withheld: false,
  };
}
