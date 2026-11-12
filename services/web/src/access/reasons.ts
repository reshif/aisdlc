import {
  ACTION_CATALOGUE,
  NOT_VISIBLE_REASON,
  ROLE_CATALOGUE,
  roleHolds,
  type ActionId,
  type PdpResource,
  type RoleId,
} from '@aisdlc/contracts';

// Words for what the PDP answered. The codes are the PDP's (`@aisdlc/pdp`): an unknown one is shown
// as the code, never guessed at, and anything that is not an allow reads as "no" (fail closed).

const policyCouldNot = 'The policy could not be checked, so the answer is no.';

const KNOWN: Readonly<Record<string, string>> = {
  [NOT_VISIBLE_REASON]: 'You cannot see this project.',
  no_policy_permits: 'None of your roles allows this here.',
  unknown_principal: 'The factory does not know your account.',
  action_not_applicable: 'This action does not apply here.',
  'xcut/disabled_principal_denied': 'Your account is not active.',
  'xcut/service_principal_never_decides': 'A service account never decides.',
  'xcut/fleet_kill_factory_admin_only': 'Only a factory admin may kill the whole fleet.',
};
const FAIL_CLOSED = [
  'no_bundle',
  'bundle_malformed',
  'bundle_hash_mismatch',
  'bundle_invalid',
  'entity_source_error',
  'evaluator_error',
  'decision_log_failed',
  'unavailable',
];

/** One sentence: what the action is and why the answer was no. */
export function reasonText(action: ActionId, reasons: readonly string[]): string {
  const what = ACTION_CATALOGUE[action].description;
  const first = reasons[0] ?? 'no_policy_permits';
  if (first === NOT_VISIBLE_REASON) return KNOWN[first] as string;
  const why =
    KNOWN[first] ??
    (FAIL_CLOSED.some((c) => first === c || first.startsWith(`${c}:`))
      ? policyCouldNot
      : first.startsWith('policy_error:')
        ? policyCouldNot
        : `Refused (${first}).`);
  return `${why} The action: ${what}.`;
}

/** The roles of the catalogue that would allow this action on this resource (for "request access"). */
export function rolesThatGrant(action: ActionId, resource: PdpResource): RoleId[] {
  return ROLE_CATALOGUE.filter((r) => !r.service_only && roleHolds(r, action, resource)).map(
    (r) => r.role_id,
  );
}
