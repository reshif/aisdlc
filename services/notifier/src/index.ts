// notifier (PLAN M18; ADR-0003 §1 Integration plane): Slack and email delivery of what waits for a person, read from
// the record. Best effort: the portal inbox stays the authoritative channel, and the notifier decides nothing.
export * from './app.js';
export * from './boot.js';
export * from './channels.js';
export * from './deliver.js';
export * from './migrations.js';
export * from './raise.js';
export * from './recipients.js';
export * from './render.js';
export * from './slack.js';
export * from './smtp.js';
export * from './sources.js';
export * from './store.js';
