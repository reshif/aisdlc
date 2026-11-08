// The aggregates' folds live in `@aisdlc/onboarding` so the bff's PDP entity source can read the
// bootstrap grant without depending on core. This file keeps core's import paths.
export * from '@aisdlc/onboarding/fold';
