import {
  AffirmedFilesValue,
  BranchRules,
  DRIFT_EVENT,
  DriftEvaluatedPayload,
  DriftReaffirmedPayload,
  DriftRestoredPayload,
  DriftSecurityConfirmedPayload,
  DriftSecurityRaisedPayload,
  DriftSuspendedPayload,
  InstallationObservation,
  OpenFindingsValue,
  DriftVersionRequestedPayload,
  INBOUND_FACT_EVENT,
  InboundFactPayload,
  PACK_EVENT,
  PackRenderedPayload,
  driftStream,
  inboundFactStream,
  packStream,
  type DriftBaseline,
  type PackFile,
  type RecordEvent,
} from '@aisdlc/contracts';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import type { PrrVersion } from '../fold.js';
import { readGoverning } from '../prr-store.js';
import { trackedFiles, type DriftInputs } from './evaluate.js';

// The after-onboarding state of one repo, read from the record only (PLAN M16; DEC-12(a)): the governing readiness
// record, its pack (`pack:<s0>`), the repo's `drift:<repo>` stream (evaluations, suspensions, restores,
// re-affirmations, version requests) and the newest inbound facts. Nothing here reads the code host.

export interface DriftStream {
  readonly events: readonly RecordEvent[];
  /** The newest evaluation of each version. */
  readonly evaluated: ReadonlyMap<number, DriftEvaluatedPayload & { at: string }>;
  readonly suspensions: ReadonlyArray<DriftSuspendedPayload & { at: string }>;
  readonly restores: ReadonlyArray<DriftRestoredPayload>;
  readonly reaffirmations: ReadonlyArray<DriftReaffirmedPayload>;
  readonly versions: ReadonlyArray<DriftVersionRequestedPayload & { at: string }>;
  /** OB §8 security events, and the installations the security slot confirmed. */
  readonly security_raised: ReadonlyArray<DriftSecurityRaisedPayload & { at: string }>;
  readonly security_confirmed: ReadonlyArray<DriftSecurityConfirmedPayload>;
}

export function foldDrift(events: readonly RecordEvent[]): DriftStream {
  const evaluated = new Map<number, DriftEvaluatedPayload & { at: string }>();
  const suspensions: Array<DriftSuspendedPayload & { at: string }> = [];
  const restores: DriftRestoredPayload[] = [];
  const reaffirmations: DriftReaffirmedPayload[] = [];
  const versions: Array<DriftVersionRequestedPayload & { at: string }> = [];
  const security_raised: Array<DriftSecurityRaisedPayload & { at: string }> = [];
  const security_confirmed: DriftSecurityConfirmedPayload[] = [];
  for (const e of events) {
    switch (e.type) {
      case DRIFT_EVENT.evaluated: {
        const p = DriftEvaluatedPayload.parse(e.payload);
        evaluated.set(p.prr_version, { ...p, at: e.occurred_at });
        break;
      }
      case DRIFT_EVENT.suspended:
        suspensions.push({ ...DriftSuspendedPayload.parse(e.payload), at: e.occurred_at });
        break;
      case DRIFT_EVENT.restored:
        restores.push(DriftRestoredPayload.parse(e.payload));
        break;
      case DRIFT_EVENT.reaffirmed:
        reaffirmations.push(DriftReaffirmedPayload.parse(e.payload));
        break;
      case DRIFT_EVENT.version_requested:
        versions.push({ ...DriftVersionRequestedPayload.parse(e.payload), at: e.occurred_at });
        break;
      case DRIFT_EVENT.security_raised:
        security_raised.push({
          ...DriftSecurityRaisedPayload.parse(e.payload),
          at: e.occurred_at,
        });
        break;
      case DRIFT_EVENT.security_confirmed:
        security_confirmed.push(DriftSecurityConfirmedPayload.parse(e.payload));
        break;
    }
  }
  return {
    events,
    evaluated,
    suspensions,
    restores,
    reaffirmations,
    versions,
    security_raised,
    security_confirmed,
  };
}

async function streamOf(db: Executor, name: string): Promise<RecordEvent[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [name],
  );
  return q.rows.map(toRecordEvent);
}

export interface DriftFact<T> {
  readonly value: T;
  readonly value_hash: string;
  readonly at: string;
}

/** Every recorded fact of one kind for a repo, oldest first (a fact that no longer parses is skipped). */
async function factsOf<T>(
  db: Executor,
  kind: 'affirmed_files' | 'effective_rules' | 'installation' | 'open_findings',
  repo: string,
  parse: (v: unknown) => T | null,
): Promise<DriftFact<T>[]> {
  const out: DriftFact<T>[] = [];
  for (const e of await streamOf(db, inboundFactStream(kind, repo))) {
    if (e.type !== INBOUND_FACT_EVENT.observed) continue;
    const p = InboundFactPayload.safeParse(e.payload);
    if (!p.success) continue;
    const v = parse(p.data.value);
    if (v !== null) out.push({ value: v, value_hash: p.data.value_hash, at: e.occurred_at });
  }
  return out;
}

const parseWith =
  <T>(schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }) =>
  (v: unknown): T | null => {
    const r = schema.safeParse(v);
    return r.success ? r.data : null;
  };

/** The newest rendered pack's files for an S0 record (empty: none rendered). */
export async function packFilesOf(db: Executor, s0Id: string): Promise<PackFile[]> {
  const ev = (await streamOf(db, packStream(s0Id))).filter((e) => e.type === PACK_EVENT.rendered);
  const last = ev.at(-1);
  return last ? PackRenderedPayload.parse(last.payload).files : [];
}

export interface LoadedDrift {
  readonly repo_ref: string;
  readonly project_id: string;
  readonly governing: PrrVersion | null;
  readonly drift: DriftStream;
  readonly pack: readonly PackFile[];
  readonly files: DriftFact<AffirmedFilesValue> | null;
  readonly files_history: readonly DriftFact<AffirmedFilesValue>[];
  readonly rules: DriftFact<BranchRules> | null;
  /** The newest `installation` fact's installation (`null`: none recorded, or the repo is no longer reached). */
  readonly installation: DriftFact<InstallationObservation> | null;
  /** Every `open_findings` fact, oldest first. */
  readonly open_findings: readonly DriftFact<OpenFindingsValue>[];
}

/** The installation of an `installation` fact (`{installation, repo}`), or `null` when it does not parse. */
function installationOf(v: unknown): InstallationObservation | null {
  const i = (v as { installation?: unknown } | null)?.installation as
    | { installation_id?: unknown; repository_selection?: unknown; permissions?: unknown }
    | undefined;
  const p = InstallationObservation.safeParse({
    installation_id: i?.installation_id,
    repository_selection: i?.repository_selection,
    permissions: i?.permissions,
  });
  return p.success ? p.data : null;
}

/** Everything the fold needs for one repo; `null` for a repo core never registered. */
export async function loadDrift(db: Executor, repo: string): Promise<LoadedDrift | null> {
  const g = await readGoverning(db, repo);
  if (!g) return null;
  const drift = foldDrift(await streamOf(db, driftStream(g.repo_ref)));
  const pack = g.governing ? await packFilesOf(db, g.governing.s0_id) : [];
  const files = await factsOf(db, 'affirmed_files', g.repo_ref, parseWith(AffirmedFilesValue));
  const rules = await factsOf(db, 'effective_rules', g.repo_ref, parseWith(BranchRules));
  const installs = await factsOf(db, 'installation', g.repo_ref, installationOf);
  const open = await factsOf(db, 'open_findings', g.repo_ref, parseWith(OpenFindingsValue));
  return {
    repo_ref: g.repo_ref,
    project_id: g.project_id,
    governing: g.governing,
    drift,
    pack,
    files: files.at(-1) ?? null,
    files_history: files,
    rules: rules.at(-1) ?? null,
    installation: installs.at(-1) ?? null,
    open_findings: open,
  };
}

/** The re-affirmations of one version, by path (the newest wins). */
export function reaffirmedOf(
  d: DriftStream,
  version: number,
): Map<string, { text_sha256: string; blob_sha: string; text: string }> {
  const out = new Map<string, { text_sha256: string; blob_sha: string; text: string }>();
  for (const r of d.reaffirmations) {
    if (r.prr_version !== version) continue;
    out.set(r.path, { text_sha256: r.text_sha256, blob_sha: r.blob_sha, text: r.text });
  }
  return out;
}

/** The baseline the newest restore of this version accepted, or `null`. */
export function baselineFor(d: DriftStream, version: number): DriftBaseline | null {
  return [...d.restores].reverse().find((r) => r.prr_version === version)?.baseline ?? null;
}

/** The fold's inputs for the governing version; `null` when no record governs the repo. */
export function inputsOf(l: LoadedDrift): DriftInputs | null {
  const g = l.governing;
  if (!g) return null;
  return {
    level: g.prr.level.signed,
    controls: g.prr.controls,
    tracked: trackedFiles(g.prr, l.pack, reaffirmedOf(l.drift, g.version)),
    baseline: baselineFor(l.drift, g.version),
    files_history: l.files_history.map((f) => f.value),
    files: l.files?.value ?? null,
    rules: l.rules?.value ?? null,
    // OB §8: the installation the record saw at 0.4, or the newest the security slot confirmed for this version
    installation_base:
      [...l.drift.security_confirmed].reverse().find((c) => c.prr_version === g.version)
        ?.installation ?? g.prr.controls.app_installation,
    installation: l.installation?.value ?? null,
    // the findings the record knew of: none when it signed with no open finding, else those of the first poll
    findings_base:
      g.prr.security_summary.history_scan.open === 0
        ? []
        : (l.open_findings[0]?.value.finding_ids ?? null),
    open_findings: l.open_findings.at(-1)?.value.finding_ids ?? null,
  };
}
