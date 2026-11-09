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
