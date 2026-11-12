import { ErasablePayloadList, type ErasablePayload, type ErasureTarget } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';

// ErasablePayloadsPort (PLAN M19; docs/specs/audit-api.md): the audit service's ONE way to the payloads kept off the
// hash chain. Their owner (core: `core.conversation_payload`) lists them by id, hash and owner (never their text) and
// erases one (its text goes, its hash stays, `conversation.payload_erased` on its thread). The audit service never
// touches core's tables: `HttpErasablePayloads` is core's `/v1/erasable-payloads` API (scope `erasure`),
// `FakeErasablePayloads` the deterministic fake.
//
// Fail closed: a transport error, a non-2xx answer or a body that does not parse is an error, never "nothing to erase"
// and never "erased". Erasing a payload whose hash is not the one named is refused (`mismatch`): the approval bound a
// payload by its hash, and only that payload goes.

export const ErasablePayloadsError = taggedError('ErasablePayloadsError');
export type ErasablePayloadsError = TaggedError<
  'ErasablePayloadsError',
  { code: 'unavailable' | 'not_found' | 'mismatch' | 'refused'; message: string }
>;
export const erasablePayloadsError = (
  code: ErasablePayloadsError['code'],
  message: string,
): ErasablePayloadsError => ErasablePayloadsError({ code, message });

export interface ErasablePayloadQuery {
  /** One person's payloads. */
  readonly owner?: string;
  /** ...in one project. */
  readonly project_id?: string;
  /** Created before this instant (retention). */
  readonly created_before?: string;
  /** Only payloads not erased yet. */
  readonly live_only?: boolean;
  readonly limit: number;
}

export interface ErasablePayloadsPort {
  list(q: ErasablePayloadQuery): Promise<Result<ErasablePayload[], ErasablePayloadsError>>;
  /** Idempotent: an already erased payload answers `already: true`. */
  erase(t: ErasureTarget): Promise<Result<{ already: boolean }, ErasablePayloadsError>>;
}

/** In memory, the same rules as core. `text` is kept so a test can see it go. */
export class FakeErasablePayloads implements ErasablePayloadsPort {
  readonly rows = new Map<string, ErasablePayload & { text: string | null }>();
  /** When set, every call answers `unavailable` (core down). */
  down = false;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  add(p: {
    readonly payload_id: string;
    readonly thread_id: string;
    readonly owner: string;
    readonly project_id: string | null;
    readonly sha256: string;
    readonly created_at: string;
    readonly text?: string;
  }): void {
    this.rows.set(p.payload_id, {
      kind: 'conversation_payload',
      payload_id: p.payload_id,
      thread_id: p.thread_id,
      owner: p.owner as ErasablePayload['owner'],
      project_id: p.project_id as ErasablePayload['project_id'],
      sha256: p.sha256,
      created_at: p.created_at,
      erased_at: null,
      text: p.text ?? 'some words',
    });
  }

  async list(q: ErasablePayloadQuery) {
    if (this.down) return err(erasablePayloadsError('unavailable', 'core is down'));
    const out = [...this.rows.values()]
      .filter(
        (r) =>
          (q.owner === undefined || r.owner === q.owner) &&
          (q.project_id === undefined || r.project_id === q.project_id) &&
          (q.created_before === undefined ||
            Date.parse(r.created_at) < Date.parse(q.created_before)) &&
          (!q.live_only || r.erased_at === null),
      )
      .sort((a, b) =>
        a.created_at === b.created_at
          ? a.payload_id.localeCompare(b.payload_id)
          : a.created_at.localeCompare(b.created_at),
      )
      .slice(0, q.limit)
      .map(({ text: _text, ...p }) => p);
    return ok(out);
  }

  async erase(t: ErasureTarget) {
    if (this.down) return err(erasablePayloadsError('unavailable', 'core is down'));
    const r = this.rows.get(t.payload_id);
    if (!r || r.owner !== t.owner || r.thread_id !== t.thread_id) {
      return err(erasablePayloadsError('not_found', 'no such payload'));
    }
    if (r.sha256 !== t.sha256) return err(erasablePayloadsError('mismatch', 'another payload'));
    if (r.erased_at !== null) return ok({ already: true });
    r.text = null;
    r.erased_at = this.now();
    return ok({ already: false });
  }
}

const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** Core's `/v1/erasable-payloads` (scope `erasure`). */
export class HttpErasablePayloads implements ErasablePayloadsPort {
  constructor(
    private readonly o: {
      readonly baseUrl: string;
      readonly token: string;
      readonly fetchImpl?: typeof fetch;
    },
  ) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown) {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!r.reached) return err(erasablePayloadsError('unavailable', r.message));
    if (r.status >= 200 && r.status < 300) return ok(r.json);
    const e = ErrorBody.safeParse(r.json);
    const code =
      r.status === 404
        ? 'not_found'
        : r.status === 409
          ? 'mismatch'
          : r.status >= 500
            ? 'unavailable'
            : 'refused';
    return err(
      erasablePayloadsError(
        code,
        e.success ? e.data.error.message.slice(0, 200) : `HTTP ${r.status}`,
      ),
    );
  }

  async list(q: ErasablePayloadQuery) {
    const p = new URLSearchParams({ limit: String(q.limit) });
    if (q.owner !== undefined) p.set('owner', q.owner);
    if (q.project_id !== undefined) p.set('project', q.project_id);
    if (q.created_before !== undefined) p.set('created_before', q.created_before);
    if (q.live_only) p.set('live_only', 'true');
    const r = await this.call('GET', `/v1/erasable-payloads?${p.toString()}`);
    if (!r.ok) return r;
    const parsed = ErasablePayloadList.safeParse(r.value);
    return parsed.success
      ? ok(parsed.data.payloads)
      : err(erasablePayloadsError('unavailable', 'core sent something unexpected'));
  }

  async erase(t: ErasureTarget) {
    const r = await this.call('POST', `/v1/erasable-payloads/${t.payload_id}/erase`, {
      thread_id: t.thread_id,
      owner: t.owner,
      sha256: t.sha256,
    });
    if (!r.ok) return r;
    const parsed = z.strictObject({ already: z.boolean() }).safeParse(r.value);
    return parsed.success
      ? ok(parsed.data)
      : err(erasablePayloadsError('unavailable', 'core sent something unexpected'));
  }
}
