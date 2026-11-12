import { SECRET_REF_PATTERN, SecretRef } from '@aisdlc/contracts';
import { useEffect, useId, useState } from 'react';
import type { JsonSchema } from '../lib/schema';

// A form generated from a key's JSON Schema (the server sends it, generated from the key's Zod
// schema in the contracts: nothing is listed here). Objects with named properties, arrays, strings
// (an enum is a select), integers and numbers, booleans; anything else (a union, a record) is edited
// as JSON. A secret-reference field (the contracts' `SecretRef`) is edited as a reference and never
// holds a secret: the form says so, and the server refuses anything else.

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A string field whose pattern is the contracts' secret-reference pattern. */
export const isSecretRefSchema = (s: JsonSchema): boolean =>
  s['type'] === 'string' && s['pattern'] === SECRET_REF_PATTERN.source;
export const looksLikeSecretRef = (v: unknown): boolean =>
  typeof v === 'string' && SecretRef.safeParse(v).success;

type Kind = 'object' | 'array' | 'string' | 'integer' | 'number' | 'boolean' | 'json';

function kindOf(s: JsonSchema): Kind {
  if (Array.isArray(s['anyOf']) || Array.isArray(s['oneOf']) || Array.isArray(s['allOf'])) {
    return 'json';
  }
  const t = s['type'];
  if (t === 'object') return isObj(s['properties']) ? 'object' : 'json';
  if (t === 'array') return isObj(s['items']) ? 'array' : 'json';
  if (t === 'string' || t === 'integer' || t === 'number' || t === 'boolean') return t;
  return 'json';
}

/** A starting value that fits the schema's shape (the server still validates it). */
export function defaultFor(s: JsonSchema): unknown {
  if ('default' in s) return s['default'];
  if ('const' in s) return s['const'];
  const e = s['enum'];
  if (Array.isArray(e) && e.length > 0) return e[0];
  switch (kindOf(s)) {
    case 'object': {
      const props = s['properties'] as Record<string, JsonSchema>;
      const req = Array.isArray(s['required']) ? (s['required'] as string[]) : [];
      return Object.fromEntries(req.map((k) => [k, defaultFor(props[k] ?? {})]));
    }
    case 'array':
      return [];
    case 'string':
      return '';
    case 'integer':
    case 'number':
      return typeof s['minimum'] === 'number' ? s['minimum'] : 0;
    case 'boolean':
      return false;
    case 'json':
      return s['type'] === 'object' ? {} : null;
  }
}

interface FieldProps {
  readonly schema: JsonSchema;
  readonly value: unknown;
  readonly onChange: (v: unknown) => void;
  readonly label: string;
  readonly disabled?: boolean;
}

function JsonField({ value, onChange, label, disabled }: FieldProps) {
  const id = useId();
  const [text, setText] = useState(() => JSON.stringify(value ?? null, null, 2));
  const [bad, setBad] = useState(false);
  useEffect(() => {
    // follow a reset from outside (the effective value loaded again)
    setText((t) => {
      try {
        return JSON.stringify(JSON.parse(t)) === JSON.stringify(value ?? null)
          ? t
          : JSON.stringify(value ?? null, null, 2);
      } catch {
        return t;
      }
    });
  }, [value]);
  return (
    <div className="field">
      <label htmlFor={id}>
        {label} <span className="muted">(JSON)</span>
      </label>
      <textarea
        id={id}
        className="cfg-json"
        rows={Math.min(14, Math.max(3, text.split('\n').length))}
        value={text}
        disabled={disabled}
        aria-invalid={bad}
        onChange={(e) => {
          setText(e.target.value);
          try {
            onChange(JSON.parse(e.target.value));
            setBad(false);
          } catch {
            setBad(true);
          }
        }}
      />
      {bad ? <p className="hint">This is not valid JSON yet.</p> : null}
    </div>
  );
}

export function SchemaField(p: FieldProps) {
  const id = useId();
  const { schema, value, onChange, label, disabled } = p;
  const kind = kindOf(schema);
  const help = typeof schema['description'] === 'string' ? schema['description'] : null;

  if (kind === 'object') {
    const props = schema['properties'] as Record<string, JsonSchema>;
    const req = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);
    const obj = isObj(value) ? value : {};
    return (
      <fieldset className="cfg-group">
        <legend>{label}</legend>
        {help ? <p className="hint">{help}</p> : null}
        {Object.entries(props).map(([k, sub]) => {
          const present = k in obj;
          const set = (v: unknown) => onChange({ ...obj, [k]: v });
          if (req.has(k)) {
            return (
              <SchemaField
                key={k}
                schema={sub}
                value={obj[k]}
                onChange={set}
                label={k}
                {...(disabled ? { disabled } : {})}
              />
            );
          }
          return (
            <div key={k} className="cfg-optional">
              <label className="check">
                <input
                  type="checkbox"
                  checked={present}
                  disabled={disabled}
                  onChange={(e) => {
                    if (e.target.checked) set(defaultFor(sub));
                    else {
                      const { [k]: _gone, ...rest } = obj;
                      void _gone;
                      onChange(rest);
                    }
                  }}
                />
                Set {k} <span className="muted">(optional)</span>
              </label>
              {present ? (
                <SchemaField
                  schema={sub}
                  value={obj[k]}
                  onChange={set}
                  label={k}
                  {...(disabled ? { disabled } : {})}
                />
              ) : null}
            </div>
          );
        })}
      </fieldset>
    );
  }

  if (kind === 'array') {
    const items = schema['items'] as JsonSchema;
    const list = Array.isArray(value) ? value : [];
    const max = typeof schema['maxItems'] === 'number' ? schema['maxItems'] : Infinity;
    return (
      <fieldset className="cfg-group">
        <legend>{label}</legend>
        {help ? <p className="hint">{help}</p> : null}
        {list.length === 0 ? <p className="muted">No entries.</p> : null}
        <ol className="cfg-list">
          {list.map((v, i) => (
            <li key={i}>
              <SchemaField
                schema={items}
                value={v}
                label={`${label} ${i + 1}`}
                onChange={(nv) => onChange(list.map((x, j) => (j === i ? nv : x)))}
                {...(disabled ? { disabled } : {})}
              />
              <button
                type="button"
                className="ui-btn ui-btn-sm ui-btn-ghost"
                disabled={disabled}
                onClick={() => onChange(list.filter((_, j) => j !== i))}
              >
                Remove {label} {i + 1}
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={disabled || list.length >= max}
          onClick={() => onChange([...list, defaultFor(items)])}
        >
          Add to {label}
        </button>
      </fieldset>
    );
  }

  if (kind === 'boolean') {
    return (
      <label className="check">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
      </label>
    );
  }

  if (kind === 'integer' || kind === 'number') {
    const min = typeof schema['minimum'] === 'number' ? schema['minimum'] : undefined;
    const max = typeof schema['maximum'] === 'number' ? schema['maximum'] : undefined;
    return (
      <div className="field">
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          type="number"
          inputMode={kind === 'integer' ? 'numeric' : 'decimal'}
          step={kind === 'integer' ? 1 : 'any'}
          {...(min !== undefined ? { min } : {})}
          {...(max !== undefined ? { max } : {})}
          disabled={disabled}
          value={typeof value === 'number' ? String(value) : ''}
          onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        />
        {min !== undefined || max !== undefined ? (
          <p className="hint">
            {min !== undefined ? `at least ${min}` : ''}
            {min !== undefined && max !== undefined ? ', ' : ''}
            {max !== undefined ? `at most ${max}` : ''}
          </p>
        ) : null}
      </div>
    );
  }

  if (kind === 'string') {
    const options = Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]) : null;
    if (options) {
      return (
        <div className="field">
          <label htmlFor={id}>{label}</label>
          <select
            id={id}
            value={String(value ?? '')}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
          >
            {options.map((o) => (
              <option key={String(o)} value={String(o)}>
                {String(o)}
              </option>
            ))}
          </select>
        </div>
      );
    }
    const secret = isSecretRefSchema(schema);
    return (
      <div className="field">
        <label htmlFor={id}>
          {label}
          {secret ? <span className="muted"> (a secret reference)</span> : null}
        </label>
        <input
          id={id}
          type="text"
          spellCheck={false}
          autoComplete="off"
          disabled={disabled}
          value={typeof value === 'string' ? value : ''}
          onChange={(e) => onChange(e.target.value)}
        />
        {secret ? (
          <p className="hint">
            Where the secret lives (<code>file:/path</code> or <code>env:NAME</code>), never the
            secret itself.
          </p>
        ) : null}
      </div>
    );
  }

  return <JsonField {...p} />;
}

/** One changed leaf between two JSON values. */
export interface Change {
  readonly path: string;
  readonly before: unknown;
  readonly after: unknown;
}

const ABSENT = Symbol('absent');

/** The leaves that differ, by path (`a.b[2]`); objects and arrays are compared element by element. */
export function diffValues(before: unknown, after: unknown, path = ''): Change[] {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) =>
      diffValues(
        k in before ? before[k] : ABSENT,
        k in after ? after[k] : ABSENT,
        path === '' ? k : `${path}.${k}`,
      ),
    );
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const n = Math.max(before.length, after.length);
    return Array.from({ length: n }, (_, i) =>
      diffValues(
        i < before.length ? before[i] : ABSENT,
        i < after.length ? after[i] : ABSENT,
        `${path}[${i}]`,
      ),
    ).flat();
  }
  return [
    {
      path: path === '' ? '(value)' : path,
      before: before === ABSENT ? undefined : before,
      after: after === ABSENT ? undefined : after,
    },
  ];
}
