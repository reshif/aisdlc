import { useMutation, useQueryClient } from '@tanstack/react-query';
import { pdpResource, type PortalItemView } from '@aisdlc/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Guarded } from '../access';
import { ErrorNote } from '../components/Notice';
import { Link } from '../router';
import { Card, GateTag, Pill } from '../ui';

// M15 on the item page: G5's release status with RELHOLD's re-request, B14 (the mode-E approver is unsure: the
// review goes to a codeowner, mode C), and the way to the 9.3 close-out record. Each button is the PDP's hint for
// the person on this item; the server decides (the slot, the approver bars, the item's state) and may still refuse.

/** One retry key per press: the same key is the same signal, so a double click is not two. */
const newKey = (): string => `portal-${crypto.randomUUID()}`;

export function ItemGovernance({ item, csrf }: { item: PortalItemView; csrf: string }) {
  const resource = pdpResource.item(item.project_id, item.item_id, item.lane ?? item.proposed_lane);
  const g5 = item.gates.filter((g) => g.gate === 'G5');
  const g4Pending = item.gates.some((g) => g.gate === 'G4' && g.status === 'pending');
  const lastG5 = g5.at(-1);
  // RELHOLD: the release was turned down; once the fix window is over the requester asks for G5 again.
  const onHold =
    lastG5 !== undefined && lastG5.status === 'decided' && lastG5.outcome !== 'approve';
  const closed = item.terminal !== null || item.phase === 'S9' || item.phase === 'G6';
  if (g5.length === 0 && !g4Pending && !closed) return null;
  return (
    <>
      {g5.length > 0 ? (
        <Card title="Release (G5)" testId="item-release">
          <ul className="pg-list" aria-label="Release decisions">
            {g5.map((g) => (
              <li key={g.gate_instance_id}>
                <GateTag gate="G5" />
                {g.status === 'pending' ? (
                  <Pill tone="warn">waiting for a decision</Pill>
                ) : (
                  <Pill tone={g.outcome === 'approve' ? 'ok' : 'bad'}>
                    {g.outcome ?? 'decided'}
                  </Pill>
                )}
              </li>
            ))}
          </ul>
          {onHold ? (
            <>
              <p>
                The release is on hold (RELHOLD). When the fix window has passed, ask for the
                release again: G5 opens anew and its deciders see it in their inbox.
              </p>
              <Guarded action="item.release" resource={resource} label="Re-request the release">
                <ActionButton
                  label="Re-request the release"
                  done="The release is requested again."
                  run={() => api.itemReRequestRelease(item.item_id, newKey(), csrf)}
                  id={item.item_id}
                />
              </Guarded>
            </>
          ) : null}
        </Card>
      ) : null}
      {g4Pending ? (
        <Card title="Not sure about this merge?" testId="item-unsure">
          <p>
            An evidence approver (mode E) decides on the Evidence Pack alone. If you are unsure,
            send the review to a codeowner instead (B14: mode C). Nothing is approved by this.
          </p>
          <Guarded action="item.unsure" resource={resource} mode="hide">
            <ActionButton
              label="I am unsure: ask a codeowner"
              done="The review now goes to a codeowner (mode C)."
              run={() => api.itemUnsure(item.item_id, newKey(), csrf)}
              id={item.item_id}
            />
          </Guarded>
        </Card>
      ) : null}
      {closed ? (
        <Card title="Close-out" testId="item-closeout-link">
          <p>
            <Link to={`/items/${item.item_id}/closeout`}>The close-out record</Link>: every gate
            with its ledger decision, the merge, the release, the acceptance and the rework (9.3).
          </p>
        </Card>
      ) : null}
    </>
  );
}

function ActionButton({
  label,
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
        {label}
      </button>
      {ok ? (
        <p role="status" className="muted">
          {done}
        </p>
      ) : null}
      {m.isError ? <ErrorNote error={m.error} /> : null}
    </>
  );
}
