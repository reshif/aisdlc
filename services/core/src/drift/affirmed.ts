import type { AffirmedInstruction } from '@aisdlc/agents';
import { sha256Hex } from '@aisdlc/kernel';
import type { Executor } from '@aisdlc/record';
import type pg from 'pg';
import { affirmedOf } from '../cards/pack.js';
import { loadS0, s0Cards } from '../cards/read.js';
import { inputsOf, loadDrift } from './state.js';

// The affirmed instruction text an agent receives (PLAN M16 part 3; OB §4.1 items 6 and 7, §4.2; DEC-11(a)): level 3
// of the context, fenced GUIDANCE with its provenance header. It is read from the RECORD only, for the version that
// governs the repo now, never from the repo: the git copy is a projection and is never re-read as authority.
//
//   - a path a person re-affirmed after drift (`drift.reaffirmed`, the newest for the version): that text, from the
//     record, its reference the re-affirmation's ledger entry;
//   - otherwise the text card 2 affirmed (the proposal's or an edit's, by the hash the readiness record holds), its
//     reference the record's hash and the path.
//
// Each text must hash to the sha256 the record binds it to; one that does not (or is not on the record) is left out,
// so an agent is never handed text nobody affirmed. While a file has drifted the last affirmed text keeps being
// served: the repo's new text is not here at all (it is data, through knowledge, like every other repo file).

/** The current affirmed instruction texts of a repo, by path; empty when no record governs it. */
export async function affirmedInstructionsOf(
  db: Executor,
  repo: string,
): Promise<AffirmedInstruction[]> {
  const l = await loadDrift(db, repo);
  const g = l?.governing;
  const inputs = l ? inputsOf(l) : null;
  if (!l || !g || !inputs) return [];
  const areaOf = new Map(g.prr.affirmed.instructions.map((i) => [i.path, i.area]));
  // the newest re-affirmation of each path of this version, with its ledger entry
  const reaffirmed = new Map<string, { text: string; text_sha256: string; ref: string }>();
  for (const r of l.drift.reaffirmations) {
    if (r.prr_version !== g.version) continue;
    reaffirmed.set(r.path, { text: r.text, text_sha256: r.text_sha256, ref: r.ledger_entry_id });
  }
  // card 2's texts, read back from the S0 record only when some path still needs one
  let card2: Map<string, string> | null = null;
  const card2Text = async (path: string): Promise<string | null> => {
    if (card2 === null) {
      card2 = new Map();
      const s0 = await loadS0(db as pg.Pool, g.s0_id);
      if (s0) {
        const a = affirmedOf(s0, await s0Cards(db as pg.Pool, g.s0_id));
        for (const i of a.ok ? (a.value?.instructions ?? []) : []) card2.set(i.path, i.text);
      }
    }
    return card2.get(path) ?? null;
  };
  const out: AffirmedInstruction[] = [];
  for (const t of inputs.tracked) {
    if (t.kind !== 'instruction_text') continue;
    const re = reaffirmed.get(t.path);
    const text = re ? re.text : await card2Text(t.path);
    // hash-bound: only the bytes the record says were affirmed
    if (text === null || sha256Hex(text) !== t.expected_sha256) continue;
    out.push({
      repo: l.repo_ref,
      area: areaOf.get(t.path) ?? '.',
      path: t.path,
      text,
      text_sha256: t.expected_sha256,
      affirmation_ref: re ? `ledger:${re.ref}` : `prr:${g.prr.record_hash}#${t.path}`,
      subject: `instructions:${t.path}`,
    });
  }
  return out;
}
