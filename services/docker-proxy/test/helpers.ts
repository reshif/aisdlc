import {
  SANDBOX_GID,
  SANDBOX_LABEL,
  SANDBOX_PROFILES,
  SANDBOX_UID,
  type SandboxClass,
} from '@aisdlc/contracts';
import type { PolicyConfig } from '../src/index.js';

export const SCRATCH = '/var/lib/aisdlc-test/scratch';
export const IMAGE = 'aisdlc/sandbox:local';

export const cfg = (over: Partial<PolicyConfig> = {}): PolicyConfig => ({
  images: [IMAGE],
  entrypoint: ['/usr/local/bin/aisdlc-run'],
  scratchRoot: SCRATCH,
  allowNetworks: true,
  maxSandboxes: 4,
  codingCap: 1,
  archiveGet: [],
  archivePut: [],
  maxArchiveBytes: 1024 * 1024,
  ...over,
});

/** A create body that passes, for a class; tests change one thing at a time. */
/** A create body the tests mutate freely (add a key, delete one, change a value): untyped on purpose. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test bodies are edited key by key
export type Body = Record<string, any>;

export function validBody(cls: SandboxClass = 'K', session = 'sess-000001'): Body {
  const p = SANDBOX_PROFILES[cls];
  const tm = (bytes: number, exec: boolean) =>
    `rw,${exec ? 'exec' : 'noexec'},nosuid,nodev,size=${bytes},uid=${SANDBOX_UID},gid=${SANDBOX_GID},mode=0700`;
  return {
    Image: IMAGE,
    Entrypoint: ['/usr/local/bin/aisdlc-run'],
    Cmd: ['node', '-e', '1'],
    Env: ['AISDLC_REPO_MODE=ro', 'LANG=C'],
    User: `${SANDBOX_UID}:${SANDBOX_GID}`,
    WorkingDir: '/work',
    Labels: {
      [SANDBOX_LABEL.sandbox]: '1',
      [SANDBOX_LABEL.session]: session,
      [SANDBOX_LABEL.class]: cls,
    },
    HostConfig: {
      Binds: [`${SCRATCH}/${session}/repo:/repo:ro`],
      Tmpfs: {
        '/out': tm(p.limits.out_bytes, false),
        '/work': tm(p.limits.work_bytes, p.exec),
        '/tmp': tm(16 * 1024 * 1024, p.exec),
      },
      NetworkMode: p.network === 'none' ? 'none' : `aisdlc-sbx-net-${session}`,
      Memory: p.limits.memory_mb * 1024 * 1024,
      MemorySwap: p.limits.memory_mb * 1024 * 1024,
      NanoCpus: p.limits.cpus * 1_000_000_000,
      PidsLimit: p.limits.pids,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges'],
      LogConfig: { Type: 'json-file', Config: { 'max-size': '8m', 'max-file': '2' } },
      Init: true,
      IpcMode: 'private',
    },
  };
}
