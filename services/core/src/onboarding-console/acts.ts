import { hashCanonical } from '@aisdlc/kernel';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { ConsoleActTool } from '@aisdlc/contracts';
import type { PackDeps } from '../cards/pack.js';
import type { CardDeps } from '../cards/model.js';
import { recheckControls } from '../cards/api.js';
import { runOnboardingProbe, type ProbeRunDeps } from '../cards/probe.js';
import { loadS0, s0Cards } from '../cards/read.js';
import { syncCards } from '../cards/sync.js';
import { coreError, type CoreError } from '../errors.js';
import { clockOf } from '../journal.js';
import {
  latestProposal,
  projectFixes,
  type OnboardingAgentOutput,
} from '../onboarding-v2/agent.js';
import { mergeConsoleFixes } from './fixes.js';
import { acceptedFixFilesOf } from './store.js';

// The onboarder's ACTS (docs/design/onboarding-console.md, P4). Each is something the factory already does under its
// own record; none decides a gate:
//   recheck_controls  reads the code host again (card 4's re-check, as the person the session acts for)
//   run_probe         the tests probe: DEC-18 and B1 are checked inside it, exactly as for the loop
//   render_fix_pack   records the accepted fix files as ONE pack and opens its X2; the Push Broker is asked only once X2
//                     is approved in the ledger, and the factory never merges
//   sync_cards        opens and applies the cards the record waits for
// `rerun_census` is not offered: a new census starts a new onboarding record, which is a person's re-onboard.
// Every act answers with a short plain sentence (data for the model); a refusal is a result, never an exception.

export type ActResult = Result<string, CoreError>;

/** What a deployment can do. An act with no implementation is "not available here". */
export interface ConsoleActsPort {
  recheck_controls?(s0Id: string, by: string): Promise<ActResult>;
  run_probe?(s0Id: string, by: string): Promise<ActResult>;
  render_fix_pack?(s0Id: string, by: string): Promise<ActResult>;
  sync_cards?(s0Id: string, by: string): Promise<ActResult>;
}

export const OFFERED_ACTS: readonly ConsoleActTool[] = [
  'recheck_controls',
  'run_probe',
  'render_fix_pack',
  'sync_cards',
];

export function consoleActsFrom(o: {
  readonly cards: CardDeps;
  /** The probe's deps (sandbox, image, allow-list); absent: `run_probe` is not available in this process. */
  readonly probe?: ProbeRunDeps;
  /** The pack path (record, X2, Push Broker); absent: `render_fix_pack` is not available in this process. */
  readonly pack?: PackDeps;
}): ConsoleActsPort {
  const { cards } = o;
  return {
    async recheck_controls(s0Id, by) {
      const all = await s0Cards(cards.pool, s0Id);
      const c4 = [...all]
        .filter((c) => c.kind === 'C4' && c.state.status === 'open')
        .sort((a, b) => b.occurrence - a.occurrence)[0];
      if (!c4)
        return err(coreError('conflict', 'the controls card is not open: nothing to re-check now'));
      const r = await recheckControls(cards, { card_id: c4.card_id, principal: by as never });
      return r.ok ? ok('The GitHub controls were read again and recorded.') : r;
    },

    ...(o.probe
      ? {
          async run_probe(s0Id: string) {
            const probe = o.probe as ProbeRunDeps;
            const r = await runOnboardingProbe(probe, s0Id, { retry: true });
            if (!r.ok) return r;
            const x = r.value.result;
            return ok(`The tests probe ended: ${x.outcome}${x.detail ? ` (${x.detail})` : ''}.`);
          },
        }
      : {}),

    ...(o.pack
      ? {
          async render_fix_pack(s0Id: string) {
            const pack = o.pack as PackDeps;
            const loaded = await loadS0(cards.pool, s0Id);
            if (!loaded?.s0.census) return err(coreError('conflict', 'the census is not in yet'));
            const c1 = [...(await s0Cards(cards.pool, s0Id))]
              .filter((c) => c.kind === 'C1')
              .sort((a, b) => b.occurrence - a.occurrence)[0];
            if (!c1) return err(coreError('conflict', 'card 1 is not open yet'));
            const latest = await cards.knowledge.census(loaded.s0.repo);
            if (
              !latest.ok ||
              latest.value === null ||
              latest.value.census_hash !== loaded.s0.census.census_hash
            ) {
              return err(coreError('conflict', 'the census moved on since this record was raised'));
            }
            const base = await latestProposal(cards.pool, s0Id, loaded.s0.census.census_hash);
            const accepted = await acceptedFixFilesOf(cards.pool, s0Id);
            const merged: OnboardingAgentOutput | null = mergeConsoleFixes(
              base?.output ?? null,
              accepted,
            );
            if (merged === null) return ok('There is nothing to put in a fix PR yet.');
            const row = {
              s0_id: s0Id,
              output_hash: hashCanonical(merged),
              census_hash: loaded.s0.census.census_hash,
              base_sha: latest.value.census.baseline_sha,
              model: 'console',
              output: merged,
              dropped: [],
              proposed_at: clockOf(cards).now().toISOString(),
            };
            // the agent port is not used by the pack path
            const v = await projectFixes(
              { cards, agent: undefined as never, pack },
              loaded,
              c1.card_id,
              row,
            );
            if (!v.ok) return v;
            return ok(
              v.value === 'nothing_to_open'
                ? 'None of the accepted files can be written (each is a path the factory may write that the repo does not already have).'
                : `The fix pack is recorded (state: ${v.value}). It needs its own approval before it is pushed as a draft PR; a person merges it.`,
            );
          },
        }
      : {}),

    async sync_cards(s0Id) {
      const r = await syncCards(cards, s0Id);
      if (!r.ok) return r;
      return ok(
        `Cards synced: ${r.value.opened.length} opened, ${r.value.applied.length} applied, ${r.value.pending.length} pending.`,
      );
    },
  };
}
