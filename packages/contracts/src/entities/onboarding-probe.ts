import { z } from 'zod';
import { RepoFullName } from './codehost.js';
import { GitSha, S0RecordId, Sha256Hex } from './ids.js';
import { SandboxImageRef, SandboxRunStatus } from './sandbox.js';

// The onboarding probe (PLAN M16; OB §3.2 LF3, §5.6, §6.2 row 0.2; ADR-0003 §7 K-exec; DEC-17 refined, DEC-18).
//
// At Light (0.2) the factory runs the repo's OWN `setup` and `test` (the census's task-contract facts, read at the
// census head) once, in a K-exec session: the dedicated onboarding image (scanners and common libraries baked in at
// exact versions and checksums, named by digest in config `onboarding.sandbox_image`, M1-gated), the package mirror
// as the ONLY peer (no gateway, no key, no internet), and only for a repo on the DEC-18 owner allow-list (off the
// list: nothing runs, and that is recorded). The controller starts the session only under a probe grant core
// recorded first (`probe.granted`). The result is recorded (`probe.recorded`, record-first) and folded into
// `core.onboarding_probe` (rebuildable). LF3 is met only by a `passed` result for the census head card 2 shows:
// setup and test exited 0 and the test count is above zero. Anything else is unmet or unknown, and card 2 cannot be
// approved (no waiver: DEC-14).

// ---------------------------------------------------------------- The image (config)

/** The config key of the probe image (factory layer only, M1-gated: an image update is a reviewed config change). */
export const ONBOARDING_SANDBOX_IMAGE_KEY = 'onboarding.sandbox_image';

/**
 * The probe image: by digest only, and the sha256 of the pin lock it was built from (the image carries it as its
 * `aisdlc.onboarding.lock.sha256` label), so the reviewer of an M1 change sees what is inside. `null` (the default):
 * no image is approved yet, and no probe runs (LF3 stays unknown).
 */
export const OnboardingSandboxImage = z
  .strictObject({
    image: SandboxImageRef,
    lock_sha256: Sha256Hex,
  })
  .nullable();
export type OnboardingSandboxImage = z.infer<typeof OnboardingSandboxImage>;

// ---------------------------------------------------------------- The grant (what the controller checks)

/**
 * The Unit id a probe grant names: an onboarding probe has no work item and no Unit. The controller reads a grant
 * with this Unit from core's probe grants (`core.probe_grant`), for class K-exec only, while it is `granted` and
 * younger than `PROBE_GRANT_TTL_S`. `item_id` is the S0 record's id; `lease_epoch` is always 1.
 */
export const ONBOARDING_PROBE_UNIT = 'onboarding-probe';
export const PROBE_GRANT_LEASE_EPOCH = 1;
/** The probe grant lapses after this (the K-exec ceiling of 15 minutes plus slack). A lapsed grant starts nothing. */
export const PROBE_GRANT_TTL_S = 1200;

// ---------------------------------------------------------------- The record

export const probeStream = (s0Id: string): string => `probe:${s0Id}`;
export const PROBE_EVENT = {
  granted: 'probe.granted',
  recorded: 'probe.recorded',
} as const;

/** `probe-<32 hex>`: the probe's id, also the grant id and (cut) the session id. */
export const ProbeId = z.string().regex(/^probe-[0-9a-f]{32}$/);
export type ProbeId = z.infer<typeof ProbeId>;

export const ProbeOutcome = z.enum([
  /** setup (when declared) and test exited 0, and more than zero tests were counted. */
  'passed',
  /** setup or test exited non-zero. */
  'failed',
  /** test exited 0 and counted zero tests. */
  'no_tests',
  /** test exited 0 but no count could be read (no JUnit report, no runner summary): unknown, not a pass. */
  'tests_uncounted',
  /** the session did not run to its own end (time, memory, output cap, killed) or a canary quarantined it. */
  'void',
  /** DEC-18: the repo is not on the owner allow-list (`sandbox.exec_allowed_repos`): nothing ran. */
  'not_allowed',
  /** B1: an open secret finding blocks K-exec: nothing ran. */
  'b1_blocked',
  /** the census found no `test` command (RS-BT-1): nothing ran. */
  'no_test_command',
  /** `onboarding.sandbox_image` is not set or does not read: nothing ran. */
  'no_image',
  /** the sandbox, the controller or a read failed: nothing ran (or nothing that counts). */
  'unavailable',
]);
export type ProbeOutcome = z.infer<typeof ProbeOutcome>;

/** Outcomes where nothing ran in a sandbox. */
export const PROBE_NOT_RUN: readonly ProbeOutcome[] = [
  'not_allowed',
  'b1_blocked',
  'no_test_command',
  'no_image',
  'unavailable',
];

/** An argv of the probe: the census's invocation split on spaces. Plain tokens only. */
export const ProbeArgv = z
  .array(z.string().regex(/^[A-Za-z0-9_.:@=/+,-]{1,200}$/))
  .min(1)
  .max(16);
export type ProbeArgv = z.infer<typeof ProbeArgv>;

/** At most this many characters of a step's log tail are kept in the record (secret-scanned; dropped on a hit). */
export const PROBE_LOG_TAIL_CHARS = 2000;

export const ProbeStep = z.strictObject({
  /** The argv run, or `null` when the census declared none (setup may be absent; test may not). */
  argv: ProbeArgv.nullable(),
  /** As the wrapper in the image reports it: the sandbox's word, untrusted. `null`: did not run. */
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().min(0).nullable(),
  /** sha256 of the full log as it came out (`/out`), or `null`. */
  log_sha256: Sha256Hex.nullable(),
  /** The end of the log; `null` when there was none or the secret ruleset hit it. */
  log_tail: z.string().max(PROBE_LOG_TAIL_CHARS).nullable(),
});
export type ProbeStep = z.infer<typeof ProbeStep>;

export const ProbeTestCount = z.strictObject({
  /** Total tests run; `null` when no count could be read. */
  total: z.number().int().min(0).nullable(),
  passed: z.number().int().min(0).nullable(),
  failed: z.number().int().min(0).nullable(),
  skipped: z.number().int().min(0).nullable(),
  /** `junit`: a JUnit XML report the wrapper asked for; `summary`: a known runner's summary line. */
  source: z.enum(['junit', 'summary']).nullable(),
});
export type ProbeTestCount = z.infer<typeof ProbeTestCount>;

/** What a repo's dependencies need from the mirror (LF8, RS-EN-1): declared from the census's lockfile facts. */
export const ProbeEgressNeed = z.strictObject({
  ecosystem: z.string().min(1).max(32),
  manifest: z.string().min(1).max(512),
  lockfile: z.string().min(1).max(512).nullable(),
});
/** The ecosystems the package mirror serves (npm tarballs and Python wheels). Others cannot be installed. */
export const MIRROR_ECOSYSTEMS = ['npm', 'python'] as const;

export const ProbeGrantedPayload = z.strictObject({
  probe_id: ProbeId,
  s0_id: S0RecordId,
  project_id: z.string().min(1),
  repo: RepoFullName,
  census_hash: Sha256Hex,
  baseline_sha: GitSha,
  image: SandboxImageRef,
  granted_at: z.string().datetime(),
});
export type ProbeGrantedPayload = z.infer<typeof ProbeGrantedPayload>;

export const ProbeResult = z.strictObject({
  probe_id: ProbeId,
  s0_id: S0RecordId,
  repo: RepoFullName,
  census_hash: Sha256Hex,
  baseline_sha: GitSha,
  /** The image the session ran, by digest, or `null` when none was approved. */
  image: SandboxImageRef.nullable(),
  outcome: ProbeOutcome,
  /** One line of factory text: why (never sandbox text). */
  detail: z.string().max(300).nullable(),
  /** The session as the sandbox reported it; `null` when nothing ran. */
  session: z
    .strictObject({
      status: SandboxRunStatus,
      exit_code: z.number().int().nullable(),
      duration_ms: z.number().min(0),
      /** The peers the session's network had: for K-exec only the mirror. */
      peers: z.array(z.string()),
      quarantined: z.boolean(),
    })
    .nullable(),
  setup: ProbeStep,
  test: ProbeStep,
  tests: ProbeTestCount,
  /** The output scan of `/out` and the logs: rule ids only, never a value. */
  out_scan: z.strictObject({
    clean: z.boolean(),
    canary: z.boolean(),
    rule_ids: z.array(z.string()),
  }),
  egress: z.strictObject({
    declared: z.array(ProbeEgressNeed).max(200),
    /** Needs the mirror does not serve (an ecosystem outside `MIRROR_ECOSYSTEMS`). */
    unserved: z.array(z.string()).max(200),
  }),
  recorded_at: z.string().datetime(),
});
export type ProbeResult = z.infer<typeof ProbeResult>;

export const ProbeRecordedPayload = z.strictObject({
  project_id: z.string().min(1),
  result: ProbeResult,
  /** `hashCanonical(result)`: what card 2's approval binds. */
  result_hash: Sha256Hex,
});
export type ProbeRecordedPayload = z.infer<typeof ProbeRecordedPayload>;

// ---------------------------------------------------------------- The Light floors

export const LightFloorId = z.enum(['LF1', 'LF2', 'LF3', 'LF4', 'LF5', 'LF6', 'LF7', 'LF8']);
export type LightFloorId = z.infer<typeof LightFloorId>;
/** Unknown is unmet for every decision (fail closed); it is kept apart only to say why. */
export const LightFloorState = z.enum(['met', 'unmet', 'unknown']);
export type LightFloorState = z.infer<typeof LightFloorState>;

export const LightFloorReport = z.strictObject({
  floors: z.array(
    z.strictObject({
      floor: LightFloorId,
      state: LightFloorState,
      reasons: z.array(z.string().min(1).max(200)).max(20),
    }),
  ),
  /** Every floor met (Light can be signed). */
  met: z.boolean(),
});
export type LightFloorReport = z.infer<typeof LightFloorReport>;
