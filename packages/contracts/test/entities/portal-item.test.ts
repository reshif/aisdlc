import { describe, expect, it } from 'vitest';
import {
  ARTEFACT_DOCUMENT_GROUP,
  ArtefactTypeValues,
  DocumentGroupValues,
  ItemDocumentsView,
  ItemRequestView,
  ItemTimelineKind,
  ItemEventTypeValues,
  cutDocumentsView,
  cutRequestView,
} from '../../src/index.js';

const ITEM = '33333333-4444-4555-8666-777777777777';
const H = 'a'.repeat(64);

const request = ItemRequestView.parse({
  item_id: ITEM,
  project_id: 'testbed',
  repo: 'acme/app',
  request_id: ITEM,
  requester: 'alice',
  channel: 'N1',
  request_text: {
    text: 'Add an audit log',
    taint: 'untrusted',
    origin: 'request',
    provenance: {
      channel: 'N1',
      source: null,
      received_at: '2026-11-09T10:00:00.000Z',
      submitted_by: 'alice',
      raw_sha256: H,
      normalised_sha256: H,
    },
    flags: [],
  },
  text_withheld: false,
  text_sha256: H,
  injection: null,
  dedupe_links: [],
  conflict_candidates: [],
  asked_lane: 'L4',
  proposed_lane: 'L4',
  lane: null,
  lane_bound_by: null,
  intake_route: 'normal',
  eligibility_reason: 'eligible',
  lane_opens_at: 'light',
  data_class: 'D2',
});

const docs = ItemDocumentsView.parse({
  item_id: ITEM,
  project_id: 'testbed',
  documents: [
    {
      type: 'spec_delta',
      group: 'spec',
      versions: [
        {
          version: 1,
          sha256: H,
          step: '3.2',
          stored_at: '2026-11-09T10:00:00.000Z',
          bytes: 10,
          author: { kind: 'factory' },
          markdown: '# Spec',
          withheld: false,
          gates: [],
        },
      ],
    },
  ],
  not_intact: 0,
  data_class: 'D2',
});

describe('the item page views (P2-1)', () => {
  it('withholds the request text below D1 and keeps its hash', () => {
    const cut = cutRequestView(request, 'D0');
    expect(cut.request_text).toBeNull();
    expect(cut.text_withheld).toBe(true);
    expect(cut.text_sha256).toBe(H);
    expect(cutRequestView(request, 'D1').request_text?.text).toBe('Add an audit log');
  });

  it('withholds the documents text below D1 and keeps versions and hashes', () => {
    const cut = cutDocumentsView(docs, 'D0');
    const v = cut.documents[0]?.versions[0];
    expect(v?.markdown).toBeNull();
    expect(v?.withheld).toBe(true);
    expect(v?.sha256).toBe(H);
    expect(cutDocumentsView(docs, 'D1').documents[0]?.versions[0]?.markdown).toBe('# Spec');
  });

  it('gives every artefact type a document group, and the timeline every item event', () => {
    for (const t of ArtefactTypeValues) {
      expect(DocumentGroupValues).toContain(ARTEFACT_DOCUMENT_GROUP[t]);
    }
    for (const e of ItemEventTypeValues) expect(ItemTimelineKind.options).toContain(e);
    expect(ItemTimelineKind.options).toContain('artefact.stored');
  });
});
