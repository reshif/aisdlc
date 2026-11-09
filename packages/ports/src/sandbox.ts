import {
  CODING_CLASSES,
  CODING_SESSION_CAP,
  SANDBOX_PROFILES,
  SANDBOX_SESSION_ID,
  sandboxEnvViolations,
  type SandboxClass,
  type SandboxLimits,
  type SandboxProfile,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';

// SandboxPort (PLAN M13.2; RV §2 "Sandbox isolation and egress", §3.4; onboarding-roadmap §5.6).
//
// The one way the factory runs anything it does not trust: a repository's tests, a third-party scanner, a
// coding session. A session is a class (the profile in `SANDBOX_PROFILES` is a ceiling), a read-only copy of
// the repository (data, never instructions), a command, and at most a per-Unit gateway virtual key. It comes
// back as an exit status, bounded logs and the files of `/out`, scanned for factory canaries. The container
// never holds a credential, never sees a Docker socket and is gone when `run` returns (success or not).
//
// Everything a sandbox reports about itself (its exit code, its output, its logs) is UNTRUSTED text: it is
// the word of the code that ran. The port bounds it; the caller decides what it is worth.
//
// Adapters: `DockerSandboxDriver` (services/sandbox-driver, through the allow-list socket proxy), the
// micro-VM provider the cloud buys later, and `FakeSandbox` below (deterministic, same rules).

export const SandboxError = taggedError('SandboxError');
export type SandboxError = TaggedError<
  'SandboxError',
  {
    code:
      | 'invalid_spec'
      | 'exec_not_allowed'
      /** B1: an open secret finding for the repo blocks P, W, O, V and K-exec sessions (K is exempt). */
      | 'b1_blocked'
      | 'busy'
      | 'unavailable'
      | 'refused'
      | 'driver_failure';
    message: string;
  }
>;
export const sandboxError = (code: SandboxError['code'], message: string): SandboxError =>
  SandboxError({ code, message });

/** One file of the repository copy (from the knowledge bundle). Symlinks are never part of a copy. */
export interface RepoFile {
  /** Relative, `/`-separated, no `..`, no leading `/`. */
  readonly path: string;
  readonly content: Uint8Array | string;
  readonly executable?: boolean;
}

export interface SandboxSpec {
  /**
   * The repository (`owner/name`) the copy is of. Optional for the port (the driver does not need it); a
   * guarded sandbox (`GuardedSandbox`) refuses a session of a class the allow-list or B1 applies to without it.
   */
  readonly repo_full_name?: string;
  /** Names the container, the network and the scratch directory: `[a-z0-9-]`, 6 to 48 characters. */
  readonly session_id: string;
  readonly class: SandboxClass;
  /** argv. For a class that does not execute repo code, `command[0]` must be a trusted command of the image. */
  readonly command: readonly string[];
  readonly repo: readonly RepoFile[];
  /** Plain, non-secret variables. Credentials are refused by name and by value. */
  readonly env?: Readonly<Record<string, string>>;
  /** The per-Unit (or per-job) gateway virtual key: only for a class whose profile has a key, required there. */
  readonly gateway_key?: string;
  /** Only ever lower than the class's profile. */
  readonly limits?: Partial<SandboxLimits>;
}

export interface OutFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly content: Uint8Array;
}

export interface OutScanFinding {
  readonly path: string;
  readonly rule_id: string;
  readonly line: number;
}

/** The output scan (factory canaries, then the shared secret ruleset), over `/out` AND the logs. Values never leave it. */
export interface OutScan {
  readonly clean: boolean;
  /** A factory-only canary (`AISDLC_CANARY_*`) was found: the sandbox reached something it must not, or tried to smuggle one out. */
  readonly canary: boolean;
  readonly findings: readonly OutScanFinding[];
}

export type SandboxStatus =
  /** The command ran to its own end (any exit code). */
  | 'exited'
  /** The time limit passed; the container was killed. The run is void. */
  | 'timed_out'
  /** The kernel killed the session for memory. The run is void. */
  | 'oom_killed'
  /** `/out` held more than the cap, or the log stream did. The run is void. */
  | 'out_oversized'
  /** Anything else the driver could not account for (no exit marker, killed from outside). The run is void. */
  | 'killed';

export interface SandboxRun {
  readonly session_id: string;
  readonly class: SandboxClass;
  readonly status: SandboxStatus;
  /** Null unless `status` is `exited`. */
  readonly exit_code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly logs_truncated: boolean;
  /** Empty when `quarantined`. */
  readonly out: readonly OutFile[];
  readonly out_scan: OutScan;
  /** A canary was found: `/out` is withheld. */
  readonly quarantined: boolean;
  readonly duration_ms: number;
  /** Why a void run is void (one line, no sandbox text), or null. */
  readonly detail: string | null;
  /** Things the driver could not remove (container, network, scratch). Empty means nothing was left behind. */
  readonly cleanup_errors: readonly string[];
  /** What the session actually got: the class's ceiling lowered by the spec. */
  readonly limits: SandboxLimits;
  /** The network peers the session had (never more than the class allows). */
  readonly peers: readonly string[];
}

export interface SandboxPort {
  /**
   * Runs one session to its end and removes everything it made (container, network, scratch). A refusal
   * (`invalid_spec`, `exec_not_allowed`, `busy`) starts nothing. A sandbox that misbehaves is a `SandboxRun`
   * with a void status, not an error: the caller treats a void run as no evidence.
   */
  run(spec: SandboxSpec): Promise<Result<SandboxRun, SandboxError>>;
}

// ---------------------------------------------------------------------------------------------- shared rules

const MAX_ARGS = 64;
const MAX_ARG_LEN = 4096;
const MAX_ENV = 32;
const MAX_ENV_VALUE = 4096;
export const MAX_REPO_FILES = 50_000;
export const MAX_REPO_BYTES = 512 * 1024 * 1024;
const REPO_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\/\/)[^\0\\]{1,1024}$/;

/** The effective limits: the ceiling lowered by what the spec asked. A request for more is an error, not a clamp. */
export function effectiveLimits(
  profile: SandboxProfile,
  asked: Partial<SandboxLimits> | undefined,
): Result<SandboxLimits, SandboxError> {
  const out: SandboxLimits = { ...profile.limits };
  for (const [k, v] of Object.entries(asked ?? {}) as Array<[keyof SandboxLimits, number]>) {
    if (!(k in out)) return err(sandboxError('invalid_spec', `unknown limit ${String(k)}`));
    if (!Number.isFinite(v) || v <= 0) {
      return err(sandboxError('invalid_spec', `limit ${k} must be a positive number`));
    }
    if (v > out[k]) {
      return err(
        sandboxError(
          'invalid_spec',
          `limit ${k}=${v} is above the ${profile.class} ceiling ${out[k]}`,
        ),
      );
    }
    out[k] = v;
  }
  return ok(out);
}

export interface PreflightOptions {
  /** Commands of the image a class that executes no repo code may run (scanners). */
  readonly trustedCommands?: readonly string[];
}

export interface Preflighted {
  readonly profile: SandboxProfile;
  readonly limits: SandboxLimits;
}

/**
 * Every refusal that needs no container: session id, class rules (a key only where the profile has one and
 * required there; no credential in the environment, by name or by value; no execution of repo code where the
 * profile says so), argv and repo-copy shape, limits that only go down. Shared by the driver and the fake, so
 * a test on the fake is a test of the rule.
 */
export function preflightSpec(
  spec: SandboxSpec,
  opts: PreflightOptions = {},
): Result<Preflighted, SandboxError> {
  const bad = (m: string) => err(sandboxError('invalid_spec', m));
  if (!SANDBOX_SESSION_ID.test(spec.session_id)) {
    return bad(
      'session_id must be 6 to 48 characters of [a-z0-9-], starting with a letter or digit',
    );
  }
  const profile = SANDBOX_PROFILES[spec.class];
  if (profile === undefined) return bad(`unknown sandbox class ${String(spec.class)}`);
  const limits = effectiveLimits(profile, spec.limits);
  if (!limits.ok) return limits;

  if (spec.gateway_key !== undefined) {
    if (!profile.key) return bad(`class ${spec.class} gets no gateway key`);
    if (
      spec.gateway_key.length < 8 ||
      spec.gateway_key.length > 512 ||
      /[\s\0]/.test(spec.gateway_key)
    ) {
      return bad('gateway_key is not a plausible virtual key');
    }
  } else if (profile.key) {
    return bad(`class ${spec.class} needs its gateway key: no key, no run`);
  }

  const env = spec.env ?? {};
  if (Object.keys(env).length > MAX_ENV) return bad(`at most ${MAX_ENV} environment variables`);
  const names = sandboxEnvViolations(env, spec.class);
  if (names.length > 0)
    return bad(`credential-shaped or reserved environment: ${names.join('; ')}`);
  for (const [name, value] of Object.entries(env)) {
    if (value.length > MAX_ENV_VALUE || value.includes('\0')) return bad(`${name}: bad value`);
    if (scanText(value).length > 0 || scanText(`${name}=${value}`).length > 0) {
      return bad(`${name}: the value looks like a credential`);
    }
  }

  if (spec.command.length === 0 || spec.command.length > MAX_ARGS) {
    return bad(`command must have 1 to ${MAX_ARGS} arguments`);
  }
  if (spec.command.some((a) => a.length > MAX_ARG_LEN || a.includes('\0'))) {
    return bad('an argument is too long or holds a NUL');
  }
  if (!profile.exec && !(opts.trustedCommands ?? []).includes(spec.command[0] as string)) {
    return err(
      sandboxError(
        'exec_not_allowed',
        `class ${spec.class} runs no repo code: ${spec.command[0]} is not a trusted command of the image`,
      ),
    );
  }

  if (spec.repo.length > MAX_REPO_FILES)
    return bad(`a repo copy has at most ${MAX_REPO_FILES} files`);
  const seen = new Set<string>();
  let bytes = 0;
  for (const f of spec.repo) {
    if (!REPO_PATH.test(f.path))
      return bad(`repo path refused: ${JSON.stringify(f.path).slice(0, 80)}`);
    if (seen.has(f.path)) return bad(`repo path twice: ${f.path}`);
    seen.add(f.path);
    bytes += typeof f.content === 'string' ? Buffer.byteLength(f.content) : f.content.byteLength;
    if (bytes > MAX_REPO_BYTES) return bad('the repo copy is too large');
  }
  // a file and a directory of the same name cannot both exist
  for (const p of seen) {
    for (let i = p.indexOf('/'); i !== -1; i = p.indexOf('/', i + 1)) {
      if (seen.has(p.slice(0, i)))
        return bad(`repo path ${p.slice(0, i)} is a file and a directory`);
    }
  }
  return ok({ profile, limits: limits.value });
}

/**
 * Scans what came out of a sandbox: `/out` files and the logs, with the shared ruleset (which carries the
 * factory canary rule). A canary means the sandbox reached something only the factory holds, or the code
 * planted one to see whether the scan notices; either way `/out` is withheld. Other findings are reported
 * (a scanner's report may legitimately name a secret): the caller decides. Values never leave this function.
 */
export function scanSandboxOutput(
  files: ReadonlyArray<{ path: string; content: Uint8Array }>,
  logs: ReadonlyArray<{ path: string; text: string }> = [],
): OutScan {
  const findings: OutScanFinding[] = [];
  const add = (path: string, text: string) => {
    for (const m of scanText(text)) findings.push({ path, rule_id: m.rule_id, line: m.line });
  };
  for (const f of files) {
    // latin1 keeps every byte as one char, so a secret in a binary file is still one match
    add(f.path, Buffer.from(f.content).toString('latin1'));
    add(f.path, Buffer.from(f.content).toString('utf8'));
  }
  for (const l of logs) add(l.path, l.text);
  const uniq = new Map<string, OutScanFinding>();
  for (const f of findings) uniq.set(`${f.path}\0${f.rule_id}\0${f.line}`, f);
  const all = [...uniq.values()].sort(
    (a, b) => a.path.localeCompare(b.path) || a.rule_id.localeCompare(b.rule_id) || a.line - b.line,
  );
  const canary = all.some((f) => f.rule_id === 'aisdlc-canary');
  return { clean: all.length === 0, canary, findings: all };
}

export const outFileOf = (path: string, content: Uint8Array): OutFile => ({
  path,
  size: content.byteLength,
  sha256: sha256Hex(content),
  content,
});

/** `W` sessions counted against the cap of one (RV §3.4). In-process; the proxy counts across processes. */
export class CodingGate {
  private running = 0;
  constructor(private readonly cap: number = CODING_SESSION_CAP) {}
  /** Takes a slot or says no. Never waits: admission queues, the sandbox refuses. */
  tryAcquire(cls: SandboxClass): (() => void) | null {
    if (!CODING_CLASSES.includes(cls)) return () => undefined;
    if (this.running >= this.cap) return null;
    this.running += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.running -= 1;
      }
    };
  }
  get active(): number {
    return this.running;
  }
}

// ---------------------------------------------------------------------------------------------- the fake

export interface FakeSandboxOutcome {
  readonly status?: SandboxStatus;
  readonly exit_code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  /** What the "session" wrote to `/out`: path to text or bytes. */
  readonly out?: Readonly<Record<string, string | Uint8Array>>;
}

export type FakeSandboxScript = (
  spec: SandboxSpec,
  ctx: { profile: SandboxProfile; limits: SandboxLimits },
) => FakeSandboxOutcome | Promise<FakeSandboxOutcome>;

/**
 * Deterministic `SandboxPort`: the same preflight, cap, output cap and output scan as the real driver, and a
 * script in place of the container. `peers` follow the profile, so a test sees what the real network would be.
 */
export class FakeSandbox implements SandboxPort {
  readonly runs: SandboxSpec[] = [];
  private readonly gate = new CodingGate();
  private down = false;

  constructor(
    private readonly script: FakeSandboxScript = () => ({ exit_code: 0 }),
    private readonly opts: PreflightOptions = {},
  ) {}

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async run(spec: SandboxSpec): Promise<Result<SandboxRun, SandboxError>> {
    const pre = preflightSpec(spec, this.opts);
    if (!pre.ok) return pre;
    if (this.down) return err(sandboxError('unavailable', 'the sandbox host is unavailable'));
    const release = this.gate.tryAcquire(spec.class);
    if (release === null) {
      return err(sandboxError('busy', `at most ${CODING_SESSION_CAP} coding session runs at once`));
    }
    try {
      this.runs.push(spec);
      const o = await this.script(spec, pre.value);
      const { profile, limits } = pre.value;
      const files = Object.entries(o.out ?? {}).map(([path, c]) =>
        outFileOf(path, typeof c === 'string' ? Buffer.from(c) : c),
      );
      const total = files.reduce((n, f) => n + f.size, 0);
      let status: SandboxStatus = o.status ?? 'exited';
      if (status === 'exited' && total > limits.out_bytes) status = 'out_oversized';
      const stdout = (o.stdout ?? '').slice(0, 1_000_000);
      const stderr = (o.stderr ?? '').slice(0, 1_000_000);
      const scan = scanSandboxOutput(files, [
        { path: 'stdout', text: stdout },
        { path: 'stderr', text: stderr },
      ]);
      const void_ = status !== 'exited';
      return ok({
        session_id: spec.session_id,
        class: spec.class,
        status,
        exit_code: status === 'exited' ? (o.exit_code ?? 0) : null,
        stdout,
        stderr,
        logs_truncated: false,
        out: scan.canary || void_ ? [] : files,
        out_scan: scan,
        quarantined: scan.canary,
        duration_ms: 0,
        detail: void_ ? status : null,
        cleanup_errors: [],
        limits,
        peers: peersOf(profile),
      });
    } finally {
      release();
    }
  }
}

export function peersOf(profile: SandboxProfile): string[] {
  switch (profile.network) {
    case 'none':
      return [];
    case 'mirror':
      return ['mirror'];
    case 'gateway':
      return ['gateway'];
    case 'gateway+mirror':
      return ['gateway', 'mirror'];
  }
}
