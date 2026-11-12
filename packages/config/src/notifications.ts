import { NOTIFICATIONS_CONFIG_KEY, NotificationChannels } from '@aisdlc/contracts';
import type { z } from 'zod';
import { findSecrets } from './integrations.js';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the notifier's channel rows (PLAN M18; docs/specs/notifier-api.md): `notifications.channels`, factory
 * layer only (a project cannot add a channel), M1-gated like every revision. Default: no channel, so a fresh factory
 * notifies nobody outside the portal inbox (which stays the authoritative channel). Credentials are `file:`
 * references only (the contract) and the whole document goes through the shared secret ruleset, so a pasted webhook
 * URL or password is refused before an approver sees it; the finding names the rule, never the value. Read by the
 * notifier and registered by core (whose factory revisions must validate a document that sets it). Idempotent.
 */
export function registerNotificationsConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(NOTIFICATIONS_CONFIG_KEY)) return registry;
  const noSecrets = (value: unknown, ctx: z.RefinementCtx) => {
    for (const f of findSecrets(value)) {
      ctx.addIssue({
        code: 'custom',
        message: `the channel rows hold something that looks like a secret (rule ${f}): store a file: reference, never the value`,
      });
    }
  };
  return registry.setting({
    key: NOTIFICATIONS_CONFIG_KEY,
    schema: NotificationChannels.superRefine(noSecrets),
    default: [],
    overridable: false,
    description:
      'the notifier’s Slack (incoming webhook) and email (SMTP) channels: credentials as file: references, a data class cap per channel (D0 or D1), which rows a person gets by default. Factory layer only, M1-gated',
  });
}
