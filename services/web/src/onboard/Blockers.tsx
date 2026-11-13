import { useQuery } from '@tanstack/react-query';
import type { Blocker, BlockerOwner } from '@aisdlc/contracts';
import { Card, Pill, type PillTone } from '../ui';
import { onboardApi } from './api';

// "What is in the way, and whose move is it" (onboarding console P0): the deterministic blocker graph of one S0
// record, read from core. A read only; it decides nothing. It hides itself when it cannot be read: the summary
// underneath is the page.

const OWNER: Readonly<Record<BlockerOwner, { label: string; tone: PillTone }>> = {
  agent: { label: 'The factory', tone: 'neutral' },
  you: { label: 'You', tone: 'warn' },
  security: { label: 'Security approver', tone: 'bad' },
  signer: { label: 'The signer', tone: 'info' },
  github: { label: 'On GitHub', tone: 'warn' },
};

export function Blockers({ id, pollMs }: { id: string; pollMs?: number }) {
  const q = useQuery({
    queryKey: ['onboard-blockers', id],
    queryFn: () => onboardApi.blockers(id),
    retry: false,
    refetchInterval: (x) =>
      x.state.data && x.state.data.blockers.length === 0 ? false : (pollMs ?? 15000),
  });
  if (!q.data || q.data.blockers.length === 0) return null;
  const { blockers, ready } = q.data;
  const title = new Map(blockers.map((b) => [b.id, b.title]));
  return (
    <Card title={ready ? 'Left to decide' : 'What is in the way'} testId="blockers">
      <p className="ui-help">
        {ready
          ? 'Nothing needs fixing first: only decisions are left.'
          : 'Each item says whose move it is and what to do.'}
      </p>
      <ul className="ob-list" aria-label="Blockers">
        {blockers.map((b) => (
          <BlockerRow key={b.id} b={b} title={title} />
        ))}
      </ul>
    </Card>
  );
}

function BlockerRow({ b, title }: { b: Blocker; title: ReadonlyMap<string, string> }) {
  const o = OWNER[b.owner];
  return (
    <li data-testid="blocker" data-code={b.code} data-owner={b.owner}>
      <span>
        <Pill tone={o.tone}>{o.label}</Pill> <strong>{b.title}</strong>
      </span>
      <span className="ui-help">{b.why}</span>
      <span>
        <strong>Next:</strong> {b.next}
      </span>
      {b.blocked_by.length > 0 ? (
        <span className="ui-help">
          Waits behind: {b.blocked_by.map((x) => title.get(x) ?? x).join('; ')}
        </span>
      ) : null}
    </li>
  );
}
