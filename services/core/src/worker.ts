// What core-worker hosts (PLAN M7): the S0 step driver, the role-map sync, and the adapters they
// and the worker's other loops use. Nothing here listens or boots.
export * from './driver.js';
export * from './role-map-sync.js';
export * from './clients.js';
export * from './registry.js';
export * from './settings.js';
export { cardsLoop, type CardsLoopOptions } from './cards/loop.js';
export { instructionTemplateFrom } from './cards/light.js';
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
export {
  MERGE_REVIEW_OBSERVER,
  mergeReviewLoop,
  observeBypassMerges,
  type MergeReviewDeps,
} from './merge-review.js';
