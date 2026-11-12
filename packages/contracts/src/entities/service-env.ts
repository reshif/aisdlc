import { z } from 'zod';
import { Sha256Hex } from './ids.js';

// ServiceEnv (DM §3.2, PROPOSED there: "G5 binds (service, environment, digest) but no environment entity") and FF2
// (OB §3.2: "For L5 only: `staging_separation: yes` attested", RS-OP-2; OB §2.1: "L5 also needs `operations.md` with
// staging separation").
//
// At Full, card 3 declares the project's services and the environments each deploys to, and the person attests
// whether staging is separated from production (accounts, data, credentials: interview question full-14). The
// declaration is part of card 3's ledgered payload (a `service_envs` row), so the PRR carries it as
// `affirmed.full.service_envs` and M4 binds to it. FF2 is met only when the attestation is `yes` AND some service
// declares both a staging and a production environment, which are then two distinct ServiceEnvs. Anything else
// (no, not applicable, no declaration, a service with only one of the two) is unmet: L5 stays closed. Unknown is
// unmet; FF2 never opens anything but L5.

export const ServiceEnvironment = z.enum(['development', 'staging', 'production']);
export type ServiceEnvironment = z.infer<typeof ServiceEnvironment>;

/** A service's name as the project calls it: identifier-like, never a URL or a secret. */
export const ServiceName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, 'a lowercase service name');

export const StagingSeparation = z.enum(['yes', 'no', 'not_applicable']);
export type StagingSeparation = z.infer<typeof StagingSeparation>;

export const MAX_SERVICES = 20;

/** What a person declares on card 3 (optional: without it FF2 is unmet and L5 stays closed). */
export const ServiceEnvDeclaration = z.strictObject({
  services: z
    .array(
      z.strictObject({
        service: ServiceName,
        environments: z.array(ServiceEnvironment).min(1).max(3),
      }),
    )
    .max(MAX_SERVICES),
  staging_separation: StagingSeparation,
});
export type ServiceEnvDeclaration = z.infer<typeof ServiceEnvDeclaration>;

/** One (project, service, environment): what G5 binds a deploy to. */
export const ServiceEnv = z.strictObject({
  service_env_id: z.string().regex(/^senv:[^:]+:[a-z0-9._-]+:(development|staging|production)$/),
  service: ServiceName,
  environment: ServiceEnvironment,
});
export type ServiceEnv = z.infer<typeof ServiceEnv>;

export const serviceEnvId = (project: string, service: string, env: ServiceEnvironment): string =>
  `senv:${project}:${service}:${env}`;

export const Ff2State = z.enum(['met', 'unmet']);
export type Ff2State = z.infer<typeof Ff2State>;

/** What the PRR carries (`affirmed.full.service_envs`): the ServiceEnvs, the attestation and FF2. */
export const PrrServiceEnvs = z.strictObject({
  envs: z.array(ServiceEnv),
  staging_separation: StagingSeparation,
  ff2: Ff2State,
  envs_hash: Sha256Hex,
});
export type PrrServiceEnvs = z.infer<typeof PrrServiceEnvs>;

/** FF2 of a declaration (pure): `yes` attested and a service with both a staging and a production environment. */
export function ff2Of(d: ServiceEnvDeclaration | null): { state: Ff2State; reasons: string[] } {
  if (d === null) return { state: 'unmet', reasons: ['no service environments declared'] };
  const reasons: string[] = [];
  if (d.staging_separation !== 'yes') {
    reasons.push(`staging separation attested ${d.staging_separation.replace('_', ' ')}`);
  }
  if (
    !d.services.some(
      (s) => s.environments.includes('staging') && s.environments.includes('production'),
    )
  ) {
    reasons.push('no service has both a staging and a production environment');
  }
  return reasons.length === 0 ? { state: 'met', reasons } : { state: 'unmet', reasons };
}
