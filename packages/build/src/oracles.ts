import { sha256 } from './store.js';
import type { ApprovedOracle, OracleFile } from './source.js';

// 6.3: the oracle code must be what G2 approved (PLAN M13.3; FL "D check: matches G2-approved oracle specs").
// An oracle test file names the spec it implements with ONE marker line:
//
//     // aisdlc-oracle id=<oracle_id> spec=<sha256 of the approved spec entry>
//
// The check is deterministic and data-only: it never runs the file. A deviation (an approved oracle with no code,
// code for an oracle nobody approved, code that says it implements another spec, an oracle that is not red) is what
// G3o decides; nothing deviating goes on without that decision.

const MARKER =
  /^[ \t]*(?:\/\/|#|--|\/\*)\s*aisdlc-oracle\s+id=([A-Za-z0-9_.:-]{1,64})\s+spec=([0-9a-f]{64})/m;

export type OracleDeviationKind =
  | 'oracle_missing'
  | 'oracle_unbound'
  | 'spec_mismatch'
  | 'no_marker'
  | 'duplicate_oracle'
  | 'oracle_not_red'
  | 'repro_missing';

export interface OracleDeviation {
  readonly kind: OracleDeviationKind;
  readonly oracle_id: string | null;
  readonly path: string | null;
}

export interface BoundOracle {
  readonly path: string;
  readonly oracle_id: string | null;
  readonly declared_spec_sha256: string | null;
  readonly code_sha256: string;
}

export function bindOracles(files: readonly OracleFile[]): BoundOracle[] {
  return files.map((f) => {
    const m = MARKER.exec(f.content);
    return {
      path: f.path,
      oracle_id: m ? (m[1] as string) : null,
      declared_spec_sha256: m ? (m[2] as string) : null,
      code_sha256: sha256(f.content),
    };
  });
}

/** The spec hash an approved oracle entry has (what a marker must carry): the sha256 of its canonical text. */
export const specHashOf = (entry: {
  oracle_id: string;
  requirement_id: string;
  description: string;
  expected_failure: string;
}): string =>
  sha256(
    JSON.stringify([
      entry.oracle_id,
      entry.requirement_id,
      entry.description,
      entry.expected_failure,
    ]),
  );

export function checkOracleBinding(
  approved: readonly ApprovedOracle[],
  bound: readonly BoundOracle[],
  repro: boolean,
): OracleDeviation[] {
  const out: OracleDeviation[] = [];
  if (repro) {
    // L0: no oracle specs: one failing repro test (a test file that carries the marker `id=repro`, or any one file)
    if (bound.length === 0) out.push({ kind: 'repro_missing', oracle_id: null, path: null });
    return out;
  }
  const byId = new Map<string, BoundOracle[]>();
  for (const b of bound) {
    if (b.oracle_id === null) out.push({ kind: 'no_marker', oracle_id: null, path: b.path });
    else byId.set(b.oracle_id, [...(byId.get(b.oracle_id) ?? []), b]);
  }
  const ids = new Set(approved.map((a) => a.oracle_id));
  for (const a of approved) {
    const have = byId.get(a.oracle_id) ?? [];
    if (have.length === 0) out.push({ kind: 'oracle_missing', oracle_id: a.oracle_id, path: null });
    else if (have.length > 1)
      out.push({ kind: 'duplicate_oracle', oracle_id: a.oracle_id, path: have[1]?.path ?? null });
    else if (have[0]?.declared_spec_sha256 !== a.spec_sha256) {
      out.push({ kind: 'spec_mismatch', oracle_id: a.oracle_id, path: have[0]?.path ?? null });
    }
  }
  for (const [id, list] of byId) {
    if (!ids.has(id))
      for (const b of list) out.push({ kind: 'oracle_unbound', oracle_id: id, path: b.path });
  }
  return out;
}
