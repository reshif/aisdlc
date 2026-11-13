import { lookupTerm, type GlossaryFamily } from '@aisdlc/contracts';

// Field names and values of a setting as a person reads them: a value that is a glossary code (an approval, a track,
// a role slot, a sandbox kind, an agent) shows its plain label; a field name `max_turns` reads "Max turns". The JSON
// itself is data and keeps its codes.

/** Families a setting's record keys and enum values may come from, most specific first. */
const FAMILIES: readonly GlossaryFamily[] = [
  'gate',
  'lane',
  'roleSlot',
  'sandboxClass',
  'agent',
  'dataClass',
  'backEdge',
  'trigger',
  'handoff',
  'level',
  'tier',
  'unitSize',
  'integrationKind',
  'integrationAdapter',
  'integrationStatus',
];

/** The plain label of a code, or `null` when no family has it. */
export function codeWord(v: string): string | null {
  for (const f of FAMILIES) {
    const t = lookupTerm(f, v);
    if (t) return t.label;
  }
  return null;
}

const UNITS: ReadonlyArray<readonly [RegExp, string]> = [
  [/_ms$/, ' (milliseconds)'],
  [/_s$/, ' (seconds)'],
  [/_days$/, ' (days)'],
  [/_micro_usd$/, ' (millionths of a dollar)'],
];

/** `max_turns` -> "Max turns"; `run_time_s` -> "Run time (seconds)"; a code -> its plain label. */
export function fieldWord(name: string): string {
  const code = codeWord(name) ?? (/^[a-z]\d+$/.test(name) ? codeWord(name.toUpperCase()) : null);
  if (code) return code;
  let unit = '';
  let base = name;
  for (const [re, u] of UNITS) {
    if (re.test(base)) {
      base = base.replace(re, '');
      unit = u;
      break;
    }
  }
  const words = base.replace(/[_.]+/g, ' ').trim();
  return words === '' ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}${unit}`;
}

/** A scalar as text: numbers grouped, booleans as yes/no, codes as their label. */
export function valueWord(v: unknown): string {
  if (v === null || v === undefined) return 'not set';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'number') return v.toLocaleString('en-GB');
  if (typeof v === 'string') return codeWord(v) ?? v;
  if (Array.isArray(v)) {
    if (v.length === 0) return 'none';
    return v.every((x) => typeof x !== 'object' || x === null)
      ? v.map(valueWord).join(', ')
      : `${v.length} entries`;
  }
  return `${Object.keys(v as object).length} entries`;
}
