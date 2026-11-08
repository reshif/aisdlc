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

  /** Makes every call for the project fail, to test fail-closed behaviour. */
  breakProject(project: ProjectId): this {
    this.down.add(project);
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
