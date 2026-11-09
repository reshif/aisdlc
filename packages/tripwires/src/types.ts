// The tripwires (PLAN M13.4, M13.5; FL 6.5, X1, X3, B8, Q1): what a session did that the factory must act on.
//
//   quarantine   ET10, misbehaviour: stop at once, session tainted, Q1 then SECT
//   gate_x1      an irreversible operation: stop, X1 decides (approved: resume; denied: D1)
//   gate_x3      a new dependency: stop, X3 decides (approved: the mirror pins it; denied: find another way, 1x, else D1)
//   gate_e6      a locked test must change (the coder's own request): E6, then G3o
//   relane_r1    the work outgrew its lane (diff over budget, a sensitive path): R1, free and logged
//   scope        the diff left the Unit's scope: B8 (split the Unit), the second time D1 (ET9)

export type TripwireClass =
  'quarantine' | 'gate_x1' | 'gate_x3' | 'gate_e6' | 'relane_r1' | 'scope';

export type TripwireKind =
  | 'locked_test_edit'
  | 'protected_path_write'
  | 'secret_access'
  | 'credential_hunting'
  | 'stub_test'
  | 'irreversible_operation'
  | 'new_dependency'
  | 'locked_test_change_request'
  | 'diff_over_lane_budget'
  | 'sensitive_path'
  | 'scope_drift';

export interface Tripwire {
  readonly kind: TripwireKind;
  readonly class: TripwireClass;
  /** One line for a person. Never a secret's value, never repo text beyond a path or a short rule name. */
  readonly detail: string;
  readonly path?: string;
}

/** The kinds that are misbehaviour (ET10): they are never a request, whatever the agent says about them. */
export const QUARANTINE_KINDS: readonly TripwireKind[] = [
  'locked_test_edit',
  'protected_path_write',
  'secret_access',
  'credential_hunting',
  'stub_test',
];

/** The order a set of tripwires is acted on: misbehaviour first, then what needs a person, then what only moves the item. */
export const TRIPWIRE_ORDER: readonly TripwireClass[] = [
  'quarantine',
  'gate_x1',
  'gate_x3',
  'gate_e6',
  'relane_r1',
  'scope',
];

export const heaviest = (ts: readonly Tripwire[]): Tripwire | null =>
  [...ts].sort((a, b) => TRIPWIRE_ORDER.indexOf(a.class) - TRIPWIRE_ORDER.indexOf(b.class))[0] ??
  null;
