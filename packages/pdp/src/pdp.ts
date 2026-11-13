import { createHash } from 'node:crypto';
import {
  ACTION_IDS,
  ActionId,
  PdpDecisionRecord,
  isAdminOverride,
  PdpResource,
  actionDef,
  resourceScopes,
  type PdpDecision,
  type PrincipalId,
  type RoleDef,
  ROLE_CATALOGUE,
} from '@aisdlc/contracts';
import { newId, systemClock, type Clock } from '@aisdlc/kernel';
import type { PdpEntityPort } from '@aisdlc/ports';
import { verifyBundle, type BundleSource } from './bundle.js';
import { evaluate } from './cedar.js';
import { buildEntities } from './entities.js';
import type { DecisionLog } from './log.js';

// The embedded evaluator (PLAN M4.3, AR2): Cedar in-process, one bundle version per decision.
//
// FAIL CLOSED. The answer is `allow` only when a verified bundle was loaded, the principal and its
// bindings were read, Cedar evaluated without error and said allow, and (for an action whose allow
// must be logged) the log took the record. Every other path, including every exception, denies.

export interface PdpOptions {
  readonly source: BundleSource;
  readonly entities: PdpEntityPort;
  readonly clock?: Clock;
  readonly log?: DecisionLog;
  /** Fraction (0..1) of the allows that are not `log_allow` actions to log anyway. Default 0. */
  readonly sampleRate?: number;
  readonly catalogue?: readonly RoleDef[];
  /** A failure to log a deny, or any other background problem. Never changes a decision. */
  readonly onError?: (e: unknown) => void;
}

export interface PdpRequest {
  readonly principal: PrincipalId | string;
  readonly action: string;
  readonly resource: PdpResource;
  /** Why the caller asks (a card note, a kill reason); recorded with the decision, never evaluated. */
  readonly justification?: string;
}

export interface PdpOutcome extends PdpDecision {
  readonly decision_id: string;
}

const sampled = (decisionId: string, rate: number): boolean => {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  const h = createHash('sha256').update(decisionId).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000 < rate;
};

export class Pdp {
  constructor(private readonly o: PdpOptions) {}

  /**
   * Decides one request. `log: false` is for capability probes (what may this user do here): the
   * answer is the same, but no `pdp.decision` event is written, so a screen that asks about twenty
   * buttons does not write twenty denies.
   */
  async decide(req: PdpRequest, opts: { log?: boolean } = {}): Promise<PdpOutcome> {
    const decision_id = newId<'PdpDecision'>();
    const now = (this.o.clock ?? systemClock).now();
    let out: PdpDecision;
    let action: ActionId | null = null;
    let resource: PdpResource | null = null;
    try {
      const a = ActionId.safeParse(req.action);
      const r = PdpResource.safeParse(req.resource);
      if (!a.success) out = deny('unknown_action');
      else if (!r.success) out = deny('invalid_resource');
      else if (!(actionDef(a.data).resource_types as readonly string[]).includes(r.data.type)) {
        out = deny('action_not_applicable');
        action = a.data;
        resource = r.data;
      } else {
        action = a.data;
        resource = r.data;
        out = await this.evaluateRequest(req.principal, a.data, r.data, now);
      }
    } catch (e) {
      out = deny(`evaluator_error:${e instanceof Error ? e.message : String(e)}`);
    }

    if (opts.log !== false && action !== null && resource !== null) {
      out = await this.logDecision(
        {
          decision_id,
          principal: req.principal,
          action,
          resource,
          justification: req.justification ?? null,
          now,
        },
        out,
      );
    }
    return { ...out, decision_id };
  }

  /**
   * M19: one action of one principal on many resources (the floor's per-item `item.view_floor`), not logged: the
   * same answers `decide(..., { log: false })` gives one by one, with the bundle verified once and the entity source's
   * batch view (`PdpEntityPort.batch`: identity's read model caught up once, the principal and each scope's bindings
   * read once, the live bootstrap grant once per project). The load test measured the floor at 30 items doing 30
   * bundle verifications and 30 identity read-model folds per read (docs/evidence/load-m19.md).
   */
  async decideEach(
    principal: PrincipalId | string,
    action: string,
    resources: readonly PdpResource[],
  ): Promise<PdpDecision[]> {
    const now = (this.o.clock ?? systemClock).now();
    const a = ActionId.safeParse(action);
    if (!a.success) return resources.map(() => deny('unknown_action'));
    let bundle: ReturnType<typeof verifyBundle>;
    try {
      bundle = verifyBundle(this.o.source.current());
    } catch (e) {
      const why = `evaluator_error:${e instanceof Error ? e.message : String(e)}`;
      return resources.map(() => deny(why));
    }
    const src = this.o.entities.batch?.() ?? this.o.entities;
    const out: PdpDecision[] = [];
    for (const raw of resources) {
      try {
        const r = PdpResource.safeParse(raw);
        if (!r.success) {
          out.push(deny('invalid_resource'));
          continue;
        }
        if (!(actionDef(a.data).resource_types as readonly string[]).includes(r.data.type)) {
          out.push(deny('action_not_applicable'));
          continue;
        }
        if (!bundle.ok) {
          out.push(this.evaluateWith(bundle, a.data, r.data, null));
          continue;
        }
        const facts = await src.principalFacts(
          principal as PrincipalId,
          resourceScopes(r.data),
          now,
          { action: a.data, resource: r.data },
        );
        out.push(this.evaluateWith(bundle, a.data, r.data, facts));
      } catch (e) {
        out.push(deny(`evaluator_error:${e instanceof Error ? e.message : String(e)}`));
      }
    }
    return out;
  }

  /** The catalogue actions that apply to this resource type and that the principal may do here. Not logged. */
  async allowedActions(
    principal: PrincipalId | string,
    resource: PdpResource,
    candidates: readonly ActionId[] = ACTION_IDS,
  ): Promise<ActionId[]> {
    const out: ActionId[] = [];
    for (const a of candidates) {
      if (!(actionDef(a).resource_types as readonly string[]).includes(resource.type)) continue;
      const d = await this.decide({ principal, action: a, resource }, { log: false });
      if (d.decision === 'allow') out.push(a);
    }
    return out;
  }

  private async evaluateRequest(
    principal: string,
    action: ActionId,
    resource: PdpResource,
    now: Date,
  ): Promise<PdpDecision> {
    const v = verifyBundle(this.o.source.current());
    const facts = v.ok
      ? await this.o.entities.principalFacts(
          principal as PrincipalId,
          resourceScopes(resource),
          now,
          { action, resource },
        )
      : null;
    return this.evaluateWith(v, action, resource, facts);
  }

  /** The evaluation of one request over a verified bundle and the principal's facts (shared by decide and decideEach). */
  private evaluateWith(
    v: ReturnType<typeof verifyBundle>,
    action: ActionId,
    resource: PdpResource,
    facts: Awaited<ReturnType<PdpEntityPort['principalFacts']>> | null,
  ): PdpDecision {
    if (!v.ok) {
      return deny(v.error.reason, {
        bundle_version: v.error.bundle_version,
        bundle_hash: v.error.bundle_hash,
      });
    }
    const bundle = v.value;
    const stamp: Stamp = {
      bundle_version: bundle.bundle_version,
      bundle_hash: bundle.bundle_hash,
    };

    if (facts === null || !facts.ok) return deny('entity_source_error', stamp);
    if (facts.value === null) return deny('unknown_principal', stamp);

    const built = buildEntities(facts.value, resource, this.o.catalogue ?? ROLE_CATALOGUE);
    const verdict = evaluate(bundle, {
      principal: built.principal,
      action,
      resource: { type: resource.type, id: resource.id },
      entities: built.entities,
    });
    if (!verdict.ok) return deny('evaluator_error', stamp);
    if (verdict.value.errors.length > 0) {
      return deny(
        verdict.value.errors.map((e) => `policy_error:${e}`),
        stamp,
      );
    }
    if (verdict.value.decision === 'allow') {
      return { decision: 'allow', reasons: [...verdict.value.reasons], ...stamp };
    }
    return deny(
      verdict.value.reasons.length > 0 ? verdict.value.reasons : ['no_policy_permits'],
      stamp,
    );
  }

  private async logDecision(
    c: {
      decision_id: string;
      principal: string;
      action: ActionId;
      resource: PdpResource;
      justification: string | null;
      now: Date;
    },
    out: PdpDecision,
  ): Promise<PdpDecision> {
    const log = this.o.log;
    if (!log) return out;
    // An override is always logged, and an override that cannot be logged is not given (recording never has holes).
    const override = isAdminOverride(out);
    const must = out.decision === 'allow' && (actionDef(c.action).log_allow || override);
    const because: PdpDecisionRecord['logged_because'] | null =
      out.decision === 'deny'
        ? 'deny'
        : override
          ? 'override'
          : must
            ? 'action'
            : sampled(c.decision_id, this.o.sampleRate ?? 0)
              ? 'sampled'
              : null;
    if (because === null) return out;
    const rec = PdpDecisionRecord.safeParse({
      decision_id: c.decision_id,
      principal: c.principal,
      action: c.action,
      resource: c.resource,
      decision: out.decision,
      reasons: out.reasons,
      bundle_version: out.bundle_version,
      bundle_hash: out.bundle_hash,
      at: c.now.toISOString(),
      justification: c.justification,
      logged_because: because,
    });
    const written = rec.success
      ? await log.record(rec.data)
      : ({ ok: false, error: rec.error.message } as const);
    if (written.ok) return out;
    if (must) {
      // An allow that cannot be recorded is not given: the decide, kill and config acts are
      // exactly the ones whose record must exist.
      return deny('decision_log_failed', {
        bundle_version: out.bundle_version,
        bundle_hash: out.bundle_hash,
      });
    }
    this.o.onError?.(new Error(`pdp decision log: ${written.error}`));
    return out;
  }
}

type Stamp = Pick<PdpDecision, 'bundle_version' | 'bundle_hash'>;
const NO_STAMP: Stamp = { bundle_version: null, bundle_hash: null };

function deny(reasons: string | readonly string[], stamp: Stamp = NO_STAMP): PdpDecision {
  return {
    decision: 'deny',
    reasons: typeof reasons === 'string' ? [reasons] : [...reasons],
    bundle_version: stamp.bundle_version,
    bundle_hash: stamp.bundle_hash,
  };
}
