import { ProjectSettingsWire, RegisteredRepo, type ProjectId } from '@aisdlc/contracts';
import { err, ok } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';
import { RegisteredReposError, type RegisteredReposPort } from './registered-repos.js';
import { projectSettingsError, type ProjectSettingsPort } from './project-settings.js';

// The real adapters of the two ports whose source is core's Projects context (PLAN M7.1), over core's
// HTTP API with the caller's own service token (scope `read` for settings, `registry` for the repos).
// Both fail closed: a core that cannot be reached, a refusal and an answer of the wrong shape are
// errors, never "no restrictions" and never "no repos registered" (an empty list is an answer; a
// missing one allows nothing).

export interface CoreClientOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const callOf = (o: CoreClientOptions, path: string) =>
  callJson({
    baseUrl: o.baseUrl,
    token: o.token,
    method: 'GET',
    path,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  });

/** `ProjectSettingsPort` over `GET /v1/projects/:id/settings`. */
export class HttpProjectSettings implements ProjectSettingsPort {
  constructor(private readonly o: CoreClientOptions) {}

  async get(project: ProjectId) {
    const r = await callOf(this.o, `/v1/projects/${encodeURIComponent(project)}/settings`);
    if (!r.reached) return err(projectSettingsError('unavailable', 'core did not answer'));
    if (r.status === 404) {
      return err(projectSettingsError('unknown_project', `unknown project ${project}`));
    }
    if (r.status !== 200) {
      return err(projectSettingsError('unavailable', `core answered ${r.status}`));
    }
    const p = ProjectSettingsWire.safeParse(r.json);
    if (!p.success) {
      return err(projectSettingsError('unavailable', 'core answered with an unexpected shape'));
    }
    if (p.data.settings.project_id !== project) {
      return err(projectSettingsError('unavailable', 'core answered for another project'));
    }
    return ok(p.data);
  }
}

/** `RegisteredReposPort` over `GET /v1/registered-repos`. */
export class HttpRegisteredRepos implements RegisteredReposPort {
  constructor(private readonly o: CoreClientOptions) {}

  async list() {
    const down = (message: string) =>
      err(RegisteredReposError({ code: 'unavailable' as const, message }));
    const r = await callOf(this.o, '/v1/registered-repos');
    if (!r.reached) return down('core did not answer');
    if (r.status !== 200) return down(`core answered ${r.status}`);
    const p = z.array(RegisteredRepo).safeParse(r.json);
    return p.success ? ok(p.data) : down('core answered with an unexpected shape');
  }
}
