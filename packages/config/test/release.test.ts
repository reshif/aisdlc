import { RELEASE_CONFIG_KEY } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ConfigReader,
  ConfigRegistry,
  configProjection,
  configPublish,
  proposeRevision,
  readReleaseSetting,
  registerReleaseConfig,
} from '../src/index.js';
import { decideGate, pid, pr, setupProject, startStack, type Stack } from './helpers.js';

// PLAN M15.3: a project's release choice is a project-layer config key, M1-gated like every revision; unset is `null`.

let s: Stack;
beforeAll(async () => {
  s = await startStack(registerReleaseConfig(new ConfigRegistry()));
  setupProject(s, 'rel1', { admin: ['pat'] });
  setupProject(s, 'rel2', { admin: ['pam'] });
});
afterAll(async () => {
  await s.stop();
});

const project = (ref: string) => ({
  layer: 'project' as const,
  scope: { kind: 'project' as const, ref },
});

describe('project.release', () => {
  it('is registered once, project-overridable, default not chosen', () => {
    const r = registerReleaseConfig(registerReleaseConfig(new ConfigRegistry()));
    expect(r.get(RELEASE_CONFIG_KEY)).toMatchObject({ overridable: true, default: null });
    expect(r.validate('project', { [RELEASE_CONFIG_KEY]: { mode: 'off' } }).ok).toBe(true);
    expect(
      r.validate('project', { [RELEASE_CONFIG_KEY]: { mode: 'target', environment: 'prod' } }).ok,
    ).toBe(true);
    expect(
      r.validate('project', { [RELEASE_CONFIG_KEY]: { mode: 'target', environment: 'a b' } }).ok,
    ).toBe(false);
    expect(r.validate('project', { [RELEASE_CONFIG_KEY]: { mode: 'auto' } }).ok).toBe(false);
  });

  it('is in force only once its M1 decision is approved and published', async () => {
    expect(await readReleaseSetting(s.record.pool, 'rel1')).toEqual({ state: 'ok', value: null });
    const p = await proposeRevision(s.deps, {
      ...project('rel1'),
      doc: { [RELEASE_CONFIG_KEY]: { mode: 'target', environment: 'production' } },
      proposed_by: pr('dev'),
    });
    if (!p.ok) throw new Error(p.error.message);
    // proposed is not in force
    expect(await readReleaseSetting(s.record.pool, 'rel1')).toEqual({ state: 'ok', value: null });
    const d = await decideGate(s, p.value.gate_instance_id, 'pat', 'approve');
    expect(d.ok).toBe(true);
    const r = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
    expect(r.ok).toBe(true);
    // the published view is a read model of the record (core's worker folds it)
    await runProjection(s.record.pool, configProjection);
    expect(await readReleaseSetting(s.record.pool, 'rel1')).toEqual({
      state: 'ok',
      value: { mode: 'target', environment: 'production' },
    });
    // another project is untouched; the reader agrees
    expect(await readReleaseSetting(s.record.pool, 'rel2')).toEqual({ state: 'ok', value: null });
    const reader = await ConfigReader.create({
      pool: s.record.pool,
      registry: registerReleaseConfig(new ConfigRegistry()),
      project: pid('rel1'),
    });
    expect(reader.current().get(RELEASE_CONFIG_KEY)).toEqual({
      mode: 'target',
      environment: 'production',
    });
  });
});
