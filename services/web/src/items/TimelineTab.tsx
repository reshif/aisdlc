import type { ItemTimelineEntry } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Read } from '../components/Read';
import { shortTime } from '../format';
import { EmptyState, Timeline, type TimelineKind } from '../ui';
import { TIMELINE_KIND_TEXT } from '../vocab';

// The item page's Timeline tab (P2-1): the item's record events and its stored documents, folded to plain steps with
// who did it and when, oldest first. Core carries only codes (an outcome, an edge, a reason code), never text.

const BACK = new Set(['item.rework_requested', 'item.relane_requested']);
const BAD = new Set([
  'item.abandoned',
  'item.withdrawn',
  'item.trigger_fired',
  'item.stage_failed',
]);
const GATE = new Set(['item.gates_opened', 'item.gate_decided', 'item.stage_gate_needed']);

export function timelineKindOf(e: ItemTimelineEntry): TimelineKind {
  if (BAD.has(e.kind)) return 'bad';
  if (BACK.has(e.kind)) return 'back';
  if (GATE.has(e.kind)) return 'gate';
  if (e.by !== null || !e.actor.startsWith('system.')) return 'human';
  return e.kind === 'artefact.stored' || e.kind === 'item.stage_completed' ? 'agent' : 'det';
}

const codeText = (c: string): string => {
  const [k, ...v] = c.split(':');
  return `${(k ?? '').replace(/_/g, ' ')} ${v.join(':').replace(/_/g, ' ')}`;
};

export function TimelineTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['item-timeline', id], queryFn: () => api.itemTimeline(id) });
  return (
    <Read q={q} what="the timeline">
      {(v) =>
        v.entries.length === 0 ? (
          <EmptyState title="Nothing recorded yet" />
        ) : (
          <div data-testid="timeline-tab">
            <Timeline
              label="What happened to the item"
              events={v.entries.map((e) => ({
                id: String(e.global_seq),
                when: shortTime(e.at),
                kind: timelineKindOf(e),
                title: (
                  <>
                    {TIMELINE_KIND_TEXT[e.kind]}
                    {e.step ? ` (step ${e.step})` : ''}
                    {e.gates.length > 0 ? `: ${e.gates.join(', ')}` : ''}
                  </>
                ),
                meta: (
                  <>
                    {e.by ?? e.actor}
                    {e.codes.length > 0 ? ` · ${e.codes.map(codeText).join(' · ')}` : ''}
                  </>
                ),
              }))}
            />
          </div>
        )
      }
    </Read>
  );
}
