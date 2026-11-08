import { ProjectSettings, type ProjectId, type Tier } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// ProjectSettingsPort (PLAN M4.4): what the identity service needs of a project's settings (role
// map, two-person, kill delegations) and of the project itself (its tier). The real adapters are
// core's (M7.1): `DbProjectSettings` in `@aisdlc/core` over its read models and the effective config,
// and `HttpProjectSettings` (core-clients.ts) for the services that run elsewhere. The fake stays for tests.

export type ProjectSettingsErrorCode = 'unknown_project' | 'unavailable';

export const ProjectSettingsError = taggedError('ProjectSettingsError');
export type ProjectSettingsError = TaggedError<
  'ProjectSettingsError',
  { code: ProjectSettingsErrorCode; message: string }
>;

export const projectSettingsError = (
  code: ProjectSettingsErrorCode,
  message: string,
): ProjectSettingsError => ProjectSettingsError({ code, message });

/** The settings document and the tier of its project (the tier lives on the project, DM §3.2). */
export interface ProjectSettingsView {
  readonly settings: ProjectSettings;
  /** `null` = no M4 yet; an unknown tier is not T2, but nothing signed means nothing to lock. */
  readonly tier: Tier | null;
}

export interface ProjectSettingsPort {
  /** The settings in force. An error is a refusal, never "no restrictions". */
  get(project: ProjectId): Promise<Result<ProjectSettingsView, ProjectSettingsError>>;
}

/** Deterministic in-memory `ProjectSettingsPort`. An unset project is `unknown_project`. */
export class FakeProjectSettings implements ProjectSettingsPort {
  private readonly views = new Map<string, ProjectSettingsView>();
  private readonly down = new Set<string>();

  set(settings: ProjectSettings, tier: Tier | null = null): this {
    this.views.set(settings.project_id, { settings: ProjectSettings.parse(settings), tier });
    return this;
  }

  remove(project: ProjectId): this {
    this.views.delete(project);
    return this;
  }

  /** Makes every call for the project fail, to test fail-closed behaviour. */
  breakProject(project: ProjectId): this {
    this.down.add(project);
    return this;
  }

  async get(project: ProjectId) {
    if (this.down.has(project)) {
      return err(projectSettingsError('unavailable', `settings unavailable: ${project}`));
    }
    const v = this.views.get(project);
    return v
      ? ok(structuredClone(v))
      : err(projectSettingsError('unknown_project', `unknown project ${project}`));
  }
}
