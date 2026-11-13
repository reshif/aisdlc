import { useMutation, useQueryClient } from '@tanstack/react-query';
import { label, lookupTerm, pdpResource, type PortalItemView } from '@aisdlc/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Guarded } from '../access';
import { ErrorNote } from '../components/Notice';
import { Link } from '../router';
import { Card, Pill } from '../ui';

// On the item page: the release approval with "ask to release again" when it is held, "I'm not sure" (a light code
// review goes to a code owner instead), and the way to the final record. Each button is the PDP's hint for the person
// on this item; the server decides (the role, the approver bars, the item's state) and may still refuse.

/** One retry key per press: the same key is the same signal, so a double click is not two. */
const newKey = (): string => `portal-${crypto.randomUUID()}`;

export function ItemGovernance({ item, csrf }: { item: PortalItemView; csrf: string }) {
  const resource = pdpResource.item(item.project_id, item.item_id, item.lane ?? item.proposed_lane);
  const g5 = item.gates.filter((g) => g.gate === 'G5');
  const g4Pending = item.gates.some((g) => g.gate === 'G4' && g.status === 'pending');
  const lastG5 = g5.at(-1);
  // the release was turned down; once the fix window is over the requester asks for it again
  const onHold =
    lastG5 !== undefined && lastG5.status === 'decided' && lastG5.outcome !== 'approve';
  const closed = item.terminal !== null || item.phase === 'S9' || item.phase === 'G6';
  if (g5.length === 0 && !g4Pending && !closed) return null;
  return (
    <>
      {g5.length > 0 ? (
        <Card title={label('gate', 'G5')} testId="item-release">
          <ul className="wk-list" aria-label="Release decisions">
            {g5.map((g) => (
              <li key={g.gate_instance_id}>
                {g.status === 'pending' ? (
                  <Pill tone="warn">{label('gateStatus', 'pending')}</Pill>
                ) : (
                  <Pill tone={g.outcome === 'approve' ? 'ok' : 'bad'}>
                    {lookupTerm('decision', g.outcome ?? '')?.label ??
                      label('gateStatus', 'decided')}
                  </Pill>
                )}
              </li>
            ))}
          </ul>
          {onHold ? (
            <>
              <p>
                The release is on hold. When the fix window has passed, ask for the release again:
                the release approval opens anew and its deciders see it in their inbox.
              </p>
              <Guarded action="item.release" resource={resource} label="Ask to release again">
                <ActionButton
                  label="Ask to release again"
                  done="The release is asked for again."
                  run={() => api.itemReRequestRelease(item.item_id, newKey(), csrf)}
                  id={item.item_id}
                />
              </Guarded>
            </>
          ) : null}
        </Card>
      ) : null}
      {g4Pending ? (
        <Card title="Not sure about this code review?" testId="item-unsure">
          <p>
            In a light review the code reviewer decides on the evidence pack alone. If you are
            unsure, ask a code owner to do a full review instead. Nothing is approved by this.
          </p>
          <Guarded action="item.unsure" resource={resource} mode="hide">
            <ActionButton
              label={label('decideWord', 'unsure')}
              done="A code owner now does a full review."
              run={() => api.itemUnsure(item.item_id, newKey(), csrf)}
              id={item.item_id}
            />
          </Guarded>
        </Card>
      ) : null}
      {closed ? (
        <Card title={label('concept', 'closeout')} testId="item-closeout-link">
          <p>
            <Link to={`/items/${item.item_id}/closeout`}>Open the final record</Link>: every
            approval with its decision, the merge, the release, the acceptance and the rework.
          </p>
        </Card>
      ) : null}
    </>
  );
}

function ActionButton({
  label: text,
  done,
  run,
  id,
}: {
  label: string;
  done: string;
  run: () => Promise<unknown>;
  id: string;
}) {
  const qc = useQueryClient();
  const [ok, setOk] = useState(false);
  const m = useMutation({
    mutationFn: run,
    onSuccess: () => {
      setOk(true);
      void qc.invalidateQueries({ queryKey: ['item', id] });
    },
  });
  return (
    <>
      <button type="button" className="ui-btn" disabled={m.isPending} onClick={() => m.mutate()}>
        {text}
      </button>
      {ok ? (
        <p role="status" className="wk-muted">
          {done}
        </p>
      ) : null}
      {m.isError ? <ErrorNote error={m.error} /> : null}
    </>
  );
}
