import {
  AgentsSettingsConfig,
  GATEWAY_CONFIG_KEYS,
  GatewayModels,
  SETTINGS_KEYS,
  label,
  lookupTerm,
  type AgentRegistryRow,
  type AgentSettingsRow,
  type EvalRunHeader,
} from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type ConfigKeyWire } from '../api';
import { Read } from '../components/Read';
import { Link } from '../router';
import { ChangeActions } from '../settings/ChangeActions';
import { EmptyState, InfoTip, Modal, PageHeader, Pill, Table, type Column } from '../ui';
import '../settings/settings.css';

// Agents (screen map §2.14): every agent, on or off, its model, limits and quality. The agent's definition is code
// (its steps, tools, most sensitive data and prompt); what the factory owner changes is `agents.config` (on/off,
// models, budget, turns and time limits), one settings change like any other: preview, propose, or apply now as the
// factory admin. Reading is `quality.read` on the fleet; the settings view also needs the right to read settings.

export const AGENTS_KEY = SETTINGS_KEYS.agents_settings;

export const agentName = (id: string) => lookupTerm('agent', id)?.label ?? 'Unnamed agent';
export const agentWhat = (id: string) => lookupTerm('agent', id)?.explain ?? '';

/** The agents config in force, or `null` when this person may not read it (shown as "the contract's"). */
export function useAgentsConfig() {
  return useQuery({
    queryKey: ['config', AGENTS_KEY],
    queryFn: () => api.configKey(AGENTS_KEY),
    retry: false,
  });
}

export function useModelIds() {
  return useQuery({
    queryKey: ['config', GATEWAY_CONFIG_KEYS.models],
    queryFn: () => api.configKey(GATEWAY_CONFIG_KEYS.models),
    retry: false,
    select: (v: ConfigKeyWire) => {
      const m = GatewayModels.safeParse(v.effective.value);
      return m.success ? m.data.map((x) => x.model_id) : [];
    },
  });
}

export function rowsOf(v: ConfigKeyWire | undefined): AgentsSettingsConfig {
  const p = AgentsSettingsConfig.safeParse(v?.effective.value ?? {});
  return p.success ? p.data : {};
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
export const isOn = (row: AgentSettingsRow | undefined) => row?.enabled !== false;

/** The newest eval run per agent (runs come newest first). */
const newestByAgent = (runs: readonly EvalRunHeader[]) => {
  const m = new Map<string, EvalRunHeader>();
  for (const r of runs) if (!m.has(r.agent_id)) m.set(r.agent_id, r);
  return m;
};

/** Turn one agent on or off: the preview and the change in a dialog. */
export function ToggleAgent({
  a,
  cfg,
  csrf,
}: {
  a: AgentRegistryRow;
  cfg: ConfigKeyWire;
  csrf: string;
}) {
  const [open, setOpen] = useState(false);
  const rows = rowsOf(cfg);
  const on = isOn(rows[a.agent_id]);
  const draft: AgentsSettingsConfig = {
    ...rows,
    [a.agent_id]: { ...rows[a.agent_id], enabled: !on },
  };
  const name = agentName(a.agent_id);
  const verb = on ? 'Turn off' : 'Turn on';
  return (
    <>
      <button
        type="button"
        className="ui-btn ui-btn-sm"
        disabled={!cfg.may_propose}
        onClick={() => setOpen(true)}
      >
        {verb} {name}
      </button>
      <Modal open={open} title={`${verb} ${name}?`} onClose={() => setOpen(false)}>
        <p>
          {on
            ? 'An agent that is off runs nothing: work that needs it waits, and it is recorded once.'
            : 'The agent runs again at its next step.'}
        </p>
        <ChangeActions
          configKey={AGENTS_KEY}
          draft={draft}
          parent={cfg.head_rev_hash}
          csrf={csrf}
          mayApplyNow={cfg.may_apply_now === true}
          blocked={null}
          onDone={() => setOpen(false)}
        />
      </Modal>
    </>
  );
}

export function AgentsPage({ csrf }: { csrf: string }) {
  const reg = useQuery({ queryKey: ['agents'], queryFn: api.agents });
  const runs = useQuery({ queryKey: ['eval-runs'], queryFn: api.evalRuns, retry: false });
  const cfg = useAgentsConfig();
  return (
    <>
      <PageHeader
        title={label('screen', 'agents')}
        meta="Turn an agent on or off, choose its model and limits, and see how well it works. What an agent may do is part of its definition and cannot be widened here."
        actions={
          <Link to="/evals" className="ui-btn">
            {label('screen', 'evals')}
          </Link>
        }
      />
      <Read q={reg} what="the agents">
        {(v) => {
          const newest = newestByAgent(runs.data?.runs ?? []);
          const rows = rowsOf(cfg.data);
          const agents = v.agents.filter((a) => a.steps.length + a.specialist_steps.length > 0);
          const cols: ReadonlyArray<Column<AgentRegistryRow>> = [
            {
              key: 'agent',
              header: 'Agent',
              rowHeader: true,
              render: (a) => (
                <>
                  <Link to={`/agents/${encodeURIComponent(a.agent_id)}`}>
                    <b>{agentName(a.agent_id)}</b>
                  </Link>
                  <div className="muted">{agentWhat(a.agent_id)}</div>
                </>
              ),
            },
            {
              key: 'on',
              header: 'On or off',
              render: (a) =>
                cfg.isError ? (
                  <span className="muted">Unknown</span>
                ) : isOn(rows[a.agent_id]) ? (
                  <Pill tone="ok">On</Pill>
                ) : (
                  <Pill tone="bad">Off</Pill>
                ),
            },
            {
              key: 'model',
              header: 'Model',
              render: (a) => (rows[a.agent_id]?.models ?? a.models).join(', ') || 'none',
            },
            {
              key: 'steps',
              header: 'Works at',
              render: (a) =>
                [...a.steps, ...a.specialist_steps].map((s) => label('step', s)).join(', '),
            },
            {
              key: 'score',
              header: 'Latest evaluation',
              align: 'right',
              render: (a) => {
                const r = newest.get(a.agent_id);
                if (runs.isError) return <span className="muted">Unknown</span>;
                return r ? pct(r.pass_rate) : <span className="muted">No evaluation yet</span>;
              },
            },
            {
              key: 'act',
              header: 'Change',
              render: (a) =>
                cfg.data && cfg.data.may_propose ? (
                  <ToggleAgent a={a} cfg={cfg.data} csrf={csrf} />
                ) : (
                  <span className="muted">Read only</span>
                ),
            },
          ];
          return (
            <section aria-labelledby="agents-h">
              <h2 id="agents-h" className="st-h2">
                Every agent{' '}
                <InfoTip
                  about="agents"
                  text="An agent that is off runs nothing; its model and limits apply from its next run."
                />
              </h2>
              <Table
                caption="Agents"
                captionHidden
                columns={cols}
                rows={agents}
                rowKey={(a) => a.agent_id}
                empty={<EmptyState title="No agent is defined" />}
              />
            </section>
          );
        }}
      </Read>
    </>
  );
}
