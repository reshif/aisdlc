import {
  C1DecisionContent,
  C4DecisionContent,
  C5DecisionContent,
  KillDelegation,
  ProjectSettingsDoc,
  PROJECT_CONFIG_KEYS,
  SecrDecisionContent,
  gatingFloorViolations,
  projectSettingsTierViolations,
  type CardPayloadItem,
  type KillDelegation as KillDelegationT,
  type PrincipalId,
  type Scope,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { ZodType } from 'zod';
import { coreError, type CoreError } from '../errors.js';
import { gapLedgerHash, gapPayload } from './gaps.js';
import { tierBelow, type C1Ctx, type C4Ctx, type C5Ctx } from './views.js';

// Turning what a person sends into the list payload of the ledger entry (SP-PROC-2). Each rule of
// the spec is checked here, before anything is written, and a refusal says which one. The payload
// holds every choice of the decision, so its one hash binds all of it.

function parse<S extends ZodType>(schema: S, v: unknown): Result<S['_output'], CoreError> {
  const p = schema.safeParse(v ?? {});
  return p.success ? ok(p.data) : err(coreError('invalid_input', p.error.message));
}

// ---------------------------------------------------------------- card 1

/** Owner(s), tier (raise-only, T0 needs the positive attestation), disputes, every gap disposed. */
export function planC1(
  c: C1Ctx,
  content: unknown,
  now: Date,
): Result<CardPayloadItem[], CoreError> {
  const p = parse(C1DecisionContent, content);
  if (!p.ok) return p;
  const d = p.value;
  if (new Set(d.owners).size !== d.owners.length) {
    return err(coreError('invalid_input', 'an owner is listed twice'));
  }
  if (tierBelow(d.tier, c.floor)) {
    return err(
      coreError(
        'refused',
        `the tier is raise-only: the floor is ${c.floor}, ${d.tier} is below it`,
      ),
    );
  }
  if (d.tier === 'T0' && c.t0_required && d.t0_attestation !== true) {
    return err(
      coreError(
        'refused',
        'T0 needs the owner\'s positive attestation: "no prod, no real data, no dependants" (DEC-4)',
      ),
    );
  }
  const refs = new Set<string>();
  for (const x of d.disputes ?? []) {
    if (refs.has(x.ref)) return err(coreError('invalid_input', `${x.ref} is disputed twice`));
    refs.add(x.ref);
  }
  const gaps = gapPayload(c.gaps, d.gaps, now);
  if (!gaps.ok) return gaps;
  return ok([
    { kind: 'owner_confirmation', owners: [...d.owners].sort() as PrincipalId[] },
    {
      kind: 'tier_decision',
      tier: d.tier,
      floor: c.floor,
      t0_attested: d.tier === 'T0' && d.t0_attestation === true,
      regulatory_attested: d.regulatory_attested === true,
      criticality_attested: d.criticality_attested === true,
    },
    ...[...(d.disputes ?? [])]
      .sort((a, b) => (a.ref < b.ref ? -1 : 1))
      .map((x) => ({ kind: 'evidence_dispute' as const, ref: x.ref, note: x.note })),
    {
      kind: 'gap_ledger',
      census_hash: c.census.census_hash,
      gap_ledger_hash: gapLedgerHash(c.gaps, gaps.value) as never,
      gaps: c.gaps.length,
    },
    ...gaps.value,
  ] as CardPayloadItem[]);
}

// ---------------------------------------------------------------- card 4

const sameScope = (a: Scope, b: Scope): boolean => a.kind === b.kind && a.ref === b.ref;

/** The delegations after this decision: kept, new (stamped by the server), revoked (omitted). */
function mergeKills(
  current: readonly KillDelegationT[],
  wanted: ReadonlyArray<{ delegate: PrincipalId; scope: Scope }>,
  project: string,
  actor: PrincipalId,
  now: Date,
): Result<KillDelegationT[], CoreError> {
  const at = now.toISOString();
  const out: KillDelegationT[] = [];
  for (const w of wanted) {
    const inProject =
      (w.scope.kind === 'project' && w.scope.ref === project) ||
      (w.scope.kind === 'lane' && w.scope.ref.startsWith(`${project}/`));
    if (!inProject) {
      return err(coreError('refused', 'a kill delegation covers this project or one of its lanes'));
    }
  }
  const seen = new Set<string>();
  for (const w of wanted) {
    const key = `${w.delegate}|${w.scope.kind}|${w.scope.ref}`;
    if (seen.has(key)) return err(coreError('invalid_input', 'a kill delegation is listed twice'));
    seen.add(key);
  }
  const live = current.filter((c) => c.revoked_at === null);
  for (const c of current) if (c.revoked_at !== null) out.push(c);
  for (const w of wanted) {
    const kept = live.find((c) => c.delegate === w.delegate && sameScope(c.scope, w.scope));
    out.push(
      kept ?? {
        delegate: w.delegate,
        scope: w.scope,
        granted_by: actor,
        granted_at: at,
        revoked_at: null,
      },
    );
  }
  for (const c of live) {
    if (!wanted.some((w) => w.delegate === c.delegate && sameScope(c.scope, w.scope))) {
      out.push({ ...c, revoked_at: at });
    }
  }
  const checked = out.map((d) => KillDelegation.safeParse(d));
  const bad = checked.find((x) => !x.success);
  if (bad && !bad.success) return err(coreError('invalid_input', bad.error.message));
  return ok(
    out.sort((a, b) =>
      `${a.delegate}|${a.scope.ref}|${a.granted_at}` <
      `${b.delegate}|${b.scope.ref}|${b.granted_at}`
        ? -1
        : 1,
    ),
  );
}

/**
 * The controls report the person saw is the one read now, no blocking control is open, the
 * attestations are given, the settings fit the tier (T2: two-person locked on, the gating floor).
 */
export function planC4(
  c: C4Ctx,
  content: unknown,
  o: { project: string; actor: PrincipalId; now: Date },
): Result<CardPayloadItem[], CoreError> {
  const p = parse(C4DecisionContent, content);
  if (!p.ok) return p;
  const d = p.value;
  if (d.controls_report_hash !== c.report.report_hash) {
    return err(
      coreError('conflict', 'the controls report changed since you saw it: re-check, then decide'),
    );
  }
  if (c.report.blocking_open.length > 0) {
    return err(
      coreError(
        'refused',
        `blocking controls are not met (${c.report.blocking_open.join(', ')}): fix them on GitHub and re-check`,
      ),
    );
  }
  if (c.level_needs_operations && d.attestations.operations_md !== true) {
    return err(coreError('refused', 'at Light and above, operations.md is attested too'));
  }
  if (!c.level_needs_operations && d.attestations.operations_md !== undefined) {
    return err(coreError('invalid_input', 'operations.md is attested at Light and above only'));
  }
  const t2 = c.tier === 'T2';
  if (t2 && !d.two_person_enabled) {
    return err(
      coreError('refused', 'a T2 project locks two-person on: a single-person setting is refused'),
    );
  }
  const slots = d.role_map;
  for (const slot of ['admin', 'm4'] as const) {
    const v = slots[slot];
    if (v.kind !== 'principals' || v.principals.length === 0) {
      return err(coreError('refused', `the ${slot} slot needs at least one person`));
    }
  }
  const floor = gatingFloorViolations(d.gating_profile, { tier: c.tier, deploys: c.deploys });
  if (floor.length > 0) return err(coreError('refused', floor.join('; ')));
  const kills = mergeKills(
    c.current?.settings.kill_delegations ?? [],
    d.kill_delegations,
    o.project,
    o.actor,
    o.now,
  );
  if (!kills.ok) return kills;
  const two_person = {
    enabled: d.two_person_enabled || t2,
    default: 'on_if_2plus' as const,
    locked_on: t2,
  };
  const doc = ProjectSettingsDoc.safeParse({
    [PROJECT_CONFIG_KEYS.role_map]: d.role_map,
    [PROJECT_CONFIG_KEYS.two_person]: two_person,
    [PROJECT_CONFIG_KEYS.gating_profile]: d.gating_profile,
    [PROJECT_CONFIG_KEYS.kill_delegations]: kills.value,
  });
  if (!doc.success) return err(coreError('invalid_input', doc.error.message));
  const violations = projectSettingsTierViolations(
    {
      project_id: o.project as never,
      role_map: d.role_map,
      two_person,
      gating_profile: d.gating_profile,
      kill_delegations: kills.value,
      version: 1,
      updated_at: o.now.toISOString(),
    },
    { tier: c.tier, deploys: c.deploys },
  );
  if (violations.length > 0) return err(coreError('refused', violations.join('; ')));
  return ok([
    { kind: 'controls_report', report_hash: c.report.report_hash, reduced: c.report.reduced },
    { kind: 'controls_attestation', attestation: d.attestations },
    {
      kind: 'settings_decision',
      tier: c.tier,
      role_map: d.role_map,
      two_person,
      gating_profile: d.gating_profile,
      kill_delegations: kills.value,
    },
  ] as CardPayloadItem[]);
}

// ---------------------------------------------------------------- card 5 and the security card

export function planC5(c: C5Ctx, content: unknown): Result<CardPayloadItem[], CoreError> {
  const p = parse(C5DecisionContent, content);
  if (!p.ok) return p;
  return ok([{ kind: 'm4_package', ...c.package } as CardPayloadItem]);
}

export function planSecr(
  findingId: string,
  content: unknown,
): Result<{ payload: CardPayloadItem[]; reason: string }, CoreError> {
  const p = parse(SecrDecisionContent, content);
  if (!p.ok) return p;
  return ok({
    payload: [
      { kind: 'finding_state', finding_id: findingId, state: p.value.state } as CardPayloadItem,
    ],
    reason: p.value.reason,
  });
}
