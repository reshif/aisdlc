import { z } from 'zod';

// Sandbox classes and their profiles (PLAN M13.2; onboarding-roadmap §5.6; RV §2, §3.4; DM `SandboxClass`).
//
// The profile of a class is a CEILING, written once here and imported by the `SandboxPort`, its fake, the
// Docker driver and the socket proxy (which refuses a create body that asks for more). A session may ask for
// less (a shorter time, less memory); never for more, and never for a different network or key.
//
//   K       third-party scanners: no NIC at all, repo read-only, no key, no execution of repo code
//   K-exec  the build/test probe: the package mirror ONLY (no gateway, no key), repo code runs (DEC-18)
//   P       planning agents: the gateway only, repo read-only, a per-job key, no execution
//   W       the coding worker's session: gateway and mirror, a disposable copy of the repo, a per-Unit key, runs code
//   O       oracle runs: the mirror only, no key, repo code runs (the oracles are tests)
//   V       reviewers and verifiers: the gateway only, repo read-only, a per-job key, no execution
//
// Every class has an `/out` directory (fix #25: K and K-exec had none), size-capped, and a memory limit.

export const SandboxClass = z.enum(['K', 'K-exec', 'P', 'W', 'O', 'V']);
export type SandboxClass = z.infer<typeof SandboxClass>;
export const SandboxClassValues = SandboxClass.options;

/** Who a sandbox's network can reach. `none` is no NIC (Docker network mode `none`); the others are the peers of a per-session `--internal` network. */
export const SandboxNetwork = z.enum(['none', 'mirror', 'gateway', 'gateway+mirror']);
export type SandboxNetwork = z.infer<typeof SandboxNetwork>;

export const SandboxLimits = z.strictObject({
  cpus: z.number().positive().max(8),
  memory_mb: z.number().int().min(64).max(8192),
  pids: z.number().int().min(16).max(4096),
  /** Wall clock; the driver kills the container at the limit and the result is void. */
  time_s: z.number().int().min(1).max(14_400),
  /** The `/out` tmpfs size and the most output bytes the driver accepts. */
  out_bytes: z
    .number()
    .int()
    .min(1024)
    .max(256 * 1024 * 1024),
  /** `/work` and `/tmp`: writable scratch (tmpfs: memory-backed, so it counts against the memory limit as well as its own cap). */
  work_bytes: z
    .number()
    .int()
    .min(1024 * 1024)
    .max(1024 * 1024 * 1024),
});
export type SandboxLimits = z.infer<typeof SandboxLimits>;

export const SandboxProfile = z.strictObject({
  class: SandboxClass,
  description: z.string(),
  network: SandboxNetwork,
  /** `ro`: the repo is a read-only mount, no write anywhere in it. `copy`: a disposable writable copy in `/work`, the mount stays read-only. */
  repo: z.enum(['ro', 'copy']),
  /** Repo-supplied code may run. Where false only the image's own trusted commands run, and files carry no exec bit. */
  exec: z.boolean(),
  /** The session gets a per-Unit (or per-job) gateway virtual key. No other credential, ever. */
  key: z.boolean(),
  limits: SandboxLimits,
});
export type SandboxProfile = z.infer<typeof SandboxProfile>;

const MIB = 1024 * 1024;

export const SANDBOX_PROFILES: Readonly<Record<SandboxClass, SandboxProfile>> = {
  K: {
    class: 'K',
    description: 'third-party scanners: no NIC, repo read-only, no key, no execution',
    network: 'none',
    repo: 'ro',
    exec: false,
    key: false,
    limits: {
      cpus: 1,
      memory_mb: 512,
      pids: 128,
      time_s: 300,
      out_bytes: 16 * MIB,
      work_bytes: 64 * MIB,
    },
  },
  'K-exec': {
    class: 'K-exec',
    description: 'build/test probe: the package mirror only, no gateway key, repo code runs',
    network: 'mirror',
    repo: 'copy',
    exec: true,
    key: false,
    limits: {
      cpus: 1,
      memory_mb: 1024,
      pids: 256,
      time_s: 900,
      out_bytes: 16 * MIB,
      work_bytes: 256 * MIB,
    },
  },
  P: {
    class: 'P',
    description: 'planning agents: the gateway only, repo read-only, a per-job key, no execution',
    network: 'gateway',
    repo: 'ro',
    exec: false,
    key: true,
    limits: {
      cpus: 1,
      memory_mb: 512,
      pids: 128,
      time_s: 600,
      out_bytes: 8 * MIB,
      work_bytes: 64 * MIB,
    },
  },
  W: {
    class: 'W',
    description:
      'coding session: the gateway and the mirror, a disposable repo copy, a per-Unit key, runs code',
    network: 'gateway+mirror',
    repo: 'copy',
    exec: true,
    key: true,
    limits: {
      cpus: 2,
      memory_mb: 2048,
      pids: 512,
      time_s: 3600,
      out_bytes: 32 * MIB,
      work_bytes: 512 * MIB,
    },
  },
  O: {
    class: 'O',
    description: 'oracle runs: the mirror only, no key, repo code runs',
    network: 'mirror',
    repo: 'copy',
    exec: true,
    key: false,
    limits: {
      cpus: 1,
      memory_mb: 1024,
      pids: 256,
      time_s: 900,
      out_bytes: 16 * MIB,
      work_bytes: 256 * MIB,
    },
  },
  V: {
    class: 'V',
    description:
      'reviewers and verifiers: the gateway only, repo read-only, a per-job key, no execution',
    network: 'gateway',
    repo: 'ro',
    exec: false,
    key: true,
    limits: {
      cpus: 1,
      memory_mb: 512,
      pids: 128,
      time_s: 600,
      out_bytes: 8 * MIB,
      work_bytes: 64 * MIB,
    },
  },
};

/** At most this many coding (`W`) sessions run at once (RV §3.4: two sessions plus a test run push the host into swap). */
export const CODING_SESSION_CAP = 1;
/** Classes that count against the coding-session cap. */
export const CODING_CLASSES: readonly SandboxClass[] = ['W'];

// ---- what a container wears, for the proxy and the driver to agree on (labels, names, mounts)

export const SANDBOX_LABEL = {
  /** `1` on every sandbox container and network: the proxy touches nothing without it. */
  sandbox: 'aisdlc.sandbox',
  session: 'aisdlc.sandbox.session',
  class: 'aisdlc.sandbox.class',
  /** Set by compose on the peers a session network may attach (`gateway`, `mirror`); the proxy refuses it on a create. */
  peer: 'aisdlc.sandbox.peer',
} as const;

export const SandboxPeer = z.enum(['gateway', 'mirror']);
export type SandboxPeer = z.infer<typeof SandboxPeer>;
/** The DNS name each peer has on a session network. */
export const SANDBOX_PEER_ALIAS: Readonly<Record<SandboxPeer, string>> = {
  gateway: 'gateway',
  mirror: 'package-mirror',
};
export const SANDBOX_NAME_PREFIX = 'aisdlc-sbx-';
/** A session id as it appears in names, labels and scratch paths: lowercase, short, no separators that mean anything to a path or a shell. */
export const SANDBOX_SESSION_ID = /^[a-z0-9][a-z0-9-]{5,47}$/;
/** The only non-root identity a sandbox runs as. */
export const SANDBOX_UID = 10002;
export const SANDBOX_GID = 10002;
/** Where things are in a sandbox. */
export const SANDBOX_PATHS = { repo: '/repo', out: '/out', work: '/work', tmp: '/tmp' } as const;

// ---- the environment of a sandbox (no credential, ever)

/** Names the wrapper and the driver own; a session's `env` may not use the prefix. */
export const SANDBOX_ENV_RESERVED_PREFIX = 'AISDLC_';
/** The only credential a sandbox may hold, and only classes whose profile says `key`: the per-Unit gateway virtual key. */
export const SANDBOX_GATEWAY_KEY_ENV = 'AISDLC_GATEWAY_KEY';
export const SANDBOX_GATEWAY_URL_ENV = 'AISDLC_GATEWAY_URL';
/** What the in-image wrapper (`aisdlc-run`) is configured with: the one set of `AISDLC_` names a create may carry besides the gateway pair. */
export const SANDBOX_WRAPPER_ENV = [
  'AISDLC_REPO_MODE',
  'AISDLC_OUT_MARK',
  'AISDLC_OUT_BYTES',
  'AISDLC_TIME_S',
] as const;
const SANDBOX_ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
/** An environment variable whose NAME says it holds a credential. */
export const SECRET_ENV_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|PRIVATE|CANARY)/i;

/**
 * Why an environment is refused for a class, or `[]`. Names only (values are scanned by the driver with the
 * shared secret ruleset): a malformed name, a reserved one, one that says it holds a credential, and the
 * gateway key on a class whose profile has no key.
 */
export function sandboxEnvViolations(
  env: Readonly<Record<string, string>>,
  cls: SandboxClass,
  /** The create body (proxy, driver) may carry the wrapper's names; a session's own `env` may not. */
  allowWrapper = false,
): string[] {
  const out: string[] = [];
  for (const name of Object.keys(env)) {
    if (name === SANDBOX_GATEWAY_KEY_ENV || name === SANDBOX_GATEWAY_URL_ENV) {
      if (!SANDBOX_PROFILES[cls].key) out.push(`${name}: class ${cls} gets no gateway key`);
      continue;
    }
    if (allowWrapper && (SANDBOX_WRAPPER_ENV as readonly string[]).includes(name)) continue;
    if (!SANDBOX_ENV_NAME.test(name)) out.push(`${name}: not a plain upper-case name`);
    else if (name.startsWith(SANDBOX_ENV_RESERVED_PREFIX)) out.push(`${name}: reserved prefix`);
    else if (SECRET_ENV_NAME.test(name)) out.push(`${name}: the name says it holds a credential`);
  }
  return out;
}
