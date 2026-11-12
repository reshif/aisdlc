import { parseCodeowners } from '@aisdlc/codeowners';
import {
  G4Review,
  G4_REVIEW_FACT,
  G4_REVIEW_SCHEMA,
  GATE_EVENT,
  ITEM_EVENT,
  PUSH_EVENT,
  PushIntendedPayload,
  ReviewReason,
  pushStream,
  type Autonomy,
  type G4ReviewUnit,
  type G4StandingState,
  type GitSha,
  type PrincipalId,
} from '@aisdlc/contracts';
import { gateHolders, readGateState, type DecisionDeps } from '@aisdlc/decisions';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import type { CodeHostPort } from '@aisdlc/ports';
import type { Executor } from '@aisdlc/record';
import { DEFAULT_PROTECTED_GLOBS, DEFAULT_SENSITIVE_GLOBS } from '@aisdlc/tripwires';
import { catalogueOfItem, type ItemState } from '@aisdlc/work';
import { listPullRequests, listPushReceipts } from '../build/push.js';
import type { PrincipalLinksPort } from '../clients.js';
import { coreError, type CoreError } from '../errors.js';
import type { CoreDeps } from '../journal.js';
import { autonomyNow } from '../drift/krl.js';
import { readGoverning } from '../prr-store.js';
import { passingPackFor } from '../verify/evidence.js';
import { readItem, readItemEvents } from '../work-items.js';
import { requestRework } from '../work-signals.js';
import { readModeESuspension } from '../closeout/audit.js';
import { decideReviewMode, type ReviewModeDecision } from './mode.js';

// G4 review (FL 8.1, PLAN M15.1): what core adds to the G4 card the engine asks for. When G4 opens, core reads the
// item's pull requests, the passing Evidence Pack of exactly each head, the paths each head changed (the push intent),
// CODEOWNERS at the base, and the readiness record governing the repo now; `decideReviewMode` turns them into the
// mode and its reasons. The card then carries the review (`facts.g4_review`), binds it into its subject hash (a new
// head, a new pack or another mode is another subject), shows the pack as its evidence, needs the D37 step-up on a
// sensitive path, and in mode C is decided only by the code owners of the changed paths (the gate's `deciders`). The
// requester and whoever wrote the change by hand are barred like every gate's requester. Nothing here decides G4: the
// engine opens it, a person decides it in the ledger.

/** What core reads besides its own record to decide the review. */
export interface ReviewPorts {
  /** CODEOWNERS at a commit: the code host's read. */
  readonly source: Pick<CodeHostPort, 'codeowners'>;
  /** GitHub logins to principals (identity's `github_login` links). */
  readonly links: PrincipalLinksPort;
  /** Globs whose change is sensitive (codeowner plus step-up). Default: the sensitive and the protected globs. */
  readonly sensitive_globs?: readonly string[];
}

export const DEFAULT_REVIEW_SENSITIVE_GLOBS: readonly string[] = [
  ...new Set([...DEFAULT_SENSITIVE_GLOBS, ...DEFAULT_PROTECTED_GLOBS]),
];

/** What the G4 gate is opened with besides the engine's facts. */
export interface G4Opening {
  readonly review: G4Review;
  readonly subject_hash: string;
  readonly deciders: readonly PrincipalId[] | undefined;
  readonly authors: readonly PrincipalId[];
}

/** The changed paths of a head: the intent of the applied push that wrote it, or `null` when the record has none. */
export async function changedPaths(
  db: Executor,
  itemId: string,
  unitKey: string,
  head: string,
): Promise<string[] | null> {
  const receipt = (await listPushReceipts(db, itemId))
    .filter((r) => r.unit_key === unitKey && r.status === 'applied' && r.head_sha === head)
    .at(-1);
  if (!receipt) return null;
  const q = await db.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
    [pushStream(itemId), PUSH_EVENT.intended],
  );
  const intent = q.rows
    .map((r) => PushIntendedPayload.safeParse(r.body))
    .flatMap((p) => (p.success ? [p.data] : []))
    .filter((p) => p.unit_key === unitKey && p.patch_hash === receipt.patch_hash)
    .at(-1);
  return intent?.paths ? [...intent.paths] : null;
}

/** Who wrote the change by hand: a developer who took the item over (E4), and who said an L8 item's work is done. */
async function humanAuthors(db: Executor, s: ItemState): Promise<PrincipalId[]> {
  const out = new Set<string>();
  for (const h of s.handoffs) {
    if (h.choice === 'takeover' && h.chosen_by !== null) out.add(h.chosen_by);
  }
  for (const e of await readItemEvents(db, s.item_id)) {
    if (e.type !== ITEM_EVENT.human_work_done) continue;
    const p = e.payload as { by?: unknown; outputs?: unknown };
    // a hand-written plan (B5) is not code: its author is G3's concern
    if (typeof p.by === 'string' && p.outputs === undefined) out.add(p.by);
  }
  return [...out].sort() as PrincipalId[];
}

/**
 * The review of the item's G4 as it would open now. An error is a refusal to open (the command is delivered again):
 * no open PR, a head with no passing pack (the head moved after S7), the code host or identity not answering.
 */
export async function g4ReviewOf(
  d: Pick<CoreDeps, 'pool'>,
  ports: ReviewPorts,
  s: ItemState,
  engineSubjectHash: string,
  engineFacts: Record<string, unknown>,
): Promise<Result<G4Opening, CoreError>> {
  const prs = (await listPullRequests(d.pool, s.item_id)).filter((p) => p.state === 'open');
  if (prs.length === 0)
    return err(coreError('conflict', 'G4 needs the pull request: none is open'));

  const units: G4ReviewUnit[] = [];
  const decisions: ReviewModeDecision[] = [];
  const known: Array<string[] | null> = [];
  const unmapped = new Set<string>();
  let codeownersRead: 'ok' | 'none' | 'unreadable' = 'ok';
  let atSha: string | null = null;
  const cat = catalogueOfItem(s);
  const caps = Object.values(cat.autonomy.posture)
    .filter((p) => p.g4_mode_c && p.cap !== null)
    .map((p) => p.cap as Autonomy);
  const gov = await readGoverning(d.pool, s.repo);
  const a = gov?.governing?.prr.autonomy;
  // OB §4.2 (M16 part 3): the autonomy in force now, the signed one tightened by open KRL penalties from drift
  const now = a ? await autonomyNow(d.pool, s.repo) : null;
  const prr = a
    ? {
        effective: now?.effective_now ?? a.effective,
        posture_cap: a.posture_cap,
        r3_zones: a.r3_zones,
      }
    : null;
  const authors = await humanAuthors(d.pool, s);
  const lane = s.lane ?? s.proposed_lane;
  // B19 (M15.4): a project whose mode-E audit sample tripped reviews in mode C, with the reason
  const suspended = (await readModeESuspension(d.pool, s.project_id)) !== null;

  for (const pr of [...prs].sort((x, y) => x.unit_key.localeCompare(y.unit_key))) {
    const pack = await passingPackFor(d.pool, s.item_id, pr.head_sha);
    if (!pack || pack.unit_key !== pr.unit_key) {
      return err(
        coreError(
          'conflict',
          `PR #${pr.number} head ${pr.head_sha.slice(0, 12)} has no passing Evidence Pack: G4 binds the pack of exactly the head`,
        ),
      );
    }
    units.push({
      unit_key: pr.unit_key as never,
      pr_number: pr.number,
      head_sha: pr.head_sha as GitSha,
      base_sha: pack.base_sha,
      pack_sha256: pack.pack_sha256,
    });
    const co = await ports.source.codeowners({ repo: s.repo as never, sha: pack.base_sha });
    if (co.state === 'unknown') {
      return err(coreError('unavailable', `CODEOWNERS at ${pack.base_sha}: ${co.message}`));
    }
    atSha ??= pack.base_sha;
    const codeowners =
      co.state !== 'ok'
        ? ({ read: 'unreadable' } as const)
        : co.value === null
          ? ({ read: 'none' } as const)
          : ({ read: 'ok', parsed: parseCodeowners(co.value.content) } as const);
    if (codeowners.read === 'unreadable') codeownersRead = 'unreadable';
    else if (codeowners.read === 'none' && codeownersRead === 'ok') codeownersRead = 'none';
    const paths = await changedPaths(d.pool, s.item_id, pr.unit_key, pr.head_sha);
    known.push(paths);
    decisions.push(
      decideReviewMode({
        b14: engineFacts['review_mode'] === 'C',
        human_authored: lane === 'L8' || authors.length > 0,
        changed_paths: paths,
        sensitive_globs: ports.sensitive_globs ?? DEFAULT_REVIEW_SENSITIVE_GLOBS,
        codeowners,
        prr,
        mode_c_posture_caps: caps,
        mode_e_suspended: suspended,
      }),
    );
  }

  // One mode for the item: C when any Unit's review is C, with every reason in the contract's order.
  const order = ReviewReason.options;
  const all = new Set(decisions.flatMap((x) => x.reasons));
  const modeC = decisions.some((x) => x.mode === 'C');
  const reasons = modeC ? order.filter((r) => r !== 'evidence_sufficient' && all.has(r)) : [];
  const owners = [...new Set(decisions.flatMap((x) => x.owner_logins))].sort();
  for (const o of decisions.flatMap((x) => x.other_owners)) unmapped.add(o);

  let principals: PrincipalId[] = [];
  if (modeC && owners.length > 0) {
    const links = await ports.links.githubLogins(owners);
    if (!links.ok) return err(coreError('unavailable', `identity links: ${links.error.message}`));
    const mapped = new Set<PrincipalId>();
    for (const login of owners) {
      const p = links.value[login] ?? null;
      if (p === null) unmapped.add(login);
      else mapped.add(p);
    }
    principals = [...mapped].sort();
  }
  const allPaths = known.some((k) => k === null)
    ? null
    : [...new Set(known.flatMap((k) => k ?? []))].sort();

  const review = G4Review.parse({
    schema: G4_REVIEW_SCHEMA,
    mode: modeC ? 'C' : 'E',
    reasons: modeC ? reasons : ['evidence_sufficient'],
    units,
    evidence_sha256:
      units.length === 1 ? (units[0] as G4ReviewUnit).pack_sha256 : hashCanonical(units),
    changed_paths: {
      count: allPaths === null ? null : allPaths.length,
      sha256: allPaths === null ? null : hashCanonical(allPaths),
    },
    sensitive_paths: [...new Set(decisions.flatMap((x) => x.sensitive_paths))].sort().slice(0, 50),
    step_up: decisions.some((x) => x.step_up),
    deciders: {
      basis: principals.length > 0 ? 'path_owners' : 'g4_slot',
      principals,
    },
    codeowners: {
      read: codeownersRead,
      at_sha: atSha,
      unmapped: [...unmapped].sort().slice(0, 64),
    },
    authors,
  });
  return ok({
    review,
    subject_hash: hashCanonical({ engine: engineSubjectHash, [G4_REVIEW_FACT]: review }),
    deciders: principals.length > 0 ? principals : undefined,
    authors,
  });
}

// ---------------------------------------------------------------- Does G4 still stand?

export interface G4Standing {
  readonly state: G4StandingState;
  readonly gate_instance_id: string | null;
  readonly review: G4Review | null;
  /** The PR heads now, by Unit. */
  readonly heads: Readonly<Record<string, string>>;
}

/** The item's G4 instances, oldest first (their open events). */
async function g4Instances(db: Executor, itemId: string): Promise<string[]> {
  const q = await db.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = $1 AND seq = 1 AND body ->> 'subject_id' = $2 AND body ->> 'gate_id' = 'G4'
        AND body ->> 'subject_kind' = 'item'
      ORDER BY global_seq`,
    [GATE_EVENT.opened, itemId],
  );
  return q.rows.map((r) => r.stream.slice('gate:'.length));
}

/**
 * Whether the item's newest G4 stands for its PRs as they are now. Its status is the ledger's (`readGateState` folds
 * the decisions); an approval stands only while every PR's head is the head the approval bound: a new push is a new
 * head (`head_moved`), and the old approval does not carry over.
 */
export async function readG4Standing(db: Executor, itemId: string): Promise<G4Standing> {
  const heads = Object.fromEntries(
    (await listPullRequests(db, itemId))
      .filter((p) => p.state === 'open')
      .map((p) => [p.unit_key, p.head_sha]),
  );
  const id = (await g4Instances(db, itemId)).at(-1);
  if (id === undefined) return { state: 'none', gate_instance_id: null, review: null, heads };
  const g = await readGateState(db, id);
  const parsed = G4Review.safeParse(
    (g?.open.payload.facts as Record<string, unknown> | undefined)?.[G4_REVIEW_FACT],
  );
  const review = parsed.success ? parsed.data : null;
  const base = { gate_instance_id: id, review, heads };
  if (!g) return { state: 'none', ...base };
  if (g.status === 'pending') return { state: 'pending', ...base };
  if (g.status !== 'decided') return { state: 'ended', ...base };
  if (g.outcome === 'request_changes') return { state: 'changes_requested', ...base };
  if (g.outcome !== 'approve') return { state: 'rejected', ...base };
  // approved: of exactly these heads, or it no longer stands (a review without heads is unknown, so unmet)
  const same =
    review !== null &&
    review.units.length === Object.keys(heads).length &&
    review.units.every((u) => heads[u.unit_key] === u.head_sha);
  return { state: same ? 'approved' : 'head_moved', ...base };
}

// ---------------------------------------------------------------- B14

/**
 * B14: the mode-E approver is unsure. Only while the item's G4 is open in mode E, and only someone who may decide it
 * says so; the engine then opens the same review again, now for a codeowner (mode C), once.
 */
export async function reviewerUnsure(
  d: CoreDeps & { readonly decisions: Pick<DecisionDeps, 'eligibility'> },
  itemId: string,
  by: PrincipalId,
  key: string,
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  const item = await readItem(d.pool, itemId);
  if (!item) return err(coreError('not_found', `no item ${itemId}`));
  const st = await readG4Standing(d.pool, itemId);
  if (st.state !== 'pending' || st.gate_instance_id === null) {
    return err(coreError('conflict', 'G4 is not open'));
  }
  if (st.review?.mode !== 'E') {
    return err(coreError('conflict', 'G4 is already in mode C: a codeowner reviews it'));
  }
  const g = await readGateState(d.pool, st.gate_instance_id);
  const p = g?.open.payload;
  if (!p) return err(coreError('not_found', 'the G4 instance has no open event'));
  const holders = await gateHolders(d.decisions.eligibility, p.project_id, 'g4', p.deciders);
  if (!holders.ok) return err(coreError('unavailable', holders.error.message));
  if (!holders.value.includes(by)) {
    return err(coreError('forbidden', `${by} may not decide this G4, so cannot be unsure of it`));
  }
  const r = await requestRework(d, itemId, {
    edge: 'B14',
    step: null,
    reason_code: 'approver_unsure',
    by,
    key,
  });
  return r.ok ? ok({ duplicate: r.value.duplicate }) : r;
}
