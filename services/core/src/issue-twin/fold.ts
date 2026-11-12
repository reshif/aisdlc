import {
  ISSUE_TWIN_EVENT,
  IssueTwinBatchApproved,
  IssueTwinLinked,
  IssueTwinRechecked,
  IssueTwinRequestMade,
  IssueTwinSignal,
  IssueTwinStateChanged,
  IssueTwinWriteDone,
  IssueTwinWriteIntended,
  type GapRecheckResult,
  type GapSeverity,
  type IssueTwinLinkVia,
  type IssueTwinState,
  type IssueTwinWrite,
  type RecordEvent,
} from '@aisdlc/contracts';

// The twin read model (PLAN M16): a pure fold of one repo's `issue_twin:<repo>` stream. The stream is the authority
// and every read folds it, so the model is rebuilt by reading it again: there is no table to drift from the record.

export interface TwinRow {
  readonly gap_id: string;
  readonly criterion: string;
  readonly severity: GapSeverity;
  readonly title: string;
  readonly body_sha256: string;
  readonly batch_id: string;
  number: number | null;
  via: IssueTwinLinkVia | null;
  state: IssueTwinState;
  intents: number;
  recheck: { result: GapRecheckResult; sha: string | null } | null;
  last_seen: IssueTwinSignal['seen'] | null;
  readonly writes_intended: Set<IssueTwinWrite>;
  readonly writes_done: Set<IssueTwinWrite>;
  request: { request_id: string; item_id: string | null } | null;
}

export interface TwinState {
  readonly batches: IssueTwinBatchApproved[];
  /** Every gap a batch chose to file, by gap id. */
  readonly twins: Map<string, TwinRow>;
  /** Gaps a batch kept in the factory (`track_only`), by gap id: the latest batch's choice. */
  readonly tracked: Set<string>;
  /** Remediation requests made from a gap that has no twin (a tracked gap). */
  readonly requests: Map<string, { request_id: string; item_id: string | null }>;
  /** When the poll last recorded a signal. */
  polled_at: string | null;
}

export function foldIssueTwin(events: readonly RecordEvent[]): TwinState {
  const s: TwinState = {
    batches: [],
    twins: new Map(),
    tracked: new Set(),
    requests: new Map(),
    polled_at: null,
  };
  for (const e of events) {
    switch (e.type) {
      case ISSUE_TWIN_EVENT.batch_approved: {
        const b = IssueTwinBatchApproved.parse(e.payload);
        s.batches.push(b);
        for (const r of b.rows) {
          if (r.disposition === 'track_only') {
            if (!s.twins.has(r.gap_id)) s.tracked.add(r.gap_id);
            continue;
          }
          if (s.twins.has(r.gap_id) || r.body_sha256 === null) continue;
          s.tracked.delete(r.gap_id);
          s.twins.set(r.gap_id, {
            gap_id: r.gap_id,
            criterion: r.criterion,
            severity: r.severity,
            title: r.title,
            body_sha256: r.body_sha256,
            batch_id: b.batch_id,
            number: null,
            via: null,
            state: 'pending',
            intents: 0,
            recheck: null,
            last_seen: null,
            writes_intended: new Set(),
            writes_done: new Set(),
            request: s.requests.get(r.gap_id) ?? null,
          });
        }
        break;
      }
      case ISSUE_TWIN_EVENT.file_intended: {
        const t = s.twins.get(String((e.payload as { gap_id?: unknown }).gap_id));
        if (t) t.intents += 1;
        break;
      }
      case ISSUE_TWIN_EVENT.linked: {
        const l = IssueTwinLinked.parse(e.payload);
        const t = s.twins.get(l.gap_id);
        if (!t) break;
        t.number = l.number;
        t.via = l.via;
        if (t.state === 'pending' || t.state === 'lost') t.state = 'open';
        break;
      }
      case ISSUE_TWIN_EVENT.signal_observed: {
        const g = IssueTwinSignal.parse(e.payload);
        const t = s.twins.get(g.gap_id);
        if (t) t.last_seen = g.seen;
        s.polled_at = e.occurred_at;
        break;
      }
      case ISSUE_TWIN_EVENT.rechecked: {
        const r = IssueTwinRechecked.parse(e.payload);
        const t = s.twins.get(r.gap_id);
        if (t) t.recheck = { result: r.result, sha: r.sha };
        break;
      }
      case ISSUE_TWIN_EVENT.write_intended: {
        const w = IssueTwinWriteIntended.parse(e.payload);
        s.twins.get(w.gap_id)?.writes_intended.add(w.write);
        break;
      }
      case ISSUE_TWIN_EVENT.write_done: {
        const w = IssueTwinWriteDone.parse(e.payload);
        s.twins.get(w.gap_id)?.writes_done.add(w.write);
        break;
      }
      case ISSUE_TWIN_EVENT.state_changed: {
        const c = IssueTwinStateChanged.parse(e.payload);
        const t = s.twins.get(c.gap_id);
        if (t) t.state = c.to;
        break;
      }
      case ISSUE_TWIN_EVENT.request_made: {
        const r = IssueTwinRequestMade.parse(e.payload);
        const ref = { request_id: r.request_id, item_id: r.item_id };
        const t = s.twins.get(r.gap_id);
        if (t) t.request = ref;
        s.requests.set(r.gap_id, ref);
        break;
      }
      default:
        break;
    }
  }
  return s;
}
