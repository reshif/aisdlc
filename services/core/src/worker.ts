// What core-worker hosts (PLAN M7): the S0 step driver, the role-map sync, and the adapters they
// and the worker's other loops use. Nothing here listens or boots.
export * from './driver.js';
export * from './role-map-sync.js';
export * from './clients.js';
export * from './registry.js';
export * from './settings.js';
export * from './settings-v2.js';
export { cardsLoop, type CardsLoopOptions } from './cards/loop.js';
export { instructionTemplateFrom } from './cards/light.js';
export { probeFilesOf, probeLoop, runOnboardingProbe, type ProbeDeps } from './cards/probe.js';
export { packLoop, projectFullPack, projectPack, type PackDeps } from './cards/pack.js';
export { onboardingConsoleLoop } from './onboarding-console/loop.js';
export { consoleDepsFrom } from './onboarding-console/wire.js';
export { consoleActsFrom } from './onboarding-console/acts.js';
export {
  FakeOnboardingAgent,
  GatewayOnboardingAgent,
  onboardingAgentLoop,
  runOnboardingAgent,
  type OnboardingAgentPort,
} from './onboarding-v2/agent.js';
export {
  driftLoop,
  checkDrift,
  pollAffirmedFiles,
  expireRecord,
  type DriftDeps,
} from './drift/check.js';
export { lightTestsFrom } from './cards/spikes.js';
export { reonboardTriggersFrom } from './knowledge-defects.js';
export * from './card-wiring.js';
export {
  DbWorkInFlight,
  WORK_DRIVER_INTERVAL_MS,
  driveWork,
  workDriverLoop,
  type WorkDriverDeps,
  type WorkDriverLoopOptions,
} from './work-driver.js';
export { DEFAULT_WORK_SETTINGS, workSettingsFrom, type WorkSettings } from './work-control.js';
export {
  killHoldersLoop,
  killObserverLoop,
  observeKillswitch,
  syncKillHolders,
  syncKillHolds,
  type KillswitchLink,
} from './kill.js';
export {
  gatewayTriggersLoop,
  observeGatewayTriggers,
  type GatewayTriggersLoopOptions,
} from './gateway-triggers.js';
export { GatewayAgentKeys, type GatewayKeyClient } from './agent-keys.js';
export * from './planning/index.js';
export * from './admission/index.js';
export * from './build/index.js';
export * from './verify/index.js';
export * from './review/index.js';
export * from './closeout/index.js';
export { DbPrincipalLinks } from './cards/links.js';
export { releaseStagePorts, GateRelayReleasePort } from './release/port.js';
export {
  MERGE_REVIEW_OBSERVER,
  mergeReviewLoop,
  observeBypassMerges,
  type MergeReviewDeps,
} from './merge-review.js';
export {
  CensusGapRecheck,
  issueTwinLoop,
  syncIssueTwins,
  type IssueTwinSyncDeps,
  type IssueTwinSyncReport,
} from './issue-twin/index.js';
export { healthSnapshotLoop, collectHealth, HEALTH_LOOP } from './health.js';
export { AlertTracker, checkpointLag, recordAlert, verdictOf } from './alerts.js';
export { opsBackfillLoop } from './controls.js';
