import { PrincipalId, ProjectId, type OnboardRequest, type RoleSlot } from '@aisdlc/contracts';
import { ConfigRegistry, configPublish, migrateConfig, type ConfigDeps } from '@aisdlc/config';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  prepare,
  recordEvidenceViewed,
} from '@aisdlc/decisions';
import { startIdentityStack, type IdentityStack } from '@aisdlc/identity/testing';
import { registerPdpConfig } from '@aisdlc/pdp';
import { FakeGitHub, emptySeed, type CodeHostSeed } from '@aisdlc/ports';
import type { DriverDeps } from './driver.js';
import type { KnowledgePort, PrincipalLinksPort } from './clients.js';
import { FakePrincipalLinks } from './clients.js';
import type { CardDeps } from './cards/model.js';
import type { CoreDeps } from './journal.js';
import { migrateCore } from './migrations.js';
import { proposeProjectSettings, registerCoreConfig, type SettingsChange } from './settings.js';

// A real core stack for tests: one Postgres with the record, ledger, decisions, identity, config and
// core schemas (identity's own test stack underneath), a real kms-local and Notary, a manual clock,
// and the fakes behind the ports (FakeEligibility for who decides an M1 gate, FakeGitHub for the
// code host, a fake knowledge in the tests that need one).

export { T_START } from '@aisdlc/identity/testing';

export interface CoreStack {
  readonly id: IdentityStack;
  readonly record: IdentityStack['record'];
  readonly clock: IdentityStack['clock'];
  readonly registry: ConfigRegistry;
  readonly elig: FakeEligibility;
  /** For the decision kernel and config publishing. */
  readonly config: ConfigDeps & { readonly clock: IdentityStack['clock'] };
  /** For core's own writers. */
  readonly deps: CoreDeps & { readonly clock: IdentityStack['clock'] };
  stop(): Promise<void>;
}

export async function startCoreStack(): Promise<CoreStack> {
  const id = await startIdentityStack();
  try {
    await migrateConfig(id.record.pool);
    await migrateCore(id.record.pool);
    const registry = registerCoreConfig(registerPdpConfig(new ConfigRegistry()));
    const elig = new FakeEligibility();
    return {
      id,
      record: id.record,
      clock: id.clock,
      registry,
      elig,
      config: {
        pool: id.record.pool,
        ledger: id.ledger,
        eligibility: elig,
        stepUp: new FakeStepUp(),
        clock: id.clock,
        registry,
      },
      deps: { pool: id.record.pool, clock: id.clock },
      stop: () => id.stop(),
    };
  } catch (e) {
    await id.stop().catch(() => undefined);
    throw e;
  }
}

export const pr = (s: string): PrincipalId => PrincipalId.parse(s);
export const pid = (s: string): ProjectId => ProjectId.parse(s);

const SLOTS: readonly RoleSlot[] = [
  'admin',
  'requesters',
  'intent',
  'design',
  'g4',
  'g5',
  'x',
  'sec',
  'm4',
  'kill',
];

/** Who decides an M1 gate of the project (the `admin` slot) and the project's tier, for the fake eligibility. */
export function setAdmins(s: CoreStack, project: string, admins: string[]): void {
  s.elig.setPolicy(pid(project), { tier: 'T1' });
  for (const slot of SLOTS)
    s.elig.setHolders(pid(project), slot, slot === 'admin' ? admins.map(pr) : []);
}

/** prepare, evidence viewed, decide on a gate. */
export async function decideGate(s: CoreStack, gate: string, principal: string, decision: string) {
  const p = await prepare(s.config, { gate_instance_id: gate, principal: pr(principal) });
  if (!p.ok) return p;
  const v = await recordEvidenceViewed(s.config, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) return v;
  return decide(s.config, { nonce: p.value.nonce, decision });
}

/** Proposes project settings, approves the M1 gate with `approver`, publishes. Throws on any refusal. */
export async function publishSettings(
  s: CoreStack,
  project: string,
  change: SettingsChange,
  approver: string,
  proposer = approver,
) {
  const p = await proposeProjectSettings(s.config, {
    project: pid(project),
    change,
    proposed_by: pr(proposer),
  });
  if (!p.ok) throw new Error(`propose: ${p.error.message}`);
  const d = await decideGate(s, p.value.gate_instance_id, approver, 'approve');
  if (!d.ok) throw new Error(`decide: ${JSON.stringify(d.error)}`);
  const r = await configPublish(s.config, { rev_hash: p.value.rev_hash });
  if (!r.ok) throw new Error(`publish: ${JSON.stringify(r.error)}`);
  return { ...p.value, ...r.value };
}

export const SHA = 'a'.repeat(40);

export interface HostOptions {
  /** Repos the App is installed on. */
  readonly installed?: readonly string[];
  /** Installed repos with no commit on the default branch. */
  readonly blank?: readonly string[];
  readonly suspended?: boolean;
}

/** A `FakeGitHub` for the driver: installed repos (with a head unless blank). */
export function fakeHost(o: HostOptions = {}): FakeGitHub {
  const installed = o.installed ?? [];
  const blank = new Set(o.blank ?? []);
  return new FakeGitHub(hostSeed(o, installed, blank));
}

function hostSeed(o: HostOptions, installed: readonly string[], blank: Set<string>): CodeHostSeed {
  return emptySeed({
    installation: {
      installation_id: 4242,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'read', metadata: 'read' },
      suspended: o.suspended ?? false,
    },
    repos: installed.map((full_name) => ({
      full_name,
      default_branch: 'main',
      private: true,
      archived: false,
    })),
    heads: installed
      .filter((r) => !blank.has(r))
      .map((repo) => ({ repo, branch: 'main', sha: SHA })),
  });
}

/** Changes what the fake host knows (the App gets installed, a repo is committed to, ...). */
export function setHost(host: FakeGitHub, o: HostOptions): void {
  host.load(hostSeed(o, o.installed ?? [], new Set(o.blank ?? [])));
}

export const request = (over: Partial<OnboardRequest> = {}): OnboardRequest => ({
  project_id: pid('acme'),
  repo: 'acme/app',
  level: 'census',
  on_behalf_of: pr('alice'),
  ...over,
});

export function driverDeps(
  s: CoreStack,
  host: FakeGitHub,
  knowledge: KnowledgePort,
  over: Partial<DriverDeps> = {},
): DriverDeps {
  return { pool: s.record.pool, clock: s.clock, source: host, knowledge, ...over };
}

/**
 * Who holds each slot of a project and its tier, for the fake eligibility (the decision kernel's
 * port). Slots not listed are empty: nobody can decide what they decide.
 */
export function setSlots(
  s: CoreStack,
  project: string,
  slots: Partial<Record<RoleSlot, string[]>>,
  tier: 'T0' | 'T1' | 'T2' | null = 'T1',
): void {
  s.elig.setPolicy(pid(project), { tier });
  for (const slot of SLOTS) s.elig.setHolders(pid(project), slot, (slots[slot] ?? []).map(pr));
}

/** The card layer's dependencies over the stack, a host and a knowledge. */
export function cardDeps(
  s: CoreStack,
  host: FakeGitHub,
  knowledge: KnowledgePort,
  over: Partial<CardDeps> & { links?: PrincipalLinksPort } = {},
): CardDeps {
  return {
    pool: s.record.pool,
    clock: s.clock,
    decisions: s.config,
    config: s.config,
    registry: s.registry,
    knowledge,
    source: host,
    links: over.links ?? new FakePrincipalLinks(),
    ...over,
  };
}
