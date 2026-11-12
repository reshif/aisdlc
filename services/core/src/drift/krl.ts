import { readinessCap } from '@aisdlc/catalogue';
import {
  AutonomyValues,
  DRIFT_EVENT,
  type Autonomy,
  type DriftKrlLoweredPayload,
  type ProjectReadinessRecord,
} from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';
import { loadDrift, type DriftStream } from './state.js';

// KRL −1 on instruction drift (PLAN M16 part 3; OB §4.2 "the area gets KRL −1", §8 "Instruction text drift"; §2.3
// "Automatic changes may only tighten"). The PRR version is immutable: its pillars and its `autonomy.effective` stay as
// signed. What changes is the autonomy the factory USES now: while an area has an open penalty the repo's KRL reads one
// lower, the composite is the min of the pillars with that KRL, and the effective autonomy is the signed one capped by
// the readiness cap of that composite (tighten only, never above what was signed).
//
// A penalty is a `drift.krl_lowered` event (ledgered) for one path of one version. It is open until a person
// re-affirms that path (`drift.reaffirmed` later in the stream, for the same version and path), or a new version is
// made active by its M4 (penalties belong to their version). Nothing mechanical lifts it: a revert of the file to the
// affirmed bytes clears the finding, not the penalty (loosening needs a human).

export interface OpenKrlPenalty extends DriftKrlLoweredPayload {
  readonly at: string;
}

/** The open KRL penalties of a version, in record order. */
export function openKrl(d: DriftStream, version: number): OpenKrlPenalty[] {
  const open = new Map<string, OpenKrlPenalty>();
  for (const e of d.events) {
    if (e.type === DRIFT_EVENT.krl_lowered) {
      const p = e.payload as DriftKrlLoweredPayload;
      if (p.prr_version === version && !open.has(p.path)) {
        open.set(p.path, { ...p, at: e.occurred_at });
      }
    } else if (e.type === DRIFT_EVENT.reaffirmed) {
      const p = e.payload as { prr_version?: number; path?: string };
      if (p.prr_version === version && typeof p.path === 'string') open.delete(p.path);
    }
  }
  return [...open.values()];
}

const rank = (a: Autonomy): number => AutonomyValues.indexOf(a);

export interface KrlNow {
  readonly signed: number;
  readonly current: number;
  readonly effective_signed: Autonomy;
  readonly effective_now: Autonomy;
}

/** The KRL and the effective autonomy a record gives now, with `penalised` areas open (pure). */
export function krlNow(prr: ProjectReadinessRecord, penalised: number): KrlNow {
  const krl = prr.pillars.find((p) => p.pillar === 'KRL');
  const signed = krl?.level ?? 0;
  const current = penalised > 0 ? Math.max(0, signed - 1) : signed;
  const effective_signed = prr.autonomy.effective;
  if (current === signed)
    return { signed, current, effective_signed, effective_now: effective_signed };
  const composite = Math.min(
    ...prr.pillars.map((p) => (p.pillar === 'KRL' ? current : p.level)),
    current,
  );
  // RL0 is not stated: fail closed to the lowest autonomy
  const cap = readinessCap(composite) ?? (AutonomyValues[0] as Autonomy);
  return {
    signed,
    current,
    effective_signed,
    effective_now: rank(cap) < rank(effective_signed) ? cap : effective_signed,
  };
}

/**
 * The autonomy cap a repo's work runs under now: the governing record's, tightened by its open KRL penalties. `null`
 * when no record governs the repo.
 */
export async function autonomyNow(
  db: Executor,
  repo: string,
): Promise<(KrlNow & { readonly penalties: readonly OpenKrlPenalty[] }) | null> {
  const l = await loadDrift(db, repo);
  const g = l?.governing;
  if (!l || !g) return null;
  const penalties = openKrl(l.drift, g.version);
  return { ...krlNow(g.prr, new Set(penalties.map((p) => p.area)).size), penalties };
}
