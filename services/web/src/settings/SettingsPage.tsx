import {
  SettingsSection,
  label,
  lookupTerm,
  placementOf,
  term,
  type ConfigKeySummary,
} from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { ApiError, api } from '../api';
import { Loading, PageError } from '../components/Notice';
import { ConfigConsole } from '../config/ConfigConsole';
import { Link } from '../router';
import { EmptyState, InfoTip, PageHeader, Pill, Term } from '../ui';
import { fieldWord, valueWord } from './words';
import './settings.css';

// Settings (screen map §2.11): everything configurable for the factory, nothing hard-coded. Sections in plain words
// on the left; each setting shows what it does, when a change applies and what is in force; one setting opens in the
// configuration console (change, preview, propose or apply now, waiting for approval, history). The keys come from
// the registry (`GET /api/config/keys`); where each goes is `SETTING_PLACEMENTS` in the contracts.

const SECTIONS = SettingsSection.options;
export type SectionId = SettingsSection;

/** The plain name of a key; a key the glossary does not name reads by its description. */
export const keyName = (k: { key: string; description?: string }): string =>
  lookupTerm('configKey', k.key)?.label ?? k.description ?? 'Unnamed setting';
const keyTip = (k: ConfigKeySummary): string =>
  lookupTerm('configKey', k.key)?.explain ?? k.description;

export const settingHref = (key: string) =>
  `/settings/${placementOf(key).section}/${encodeURIComponent(key)}`;

const crumbsLink = (to: string, text: string) => <Link to={to}>{text}</Link>;

function useKeys() {
  return useQuery({ queryKey: ['config-keys'], queryFn: () => api.configKeys() });
}

function Frame({
  section,
  keys,
  children,
}: {
  section: SectionId | null;
  keys: readonly ConfigKeySummary[];
  children: ReactNode;
}) {
  const present = SECTIONS.filter((s) => keys.some((k) => placementOf(k.key).section === s));
  return (
    <div className="st-layout">
      <nav className="st-sections" aria-label="Settings sections">
        <ul>
          {present.map((s) => (
            <li key={s}>
              <Link
                to={`/settings/${s}`}
                className="st-section-link"
                {...(s === section ? { 'aria-current': 'page' as const } : {})}
              >
                {label('settingsSection', s)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="st-main">{children}</div>
    </div>
  );
}

/** `/settings` and `/settings/:section`. */
export function SettingsPage({ section }: { section: string | null }) {
  const q = useKeys();
  if (q.isPending) return <Loading what="the settings" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const keys = q.data.keys;
  const s = SettingsSection.safeParse(section ?? 'general');
  if (!s.success) return <PageError error={notFound()} />;
  const here = keys.filter((k) => placementOf(k.key).section === s.data);
  const title = label('settingsSection', s.data);
  return (
    <>
      <PageHeader
        title={label('screen', 'settings')}
        crumbs={[{ label: label('screen', 'settings'), to: '/settings' }, { label: title }]}
        renderLink={crumbsLink}
        meta={
          q.data.may_propose
            ? 'A change is previewed, then waits for approval before it is in force.'
            : 'You can read the settings; changing them needs the right to propose a change.'
        }
      />
      <Frame section={s.data} keys={keys}>
        <section aria-labelledby="st-section-h">
          <h2 id="st-section-h" className="st-h2">
            {title}
          </h2>
          <p className="muted">{term('settingsSection', s.data).explain}</p>
          {here.length === 0 ? (
            <EmptyState title="Nothing to set here">
              This deployment has no setting in this section.
            </EmptyState>
          ) : (
            <ul className="st-list" aria-label={`Settings in ${title}`}>
              {here.map((k) => (
                <SettingRow key={k.key} k={k} />
              ))}
            </ul>
          )}
        </section>
      </Frame>
    </>
  );
}

function notFound() {
  return new ApiError(404, 'not_found', 'Not found.');
}

function SettingRow({ k }: { k: ConfigKeySummary }) {
  const p = placementOf(k.key);
  const v = useQuery({ queryKey: ['config', k.key], queryFn: () => api.configKey(k.key) });
  const value = v.data?.effective.value;
  const summary =
    value === undefined
      ? null
      : typeof value === 'object' && value !== null && !Array.isArray(value)
        ? Object.entries(value)
            .slice(0, 3)
            .map(([f, x]) => `${fieldWord(f)}: ${valueWord(x)}`)
            .join(' · ') + (Object.keys(value).length > 3 ? ' · …' : '')
        : valueWord(value);
  const name = keyName(k);
  return (
    <li className="st-row" data-key={k.key}>
      <div className="st-row-t">
        <h3>
          <Link to={settingHref(k.key)}>{name}</Link>
        </h3>
        <InfoTip about={name} text={keyTip(k)} />
        <Pill tone={p.applies === 'now' ? 'mute' : 'info'}>
          <Term family="settingsApplies" value={p.applies} />
        </Pill>
        {v.data && v.data.pending.length > 0 ? (
          <Pill tone="warn">{v.data.pending.length} waiting for approval</Pill>
        ) : null}
        {v.data?.effective.source === 'default' ? <Pill plain>Default</Pill> : null}
      </div>
      <p>{p.effect}</p>
      <p className="st-row-v">
        {v.isPending ? 'Reading…' : v.isError ? 'Could not read the value.' : `Now: ${summary}`}
      </p>
      {p.edit_on ? (
        <p className="st-row-on">
          <Link to={p.edit_on}>Change it on its own page</Link>
        </p>
      ) : null}
    </li>
  );
}

/** `/settings/:section/:key` (and the old `/config/:key`). */
export function SettingPage({ configKey, csrf }: { configKey: string; csrf: string }) {
  const q = useKeys();
  if (q.isPending) return <Loading what="the setting" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const k = q.data.keys.find((x) => x.key === configKey);
  if (!k) return <PageError error={notFound()} />;
  const p = placementOf(configKey);
  const section = label('settingsSection', p.section);
  const name = keyName(k);
  return (
    <>
      <PageHeader
        title={name}
        crumbs={[
          { label: label('screen', 'settings'), to: '/settings' },
          { label: section, to: `/settings/${p.section}` },
          { label: name },
        ]}
        renderLink={crumbsLink}
        status={
          <Pill tone={p.applies === 'now' ? 'mute' : 'info'}>
            <Term family="settingsApplies" value={p.applies} />
          </Pill>
        }
        meta={p.effect}
      />
      <Frame section={p.section} keys={q.data.keys}>
        {p.read_only ? (
          <p className="muted" data-testid="st-generated">
            This is generated by the factory and cannot be changed by hand.
          </p>
        ) : p.edit_on ? (
          <p className="muted">
            It is easier to change on <Link to={p.edit_on}>its own page</Link>; every field is also
            here.
          </p>
        ) : null}
        <ConfigConsole configKey={configKey} csrf={csrf} readOnly={p.read_only === true} />
      </Frame>
    </>
  );
}
