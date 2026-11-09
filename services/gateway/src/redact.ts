import type { ModelCompleteRequest } from '@aisdlc/contracts';
import { scanText } from '@aisdlc/secrets-rules';

// Redaction of what leaves for the vendor (PLAN M10.3; FL GATEWAY "redaction"). The ONE shared secret
// ruleset (`@aisdlc/secrets-rules`) runs over every string of the request that is content: the system
// prompt, message text, tool results, and the strings inside a tool call's input. A found value is
// replaced by `[REDACTED:<rule>]` and counted; the value itself goes nowhere (not into the count, a
// log or the record). The request is copied, never changed in place.

const mark = (rule: string): string => `[REDACTED:${rule}]`;

interface Counter {
  n: number;
}

function redactString(s: string, c: Counter): string {
  if (s.length < 8) return s;
  const found = scanText(s);
  if (found.length === 0) return s;
  // Longest values first, so a secret that contains another is replaced whole.
  const byValue = new Map<string, string>();
  for (const m of found) if (!byValue.has(m.value)) byValue.set(m.value, m.rule_id);
  let out = s;
  for (const [value, rule] of [...byValue].sort((a, b) => b[0].length - a[0].length)) {
    const parts = out.split(value);
    if (parts.length > 1) {
      c.n += parts.length - 1;
      out = parts.join(mark(rule));
    }
  }
  return out;
}

function redactJson(v: unknown, c: Counter): unknown {
  if (typeof v === 'string') return redactString(v, c);
  if (Array.isArray(v)) return v.map((x) => redactJson(x, c));
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, redactJson(x, c)]),
    );
  }
  return v;
}

export function redactRequest(req: ModelCompleteRequest): {
  request: ModelCompleteRequest;
  redactions: number;
} {
  const c: Counter = { n: 0 };
  const request: ModelCompleteRequest = {
    ...req,
    ...(req.system === undefined ? {} : { system: redactString(req.system, c) }),
    messages: req.messages.map((m) => ({
      role: m.role,
      content:
        typeof m.content === 'string'
          ? redactString(m.content, c)
          : m.content.map((b) => {
              if (b.type === 'text') return { ...b, text: redactString(b.text, c) };
              if (b.type === 'tool_use') {
                return { ...b, input: redactJson(b.input, c) as Record<string, unknown> };
              }
              return {
                ...b,
                ...(b.content === undefined
                  ? {}
                  : {
                      content:
                        typeof b.content === 'string'
                          ? redactString(b.content, c)
                          : b.content.map((t) => ({ ...t, text: redactString(t.text, c) })),
                    }),
              };
            }),
    })),
    ...(req.tools
      ? {
          tools: req.tools.map((t) => ({
            ...t,
            ...(t.description === undefined ? {} : { description: redactString(t.description, c) }),
          })),
        }
      : {}),
  };
  return { request, redactions: c.n };
}

/** Redacts a JSON value's strings (a tool call's input in a streamed answer). The value is copied. */
export function redactValue(v: unknown): { value: unknown; redactions: number } {
  const c: Counter = { n: 0 };
  return { value: redactJson(v, c), redactions: c.n };
}

/**
 * Redaction of a STREAMED answer (PLAN M10 follow-up): text arrives in pieces and a secret can be split
 * across them (`AKIA` | `IOSFODNN7EXAMPLE`), so a piece is never judged alone. Text is held in a buffer;
 * every `push` scans the whole buffer with the shared ruleset, replaces what it finds, and releases only
 * the part that cannot still be the start of a secret:
 *
 *   - the last `HOLD` characters stay in the buffer (a secret shorter than that cannot be cut by the release point);
 *   - the release point is moved back to the last whitespace, so a token is never cut in the middle;
 *   - an unclosed `-----BEGIN ...` block (a private key) holds everything from its start until `-----END`;
 *   - past `MAX_BUFFER` characters with no whitespace at all, text is released anyway (bounded memory).
 *
 * `flush` releases the rest at the end of the block, after a last scan. Whatever the buffer holds when
 * the stream is aborted is dropped, never delivered.
 */
export const STREAM_HOLD = 256;
export const STREAM_MAX_BUFFER = 65_536;

export class StreamRedactor {
  private buf = '';
  private n = 0;

  get redactions(): number {
    return this.n;
  }

  push(text: string): string {
    this.buf += text;
    this.scan();
    let cut = this.buf.length - STREAM_HOLD;
    if (cut <= 0) return '';
    if (this.buf.length <= STREAM_MAX_BUFFER) {
      let i = cut;
      while (i > 0 && !/\s/.test(this.buf[i - 1] as string)) i -= 1;
      cut = i;
    }
    const pem = this.buf.lastIndexOf('-----BEGIN');
    if (pem !== -1 && pem < cut && !this.buf.includes('-----END', pem)) cut = pem;
    if (cut <= 0) return '';
    const out = this.buf.slice(0, cut);
    this.buf = this.buf.slice(cut);
    return out;
  }

  flush(): string {
    this.scan();
    const out = this.buf;
    this.buf = '';
    return out;
  }

  private scan(): void {
    const c: Counter = { n: 0 };
    this.buf = redactString(this.buf, c);
    this.n += c.n;
  }
}
