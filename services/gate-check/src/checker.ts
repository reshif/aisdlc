import {
  EVIDENCE_BUCKET,
  GATE_CHECK_NAME,
  GateCheckVerdict,
  bypassListFor,
  checkRunOf,
  checkSignedEvidencePack,
  gateCheckVerdictHash,
  badPushBranch,
  mergeSubjectId,
  type BypassPerson,
  type EvidencePack,
  type GateCheckOutcome,
  type GateCheckProfile,
  type GateCheckReason,
  type MergeBypassConfig,
  type MergeClass,
  type MergeObservedPayload,
} from '@aisdlc/contracts';
import { catalogueFor } from '@aisdlc/catalogue';
import { hashCanonical, systemClock, type Clock, type Jwk } from '@aisdlc/kernel';
import { effectiveProfile, presentGates } from '@aisdlc/work';
import {
  repoKey,
  type GateCheckHostPort,
  type GateCheckPull,
  type ObjectStorePort,
  type PullCommit,
} from '@aisdlc/ports';
import type { FactsPort, PackRow, RepoRow } from './facts.js';
import type { GateCheckStore } from './store.js';

// The verdict of `aisdlc/gate` (PLAN M14.5; FL 8.2 "gate-check: PR head SHA == Evidence Pack SHA"; ADR-0003 "GC->>C:
// pack SHA = PR head? G3 decided?"; DEC-10 as refined, DEC-13(a)).
//
// How a PR is told apart: an AGENT PR is authored by the Push Broker's bot AND is a PR core recorded from a Push Broker
// receipt (`core.pull_request`: same repo, number and branch) AND its branch is exactly `agent/<item>/<unit>` of that
// row. A PR the broker's bot authored that core does not know is refused (`unknown_agent_pr`). Everything else is a
// person's PR (NON-AGENT).
//
//   agent                     success iff the newest pack of the item is for exactly the PR head, it is passing, its
//                             bytes verify offline with the Notary's PUBLIC key (canonical, hash, signature, head, item,
//                             object key) and bind this repo, this PR and this Unit, AND, when the item's route has G3,
//                             the item's newest G3 is decided `approve` in the ledger (and is the G3 the pack carries).
//                             "The route has G3" is the engine's own rule (`presentGates`) over the lane in the pack's
//                             PINNED catalogue (`catalogueFor(catalogue_ref)`) under the gating profile and tier the item
//                             pinned at intake (its `item.created`, checked against the pack's signed `profile_sha256`).
//                             L8's route has no G3, so L8 (DEC-10(a)) comes out of the same rule. A catalogue or pin
//                             that cannot be read is `pending`
//   s0 (repo onboarding)      never success: `action_required` (the factory's evidence does not apply; DEC-13(i))
//   non_agent                 never success: the laundering check, then `action_required` (a person reviews; only a
//                             named bypass person may merge, and that merge is recorded and reviewed, X4)
//
// Laundering (a non-agent PR passing as factory work, or borrowing an agent's evidence) is `failure`: an `agent/*`
// branch, a head or commit the Push Broker wrote, a pack id or object key cited in the title or body, the factory's
// commit trailers or PR marker. Fail closed throughout: a dependency that does not answer (the record, the object store,
// the Notary key, the PR's commit list) is `pending`, never `success`.

export const GATE_CHECK_ACTOR = 'system.gate-check';

export interface NotaryKeyPort {
  /** The Notary's public key, or `null` when it cannot be had now (no pass can be given meanwhile). */
  get(): Promise<Jwk | null>;
}

export type PackBytesPort = Pick<ObjectStorePort, 'get' | 'declareBucket'>;

export interface CheckerDeps {
  readonly host: GateCheckHostPort;
  readonly facts: FactsPort;
  readonly packs: PackBytesPort;
  readonly notaryKey: NotaryKeyPort;
  /** The Push Broker's bot login (`<slug>[bot]`): the author of every agent PR. */
  readonly brokerLogin: string;
  /** The published bypass list; `null` when it cannot be read (then nobody is on it). */
  readonly bypass: () => MergeBypassConfig | null;
  readonly store: GateCheckStore;
  /** When a repo's watch starts (default the system clock). */
  readonly clock?: Clock;
  /**
   * Portal v2: loads the catalogue's settings releases from the record (`loadSettingsReleases`), asked when a pack
   * names a catalogue this process does not know yet. Absent: an unknown catalogue stays unknown (pending).
   */
  readonly loadCatalogueReleases?: () => Promise<void>;
}

const SUMMARY: Readonly<Record<GateCheckReason, string>> = {
  passed:
    'The Evidence Pack signed for exactly this head verifies with the Notary key, and G3 is approved in the ledger. A person reviews (G4) and merges; the factory never does.',
  passed_no_g3:
    'The Evidence Pack signed for exactly this head verifies with the Notary key; the item’s route has no G3 (its pinned catalogue and profile). A person reviews (G4) and merges.',
  no_pack: 'No Evidence Pack has been signed for this head (S7 has not passed it).',
  pack_not_passing: 'The Evidence Pack signed for this head is not a pass (rework or a handoff).',
  head_moved:
    'The PR head is not the head the Evidence Pack was signed for: a new push needs new evidence.',
  pack_invalid: 'The Evidence Pack does not verify for this repo, PR and head.',
  g3_missing: 'The item has no G3 (plan approval) decision.',
  g3_pending: 'G3 (plan approval) is not decided yet.',
  g3_not_approved: 'G3 (plan approval) was not approved.',
  g3_changed: 'A newer G3 than the one the evidence carries was opened: the plan changed.',
  unknown_agent_pr:
    'Authored by the Push Broker but not a pull request the factory recorded: refused.',
  s0_onboarding:
    'The project is onboarding (S0): the factory’s evidence does not apply. A person reviews; only a named bypass person may merge, and that merge gets an X4 review.',
  not_factory_work:
    'Not factory work: a person reviews. Only a named bypass person may merge it, and that merge is recorded and gets an X4 review.',
  laundering_agent_branch:
    'Laundering: a pull request the Push Broker did not open uses a factory agent/* branch.',
  laundering_agent_head:
    'Laundering: this pull request carries a head the Push Broker wrote for an agent PR.',
  laundering_pack_cited: 'Laundering: this pull request cites a factory Evidence Pack.',
  laundering_trailer:
    'Laundering: this pull request carries the factory’s commit trailers or PR marker.',
  dependency_unavailable:
    'gate-check could not read what it needs (the record, the evidence store or the Notary key): no pass until it can.',
};

const HEX64 = /\b[0-9a-fA-F]{64}\b/g;
const PACK_MARKER = /aisdlc-(?:signed-)?evidence-pack/i;
const TRAILER = /^\s*Aisdlc-(?:Item|Unit|Lease-Epoch|Patch):/im;
const PR_MARKER = /opened by the factory/i;

/** The laundering reason of a non-agent PR, from its text, its commits and what the record knows; `null`: none. */
export function launderingOf(
  pr: Pick<GateCheckPull, 'head_ref' | 'head_sha' | 'title' | 'body'>,
  commits: readonly PullCommit[],
  agentHeads: ReadonlySet<string>,
  cited: ReadonlySet<string>,
): GateCheckReason | null {
  if (pr.head_ref.startsWith('agent/')) return 'laundering_agent_branch';
  if (agentHeads.has(pr.head_sha) || commits.some((c) => agentHeads.has(c.sha)))
    return 'laundering_agent_head';
  const text = `${pr.title}\n${pr.body}`;
  if (cited.size > 0 || PACK_MARKER.test(text)) return 'laundering_pack_cited';
  if (TRAILER.test(text) || PR_MARKER.test(text) || commits.some((c) => TRAILER.test(c.message)))
    return 'laundering_trailer';
  return null;
}

/** The 64-hex tokens of a PR's text and commit messages (lower case, at most 64): what a citation would look like. */
export function hexTokensOf(
  pr: Pick<GateCheckPull, 'title' | 'body'>,
  commits: readonly PullCommit[],
): string[] {
  const all = `${pr.title}\n${pr.body}\n${commits.map((c) => c.message).join('\n')}`;
  return [...new Set((all.match(HEX64) ?? []).map((h) => h.toLowerCase()))].slice(0, 64);
}

/** The ids a verdict may carry; checked by `GateCheckVerdict.parse`. */
interface VerdictExtra {
  readonly item_id?: string;
  readonly unit_key?: string;
  readonly pack_sha256?: string;
  readonly lane?: EvidencePack['lane'];
  readonly g3?: GateCheckVerdict['g3'];
}

interface Base {
  readonly repo: RepoRow;
  readonly pr: GateCheckPull;
}

export class GateChecker {
  constructor(private readonly d: CheckerDeps) {}

  private verdict(
    b: Base,
    profile: GateCheckProfile,
    outcome: GateCheckOutcome,
    reason: GateCheckReason,
    extra: VerdictExtra = {},
  ): GateCheckVerdict {
    return GateCheckVerdict.parse({
      repo: b.repo.repo,
      pr_number: b.pr.number,
      head_sha: b.pr.head_sha,
      head_ref: b.pr.head_ref.slice(0, 255),
      author: { login: b.pr.author.login.slice(0, 100), type: b.pr.author.type },
      project_id: b.repo.project_id,
      profile,
      outcome,
      reason,
      detail: SUMMARY[reason].slice(0, 300),
      item_id: null,
      unit_key: null,
      pack_sha256: null,
      lane: null,
      g3: null,
      ...extra,
    });
  }

  private isBroker(pr: GateCheckPull): boolean {
    return pr.author.type === 'Bot' && pr.author.login === this.d.brokerLogin;
  }

  /** The verdict for one PR at its current head. Never throws: what cannot be read is `pending`. */
  async verdictFor(repo: RepoRow, pr: GateCheckPull): Promise<GateCheckVerdict> {
    const b = { repo, pr };
    try {
      return await this.decide(b);
    } catch {
      return this.verdict(
        b,
        this.isBroker(pr) ? 'agent' : 'non_agent',
        'pending',
        'dependency_unavailable',
      );
    }
  }

  private async decide(b: Base): Promise<GateCheckVerdict> {
    const { repo, pr } = b;
    const s0 = repo.onboarding_level === 'none';
    if (this.isBroker(pr)) {
      const row = await this.d.facts.agentPr(repo.repo, pr.number);
      if (
        row === null ||
        row.head_ref !== pr.head_ref ||
        badPushBranch(pr.head_ref, row.item_id, row.unit_key) !== null
      ) {
        return this.verdict(b, 'agent', 'failure', 'unknown_agent_pr');
      }
      if (s0)
        return this.verdict(b, 's0', 'action_required', 's0_onboarding', { item_id: row.item_id });
      return this.agent(b, row.item_id, row.unit_key);
    }
    // a person's PR: the laundering check first (it needs the commits: unreadable is pending)
    const commits = await this.d.host.pull_commits({ repo: repo.repo, number: pr.number });
    if (commits.state !== 'ok')
      return this.verdict(b, s0 ? 's0' : 'non_agent', 'pending', 'dependency_unavailable');
    const heads = await this.d.facts.agentHeads(repo.repo, [
      pr.head_sha,
      ...commits.value.map((c) => c.sha),
    ]);
    const cited = await this.d.facts.packsCited(hexTokensOf(pr, commits.value));
    const laundering = launderingOf(pr, commits.value, heads, cited);
    if (laundering) return this.verdict(b, s0 ? 's0' : 'non_agent', 'failure', laundering);
    return s0
      ? this.verdict(b, 's0', 'action_required', 's0_onboarding')
      : this.verdict(b, 'non_agent', 'action_required', 'not_factory_work');
  }

  private async agent(b: Base, itemId: string, unitKey: string): Promise<GateCheckVerdict> {
    const head = b.pr.head_sha;
    const ids = { item_id: itemId, unit_key: unitKey };
    const packs = await this.d.facts.packsOf(itemId);
    const forHead = packs.filter((p) => p.head_sha === head && p.unit_key === unitKey);
    const passing = forHead.filter((p) => p.passing).at(-1);
    if (!passing) {
      if (forHead.length > 0) return this.verdict(b, 'agent', 'failure', 'pack_not_passing', ids);
      if (packs.length > 0) return this.verdict(b, 'agent', 'failure', 'head_moved', ids);
      return this.verdict(b, 'agent', 'failure', 'no_pack', ids);
    }
    const key = await this.d.notaryKey.get();
    if (key === null) return this.verdict(b, 'agent', 'pending', 'dependency_unavailable', ids);
    const bytes = await this.read(passing);
    if (bytes === null) return this.verdict(b, 'agent', 'pending', 'dependency_unavailable', ids);
    // the pack verifies here, with the Notary's public key: core's word that it passed is not taken
    const c = await checkSignedEvidencePack(bytes, key, {
      head_sha: head,
      item_id: itemId,
      object_key: passing.object_key,
    });
    const withPack = { ...ids, pack_sha256: passing.pack_sha256 };
    if (!c.ok) {
      const reason: GateCheckReason =
        c.code === 'head_mismatch'
          ? 'head_moved'
          : c.code === 'not_passing'
            ? 'pack_not_passing'
            : 'pack_invalid';
      return this.verdict(b, 'agent', 'failure', reason, withPack);
    }
    const pack = c.signed.pack;
    if (c.signed.pack_sha256 !== passing.pack_sha256 || !this.binds(pack, b, unitKey)) {
      return this.verdict(b, 'agent', 'failure', 'pack_invalid', withPack);
    }
    const signed = { ...withPack, lane: pack.lane };
    const route = await this.routeHasG3(pack, itemId);
    if (route === 'unknown')
      return this.verdict(b, 'agent', 'pending', 'dependency_unavailable', signed);
    if (route === 'mismatch') return this.verdict(b, 'agent', 'failure', 'pack_invalid', signed);
    if (route === 'no') return this.verdict(b, 'agent', 'success', 'passed_no_g3', signed);
    const g3 = await this.d.facts.latestG3(itemId);
    if (g3 === null) return this.verdict(b, 'agent', 'failure', 'g3_missing', signed);
    const g3v = { ...signed, g3 };
    const carried = pack.gates.filter((g) => g.gate === 'G3').at(-1);
    if (carried && carried.gate_instance_id !== g3.gate_instance_id) {
      return this.verdict(b, 'agent', 'failure', 'g3_changed', g3v);
    }
    if (g3.status === 'pending') return this.verdict(b, 'agent', 'failure', 'g3_pending', g3v);
    if (g3.status !== 'decided' || g3.outcome !== 'approve') {
      return this.verdict(b, 'agent', 'failure', 'g3_not_approved', g3v);
    }
    return this.verdict(b, 'agent', 'success', 'passed', g3v);
  }

  /**
   * Whether the item's route has G3: the engine's rule (`presentGates` over the lane, `effectiveProfile` of the pinned
   * profile and tier) in the pack's pinned catalogue. `unknown`: the catalogue or the pin cannot be read (pending);
   * `mismatch`: the item's recorded profile is not the one the signed pack names.
   */
  private async routeHasG3(
    pack: EvidencePack,
    itemId: string,
  ): Promise<'yes' | 'no' | 'unknown' | 'mismatch'> {
    let cat = catalogueFor(pack.catalogue_ref);
    if (!cat.ok && cat.error._tag === 'CatalogueUnknown' && this.d.loadCatalogueReleases) {
      await this.d.loadCatalogueReleases().catch(() => undefined);
      cat = catalogueFor(pack.catalogue_ref);
    }
    if (!cat.ok) return 'unknown';
    const lane = cat.value.lanes[pack.lane];
    if (!lane) return 'unknown';
    const pin = await this.d.facts.itemPin(itemId);
    if (pin === null) return 'unknown';
    if (hashCanonical(pin.gating_profile as never) !== pack.profile_sha256) return 'mismatch';
    if (pin.tier !== pack.tier) return 'mismatch';
    return presentGates(lane, effectiveProfile(pin.gating_profile, pin.tier)).has('G3')
      ? 'yes'
      : 'no';
  }

  /** The signed pack is for this repo, this Unit and (when the receipt is in it) this PR and head. */
  private binds(pack: EvidencePack, b: Base, unitKey: string): boolean {
    if (repoKey(pack.repo) !== repoKey(b.repo.repo)) return false;
    if (!pack.units.some((u) => u.unit_key === unitKey)) return false;
    const r = pack.push_receipt;
    // a pass binds the Push Broker's receipt for this head; a pack without one is not bound to any PR
    return r !== null && r.pr_number === b.pr.number && r.head_sha === b.pr.head_sha;
  }

  private async read(p: PackRow): Promise<Uint8Array | null> {
    if (p.bucket !== EVIDENCE_BUCKET) return null;
    const d = await this.d.packs.declareBucket(EVIDENCE_BUCKET, 'write_once');
    if (!d.ok) return null;
    const g = await this.d.packs.get(p.bucket, p.object_key);
    return g.ok ? g.value : null;
  }

  /**
   * One repo's open PRs: each gets its verdict. A check run belongs to a COMMIT, not to a PR, so several open PRs with
   * one head share it: the run written on a head is the strictest verdict of the PRs at that head (a PR that borrows an
   * agent's head turns that head's run into its laundering failure; it never inherits the agent's pass). A head is
   * written again when any of its PRs' verdicts, or the strictest of them, changed since it was last recorded (or its
   * run was never written); then each of those PRs' verdicts is recorded with the run. Returns how many check runs
   * were written. A code host that does not answer fails the repo (nothing is written or recorded).
   */
  async syncRepo(repo: RepoRow, each: Each = defaultEach): Promise<number> {
    const open = await this.d.host.list_pulls({ repo: repo.repo, state: 'open' });
    if (open.state !== 'ok')
      throw new Error(`open PRs of ${repo.repo}: ${open.state}/${open.reason}`);
    const heads = new Map<string, Array<{ pr: GateCheckPull; v: GateCheckVerdict; sha: string }>>();
    for (const pr of open.value) {
      const v = await this.verdictFor(repo, pr);
      const list = heads.get(pr.head_sha) ?? [];
      list.push({ pr, v, sha: gateCheckVerdictHash(v) });
      heads.set(pr.head_sha, list);
    }
    let wrote = 0;
    await each(
      [...heads.entries()],
      ([head]) => `${repo.repo}@${head.slice(0, 12)}`,
      async ([, members]) => {
        const gov = strictest(members);
        const lasts = await Promise.all(
          members.map((m) => this.d.facts.lastVerdict(repo.repo, m.pr.number)),
        );
        const stale = members.filter((m, i) => {
          const l = lasts[i];
          return !(
            l &&
            l.verdict_sha256 === m.sha &&
            l.check_verdict_sha256 === gov.sha &&
            l.check_run_id !== null
          );
        });
        if (stale.length === 0) return;
        const v = gov.v;
        const run = checkRunOf(v);
        const shared =
          members.length > 1
            ? `\n\nThis commit is the head of ${members.length} open pull requests (${members.map((m) => `#${m.pr.number}`).join(', ')}): the strictest verdict applies.`
            : '';
        const w = await this.d.host.write_check_run({
          repo: repo.repo,
          head_sha: v.head_sha,
          name: GATE_CHECK_NAME,
          status: run.status,
          conclusion: run.conclusion,
          external_id: gov.sha,
          title: `${v.profile}: ${v.reason}`,
          summary: `${v.detail}${shared}\n\nverdict ${gov.sha}${v.pack_sha256 ? `\nevidence pack ${v.pack_sha256}` : ''}`,
        });
        if (w.state !== 'ok')
          throw new Error(`check run on ${repo.repo} #${v.pr_number}: ${w.state}/${w.reason}`);
        wrote += 1;
        for (const m of stale) {
          const l = lasts[members.indexOf(m)];
          await this.d.store.recordVerdict(m.v, m.sha, gov.sha, w.value.id, l?.seq ?? 0);
        }
      },
    );
    return wrote;
  }

  /**
   * One repo's merged PRs that are not recorded yet: each is classed (`gated` when gate-check's own check run was
   * `success` on the merged head AND its record says so; else `bypass` when the merger is on the repo's list, else
   * `unauthorised`) and recorded. core raises the X4 review of a bypass and an unauthorised merge from the record.
   */
  async observeMerges(repo: RepoRow, each: Each = defaultEach): Promise<MergeClass[]> {
    const closed = await this.d.host.list_pulls({ repo: repo.repo, state: 'closed' });
    if (closed.state !== 'ok')
      throw new Error(`closed PRs of ${repo.repo}: ${closed.state}/${closed.reason}`);
    // the first time a repo is seen, its watch starts now: earlier merges are `pre_watch` (no review: gate-check
    // could not have checked them); merged at an unknown time counts as after (fail closed)
    let watch = await this.d.facts.repoWatch(repo.repo);
    if (watch === null) {
      const branch = repo.default_branch ?? 'main';
      const head = await this.d.host.branch_head({ repo: repo.repo, branch });
      if (head.state !== 'ok')
        throw new Error(`head of ${repo.repo}: ${head.state}/${head.reason}`);
      await this.d.store.recordRepoWatch({
        repo: repo.repo,
        project_id: repo.project_id as never,
        watched_at: (this.d.clock ?? systemClock).now().toISOString(),
        default_branch: branch,
        head_sha: head.value,
      });
      watch = await this.d.facts.repoWatch(repo.repo);
      if (watch === null) throw new Error(`the watch of ${repo.repo} was not recorded`);
    }
    const since = Date.parse(watch.watched_at);
    const out: MergeClass[] = [];
    await each(
      closed.value.filter((p) => p.merged),
      (p) => `${repo.repo}#${p.number}`,
      async (pr) => {
        const merge_id = mergeSubjectId(repo.repo, pr.number, pr.head_sha);
        if (await this.d.facts.mergeRecorded(merge_id)) return;
        const at = pr.merged_at === null ? Number.NaN : Date.parse(pr.merged_at);
        if (Number.isFinite(at) && at <= since) {
          await this.d.store.recordMerge(
            this.mergePayload(repo, pr, merge_id, 'pre_watch', null, null, 'absent', null),
          );
          out.push('pre_watch');
          return;
        }
        const runs = await this.d.host.check_runs({
          repo: repo.repo,
          sha: pr.head_sha,
          name: GATE_CHECK_NAME,
        });
        // no answer about the check is not "it was absent": the merge is classed when the host answers
        if (runs.state !== 'ok')
          throw new Error(`check runs of ${repo.repo}#${pr.number}: ${runs.state}`);
        const mine = runs.value
          .filter((r) => r.app_id === this.d.host.app_id)
          .sort((a, x) => a.id - x.id)
          .at(-1);
        const host_check: MergeObservedPayload['host_check'] =
          mine === undefined
            ? 'absent'
            : mine.status === 'completed' && mine.conclusion === 'success'
              ? 'success'
              : 'not_success';
        const last = await this.d.facts.lastVerdict(repo.repo, pr.number);
        const lastHere = last && last.verdict.head_sha === pr.head_sha ? last.verdict : null;
        const gated = host_check === 'success' && lastHere?.outcome === 'success';
        let cls: MergeClass = 'gated';
        let person: BypassPerson | null = null;
        if (!gated) {
          const list = bypassListFor(this.d.bypass() ?? {}, repo.repo);
          person =
            list.find(
              (p) => pr.merged_by !== null && p.login.toLowerCase() === pr.merged_by.toLowerCase(),
            ) ?? null;
          cls = person ? 'bypass' : 'unauthorised';
        }
        const agent = this.isBroker(pr) ? await this.d.facts.agentPr(repo.repo, pr.number) : null;
        await this.d.store.recordMerge(
          this.mergePayload(
            repo,
            pr,
            merge_id,
            cls,
            person,
            lastHere,
            host_check,
            agent?.item_id ?? lastHere?.item_id ?? null,
          ),
        );
        out.push(cls);
      },
    );
    return out;
  }

  private mergePayload(
    repo: RepoRow,
    pr: GateCheckPull,
    merge_id: string,
    cls: MergeClass,
    person: BypassPerson | null,
    last: GateCheckVerdict | null,
    host_check: MergeObservedPayload['host_check'],
    item: string | null,
  ): MergeObservedPayload {
    return {
      merge_id,
      repo: repo.repo,
      project_id: repo.project_id as never,
      pr_number: pr.number,
      head_sha: pr.head_sha,
      head_ref: pr.head_ref.slice(0, 255),
      merge_commit_sha: pr.merge_commit_sha,
      merged_by: pr.merged_by?.slice(0, 100) ?? null,
      merged_at: pr.merged_at ? new Date(pr.merged_at).toISOString() : null,
      author: { login: pr.author.login.slice(0, 100), type: pr.author.type },
      class: cls,
      bypass_person: person,
      last_verdict: last
        ? { outcome: last.outcome, reason: last.reason, profile: last.profile }
        : null,
      host_check,
      item_id: item as never,
    };
  }
}

const RANK: Readonly<Record<GateCheckOutcome, number>> = {
  success: 0,
  action_required: 1,
  pending: 2,
  failure: 3,
};

/** The strictest verdict of the PRs at one head (ties: the lowest PR number, so it is stable). */
function strictest<T extends { pr: GateCheckPull; v: GateCheckVerdict }>(members: readonly T[]): T {
  return [...members].sort(
    (a, b) => RANK[b.v.outcome] - RANK[a.v.outcome] || a.pr.number - b.pr.number,
  )[0] as T;
}

export type Each = <T>(
  items: readonly T[],
  label: (i: T) => string,
  fn: (i: T) => Promise<void>,
) => Promise<void>;

const defaultEach = async <T>(
  items: readonly T[],
  _label: (i: T) => string,
  fn: (i: T) => Promise<void>,
): Promise<void> => {
  for (const i of items) await fn(i);
};
