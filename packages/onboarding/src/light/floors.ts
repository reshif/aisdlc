import {
  LF6_MIN_AFFIRMED_OR_UNKNOWN,
  LightFloorId,
  type LightFloorReport,
  type LightFloorState,
  type ProbeResult,
} from '@aisdlc/contracts';

// The Light floors LF1 to LF8 (OB §3.2: "the only gating list" of Light, per area; they unlock L1 to L3). Pure: the
// caller reads each input from the record, knowledge and the code host, and passes `null` for what it could not read
// or what is not there yet. Unknown is unmet for every decision; it is kept apart from unmet only to say why.
//
//   LF1  no open BLOCKING security finding (B1, B2, B5), the scan complete       D+H
//   LF2  protect-main effective (card 4's rules read) and the bypass list attested  D+H
//   LF3  the probe: setup + test from a clean checkout, hermetic, one run; test count > 0 and the gating set passes  D
//   LF4  the harness and auto-run config inventoried, AND the live planted-instruction isolation test passed  D
//   LF5  the instruction text affirmed (card 2, D37 step-up, lint-clean)         D+H
//   LF6  >= 90% of the claims affirmed or unknown; intent and practices attested A+H
//   LF7  operations.md attested and apply-on-merge known                         A+H
//   LF8  egress needs declared (a mirror allow-list request), all servable       A+D

export interface LightFloorInputs {
  /** Open blocking findings (B1, B2, B5) for the repo; `null`: knowledge could not say. */
  readonly blocking_findings: number | null;
  /** The census's secret scan is complete (or its gap accepted). */
  readonly scan_complete: boolean | null;
  /** Card 4's controls report: blocking items still open (`null`: not read yet). */
  readonly controls_blocking_open: number | null;
  /** Card 4 approved with the bypass attestation. */
  readonly controls_attested: boolean | null;
  /** The census head card 2 is about, and the latest probe recorded for this S0 record. */
  readonly head: { readonly census_hash: string; readonly baseline_sha: string };
  readonly probe: ProbeResult | null;
  /** The census inventoried the instruction and harness files. */
  readonly harness_inventoried: boolean | null;
  /** The live planted-instruction isolation test (SP-STD-1) passed for the worker image in use. */
  readonly isolation_test_passed: boolean | null;
  /** Why the isolation test is unknown (no worker image named, none recorded for it): `isolation_test_not_run` by default. */
  readonly isolation_unknown_reason?: string;
  /** Card 2 approved: its instruction affirmations (AGENTS.md at least) under the step-up. */
  readonly instructions_affirmed: boolean | null;
  /** Card 2 approved: the share of claims affirmed or unknown (0..1), and the intent and practices attested. */
  readonly claims_share: number | null;
  readonly intent_attested: boolean | null;
  readonly practices_attested: boolean | null;
  readonly operations_attested: boolean | null;
  readonly apply_on_merge_known: boolean | null;
}

type Floor = { state: LightFloorState; reasons: string[] };
const met = (): Floor => ({ state: 'met', reasons: [] });
const unmet = (...reasons: string[]): Floor => ({ state: 'unmet', reasons });
const unknown = (...reasons: string[]): Floor => ({ state: 'unknown', reasons });

/** LF3 alone: what card 2's exit needs (OB §6.2 row 0.2: "probe passes (no waiver)"). */
export function lf3Of(
  probe: ProbeResult | null,
  head: { readonly census_hash: string; readonly baseline_sha: string },
): Floor {
  if (probe === null) return unknown('probe_not_run');
  if (probe.census_hash !== head.census_hash || probe.baseline_sha !== head.baseline_sha) {
    return unknown('probe_of_another_head');
  }
  switch (probe.outcome) {
    case 'passed':
      if (!probe.out_scan.clean) return unmet('probe_output_held_a_secret');
      if ((probe.tests.total ?? 0) <= 0) return unmet('no_tests');
      return met();
    case 'failed':
      return unmet('probe_failed');
    case 'no_tests':
      return unmet('no_tests');
    case 'no_test_command':
      return unmet('no_test_command');
    case 'not_allowed':
      return unknown('exec_not_allowed');
    case 'b1_blocked':
      return unknown('b1_blocked');
    case 'tests_uncounted':
      return unknown('tests_uncounted');
    case 'void':
      return unknown('probe_void');
    case 'no_image':
      return unknown('no_probe_image');
    case 'unavailable':
      return unknown('sandbox_unavailable');
  }
}

const bool = (v: boolean | null, reason: string): Floor =>
  v === null ? unknown(`${reason}_unknown`) : v ? met() : unmet(reason);

export function evaluateLightFloors(i: LightFloorInputs): LightFloorReport {
  const floors: Record<LightFloorId, Floor> = {
    LF1:
      i.blocking_findings === null
        ? unknown('findings_unknown')
        : i.blocking_findings > 0
          ? unmet('blocking_finding_open')
          : i.scan_complete === null
            ? unknown('scan_unknown')
            : i.scan_complete
              ? met()
              : unmet('scan_incomplete'),
    LF2:
      i.controls_blocking_open === null || i.controls_attested === null
        ? unknown('controls_not_decided')
        : i.controls_blocking_open > 0
          ? unmet('protect_main_not_effective')
          : i.controls_attested
            ? met()
            : unmet('bypass_not_attested'),
    LF3: lf3Of(i.probe, i.head),
    LF4:
      i.harness_inventoried === false
        ? unmet('harness_not_inventoried')
        : i.isolation_test_passed === false
          ? unmet('isolation_test_failed')
          : i.harness_inventoried === null
            ? unknown('harness_inventory_unknown')
            : i.isolation_test_passed === null
              ? unknown(i.isolation_unknown_reason ?? 'isolation_test_not_run')
              : met(),
    LF5: bool(i.instructions_affirmed, 'instructions_not_affirmed'),
    LF6:
      i.claims_share === null
        ? unknown('claims_not_decided')
        : i.claims_share < LF6_MIN_AFFIRMED_OR_UNKNOWN
          ? unmet('claims_below_floor')
          : i.intent_attested !== true
            ? i.intent_attested === null
              ? unknown('intent_unknown')
              : unmet('intent_not_attested')
            : i.practices_attested !== true
              ? i.practices_attested === null
                ? unknown('practices_unknown')
                : unmet('practices_not_attested')
              : met(),
    LF7:
      i.operations_attested === null || i.apply_on_merge_known === null
        ? unknown('operations_unknown')
        : !i.operations_attested
          ? unmet('operations_not_attested')
          : !i.apply_on_merge_known
            ? unmet('apply_on_merge_unknown')
            : met(),
    LF8:
      i.probe === null
        ? unknown('egress_not_declared')
        : i.probe.egress.unserved.length > 0
          ? unmet(...i.probe.egress.unserved.slice(0, 19).map((e) => `mirror_does_not_serve:${e}`))
          : met(),
  };
  const list = LightFloorId.options.map((floor) => ({ floor, ...floors[floor] }));
  return { floors: list, met: list.every((f) => f.state === 'met') };
}
