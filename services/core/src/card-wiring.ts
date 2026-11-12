import { FactoryM1Eligibility } from './factory-m1.js';
import type { ConfigDeps, ConfigRegistry } from '@aisdlc/config';
import { PortError, type EligibilityPort, type StepUpPort } from '@aisdlc/decisions';
import { IdentityEligibility } from '@aisdlc/identity/read';
import { err } from '@aisdlc/kernel';
import { DbPrincipalLinks } from './cards/links.js';
import type { CardDeps } from './cards/model.js';
import type { KnowledgePort } from './clients.js';
import type { S0Settings } from './driver.js';
import { DbProjectSettings } from './settings.js';
import type pg from 'pg';

/**
 * The onboarding cards' dependencies as a deployment builds them (PLAN M8.0), once for core (the
 * card routes: prepare, view, decide) and once for core-worker (`cardsLoop`), so the two cannot
 * disagree.
 *
 *  - `bootstrap: true`: the first onboarding of a project is decided by its requester as the
 *    provisional admin (M7.4). The card layer scopes the grant to one S0 record per operation, so
 *    `eligibility` here MUST be the plain port (identity's), never a `BootstrapEligibility`, which
 *    would answer for every record that holds a grant and so defeat the scoping.
 *  - `links` read the identity read model (`DbPrincipalLinks`) through a pool of its own, because
 *    the card layer calls it while a decision transaction holds a connection.
 */
export interface CardWiring {
  readonly pool: pg.Pool;
  /** A second pool for the identity read model's catch-up (not the one decisions run in). */
  readonly readPool: pg.Pool;
  readonly registry: ConfigRegistry;
  readonly ledger: ConfigDeps['ledger'];
  readonly eligibility: EligibilityPort;
  readonly stepUp: StepUpPort;
  readonly knowledge: KnowledgePort;
  readonly source: CardDeps['source'];
  readonly settings?: () => S0Settings;
  /** MM-2 (`maintenanceFrom`): decisions are refused and the timers frozen while it is on. */
  readonly maintenance?: () => boolean;
}

export function cardDepsFrom(w: CardWiring): CardDeps {
  const kernel: ConfigDeps = {
    pool: w.pool,
    ledger: w.ledger,
    eligibility: w.eligibility,
    stepUp: w.stepUp,
    registry: w.registry,
    ...(w.maintenance ? { maintenance: w.maintenance } : {}),
  };
  return {
    pool: w.pool,
    decisions: kernel,
    config: kernel,
    registry: w.registry,
    knowledge: w.knowledge,
    source: w.source,
    links: new DbPrincipalLinks(w.readPool),
    bootstrap: true,
    ...(w.settings ? { settings: w.settings } : {}),
  };
}

/** Identity's answer to "who holds this slot", over the record database (the plain port, see above). */
export function identityEligibility(pool: pg.Pool, registry: ConfigRegistry): EligibilityPort {
  // M15.5: the factory pseudo-project's M1 is decided under `factory.m1_policy` (FactoryM1Eligibility)
  return FactoryM1Eligibility.over(
    new IdentityEligibility({ pool, settings: new DbProjectSettings({ pool, registry }) }),
    pool,
  );
}

/**
 * For a process that opens and applies cards but never takes a person's decision (core-worker's
 * `cardsLoop`): a step-up proof is checked where the decision is made, in core. Always refuses.
 */
export class RefusingStepUp implements StepUpPort {
  async verify() {
    return err(PortError({ message: 'this process takes no decisions' }));
  }
}
