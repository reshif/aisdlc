import { useQuery } from '@tanstack/react-query';
import {
  GATES,
  GatingProfile,
  PROJECT_CONFIG_KEYS,
  RoleMap,
  gatePolicy,
  label,
  lookupTerm,
  type GateId,
  type RoleSlot,
} from '@aisdlc/contracts';
import { api } from '../api';
import { describeError } from '../format';
import { Card, Table } from '../ui';

// "Reflection of onboarding to the floor, gates and all" (owner): which approvals each track will have on this
// project, and who decides each, read from the SAME settings in force that the work engine reads (the project's
// gating profile and role map, M1-published) over the current catalogue's tracks. Off means absent, never approved on
// its own; the always-required approvals cannot be switched off. Read-only: a change is made in Settings.

export interface TrackApprovalRow {
  readonly lane: string;
  readonly gates: ReadonlyArray<{ gate: GateId; on: boolean; who: string }>;
}

const whoOf = (map: RoleMap | null, slot: string): string => {
  const v = map?.[slot as RoleSlot];
  if (!v) return 'Nobody yet';
  if (v.kind === 'codeowners') return 'The code owners';
  return v.principals.length === 0 ? 'Nobody yet' : v.principals.join(', ');
};

/** Pure: the approvals of each track under a gating profile and a role map (exported for tests). */
export function trackApprovals(
  lanes: ReadonlyArray<{ lane: string; gates: ReadonlyArray<{ gate: GateId }> }>,
  profile: GatingProfile | null,
  map: RoleMap | null,
): TrackApprovalRow[] {
  return lanes.map((l) => ({
    lane: l.lane,
    gates: [...new Set(l.gates.map((g) => g.gate))].map((gate) => {
      const info = GATES[gate];
      const group = info.projectToggle;
      const byLane = group ? profile?.by_lane?.[l.lane as never]?.[group] : undefined;
      const sw = group ? (byLane ?? profile?.gates[group] ?? 'on') : 'on';
      return {
        gate,
        on: info.alwaysRequired || sw !== 'off',
        who: whoOf(map, gatePolicy(gate).slot),
      };
    }),
  }));
}

export function TrackApprovals({ project }: { project: string }) {
  const cat = useQuery({ queryKey: ['catalogue'], queryFn: api.catalogue, staleTime: 60_000 });
  const gp = useQuery({
    queryKey: ['project-config', project, PROJECT_CONFIG_KEYS.gating_profile],
    queryFn: () => api.projectConfigKey(project, PROJECT_CONFIG_KEYS.gating_profile),
    retry: false,
  });
  const rm = useQuery({
    queryKey: ['project-config', project, PROJECT_CONFIG_KEYS.role_map],
    queryFn: () => api.projectConfigKey(project, PROJECT_CONFIG_KEYS.role_map),
    retry: false,
  });
  if (cat.isPending || gp.isPending || rm.isPending) {
    return <p className="ui-help">Reading the approvals of each track…</p>;
  }
  if (cat.isError)
    return <p className="ui-help">The tracks could not be read ({describeError(cat.error)}).</p>;
  const current = cat.data.versions.find((v) => v.current) ?? cat.data.versions[0];
  const profile = gp.data ? GatingProfile.safeParse(gp.data.effective.value) : null;
  const map = rm.data ? RoleMap.safeParse(rm.data.effective.value) : null;
  const rows = trackApprovals(
    current?.lanes ?? [],
    profile?.success ? profile.data : null,
    map?.success ? map.data : null,
  );
  return (
    <Card title="Approvals each track will have" testId="track-approvals" flush>
      <Table
        caption="Approvals each track will have on this project"
        captionHidden
        rowKey={(r) => r.lane}
        rows={rows}
        empty={<p className="ui-help">No tracks.</p>}
        columns={[
          {
            key: 'lane',
            header: 'Track',
            rowHeader: true,
            render: (r) => lookupTerm('lane', r.lane)?.label ?? 'Unknown',
          },
          {
            key: 'gates',
            header: 'Approvals (who decides)',
            render: (r) => (
              <ul className="ob-list">
                {r.gates.map((g) => (
                  <li key={g.gate} data-gate={g.gate} data-on={g.on}>
                    {label('gate', g.gate)}: {g.on ? g.who : 'off'}
                  </li>
                ))}
              </ul>
            ),
          },
        ]}
      />
      {gp.isError || rm.isError ? (
        <p className="ui-help">
          This project&rsquo;s settings could not be read: the defaults are shown (every approval
          on).
        </p>
      ) : null}
    </Card>
  );
}
