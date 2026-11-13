import type {
  PrincipalId,
  ProjectId,
  RoleSlot,
  Sha256Hex,
  Tier,
  TwoPerson,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import type { PolicyContext } from './policy.js';

// Ports of the decision kernel (AGENTS.md: identity and step-up are reached only through a port,
// each with a deterministic fake). Real identity comes in M4, the real step-up in M4.5.

export const PortError = taggedError('PortError');
export type PortError = TaggedError<'PortError', { message: string }>;
const portError = (message: string): PortError => PortError({ message });

/** Who holds a role slot of a project (OB §1B `role_map`), and what the project says about itself. */
export interface EligibilityPort {
  /** The principals that currently hold `slot`. An error is a refusal, never "everyone". */
  holders(project: ProjectId, slot: RoleSlot): Promise<Result<readonly PrincipalId[], PortError>>;
  /** Tier and two-person setting of the project. */
  policy(project: ProjectId): Promise<Result<PolicyContext, PortError>>;
}

/**
 * Who may decide one gate: the holders of its slot, narrowed to the gate's `deciders` when it was opened with them
 * (G4 mode C: the code owners of the changed paths). The narrowing never widens: a decider who does not hold the slot
 * is not eligible. Used by open, prepare and vote alike, so the three never disagree.
 */
export async function gateHolders(
  eligibility: EligibilityPort,
  project: ProjectId,
  slot: RoleSlot,
  deciders: readonly PrincipalId[] | undefined,
): Promise<Result<readonly PrincipalId[], PortError>> {
  const h = await eligibility.holders(project, slot);
  if (!h.ok || deciders === undefined) return h;
  const only = new Set(deciders);
  return ok(h.value.filter((p) => only.has(p)));
}

/** Deterministic in-memory `EligibilityPort`. Anything not set is an error: unknown means unmet. */
export class FakeEligibility implements EligibilityPort {
  private readonly slots = new Map<string, readonly PrincipalId[]>();
  private readonly policies = new Map<string, PolicyContext>();
  private readonly down = new Set<string>();

  setHolders(project: ProjectId, slot: RoleSlot, principals: readonly PrincipalId[]): this {
    this.slots.set(`${project}/${slot}`, principals);
    return this;
  }

  setPolicy(project: ProjectId, p: { tier: Tier | null; two_person?: Partial<TwoPerson> }): this {
    const locked = p.tier === 'T2' || (p.two_person?.locked_on ?? false);
    this.policies.set(project, {
      tier: p.tier,
      two_person: {
        enabled: locked ? true : (p.two_person?.enabled ?? true),
        default: 'on_if_2plus',
        locked_on: locked,
      },
    });
    return this;
  }

  /** Makes every call for the project fail, to test fail-closed behaviour (`false` mends it). */
  breakProject(project: ProjectId, broken = true): this {
    if (broken) this.down.add(project);
    else this.down.delete(project);
    return this;
  }

  async holders(project: ProjectId, slot: RoleSlot) {
    if (this.down.has(project)) return err(portError(`identity unavailable for ${project}`));
    const h = this.slots.get(`${project}/${slot}`);
    return h ? ok(h) : err(portError(`unknown slot ${project}/${slot}`));
  }

  async policy(project: ProjectId) {
    if (this.down.has(project)) return err(portError(`identity unavailable for ${project}`));
    const p = this.policies.get(project);
    return p ? ok(p) : err(portError(`unknown project ${project}`));
  }
}

/**
 * Is a principal a factory admin (bound to `factory.admin` at fleet scope, active)? The decision kernel asks this
 * itself before it accepts an override (docs/specs/deletion.md §8). An error is a refusal, never "yes".
 */
export interface FactoryAdminPort {
  isFactoryAdmin(principal: PrincipalId): Promise<Result<boolean, PortError>>;
}

/** Deterministic `FactoryAdminPort`: the admins named, nobody else. */
export class FakeFactoryAdmins implements FactoryAdminPort {
  private readonly admins = new Set<string>();
  down = false;
  constructor(admins: readonly string[] = []) {
    for (const a of admins) this.admins.add(a);
  }
  add(principal: string): this {
    this.admins.add(principal);
    return this;
  }
  async isFactoryAdmin(principal: PrincipalId) {
    if (this.down) return err(portError('identity unavailable'));
    return ok(this.admins.has(principal));
  }
}

/**
 * Step-up: a fresh strong authentication of the principal, bound to a hash so a proof for one thing
 * cannot confirm another (D37, DEC-11; M4 and release). `Ok(true)` only for a valid proof.
 */
export interface StepUpPort {
  verify(
    proof: string,
    boundHash: Sha256Hex,
    principal: PrincipalId,
  ): Promise<Result<true, PortError>>;
}

/** Fake step-up: `issue` makes a proof that verifies only for that hash and principal. */
export class FakeStepUp implements StepUpPort {
  private readonly revoked = new Set<string>();

  issue(boundHash: string, principal: string): string {
    return `fake-stepup.${sha256Hex(`${boundHash}|${principal}`)}`;
  }

  revoke(proof: string): void {
    this.revoked.add(proof);
  }

  async verify(proof: string, boundHash: Sha256Hex, principal: PrincipalId) {
    if (this.revoked.has(proof)) return err(portError('step-up proof revoked'));
    return proof === this.issue(boundHash, principal)
      ? ok(true as const)
      : err(portError('step-up proof does not match the bound hash and principal'));
  }
}
