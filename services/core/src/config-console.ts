import {
  CardDeciders,
  ConfigKeyView,
  ConfigProposeResult,
  FACTORY_PROJECT_ID,
  FACTORY_SCOPE,
  type ConfigKeyRevision,
  type ConfigKeySummary,
  type ConfigLineage,
  type ConfigPending,
  type PrincipalId,
} from '@aisdlc/contracts';
import {
  listRevisions,
  proposeRevision,
  type ConfigDeps,
  type ConfigError,
  type ConfigKeyDef,
} from '@aisdlc/config';
import { readGateState } from '@aisdlc/decisions';
import { canonicalJson, err, ok, type Result } from '@aisdlc/kernel';
import { z } from 'zod';
import { decidersFrom } from './cards/views.js';
import { coreError, type CoreError } from './errors.js';

// The configuration console's core side (portal-coverage §6): any key registered in core's config
// registry, on the FACTORY layer. A read folds the lineage (`listRevisions`, i.e. the record and the
// ledger) into the key's effective value with where it came from, the pending proposals with who
// decides their M1 gate, and the history. A proposal is `proposeRevision` with the head document and
// this one key changed: the existing M1 path, nothing new. Nothing here publishes.

const FACTORY: ConfigLineage = { layer: 'factory', scope: FACTORY_SCOPE };

export function keySummary(def: ConfigKeyDef): ConfigKeySummary {
  let schema: Record<string, unknown>;
  try {
    schema = { ...z.toJSONSchema(def.schema, { target: 'draft-2020-12', io: 'input' }) };
    delete schema['$schema'];
  } catch {
    // A schema JSON Schema cannot express (a transform): the console falls back to raw JSON.
    schema = {};
  }
  return {
    key: def.key,
    kind: def.kind,
    description: def.description,
    overridable: def.overridable,
    json_schema: schema,
  };
}

export function listConfigKeys(deps: ConfigDeps): ConfigKeySummary[] {
  return deps.registry
    .keys()
    .map((k) => deps.registry.get(k))
    .filter((d): d is ConfigKeyDef => d !== undefined)
    .map(keySummary);
}

const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export async function configKeyView(
  deps: ConfigDeps,
  key: string,
): Promise<Result<ConfigKeyView, CoreError>> {
  const def = deps.registry.get(key);
  if (!def) return err(coreError('not_found', `no config key ${key}`));
  const revs = await listRevisions(deps, FACTORY);
  const byHash = new Map(revs.map((r) => [r.rev_hash, r]));
  const valueIn = (r: (typeof revs)[number]) =>
    key in r.content ? { value: r.content[key], set: true } : { value: def.default, set: false };

  const rows: ConfigKeyRevision[] = revs.map((r) => {
    const here = valueIn(r);
    const parent = r.previous_rev_hash === null ? undefined : byHash.get(r.previous_rev_hash);
    const before = parent ? valueIn(parent).value : def.default;
    return {
      rev_hash: r.rev_hash,
      parent_rev_hash: r.previous_rev_hash,
      state: r.state,
      gate_instance_id: r.gate_instance_id,
      ledger_entry_id: r.ledger_entry_id,
      proposed_by: r.proposed_by,
      proposed_at: r.proposed_at,
      published_at: r.published_at,
      value: here.set ? here.value : null,
      set: here.set,
      changes_key: !same(here.value, before),
    };
  });

  const current = rows.find((r) => r.state === 'current') ?? null;
  const effective = current?.set
    ? {
        value: current.value,
        source: 'revision' as const,
        rev_hash: current.rev_hash,
        gate_instance_id: current.gate_instance_id,
        ledger_entry_id: current.ledger_entry_id,
        published_at: current.published_at,
      }
    : {
        value: def.default,
        source: 'default' as const,
        rev_hash: current?.rev_hash ?? null,
        gate_instance_id: current?.gate_instance_id ?? null,
        ledger_entry_id: current?.ledger_entry_id ?? null,
        published_at: current?.published_at ?? null,
      };

  const pending: ConfigPending[] = [];
  const deciders = CardDeciders.parse(
    await decidersFrom(deps.eligibility, FACTORY_PROJECT_ID, 'admin'),
  );
  for (const r of rows.filter((x) => x.state === 'proposed')) {
    const gate = r.gate_instance_id ? await readGateState(deps.pool, r.gate_instance_id) : null;
    pending.push({ revision: r, gate_status: gate?.status ?? null, deciders });
  }

  return ok(
    ConfigKeyView.parse({
      key: keySummary(def),
      default: def.default,
      effective,
      head_rev_hash: current?.rev_hash ?? null,
      pending,
      history: [...rows].reverse(),
    }),
  );
}

const STATUS_OF: Readonly<Record<ConfigError['code'], CoreError['code']>> = {
  invalid_input: 'invalid_input',
  unknown_key: 'invalid_input',
  invalid_value: 'invalid_input',
  not_overridable: 'invalid_input',
  unchanged: 'conflict',
  stale_parent: 'conflict',
  revision_not_found: 'not_found',
  not_decided: 'conflict',
  decision: 'refused',
  database: 'database',
};

/**
 * Proposes `value` for `key` on the factory layer: the head document with this key replaced, as a
 * new revision with its M1 gate (`proposeRevision`). The registry validates the whole document, so a
 * value its schema refuses is refused here, before any approver sees it.
 */
export async function proposeConfigKey(
  deps: ConfigDeps,
  input: {
    key: string;
    value: unknown;
    principal: PrincipalId;
    parent_rev_hash: string | null;
  },
): Promise<Result<ConfigProposeResult, CoreError>> {
  const def = deps.registry.get(input.key);
  if (!def) return err(coreError('not_found', `no config key ${input.key}`));
  const revs = await listRevisions(deps, FACTORY);
  const head = revs.find((r) => r.state === 'current') ?? null;
  if ((head?.rev_hash ?? null) !== input.parent_rev_hash) {
    return err(
      coreError(
        'conflict',
        `stale_parent: the value changed since the draft was made (head ${head?.rev_hash ?? 'none'})`,
      ),
    );
  }
  const doc = { ...(head?.content ?? {}), [input.key]: input.value };
  const r = await proposeRevision(deps, {
    layer: 'factory',
    doc,
    proposed_by: input.principal,
    parent_rev_hash: input.parent_rev_hash,
  });
  if (!r.ok) return err(coreError(STATUS_OF[r.error.code], `${r.error.code}: ${r.error.message}`));
  return ok(
    ConfigProposeResult.parse({
      rev_hash: r.value.rev_hash,
      parent_rev_hash: r.value.parent_rev_hash,
      gate_instance_id: r.value.gate_instance_id,
      superseded: [...r.value.superseded],
    }),
  );
}
