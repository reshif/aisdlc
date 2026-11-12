import { z } from 'zod';
import { RepoFullName } from './codehost.js';
import { JsonObject, ProjectId, Sha256Hex } from './ids.js';
import { hashCanonical } from '@aisdlc/kernel';

// Inbound facts (PLAN M5.4; OB §6.5 "Polling, no webhooks", §8 table). The App has no webhook and
// local-prod has no public ingress, so the factory learns what changed on the code host by
// polling. Each poll that sees a different value than the last one records it as ONE record event
// in the `inbound:<kind>:<repo>` stream (one stream per repo and kind, one family of streams for
// all of them); a poll that sees the same value writes nothing. Detection latency therefore
// equals the poll interval. Everything downstream (Census re-run, B-blockers, PRR suspension)
// reads these events, never the code host.

/** What is polled. Each kind names one row of the OB §8 table. */
export const InboundFactKind = z.enum([
  /** The default branch's head sha (push to the default branch). */
  'default_branch_head',
  /** The installation (selection, permissions, suspension) and the repo's place in it. */
  'installation',
  /** The effective rules on the default branch. */
  'effective_rules',
  /** M15.2: the agent pull requests the factory watches (state, head, base, mergeability, merge): `AgentPullsFact`. */
  'agent_pulls',
  /** M16 (OB §4.2, §8): the hashes of the files the record affirmed or projected, at the default branch's head: `AffirmedFilesValue`. */
  'affirmed_files',
]);
export type InboundFactKind = z.infer<typeof InboundFactKind>;
export const InboundFactKindValues: readonly InboundFactKind[] = InboundFactKind.options;

export const INBOUND_FACT_EVENT = { observed: 'inbound.fact_observed' } as const;
export const InboundFactEventType = z.literal(INBOUND_FACT_EVENT.observed);

/** The record stream of one repo's facts of one kind. Repo names compare without case. */
export const inboundFactStream = (kind: InboundFactKind, repo: string): string =>
  `inbound:${kind}:${repo.toLowerCase()}`;

/** `inbound:<kind>:<repo>` -> its parts, or `null` for any other stream. */
export function parseInboundFactStream(
  stream: string,
): { kind: InboundFactKind; repo: string } | null {
  const m = /^inbound:([a-z_]+):(.+)$/.exec(stream);
  if (!m) return null;
  const kind = InboundFactKind.safeParse(m[1]);
  const repo = RepoFullName.safeParse(m[2]);
  return kind.success && repo.success ? { kind: kind.data, repo: repo.data } : null;
}

/** sha256 of the canonical JSON of the observed value: what "changed" is decided on. */
export const inboundValueHash = (value: unknown): string => hashCanonical(value);

/**
 * The idempotency key of an observation: repo, kind, the hash of what was seen, and the hash of
 * the value it replaces (`none` for the first). The predecessor is part of the key so that a value
 * that comes back (A, B, A) is a new fact and not a duplicate of the first A, while two workers
 * that see the same change collapse into one event.
 */
export const inboundFactKey = (
  kind: InboundFactKind,
  repo: string,
  valueHash: string,
  previousHash: string | null,
): string => `${repo.toLowerCase()}|${kind}|${valueHash}|${previousHash ?? 'none'}`;

/**
 * Payload of `inbound.fact_observed`. When it was seen is the event's `occurred_at`; the payload
 * holds nothing that varies between two workers that saw the same change, so their writes are the
 * same event under one idempotency key.
 */
export const InboundFactPayload = z.strictObject({
  repo: RepoFullName,
  project_id: ProjectId,
  kind: InboundFactKind,
  /** What was seen. For `default_branch_head`: `{branch, sha}`; the others are the port's own objects. */
  value: JsonObject,
  value_hash: Sha256Hex,
  /** `value_hash` of the fact this one replaces; `null` for the first fact of the stream. */
  previous_hash: Sha256Hex.nullable(),
  /** The interval the poll runs at: the most a change can have gone unseen. */
  poll_interval_ms: z.number().int().min(1),
});
export type InboundFactPayload = z.infer<typeof InboundFactPayload>;
