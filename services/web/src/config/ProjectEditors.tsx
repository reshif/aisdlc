import {
  DEFAULT_GATING_PROFILE,
  EMPTY_ROLE_MAP,
  GATES,
  GatingProfile,
  PROJECT_CONFIG_KEYS,
  ProjectToggleGroupValues,
  ROLE_CATALOGUE,
  RoleMap,
  RoleSlotValues,
  T2_GATING_FLOOR,
  Tier,
  TwoPerson,
  projectSettingsTierViolations,
  type ProjectSettings,
  type ProjectToggleGroup,
  type RoleSlot,
} from '@aisdlc/contracts';
import { useState } from 'react';
import { Check, TextField, ids } from '../cards/shared';
import type { DraftEditorProps } from './ConfigConsole';

// The project layer's own draft editors (P1-5): the role map as slot by people, the gating profile as toggles within
// the T2 floor. The generated form stays one click away for every field (by_lane, kill delegations ...). The floors
// are checked on the draft with the same function the server runs (`projectSettingsTierViolations`).

const slotDescription = (slot: RoleSlot): string =>
  ROLE_CATALOGUE.find((r) => r.slot === slot)?.description ?? slot;

const groupTitle = (g: ProjectToggleGroup): string =>
  Object.values(GATES)
    .filter((x) => x.projectToggle === g)
    .map((x) => x.title)
    .join(', ') || g;

/** The role map: one row per slot, the people who hold it (ids, comma or space separated); g4 may be the code owners. */
export function RoleMapEditor({ value, onChange }: DraftEditorProps) {
  const parsed = RoleMap.safeParse(value);
  const start = parsed.success ? parsed.data : EMPTY_ROLE_MAP;
  const [text, setText] = useState<Record<RoleSlot, string>>(
    () =>
      Object.fromEntries(
        RoleSlotValues.map((s) => {
          const v = start[s];
          return [s, v.kind === 'principals' ? v.principals.join(', ') : ''];
        }),
      ) as Record<RoleSlot, string>,
  );
  const [owners, setOwners] = useState(start.g4.kind === 'codeowners');
  const emit = (t: Record<RoleSlot, string>, o: boolean) =>
    onChange(
      Object.fromEntries(
        RoleSlotValues.map((s) => [
          s,
          s === 'g4' && o ? { kind: 'codeowners' } : { kind: 'principals', principals: ids(t[s]) },
        ]),
      ),
    );
  return (
    <fieldset className="plain-fieldset" data-testid="role-map-editor">
      <legend>Who holds each slot</legend>
      <div className="roles">
        {RoleSlotValues.map((s) => (
          <div key={s} className="role" data-slot={s}>
            {s === 'g4' ? (
              <Check
                checked={owners}
                onChange={(o) => {
                  setOwners(o);
                  emit(text, o);
                }}
                hint="Merge review is done by the code owners on GitHub."
              >
                g4: the code owners on GitHub review merges
              </Check>
            ) : null}
            <TextField
              label={`${s}: ${slotDescription(s)}`}
              value={text[s]}
              disabled={s === 'g4' && owners}
              onChange={(x) => {
                const t = { ...text, [s]: x };
                setText(t);
                emit(t, owners);
              }}
            />
          </div>
        ))}
      </div>
      <p className="muted">
        People are named by their factory id. A slot with nobody in it means nobody can decide its
        gates.
      </p>
    </fieldset>
  );
}

/** Whether the T2 floor holds a toggle group on (the same rule as card 4 and `gatingFloorViolations`). */
const floorLocked = (g: ProjectToggleGroup, tier: string | null, deploys: boolean | null) =>
  tier === 'T2' &&
  ((T2_GATING_FLOOR.groups as readonly string[]).includes(g) ||
    (g === T2_GATING_FLOOR.deployGroup && deploys !== false));

/** The gating profile: one toggle per group, the floor's held on and disabled, and the schedule. */
export function GatingProfileEditor({ value, onChange, tier, deploys }: DraftEditorProps) {
  const parsed = GatingProfile.safeParse(value);
  const p = parsed.success ? parsed.data : DEFAULT_GATING_PROFILE;
  return (
    <div data-testid="gating-editor">
      <fieldset className="options">
        <legend>Gates (off means absent, never approved on its own)</legend>
        {ProjectToggleGroupValues.map((g) => {
          const locked = floorLocked(g, tier, deploys);
          return (
            <Check
              key={g}
              checked={p.gates[g] === 'on'}
              disabled={locked}
              hint={locked ? 'Held on by the T2 floor.' : undefined}
              onChange={(x) => onChange({ ...p, gates: { ...p.gates, [g]: x ? 'on' : 'off' } })}
            >
              {groupTitle(g)} ({g}) is on
            </Check>
          );
        })}
      </fieldset>
      <fieldset className="options">
        <legend>Schedule</legend>
        {(['auto', 'human'] as const).map((m) => (
          <label key={m} className="radio">
            <input
              type="radio"
              name="gating-schedule"
              checked={p.schedule === m}
              onChange={() => onChange({ ...p, schedule: m })}
            />{' '}
            {m === 'auto' ? 'The factory schedules work itself' : 'A person schedules work'}
          </label>
        ))}
      </fieldset>
      {p.by_lane && Object.keys(p.by_lane).length > 0 ? (
        <p className="muted">
          Lane overrides are set ({Object.keys(p.by_lane).join(', ')}); edit them in the generated
          form.
        </p>
      ) : null}
    </div>
  );
}

/** A settings document that breaks no tier rule, with one part replaced by the draft. */
const NEUTRAL: Omit<ProjectSettings, 'project_id' | 'updated_at' | 'version'> = {
  role_map: EMPTY_ROLE_MAP,
  two_person: { enabled: true, default: 'on_if_2plus', locked_on: true },
  gating_profile: DEFAULT_GATING_PROFILE,
  kill_delegations: [],
};

/**
 * The tier rules a key's draft breaks (T2: two-person locked on, the gating floor), as the server words them. No tier
 * yet: no floor. A draft that does not parse is the schema's problem, not this one.
 */
export function projectFloorProblems(key: string) {
  return (draft: unknown, ctx: { tier: string | null; deploys: boolean | null }): string[] => {
    const tier = Tier.safeParse(ctx.tier);
    if (!tier.success) return [];
    let part: Partial<typeof NEUTRAL> | null = null;
    if (key === PROJECT_CONFIG_KEYS.gating_profile) {
      const g = GatingProfile.safeParse(draft);
      if (g.success) part = { gating_profile: g.data };
    } else if (key === PROJECT_CONFIG_KEYS.two_person) {
      const t = TwoPerson.safeParse(draft);
      if (t.success) part = { two_person: t.data };
    }
    if (part === null) return [];
    return projectSettingsTierViolations(
      {
        ...NEUTRAL,
        ...part,
        project_id: 'p' as never,
        version: 1,
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      { tier: tier.data, deploys: ctx.deploys },
    );
  };
}
