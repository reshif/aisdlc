import {
  BindingCreatedPayload,
  BindingRevokedPayload,
  BindingUpdatedPayload,
  GroupCreatedPayload,
  GroupUpdatedPayload,
  IDENTITY_EVENT,
  LinkLinkedPayload,
  MemberAddedPayload,
  MemberRemovedPayload,
  PrincipalCreatedPayload,
  PrincipalStatusChangedPayload,
  PrincipalUpdatedPayload,
  QualificationGrantedPayload,
  QualificationRevokedPayload,
  TeamCreatedPayload,
  TeamUpdatedPayload,
  bindingStream,
  groupStream,
  identityLinkStream,
  principalStream,
  teamStream,
  type Binding,
  type Group,
  type IdentityLink,
  type Membership,
  type Principal,
  type Qualification,
  type RecordEvent,
  type Team,
} from '@aisdlc/contracts';
import { err, ok, type Clock, type Result } from '@aisdlc/kernel';
import { EVENT_COLUMNS, appendEvents, toRecordEvent, type EventRow, type Tx } from '@aisdlc/record';
import { identityError, type IdentityError } from './errors.js';

// The identity journal as the writer sees it. The writer reads the authoritative record streams
// (never the read model, which may lag) and folds them with the functions below; the projection
// folds the same events into tables. State is a function of the stream, so a stream that was
// appended to in this transaction is read back with its new events.

export interface PrincipalState {
  readonly principal: Principal;
  /** Granted and not revoked; whether one is still valid is a question of the clock. */
  readonly qualifications: ReadonlyMap<string, Qualification>;
}

export interface GroupState {
  readonly group: Group;
  readonly members: ReadonlyMap<string, Membership>;
}

export interface BindingState {
  readonly binding: Binding;
  readonly revoked: boolean;
}

export function foldPrincipal(events: readonly RecordEvent[]): PrincipalState | null {
  let principal = null as Principal | null;
  const quals = new Map<string, Qualification>();
  for (const e of events) {
    switch (e.type) {
      case IDENTITY_EVENT.principal_created:
        principal = PrincipalCreatedPayload.parse(e.payload);
        break;
      case IDENTITY_EVENT.principal_updated:
        if (principal) {
          principal = Object.assign({}, principal, PrincipalUpdatedPayload.parse(e.payload));
        }
        break;
      case IDENTITY_EVENT.principal_status_changed:
        if (principal) {
          const p = PrincipalStatusChangedPayload.parse(e.payload);
          principal = { ...principal, status: p.status, status_changed_at: e.occurred_at };
        }
        break;
      case IDENTITY_EVENT.qualification_granted: {
        const q = QualificationGrantedPayload.parse(e.payload);
        quals.set(q.qual_type, q);
        break;
      }
      case IDENTITY_EVENT.qualification_revoked:
        quals.delete(QualificationRevokedPayload.parse(e.payload).qual_type);
        break;
    }
  }
  return principal ? { principal, qualifications: quals } : null;
}

export function foldGroup(events: readonly RecordEvent[]): GroupState | null {
  let group = null as Group | null;
  const members = new Map<string, Membership>();
  for (const e of events) {
    switch (e.type) {
      case IDENTITY_EVENT.group_created:
        group = GroupCreatedPayload.parse(e.payload);
        break;
      case IDENTITY_EVENT.group_updated:
        if (group) group = Object.assign({}, group, GroupUpdatedPayload.parse(e.payload));
        break;
      case IDENTITY_EVENT.member_added: {
        const m = MemberAddedPayload.parse(e.payload);
        members.set(m.principal_id, m);
        break;
      }
      case IDENTITY_EVENT.member_removed:
        members.delete(MemberRemovedPayload.parse(e.payload).principal_id);
        break;
    }
  }
  return group ? { group, members } : null;
}

export function foldBinding(events: readonly RecordEvent[]): BindingState | null {
  let binding = null as Binding | null;
  let revoked = false;
  for (const e of events) {
    switch (e.type) {
      case IDENTITY_EVENT.binding_created:
        binding = BindingCreatedPayload.parse(e.payload);
        revoked = false;
        break;
      case IDENTITY_EVENT.binding_updated:
        if (binding) binding = { ...binding, ...BindingUpdatedPayload.parse(e.payload) };
        break;
      case IDENTITY_EVENT.binding_revoked:
        BindingRevokedPayload.parse(e.payload);
        revoked = true;
        break;
    }
  }
  return binding ? { binding, revoked } : null;
}

export function foldTeam(events: readonly RecordEvent[]): Team | null {
  let team = null as Team | null;
  for (const e of events) {
    if (e.type === IDENTITY_EVENT.team_created) team = TeamCreatedPayload.parse(e.payload);
    else if (e.type === IDENTITY_EVENT.team_updated && team) {
      team = Object.assign({}, team, TeamUpdatedPayload.parse(e.payload));
    }
  }
  return team;
}

/** The principal an external identity is linked to now, or `null`. */
export function foldLink(events: readonly RecordEvent[]): IdentityLink | null {
  let link = null as IdentityLink | null;
  for (const e of events) {
    if (e.type === IDENTITY_EVENT.link_linked) link = LinkLinkedPayload.parse(e.payload);
    else if (e.type === IDENTITY_EVENT.link_unlinked) link = null;
  }
  return link;
}

/** Serialises writers of the named keys until the transaction ends. Sorted, so two writers never deadlock. */
export async function lockKeys(tx: Tx, keys: readonly string[]): Promise<void> {
  for (const k of [...new Set(keys)].sort()) {
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`aisdlc.identity:${k}`]);
  }
}

/** One transaction's view of the journal: streams are read once, and appended events are visible. */
export class Journal {
  private readonly cache = new Map<string, RecordEvent[]>();
  /** How many events this transaction appended. */
  appended = 0;

  constructor(
    readonly tx: Tx,
    readonly clock: Clock,
  ) {}

  async events(stream: string): Promise<RecordEvent[]> {
    const hit = this.cache.get(stream);
    if (hit) return hit;
    const q = await this.tx.query<EventRow>(
      `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
      [stream],
    );
    const events = q.rows.map(toRecordEvent);
    this.cache.set(stream, events);
    return events;
  }

  /** Appends one event to `stream` at its current head. Callers hold the stream's key (`lockKeys`). */
  async emit(
    stream: string,
    type: string,
    payload: object,
    actor: string,
  ): Promise<Result<RecordEvent, IdentityError>> {
    const events = await this.events(stream);
    const head = events.at(-1)?.stream_seq ?? 0;
    const r = await appendEvents(
      this.tx,
      stream,
      head,
      [{ type, body: payload as Record<string, unknown>, actor }],
      { clock: this.clock },
    );
    if (!r.ok) return err(identityError('conflict', JSON.stringify(r.error)));
    const written = r.value.events[0] as RecordEvent;
    events.push(written);
    this.appended += 1;
    return ok(written);
  }

  async principal(id: string) {
    return foldPrincipal(await this.events(principalStream(id)));
  }
  async group(id: string) {
    return foldGroup(await this.events(groupStream(id)));
  }
  async binding(id: string) {
    return foldBinding(await this.events(bindingStream(id)));
  }
  async team(id: string) {
    return foldTeam(await this.events(teamStream(id)));
  }
  async link(l: Parameters<typeof identityLinkStream>[0]) {
    return foldLink(await this.events(identityLinkStream(l)));
  }
}
