import type {
  ExamGrade,
  ExamQuestion,
  ExclusionManifest,
  FullQuestion,
  GoldenTaskCandidate,
  GoldenVerdict,
  OracleLockProposal,
  SeedVerdict,
  SpecSeed,
  SystemMap,
} from '@aisdlc/contracts';
import { useEffect, useState } from 'react';
import type { CardDetailWire } from '../api';
import { Card, Pill, Stat, Stats, Table } from '../ui';
import { DecideShell } from './DecideShell';
import { DecidersLine, Hash } from './shared';

// Card 3, Full 0.3 (PLAN M17; OB §6.2 row 0.3; FF1; DEC-15(a)): the factory's map of the repository (its
// areas and the imports between them), one living-spec seed per area to affirm, correct or keep as
// observed, the exam (the factory's own answers to grade: measured, never a gate), the golden-task
// candidates harvested after the exclusion manifest, the oracle-lock proposal, and the longer intent
// interview. Card 3 is decided by the intent slot; seeds and corrections reach agents as data only.

interface Floor {
  state: 'met' | 'unmet' | 'unknown';
  reasons: string[];
}
interface C3View {
  repo: string;
  baseline: {
    baseline_hash: string;
    baseline_sha: string;
    graph: {
      files: number;
      edges: number;
      external_imports: number;
      skipped_index: number;
      truncated: boolean;
    };
  };
  ff1: Floor;
  system_map: SystemMap;
  seeds: SpecSeed[];
  seeds_dropped: number;
  exam: ExamQuestion[];
  exclusion: ExclusionManifest;
  golden_candidates: GoldenTaskCandidate[];
  oracle_lock: OracleLockProposal;
  intent_questions: FullQuestion[];
}

const FLOOR_TONE = { met: 'ok', unmet: 'bad', unknown: 'warn' } as const;
const SEED_TEXT: Readonly<Record<SeedVerdict, string>> = {
  affirm: 'True: make it intended',
  correct: 'Wrong: I correct it',
  keep_observed: 'Keep it as observed',
};
const GRADE_TEXT: Readonly<Record<ExamGrade, string>> = {
  correct: 'Correct',
  incorrect: 'Incorrect',
  unsure: 'Not sure',
};
const GOLDEN_TEXT: Readonly<Record<GoldenVerdict, string>> = {
  accept: 'Use as a golden task',
  reject: 'Leave out',
};
const EXCLUSION_TEXT = {
  protected_path: 'protected path',
  sensitive_path: 'sensitive path',
  generated_or_vendored: 'generated or vendored',
} as const;
const area = (a: string) => (a === '.' ? '. (repository root)' : a);

interface Draft {
  seeds: Record<string, SeedVerdict | ''>;
  corrections: Record<string, string>;
  grades: Record<string, ExamGrade | ''>;
  golden: Record<string, GoldenVerdict | ''>;
  intent: Record<string, string>;
}
const EMPTY: Draft = { seeds: {}, corrections: {}, grades: {}, golden: {}, intent: {} };
function readDraft(key: string): Draft {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return EMPTY;
    const d = JSON.parse(raw) as Partial<Draft>;
    return {
      seeds: d.seeds ?? {},
      corrections: d.corrections ?? {},
      grades: d.grades ?? {},
      golden: d.golden ?? {},
      intent: d.intent ?? {},
    };
  } catch {
    return EMPTY;
  }
}

function Radios<T extends string>({
  name,
  legend,
  options,
  value,
  onChange,
  labels,
}: {
  name: string;
  legend: string;
  options: readonly T[];
  value: T | '';
  onChange: (v: T) => void;
  labels: Readonly<Record<T, string>>;
}) {
  return (
    <fieldset className="options">
      <legend className="ui-sr">{legend}</legend>
      {options.map((o) => (
        <label key={o} className="radio">
          <input
            type="radio"
            name={name}
            value={o}
            checked={value === o}
            onChange={() => onChange(o)}
          />{' '}
          {labels[o]}
        </label>
      ))}
    </fieldset>
  );
}

export function C3Form({ card, csrf }: { card: CardDetailWire; csrf: string }) {
  const v = card.view as unknown as C3View;
  // A draft for this baseline only, kept in this browser tab (never sent anywhere until the decision).
  const key = `c3-draft:${card.summary.card_id}:${v.baseline.baseline_hash}`;
  const [draft] = useState<Draft>(() => readDraft(key));
  const [seeds, setSeeds] = useState(draft.seeds);
  const [corrections, setCorrections] = useState(draft.corrections);
  const [grades, setGrades] = useState(draft.grades);
  const [golden, setGolden] = useState(draft.golden);
  const [intent, setIntent] = useState(draft.intent);
  useEffect(() => {
    try {
      sessionStorage.setItem(key, JSON.stringify({ seeds, corrections, grades, golden, intent }));
    } catch {
      // no storage (a private window): the draft is simply not kept
    }
  }, [key, seeds, corrections, grades, golden, intent]);

  const blocked = [
    ...(v.ff1.state === 'met'
      ? []
      : [`FF1 is not met (${v.ff1.reasons.join(', ')}): send the card back.`]),
    ...(v.intent_questions.every((q) => (intent[q.question_id] ?? '').trim() !== '')
      ? []
      : ['Answer every interview question.']),
    ...(v.exam.every((q) => (grades[q.question_id] ?? '') !== '')
      ? []
      : ['Grade every exam answer.']),
    ...(v.seeds.every((x) => (seeds[x.seed_id] ?? '') !== '') ? [] : ['Decide every seed.']),
    ...(v.seeds.some(
      (x) => seeds[x.seed_id] === 'correct' && (corrections[x.seed_id] ?? '').trim() === '',
    )
      ? ['Write what is meant for each seed you correct.']
      : []),
    ...(v.golden_candidates.every((g) => (golden[g.candidate_id] ?? '') !== '')
      ? []
      : ['Accept or leave out every golden-task candidate.']),
  ];
  const content = {
    baseline_hash: v.baseline.baseline_hash,
    intent_answers: v.intent_questions.map((q) => ({
      question_id: q.question_id,
      answer: (intent[q.question_id] ?? '').trim(),
    })),
    exam: v.exam.map((q) => ({
      question_id: q.question_id,
      grade: grades[q.question_id] || 'unsure',
    })),
    seeds: v.seeds.map((x) => {
      const verdict = seeds[x.seed_id] || 'keep_observed';
      return {
        seed_id: x.seed_id,
        verdict,
        ...(verdict === 'correct' ? { correction: (corrections[x.seed_id] ?? '').trim() } : {}),
      };
    }),
    golden: v.golden_candidates.map((g) => ({
      candidate_id: g.candidate_id,
      verdict: golden[g.candidate_id] || 'reject',
    })),
  };
  const graded = Object.values(grades).filter((g) => g === 'correct' || g === 'incorrect').length;
  const right = Object.values(grades).filter((g) => g === 'correct').length;

  return (
    <>
      <p>
        What the factory mapped in {v.repo} at{' '}
        <Hash value={v.baseline.baseline_sha} label="commit" />. A seed you affirm or correct
        becomes intended; seeds and your corrections reach agents as data, never as instructions.
      </p>
      <DecidersLine who={card.deciders} names={card.principal_names} what="this card" />
      <Card title="The code map">
        <Stats label="The code map">
          <Stat
            label="Files"
            value={v.baseline.graph.files}
            detail={`${v.baseline.graph.skipped_index} not indexed`}
          />
          <Stat
            label="Imports"
            value={v.baseline.graph.edges}
            detail={`${v.baseline.graph.external_imports} outside the repository`}
          />
          <Stat
            label="Areas"
            value={v.system_map.areas.length}
            detail="per-area levels are judged over these"
          />
          <Stat
            label="FF1"
            value={v.ff1.state}
            tone={FLOOR_TONE[v.ff1.state]}
            detail={v.ff1.reasons.join('; ') || 'full codekb, system map and a seed per area'}
          />
        </Stats>
        <Table
          caption="Areas of the repository"
          columns={[
            {
              key: 'a',
              header: 'Area',
              rowHeader: true,
              render: (a) => <span className="mono">{area(a.area)}</span>,
            },
            {
              key: 'f',
              header: 'Files',
              align: 'right',
              render: (a) => `${a.files} (${a.source_files} source, ${a.test_files} test)`,
            },
            { key: 'l', header: 'Languages', render: (a) => a.languages.join(', ') || '—' },
            {
              key: 'd',
              header: 'Depends on',
              render: (a) => a.depends_on.map(area).join(', ') || '—',
            },
            { key: 'u', header: 'Used by', render: (a) => a.used_by.map(area).join(', ') || '—' },
          ]}
          rows={v.system_map.areas}
          rowKey={(a) => a.area}
        />
      </Card>

      <Card title="Living-spec seeds">
        <p className="muted">
          One per area, observed from the code. A seed stays observed until you affirm it.
          {v.seeds_dropped > 0 ? ` ${v.seeds_dropped} seed(s) were left out by the lint.` : ''}
        </p>
        {v.seeds.map((x) => (
          <section key={x.seed_id} aria-label={`Seed for ${area(x.area)}`} className="seed">
            <h3>
              <span className="mono">{x.path}</span> <Pill tone="info">{x.status}</Pill>
            </h3>
            <pre className="proposed-text">{x.text}</pre>
            <p className="muted">
              Evidence: {x.evidence.map((e) => `${e.path}:${e.line}`).join(', ')}
            </p>
            <Radios
              name={`seed-${x.seed_id}`}
              legend={`Your verdict on the seed for ${area(x.area)}`}
              options={['affirm', 'correct', 'keep_observed'] as const}
              value={seeds[x.seed_id] ?? ''}
              onChange={(s) => setSeeds({ ...seeds, [x.seed_id]: s })}
              labels={SEED_TEXT}
            />
            {seeds[x.seed_id] === 'correct' ? (
              <div className="field">
                <label htmlFor={`corr-${x.seed_id}`}>What {area(x.area)} is meant to do</label>
                <textarea
                  id={`corr-${x.seed_id}`}
                  rows={6}
                  maxLength={4000}
                  value={corrections[x.seed_id] ?? ''}
                  onChange={(e) => setCorrections({ ...corrections, [x.seed_id]: e.target.value })}
                />
                <p className="muted hint">
                  Checked for secrets and instructions before anything is stored.
                </p>
              </div>
            ) : null}
          </section>
        ))}
      </Card>

      <Card title="The exam">
        <p className="muted">
          The factory answered these from its own map. Grade each answer: the score is measured,
          never a gate.{' '}
          {graded > 0 ? `So far ${right} of ${graded} graded answers are correct.` : ''}
        </p>
        {v.exam.map((q) => (
          <section key={q.question_id} aria-label={q.text} className="exam">
            <h3>{q.text}</h3>
            <p>{q.answer}</p>
            {q.evidence.length > 0 ? (
              <p className="muted">
                Evidence: {q.evidence.map((e) => `${e.path}:${e.line}`).join(', ')}
              </p>
            ) : null}
            <Radios
              name={`exam-${q.question_id}`}
              legend={`Your grade for: ${q.text}`}
              options={['correct', 'incorrect', 'unsure'] as const}
              value={grades[q.question_id] ?? ''}
              onChange={(g) => setGrades({ ...grades, [q.question_id]: g })}
              labels={GRADE_TEXT}
            />
          </section>
        ))}
      </Card>

      <Card title="Golden-task candidates">
        <p className="muted">
          Existing tests whose code the factory could be asked to rebuild. The exclusion manifest
          ran first: {v.exclusion.excluded_count} file(s) were left out ({v.exclusion.not_indexed}{' '}
          more were never indexed).
        </p>
        <Table
          caption="Golden-task candidates"
          columns={[
            {
              key: 't',
              header: 'Test',
              rowHeader: true,
              render: (g) => <span className="mono">{g.test.path}</span>,
            },
            {
              key: 'a',
              header: 'Area',
              render: (g) => <span className="mono">{area(g.area)}</span>,
            },
            {
              key: 's',
              header: 'Code it checks',
              render: (g) => g.subjects.map((s) => s.path).join(', '),
            },
            {
              key: 'v',
              header: 'Your choice',
              render: (g) => (
                <Radios
                  name={`golden-${g.candidate_id}`}
                  legend={`Your choice for ${g.test.path}`}
                  options={['accept', 'reject'] as const}
                  value={golden[g.candidate_id] ?? ''}
                  onChange={(x) => setGolden({ ...golden, [g.candidate_id]: x })}
                  labels={GOLDEN_TEXT}
                />
              ),
            },
          ]}
          rows={v.golden_candidates}
          rowKey={(g) => g.candidate_id}
          empty={
            <p className="muted">No test of the repository imports code the harvest may take.</p>
          }
        />
        {v.exclusion.excluded.length > 0 ? (
          <details>
            <summary>What the exclusion manifest left out</summary>
            <ul aria-label="Excluded from the harvest">
              {v.exclusion.excluded.map((x) => (
                <li key={x.path}>
                  <span className="mono">{x.path}</span>: {EXCLUSION_TEXT[x.reason]}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </Card>

      <Card title="Oracle lock (proposal)">
        <p>
          {v.oracle_lock.tests.length} test file(s){v.oracle_lock.truncated ? ' (and more)' : ''}{' '}
          would be locked as oracles. This is a proposal: it reaches the repository only through an
          X2 decision.
        </p>
      </Card>

      <Card title="The intent interview">
        {v.intent_questions.map((q) => (
          <div className="field" key={q.question_id}>
            <label htmlFor={`full-${q.question_id}`}>{q.text}</label>
            <textarea
              id={`full-${q.question_id}`}
              rows={2}
              maxLength={2000}
              value={intent[q.question_id] ?? ''}
              onChange={(e) => setIntent({ ...intent, [q.question_id]: e.target.value })}
            />
          </div>
        ))}
      </Card>
      <DecideShell
        card={card}
        csrf={csrf}
        content={content}
        blocked={blocked}
        approveLabel="Affirm the Full baseline"
      />
    </>
  );
}
