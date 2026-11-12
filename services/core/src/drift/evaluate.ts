import {
  type AffirmedFilesValue,
  type BranchRules,
  type CodeownersObservation,
  type DriftBaseline,
  type DriftFinding,
  type Level,
  type PackFile,
  type ProjectReadinessRecord,
  type ServedFile,
} from '@aisdlc/contracts';
import { protectMain } from '../cards/controls.js';

// The drift fold (PLAN M16; OB §4.2, §8; DEC-21): pure, deterministic, no clock and no I/O. It compares the newest
// recorded facts (the `affirmed_files` fact at the default branch's head, the effective-rules fact) with what the
// governing readiness record holds, the pack the factory projected, and what people decided since (re-affirmations,
// the baseline a restore accepted). Unknown is never clean: a fact that is missing is no finding (nothing was seen),
// but a fact that says "could not tell" (CODEOWNERS errors `unknown`) is a `suspend` finding.

/** One file the record tracks at the head. */
export interface TrackedFile {
  readonly path: string;
  /** `instruction_text` (an affirmed AGENTS.md / CLAUDE.md section's file) or `pack_file` (rendered by the pack). */
  readonly kind: 'instruction_text' | 'pack_file';
  /** The sha256 the record says the file should have: the affirmed or rendered text. */
  readonly expected_sha256: string;
  /** git's blob id of the repo file the affirmation was drafted from (still there: the projection is pending). */
  readonly baseline_blob_sha: string | null;
}

export interface DriftInputs {
  readonly level: Level;
  readonly controls: ProjectReadinessRecord['controls'];
  readonly tracked: readonly TrackedFile[];
  /** The baseline the newest restore accepted, for this version; `null`: the record's own 0.4 reads. */
  readonly baseline: DriftBaseline | null;
  /** Newest first is not needed: every `affirmed_files` value of the stream since the record was made active. */
  readonly files_history: readonly AffirmedFilesValue[];
  readonly files: AffirmedFilesValue | null;
  readonly rules: BranchRules | null;
}

/** The paths the record tracks: the affirmed instruction files, then the pack's other files (one row per path). */
export function trackedFiles(
  prr: ProjectReadinessRecord,
  pack: readonly PackFile[],
  reaffirmed: ReadonlyMap<string, { text_sha256: string; blob_sha: string }>,
): TrackedFile[] {
  const out = new Map<string, TrackedFile>();
  for (const i of prr.affirmed.instructions) {
    out.set(i.path, {
      path: i.path,
      kind: 'instruction_text',
      expected_sha256: i.text_sha256,
      baseline_blob_sha: i.source_blob_sha ?? null,
    });
  }
  for (const f of pack) {
    if (out.has(f.path)) continue;
    out.set(f.path, {
      path: f.path,
      kind: f.source === 'affirmed_instructions' ? 'instruction_text' : 'pack_file',
      expected_sha256: f.sha256,
      baseline_blob_sha: null,
    });
  }
  // a re-affirmation replaces what is served for its path; the repo file it was read from is in sync by definition
  for (const [path, r] of reaffirmed) {
    const cur = out.get(path);
    out.set(path, {
      path,
      kind: cur?.kind ?? 'instruction_text',
      expected_sha256: r.text_sha256,
      baseline_blob_sha: r.blob_sha,
    });
  }
  return [...out.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const obsOf = (v: AffirmedFilesValue | null, path: string) =>
  v?.files.find((f) => f.path === path) ?? null;

/** The state of each tracked file at the head (OB §4.1: affirmed, a pending projection, drift, or absent). */
export function servedFiles(
  i: Pick<DriftInputs, 'tracked' | 'files' | 'files_history'>,
): ServedFile[] {
  return i.tracked.map((t) => {
    const o = obsOf(i.files, t.path);
    const sha = o?.sha256 ?? null;
    const state = fileState(t, i.files, i.files_history);
    return {
      path: t.path,
      state,
      served_sha256: t.expected_sha256 as never,
      observed_sha256: sha as never,
    };
  });
}

function fileState(
  t: TrackedFile,
  files: AffirmedFilesValue | null,
  history: readonly AffirmedFilesValue[],
): ServedFile['state'] {
  if (!files) return 'pending_projection';
  const o = obsOf(files, t.path);
  if (o?.sha256 === t.expected_sha256) return 'affirmed';
  // once the head carried the affirmed (or rendered) bytes, any other content is drift, deletion included
  const wasInSync = history.some((v) => obsOf(v, t.path)?.sha256 === t.expected_sha256);
  const present = o !== null && o.sha256 !== null;
  const atBaseline = t.baseline_blob_sha !== null ? o?.blob_sha === t.baseline_blob_sha : !present;
  if (atBaseline && !wasInSync) return 'pending_projection';
  return present ? 'drift' : 'absent';
}

const BY_KEY = (a: DriftFinding, b: DriftFinding): number => {
  const ka = `${a.kind}|${a.subject ?? ''}`;
  const kb = `${b.kind}|${b.subject ?? ''}`;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
};

/** The findings for a repo: what drifted, and what that does. Sorted, so the hash of two equal sets is equal. */
export function evaluateDrift(i: DriftInputs): DriftFinding[] {
  const out: DriftFinding[] = [];

  // instruction text and pack files: the factory keeps serving the affirmed text; a person re-affirms
  for (const t of i.tracked) {
    const state = fileState(t, i.files, i.files_history);
    if (state !== 'drift' && state !== 'absent') continue;
    const o = obsOf(i.files, t.path);
    out.push({
      kind: t.kind,
      effect: 'reaffirm',
      subject: t.path,
      reasons: [state === 'absent' ? 'file_deleted' : 'file_changed'],
      expected: t.expected_sha256,
      observed: o?.sha256 ?? null,
    });
  }

  // CODEOWNERS: a control observed at 0.4 (or accepted at a restore); gone, broken or changed suspends
  const co: CodeownersObservation | null =
    i.baseline?.codeowners ??
    (i.controls.codeowners
      ? {
          path: i.controls.codeowners.path,
          blob_sha: i.controls.codeowners.blob_sha,
          errors: i.controls.codeowners.errors,
        }
      : null);
  if (i.files && co) {
    const now = i.files.codeowners;
    // the pack may have projected CODEOWNERS: its rendered bytes at the head are not drift
    const projected = i.tracked.some(
      (t) =>
        now !== null && t.path === now.path && obsOf(i.files, t.path)?.sha256 === t.expected_sha256,
    );
    const reasons: string[] = [];
    if (now === null) reasons.push('codeowners_deleted');
    else {
      if (now.errors === 'unknown') reasons.push('codeowners_errors_unknown');
      else if (now.errors > 0 && (co.errors === 'unknown' || now.errors > co.errors)) {
        reasons.push('codeowners_errors');
      }
      if ((now.blob_sha !== co.blob_sha || now.path !== co.path) && !projected) {
        reasons.push('codeowners_changed');
      }
    }
    if (reasons.length > 0) {
      out.push({
        kind: 'codeowners',
        effect: 'suspend',
        subject: co.path,
        reasons,
        expected: co.blob_sha,
        observed: now?.blob_sha ?? null,
      });
    }
  }

  if (i.rules) {
    // the required checks the record saw (with the App each was pinned to): gone or unpinned suspends
    const base =
      i.baseline?.required_checks ??
      (i.controls.effective_rules?.required_checks ?? []).map((c) => ({
        name: c.name,
        integration_id: c.integration_id ?? null,
      }));
    for (const c of base) {
      const seen = i.rules.required_checks.find((r) => r.context === c.name);
      if (!seen) {
        out.push({
          kind: 'required_check',
          effect: 'suspend',
          subject: c.name,
          reasons: ['check_removed'],
          expected: c.integration_id === null ? null : String(c.integration_id),
          observed: null,
        });
      } else if (c.integration_id !== null && seen.integration_id !== c.integration_id) {
        out.push({
          kind: 'required_check',
          effect: 'suspend',
          subject: c.name,
          reasons: ['check_unpinned'],
          expected: String(c.integration_id),
          observed: seen.integration_id === null ? null : String(seen.integration_id),
        });
      }
    }
    // protect-main: a floor of every level above Census (LF2), so anything weaker than it is a loosened control
    if (i.level !== 'census') {
      const v = protectMain({ state: 'ok', value: i.rules });
      if (v.status !== 'met') {
        out.push({
          kind: 'protect_main',
          effect: 'suspend',
          subject: i.rules.branch,
          reasons: v.reasons.slice(0, 20),
          expected: null,
          observed: null,
        });
      }
    }
  }
  return out.sort(BY_KEY);
}

/** Only the findings that suspend. */
export const suspending = (f: readonly DriftFinding[]): DriftFinding[] =>
  f.filter((x) => x.effect === 'suspend');

/** The baseline a restore accepts: the controls the clean re-check saw. */
export function baselineOf(
  files: AffirmedFilesValue | null,
  rules: BranchRules | null,
  prior: DriftBaseline | null,
): DriftBaseline {
  return {
    required_checks: rules
      ? rules.required_checks
          .map((c) => ({ name: c.context, integration_id: c.integration_id }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      : (prior?.required_checks ?? null),
    codeowners: files ? files.codeowners : (prior?.codeowners ?? null),
  };
}
