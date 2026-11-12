import {
  gatePolicy,
  type CardKind,
  type InstructionTemplate,
  type LightTestsConfig,
  type OnboardingStepId,
  type RoleSlot,
} from '@aisdlc/contracts';
import type { ConfigDeps, ConfigRegistry } from '@aisdlc/config';
import type { DecisionDeps } from '@aisdlc/decisions';
import { BootstrapEligibility } from '../bootstrap.js';
import type { Clock } from '@aisdlc/kernel';
import type { CodeHostPort } from '@aisdlc/ports';
import type pg from 'pg';
import type { KnowledgePort, PrincipalLinksPort } from '../clients.js';
import type { S0Settings } from '../driver.js';

// The onboarding cards (PLAN M7.3): cards 1, 4, 5 and the security card turn the driver's
// `s0.card_required` into inbox cards of the decision kernel and apply their decisions back to the
// S0 record. Nothing here approves anything: a card is decided by a person through
// prepare / evidence viewed / decide, and every decision is a ledger entry with the hash of its
// list payload.

/** The cards this layer owns. C2 is Light's (M16); C3 (Full) is a later task's. */
export const HANDLED_CARDS = ['C1', 'C2', 'C4', 'C5', 'SECR'] as const;
export type HandledCard = (typeof HANDLED_CARDS)[number];
export const isHandled = (k: string | null): k is HandledCard =>
  k !== null && (HANDLED_CARDS as readonly string[]).includes(k);

/** The S0 step a card decides. The security card belongs to 0.1 but is separate from card 1. */
export const STEP_OF_CARD: Readonly<Record<HandledCard, OnboardingStepId>> = {
  C1: '0.1',
  C2: '0.2',
  C4: '0.4',
  C5: '0.5',
  SECR: '0.1',
};

/**
 * Who decides a card. A step card has no gate of its own, so the slot comes from the gate policy
 * that governs the same kind of decision: onboarding's own decisions are meta decisions of the
 * project (the M family: the project `admin`), the security card is the security triage (`SECT`:
 * the `sec` slot). Changing a gate policy's slot moves the card with it.
 */
export const SLOT_OF_CARD: Readonly<Record<HandledCard, RoleSlot>> = {
  C1: gatePolicy('M1').slot,
  C2: gatePolicy('M1').slot,
  C4: gatePolicy('M1').slot,
  C5: gatePolicy('M1').slot,
  SECR: gatePolicy('SECT').slot,
};

/** What the card layer needs. The code host and knowledge are reached only through their ports. */
export interface CardDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  /** The decision kernel: the ledger, who holds a slot (`EligibilityPort`), step-up. */
  readonly decisions: DecisionDeps;
  /** Card 4 proposes the project's settings as a config revision (M1 gate); absent: it cannot be decided. */
  readonly config?: ConfigDeps;
  readonly registry: ConfigRegistry;
  readonly knowledge: KnowledgePort;
  /** The code host's reads: the controls report and the role map proposal. */
  readonly source: Pick<
    CodeHostPort,
    | 'list_repos'
    | 'installation'
    | 'branch_head'
    | 'rules_for_branch'
    | 'codeowners'
    | 'codeowners_errors'
    | 'collaborators'
    | 'read_at_sha'
  >;
  readonly links: PrincipalLinksPort;
  readonly settings?: () => S0Settings;
  /**
   * The bootstrap decider (PLAN M7.4): when set, the card operations of an S0 record that holds a
   * provisional grant resolve the `admin` slot to its requester while the project has no published
   * role map. Off by default: nothing is granted unless the deployment says so.
   */
  readonly bootstrap?: boolean;
  /**
   * Card 2's factory template (config `onboarding.instruction_template`, M1-gated). Absent: the
   * default. `null`: the published value does not read, and card 2 cannot open (fail closed).
   */
  readonly instructionTemplate?: () => InstructionTemplate | null;
  /** `onboarding.light_tests` (M16: the worker image LF4 is about). Absent: the defaults (LF4 unknown). */
  readonly lightTests?: () => LightTestsConfig | null;
}

/** The decision kernel's dependencies for one S0 record's card operations (bootstrap-aware when on). */
export function decisionsFor(deps: CardDeps, s0Id: string): DecisionDeps {
  if (!deps.bootstrap) return deps.decisions;
  return {
    ...deps.decisions,
    eligibility: new BootstrapEligibility(deps.decisions.eligibility, {
      pool: deps.pool,
      s0_id: s0Id,
    }),
  };
}

/** `decisionsFor` for the config publishing side (card 4 proposes the settings as a revision). */
export function configFor(deps: CardDeps, s0Id: string): ConfigDeps | undefined {
  if (!deps.config) return undefined;
  if (!deps.bootstrap) return deps.config;
  return { ...deps.config, eligibility: decisionsFor(deps, s0Id).eligibility };
}

export const SYSTEM_CARDS_ACTOR = 'system.cards';

/** The record's id on a card's subject, and the key of a step card (what makes its id unique). */
export const cardKey = (s0Id: string, kind: HandledCard, occurrence: number, finding?: string) =>
  `${s0Id}:${kind}:${occurrence}${finding === undefined ? '' : `:${finding}`}`;

export function parseCardKey(
  key: string | null,
): { s0_id: string; kind: string; occurrence: number; finding_id: string | null } | null {
  if (key === null) return null;
  const m = /^([0-9a-f-]{36}):([A-Z0-9]+):(\d+)(?::([0-9a-f-]{36}))?$/.exec(key);
  return m
    ? {
        s0_id: m[1] as string,
        kind: m[2] as string,
        occurrence: Number(m[3]),
        finding_id: m[4] ?? null,
      }
    : null;
}

export type { CardKind };
