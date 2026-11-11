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

/** A design document (4.1 to 4.4): the prose plus the structured facts a rule reads, shown so a person sees them. */
function designDocument(c: Obj): string[] {
  const files = arr(c['contract_files']).filter(isObj);
  const migrations = arr(c['migrations']).filter(isObj);
  const calls = arr(c['network_calls']).filter(isObj);
  return [
    ...document(c),
    ...(files.length === 0
      ? []
      : [
          '',
          '## Contract files',
          ...files.flatMap((x) => [
            '',
            `### \`${line(x['path'])}\` (${line(x['format'])})`,
            '',
            '```json',
            str(x['content']).replace(/```/g, "'''"),
            '```',
          ]),
        ]),
    ...(migrations.length === 0
      ? []
      : [
          '',
          '## Migrations',
          ...migrations.map(
            (m) =>
              `- ${line(m['name'])}: ${m['reversible'] === true ? 'reversible' : m['irreversible_flagged'] === true ? 'IRREVERSIBLE (flagged)' : 'NOT reversible and NOT flagged'}${typeof m['note'] === 'string' ? `, ${line(m['note'])}` : ''}`,
          ),
        ]),
    ...(calls.length === 0
      ? []
      : [
          '',
          '## Network calls',
          ...calls.map(
            (n) =>
              `- ${line(n['host'])}: ${line(n['purpose'])} (${typeof n['approval_ref'] === 'string' ? `approval: ${line(n['approval_ref'])}` : 'no approval reference'})`,
          ),
        ]),
  ];
}

function classification(c: Obj): string[] {
  return [
    '# Classification',
    '',
    `- work type: ${line(c['work_type'])}`,
    `- size: ${line(c['size'])}`,
    `- risk: ${line(c['risk'])}`,
    `- confidence: ${typeof c['confidence'] === 'number' ? c['confidence'] : '?'}`,
    '',
    "> The classifier says what the work is. The lane is the factory's, derived from this by the catalogue.",
    '',
    str(c['rationale']),
  ];
}

function intentBlock(c: Obj): string[] {
  return [
    '# Intent',
    '',
    '## Goal',
    '',
    str(c['goal']),
    ...bullets('Non-goals', c['non_goals']),
    ...bullets('Acceptance criteria', c['acceptance_criteria']),
    ...bullets('Open questions', c['open_questions']),
    ...assumptions(c['assumptions']),
  ];
}

function constitutionReport(c: Obj): string[] {
  const det = arr(c['deterministic']).filter(isObj);
  const review = isObj(c['review']) ? c['review'] : {};
  return [
    `# Constitution check: ${line(c['verdict'])}`,
    '',
    `Constitution version ${typeof c['constitution_version'] === 'number' ? c['constitution_version'] : '?'}.`,
    '',
    '## Rules (deterministic)',
    ...(det.length === 0
      ? ['', 'No rule found anything.']
      : det.map(
          (f) =>
            `- (${line(f['severity'])}) [${line(f['rule_id'])}] ${isObj(f['location']) ? `\`${line(f['location']['path'])}\`` : ''} ${line(f['message'])}`,
        )),
    '',
    ...findings('Review (A5)', review),
  ];
}

function unitSplit(c: Obj): string[] {
  return [
    '# Units',
    ...arr(c['units'])
      .filter(isObj)
      .flatMap((u) => [
        '',
        `## ${line(u['unit_key'])}: ${line(u['title'])} (${line(u['size'])})`,
        '',
        `Depends on: ${arr(u['depends_on']).map(line).join(', ') || 'nothing'}`,
        ...arr(u['paths']).map((p) => `- scope \`${line(p)}\``),
      ]),
    ...assumptions(c['assumptions']),
    ...base(c),
  ];
}

const base = (c: Obj): string[] =>
  typeof c['base_sha'] === 'string'
    ? ['', `Planned against \`${line(c['base_sha']).slice(0, 12)}\`.`]
    : [];

function unitSequence(c: Obj): string[] {
  return [
    '# Sequence',
    '',
    ...arr(c['order']).map((k, i) => `${i + 1}. ${line(k)}`),
    '',
    str(c['rationale']),
    ...assumptions(c['assumptions']),
    ...base(c),
  ];
}

/** The task plan: `plan.md`. */
function taskPlan(c: Obj): string[] {
  return [
    '# Plan',
    ...arr(c['units'])
      .filter(isObj)
      .flatMap((u) => [
        '',
        `## Unit ${line(u['unit_key'])}`,
        ...arr(u['tasks'])
          .filter(isObj)
          .flatMap((t) => [
            '',
            `- [ ] **${line(t['task_id'])}** ${line(t['description'])}`,
            `  - verified by: ${line(t['verification'])}`,
          ]),
      ]),
    ...assumptions(c['assumptions']),
    ...base(c),
  ];
}

function verification(c: Obj): string[] {
  return [
    '# Verification binding',
    '',
    ...arr(c['bindings'])
      .filter(isObj)
      .map((b) => `- **${line(b['unit_key'])}**: ${arr(b['oracle_ids']).map(line).join(', ')}`),
    ...assumptions(c['assumptions']),
    ...base(c),
  ];
}

function envelope(c: Obj): string[] {
  return [
    '# Budget envelope',
    '',
    ...arr(c['units'])
      .filter(isObj)
      .map(
        (u) =>
          `- **${line(u['unit_key'])}** (${line(u['size'])}): ${String(u['max_tokens'])} tokens, ${String(u['max_cost_micro_usd'])} micro-USD`,
      ),
    ...(isObj(c['total'])
      ? [
          '',
          `Total: ${String(c['total']['max_tokens'])} tokens, ${String(c['total']['max_cost_micro_usd'])} micro-USD${c['capped'] === true ? ' (capped by the lane default)' : ''}.`,
        ]
      : []),
    ...base(c),
  ];
}

function capacity(c: Obj): string[] {
  return [
    '# Capacity input',
    '',
    `Units in parallel: ${String(c['max_parallel_units'])} (the plan asked for ${String(c['proposed_parallel_units'])}; the factory bounds it).`,
    ...arr(c['review_minutes'])
      .filter(isObj)
      .map((r) => `- review of ${line(r['unit_key'])}: ${String(r['minutes'])} minutes`),
    '',
    str(c['rationale']),
    ...assumptions(c['assumptions']),
    ...base(c),
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

/**
 * The patch an X2 decision is bound to (M13.6): the paths it touches, which are protected, and how big each file is. NOT the
 * file contents (the card shows what the decision covers; the full patch is in the artefact by its hash, and the decider
 * reads the hash they approve). Paths are shown as text in code spans.
 */
function patchSummary(c: Obj): string[] {
  const files = arr(c['files']).filter(isObj);
  return [
    '# Patch (what this decision covers)',
    '',
    `${files.length} files. The hash of this patch is the hash the Push Broker checks: another patch is another decision.`,
    '',
    ...files.map((f) => {
      const bytes = f['op'] === 'put' ? Math.floor((str(f['content_b64']).length * 3) / 4) : 0;
      return `- \`${line(f['op'])}\` \`${line(f['path'])}\`${f['op'] === 'put' ? ` (${bytes} bytes)` : ''}`;
    }),
  ];
}

/** The oracle test files A6 wrote at 6.3: their paths and sizes (the code is in the artefact by its hash). */
function oracleCode(c: Obj): string[] {
  const files = arr(c['files']).filter(isObj);
  return [
    `# Oracle test files (unit ${line(c['unit_key'])})`,
    '',
    ...files.map((f) => `- \`${line(f['path'])}\` (${str(f['content']).length} characters)`),
  ];
}

function spikeReport(c: Obj): string[] {
  return [
    '# Spike report',
    '',
    ...bullets('Findings', c['findings']),
    '',
    '### Recommendation',
    line(c['recommendation']),
    '',
    `Files changed: ${line(c['files_changed'])}. Archived work: \`${line(c['archive_ref']) || 'none'}\`. Nothing was pushed.`,
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
    case 'adr':
    case 'contracts':
    case 'data_migration':
    case 'nfr_threat_ops':
      out = designDocument(content);
      break;
    case 'classification':
      out = classification(content);
      break;
    case 'intent_block':
      out = intentBlock(content);
      break;
    case 'constitution_report':
      out = constitutionReport(content);
      break;
    case 'unit_split':
      out = unitSplit(content);
      break;
    case 'unit_sequence':
      out = unitSequence(content);
      break;
    case 'plan':
      out = taskPlan(content);
      break;
    case 'verification_binding':
      out = verification(content);
      break;
    case 'budget_envelope':
      out = envelope(content);
      break;
    case 'capacity_input':
      out = capacity(content);
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
    case 'patch':
      out = patchSummary(content);
      break;
    case 'oracle_code':
      out = oracleCode(content);
      break;
    case 'spike_report':
      out = spikeReport(content);
      break;
    default:
      out = ['```json', JSON.stringify(content, null, 2), '```'];
  }
  return `${out.join('\n')}\n`;
}
