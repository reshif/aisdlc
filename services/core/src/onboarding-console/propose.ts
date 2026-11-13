import {
  ConsoleActTool,
  ConsoleProposalKind,
  ProposalValues,
  isRoleSlotTarget,
  type ConsoleProposal,
  type Tier,
} from '@aisdlc/contracts';
import { argvOf } from '@aisdlc/onboarding';
import { scanText } from '@aisdlc/secrets-rules';
import { lintText } from '@aisdlc/text-lint';
import { definesTestTarget } from '../onboarding-v2/agent.js';
import { FIX_FILE_PATHS } from './fixes.js';

// What the onboarder may PROPOSE (docs/design/onboarding-console.md, P4): a thing for the person to accept, edit or
// reject. A proposal is checked here against its kind and against the session (the census floor, the gaps and what
// each allows) and the secret ruleset, before anything is recorded. Nothing a proposal says is executed: accepting one
// writes the person's choice into the summary draft (or, for a test command, the attested command the probe reads).

const TIER_RANK: Readonly<Record<Tier, number>> = { T0: 0, T1: 1, T2: 2 };
const TARGET = /^[A-Za-z0-9_.:-]{1,128}$/;
const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const REFUSING_LINT = new Set(['L-SECRET', 'L-URL', 'L-PIPE-SH']);

/** What the session knows that a proposal is checked against. */
export interface ProposalContext {
  /** The census's tier floor (a proposed tier is never below it); `null`: no census yet. */
  readonly floor: Tier | null;
  /** The census gaps by id, with the dispositions each allows. */
  readonly gaps: ReadonlyMap<string, readonly string[]>;
}

export interface ProposalInput {
  readonly kind: unknown;
  readonly target: unknown;
  readonly title: unknown;
  readonly why: unknown;
  readonly value: unknown;
}

export type Validated =
  | { readonly ok: true; readonly proposal: Omit<ConsoleProposal, 'proposal_id'> }
  | { readonly ok: false; readonly reason: string };

const no = (reason: string): Validated => ({ ok: false, reason });

/** Checks a value of `kind` for `target`; the same rules for the agent's proposal and the person's edit. */
export function checkValue(
  ctx: ProposalContext,
  kind: ConsoleProposalKind,
  target: string,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  const parsed = ProposalValues[kind].safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `the value does not fit a ${kind} proposal: ${parsed.error.issues[0]?.message ?? 'invalid'}`,
    };
  }
  const v = parsed.data as Record<string, unknown>;
  const refuse = (reason: string) => ({ ok: false as const, reason });
  switch (kind) {
    case 'tier':
      if (target !== 'tier') return refuse('a tier proposal targets `tier`');
      if (ctx.floor !== null && TIER_RANK[v['tier'] as Tier] < TIER_RANK[ctx.floor]) {
        return refuse(`the risk only goes up: the census floor is ${ctx.floor}`);
      }
      break;
    case 'gap_disposition': {
      const allowed = ctx.gaps.get(target);
      if (!allowed) return refuse('that gap is not one the census found');
      if (!allowed.includes(v['disposition'] as string)) {
        return refuse(`this gap allows only: ${allowed.join(', ')}`);
      }
      break;
    }
    case 'role_map':
      if (!isRoleSlotTarget(target)) return refuse('that is not a role map slot');
      break;
    case 'settings':
      if (target !== 'two_person') return refuse('a settings proposal targets `two_person`');
      break;
    case 'instruction_text':
      if (!INSTRUCTION_FILES.includes(target)) return refuse('only AGENTS.md or CLAUDE.md');
      if (lintText(String(v['text'])).some((f) => REFUSING_LINT.has(f.rule))) {
        return refuse(
          'the text carries something the factory refuses (a secret, a link, a piped download)',
        );
      }
      break;
    case 'fix_file': {
      const path = String(v['path']);
      if (!FIX_FILE_PATHS.includes(path)) return refuse(`the factory writes no file at ${path}`);
      if (
        (path === 'Makefile' || path === 'justfile') &&
        !definesTestTarget(path, String(v['content']))
      ) {
        return refuse(`${path} must define a \`test\` target the detector reads`);
      }
      break;
    }
    case 'test_command':
      if (target !== 'test') return refuse('a test command proposal targets `test`');
      if (argvOf(String(v['command'])) === null) {
        return refuse('the test command must be plain words (no shell syntax)');
      }
      if (typeof v['setup'] === 'string' && argvOf(v['setup']) === null) {
        return refuse('the setup command must be plain words (no shell syntax)');
      }
      break;
    case 'act':
      if (!ConsoleActTool.safeParse(target).success || v['act'] !== target) {
        return refuse('an act proposal names the act it targets');
      }
      break;
    case 'claim':
    case 'manual_step':
      break;
  }
  if (scanText(JSON.stringify(parsed.data)).length > 0) {
    return refuse('the value holds something that looks like a secret');
  }
  return { ok: true, value: parsed.data };
}

/** The model's proposal, checked. `reason` is what it is told when refused. */
export function validateProposal(ctx: ProposalContext, i: ProposalInput): Validated {
  const kind = ConsoleProposalKind.safeParse(i.kind);
  if (!kind.success) return no(`kind must be one of: ${ConsoleProposalKind.options.join(', ')}`);
  if (typeof i.target !== 'string' || !TARGET.test(i.target))
    return no('target must be a short id');
  if (typeof i.title !== 'string' || i.title.trim() === '' || i.title.length > 200) {
    return no('title must be 1 to 200 characters');
  }
  if (typeof i.why !== 'string' || i.why.trim() === '' || i.why.length > 1000) {
    return no('why must be 1 to 1000 characters');
  }
  const v = checkValue(ctx, kind.data, i.target, i.value);
  if (!v.ok) return no(v.reason);
  if (scanText(`${i.title}\n${i.why}`).length > 0)
    return no('the text holds something that looks like a secret');
  return {
    ok: true,
    proposal: {
      kind: kind.data,
      target: i.target,
      title: i.title.trim(),
      why: i.why.trim(),
      value: v.value,
    },
  };
}
