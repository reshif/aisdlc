import {
  AUDIT_RETENTION_CONFIG_KEY,
  AuditRetentionConfig,
  DEFAULT_AUDIT_RETENTION,
} from '@aisdlc/contracts';
import type { ConfigRegistry } from './registry.js';

/**
 * Registers the audit service's retention classes (PLAN M19; DM §3.12 RetentionClass; docs/specs/audit-api.md):
 * `audit.retention`, factory layer only, M1-gated like every revision. Default: every class `days: null`, so the
 * retention sweep erases nothing until a factory revision sets a class. Only payloads kept off the hash chain have a
 * class (today the conversation payloads); the record, the ledger and the signed exports have none: they are kept.
 * Read by the audit service and registered by core (whose revisions must validate a document that sets it).
 * Idempotent.
 */
export function registerAuditConfig(registry: ConfigRegistry): ConfigRegistry {
  if (registry.get(AUDIT_RETENTION_CONFIG_KEY)) return registry;
  return registry.setting({
    key: AUDIT_RETENTION_CONFIG_KEY,
    schema: AuditRetentionConfig,
    default: DEFAULT_AUDIT_RETENTION,
    overridable: false,
    description:
      'retention classes of the payloads kept off the hash chain (days before the audit service’s sweep erases them; null keeps them until an erasure request). A legal hold always wins. Factory layer only, M1-gated',
  });
}
