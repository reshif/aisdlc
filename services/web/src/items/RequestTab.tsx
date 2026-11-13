import { EligibilityReason, type ItemRequestView } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Read } from '../components/Read';
import { Card, KeyValue, Pill, laneText } from '../ui';
import { ELIGIBILITY_REASON_TEXT, ELIGIBILITY_ROUTE_TEXT, levelTitle } from '../vocab';
import { DuplicatesCard, InjectionCard, RequestTextCard } from './RequestParts';

// The item page's Request tab (P2-1, P2-17): the request as the factory keeps it (1.1), the injection check (B27), the
// de-dupe links (1.2) and the lane: what was asked, what it runs as, what bound it, and why intake routed it there.
// The same parts as the Ask-for-work receipt. The text needs data class D1 (the bff withholds it below; the hash stays).

const reasonText = (r: string): string => {
  const known = EligibilityReason.safeParse(r);
  return known.success ? ELIGIBILITY_REASON_TEXT[known.data] : r;
};

export function RequestTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['item-request', id], queryFn: () => api.itemRequest(id) });
  return (
    <Read q={q} what="the request">
      {(v) => <RequestBody v={v} />}
    </Read>
  );
}

function RequestBody({ v }: { v: ItemRequestView }) {
  const name = (p: string) => p;
  const eligible = v.eligibility_reason === 'eligible';
  const opensAt =
    eligible || v.lane_opens_at === null || v.asked_lane === null
      ? null
      : `${v.asked_lane} opens at ${levelTitle(v.lane_opens_at)}${
          v.eligibility_reason === 'level_too_low' ? '' : ' at the earliest'
        }.`;
  return (
    <div data-testid="request-tab">
      <Card title="Lane and why" testId="request-lane">
        <KeyValue
          rows={[
            ['Asked for', v.asked_lane === null ? 'no lane named' : laneText(v.asked_lane)],
            [
              'Runs as',
              v.lane === null ? (
                <>
                  {laneText(v.proposed_lane)}{' '}
                  <span className="muted">(proposed: G0 binds the lane)</span>
                </>
              ) : (
                <>
                  {laneText(v.lane)}{' '}
                  <span className="muted">
                    (bound
                    {v.lane_bound_by === 'ready_decision' ? ' by the Ready decision' : ' at G0'})
                  </span>
                </>
              ),
            ],
            [
              'Readiness check at intake (1.4)',
              <>
                <Pill tone={eligible ? 'ok' : 'warn'}>
                  {eligible ? 'eligible' : 'not eligible'}
                </Pill>{' '}
                {reasonText(v.eligibility_reason)};{' '}
                {ELIGIBILITY_ROUTE_TEXT[v.intake_route === 'l8' ? 'l8' : 'normal']}.
              </>,
            ],
            ...(opensAt === null ? [] : ([['What would open it', opensAt]] as const)),
            ['Requested by', v.requester ?? 'the factory'],
            ['Channel', v.channel ?? 'unknown'],
          ]}
        />
      </Card>
      <RequestTextCard
        text={v.request_text}
        withheldSha={v.text_withheld ? v.text_sha256 : null}
        name={name}
        testId="request-text"
      />
      <InjectionCard
        suspected={v.injection?.suspected ?? false}
        flags={v.request_text?.flags ?? []}
        rules={v.injection?.rules ?? []}
        testId="request-injection"
      />
      <DuplicatesCard
        links={v.dedupe_links}
        conflicts={v.conflict_candidates}
        testId="request-dedupe"
      />
    </div>
  );
}
