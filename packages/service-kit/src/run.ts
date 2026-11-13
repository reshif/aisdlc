import { ServiceConfigError } from './auth.js';
import { primeSecretRefsFromEnv } from './secret-refs.js';

export interface RunningService {
  /** Where it listens, for the startup line. */
  url: string;
  /** Stops accepting connections and releases pools; resolves when done. */
  close(): Promise<void>;
}

/** Exit code for a configuration error (EX_CONFIG). */
export const EXIT_CONFIG = 78;
export const SHUTDOWN_TIMEOUT_MS = 10_000;

export interface RunServiceDeps {
  log?: (line: string) => void;
  error?: (line: string) => void;
  exit?: (code: number) => never;
  /** Where signal handlers are installed. */
  proc?: Pick<NodeJS.Process, 'once' | 'on'>;
  shutdownTimeoutMs?: number;
  /** Whose `vault:` references are primed before `start` (default process.env). */
  env?: Record<string, string | undefined>;
}

/**
 * The `main` of every service. Primes the `vault:` references of the environment, runs `start`; a `ServiceConfigError` prints a clear message and
 * exits 78, any other startup failure exits 1. On SIGTERM or SIGINT it calls `close()` once and
 * exits 0 (1 if close fails or takes longer than the timeout); a second signal exits at once.
 */
export async function runService(
  name: string,
  start: () => Promise<RunningService>,
  deps: RunServiceDeps = {},
): Promise<void> {
  const log = deps.log ?? ((l) => console.log(l));
  const error = deps.error ?? ((l) => console.error(l));
  const exit = deps.exit ?? ((c) => process.exit(c));
  const proc = deps.proc ?? process;
  let svc: RunningService;
  try {
    // every `vault:` reference the environment names is read before any configuration is (secret-refs.ts)
    await primeSecretRefsFromEnv(deps.env ?? process.env);
    svc = await start();
  } catch (e) {
    if (e instanceof ServiceConfigError) {
      error(`${name}: configuration error: ${e.message}`);
      return exit(EXIT_CONFIG);
    }
    error(`${name}: failed to start: ${e instanceof Error ? e.message : String(e)}`);
    return exit(1);
  }
  log(`${name} listening on ${svc.url}`);
  let closing = false;
  const onSignal = (sig: string): void => {
    if (closing) return exit(1);
    closing = true;
    log(`${name}: ${sig} received, shutting down`);
    const timer = setTimeout(() => {
      error(`${name}: shutdown timed out`);
      exit(1);
    }, deps.shutdownTimeoutMs ?? SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    svc.close().then(
      () => exit(0),
      (e: unknown) => {
        error(`${name}: shutdown failed: ${e instanceof Error ? e.message : String(e)}`);
        exit(1);
      },
    );
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) proc.on(sig, () => onSignal(sig));
}
