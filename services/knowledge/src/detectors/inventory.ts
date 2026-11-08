import {
  AGENTS_CHAIN_LIMIT_BYTES,
  AGENTS_NESTED_MAX_LINES,
  AGENTS_ROOT_MAX_LINES,
  MAX_INVENTORY_FILES,
  type Fact,
  type InventoryKind,
} from '@aisdlc/contracts';
import { ancestry, isVendored } from './paths.js';
import { parseJson, parseJsonc, parseYamlSafe } from './safe-parse.js';
import {
  Collector,
  basename,
  dirname,
  type Detector,
  type TreeFile,
  type TreeReader,
} from './types.js';

// Instruction and harness inventory (PLAN M6.3; RS-AI-7, LF4; OB §4.1 items 1 and 8, §6.2 0.1).
// Lists every instruction file and harness or auto-run config in the head tree as DATA with a state
// (`absent` or `data`). Nothing in it is ever loaded as guidance, quoted, or affirmed: facts carry
// paths, sizes, line counts and flags. Config files are parsed (safe parsers) only to say whether
// they run code on their own: hooks, lifecycle commands, `runOn: folderOpen`, stdio MCP servers.

type AutoRun = 'yes' | 'no' | 'unknown' | 'not_applicable';
type Detail = Record<string, string | number | boolean | null>;

interface Group {
  readonly kind: InventoryKind;
  readonly match: (path: string) => boolean;
}

const rx =
  (re: RegExp) =>
  (p: string): boolean =>
    re.test(p);

const GROUPS: readonly Group[] = [
  { kind: 'agents_md', match: rx(/(?:^|\/)AGENTS(?:\.override)?\.md$/) },
  { kind: 'claude_md', match: rx(/(?:^|\/)CLAUDE(?:\.local)?\.md$/) },
  { kind: 'claude_dir', match: rx(/(?:^|\/)\.claude\//) },
  { kind: 'mcp_json', match: rx(/(?:^|\/)\.mcp\.json$|(?:^|\/)\.vscode\/mcp\.json$/) },
  { kind: 'cursor', match: rx(/(?:^|\/)\.cursor\/|(?:^|\/)\.cursorrules$/) },
  {
    kind: 'copilot_instructions',
    match: rx(
      /^\.github\/(?:copilot-instructions\.md|instructions\/|prompts\/|agents\/|chatmodes\/|workflows\/copilot-setup-steps\.ya?ml$)/,
    ),
  },
  { kind: 'windsurf', match: rx(/(?:^|\/)\.windsurfrules$|(?:^|\/)\.windsurf\//) },
  { kind: 'gemini', match: rx(/(?:^|\/)GEMINI\.md$|(?:^|\/)\.gemini\//) },
  { kind: 'aider', match: rx(/(?:^|\/)\.aider[\w.-]*$/) },
  { kind: 'continue', match: rx(/(?:^|\/)\.continue\//) },
  {
    kind: 'git_hooks',
    match: rx(
      /(?:^|\/)\.husky\/(?!_\/)|(?:^|\/)\.githooks\/|(?:^|\/)\.git-hooks\/|(?:^|\/)\.?lefthook(?:-local)?\.ya?ml$|(?:^|\/)\.simple-git-hooks\.(?:json|js|cjs)$/,
    ),
  },
  { kind: 'pre_commit_config', match: rx(/(?:^|\/)\.pre-commit-config\.ya?ml$/) },
  { kind: 'devcontainer', match: rx(/(?:^|\/)\.devcontainer\/|(?:^|\/)\.devcontainer\.json$/) },
  { kind: 'vscode_tasks', match: rx(/(?:^|\/)\.vscode\/tasks\.json$/) },
  { kind: 'direnv', match: rx(/(?:^|\/)\.envrc$/) },
];

const TEXT_KINDS = new Set<InventoryKind>(['agents_md', 'claude_md']);
const MAX_LINE_COUNT_READS = 200;
const READ_LIMIT = 1024 * 1024;

const countLines = (t: string): number =>
  t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);
const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

export function inventoryDetector(): Detector {
  return {
    info: { id: 'inventory', version: '1', criteria: ['RS-AI-1', 'RS-AI-5', 'RS-AI-6', 'RS-AI-7'] },
    async run(reader: TreeReader) {
      const c = new Collector('inventory', reader);
      const byKind = new Map<InventoryKind, TreeFile[]>();
      for (const f of reader.files) {
        if (isVendored(f.path)) continue;
        for (const g of GROUPS)
          if (g.match(f.path)) byKind.set(g.kind, [...(byKind.get(g.kind) ?? []), f]);
      }
      // npm lifecycle scripts and git-hook keys live inside package.json.
      const pkg = reader.get('package.json');
      let installScripts: TreeFile | null = null;
      let hookKeys = false;
      if (pkg) {
        const t = await c.text('package.json', 4 * 1024 * 1024);
        if (t) {
          const p = parseJson(t.text);
          if (!p.ok) c.unparseable(t.file, p.why);
          else if (isObj(p.value)) {
            const s = isObj(p.value['scripts']) ? p.value['scripts'] : {};
            if (['preinstall', 'install', 'postinstall', 'prepare'].some((k) => k in s))
              installScripts = t.file;
            if ('husky' in p.value || 'simple-git-hooks' in p.value) hookKeys = true;
          }
        }
      }

      let counted = 0;
      const emit = async (kind: InventoryKind, files: readonly TreeFile[]): Promise<void> => {
        const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1));
        const listed: Array<{
          path: string;
          blob: TreeFile['blob'];
          bytes: number;
          lines: number | null;
        }> = [];
        const texts = new Map<string, string | { symlink: string }>();
        for (const f of sorted.slice(0, MAX_INVENTORY_FILES)) {
          let lines: number | null = null;
          if (TEXT_KINDS.has(kind) && counted < MAX_LINE_COUNT_READS) {
            counted++;
            const r = await reader.readText(f.path, READ_LIMIT);
            if (r.state === 'ok') {
              lines = countLines(r.text);
              texts.set(f.path, r.text);
            } else if (r.state === 'symlink') texts.set(f.path, { symlink: r.target.trim() });
            else if (r.state === 'too_large')
              c.cover({
                kind: 'parse_limit',
                path: f.path,
                object: f.blob,
                reason: `inventory: ${f.size} bytes is over the ${READ_LIMIT}-byte limit: lines not counted`,
              });
            else if (r.state === 'unreadable')
              c.cover({
                kind: 'unreadable_object',
                path: f.path,
                object: f.blob,
                reason: 'inventory: git could not read this object',
              });
          }
          listed.push({ path: f.path, blob: f.blob, bytes: f.size, lines });
        }
        const { autoRun, detail } = await classify(
          reader,
          c,
          kind,
          sorted,
          texts,
          installScripts,
          hookKeys,
        );
        const first = sorted[0];
        const fact: Fact = {
          kind: 'instruction_file',
          detector: 'inventory',
          inventory: kind,
          state: sorted.length === 0 ? 'absent' : 'data',
          file_count: sorted.length,
          files: listed,
          auto_run: sorted.length === 0 ? 'not_applicable' : autoRun,
          detail,
          evidence: first ? [c.evidence(first)] : [],
        };
        c.add(fact);
      };

      for (const g of GROUPS) {
        let files = byKind.get(g.kind) ?? [];
        if (g.kind === 'git_hooks' && hookKeys && pkg) files = [...files, pkg];
        await emit(g.kind, files);
      }
      await emit('install_scripts', installScripts ? [installScripts] : []);
      return c.output();
    },
  };
}

async function classify(
  reader: TreeReader,
  c: Collector,
  kind: InventoryKind,
  files: readonly TreeFile[],
  texts: Map<string, string | { symlink: string }>,
  installScripts: TreeFile | null,
  hookKeys: boolean,
): Promise<{ autoRun: AutoRun; detail: Detail }> {
  switch (kind) {
    case 'agents_md': {
      const sizes = new Map(files.map((f) => [dirname(f.path), 0]));
      for (const f of files) sizes.set(dirname(f.path), (sizes.get(dirname(f.path)) ?? 0) + f.size);
      // The chain an agent working in directory D reads: every AGENTS.md from the root down to D.
      let maxChain = 0;
      for (const dir of sizes.keys()) {
        let total = 0;
        for (const a of ancestry(dir)) total += sizes.get(a) ?? 0;
        maxChain = Math.max(maxChain, total);
      }
      const root = files.find((f) => f.path === 'AGENTS.md');
      const rootText = root ? texts.get(root.path) : undefined;
      const nested = files.filter((f) => f.path !== 'AGENTS.md');
      const nestedLong = nested.filter((f) => {
        const t = texts.get(f.path);
        return typeof t === 'string' && countLines(t) > AGENTS_NESTED_MAX_LINES;
      }).length;
      return {
        autoRun: 'not_applicable',
        detail: {
          root_present: root !== undefined,
          root_lines: typeof rootText === 'string' ? countLines(rootText) : null,
          root_over_limit:
            typeof rootText === 'string' ? countLines(rootText) > AGENTS_ROOT_MAX_LINES : null,
          nested_count: nested.length,
          nested_over_limit: nestedLong,
          max_chain_bytes: maxChain,
          chain_limit_bytes: AGENTS_CHAIN_LIMIT_BYTES,
          chain_over_limit: maxChain > AGENTS_CHAIN_LIMIT_BYTES,
        },
      };
    }
    case 'claude_md': {
      const isStub = (t: string | { symlink: string } | undefined): boolean | null =>
        t === undefined
          ? null
          : typeof t === 'string'
            ? t.replace(/^\uFEFF/, '').trim() === '@AGENTS.md'
            : /^(?:\.\/)?AGENTS\.md$/.test(t.symlink);
      const stubs = files.map((f) => isStub(texts.get(f.path)));
      const root = files.find((f) => f.path === 'CLAUDE.md');
      return {
        autoRun: 'not_applicable',
        detail: {
          root_present: root !== undefined,
          root_stub: root ? isStub(texts.get(root.path)) : null,
          all_stubs: stubs.length > 0 && stubs.every((s) => s === true),
          nested_count: files.filter((f) => f.path !== 'CLAUDE.md').length,
        },
      };
    }
    case 'claude_dir': {
      const count = (re: RegExp): number => files.filter((f) => re.test(f.path)).length;
      let autoRun: AutoRun = 'no';
      for (const f of files.filter((f) =>
        /(?:^|\/)\.claude\/settings(?:\.local)?\.json$/.test(f.path),
      )) {
        const t = await c.text(f.path, READ_LIMIT);
        if (!t) {
          autoRun = autoRun === 'yes' ? 'yes' : 'unknown';
          continue;
        }
        const p = parseJsonc(t.text);
        if (!p.ok) {
          c.unparseable(f, p.why);
          autoRun = autoRun === 'yes' ? 'yes' : 'unknown';
        } else if (isObj(p.value)) {
          const v = p.value;
          const hooks = isObj(v['hooks']) && Object.keys(v['hooks']).length > 0;
          if (
            hooks ||
            v['enableAllProjectMcpServers'] === true ||
            'apiKeyHelper' in v ||
            'statusLine' in v ||
            'awsAuthRefresh' in v ||
            'awsCredentialExport' in v
          )
            autoRun = 'yes';
        }
      }
      return {
        autoRun,
        detail: {
          settings: count(/\/?settings(?:\.local)?\.json$/),
          commands: count(/(?:^|\/)\.claude\/commands\//),
          agents: count(/(?:^|\/)\.claude\/agents\//),
          skills: count(/(?:^|\/)\.claude\/skills\//),
          hooks_files: count(/(?:^|\/)\.claude\/hooks\//),
        },
      };
    }
    case 'mcp_json':
    case 'cursor':
    case 'gemini':
    case 'continue':
    case 'windsurf':
    case 'aider':
    case 'copilot_instructions': {
      let servers = 0;
      let stdio = 0;
      let autoRun: AutoRun = 'no';
      const configs = files.filter((f) =>
        kind === 'mcp_json' ? true : /(?:^|\/)(?:mcp|settings|hooks)\.json$/.test(f.path),
      );
      for (const f of configs.slice(0, 20)) {
        const t = await c.text(f.path, READ_LIMIT);
        if (!t) {
          autoRun = autoRun === 'yes' ? 'yes' : 'unknown';
          continue;
        }
        const p = parseJsonc(t.text);
        if (!p.ok) {
          c.unparseable(f, p.why);
          autoRun = autoRun === 'yes' ? 'yes' : 'unknown';
          continue;
        }
        if (!isObj(p.value)) continue;
        const reg = p.value['mcpServers'] ?? p.value['servers'];
        if (isObj(reg))
          for (const s of Object.values(reg)) {
            servers++;
            if (isObj(s) && typeof s['command'] === 'string') stdio++;
          }
        if (basename(f.path) === 'hooks.json' || isObj(p.value['hooks'])) autoRun = 'yes';
      }
      if (stdio > 0) autoRun = 'yes';
      if (
        kind === 'copilot_instructions' &&
        files.some((f) => /copilot-setup-steps\.ya?ml$/.test(f.path))
      ) {
        // A workflow the Copilot agent runs to prepare its environment: it executes steps on its own.
        const t =
          reader.get('.github/workflows/copilot-setup-steps.yml') ??
          reader.get('.github/workflows/copilot-setup-steps.yaml');
        const y = t ? await c.text(t.path, 512 * 1024) : null;
        if (y) {
          const p = parseYamlSafe(y.text);
          if (!p.ok) c.unparseable(y.file, p.why);
        }
        autoRun = 'yes';
      }
      return { autoRun, detail: { mcp_servers: servers, mcp_stdio_servers: stdio } };
    }
    case 'git_hooks':
      return {
        autoRun: 'yes',
        detail: { files: files.length, package_json_keys: hookKeys },
      };
    case 'pre_commit_config': {
      const f = files[0];
      const t = f ? await c.text(f.path, READ_LIMIT) : null;
      if (!t) return { autoRun: 'unknown', detail: { local_hooks: null } };
      const y = parseYamlSafe(t.text);
      if (!y.ok) {
        c.unparseable(t.file, y.why);
        return { autoRun: 'unknown', detail: { local_hooks: null } };
      }
      const repos =
        isObj(y.value.value) && Array.isArray(y.value.value['repos'])
          ? (y.value.value['repos'] as unknown[])
          : [];
      const local = repos.filter((r) => isObj(r) && r['repo'] === 'local').length;
      return { autoRun: 'yes', detail: { repos: repos.length, local_hooks: local } };
    }
    case 'devcontainer': {
      const LIFECYCLE = [
        'initializeCommand',
        'onCreateCommand',
        'updateContentCommand',
        'postCreateCommand',
        'postStartCommand',
        'postAttachCommand',
      ];
      let autoRun: AutoRun = 'no';
      let lifecycle = 0;
      for (const f of files.filter((f) => /devcontainer\.json$/.test(f.path))) {
        const t = await c.text(f.path, READ_LIMIT);
        if (!t) {
          autoRun = autoRun === 'yes' ? 'yes' : 'unknown';
          continue;
        }
        const p = parseJsonc(t.text);
        if (!p.ok) {
          c.unparseable(f, p.why);
          autoRun = autoRun === 'yes' ? 'yes' : 'unknown';
        } else if (isObj(p.value)) {
          const n = LIFECYCLE.filter((k) => k in (p.value as Record<string, unknown>)).length;
          lifecycle += n;
          if (n > 0) autoRun = 'yes';
        }
      }
      return { autoRun, detail: { lifecycle_commands: lifecycle } };
    }
    case 'vscode_tasks': {
      const f = files[0];
      const t = f ? await c.text(f.path, READ_LIMIT) : null;
      if (!t) return { autoRun: 'unknown', detail: { folder_open_tasks: null } };
      const p = parseJsonc(t.text);
      if (!p.ok) {
        c.unparseable(t.file, p.why);
        return { autoRun: 'unknown', detail: { folder_open_tasks: null } };
      }
      const tasks =
        isObj(p.value) && Array.isArray(p.value['tasks']) ? (p.value['tasks'] as unknown[]) : [];
      const open = tasks.filter(
        (x) => isObj(x) && isObj(x['runOptions']) && x['runOptions']['runOn'] === 'folderOpen',
      ).length;
      return {
        autoRun: open > 0 ? 'yes' : 'no',
        detail: { tasks: tasks.length, folder_open_tasks: open },
      };
    }
    case 'direnv':
      return { autoRun: 'yes', detail: {} };
    case 'install_scripts':
      return { autoRun: installScripts ? 'yes' : 'not_applicable', detail: {} };
  }
}
