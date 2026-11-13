import { useQuery } from '@tanstack/react-query';
import { type CatalogueVersionRow } from '@aisdlc/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Read, ShortHash } from '../components/Read';
import { Card, GateTag, KeyValue, PageHead, Pill, Table, laneText } from '../ui';

// Govern › Tracks and limits (prototype `catalogue`): every released catalogue, read-only. The decision log and the
// audit tabs are `audit/AuditPage.tsx` (portal v2).

// ---------------------------------------------------------------- catalogue

function Lanes({ v }: { v: CatalogueVersionRow }) {
  return (
    <Table
      caption={`Lanes of catalogue ${v.ref.version}`}
      captionHidden
      columns={[
        { key: 'l', header: 'Lane', rowHeader: true, render: (l) => laneText(l.lane) },
        { key: 'e', header: 'Enters at', render: (l) => l.enter_at ?? 'human-led' },
        { key: 's', header: 'Stages', render: (l) => l.stages.join(' → ') },
        {
          key: 'g',
          header: 'Gates',
          render: (l) => (
            <ul className="pg-chips">
              {l.gates.map((g) => (
                <li key={`${g.gate}@${g.step}`} title={`${g.presence} at ${g.step}`}>
                  <GateTag gate={g.gate} />
                </li>
              ))}
            </ul>
          ),
        },
      ]}
      rows={v.lanes}
      rowKey={(l) => l.lane}
    />
  );
}

export function CataloguePage() {
  const q = useQuery({ queryKey: ['catalogue'], queryFn: api.catalogue, staleTime: 300_000 });
  const [pick, setPick] = useState<string | null>(null);
  return (
    <>
      <PageHead
        eyebrow="Govern"
        title="Catalogue"
        sub="Lanes, limits and gating as immutable releases. An item pins {version, hash} when it is created and keeps running on exactly that release; a change is a new version, never an edit."
      />
      <Read q={q} what="the catalogue">
        {(v) => {
          const current = v.versions.find((x) => x.current) ?? v.versions.at(-1);
          const shown = v.versions.find((x) => x.ref.version === pick) ?? current;
          return (
            <>
              <Card title="Released versions" flush>
                <Table
                  caption="Catalogue releases"
                  captionHidden
                  columns={[
                    {
                      key: 'v',
                      header: 'Version',
                      rowHeader: true,
                      render: (x) => (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm"
                          aria-pressed={x.ref.version === shown?.ref.version}
                          onClick={() => setPick(x.ref.version)}
                        >
                          {x.ref.version}
                        </button>
                      ),
                    },
                    {
                      key: 'c',
                      header: 'State',
                      render: (x) =>
                        x.current ? (
                          <Pill tone="ok">new items pin this</Pill>
                        ) : (
                          <Pill tone="mute">pinned only</Pill>
                        ),
                    },
                    { key: 'h', header: 'Hash', render: (x) => <ShortHash hash={x.ref.hash} /> },
                    {
                      key: 'n',
                      header: 'Items pinned',
                      align: 'right',
                      render: (x) => x.pinned_items,
                    },
                  ]}
                  rows={[...v.versions].reverse()}
                  rowKey={(x) => x.ref.version}
                />
              </Card>
              {shown ? (
                <Card title={`Lanes of ${shown.ref.version}`} flush>
                  <KeyValue rows={[['Hash', <code key="h">{shown.ref.hash}</code>]]} />
                  {shown.lanes.length === 0 ? (
                    <p className="muted pg-pad">
                      This release did not verify against its pin, so its lanes are not shown.
                    </p>
                  ) : (
                    <Lanes v={shown} />
                  )}
                </Card>
              ) : null}
            </>
          );
        }}
      </Read>
    </>
  );
}
