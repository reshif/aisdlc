import { ConfigKey, type ConfigDoc, type ConfigLayerKind } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { z } from 'zod';
import { configError, type ConfigError } from './errors.js';

// The registry of config keys (PLAN M3.5). A document is a flat map of dotted keys; every key a
// document may hold is registered here with a Zod schema, a default and whether a project layer may
// override it. A key nobody registered is refused, so a typo can never become a setting, and an ops
// flag is just a boolean key. Schemas must be JSON in, JSON out: the validated value is what gets
// hashed and stored.

export type ConfigKind = 'setting' | 'ops_flag';

export interface ConfigKeyDef<T = unknown> {
  readonly key: string;
  readonly kind: ConfigKind;
  readonly schema: z.ZodType<T>;
  /** Used when no published layer sets the key. */
  readonly default: T;
  /** May a project layer set it? `false`: factory only (the safe default for anything global). */
  readonly overridable: boolean;
  readonly description: string;
}

/**
 * A rule across keys: it sees the whole validated document (every key at its parsed value, defaults
 * filled in for the keys the document leaves out) and returns the problems it finds. For what no single
 * key's schema can say, such as "an install names an integration that exists".
 */
export interface ConfigDocRule {
  readonly name: string;
  check(values: Readonly<Record<string, unknown>>): readonly string[];
}

export class ConfigRegistry {
  private readonly defs = new Map<string, ConfigKeyDef>();
  private readonly rules: ConfigDocRule[] = [];

  /** Registers a cross-key rule; `validate` refuses a document that breaks it. */
  rule(r: ConfigDocRule): this {
    this.rules.push(r);
    return this;
  }

  /** Registers a setting. Throws on a bad key, a duplicate, or a default its own schema refuses. */
  setting<T>(def: {
    key: string;
    schema: z.ZodType<T>;
    default: T;
    overridable?: boolean;
    description: string;
  }): this {
    return this.add({ ...def, kind: 'setting', overridable: def.overridable ?? false });
  }

  /** Registers an ops flag: a boolean setting (kill delegations, feature flags). */
  opsFlag(def: {
    key: string;
    default: boolean;
    overridable?: boolean;
    description: string;
  }): this {
    return this.add({
      ...def,
      kind: 'ops_flag',
      schema: z.boolean(),
      overridable: def.overridable ?? false,
    });
  }

  private add<T>(def: ConfigKeyDef<T>): this {
    if (!ConfigKey.safeParse(def.key).success) {
      throw new RangeError(`config key ${def.key} is not a dotted lowercase key`);
    }
    if (this.defs.has(def.key)) throw new RangeError(`config key ${def.key} is registered twice`);
    const d = def.schema.safeParse(def.default);
    if (!d.success) throw new RangeError(`default of ${def.key} fails its own schema`);
    this.defs.set(def.key, def as ConfigKeyDef);
    return this;
  }

  get(key: string): ConfigKeyDef | undefined {
    return this.defs.get(key);
  }

  keys(): string[] {
    return [...this.defs.keys()].sort();
  }

  /** Every default, by key. */
  defaults(): Record<string, unknown> {
    return Object.fromEntries([...this.defs].map(([k, d]) => [k, d.default]));
  }

  /**
   * Validates a full document for a layer and returns it with every value as its schema parsed it.
   * Refuses: a non-object, an unknown key, a value its schema refuses, and (project layer) a key
   * that is not overridable. All problems are listed in the message.
   */
  validate(layer: ConfigLayerKind, doc: unknown): Result<ConfigDoc, ConfigError> {
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
      return err(configError('invalid_input', 'a config document is a JSON object'));
    }
    const out: Record<string, unknown> = {};
    const problems: string[] = [];
    let code: 'unknown_key' | 'invalid_value' | 'not_overridable' | null = null;
    const note = (c: NonNullable<typeof code>, m: string) => {
      problems.push(m);
      code ??= c;
    };
    for (const [key, value] of Object.entries(doc)) {
      const def = this.defs.get(key);
      if (!def) {
        note('unknown_key', `unknown config key ${key}`);
        continue;
      }
      if (layer === 'project' && !def.overridable) {
        note('not_overridable', `${key} cannot be set by a project`);
        continue;
      }
      const parsed = def.schema.safeParse(value);
      if (!parsed.success) {
        note('invalid_value', `${key}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
        continue;
      }
      out[key] = parsed.data;
    }
    if (code !== null) return err(configError(code, problems.join('; ')));
    const whole = { ...this.defaults(), ...out };
    for (const rule of this.rules) {
      for (const p of rule.check(whole)) note('invalid_value', `${rule.name}: ${p}`);
    }
    if (code !== null) return err(configError(code, problems.join('; ')));
    return ok(out);
  }
}
