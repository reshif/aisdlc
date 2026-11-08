import { type InjectionFlag, type LintRuleId } from '@aisdlc/contracts';
import { lintText } from '@aisdlc/text-lint';

// The untrusted-input boundary's scan (FL FIX 15, B27). It is NOT a second ruleset: it runs the one
// content lint of `@aisdlc/text-lint` (the OB §3.4 "must not contain" rules the knowledge census
// also uses) over a request's text and keeps the rules that mean "this text is trying to instruct
// the factory": a statement of tier, autonomy, lane, gate or budget (L-TIER, L-AUTONOMY, L-LANE,
// L-GATE, L-BUDGET), a tool, permission, MCP or egress grant (L-GRANT), text addressed to the factory
// or the AI (L-ADDRESS), "ignore previous instructions" and its kin (L-DIRECTIVE), and a download
// piped into a shell (L-PIPE-SH). Links (L-URL) and long prose are ordinary in a request and are not
// flags. A hit never changes anything: it fences the text and flags the G0 card.

/** The lint rules that make a request text "injection-like". */
export const INJECTION_RULES: readonly LintRuleId[] = [
  'L-TIER',
  'L-AUTONOMY',
  'L-LANE',
  'L-GATE',
  'L-BUDGET',
  'L-GRANT',
  'L-ADDRESS',
  'L-DIRECTIVE',
  'L-PIPE-SH',
];

export interface InjectionScan {
  readonly flags: InjectionFlag[];
  /** The shared secret ruleset hit: the text is refused, not flagged. */
  readonly holds_secret: boolean;
}

export function scanForInjection(text: string): InjectionScan {
  const findings = lintText(text);
  const flags: InjectionFlag[] = [];
  let secret = false;
  for (const f of findings) {
    if (f.rule === 'L-SECRET') secret = true;
    else if (INJECTION_RULES.includes(f.rule)) flags.push({ rule: f.rule, line: f.line });
  }
  return { flags, holds_secret: secret };
}
