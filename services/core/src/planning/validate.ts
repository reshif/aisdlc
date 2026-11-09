import { validateOutput } from '@aisdlc/agents';

// Step 3.3, the deterministic validator (PLAN M12.2; FL `s33 "Validate" D`, B3 "validator/critic fail: 3
// auto, then ET8"). Code, never an agent. Pure: the same delta and affected list give the same findings.
//
//   schema               the delta is a valid `spec_delta` output (every field, no extras)
//   missing_id / bad_id  every requirement has an id, and it is an id (letters, digits, `. _ : -`)
//   duplicate_id         one id, one entry
//   orphan_requirement   a `modified` or `removed` entry names a requirement 3.1 did not locate (it does not exist)
//   id_collision         an `added` entry takes the id of a requirement that already exists
//   dangling_reference   text refers to a requirement (same id style as the known ones) that nothing defines
//
// The oracle check (every oracle spec maps to a requirement of the delta) needs the oracle specs, which 3.4
// writes AFTER this step: `validateOracles` runs on the 3.4 output, before it is stored.

export interface Finding {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly severity: 'high';
}

const ID = /^[A-Za-z][A-Za-z0-9._:-]{0,127}$/;
const finding = (code: string, path: string, message: string): Finding => ({
  code,
  path,
  message,
  severity: 'high',
});

interface DeltaEntry {
  requirement_id?: unknown;
  change?: unknown;
  text?: unknown;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

/** The id prefixes of the known requirements (`REQ` of `REQ-12`): what a reference in text can look like. */
function prefixesOf(ids: readonly string[]): string[] {
  return [
    ...new Set(
      ids.flatMap((id) => {
        const m = /^([A-Za-z][A-Za-z0-9]*)[-_:.]\d+$/.exec(id);
        return m ? [m[1] as string] : [];
      }),
    ),
  ];
}

export function validateSpecDelta(
  delta: unknown,
  affected: { requirements?: ReadonlyArray<{ requirement_id?: unknown }> } | null,
): Finding[] {
  const out: Finding[] = [];
  const schema = validateOutput('A2', delta);
  if (!schema.ok) {
    for (const e of schema.error.errors)
      out.push(finding('schema', e.path, `${e.code}: ${e.message}`));
  }
  const entries = (
    Array.isArray(asRecord(delta)['delta']) ? asRecord(delta)['delta'] : []
  ) as DeltaEntry[];
  if (!schema.ok && entries.length === 0) return out;

  const located = new Set(
    (affected?.requirements ?? []).flatMap((r) =>
      typeof r.requirement_id === 'string' ? [r.requirement_id] : [],
    ),
  );
  const seen = new Set<string>();
  const defined = new Set<string>(located);
  entries.forEach((e, i) => {
    const at = `delta[${i}]`;
    const id = typeof e.requirement_id === 'string' ? e.requirement_id.trim() : '';
    if (id === '') {
      out.push(finding('missing_id', `${at}.requirement_id`, 'a requirement has no id'));
      return;
    }
    if (!ID.test(id)) {
      out.push(
        finding('bad_id', `${at}.requirement_id`, 'a requirement id has characters an id cannot'),
      );
      return;
    }
    if (seen.has(id))
      out.push(finding('duplicate_id', `${at}.requirement_id`, 'a requirement id appears twice'));
    seen.add(id);
    defined.add(id);
    if (affected !== null) {
      if ((e.change === 'modified' || e.change === 'removed') && !located.has(id)) {
        out.push(
          finding(
            'orphan_requirement',
            `${at}.requirement_id`,
            `a ${String(e.change)} requirement was not located by 3.1: it has nothing to change`,
          ),
        );
      }
      if (e.change === 'added' && located.has(id)) {
        out.push(
          finding(
            'id_collision',
            `${at}.requirement_id`,
            'an added requirement takes an existing id',
          ),
        );
      }
    }
  });

  const prefixes = prefixesOf([...defined]);
  if (prefixes.length > 0) {
    const ref = new RegExp(`\\b(?:${prefixes.join('|')})[-_:.]\\d+\\b`, 'g');
    entries.forEach((e, i) => {
      for (const m of new Set(typeof e.text === 'string' ? (e.text.match(ref) ?? []) : [])) {
        if (!defined.has(m)) {
          out.push(
            finding(
              'dangling_reference',
              `delta[${i}].text`,
              `refers to ${m}, which nothing defines`,
            ),
          );
        }
      }
    });
  }
  return out;
}

/** 3.4: every oracle spec maps to a requirement the delta defines (and does not remove). */
export function validateOracles(
  oracles: unknown,
  delta: { delta?: ReadonlyArray<{ requirement_id?: unknown; change?: unknown }> },
): Finding[] {
  const live = new Set(
    (delta.delta ?? []).flatMap((d) =>
      typeof d.requirement_id === 'string' && d.change !== 'removed' ? [d.requirement_id] : [],
    ),
  );
  const list = asRecord(oracles)['oracles'];
  const out: Finding[] = [];
  const seen = new Set<string>();
  (Array.isArray(list) ? list : []).forEach((o: Record<string, unknown>, i: number) => {
    const at = `oracles[${i}]`;
    if (typeof o['requirement_id'] !== 'string' || !live.has(o['requirement_id'])) {
      out.push(
        finding(
          'orphan_oracle',
          `${at}.requirement_id`,
          'an oracle spec maps to no requirement of the delta',
        ),
      );
    }
    const id = typeof o['oracle_id'] === 'string' ? o['oracle_id'] : '';
    if (seen.has(id))
      out.push(finding('duplicate_oracle', `${at}.oracle_id`, 'an oracle id appears twice'));
    seen.add(id);
  });
  return out;
}
