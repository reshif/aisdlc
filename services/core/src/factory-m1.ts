import {
  FACTORY_PROJECT_ID,
  FACTORY_SCOPE,
  FactoryRevisionView,
  type FactoryM1Policy,
  type PrincipalId,
  type ProjectId,
  type RoleSlot,
} from '@aisdlc/contracts';
import {
  readFactoryM1Policy,
  readLineage,
  type ConfigDeps,
  type SettingRead,
} from '@aisdlc/config';
import {
  PortError,
  readGateState,
  type EligibilityPort,
  type PolicyContext,
} from '@aisdlc/decisions';
import { freshReadModel, queryGrants } from '@aisdlc/identity/read';
import { canonicalJson, err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';

// The factory-wide M1 decider (PLAN M15.5; §7a "Factory-wide M1", decided 2026-11-11; portal-config §5 gap 1). A
// factory-layer revision's M1 is opened on the pseudo-project `factory` (`configProjectOf`), which has no role map.
// This port answers for it from `factory.m1_policy` (factory layer, itself M1-gated): the `admin` slot of `factory` is
// held by the principals bound to the policy's fleet role, and the factory's policy context carries the rule
// (`factory_m1`): the proposer (the gate's requester) never decides, there is no waiver of any kind, and the policy's
// number of distinct approvers decides. Everything else is the base port's answer.
//
// Fail closed: an unreadable policy or an identity that does not answer is an error (no one decides), never the
// default rule or "everyone".

/** Who holds a fleet role now. An error is a refusal. */
export type FleetRoleHolders = (role: string) => Promise<Result<PrincipalId[], PortError>>;
/** The factory M1 rule in force. */
export type FactoryM1PolicySource = () => Promise<SettingRead<FactoryM1Policy>>;

/** The holders of a fleet-scoped role from identity's read model (caught up first). */
export function identityFleetRoleHolders(
  pool: pg.Pool,
  clock: Clock = systemClock,
): FleetRoleHolders {
  return async (role) => {
    const fresh = await freshReadModel(pool);
    if (!fresh.ok) return err(PortError({ message: 'the identity read model is not current' }));
    try {
      const grants = await queryGrants(pool, { role }, null, clock.now());
      const out = grants
        .filter((g) => g.blockers.length === 0 && g.scope.kind === 'fleet')
        .map((g) => g.principal.principal_id as PrincipalId);
      return ok([...new Set(out)].sort());
    } catch (e) {
      return err(PortError({ message: `identity: ${e instanceof Error ? e.message : String(e)}` }));
    }
  };
}

export class FactoryM1Eligibility implements EligibilityPort {
  constructor(
    private readonly base: EligibilityPort,
    private readonly o: {
      readonly policy: FactoryM1PolicySource;
      readonly holders: FleetRoleHolders;
    },
  ) {}

  /** Over a pool: the published policy and identity's fleet bindings. */
  static over(base: EligibilityPort, pool: pg.Pool, clock?: Clock): FactoryM1Eligibility {
    return new FactoryM1Eligibility(base, {
      policy: () => readFactoryM1Policy(pool),
      holders: identityFleetRoleHolders(pool, clock),
    });
  }

  private async rule(): Promise<Result<FactoryM1Policy, PortError>> {
    try {
      const p = await this.o.policy();
      return p.state === 'ok'
        ? ok(p.value)
        : err(
            PortError({ message: 'factory.m1_policy is unreadable: no one decides a factory M1' }),
          );
    } catch (e) {
      return err(
        PortError({ message: `factory.m1_policy: ${e instanceof Error ? e.message : String(e)}` }),
      );
    }
  }

  async holders(project: ProjectId, slot: RoleSlot) {
    if (project !== FACTORY_PROJECT_ID) return this.base.holders(project, slot);
    if (slot !== 'admin') {
      return err(
        PortError({ message: `the factory decides only its M1 (slot admin), not ${slot}` }),
      );
    }
    const r = await this.rule();
    if (!r.ok) return r;
    const h = await this.o.holders(r.value.role);
    return h.ok ? ok(h.value as readonly PrincipalId[]) : h;
  }

  async policy(project: ProjectId): Promise<Result<PolicyContext, PortError>> {
    if (project !== FACTORY_PROJECT_ID) return this.base.policy(project);
    const r = await this.rule();
    if (!r.ok) return r;
    return ok({
      tier: null,
      two_person: { enabled: true, default: 'on_if_2plus', locked_on: false },
      factory_m1: { approvers: r.value.approvers },
    });
  }
}

// ---------------------------------------------------------------- the decide path of a factory revision

const FACTORY = { layer: 'factory', scope: FACTORY_SCOPE } as const;

/**
 * A factory-layer revision's M1 as something to decide (portal-config §5 gap 2): the keys it changes against its
 * parent, the rule in force, who may decide it now (the role's holders without the proposer) and how many approvals.
 */
export async function factoryRevisionView(
  deps: { pool: pg.Pool; config: ConfigDeps },
  gate: string,
): Promise<Result<FactoryRevisionView, CoreError>> {
  const state = await readGateState(deps.pool, gate);
  const p = state?.open.payload;
  if (!state || !p || p.gate_id !== 'M1' || p.subject_kind !== 'config') {
    return err(coreError('not_found', `no configuration revision gate ${gate}`));
  }
  if (p.project_id !== FACTORY_PROJECT_ID) {
    return err(coreError('not_found', `gate ${gate} decides a project revision`));
  }
  const lineage = await readLineage(deps.pool, FACTORY);
  const rev = lineage.proposed.get(p.subject_hash);
  if (!rev) return err(coreError('not_found', 'the revision this gate decides is gone'));
  const parent =
    rev.parent_rev_hash === null ? null : (lineage.proposed.get(rev.parent_rev_hash) ?? null);
  const after = rev.doc as Record<string, unknown>;
  const before = (parent?.doc ?? {}) as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const changes = keys
    .filter((k) => canonicalJson(before[k] ?? null) !== canonicalJson(after[k] ?? null))
    .map((k) => ({ key: k, before: before[k] ?? null, after: after[k] ?? null }));
  const policy = await readFactoryM1Policy(deps.pool);
  if (policy.state !== 'ok') {
    return err(
      coreError('unavailable', 'factory.m1_policy is unreadable: no one decides a factory M1'),
    );
  }
  const holders = await deps.config.eligibility.holders(FACTORY_PROJECT_ID, 'admin');
  const deciders = holders.ok ? holders.value.filter((h) => h !== rev.proposed_by) : [];
  return ok(
    FactoryRevisionView.parse({
      gate_instance_id: gate,
      rev_hash: p.subject_hash,
      parent_rev_hash: rev.parent_rev_hash,
      proposed_by: rev.proposed_by,
      status: state.status,
      outcome: state.outcome,
      published: lineage.published.some((x) => x.rev_hash === p.subject_hash),
      changes,
      evidence_hash: p.evidence_pack_hash ?? p.subject_hash,
      policy: policy.value,
      deciders: [...deciders].sort(),
      quorum: p.quorum.required,
    }),
  );
}
