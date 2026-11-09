import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '@aisdlc/kernel';
import type { RepoFile } from '@aisdlc/ports';
import type { StageOutcome } from '@aisdlc/contracts';
import type { TreeManifest } from '@aisdlc/tripwires';

// The session store (PLAN M13.4): what the factory keeps of a coding session between stage commands. A session is
// not a container (a container lives for one run); it is a WORKSPACE (a tree of files, content-addressed), the
// locks on the oracle tests, what was tried, and the snapshots HUMAN-WAIT takes. Everything is a file under one
// scratch root, written atomically; blobs and trees are named by their sha256, so a snapshot is a hash and
// "restore" is reading it back. It is a scratch store: nothing in it is authoritative (the record is), and
// everything in it is derived from sessions the sandbox produced, so every file is treated as untrusted data.

export const sha256 = (b: Uint8Array | string): string =>
  createHash('sha256').update(b).digest('hex');

export interface SessionRound {
  readonly round: number;
  readonly task_id: string;
  readonly tree_sha256: string;
  /** Failing test names (or `exit N`) after the round's self-check; empty when green. */
  readonly failing: readonly string[];
  readonly note: string;
}

export interface SessionState {
  readonly item_id: string;
  readonly repo: string;
  readonly unit_key: string;
  readonly base_sha: string;
  /** Bumped by a cold rebuild (SECT false positive): a new session, a new id. */
  generation: number;
  /** The base tree (the repo at `base_sha`) and the workspace now, as tree hashes. */
  base_tree_sha256: string;
  tree_sha256: string;
  /** The oracle tests the factory locked at 6.3: path to sha256. An edit of one is misbehaviour. */
  locks: Record<string, string>;
  oracle_ids: string[];
  /** Index of the next task of the Unit's task plan to give the agent (6.4). */
  task_idx: number;
  /** What the agent was asked and what came of it, oldest first (the Handoff Pack's "what was tried"). */
  rounds: SessionRound[];
  /** The self-check's failing sets, oldest first: ET11 looks for A, B, A. */
  failing_history: string[][];
  /** B8 and B7 counters the port keeps for its own signals (the engine counts the edges). */
  scope_drifts: number;
  started_ms: number;
  tainted: boolean;
  /** A tripwire stopped a session at 6.4 and left this gate for a person: set until the gate's approval re-runs the task. */
  pending_gate: 'X1' | 'X3' | 'E6' | 'G3o' | null;
  /** Gates approved and the task they were approved for. */
  approved_classes: Array<'gate_x1' | 'gate_x3'>;
  /** Harness files the repo carries: listed as ignored. */
  ignored_harness: string[];
  /** The last snapshot kept for this session. */
  snapshot_ref: string | null;
  /** Prompt-side notes for the next agent run (a denied gate, the failing tests). */
  feedback: string[];
  fix_round: number;
  stage:
    | 'provisioned'
    | 'baselined'
    | 'oracles_red'
    | 'building'
    | 'built'
    | 'checked'
    | 'pushed'
    | 'spiked';
  /** M13.6: the lease epoch the session ran under (the writer's epoch the Push Broker checks). */
  lease_epoch?: number;
  /** M13.6: what the agent said it did, per task (untrusted text, short): the spike report's findings. */
  notes?: string[];
  /** M13.6: the head the last push left on the Unit's branch (the next push must fast-forward from it), and its PR. */
  pushed?: { head_sha: string; pr_number: number; patch_hash: string } | null;
}

export class SessionStore {
  constructor(private readonly root: string) {
    for (const d of ['blobs', 'trees', 'sessions', 'snapshots', 'commands', 'packs']) {
      mkdirSync(join(root, d), { recursive: true });
    }
  }

  private write(path: string, data: string | Uint8Array): void {
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`;
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  }

  putBlob(bytes: Uint8Array | string): string {
    const buf = typeof bytes === 'string' ? Buffer.from(bytes) : Buffer.from(bytes);
    const h = sha256(buf);
    const p = join(this.root, 'blobs', h);
    if (!existsSync(p)) this.write(p, buf);
    return h;
  }

  getBlob(h: string): Buffer {
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error('not a blob hash');
    const b = readFileSync(join(this.root, 'blobs', h));
    if (sha256(b) !== h) throw new Error(`blob ${h} does not match its hash`);
    return b;
  }

  hasBlob(h: string): boolean {
    return /^[0-9a-f]{64}$/.test(h) && existsSync(join(this.root, 'blobs', h));
  }

  putTree(m: TreeManifest): string {
    const text = canonicalJson(m as never);
    const h = sha256(text);
    const p = join(this.root, 'trees', `${h}.json`);
    if (!existsSync(p)) this.write(p, text);
    return h;
  }

  getTree(h: string): TreeManifest {
    const text = readFileSync(join(this.root, 'trees', `${h}.json`), 'utf8');
    if (sha256(text) !== h) throw new Error(`tree ${h} does not match its hash`);
    return JSON.parse(text) as TreeManifest;
  }

  /** Stores a repo copy (blobs and tree) and answers its tree hash. */
  putFiles(files: readonly RepoFile[]): string {
    const m: Record<string, { sha256: string; size: number; exec: boolean }> = {};
    for (const f of files) {
      const buf = typeof f.content === 'string' ? Buffer.from(f.content) : Buffer.from(f.content);
      m[f.path] = { sha256: this.putBlob(buf), size: buf.length, exec: f.executable === true };
    }
    return this.putTree(m);
  }

  /** The tree as files a sandbox is given (`repo`). */
  filesOf(treeSha: string): RepoFile[] {
    const m = this.getTree(treeSha);
    return Object.entries(m)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, e]) => ({ path, content: this.getBlob(e.sha256), executable: e.exec }));
  }

  textOf(treeSha: string, path: string): string | null {
    const e = this.getTree(treeSha)[path];
    return e === undefined ? null : this.getBlob(e.sha256).toString('utf8');
  }

  // ---- sessions

  private sessionPath(item: string): string {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(item)) throw new Error('bad item id');
    return join(this.root, 'sessions', `${item}.json`);
  }

  load(item: string): SessionState | null {
    const p = this.sessionPath(item);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as SessionState) : null;
  }

  save(s: SessionState): void {
    this.write(this.sessionPath(s.item_id), JSON.stringify(s));
  }

  discard(item: string): void {
    rmSync(this.sessionPath(item), { force: true });
  }

  // ---- idempotency: the outcome of a command is kept, and a second delivery gets the same answer

  outcomeOf(commandKey: string): StageOutcome | null {
    const p = join(this.root, 'commands', `${sha256(commandKey)}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as StageOutcome) : null;
  }

  keepOutcome(commandKey: string, o: StageOutcome): void {
    this.write(join(this.root, 'commands', `${sha256(commandKey)}.json`), JSON.stringify(o));
  }

  // ---- snapshots (HUMAN-WAIT, Q1): a manifest that names a tree; the tree's blobs are kept as they are

  snapshot(s: SessionState, why: Record<string, unknown>): string {
    const body = {
      item_id: s.item_id,
      unit_key: s.unit_key,
      generation: s.generation,
      tree_sha256: s.tree_sha256,
      locks: s.locks,
      why,
    };
    const ref = `snap:${sha256(canonicalJson(body as never)).slice(0, 32)}`;
    const p = join(this.root, 'snapshots', `${ref.slice(5)}.json`);
    if (!existsSync(p)) this.write(p, JSON.stringify(body));
    return ref;
  }

  readSnapshot(
    ref: string,
  ): { item_id: string; tree_sha256: string; locks: Record<string, string> } | null {
    if (!/^snap:[0-9a-f]{32}$/.test(ref)) return null;
    const p = join(this.root, 'snapshots', `${ref.slice(5)}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as never) : null;
  }

  // ---- packs and other content-addressed records

  putRecord(kind: string, body: unknown): string {
    const text = canonicalJson(body as never);
    const h = sha256(text);
    const p = join(this.root, 'packs', `${kind}-${h}.json`);
    if (!existsSync(p)) this.write(p, text);
    return h;
  }

  getRecord<T>(kind: string, h: string): T | null {
    const p = join(this.root, 'packs', `${kind}-${h}.json`);
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null;
  }

  /** Every blob, tree, snapshot and record file name (a test asserts what a session left). */
  listAll(): string[] {
    return ['blobs', 'trees', 'snapshots', 'packs'].flatMap((d) =>
      readdirSync(join(this.root, d)).map((f) => `${d}/${f}`),
    );
  }
}
