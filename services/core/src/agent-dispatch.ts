import {
  agentEnabled,
  agentKeyRequest,
  primaryAgentFor,
  specialistAgentFor,
  withAgentSettings,
} from '@aisdlc/agents';
import {
  AGENT_EVENT,
  AgentRunDispatchedPayload,
  STEPS,
  agentStream,
  type AgentBinding,
  type AgentsSettingsConfig,
  type AgentRunFailureCode,
  type AgentRunFailedPayload,
  type ItemCommand,
  type RecordEvent,
  type VKeyMint,
} from '@aisdlc/contracts';
import { deterministicId, err, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import type { AgentKeyPort, RunKeyVault } from '@aisdlc/ports';
import type { ItemState } from '@aisdlc/work';
import { coreError, type CoreError } from './errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from './journal.js';

// Where the work driver meets the agent registry (PLAN M11.2). When it is about to hand a stage command
// to a port and the step is agent-acted, it
//   1. picks the agent the registry says acts at the step (`primaryAgentFor`),
//   2. mints a per-Unit (S6) or per-job (every other step) virtual key through the gateway admin API,
//      carrying EXACTLY the agent contract's tool allow-list, data class and budget, nothing from the
//      request, the repo or the agent,
//   3. records `agent.run_dispatched` (the agent, contract, prompt sha and the key's id, never its
//      secret) on the item's `agent:` stream BEFORE the port is called,
// and gives the port the binding. A redelivery of the same command finds the dispatch already recorded
// and uses it: one command, one run, one key. Fail closed: if a key is wanted and cannot be minted, the
// port is not called; the failure is recorded and the command is delivered again later.

export const AGENT_ACTOR = 'system.agents';

type RunStage = Extract<ItemCommand, { type: 'run_stage' }>;

/** One command, one run id (a redelivery is the same run). */
export const agentRunIdOf = (commandKey: string): string =>
  deterministicId<'AgentRun'>(`aisdlc.agent_run:${commandKey}`);

const hashOf = (s: string): string => sha256Hex(s).slice(0, 32);

export interface AgentDispatchDeps extends CoreDeps {
  /** Where keys come from. Absent: no key is minted and the run records `vkey_id: null` (a test of something else). */
  readonly keys?: AgentKeyPort;
  /**
   * Where the key's secret goes (M12): the in-process seam between this dispatch and the stage port that
   * calls the gateway (`RunKeyLender`). The secret is put here the moment the gateway mints it and is
   * never recorded: the dispatch event has the key's ID only. Absent: the secret is dropped as before
   * (a port that needs it, the sandbox of M13, gets it by its own channel).
   */
  readonly vault?: RunKeyVault;
  /**
   * Portal v2 (`agents.config`, M1-gated): each agent on or off, its models and its budget. `null`: the published
   * value does not read, and nothing is dispatched (fail closed). Absent: the contracts' values (tests of other things).
   */
  readonly agentSettings?: () => AgentsSettingsConfig | null;
}

/** The latest dispatch recorded for a command, if any (a lost secret is re-minted: a later dispatch). */
async function recorded(
  d: CoreDeps,
  itemId: string,
  commandKey: string,
): Promise<AgentRunDispatchedPayload | null> {
  const q = await d.pool.query<{ body: unknown }>(
    `SELECT body FROM record.record_event
      WHERE stream = $1 AND type = $2 AND body ->> 'command_key' = $3
      ORDER BY seq DESC LIMIT 1`,
    [agentStream(itemId), AGENT_EVENT.run_dispatched, commandKey],
  );
  const row = q.rows[0];
  return row ? AgentRunDispatchedPayload.parse(row.body) : null;
}

/**
 * Binds the agent for a stage command, minting its key. `null`: no agent acts at the step. A refused
 * key is an `unavailable` error after the failure is recorded; the caller lets the outbox retry.
 */
export async function dispatchAgent(
  d: AgentDispatchDeps,
  s: ItemState,
  c: RunStage,
): Promise<Result<AgentBinding | null, CoreError>> {
  const contractDef = primaryAgentFor(c.step) ?? specialistAgentFor(c.step);
  if (contractDef === null) return ok(null);
  // Portal v2: the factory's settings for the agent (models, budget; tools and data class stay the contract's)
  const table = d.agentSettings ? d.agentSettings() : undefined;
  const def = table ? withAgentSettings(contractDef, table[contractDef.agent_id]) : contractDef;

  const prior = await recorded(d, s.item_id, c.key);
  const lost =
    prior !== null &&
    d.vault !== undefined &&
    d.keys !== undefined &&
    prior.binding.vkey_id !== null &&
    d.vault.keyOf(prior.run_id) !== prior.binding.vkey_id;
  if (prior && !lost) return ok(prior.binding);

  if (table === null || (table && !agentEnabled(table, def.agent_id))) {
    const why =
      table === null
        ? 'the published agents.config does not read'
        : `agent ${def.agent_id} is switched off (agents.config)`;
    await recordFailure(
      d,
      s,
      c,
      {
        run_id: agentRunIdOf(c.key),
        agent_id: def.agent_id,
        contract_version: def.contract.contract_version,
        prompt_ref: def.prompt.ref,
        prompt_sha256: def.prompt.sha256,
        tools: [...def.contract.tools],
        data_class_max: def.contract.data_class_max,
        vkey_id: null,
      },
      'agent_disabled',
      why,
    );
    return err(coreError('unavailable', why));
  }

  const run_id = agentRunIdOf(c.key);
  const contract = def.contract;
  const now = clockOf(d).now();
  const isUnit = STEPS[c.step].stage === 'S6';
  // The Unit is the item until M13 gives the item Units of its own (one Unit per item today).
  const scope = isUnit
    ? { kind: 'unit' as const, ref: s.item_id }
    : { kind: 'job' as const, ref: hashOf(c.key) };
  const group = isUnit ? `unit:${s.item_id}:${def.agent_id}` : `job:${hashOf(c.key)}`;
  const base = {
    run_id,
    agent_id: def.agent_id,
    contract_version: contract.contract_version,
    prompt_ref: def.prompt.ref,
    prompt_sha256: def.prompt.sha256,
    tools: [...contract.tools],
    data_class_max: contract.data_class_max,
  };

  let vkey_id: string | null = null;
  if (d.keys) {
    // exactly the contract's allow-list: `agentKeyRequest` has no argument that can add to it
    const k = await d.keys.mint(
      agentKeyRequest(def, {
        scope,
        group,
        project_id: s.project_id as VKeyMint['project_id'],
        lane: c.lane,
        item_id: s.item_id,
        step: c.step,
        now,
        ...(isUnit ? { unit_id: s.item_id } : {}),
      }),
    );
    if (!k.ok) {
      await recordFailure(d, s, c, { ...base, vkey_id: null }, 'key_mint_refused', k.error.message);
      return err(coreError('unavailable', `no key for ${def.agent_id}: ${k.error.message}`));
    }
    vkey_id = k.value.vkey.vkey_id;
    // the secret stays in this process, for the port that runs the command; it is in no event
    d.vault?.put(run_id, vkey_id, k.value.secret);
    // the key whose secret this process lost (a restart after the first dispatch) is of no use to anyone
    if (prior?.binding.vkey_id) await d.keys.revoke?.(prior.binding.vkey_id);
  }

  const binding: AgentBinding = { ...base, vkey_id };
  const payload = AgentRunDispatchedPayload.parse({
    run_id,
    item_id: s.item_id,
    project_id: s.project_id,
    command_key: c.key,
    step: c.step,
    attempt: c.attempt,
    lane: c.lane,
    binding,
    budget: contract.budget,
    scope: vkey_id === null ? null : scope,
    unit_id: vkey_id !== null && isUnit ? s.item_id : null,
  });
  const w = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [`agent:${s.item_id}`]);
    const r = await j.emitAll(agentStream(s.item_id), [
      {
        type: AGENT_EVENT.run_dispatched,
        body: payload as unknown as Record<string, unknown>,
        actor: AGENT_ACTOR,
        // a re-mint (the secret was lost with a restart) is a later dispatch of the same command
        idempotency_key:
          prior?.binding.vkey_id && vkey_id !== null
            ? `agent.dispatched:${c.key}:after:${prior.binding.vkey_id}`
            : `agent.dispatched:${c.key}`,
      },
    ]);
    return r.ok ? ok(r.value.events) : r;
  });
  if (!w.ok) return w;
  // a concurrent worker may have recorded first: its key is the run's key
  const stored = (w.value as RecordEvent[])[0];
  return ok(stored ? AgentRunDispatchedPayload.parse(stored.payload).binding : binding);
}

/**
 * The command is answered: the run's secret is forgotten and its per-job key ended (a Unit's key outlives
 * its command and is the sandbox's). A failure to revoke is not the command's: the key expires on its own.
 */
export async function releaseRun(
  d: AgentDispatchDeps,
  c: RunStage,
  binding: AgentBinding,
): Promise<void> {
  d.vault?.drop(binding.run_id);
  if (binding.vkey_id !== null && STEPS[c.step].stage !== 'S6') {
    await d.keys?.revoke?.(binding.vkey_id).catch(() => undefined);
  }
}

/** Records that core could not carry a run (once per command and code; a retry is not a second failure). */
export async function recordFailure(
  d: CoreDeps,
  s: ItemState,
  c: RunStage,
  binding: AgentBinding,
  code: AgentRunFailureCode,
  detail: string,
): Promise<Result<void, CoreError>> {
  const payload: AgentRunFailedPayload = {
    run_id: binding.run_id,
    item_id: s.item_id as AgentRunFailedPayload['item_id'],
    project_id: s.project_id as AgentRunFailedPayload['project_id'],
    command_key: c.key,
    step: c.step,
    attempt: c.attempt,
    lane: c.lane,
    binding,
    code,
    detail: detail.slice(0, 300),
  };
  const r = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [`agent:${s.item_id}`]);
    const w = await j.emitAll(agentStream(s.item_id), [
      {
        type: AGENT_EVENT.run_failed,
        body: payload as unknown as Record<string, unknown>,
        actor: AGENT_ACTOR,
        idempotency_key: `agent.failed:${c.key}:${code}`,
      },
    ]);
    return w.ok ? ok(undefined) : w;
  });
  return r;
}
