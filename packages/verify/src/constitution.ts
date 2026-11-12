import type { Constitution, VerifyFinding, VerifyKitRun } from '@aisdlc/contracts';
import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import type { CheckContext } from './context.js';
import { finding, isFailing, verdictOf, type ResultParts } from './finding.js';
import { runReview } from './review.js';
import { diffTrees, isSourcePath, textOf, type Tree } from './tree.js';

// The factory constitution (config `factory.constitution`, M1-gated; `Constitution` in contracts) and its ONE rule
// evaluator: 4.5 runs it over the design's structured facts (core's planning), and 7.5 (FL "7.5 Constitution check,
// ALL lanes, D+A") over the facts of the CODE the Unit head changed, in every lane: nothing here reads the lane. A
// violation, by the rules or a high A5 finding, raises E2 with the result bound to it (FL `s75 -. violation .-> E2`).

/** What the design says, in the structured fields the constitution reads (the agent's claims, checked by rules). */
export interface DesignFacts {
  readonly network_calls: ReadonlyArray<{
    host?: unknown;
    purpose?: unknown;
    approval_ref?: unknown;
  }>;
  readonly migrations: ReadonlyArray<{
    name?: unknown;
    reversible?: unknown;
    irreversible_flagged?: unknown;
  }>;
}

export interface ConstitutionFinding {
  readonly rule_id: string;
  readonly severity: 'high';
  readonly location: { readonly path: string };
  readonly message: string;
}

/** One line, bounded: the design's own words end up in a card, and a newline there could start a heading. */
const say = (v: unknown, max = 80): string =>
  (typeof v === 'string' ? v : '?').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The deterministic half of 4.5: each rule of the constitution run over the design's facts. A rule kind this
 * build does not know is a finding too (unknown means unmet). Pure; the order is the constitution's.
 */
export function evaluateConstitution(c: Constitution, d: DesignFacts): ConstitutionFinding[] {
  const out: ConstitutionFinding[] = [];
  for (const rule of c.rules) {
    switch (rule.kind) {
      case 'no_unapproved_egress':
        d.network_calls.forEach((n, i) => {
          const host = say(n.host, 253).toLowerCase();
          const approved = typeof n.approval_ref === 'string' && n.approval_ref.trim() !== '';
          if (!approved && !rule.allow_hosts.includes(host)) {
            out.push({
              rule_id: rule.rule_id,
              severity: 'high',
              location: { path: `network_calls[${i}]` },
              message: `${rule.title}: the design calls ${host || '?'} with no approval reference`,
            });
          }
        });
        break;
      case 'migrations_reversible_or_flagged':
        d.migrations.forEach((m, i) => {
          if (m.reversible !== true && m.irreversible_flagged !== true) {
            out.push({
              rule_id: rule.rule_id,
              severity: 'high',
              location: { path: `migrations[${i}]` },
              message: `${rule.title}: ${say(m.name)} is neither reversible nor flagged irreversible`,
            });
          }
        });
        break;
      default:
        out.push({
          rule_id: (rule as { rule_id?: string }).rule_id ?? 'UNKNOWN',
          severity: 'high',
          location: { path: 'constitution' },
          message: 'a rule of a kind this build cannot check',
        });
    }
  }
  return out;
}

/** A host the code names in a URL literal: `https://host`, `http://host:port`, `wss://host`. */
const URL_HOST = /\b(?:https?|wss?):\/\/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::\d+)?/gi;
const LOCAL =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org|net)|[a-z0-9.-]+\.(invalid|test|example|localhost))$/;
const MIGRATION = /(^|\/)migrations?\/[^/]+\.(sql|js|ts|py|rb)$/i;
const DOWN = /(^|[._-])down([._-]|$)/i;

/**
 * The facts of the CODE the head changed, in the shape the constitution reads (pure):
 *   network_calls  each host a line the head ADDED to an implementation file names in a URL (local and reserved names
 *                  are not egress); approved when the approved design names it (G3d bound it) or the rule allows it
 *   migrations     each migration file the head added: reversible when a matching `down` file is in the head or the
 *                  file has a down section, flagged irreversible when it says `aisdlc: irreversible`
 */
export function codeFactsOf(base: Tree, head: Tree, approvedHosts: readonly string[]): DesignFacts {
  const d = diffTrees(base, head);
  const approved = new Set(approvedHosts.map((h) => h.toLowerCase()));
  const hosts = new Map<string, string>();
  for (const p of [...d.added, ...d.modified].filter(isSourcePath).sort()) {
    const had = new Set((textOf(base.get(p)) ?? '').split('\n'));
    for (const l of (textOf(head.get(p)) ?? '').split('\n')) {
      if (had.has(l)) continue;
      for (const m of l.matchAll(URL_HOST)) {
        const host = (m[1] as string).toLowerCase();
        if (!LOCAL.test(host) && !hosts.has(host)) hosts.set(host, p);
      }
    }
  }
  const migrations = d.added
    .filter((p) => MIGRATION.test(p) && !DOWN.test(p.split('/').pop() ?? ''))
    .sort()
    .map((p) => {
      const text = textOf(head.get(p)) ?? '';
      const stem = p.replace(/\.[^.]+$/, '');
      const hasDown =
        [...head.keys()].some(
          (q) => q !== p && q.startsWith(stem) && DOWN.test(q.slice(stem.length)),
        ) ||
        /^\s*(--|#|\/\/)\s*(migrate:)?\s*down\b/im.test(text) ||
        /\bexports\.down\b|\bexport\s+(async\s+)?function\s+down\b|\bdef\s+downgrade\b/.test(text);
      return {
        name: p,
        reversible: hasDown,
        irreversible_flagged: /aisdlc:\s*irreversible/i.test(text),
      };
    });
  return {
    network_calls: [...hosts.entries()].map(([host, path]) => ({
      host,
      purpose: path,
      ...(approved.has(host) ? { approval_ref: 'G3d' } : {}),
    })),
    migrations,
  };
}

/** The constitution's findings over the code (pure): one per rule violation, each high. */
export function constitutionFindings(
  constitution: Constitution,
  facts: DesignFacts,
): VerifyFinding[] {
  return evaluateConstitution(constitution, facts).map((f) => {
    const i = Number(/\[(\d+)\]/.exec(f.location.path)?.[1] ?? -1);
    const subject = f.location.path.startsWith('network_calls')
      ? facts.network_calls[i]
      : facts.migrations[i];
    const path =
      typeof (subject as { purpose?: unknown } | undefined)?.purpose === 'string'
        ? (subject as { purpose: string }).purpose
        : typeof (subject as { name?: unknown } | undefined)?.name === 'string'
          ? (subject as { name: string }).name
          : null;
    return finding('constitution_violation', 'high', {
      rule_id: f.rule_id,
      path,
      message: f.message,
      key: `${f.location.path}:${f.message}`,
    });
  });
}

export async function checkConstitution(c: CheckContext): Promise<ResultParts> {
  const { req, base, head } = c;
  const facts = codeFactsOf(base, head, req.approved_hosts);
  const findings: VerifyFinding[] = constitutionFindings(req.constitution, facts);
  const kits: VerifyKitRun[] = [
    {
      kit: 'constitution-rules',
      class: null,
      session_id: null,
      status: 'answered',
      exit_code: null,
      detail: null,
    },
  ];
  const rules = canonicalJson(req.constitution as never);
  const review = await runReview(
    c,
    'constitution',
    'the factory constitution (quoted as data above)',
    [{ type: 'constitution', sha256: sha256Hex(rules), text: rules }],
  );
  kits.push(review.kit);
  findings.push(...review.findings);
  const violation = findings.some(
    (f) =>
      (f.kind === 'constitution_violation' || f.kind === 'constitution_review') && isFailing(f),
  );
  // E2 decides a violation; approved E2 at this step (a re-run) means a person accepted it
  const raise = violation && !req.approved_gates.includes('E2');
  return {
    findings,
    kits,
    raised: raise ? { kind: 'gate', gate: 'E2', reason_code: 'constitution_violation' } : null,
    verdict: verdictOf(
      findings,
      kits,
      raise || req.approved_gates.includes('E2')
        ? ['constitution_violation', 'constitution_review']
        : [],
    ),
  };
}
