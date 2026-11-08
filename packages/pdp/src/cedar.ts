import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { PolicyBundle } from '@aisdlc/contracts';

// The one place that touches the Cedar WebAssembly build (PLAN §2 Policy, AR2: embedded in-process).
//
// `@cedar-policy/cedar-wasm/nodejs` is a CommonJS module that reads its `.wasm` next to itself with
// `__dirname`. That works from node_modules (Node 22 ESM and Vitest). In an esbuild bundle there
// is no node_modules and no `__dirname`, so `scripts/bundle.mjs` rewrites exactly those two lines to
// load `cedar_wasm_bg.wasm` from next to the bundle and copies the asset into `dist/`; the build
// fails if the lines it expects are not there (a Cedar upgrade must be looked at, not guessed).

export interface CedarUid {
  readonly type: string;
  readonly id: string;
}

export interface CedarEntity {
  readonly uid: CedarUid;
  readonly attrs: Record<string, string | number | boolean>;
  readonly parents: readonly CedarUid[];
}

export interface CedarRequest {
  readonly principal: CedarUid;
  readonly action: string;
  readonly resource: CedarUid;
  readonly entities: readonly CedarEntity[];
}

export interface CedarVerdict {
  readonly decision: 'allow' | 'deny';
  /** The ids of the policies that determined it: permits for an allow, forbids for a deny. */
  readonly reasons: readonly string[];
  /** Policies that failed to evaluate. Any of them makes the PDP deny. */
  readonly errors: readonly string[];
}

export const cedarVersion = (): string => cedar.getCedarVersion();

const messages = (es: ReadonlyArray<{ message: string }>): string =>
  es.map((e) => e.message).join('; ');

/** Problems with a bundle's schema and policies as Cedar sees them (empty: valid, strict mode). */
export function validateBundleText(b: Pick<PolicyBundle, 'schema' | 'policies'>): string[] {
  try {
    const s = cedar.checkParseSchema(b.schema);
    if (s.type !== 'success') return [`schema: ${messages(s.errors)}`];
    const v = cedar.validate({
      schema: b.schema,
      policies: { staticPolicies: b.policies },
      validationSettings: { mode: 'strict' },
    });
    if (v.type === 'failure') return [messages(v.errors)];
    // An impossible or inapplicable policy is a warning to Cedar; to us it is a bug, so it counts.
    return [...v.validationErrors, ...v.validationWarnings].map(
      (e) => `${e.policyId}: ${e.error.message}`,
    );
  } catch (e) {
    return [`cedar: ${e instanceof Error ? e.message : String(e)}`];
  }
}

/** One authorization request against a bundle's policies. Never throws: a failure is an `Err`. */
export function evaluate(
  b: Pick<PolicyBundle, 'policies'>,
  r: CedarRequest,
): Result<CedarVerdict, string> {
  try {
    const a = cedar.isAuthorized({
      principal: r.principal,
      action: { type: 'Action', id: r.action },
      resource: r.resource,
      context: {},
      policies: { staticPolicies: b.policies },
      entities: r.entities.map((e) => ({ uid: e.uid, attrs: e.attrs, parents: [...e.parents] })),
    });
    if (a.type !== 'success') return err(messages(a.errors));
    return ok({
      decision: a.response.decision === 'allow' ? 'allow' : 'deny',
      reasons: [...a.response.diagnostics.reason].sort(),
      errors: a.response.diagnostics.errors.map((e) => `${e.policyId}: ${e.error.message}`),
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
