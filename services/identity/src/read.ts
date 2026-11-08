// The read side of identity, for core (PLAN M4.2, M4.4): the read model, its queries, the real
// `EligibilityPort` and the effective-access explain. Nothing here appends to the journal; the
// writer is the package root, used only by the identity service itself.
export { identityProjection, type IdentitySnapshot } from './projection.js';
export { migrateIdentity, MIGRATION_SCOPE, MIGRATIONS_DIR } from './migrations.js';
export {
  effectiveBindings,
  inForceBindings,
  getPrincipal,
  queryGrants,
  resolveGroups,
  resolveLink,
  type EffectiveBinding,
  type GrantFilter,
  type Grant,
  type GroupMembership,
  type PrincipalRow,
} from './queries.js';
export {
  IdentityEligibility,
  freshReadModel,
  projectScope,
  slotGrants,
  type ReadDeps,
} from './eligibility.js';
export {
  explainGate,
  explainProject,
  type BlockedPrincipal,
  type ExplainedPath,
  type ExplainedPrincipal,
  type ExplainedQuorum,
  type GateExplanation,
  type OwnRequest,
} from './explain.js';
export { accessSyncLagSeconds, accessSyncStatus, type AccessSyncStatus } from './access-sync.js';
export { IdentityError, IDENTITY_STATUS, type IdentityErrorCode } from './errors.js';
export { IdentityPdpEntities } from './pdp-entities.js';
