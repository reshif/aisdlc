import {
  configProjection,
  configPublish,
  loadEffective,
  proposeRevision,
  type ConfigDeps,
} from '@aisdlc/config';
import {
  FACTORY_SCOPE,
  PRR_EVENT,
  PrrActivatedPayload,
  PrrProposedPayload,
  ProjectId,
  RoleSlotValues,
  SANDBOX_CAPS_KEY,
  prrStream,
  repoIdOf,
  type JsonObject,
  type PrincipalId,
  type PrrGatingProfile,
  type RoleMap,
  type RoleSlot,
} from '@aisdlc/contracts';
import {
  PortError,
  decide,
  prepare,
  recordEvidenceViewed,
  type EligibilityPort,
  type StepUpPort,
} from '@aisdlc/decisions';
import { err, ok, sha256Hex, type Clock } from '@aisdlc/kernel';
import { runProjection } from '@aisdlc/record';
import type pg from 'pg';
import { governingPrr } from '../fold.js';
import { inCoreTx, lockKeys } from '../journal.js';
import { readPrrState } from '../prr-store.js';
import { requestOnboarding } from '../s0.js';
import { proposeProjectSettings } from '../settings.js';
import { loadControls, loadPrr, loadPrrInputs } from './fixture.js';

// The load test's seed (PLAN M19; FACTORY_ENV=local only, like `aisdlc-seed`): N projects a work item can run in, as
// the onboarding would leave them, with the first decisions taken by a known person under a genesis eligibility (the
// same circle `aisdlc-seed` breaks for the factory: nobody holds a slot of a project before its first settings are
// published, and those settings are published through an M1 gate somebody must be eligible to decide). Every
// decision is a real ledger entry signed by the Notary. Per project:
//   1. the S0 request (`requestOnboarding`): the project and its repo exist in the record;
//   2. its PRR, proposed and activated (`fixture.ts`): tier T1, level full, the gating profile given;
//   3. its settings as a project-layer revision (role map, two-person off, the same gating), decided at its M1 gate
//      by the admin and published: core-worker's role-map sync then binds the role map in identity, and from there
//      the real eligibility, the PDP and the work engine decide everything else.
// And once for the factory: `sandbox.caps` at the coding cap the run asks for (H2 admits that many Units at once).
// Re-running changes nothing that is already in place.

export interface LoadPeople {
  /** Requests every item, holds the admin slot (the genesis M1 decider), decides G6 (the requester's acceptance). */
  readonly requester: PrincipalId;
  /** Decides every other gate (nobody decides a gate of their own request). */
  readonly approver: PrincipalId;
}

export const LOAD_GATING: PrrGatingProfile = {
  gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'off', g6: 'on' },
  schedule: 'auto',
  tier_floor_applied: true,
  project_deploys: false,
};

/** The pseudo-project the factory layer's M1 gates are decided in (as `aisdlc-seed`). */
const FACTORY_PROJECT = 'factory';

export const loadRepoOf = (project: string): string => `load-org/${project}`;

/** The role map of a load project: the requester requests (and accepts at G6), the approver decides. */
export function loadRoleMap(p: LoadPeople): RoleMap {
  return Object.fromEntries(
    RoleSlotValues.map((slot: RoleSlot) => [
      slot,
      {
        kind: 'principals',
        principals:
          slot === 'admin'
            ? [p.requester]
            : slot === 'requesters'
              ? [p.requester, p.approver]
              : [p.approver],
      },
    ]),
  ) as RoleMap;
}

/** The admin is the one holder of every first decision of the load projects and of the factory; nothing else is known. */
class LoadGenesisEligibility implements EligibilityPort {
  constructor(
    private readonly admin: PrincipalId,
    private readonly projects: ReadonlySet<string>,
  ) {}
  async holders(project: ProjectId, slot: RoleSlot) {
    if (project !== FACTORY_PROJECT && !this.projects.has(project)) {
      return err(PortError({ message: `the load seed knows only its own projects (${project})` }));
    }
    return ok(slot === 'admin' ? [this.admin] : ([] as readonly PrincipalId[]));
  }
  async policy(project: ProjectId) {
    if (project !== FACTORY_PROJECT && !this.projects.has(project)) {
      return err(PortError({ message: `unknown project ${project}` }));
    }
    return ok({
      tier: 'T1' as const,
      two_person: { enabled: false, default: 'on_if_2plus' as const, locked_on: false },
    });
  }
}

class NoStepUp implements StepUpPort {
  async verify() {
    return err(PortError({ message: 'the load seed has no step-up' }));
  }
}

export interface LoadSeedDeps {
  readonly pool: pg.Pool;
  readonly clock: Clock;
  /** The config deps with the real ledger (Notary); the seed puts its genesis eligibility in. */
  readonly config: Omit<ConfigDeps, 'eligibility' | 'stepUp'>;
  readonly log?: (l: string) => void;
}

async function decideM1(d: ConfigDeps, gate: string, who: PrincipalId): Promise<void> {
  const p = await prepare(d, { gate_instance_id: gate, principal: who });
  if (!p.ok) throw new Error(`prepare ${gate}: ${JSON.stringify(p.error)}`);
  const v = await recordEvidenceViewed(d, {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) throw new Error(`evidence ${gate}: ${JSON.stringify(v.error)}`);
  const r = await decide(d, { nonce: p.value.nonce, decision: 'approve' });
  if (!r.ok) throw new Error(`decide ${gate}: ${JSON.stringify(r.error)}`);
}

/** Seeds the projects (idempotent); returns the ones it made now. */
export async function seedLoad(
  d: LoadSeedDeps,
  o: { projects: readonly string[]; people: LoadPeople; codingCap: number },
): Promise<string[]> {
  const log = d.log ?? (() => undefined);
  const cfg: ConfigDeps = {
    ...d.config,
    eligibility: new LoadGenesisEligibility(o.people.requester, new Set(o.projects)),
    stepUp: new NoStepUp(),
  } as ConfigDeps;
  const core = { pool: d.pool, clock: d.clock };
  const made: string[] = [];

  // the factory: the coding cap H2 admits under (sandbox.caps, M1-gated)
  await runProjection(d.pool, configProjection);
  const factory = await loadEffective(d.pool, { layer: 'factory', scope: FACTORY_SCOPE });
  const caps = { total: Math.max(4, o.codingCap), coding: o.codingCap };
  const have = factory?.doc[SANDBOX_CAPS_KEY] as { coding?: number } | undefined;
  if (have?.coding !== o.codingCap) {
    const p = await proposeRevision(cfg, {
      layer: 'factory',
      doc: { ...((factory?.doc ?? {}) as JsonObject), [SANDBOX_CAPS_KEY]: caps },
      proposed_by: o.people.requester,
    });
    if (!p.ok) throw new Error(`propose sandbox.caps: ${p.error.code}: ${p.error.message}`);
    await decideM1(cfg, p.value.gate_instance_id, o.people.requester);
    const pub = await configPublish(cfg, { rev_hash: p.value.rev_hash });
    if (!pub.ok) throw new Error(`publish sandbox.caps: ${pub.error.message}`);
    log(`load seed: sandbox.caps ${JSON.stringify(caps)} published`);
  }

  for (const project of o.projects) {
    const repo = loadRepoOf(project);
    const state = await readPrrState(d.pool, project, repoIdOf(repo));
    if (governingPrr(state) === null) {
      const s0 = await requestOnboarding(core, {
        project_id: ProjectId.parse(project),
        repo,
        // the request names census (Full is a level-up after Light, OB 2.1); the PRR below is signed at full
        level: 'census',
        on_behalf_of: o.people.requester,
      });
      if (!s0.ok) throw new Error(`onboard ${project}: ${s0.error.message}`);
      const prr = loadPrr(
        loadPrrInputs({
          project,
          repo,
          now: d.clock.now(),
          admin: o.people.requester,
          gating: LOAD_GATING,
          report: await loadControls(repo),
        }),
      );
      const w = await inCoreTx(core, async (j, tx) => {
        await lockKeys(tx, [`project:${project}`, `repo:${repo.toLowerCase()}`]);
        const p = await j.emit(
          prrStream(project, repoIdOf(repo)),
          PRR_EVENT.proposed,
          PrrProposedPayload.parse({ s0_id: s0.value.s0_id, prr }),
          'load-seed',
        );
        if (!p.ok) return p;
        const a = await j.emit(
          prrStream(project, repoIdOf(repo)),
          PRR_EVENT.activated,
          PrrActivatedPayload.parse({
            s0_id: s0.value.s0_id,
            version: 1,
            record_hash: prr.record_hash,
            // no M4 card was decided: the reference names the seed, never a ledger entry that exists
            m4: {
              ledger_entry_id: '00000000-0000-4000-8000-00000000a0ad',
              decision_hash: sha256Hex(`load-seed:m4:${project}`),
            },
          }),
          'load-seed',
        );
        return a.ok ? ok(true) : a;
      });
      if (!w.ok) throw new Error(`PRR of ${project}: ${w.error.message}`);
      made.push(project);
      log(`load seed: ${project} (${repo}) has an active PRR`);
    }
    // the settings revision: proposed, decided at its M1 gate by the admin, published (unless it is in force)
    await runProjection(d.pool, configProjection);
    const eff = await loadEffective(d.pool, {
      layer: 'project',
      scope: { kind: 'project', ref: project },
    });
    if (eff === null) {
      const p = await proposeProjectSettings(cfg, {
        project: ProjectId.parse(project),
        change: {
          role_map: loadRoleMap(o.people),
          two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
          gating_profile: {
            gates: LOAD_GATING.gates,
            schedule: LOAD_GATING.schedule,
            tier_floor_applied: LOAD_GATING.tier_floor_applied,
          },
        },
        proposed_by: o.people.requester,
      });
      if (!p.ok) throw new Error(`settings of ${project}: ${p.error.code}: ${p.error.message}`);
      await decideM1(cfg, p.value.gate_instance_id, o.people.requester);
      const pub = await configPublish(cfg, { rev_hash: p.value.rev_hash });
      if (!pub.ok) throw new Error(`publish the settings of ${project}: ${pub.error.message}`);
      log(`load seed: the settings of ${project} are published`);
    }
  }
  return made;
}

/** The projects whose role map identity has bound (core-worker's role-map sync did it). */
export async function boundProjects(pool: pg.Pool, projects: readonly string[]): Promise<string[]> {
  const q = await pool.query<{ ref: string }>(
    `SELECT DISTINCT scope_ref AS ref FROM identity.binding
      WHERE scope_kind = 'project' AND scope_ref = ANY($1::text[]) AND constraints ->> 'origin' = 'role_map'`,
    [projects],
  );
  return q.rows.map((r) => r.ref).sort();
}
