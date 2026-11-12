import { z } from 'zod';
import { Sha256Hex } from './ids.js';

// The wire between the factory and the coding session in the sandbox (PLAN M13.4). The factory writes a
// `CodingTask` into the repo copy under `.aisdlc-session/` and reads a `CodingSessionResult` and the changed
// files back from `/out`. Everything in the result is the word of the code that ran (the sandbox is untrusted):
// the factory validates it, bounds it and checks it again against the tree (`evaluateTree`), never the other way.

/** Where the factory puts the task in the repo copy; the runner moves it out of the repo before anything runs. */
export const CODING_SESSION_DIR = '.aisdlc-session';
export const CODING_TASK_FILE = 'task.json';
export const CODING_RESULT_FILE = 'session.json';
export const CODING_BLOB_DIR = 'blobs';
/** Where the runner bundle and the agent SDK's binary are in the W image. */
export const CODING_RUNNER_PATH = '/opt/agent/runner.js';

export const TripwirePolicyWire = z.strictObject({
  protected_globs: z.array(z.string().min(1).max(300)).max(200),
  sensitive_globs: z.array(z.string().min(1).max(300)).max(200),
  locked_paths: z.array(z.string().min(1).max(500)).max(500),
  scope_globs: z.array(z.string().min(1).max(300)).max(200),
  diff_budget: z.strictObject({
    max_files: z.number().int().min(1).max(100_000),
    max_lines: z.number().int().min(1).max(10_000_000),
  }),
});
export type TripwirePolicyWire = z.infer<typeof TripwirePolicyWire>;

export const CodingTask = z.strictObject({
  schema: z.literal('coding-task/1'),
  /** The factory's model id, as the gateway's routes know it. */
  model: z.string().min(1).max(100),
  /** The affirmed context (`buildContext`) and the coder's role text. Control and fenced data, never the repo's own files. */
  system_prompt: z.string().min(1).max(600_000),
  /** The task: what to build, what failed last time, which oracles must turn green. */
  prompt: z.string().min(1).max(200_000),
  /** SDK tool names: exactly the coder contract's allow-list. */
  allowed_tools: z.array(z.string().min(1).max(40)).min(1).max(16),
  max_turns: z.number().int().min(1).max(500),
  time_s: z.number().int().min(10).max(14_400),
  policy: TripwirePolicyWire,
  /** Gates a person already approved for this task (X1: an irreversible operation, X3: a new dependency): the session does not stop for them again. */
  approved_classes: z
    .array(z.enum(['gate_x1', 'gate_x3']))
    .max(2)
    .default([]),
});
export type CodingTask = z.infer<typeof CodingTask>;

export const SessionTripwire = z.strictObject({
  kind: z.enum([
    'locked_test_edit',
    'protected_path_write',
    'secret_access',
    'credential_hunting',
    'stub_test',
    'irreversible_operation',
    'new_dependency',
    'locked_test_change_request',
    'diff_over_lane_budget',
    'sensitive_path',
    'scope_drift',
  ]),
  class: z.enum(['quarantine', 'gate_x1', 'gate_x3', 'gate_e6', 'relane_r1', 'scope']),
  detail: z.string().max(300),
  path: z.string().max(300).optional(),
  /**
   * P1-8: the Bash command line that raised it (an X1 or X3 stop), at most 500 characters. The agent's own text:
   * data, never instructions; the factory masks secrets in it before it reaches the record (`GateNeededDetail`).
   */
  command: z.string().max(500).optional(),
});
export type SessionTripwire = z.infer<typeof SessionTripwire>;

export const SessionChange = z.strictObject({
  path: z.string().min(1).max(1024),
  sha256: Sha256Hex,
  size: z.number().int().min(0),
  exec: z.boolean(),
});

export const CodingSessionResult = z.strictObject({
  schema: z.literal('coding-session/1'),
  /** `finished`: the agent said it was done; `tripwire`: stopped by one; `timeout`; `budget` (the gateway refused for spend); `error`. */
  status: z.enum(['finished', 'tripwire', 'timeout', 'budget', 'error']),
  tripwire: SessionTripwire.nullable(),
  /** The agent's last message (it should be one `implementation.v1` JSON object). Untrusted text. */
  final_text: z.string().max(60_000),
  turns: z.number().int().min(0),
  usage: z.strictObject({
    input_tokens: z.number().int().min(0),
    output_tokens: z.number().int().min(0),
  }),
  tool_events: z
    .array(
      z.strictObject({
        tool: z.string().max(60),
        summary: z.string().max(240),
        verdict: z.enum(['allowed', 'denied']),
      }),
    )
    .max(2000),
  /** Harness files the repo carries (CLAUDE.md, AGENTS.md, `.claude/`, `.mcp.json`, hooks): present, NOT loaded. */
  ignored_harness: z.array(z.string().max(300)).max(200),
  /** What the agent harness was told to load from the filesystem. Always empty (LF4). */
  setting_sources: z.array(z.string()).max(0),
  /** The runner looked for its own gateway key in /work and /out at the end. `true` is a fatal finding. */
  key_on_disk: z.boolean(),
  error: z.string().max(400).nullable(),
  changed: z.array(SessionChange).max(20_000),
  deleted: z.array(z.string().max(1024)).max(20_000),
  /** Files too large or too many to carry back: the factory treats the session as void. */
  changes_truncated: z.boolean(),
});
export type CodingSessionResult = z.infer<typeof CodingSessionResult>;

/** Harness files a repository may carry that the agent harness would load by default: the isolation test plants them. */
export const HARNESS_FILE_PATTERNS: readonly string[] = [
  'CLAUDE.md',
  '**/CLAUDE.md',
  'AGENTS.md',
  '**/AGENTS.md',
  '.claude/**',
  '.mcp.json',
  '**/.mcp.json',
  '.cursor/**',
  '.codex/**',
  '.github/copilot-instructions.md',
];
