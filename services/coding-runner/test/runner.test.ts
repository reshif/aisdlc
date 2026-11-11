import {
  CODING_RESULT_FILE,
  CODING_SESSION_DIR,
  CODING_TASK_FILE,
  CodingSessionResult,
  type CodingTask,
} from '@aisdlc/contracts';
import type { RepoFile } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable, startRig, type Rig } from './rig.js';

const docker = dockerAvailable();
if (!docker.ok) console.warn(`coding-runner tests SKIPPED: ${docker.why}`);
const KEY = `aisk_${'0123456789abcdef'.repeat(3)}`;

let rig: Rig;
beforeAll(async () => {
  if (docker.ok) rig = await startRig({ apiKey: KEY });
});
afterAll(async () => {
  if (docker.ok) await rig?.teardown();
});

const task = (over: Partial<CodingTask> = {}): CodingTask => ({
  schema: 'coding-task/1',
  model: 'claude-sonnet-5-5',
  system_prompt: 'You are the factory coder. Context follows.',
  prompt: 'Create src/hello.js that exports a function hello.',
  allowed_tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
  max_turns: 8,
  approved_classes: [],
  time_s: 120,
  policy: {
    protected_globs: ['CLAUDE.md', '.mcp.json', '.claude/**', '.github/**'],
    sensitive_globs: [],
    locked_paths: ['test/oracle.test.js'],
    scope_globs: [],
    diff_budget: { max_files: 20, max_lines: 500 },
  },
  ...over,
});

const repoFiles = (t: CodingTask, extra: RepoFile[] = []): RepoFile[] => [
  { path: 'src/index.js', content: 'exports.add = (a, b) => a - b;\n' },
  { path: 'test/oracle.test.js', content: "require('node:test')('x', () => {});\n" },
  ...extra,
  { path: `${CODING_SESSION_DIR}/${CODING_TASK_FILE}`, content: JSON.stringify(t) },
];

describe.skipIf(!docker.ok)('the coding runner in a real W sandbox', () => {
  it('runs a scripted session: a tool call, a file written, a result and the changed files come back', async () => {
    rig.model.reply(
      {
        tool_uses: [
          {
            name: 'Write',
            input: {
              file_path: '/work/repo/src/hello.js',
              content: 'exports.hello = () => "hi";\n',
            },
          },
        ],
      },
      {
        text: '{"kind":"implementation","status":"completed","summary":"done","files_changed":[],"checks_run":[]}',
      },
    );
    const t = task();
    const r = await rig.driver().run({
      session_id: 'runner-smoke-01',
      class: 'W',
      command: ['node', '/opt/agent/runner.js'],
      repo: repoFiles(t),
      gateway_key: KEY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const res = r.value;
    expect(res.status, `${res.stderr.slice(0, 500)} ${res.stdout.slice(0, 500)}`).toBe('exited');
    const file = res.out.find((f) => f.path === CODING_RESULT_FILE);
    expect(file).toBeDefined();
    const parsed = CodingSessionResult.parse(
      JSON.parse(Buffer.from(file?.content ?? '').toString()),
    );
    expect(parsed, JSON.stringify(parsed)).toMatchObject({
      status: 'finished',
      key_on_disk: false,
      setting_sources: [],
    });
    expect(parsed.changed.map((c) => c.path)).toEqual(['src/hello.js']);
    expect(parsed.final_text).toContain('"status":"completed"');
  });

  it('without the Unit key it starts nothing and says so (the empty key scrubs nothing)', async () => {
    const r = await rig.driver().run({
      session_id: 'runner-nokey-01',
      class: 'K-exec',
      command: ['node', '/opt/agent/runner.js'],
      repo: repoFiles(task()),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const file = r.value.out.find((f) => f.path === CODING_RESULT_FILE);
    const parsed = CodingSessionResult.parse(
      JSON.parse(Buffer.from(file?.content ?? '').toString()),
    );
    expect(parsed).toMatchObject({
      status: 'error',
      error: 'no gateway key in the environment',
      changed: [],
    });
  });
});
