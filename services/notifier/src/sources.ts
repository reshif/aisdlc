import {
  CARD_EVENT,
  CardEscalatedPayload,
  CardOpenedPayload,
  GATES,
  GATE_EVENT,
  GateOpenedPayload,
  KILL_EVENT,
  KILL_OBSERVED_EVENT,
  KILL_OBSERVED_STREAM,
  KillObservedPayload,
  KillScope,
  ROLE_CATALOGUE,
  projectOfScope,
  roleDef,
  roleForSlot,
  type DataClass,
  type NotificationContent,
  type NotificationReason,
  type PrincipalId,
  type ProjectId,
  type RoleSlot,
} from '@aisdlc/contracts';
import { z } from 'zod';

// What the notifier notifies about (PLAN M18), as a pure function of ONE record event: the content and who it is for,
// by role. It decides nothing: who holds a role is read from identity at raise time, and whether the person may
// decide is the inbox's (the PDP and the slot) to say. An event it does not know, or cannot parse, raises nothing.
//
//   gate.opened       a gate waits on its slot's holders: quarantine (Q1, SECT), handoff (E4), else gate_waiting
//   card.opened       an S0 step card with no gate (card 5's sign-off) waits on its role's holders
//   card.escalated    B21: the backup slot's holders the escalation named, and the card's own slot holders again
//   kill.observed     a kill engaged or released: the project's admin and kill slots, or the factory admins (fleet)

/** The record events the raise loop reads (the notifier role's row-level security allows exactly these and its own). */
export const SOURCE_TYPES = [
  GATE_EVENT.opened,
  CARD_EVENT.opened,
  CARD_EVENT.escalated,
  KILL_OBSERVED_EVENT,
] as const;

export interface SourceEvent {
  readonly event_id: string;
  readonly stream: string;
  readonly stream_seq: number;
  readonly global_seq: number;
  readonly type: string;
  readonly body: unknown;
  readonly occurred_at: string;
}

export type Audience =
  | {
      readonly kind: 'slot';
      readonly project: ProjectId;
      readonly slot: RoleSlot;
      readonly reason: NotificationReason;
    }
  | {
      readonly kind: 'principals';
      readonly principals: readonly PrincipalId[];
      readonly slot: RoleSlot;
      readonly reason: NotificationReason;
    }
  | { readonly kind: 'fleet_role'; readonly role: string; readonly reason: NotificationReason };

export interface NotificationIntent {
  readonly content: NotificationContent;
  readonly audiences: readonly Audience[];
  /** A gate this is about: when it is already closed at raise time, nothing is raised (the inbox moved on). */
  readonly gate_instance_id: string | null;
}

/** The class a recipient reached through `a` holds for the content: the default of the role that made them one. */
export function audienceClass(a: Audience): DataClass {
  const role = a.kind === 'fleet_role' ? a.role : roleForSlot(a.slot, ROLE_CATALOGUE);
  // an unknown role: the lowest class (the message then says only "see the portal")
  return roleDef(role, ROLE_CATALOGUE)?.data_class_default ?? 'D0';
}

export const audienceSlot = (a: Audience): RoleSlot | null =>
  a.kind === 'fleet_role' ? null : a.slot;

const content = (
  c: Partial<NotificationContent> & Pick<NotificationContent, 'kind'>,
): NotificationContent => ({
  project_id: null,
  gate_id: null,
  gate_instance_id: null,
  card_id: null,
  kill_id: null,
  due_at: null,
  link_path: '/inbox',
  ...c,
});

/**
 * The notification one source event asks for, or `null`. `cardOpened` is the `card.opened` of the card an escalation
 * is about (its project and slot), read by the caller from the same stream.
 */
export function intentOf(
  e: SourceEvent,
  ctx: { readonly cardOpened?: CardOpenedPayload | null } = {},
): NotificationIntent | null {
  if (e.type === GATE_EVENT.opened && e.stream.startsWith('gate:')) {
    const p = GateOpenedPayload.safeParse(e.body);
    if (!p.success) return null;
    const g = p.data;
    const kind =
      GATES[g.gate_id].family === 'quarantine'
        ? 'quarantine'
        : g.gate_id === 'E4'
          ? 'handoff'
          : 'gate_waiting';
    const expires = (g.facts as Record<string, unknown>)['expires_at'];
    return {
      content: content({
        kind,
        project_id: g.project_id,
        gate_id: g.gate_id,
        gate_instance_id: g.gate_instance_id,
        due_at: typeof expires === 'string' ? expires : null,
      }),
      audiences: [
        { kind: 'slot', project: g.project_id, slot: g.quorum.slot, reason: 'slot_holder' },
      ],
      gate_instance_id: g.gate_instance_id,
    };
  }
  if (e.type === CARD_EVENT.opened && e.stream.startsWith('card:')) {
    const p = CardOpenedPayload.safeParse(e.body);
    if (!p.success) return null;
    // a card with a gate is notified by its `gate.opened`; only a step card (no gate) by its own opening
    if (p.data.targets.some((t) => t.target === 'gate')) return null;
    return {
      content: content({
        kind: 'gate_waiting',
        project_id: p.data.project_id,
        card_id: p.data.card_id,
        due_at: p.data.sla_due_at,
      }),
      audiences: [
        { kind: 'slot', project: p.data.project_id, slot: p.data.role, reason: 'slot_holder' },
      ],
      gate_instance_id: null,
    };
  }
  if (e.type === CARD_EVENT.escalated && e.stream.startsWith('card:')) {
    const p = CardEscalatedPayload.safeParse(e.body);
    const opened = ctx.cardOpened;
    if (!p.success || !opened || opened.card_id !== p.data.card_id) return null;
    const target = opened.targets.find(
      (t) => t.target === 'gate' && t.gate_instance_id === p.data.gate_instance_id,
    );
    return {
      content: content({
        kind: 'sla_escalated',
        project_id: opened.project_id,
        gate_id: target?.target === 'gate' ? target.gate_id : null,
        gate_instance_id: p.data.gate_instance_id,
        card_id: p.data.card_id,
        due_at: p.data.due_at,
      }),
      audiences: [
        {
          kind: 'principals',
          principals: p.data.backup,
          slot: p.data.backup_slot,
          reason: 'escalated_backup',
        },
        { kind: 'slot', project: opened.project_id, slot: opened.role, reason: 'slot_holder' },
      ],
      gate_instance_id: p.data.gate_instance_id,
    };
  }
  if (e.type === KILL_OBSERVED_EVENT && e.stream === KILL_OBSERVED_STREAM) {
    const p = KillObservedPayload.safeParse(e.body);
    if (!p.success) return null;
    const kind =
      p.data.kind === KILL_EVENT.requested
        ? 'kill_engaged'
        : p.data.kind === KILL_EVENT.released
          ? 'kill_released'
          : null;
    if (kind === null) return null;
    const scope = KillScope.safeParse(p.data.body['scope']);
    if (!scope.success) return null;
    const killId = p.data.body['kill_id'];
    const project = projectOfScope(scope.data) as ProjectId | null;
    if (scope.data.kind !== 'fleet' && project === null) return null;
    return {
      content: content({
        kind,
        project_id: project,
        kill_id: z.uuid().safeParse(killId).success ? (killId as string) : null,
        link_path: '/kill',
      }),
      audiences:
        project === null
          ? [{ kind: 'fleet_role', role: 'factory.admin', reason: 'factory_admin' }]
          : [
              { kind: 'slot', project, slot: 'admin', reason: 'project_admin' },
              { kind: 'slot', project, slot: 'kill', reason: 'project_admin' },
            ],
      gate_instance_id: null,
    };
  }
  return null;
}
