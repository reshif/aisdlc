import {
  PROJECT_CONFIG_KEYS,
  ProjectLayerKey,
  type ConfigKeySummary,
  type ProjectLayerKey as Key,
} from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState, type ComponentType } from 'react';
import { api } from '../api';
import { Loading, PageError } from '../components/Notice';
import { ConfigConsole, type DraftEditorProps } from '../config/ConfigConsole';
import { GatingProfileEditor, RoleMapEditor, projectFloorProblems } from '../config/ProjectEditors';
import { Link } from '../router';
import { EmptyState, PageHead, Tabs } from '../ui';

// Project > Settings (P1-5): a project's settings after onboarding, the project layer of the one configuration
// pattern. One tab per key of the layer (the gating profile within the floors, the role map slot by people, two-person,
// release G5, WIP limit, default envelope, kill delegations): the value in force for the project, a draft, the diff,
// propose (an M1 at the project's admin slot, `project.settings.edit` on the server whatever this page shows), the
// pending revisions and the history.

const LABEL: Readonly<Record<Key, string>> = {
  'project.gating_profile': 'Approvals on or off',
  'project.role_map': 'Who decides',
  'project.two_person': 'Two-person approvals',
  'project.release': 'Releases',
  'project.wip_limit': 'Work-in-progress limit',
  'project.default_envelope': 'Default budget',
  'project.kill_delegations': 'Who can stop agents',
};

const EDITORS: Partial<Record<Key, ComponentType<DraftEditorProps>>> = {
  [PROJECT_CONFIG_KEYS.gating_profile]: GatingProfileEditor,
  [PROJECT_CONFIG_KEYS.role_map]: RoleMapEditor,
};

export function ProjectSettingsPage({ id, csrf }: { id: string; csrf: string }) {
  return (
    <>
      <PageHead
        crumbs={[
          { label: 'Projects', to: '/projects' },
          { label: id, to: `/projects/${id}` },
          { label: 'Settings' },
        ]}
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
        eyebrow="Project"
        title="Settings"
        sub="This project's approvals, who decides them and its limits. A change is proposed here and takes effect once the project's admin approves it."
      />
      <ProjectSettingsPanel id={id} csrf={csrf} />
    </>
  );
}

/** The project layer's keys, one tab each (portal v2: also the Settings tab of the project page). */
export function ProjectSettingsPanel({ id, csrf }: { id: string; csrf: string }) {
  const q = useQuery({
    queryKey: ['project-config-keys', id],
    queryFn: () => api.projectConfigKeys(id),
  });
  const [tab, setTab] = useState<string | null>(null);
  if (q.isPending) return <Loading what="the project's settings" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const keys = q.data.keys.filter(
    (k): k is ConfigKeySummary & { key: Key } => ProjectLayerKey.safeParse(k.key).success,
  );
  if (keys.length === 0) {
    return (
      <EmptyState title="No settings">The factory has no project settings registered.</EmptyState>
    );
  }
  const selected = keys.find((k) => k.key === tab)?.key ?? (keys[0] as { key: Key }).key;
  const editor = EDITORS[selected];
  return (
    <>
      {!q.data.may_propose ? (
        <p className="muted" data-testid="settings-read-only">
          You may read these settings; only the project&rsquo;s admins propose a change.
        </p>
      ) : null}
      <Tabs
        label="Project settings"
        tabs={keys.map((k) => ({ id: k.key, label: LABEL[k.key] }))}
        selected={selected}
        onSelect={setTab}
      >
        <ConfigConsole
          key={selected}
          configKey={selected}
          csrf={csrf}
          layer={{ kind: 'project', project: id }}
          {...(editor ? { editor } : {})}
          problemsOf={projectFloorProblems(selected)}
        />
      </Tabs>
    </>
  );
}
