import type { Fact, PresenceItem } from '@aisdlc/contracts';
import { RULES, scanText, type SecretRule } from '@aisdlc/secrets-rules';
import { findManifests, isTestish, isVendored } from './paths.js';
import { parseJson, parseJsonc, parseTomlSafe, parseYamlSafe } from './safe-parse.js';
import { loadWorkflows } from './workflows.js';
import {
  Collector,
  basename,
  lineOfText,
  type Detector,
  type TreeFile,
  type TreeReader,
} from './types.js';

// Presence detector (PLAN M6.6; OB §3.3): the criteria the Census could decide from the tree alone
// but nothing read: README, LICENSE, SECURITY.md, CONTRIBUTING and PR template, dependency-update
// config, `.env.example`, repo shape, generated/vendored declarations, quarantine manifest, skip
// inventory, decision records, runbook pointers, the CI workflow that runs `check`, formatter /
// linter / type-checker configs, toolchain pins, coverage tooling. One `presence` fact per item.
//
// Content checks are structural (headings, file names, parsed keys, counts). A fact never carries
// repo text. Nothing is executed or fetched; an over-limit or unparseable file is a coverage item.

type Detail = Record<string, string | number | boolean | null>;
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const TEXT_LIMIT = 1024 * 1024;
const MAX_CONFIG_READS = 100;
const MAX_TEST_FILES = 500;
const TEST_FILE_LIMIT = 256 * 1024;
const MAX_EVIDENCE = 3;

export interface PresenceOptions {
  readonly secretRules?: readonly SecretRule[];
}

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|php|cs|swift|scala)$/;

/** Root-level file names matched case-insensitively. */
const rootFiles = (reader: TreeReader, re: RegExp): TreeFile[] =>
  reader.files.filter((f) => !f.path.includes('/') && re.test(f.path));

/** Matches `name` in the root, `.github/` or `docs/` (the places GitHub itself looks). */
const communityFiles = (reader: TreeReader, re: RegExp): TreeFile[] =>
  reader.files.filter((f) => {
    const i = f.path.lastIndexOf('/');
    const dir = i === -1 ? '' : f.path.slice(0, i);
    return (dir === '' || dir === '.github' || dir === 'docs') && re.test(f.path.slice(i + 1));
  });

const present = (
  item: PresenceItem,
  ev: Array<{ file: TreeFile; line: number }>,
  detail: Detail = {},
): Fact => ({
  kind: 'presence',
  detector: 'presence',
  item,
  state: 'present',
  detail,
  evidence: ev
    .slice(0, MAX_EVIDENCE)
    .map((e) => ({ path: e.file.path, blob: e.file.blob, line: e.line })),
});
const absent = (item: PresenceItem, detail: Detail = {}): Fact => ({
  kind: 'presence',
  detector: 'presence',
  item,
  state: 'absent',
  detail,
  evidence: [],
});

// ---------------------------------------------------------------- README

const PURPOSE_HEADING =
  /\b(?:about|overview|introduction|purpose|what\s+(?:is|it)|description|why|summary)\b/i;
const RUN_HEADING =
  /\b(?:usage|getting\s+started|quick\s*-?start|how\s+to\s+run|running|run|install(?:ation)?|set\s*-?up|build(?:ing)?|development|develop|commands)\b/i;

interface Heading {
  readonly text: string;
  readonly line: number;
  readonly level: number;
}

/** ATX (`# x`) and setext (`x` over `===` / `---`) headings, and reST underlines; fenced code skipped. */
export function headings(text: string): Heading[] {
  const lines = text.split(/\r?\n/);
  const out: Heading[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^\s*(?:```|~~~)/.test(l)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const atx = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (atx) {
      out.push({ text: atx[2] as string, line: i + 1, level: (atx[1] as string).length });
      continue;
    }
    const next = lines[i + 1];
    if (l.trim() !== '' && next !== undefined && /^(?:={3,}|-{3,}|~{3,}|\^{3,})\s*$/.test(next)) {
      out.push({ text: l.trim(), line: i + 1, level: next.startsWith('=') ? 1 : 2 });
      i++;
    }
  }
  return out;
}

async function readme(reader: TreeReader, c: Collector): Promise<Fact> {
  const file = rootFiles(reader, /^readme(?:\.(?:md|markdown|rst|txt|adoc))?$/i)[0];
  if (!file) return absent('readme');
  const got = await c.text(file.path, TEXT_LIMIT);
  if (!got) return present('readme', [{ file, line: 1 }], { purpose: null, run: null });
  const hs = headings(got.text);
  const purposeH = hs.find((h) => PURPOSE_HEADING.test(h.text));
  const runH = hs.find((h) => RUN_HEADING.test(h.text));
  // Purpose is also met by an intro of real prose between the title and the next heading.
  const lines = got.text.split(/\r?\n/);
  const title = hs.find((h) => h.level === 1);
  const stop = hs.find((h) => h.line > (title?.line ?? 0) && h.level > 1)?.line ?? lines.length + 1;
  const introChars = lines
    .slice(title ? title.line : 0, stop - 1)
    .filter((l) => !/^\s*(?:[!<[|>`]|[-=~^]{3,}\s*$)/.test(l))
    .join(' ')
    .trim().length;
  const intro = title !== undefined && introChars >= 40;
  const purposeLine = purposeH?.line ?? (intro ? title.line : 0);
  return present(
    'readme',
    [{ file, line: purposeLine || 1 }, ...(runH ? [{ file, line: runH.line }] : [])],
    { purpose: purposeH !== undefined || intro, run: runH !== undefined, headings: hs.length },
  );
}

// ---------------------------------------------------------------- the small file checks

async function securityPolicy(reader: TreeReader, c: Collector): Promise<Fact> {
  const file = communityFiles(reader, /^security(?:\.(?:md|rst|txt))?$/i)[0];
  if (!file) return absent('security_policy');
  const got = await c.text(file.path, TEXT_LIMIT);
  if (!got) return present('security_policy', [{ file, line: 1 }], { private_reporting: null });
  // A private channel: an address, a `mailto:`, the host's advisory form, or the words saying so.
  const re =
    /mailto:|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|security\/advisories|advisories\/new|private(?:ly)?\s+(?:vulnerability\s+)?report|report\w*\s+(?:\w+\s+){0,3}privately|private\s+disclosure/i;
  const m = re.exec(got.text);
  return present('security_policy', [{ file, line: m ? lineOfText(got.text, m[0]) : 1 }], {
    private_reporting: m !== null,
  });
}

const simplePresence = (
  reader: TreeReader,
  item: PresenceItem,
  files: TreeFile[],
  detail: Detail = {},
): Fact =>
  files.length > 0
    ? present(
        item,
        files.map((file) => ({ file, line: 1 })),
        { files: files.length, ...detail },
      )
    : absent(item);

function licenseFact(reader: TreeReader): Fact {
  const files = [
    ...rootFiles(reader, /^(?:licen[sc]e|copying|unlicen[sc]e)(?:[.-][\w.-]+)?$/i),
    ...reader.files.filter((f) => /^LICENSES\/[^/]+$/.test(f.path)),
  ];
  const f = files[0];
  if (!f) return absent('license');
  return present(
    'license',
    files.map((file) => ({ file, line: 1 })),
    { empty: files.every((x) => x.size === 0) },
  );
}

function prTemplate(reader: TreeReader): Fact {
  const files = reader.files.filter((f) =>
    /^(?:\.github\/|docs\/)?pull_request_template\.(?:md|txt)$|^\.github\/pull_request_template\/[^/]+\.md$/i.test(
      f.path,
    ),
  );
  return simplePresence(reader, 'pr_template', files);
}

// ---------------------------------------------------------------- dependency updates

async function dependencyUpdates(reader: TreeReader, c: Collector): Promise<Fact> {
  const dependabot = reader.files.filter((f) => /^\.github\/dependabot\.ya?ml$/.test(f.path));
  const renovate = reader.files.filter((f) =>
    /^(?:\.github\/|\.gitlab\/)?(?:renovate\.json5?|\.renovaterc(?:\.json5?)?)$/.test(f.path),
  );
  const first = dependabot[0] ?? renovate[0];
  if (!first) return absent('dependency_updates');
  let valid: boolean | null = null;
  let tool = 'renovate';
  let entries = 0;
  const got = await c.text(first.path, 512 * 1024);
  if (got) {
    if (dependabot[0]) {
      tool = 'dependabot';
      const y = parseYamlSafe(got.text);
      if (!y.ok) c.unparseable(got.file, y.why);
      else {
        const u = isObj(y.value.value) ? y.value.value['updates'] : undefined;
        entries = Array.isArray(u) ? u.length : 0;
        valid = entries > 0;
      }
    } else {
      const j = parseJsonc(got.text);
      if (!j.ok) c.unparseable(got.file, j.why);
      else valid = isObj(j.value);
    }
  }
  return present('dependency_updates', [{ file: first, line: 1 }], { tool, valid, entries });
}

// ---------------------------------------------------------------- .env.example

const ENV_EXAMPLE =
  /^(?:\.env\.(?:example|sample|template|dist|defaults)|(?:example|sample)\.env|\.env\.[\w-]+\.(?:example|sample|template))$/i;

async function envExample(
  reader: TreeReader,
  c: Collector,
  rules: readonly SecretRule[],
): Promise<Fact> {
  const files = reader.files.filter(
    (f) => ENV_EXAMPLE.test(basename(f.path)) && !isVendored(f.path),
  );
  const first = files[0];
  if (!first) return absent('env_example');
  let real = 0;
  let unread = 0;
  let at: { file: TreeFile; line: number } | null = null;
  for (const f of files.slice(0, 10)) {
    const got = await c.text(f.path, 256 * 1024);
    if (!got) {
      unread++;
      continue;
    }
    // The shared secret ruleset decides what is a real value; only counts and the line leave here.
    const hits = scanText(got.text, rules);
    if (hits.length > 0 && at === null)
      at = { file: f, line: Math.min(...hits.map((h) => h.line)) };
    real += hits.length;
  }
  return present('env_example', [at ?? { file: first, line: 1 }], {
    files: files.length,
    real_values: real,
    unread,
  });
}

// ---------------------------------------------------------------- repo shape

const BINARY_EXT =
  /\.(?:png|jpe?g|gif|bmp|ico|webp|pdf|zip|gz|tgz|bz2|xz|7z|rar|jar|war|class|exe|dll|so|dylib|a|o|bin|wasm|pyc|mp[34]|mov|avi|woff2?|ttf|otf|eot|psd|sqlite3?|db|parquet|onnx|pt|pth|ckpt|safetensors)$/i;
const LARGE_FILE_BYTES = 5 * 1024 * 1024;

async function repoShape(reader: TreeReader, c: Collector): Promise<Fact> {
  let total = 0;
  let binaries = 0;
  let large = 0;
  for (const f of reader.files) {
    total += f.size;
    if (BINARY_EXT.test(f.path)) binaries++;
    if (f.size > LARGE_FILE_BYTES) large++;
  }
  const attrs = reader.get('.gitattributes');
  let lfs = 0;
  if (attrs) {
    const got = await c.text(attrs.path, 256 * 1024);
    if (got) lfs = got.text.split(/\r?\n/).filter((l) => /\bfilter=lfs\b/.test(l)).length;
  }
  return present('repo_shape', attrs && lfs > 0 ? [{ file: attrs, line: 1 }] : [], {
    total_bytes: total,
    files: reader.files.length,
    binary_files: binaries,
    large_files: large,
    lfs_patterns: lfs,
  });
}

// ---------------------------------------------------------------- generated and vendored paths

const GENERATED_CANDIDATE =
  /(?:^|\/)(?:vendor|third_party|generated|__generated__|gen)\/|\.pb\.go$|_pb2(?:_grpc)?\.py$|\.min\.(?:js|css)$|\.generated\.[a-z]+$|\.g\.dart$/;

async function generatedPaths(reader: TreeReader, c: Collector): Promise<Fact> {
  const candidates = reader.files.filter((f) => GENERATED_CANDIDATE.test(f.path));
  const attrs = reader.get('.gitattributes');
  let declared = 0;
  let line = 1;
  if (attrs) {
    const got = await c.text(attrs.path, 256 * 1024);
    if (got) {
      got.text.split(/\r?\n/).forEach((l, i) => {
        const body = l.replace(/(^|\s)#.*$/, '').trim();
        if (/(?:^|\s)linguist-(?:generated|vendored)(?:=(?:true|1))?(?=\s|$)/.test(body)) {
          if (declared === 0) line = i + 1;
          declared++;
        }
      });
    }
  }
  const detail = { declared, candidates: candidates.length };
  if (attrs && declared > 0) return present('generated_paths', [{ file: attrs, line }], detail);
  const cand = candidates[0];
  return cand
    ? present('generated_paths', [{ file: cand, line: 1 }], detail)
    : absent('generated_paths', detail);
}

// ---------------------------------------------------------------- skip inventory and quarantine

const SKIP_MARKER =
  /\b(?:it|test|describe|context|suite)\.(?:skip|todo)\b|\bx(?:it|describe|test)\s*\(|\bt\.Skip(?:Now|f)?\s*\(|@pytest\.mark\.(?:skip|skipif|xfail)\b|\bpytest\.(?:skip|xfail)\s*\(|@unittest\.(?:skip|expectedFailure)|#\[ignore\b|@Disabled\b|@Ignore\b|\bpending\s*\(/;

async function skipInventory(reader: TreeReader, c: Collector): Promise<Fact> {
  const tests = reader.files.filter(
    (f) => SOURCE_EXT.test(f.path) && !isVendored(f.path) && isTestish(f.path),
  );
  if (tests.length > MAX_TEST_FILES) c.capped('test files', MAX_TEST_FILES);
  let skipped = 0;
  let withSkips = 0;
  let read = 0;
  const ev: Array<{ file: TreeFile; line: number }> = [];
  for (const f of tests.slice(0, MAX_TEST_FILES)) {
    const got = await c.text(f.path, TEST_FILE_LIMIT);
    if (!got) continue;
    read++;
    let n = 0;
    got.text.split(/\r?\n/).forEach((l, i) => {
      if (!SKIP_MARKER.test(l)) return;
      n++;
      if (ev.length < MAX_EVIDENCE && ev.every((e) => e.file.path !== f.path))
        ev.push({ file: f, line: i + 1 });
    });
    if (n > 0) withSkips++;
    skipped += n;
  }
  return present('skip_inventory', ev, {
    test_files: tests.length,
    test_files_read: read,
    skipped,
    files_with_skips: withSkips,
  });
}

const QUARANTINE =
  /(?:^|\/)\.?quarantine(?:\/manifest)?\.(?:ya?ml|json)$|(?:^|\/)quarantine\/[^/]+\.(?:ya?ml|json)$/i;
const EXPIRY_KEYS = ['expires', 'expiry', 'expires_at', 'expiry_date', 'expires_on', 'expire'];

const nonEmpty = (v: unknown): boolean =>
  (typeof v === 'string' && v.trim() !== '') || typeof v === 'number' || v instanceof Date;

async function quarantine(reader: TreeReader, c: Collector): Promise<Fact> {
  const files = reader.files.filter((f) => QUARANTINE.test(f.path) && !isVendored(f.path));
  const first = files[0];
  if (!first) return absent('quarantine_manifest');
  let entries = 0;
  let complete = 0;
  let valid: boolean | null = null;
  for (const f of files.slice(0, 5)) {
    const got = await c.text(f.path, 512 * 1024);
    if (!got) {
      valid = null;
      continue;
    }
    let root: unknown;
    if (/\.json$/i.test(f.path)) {
      const p = parseJson(got.text);
      if (!p.ok) {
        c.unparseable(got.file, p.why);
        valid = null;
        continue;
      }
      root = p.value;
    } else {
      const p = parseYamlSafe(got.text);
      if (!p.ok) {
        c.unparseable(got.file, p.why);
        valid = null;
        continue;
      }
      root = p.value.value;
    }
    const list = Array.isArray(root)
      ? root
      : isObj(root)
        ? (['tests', 'quarantined', 'entries', 'quarantine', 'items']
            .map((k) => root[k])
            .find((v) => Array.isArray(v)) ?? [])
        : [];
    valid = valid ?? true;
    for (const e of list as unknown[]) {
      entries++;
      if (
        isObj(e) &&
        nonEmpty(e['issue']) &&
        nonEmpty(e['owner']) &&
        EXPIRY_KEYS.some((k) => nonEmpty(e[k]))
      )
        complete++;
    }
  }
  return present('quarantine_manifest', [{ file: first, line: 1 }], {
    entries,
    complete,
    incomplete: entries - complete,
    valid,
  });
}

// ---------------------------------------------------------------- docs

const ADR_DIR =
  /^(?:docs?\/)?(?:adrs?|decisions?|decision-records?|architecture\/decisions?|architecture\/adrs?)\/[^/]+\.(?:md|markdown|adoc|rst)$/i;

function decisionRecords(reader: TreeReader): Fact {
  const files = reader.files.filter(
    (f) => ADR_DIR.test(f.path) && !/(?:^|\/)readme\.md$/i.test(f.path),
  );
  return simplePresence(reader, 'decision_records', files.slice(0, MAX_EVIDENCE), {
    records: files.length,
  });
}

const RUNBOOK =
  /(?:^|\/)(?:runbooks?|playbooks?|oncall|on-call)\/[^/]+\.(?:md|markdown|adoc|rst|txt)$|(?:^|\/)(?:runbook|playbook|oncall)[\w-]*\.(?:md|markdown|adoc|rst|txt)$|^docs\/operations(?:\.md|\/[^/]+\.md)$/i;

function runbooks(reader: TreeReader): Fact {
  const files = reader.files.filter((f) => RUNBOOK.test(f.path) && !isVendored(f.path));
  return simplePresence(reader, 'runbooks', files.slice(0, MAX_EVIDENCE), { files: files.length });
}

// ---------------------------------------------------------------- CI that runs `check`

/** A run command that is the repo's "am I done?" command (OB §3.3 task contract: `check`). */
const CHECK_COMMAND =
  /(?:^|[\s;&|(])(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?check\b|make\s+(?:[\w-]+\s+)*check\b|just\s+check\b|(?:\.\/)?gradlew?\s+(?:[\w:-]+\s+)*check\b|tox\b|nox\b|poetry\s+run\s+check\b)/;

const OTHER_CI = [
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
  '.travis.yml',
  'bitbucket-pipelines.yml',
];

async function ciCheck(reader: TreeReader, c: Collector): Promise<Fact> {
  const { workflows, unanalysed } = await loadWorkflows(reader, c);
  const otherFiles = OTHER_CI.map((p) => reader.get(p)).filter(
    (f): f is TreeFile => f !== undefined,
  );
  const ciFiles = workflows.length + unanalysed + otherFiles.length;
  let hit: { file: TreeFile; line: number } | null = null;
  for (const w of workflows) {
    for (const { job } of w.jobs) {
      const steps = Array.isArray(job['steps']) ? (job['steps'] as unknown[]) : [];
      const runs = [...steps.map((s) => (isObj(s) ? s['run'] : undefined)), job['run']].filter(
        (r): r is string => typeof r === 'string',
      );
      for (const r of runs) {
        const m = CHECK_COMMAND.exec(r);
        if (m && !hit) hit = { file: w.file, line: lineOfText(w.text, m[0].trim()) };
      }
    }
  }
  for (const f of otherFiles) {
    if (hit) break;
    const got = await c.text(f.path, 512 * 1024);
    if (!got) continue;
    const m = CHECK_COMMAND.exec(got.text);
    if (m) hit = { file: f, line: lineOfText(got.text, m[0].trim()) };
  }
  const detail = {
    ci_files: ciFiles,
    workflows: workflows.length,
    unanalysed,
    runs_check: hit !== null,
  };
  if (hit) return present('ci_check', [hit], detail);
  const any =
    workflows[0]?.file ??
    otherFiles[0] ??
    reader.files.find((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f.path));
  return ciFiles > 0 && any
    ? present('ci_check', [{ file: any, line: 1 }], detail)
    : absent('ci_check', detail);
}

// ---------------------------------------------------------------- tool configs

interface ManifestDoc {
  readonly file: TreeFile;
  readonly json: Record<string, unknown> | null;
  readonly toml: Record<string, unknown> | null;
  readonly text: string;
}

async function loadManifestDocs(reader: TreeReader, c: Collector): Promise<ManifestDoc[]> {
  const { manifests } = findManifests(reader);
  const wanted = manifests
    .filter((m) =>
      /^(?:package\.json|pyproject\.toml|setup\.cfg|go\.mod)$/.test(basename(m.file.path)),
    )
    .slice(0, MAX_CONFIG_READS);
  const out: ManifestDoc[] = [];
  for (const m of wanted) {
    const got = await c.text(m.file.path, 4 * 1024 * 1024);
    if (!got) continue;
    const name = basename(m.file.path);
    let json: Record<string, unknown> | null = null;
    let toml: Record<string, unknown> | null = null;
    if (name === 'package.json') {
      const p = parseJson(got.text);
      if (!p.ok) c.unparseable(got.file, p.why);
      else if (isObj(p.value)) json = p.value;
    } else if (name === 'pyproject.toml') {
      const p = parseTomlSafe(got.text);
      if (!p.ok) c.unparseable(got.file, p.why);
      else toml = p.value;
    }
    out.push({ file: got.file, json, toml, text: got.text });
  }
  return out;
}

const tool = (d: ManifestDoc, ...names: string[]): boolean => {
  const t = d.toml?.['tool'];
  return isObj(t) && names.some((n) => n in t);
};

interface ToolSpec {
  readonly item: PresenceItem;
  /** File names (any directory, vendored excluded) that are the tool's own config. */
  readonly files: RegExp;
  readonly jsonKeys: readonly string[];
  readonly pyTools: readonly string[];
  readonly cfgSection?: RegExp;
}

const TOOLS: readonly ToolSpec[] = [
  {
    item: 'formatter_config',
    files:
      /^(?:\.prettierrc(?:\.[\w]+)?|prettier\.config\.[cm]?[jt]s|\.editorconfig|rustfmt\.toml|\.rustfmt\.toml|\.clang-format|biome\.jsonc?|dprint\.json|\.scalafmt\.conf|\.php-cs-fixer(?:\.dist)?\.php|\.stylua\.toml|\.ocamlformat)$/,
    jsonKeys: ['prettier'],
    pyTools: ['black', 'yapf', 'isort', 'ruff'],
  },
  {
    item: 'linter_config',
    files:
      /^(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.[\w]+)?|\.golangci\.ya?ml|ruff\.toml|\.ruff\.toml|\.flake8|\.pylintrc|clippy\.toml|\.clippy\.toml|\.rubocop\.yml|biome\.jsonc?|\.oxlintrc\.json|\.stylelintrc(?:\.[\w]+)?|\.shellcheckrc|\.hlint\.yaml|detekt\.ya?ml|checkstyle\.xml|\.luacheckrc)$/,
    jsonKeys: ['eslintConfig', 'stylelint'],
    pyTools: ['ruff', 'pylint', 'flake8'],
    cfgSection: /^\[(?:flake8|pylint)/m,
  },
  {
    item: 'type_checker_config',
    files:
      /^(?:tsconfig(?:\.[\w-]+)?\.json|jsconfig\.json|mypy\.ini|\.mypy\.ini|pyrightconfig\.json|\.flowconfig|pytype\.cfg|\.pyre_configuration)$/,
    jsonKeys: [],
    pyTools: ['mypy', 'pyright', 'pytype'],
    cfgSection: /^\[mypy/m,
  },
];

function toolConfig(reader: TreeReader, docs: readonly ManifestDoc[], spec: ToolSpec): Fact {
  const hits: Array<{ file: TreeFile; line: number }> = [];
  for (const f of reader.files) {
    if (isVendored(f.path)) continue;
    if (spec.files.test(basename(f.path))) hits.push({ file: f, line: 1 });
  }
  for (const d of docs) {
    const name = basename(d.file.path);
    if (name === 'package.json' && spec.jsonKeys.some((k) => d.json && k in d.json))
      hits.push({
        file: d.file,
        line: lineOfText(d.text, `"${spec.jsonKeys.find((k) => d.json && k in d.json)}"`),
      });
    else if (name === 'pyproject.toml' && tool(d, ...spec.pyTools))
      hits.push({ file: d.file, line: lineOfText(d.text, '[tool.') });
    else if (name === 'setup.cfg' && spec.cfgSection?.test(d.text))
      hits.push({ file: d.file, line: 1 });
  }
  return hits.length > 0 ? present(spec.item, hits, { sources: hits.length }) : absent(spec.item);
}

// ---------------------------------------------------------------- toolchain pin, coverage

const PIN_FILES =
  /^(?:\.nvmrc|\.node-version|\.tool-versions|rust-toolchain(?:\.toml)?|\.python-version|\.ruby-version|\.java-version|\.go-version|\.bun-version|\.sdkmanrc|mise\.toml|\.mise\.toml|global\.json|\.terraform-version|\.swift-version)$/;

function toolchainPin(reader: TreeReader, docs: readonly ManifestDoc[]): Fact {
  const hits: Array<{ file: TreeFile; line: number }> = [];
  for (const f of reader.files) {
    if (!isVendored(f.path) && PIN_FILES.test(basename(f.path))) hits.push({ file: f, line: 1 });
  }
  for (const d of docs) {
    const name = basename(d.file.path);
    if (name === 'go.mod' && /^go\s+\d/m.test(d.text))
      hits.push({ file: d.file, line: lineOfText(d.text, 'go ') });
    if (name === 'package.json' && d.json) {
      const engines = d.json['engines'];
      if (isObj(engines) && typeof engines['node'] === 'string')
        hits.push({ file: d.file, line: lineOfText(d.text, '"engines"') });
      else if (isObj(d.json['volta']))
        hits.push({ file: d.file, line: lineOfText(d.text, '"volta"') });
    }
  }
  return hits.length > 0
    ? present('toolchain_pin', hits, { pins: hits.length })
    : absent('toolchain_pin');
}

const COVERAGE_FILES =
  /^(?:\.coveragerc|\.nycrc(?:\.[\w]+)?|\.c8rc(?:\.[\w]+)?|codecov\.ya?ml|\.codecov\.ya?ml|tarpaulin\.toml|\.simplecov|jacoco\.xml)$/;
const COVERAGE_JS_CONFIG =
  /^(?:vitest|jest|vite|karma)\.(?:config\.)?[\w.]*\.?[cm]?[jt]s$|^(?:vitest|jest|vite)\.config\.[cm]?[jt]s$/;
const COVERAGE_DEPS =
  /^(?:c8|nyc|istanbul|@vitest\/coverage-[\w-]+|coverage|pytest-cov|jest-coverage)/;

async function coverageConfig(
  reader: TreeReader,
  c: Collector,
  docs: readonly ManifestDoc[],
): Promise<Fact> {
  const hits: Array<{ file: TreeFile; line: number }> = [];
  for (const f of reader.files) {
    if (isVendored(f.path)) continue;
    const n = basename(f.path);
    if (COVERAGE_FILES.test(n)) hits.push({ file: f, line: 1 });
    else if (COVERAGE_JS_CONFIG.test(n) && hits.length < 20) {
      const got = await c.text(f.path, 256 * 1024);
      if (got && /\bcoverage\b/.test(got.text))
        hits.push({ file: f, line: lineOfText(got.text, 'coverage') });
    }
  }
  for (const d of docs) {
    const name = basename(d.file.path);
    if (name === 'package.json' && d.json) {
      const scripts = isObj(d.json['scripts']) ? Object.values(d.json['scripts']) : [];
      const deps = ['dependencies', 'devDependencies']
        .map((k) => d.json?.[k])
        .filter(isObj)
        .flatMap((o) => Object.keys(o));
      if (
        scripts.some((s) => typeof s === 'string' && /--coverage\b|\b(?:c8|nyc)\b/.test(s)) ||
        deps.some((x) => COVERAGE_DEPS.test(x))
      )
        hits.push({ file: d.file, line: lineOfText(d.text, 'coverage') });
    } else if (name === 'pyproject.toml' && tool(d, 'coverage')) {
      hits.push({ file: d.file, line: lineOfText(d.text, '[tool.coverage') });
    }
  }
  return hits.length > 0
    ? present('coverage_config', hits, { sources: hits.length })
    : absent('coverage_config');
}

// ---------------------------------------------------------------- the detector

export function presenceDetector(opts: PresenceOptions = {}): Detector {
  return {
    info: {
      id: 'presence',
      version: '1',
      criteria: [
        'RS-KN-1',
        'RS-KN-6',
        'RS-OP-3',
        'RS-PUB-1',
        'RS-PUB-2',
        'RS-PUB-4',
        'RS-PUB-5',
        'RS-EN-2',
        'RS-EN-3',
        'RS-ST-1',
        'RS-ST-2',
        'RS-ST-3',
        'RS-ST-5',
        'RS-BT-4',
        'RS-BT-8',
        'RS-TH-3',
        'RS-TH-4',
        'RS-TH-5',
      ],
    },
    async run(reader: TreeReader) {
      const c = new Collector('presence', reader);
      const docs = await loadManifestDocs(reader, c);
      const rules = opts.secretRules ?? RULES;
      c.add(await readme(reader, c));
      c.add(licenseFact(reader));
      c.add(await securityPolicy(reader, c));
      c.add(
        simplePresence(
          reader,
          'contributing',
          communityFiles(reader, /^contributing(?:\.(?:md|rst|txt))?$/i),
        ),
      );
      c.add(prTemplate(reader));
      c.add(await dependencyUpdates(reader, c));
      c.add(await envExample(reader, c, rules));
      c.add(await repoShape(reader, c));
      c.add(await generatedPaths(reader, c));
      c.add(await skipInventory(reader, c));
      c.add(await quarantine(reader, c));
      c.add(decisionRecords(reader));
      c.add(runbooks(reader));
      c.add(await ciCheck(reader, c));
      for (const spec of TOOLS) c.add(toolConfig(reader, docs, spec));
      c.add(toolchainPin(reader, docs));
      c.add(await coverageConfig(reader, c, docs));
      return c.output();
    },
  };
}
