import http from 'node:http';
import https from 'node:https';
import {
  CODING_CLASSES,
  DEFAULT_SANDBOX_CAPS,
  SANDBOX_PROFILES,
  SandboxClassValues,
  SandboxErrorCode,
  SandboxRunWire,
  SandboxSlots,
  type SandboxCaps,
  type SandboxClass,
  type SandboxSessionRequest,
  type SandboxSpecWire,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import {
  sandboxError,
  type OutFile,
  type RepoFile,
  type SandboxError,
  type SandboxPort,
  type SandboxRun,
  type SandboxSlotsPort,
  type SandboxSpec,
} from './sandbox.js';
import { ErrorEnvelope } from './wire.js';

// `HttpSandbox` (PLAN M14.2; ADR-0003 §6, §7): the `SandboxPort` over the sandbox-controller's HTTP API
// (docs/specs/sandbox-controller-api.md), and the `SandboxSlotsPort` admission's H2 reads. The controller owns the
// driver, the class ceilings and the two caps of its runner host; core reaches it only through this adapter.
//
// Fail closed: a session with no grant is refused here before anything is sent; a transport error, a timeout, a
// non-2xx answer, a body that does not parse or an `/out` file whose bytes do not match the hash the controller named
// is a `SandboxError`, never a run. The call is synchronous like `run` itself: it returns when the session has ended.

export interface HttpSandboxOptions {
  readonly baseUrl: string;
  /** This caller's service token at the controller (resolved from a `file:` reference by the caller's boot). */
  readonly token: string;
  /** Added to the session's own time limit for the whole call (provisioning, copy-in, cleanup). Default 120 s. */
  readonly marginMs?: number;
  /** `GET /v1/slots`. Default 3 s. */
  readonly slotsTimeoutMs?: number;
  /** The largest answer accepted. Default 160 MiB (the biggest `/out` cap as base64, plus the logs). */
  readonly maxResponseBytes?: number;
}

// ---------------------------------------------------------------------------------------------- the codec

/** A spec on the wire (without its grant, which travels beside it). Text stays text; bytes go as base64. */
export function sandboxSpecToWire(spec: SandboxSpec): SandboxSpecWire {
  return {
    ...(spec.repo_full_name !== undefined ? { repo_full_name: spec.repo_full_name } : {}),
    session_id: spec.session_id,
    class: spec.class,
    command: [...spec.command],
    repo: spec.repo.map((f) => ({
      path: f.path,
      ...(typeof f.content === 'string'
        ? { encoding: 'utf8' as const, data: f.content }
        : { encoding: 'base64' as const, data: Buffer.from(f.content).toString('base64') }),
      ...(f.executable !== undefined ? { executable: f.executable } : {}),
    })),
    ...(spec.env !== undefined ? { env: { ...spec.env } } : {}),
    ...(spec.gateway_key !== undefined ? { gateway_key: spec.gateway_key } : {}),
    ...(spec.limits !== undefined ? { limits: { ...spec.limits } } : {}),
  };
}

/** The spec a controller hands its driver: the wire spec decoded, with the grant it came with. */
export function sandboxSpecFromWire(req: SandboxSessionRequest): SandboxSpec {
  const w = req.spec;
  const repo: RepoFile[] = w.repo.map((f) => ({
    path: f.path,
    content: f.encoding === 'utf8' ? f.data : new Uint8Array(Buffer.from(f.data, 'base64')),
    ...(f.executable !== undefined ? { executable: f.executable } : {}),
  }));
  const limits = w.limits
    ? Object.fromEntries(Object.entries(w.limits).filter(([, v]) => v !== undefined))
    : undefined;
  return {
    ...(w.repo_full_name !== undefined ? { repo_full_name: w.repo_full_name } : {}),
    session_id: w.session_id,
    class: w.class,
    command: w.command,
    repo,
    ...(w.env !== undefined ? { env: w.env } : {}),
    ...(w.gateway_key !== undefined ? { gateway_key: w.gateway_key } : {}),
    ...(limits !== undefined ? { limits } : {}),
    grant: req.grant,
  };
}

export function sandboxRunToWire(r: SandboxRun): SandboxRunWire {
  return {
    session_id: r.session_id,
    class: r.class,
    status: r.status,
    exit_code: r.exit_code,
    stdout: r.stdout,
    stderr: r.stderr,
    logs_truncated: r.logs_truncated,
    out: r.out.map((f) => ({
      path: f.path,
      size: f.size,
      sha256: f.sha256,
      content_b64: Buffer.from(f.content).toString('base64'),
    })),
    out_scan: {
      clean: r.out_scan.clean,
      canary: r.out_scan.canary,
      findings: r.out_scan.findings.map((f) => ({ ...f })),
    },
    quarantined: r.quarantined,
    duration_ms: r.duration_ms,
    detail: r.detail,
    cleanup_errors: [...r.cleanup_errors],
    limits: { ...r.limits },
    peers: [...r.peers],
  };
}

/** The run back from the wire. An `/out` file whose bytes do not match its size and hash is refused (no evidence). */
export function sandboxRunFromWire(w: SandboxRunWire): Result<SandboxRun, SandboxError> {
  const out: OutFile[] = [];
  for (const f of w.out) {
    const content = new Uint8Array(Buffer.from(f.content_b64, 'base64'));
    if (content.byteLength !== f.size || sha256Hex(content) !== f.sha256) {
      return err(
        sandboxError(
          'driver_failure',
          `the /out file ${f.path.slice(0, 80)} does not match its hash`,
        ),
      );
    }
    out.push({ path: f.path, size: f.size, sha256: f.sha256, content });
  }
  return ok({ ...w, out });
}

// ---------------------------------------------------------------------------------------------- slots

/** The coding sessions that may start now: the least free of the coding classes (each already under both caps). */
export function freeCodingSlots(s: SandboxSlots): number {
  return Math.min(...CODING_CLASSES.map((c) => s.free[c]));
}

/** Free slots per class under two caps, from what is in use: the arithmetic the controller and its fake share. */
export function slotsUnder(
  caps: SandboxCaps,
  used: Readonly<Record<SandboxClass, number>>,
): { used_total: number; free: Record<SandboxClass, number> } {
  const used_total = SandboxClassValues.reduce((n, c) => n + used[c], 0);
  const usedCoding = CODING_CLASSES.reduce((n, c) => n + used[c], 0);
  const totalFree = Math.max(0, caps.total - used_total);
  const codingFree = Math.max(0, Math.min(totalFree, caps.coding - usedCoding));
  const free = Object.fromEntries(
    SandboxClassValues.map((c) => [c, CODING_CLASSES.includes(c) ? codingFree : totalFree]),
  ) as Record<SandboxClass, number>;
  return { used_total, free };
}

const zeroUsed = (): Record<SandboxClass, number> =>
  Object.fromEntries(SandboxClassValues.map((c) => [c, 0])) as Record<SandboxClass, number>;

/** Deterministic `SandboxSlotsPort` for admission tests: `coding` W sessions in use under the caps, or down. */
export class FakeSandboxSlots implements SandboxSlotsPort {
  private down = false;
  readonly used = zeroUsed();
  asked = 0;

  constructor(public caps: SandboxCaps = DEFAULT_SANDBOX_CAPS) {}

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  /** Marks `n` sessions of a class as running. */
  occupy(cls: SandboxClass, n: number): this {
    this.used[cls] = Math.max(0, n);
    return this;
  }

  async slots(): Promise<Result<SandboxSlots, SandboxError>> {
    this.asked += 1;
    if (this.down) return err(sandboxError('unavailable', 'the sandbox-controller is unreachable'));
    const u = slotsUnder(this.caps, this.used);
    return ok({
      host_id: 'fake',
      caps: this.caps,
      caps_source: 'config',
      used_total: u.used_total,
      used: { ...this.used },
      free: u.free,
      sessions: [],
    });
  }
}

// ---------------------------------------------------------------------------------------------- the adapter

export interface RawAnswer {
  readonly status: number;
  readonly text: string;
}

/** One POST with a deadline over the whole call (undici's fetch would cut a long session at its 300 s header timeout). Also the verify client's (M14.3: a check runs every kit of its step). */
export function postLong(
  url: URL,
  token: string,
  body: string,
  deadlineMs: number,
  maxBytes: number,
): Promise<RawAnswer | { failed: string }> {
  return new Promise((resolve) => {
    const lib = url.protocol === 'https:' ? https : http;
    let settled = false;
    const done = (v: RawAnswer | { failed: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const req = lib.request(
      url,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let n = 0;
        res.on('data', (c: Buffer) => {
          n += c.byteLength;
          if (n > maxBytes) {
            req.destroy();
            done({ failed: 'the controller answered more than the response limit' });
            return;
          }
          chunks.push(c);
        });
        res.on('end', () =>
          done({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
        );
        res.on('error', () => done({ failed: 'the answer was cut off' }));
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      done({ failed: 'the session did not end before the deadline' });
    }, deadlineMs);
    timer.unref?.();
    req.on('error', (e) => done({ failed: e.message.slice(0, 200) }));
    req.end(body);
  });
}

const parseJson = (t: string): unknown => {
  try {
    return t === '' ? null : JSON.parse(t);
  } catch {
    return null;
  }
};

/** The controller's error body as a `SandboxError`: a code it names, else `unavailable` (never an approval). */
function errorOf(status: number, json: unknown): SandboxError {
  const e = ErrorEnvelope.safeParse(json);
  if (!e.success) return sandboxError('unavailable', `the sandbox-controller answered ${status}`);
  const code = SandboxErrorCode.safeParse(e.data.error.code);
  return sandboxError(code.success ? code.data : 'unavailable', e.data.error.message.slice(0, 500));
}

export class HttpSandbox implements SandboxPort, SandboxSlotsPort {
  constructor(private readonly o: HttpSandboxOptions) {}

  async run(spec: SandboxSpec): Promise<Result<SandboxRun, SandboxError>> {
    if (spec.grant === undefined) {
      return err(
        sandboxError(
          'refused',
          'no admission grant: the sandbox-controller starts nothing without one',
        ),
      );
    }
    const profile = SANDBOX_PROFILES[spec.class];
    const time_s = spec.limits?.time_s ?? profile?.limits.time_s ?? 3600;
    const body: SandboxSessionRequest = { grant: spec.grant, spec: sandboxSpecToWire(spec) };
    const a = await postLong(
      new URL('/v1/sessions', this.o.baseUrl),
      this.o.token,
      JSON.stringify(body),
      time_s * 1000 + (this.o.marginMs ?? 120_000),
      this.o.maxResponseBytes ?? 160 * 1024 * 1024,
    );
    if ('failed' in a) {
      return err(sandboxError('unavailable', `the sandbox-controller: ${a.failed}`));
    }
    const json = parseJson(a.text);
    if (a.status < 200 || a.status > 299) return err(errorOf(a.status, json));
    const w = SandboxRunWire.safeParse(json);
    if (!w.success) {
      return err(sandboxError('driver_failure', 'the sandbox-controller answered a malformed run'));
    }
    if (w.data.session_id !== spec.session_id || w.data.class !== spec.class) {
      return err(sandboxError('driver_failure', 'the sandbox-controller answered another session'));
    }
    return sandboxRunFromWire(w.data);
  }

  async slots(): Promise<Result<SandboxSlots, SandboxError>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method: 'GET',
      path: '/v1/slots',
      timeoutMs: this.o.slotsTimeoutMs ?? 3_000,
    });
    if (!r.reached)
      return err(sandboxError('unavailable', 'the sandbox-controller did not answer'));
    if (r.status !== 200) return err(errorOf(r.status, r.json));
    const s = SandboxSlots.safeParse(r.json);
    return s.success
      ? ok(s.data)
      : err(sandboxError('unavailable', 'the sandbox-controller answered malformed slots'));
  }
}
