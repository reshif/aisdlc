import type { ArtefactType } from '@aisdlc/contracts';

// Artefacts rendered for people (PLAN M12: "gate cards show artefacts rendered for humans (markdown) with
// their hashes"). ONE pure function of the stored content, so what a person reads is reproducible from
// the hash they decide on: nothing here is stored. The text is whatever the agent wrote: the portal shows
// it as text (never as HTML), and the markdown is not something any agent or gate ever reads back.

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** One line: a newline in a value cannot start a heading or a list item of its own. */
const line = (v: unknown): string => str(v).replace(/\s+/g, ' ').trim();

function evidence(e: unknown): string {
  if (!isObj(e)) return '';
  const lines = typeof e['lines'] === 'string' ? `:${e['lines']}` : '';
  return `\`${line(e['path'])}${lines}\` at \`${line(e['commit_sha']).slice(0, 12)}\``;
}

function citations(c: unknown): string[] {
  const list = arr(c)
    .map(evidence)
    .filter((x) => x !== '');
  return list.length === 0 ? [] : ['', '### Citations', ...list.map((x) => `- ${x}`)];
}

function assumptions(a: unknown): string[] {
  const list = arr(a).filter(isObj);
  return list.length === 0
    ? []
    : ['', '### Assumptions', ...list.map((x) => `- (${line(x['kind'])}) ${line(x['text'])}`)];
}

function bullets(title: string, v: unknown): string[] {
  const list = arr(v)
    .map(line)
    .filter((x) => x !== '');
  return list.length === 0 ? [] : ['', `### ${title}`, ...list.map((x) => `- ${x}`)];
}

function document(c: Obj): string[] {
  return [
    `# ${line(c['title']) || 'Untitled'}`,
    ...arr(c['sections']).flatMap((s) =>
      isObj(s) ? ['', `## ${line(s['heading'])}`, '', str(s['text'])] : [],
    ),
    ...bullets('Ambiguities (the intent is unclear here)', c['ambiguity']),
    ...citations(c['citations']),
    ...assumptions(c['assumptions']),
  ];
}

function options(c: Obj): string[] {
  const opts = arr(c['options']).filter(isObj);
  const rec = typeof c['recommended'] === 'number' ? c['recommended'] : -1;
  return [
    '# Decision brief',
    ...opts.flatMap((o, i) => [
      '',
      `## Option ${i + 1}: ${line(o['title'])}${i === rec ? ' (recommended)' : ''}`,
      '',
      str(o['summary']),
      ...bullets('Pros', o['pros']),
      ...bullets('Cons', o['cons']),
    ]),
    '',
    '## Recommendation',
    '',
    str(c['rationale']),
    ...(c['sizing'] === 'smaller'
      ? ['', '> The work is smaller than the lane it was routed to.']
      : []),
    ...citations(c['citations']),
    ...assumptions(c['assumptions']),
  ];
}

function reverseEngineering(c: Obj): string[] {
  return [
    `# Reverse engineering (${line(c['depth'])})`,
    ...arr(c['claims'])
      .filter(isObj)
      .flatMap((k) => [
        '',
        `## ${line(k['claim_id'])} (${line(k['confidence'])} confidence)`,
        '',
        str(k['text']),
        ...arr(k['evidence']).map((e) => `- ${evidence(e)}`),
      ]),
    ...bullets('Unknowns', c['unknowns']),
  ];
}

function affected(c: Obj): string[] {
  return [
    '# Affected requirements',
    '',
    ...arr(c['requirements'])
      .filter(isObj)
      .map(
        (r) => `- **${line(r['requirement_id'])}** in \`${line(r['path'])}\`: ${line(r['reason'])}`,
      ),
  ];
}

function specDelta(c: Obj): string[] {
  return [
    '# Spec delta',
    ...arr(c['delta'])
      .filter(isObj)
      .flatMap((d) => [
        '',
        `## ${line(d['requirement_id'])} (${line(d['change'])})`,
        '',
        str(d['text']),
      ]),
    ...assumptions(c['assumptions']),
  ];
}

function oracles(c: Obj): string[] {
  return [
    '# Oracle specs',
    ...arr(c['oracles'])
      .filter(isObj)
      .flatMap((o) => [
        '',
        `## ${line(o['oracle_id'])} for ${line(o['requirement_id'])}`,
        '',
        str(o['description']),
        '',
        `Fails before the implementation: ${line(o['expected_failure'])}`,
      ]),
  ];
}

function findings(title: string, c: Obj): string[] {
  const list = arr(c['findings']).filter(isObj);
  return [
    `# ${title}: ${line(c['verdict'])}`,
    '',
    ...(list.length === 0
      ? ['No findings.']
      : list.map((f) => {
          const loc = isObj(f['location'])
            ? `\`${line(f['location']['path'])}${typeof f['location']['line'] === 'number' ? `:${f['location']['line']}` : ''}\``
            : '';
          const tag = f['rule_id'] ?? f['code'];
          const rule = typeof tag === 'string' ? ` [${line(tag)}]` : '';
          return `- (${line(f['severity'])})${rule} ${loc} ${line(f['message'])}`;
        })),
  ];
}

/** The markdown of an artefact's content. An unknown shape is shown as the JSON it is, in a code fence. */
export function renderArtefact(type: ArtefactType, content: unknown): string {
  if (!isObj(content)) return '```json\n' + JSON.stringify(content, null, 2) + '\n```\n';
  let out: string[];
  switch (type) {
    case 'context_brief':
    case 'impact':
    case 'initiative':
      out = document(content);
      break;
    case 'decision_brief':
      out = options(content);
      break;
    case 'reverse_engineering':
      out = reverseEngineering(content);
      break;
    case 'affected_requirements':
      out = affected(content);
      break;
    case 'spec_delta':
      out = specDelta(content);
      break;
    case 'oracle_specs':
      out = oracles(content);
      break;
    case 'spec_review':
      out = findings('Clean-context review', content);
      break;
    case 'validation_report':
      out = findings('Validation', content);
      break;
    default:
      out = ['```json', JSON.stringify(content, null, 2), '```'];
  }
  return `${out.join('\n')}\n`;
}
