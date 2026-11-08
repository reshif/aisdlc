import type { PrincipalId, ProjectId, RoleSlot, Tier } from '@aisdlc/contracts';
import { PortError, type EligibilityPort, type PolicyContext } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { Executor } from '@aisdlc/record';
import type pg from 'pg';
import { hasPublishedSettings, liveBootstrap, type LiveBootstrap } from '@aisdlc/onboarding';
import { getProjectState } from './queries.js';

// The bootstrap decider (PLAN M7.4; user decision 2026-11-08). A project that has never published
// a role map has nobody who holds any slot, so nobody could decide its first onboarding. On that
// first onboarding the requester, who passed the `project.onboard` PDP check, is the provisional
// admin of THAT S0 record's cards 1, 4 and 5 (and of the M1 gate that publishes card 4's own
// revision, which the same admin slot decides). Rules, all enforced here:
//
//   - recorded at the intake: an `s0.bootstrap_granted` event on the S0 record and a ledger entry
//     that states the grant (`requestOnboarding`), so it is never implicit;
//   - only the `admin` slot resolves to the requester. Never `sec` (the security card), never `m4`
//     (M4 follows the role map, and at T2 still needs two people), never any other slot;
//   - only while the project has no published project-layer revision (verified against the ledger
//     by `readLineage`): the moment card 4's revision is published, eligibility is the role map's;
//   - only for the S0 record that holds the grant, and only while that record has not ended;
//   - at most one live grant per project: a second onboarding of the same project gets none.

/** The slot the provisional grant resolves. Card 4's M1 gate and cards 1, 4 and 5 all use it. */
export const BOOTSTRAP_SLOT: RoleSlot = 'admin';

export { hasPublishedSettings, liveBootstrap, type LiveBootstrap };

/** The first onboarding of a project: no live grant (a record that ends here does not count) and no published settings. */
export async function bootstrapApplies(
  db: Executor,
  project: string,
  except: readonly string[] = [],
): Promise<boolean> {
  if (await hasPublishedSettings(db, project)) return false;
  return (await liveBootstrap(db, project, except)) === null;
}

const TIER_RANK: Readonly<Record<Tier, number>> = { T0: 0, T1: 1, T2: 2 };

/**
 * `EligibilityPort` that adds the provisional admin to a base port (identity's, or a fake in
 * tests). Everything it does not resolve is the base port's answer, so a failing base is still a
 * refusal. `s0_id` limits it to one record's cards: the card layer builds one per card operation,
 * so the grant of record A decides nothing of record B.
 */
export class BootstrapEligibility implements EligibilityPort {
  constructor(
    private readonly base: EligibilityPort,
    private readonly o: { readonly pool: pg.Pool; readonly s0_id?: string },
  ) {}

  /** The same port limited to one S0 record. */
  scoped(s0Id: string): BootstrapEligibility {
    return new BootstrapEligibility(this.base, { pool: this.o.pool, s0_id: s0Id });
  }

  private async grant(project: ProjectId): Promise<LiveBootstrap | null> {
    try {
      const g = await liveBootstrap(this.o.pool, project);
      return g && (this.o.s0_id === undefined || g.s0_id === this.o.s0_id) ? g : null;
    } catch {
      return null; // fail closed: an error finds no grant
    }
  }

  async holders(project: ProjectId, slot: RoleSlot) {
    if (slot !== BOOTSTRAP_SLOT) return this.base.holders(project, slot);
    const g = await this.grant(project);
    return g ? ok([g.grantee] as readonly PrincipalId[]) : this.base.holders(project, slot);
  }

  async policy(project: ProjectId): Promise<Result<PolicyContext, PortError>> {
    const base = await this.base.policy(project);
    if (base.ok) return base;
    const g = await this.grant(project);
    if (!g) return base;
    // The project has no settings yet: its tier is what it attested, or what card 1 signed.
    const state = await getProjectState(this.o.pool, project);
    if (!state) return err(PortError({ message: `unknown project ${project}` }));
    const floor = state.attestations.tier_floor;
    const tier =
      state.project.tier !== null &&
      (floor === undefined || TIER_RANK[state.project.tier] >= TIER_RANK[floor])
        ? state.project.tier
        : (floor ?? null);
    const locked = tier === 'T2';
    return ok({
      tier,
      two_person: { enabled: true, default: 'on_if_2plus', locked_on: locked },
    });
  }
}
