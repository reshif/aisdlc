import {
  DataClass,
  GATES,
  NOTIFICATION_CONTENT_CLASS,
  type NotificationContent,
  type NotificationDataClass,
} from '@aisdlc/contracts';
import { scanText } from '@aisdlc/secrets-rules';

// How a notification reads (PLAN M18). Pure: the content (ids, enums, times; never free text) rendered at the class
// the channel AND the person allow. In full (D1) it names the project and the gate; for a D0 audience it says only
// that something waits in the portal. Every rendering goes through the shared secret ruleset before it is sent: a hit
// refuses the delivery (`content_refused`), it is never redacted and sent anyway.

const rank = (c: DataClass): number => DataClass.options.indexOf(c);

/**
 * The class a message may be rendered at: the lower of the channel's cap and the recipient's own class. A recipient
 * whose class is unknown never gets here (the raise records one); D0 caps everything at D0.
 */
export function allowedClass(
  channelMax: NotificationDataClass,
  recipient: DataClass,
): NotificationDataClass {
  return rank(recipient) < rank(channelMax) ? (recipient as NotificationDataClass) : channelMax;
}

export interface Rendered {
  readonly subject: string;
  readonly text: string;
  readonly rendered_class: NotificationDataClass;
}

const gateLabel = (c: NotificationContent): string => {
  if (c.gate_id === null) return 'A decision';
  const title = GATES[c.gate_id].title;
  return title === null ? `Gate ${c.gate_id}` : `Gate ${c.gate_id} (${title})`;
};

function full(c: NotificationContent): { subject: string; line: string } {
  const p = c.project_id ?? 'the factory';
  switch (c.kind) {
    case 'gate_waiting':
      return {
        subject: `${c.gate_id ?? 'A card'} waits for you on ${p}`,
        line: `${gateLabel(c)} on project ${p} waits for your decision.`,
      };
    case 'sla_escalated':
      return {
        subject: `${c.gate_id ?? 'A card'} on ${p} is past its SLA`,
        line: `${gateLabel(c)} on project ${p} is past its one-business-day SLA (B21) and came to you as well.`,
      };
    case 'quarantine':
      return {
        subject: `Quarantine on ${p}: ${c.gate_id ?? 'a decision'} waits`,
        line: `${gateLabel(c)} on project ${p} waits for a security decision.`,
      };
    case 'handoff':
      return {
        subject: `A handoff on ${p} waits for you`,
        line: `${gateLabel(c)} on project ${p}: the owner of record chooses how the work goes on.`,
      };
    case 'kill_engaged':
      return {
        subject: `Kill switch engaged on ${c.project_id ?? 'the whole factory'}`,
        line: `The kill switch stopped agent work on ${c.project_id === null ? 'the whole factory' : `project ${p}`}.`,
      };
    case 'kill_released':
      return {
        subject: `Kill switch released on ${c.project_id ?? 'the whole factory'}`,
        line: `The kill switch released ${c.project_id === null ? 'the whole factory' : `project ${p}`}.`,
      };
  }
}

function minimal(c: NotificationContent): { subject: string; line: string } {
  switch (c.kind) {
    case 'kill_engaged':
      return { subject: 'Kill switch engaged', line: 'The kill switch stopped agent work.' };
    case 'kill_released':
      return { subject: 'Kill switch released', line: 'The kill switch released a scope.' };
    default:
      return {
        subject: 'Something waits for you in the factory portal',
        line: 'Something waits for you in the factory portal.',
      };
  }
}

/** The message for `content` at class `cls`, with the portal link. `portalUrl` is the portal's base (no path). */
export function renderNotification(
  content: NotificationContent,
  cls: NotificationDataClass,
  portalUrl: string,
): Rendered {
  const inFull = rank(cls) >= rank(NOTIFICATION_CONTENT_CLASS);
  const r = inFull ? full(content) : minimal(content);
  const base = portalUrl.replace(/\/+$/, '');
  // a D0 rendering links to the inbox, never to a path that names an item, a card or a gate
  const link = `${base}${inFull ? content.link_path : '/inbox'}`;
  const lines = [r.line];
  if (inFull && content.due_at !== null) lines.push(`Due: ${content.due_at}`);
  lines.push(`Open the portal: ${link}`);
  lines.push('The portal inbox is the record; this message is only a pointer to it.');
  return {
    subject: `AISDLC: ${r.subject}`,
    text: lines.join('\n'),
    rendered_class: inFull ? NOTIFICATION_CONTENT_CLASS : 'D0',
  };
}

/** The rule ids the secret ruleset finds in a rendering (empty: it may be sent). */
export function renderingSecrets(r: Rendered): string[] {
  return [...new Set(scanText(`${r.subject}\n${r.text}`).map((m) => m.rule_id))];
}
