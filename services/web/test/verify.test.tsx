import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { me, mockApi, renderAt, type Call } from './helpers';
import {
  CARD,
  HEAD,
  ITEM,
  OBJ,
  PACK,
  SUBJECT,
  accessAt,
  decided,
  evidenceView,
  gateCard,
  gateCheckView,
  gateContext,
  itemView,
  packSummary,
  prepared,
  verifyView,
  x2Step,
} from './verifyFixtures';

// PLAN M14.6: S7 on the item page (the Verify tab), the Evidence Pack viewer, and the gate screens of Q1 (its SECT
// triage), E6, X2, X3 and E2. Every read is the bff's; every decision is prepare, evidence, decide with a reason, and
// nothing is sent without a press.

const ITEM_PATH = `/api/items/${ITEM}`;
const CARD_PATH = `/api/cards/${CARD}`;

const itemRoutes = (over: Record<string, unknown> = {}) => ({
  'GET /api/me': { json: me() },
  'GET /api/me/access': { json: accessAt('V2') },
  [`GET ${ITEM_PATH}`]: { json: itemView() },
  [`GET ${ITEM_PATH}/verify`]: { json: verifyView() },
  [`GET ${ITEM_PATH}/gate-check`]: { json: gateCheckView() },
  ...over,
});

const gateRoutes = (gate: string, card = gateCard(gate), ctx = gateContext(gate)) => ({
  'GET /api/me': { json: me() },
  'GET /api/me/access': { json: accessAt('V2') },
  [`GET ${CARD_PATH}`]: { status: 404, json: { error: { code: 'not_found', message: 'no' } } },
  [`GET ${CARD_PATH}/gate`]: { json: card },
  [`GET ${CARD_PATH}/gate/context`]: { json: ctx },
  [`POST ${CARD_PATH}/gate/prepare`]: { json: prepared(gate === 'Q1' ? 'SECT' : gate) },
  [`POST ${CARD_PATH}/gate/evidence`]: { json: { evidence_viewed: true } },
  [`POST ${CARD_PATH}/gate/decide`]: (c: Call) => ({
    json: decided(gate, (c.body as { decision: string }).decision),
  }),
});

const decideCalls = (calls: readonly Call[]) =>
  calls.filter((c) => c.method === 'POST' && c.path.endsWith('/gate/decide'));

async function readyToDecide() {
  await waitFor(() =>
    expect(screen.queryByText(/Getting the decision form ready/)).not.toBeInTheDocument(),
  );
}

describe('the Verify tab of the item page', () => {
  it('shows the five checks with facts and findings, the raised gate and gate-check, at V2', async () => {
    mockApi(itemRoutes());
    renderAt(`/items/${ITEM}`);
    // S7: the Verify tab is the one selected
    const tab = await screen.findByRole('tab', { name: 'Verify' });
    expect(tab).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByRole('region', { name: 'S7 checks' })).toBeInTheDocument();
    const x2 = document.querySelector('[data-step="7.4"]') as HTMLElement;
    expect(x2).toHaveAttribute('data-status', 'raised');
    expect(within(x2).getByText('CODEOWNERS changed')).toBeInTheDocument();
    expect(within(x2).getByRole('link', { name: 'Open X2' })).toHaveAttribute(
      'href',
      `/cards/${CARD}`,
    );
    expect(screen.getByText(/5 of 6 killed · 0\.83 \(min 0\.5\)/)).toBeInTheDocument();
    expect(screen.getByTestId('raised-banner')).toHaveTextContent('7.4 raised X2');
    expect(document.querySelector('[data-step="7.5"]')).toHaveAttribute('data-status', 'not_run');
    expect(await screen.findByTestId('gate-check-status')).toHaveAttribute(
      'data-outcome',
      'success',
    );
    expect(screen.getByText('3 of 5')).toBeInTheDocument();
  });

  it('says the text it withholds instead of showing it (below the data class)', async () => {
    mockApi(
      itemRoutes({
        [`GET ${ITEM_PATH}/verify`]: {
          json: verifyView({
            steps: [...verifyView().steps.slice(0, 3), x2Step(null, true), verifyView().steps[4]],
            data_class: 'D0',
          }),
        },
      }),
    );
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('withheld')).toHaveTextContent(/hidden/);
    expect(screen.queryByText('CODEOWNERS changed')).toBeNull();
  });

  it('reads an unreachable gate-check as unknown, never success', async () => {
    mockApi(itemRoutes({ [`GET ${ITEM_PATH}/gate-check`]: { json: gateCheckView('unknown') } }));
    renderAt(`/items/${ITEM}`);
    const s = await screen.findByTestId('gate-check-status');
    expect(s).toHaveAttribute('data-outcome', 'unknown');
    expect(s).not.toHaveTextContent('success');
  });

  it('offers no Verify tab below view level V2 and never asks for the results', async () => {
    const m = mockApi(itemRoutes({ 'GET /api/me/access': { json: accessAt('V1', 'D0') } }));
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('verify-hidden')).toHaveTextContent(/view level V2/);
    expect(screen.queryByRole('tab', { name: 'Verify' })).toBeNull();
    expect(m.calls.some((c) => c.path.includes('/verify'))).toBe(false);
  });

  it('links to the pack once 7.6 signed one', async () => {
    mockApi(
      itemRoutes({ [`GET ${ITEM_PATH}/verify`]: { json: verifyView({ pack: packSummary() }) } }),
    );
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByRole('link', { name: 'Open the pack' })).toHaveAttribute(
      'href',
      `/items/${ITEM}/evidence`,
    );
  });
});

describe('the Evidence Pack viewer', () => {
  it('shows the binding, the steps, the gates, the signature, the download and the offline command', async () => {
    const user = userEvent.setup();
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${ITEM_PATH}/evidence`]: { json: evidenceView() },
      [`GET ${ITEM_PATH}/gate-check`]: { json: gateCheckView() },
    });
    renderAt(`/items/${ITEM}/evidence`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Evidence Pack · Unit main' }),
    ).toBeInTheDocument();
    expect(screen.getByText(PACK)).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Steps of the pack' })).toBeInTheDocument();
    expect(screen.getAllByText('passed')).toHaveLength(5);
    expect(screen.getByRole('table', { name: 'Gates the item raised' })).toHaveTextContent(
      '#18166',
    );
    expect(screen.getByRole('link', { name: 'Download signed pack' })).toHaveAttribute(
      'href',
      `${ITEM_PATH}/evidence/${PACK}/signed`,
    );
    expect(screen.getByTestId('verify-command')).toHaveTextContent(
      `aisdlc-verify-pack --pack ${OBJ}.json --notary-key notary-evidence.jwk --head ${HEAD}`,
    );
    expect(screen.getByRole('list', { name: 'Verdict history' })).toHaveTextContent('head_moved');
    await user.click(screen.getByRole('button', { name: 'Verify offline' }));
    expect(screen.getByTestId('offline-check')).toHaveTextContent(/this page does not vouch/);
  });

  it('says so when the item has no pack yet', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${ITEM_PATH}/evidence`]: {
        json: evidenceView({ packs: [], pack: null, contents: null, verify_command: null }),
      },
      [`GET ${ITEM_PATH}/gate-check`]: { json: gateCheckView('unknown') },
    });
    renderAt(`/items/${ITEM}/evidence`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No Evidence Pack yet' }),
    ).toBeInTheDocument();
  });

  it('shows a pack that is not passing as such', async () => {
    mockApi({
      'GET /api/me': { json: me() },
      [`GET ${ITEM_PATH}/evidence`]: {
        json: evidenceView({
          pack: packSummary({
            passing: false,
            disposition: { kind: 'handoff', trigger: 'ET6', step: '7.6', reason_code: 'gate' },
          }),
        }),
      },
      [`GET ${ITEM_PATH}/gate-check`]: { json: gateCheckView() },
    });
    renderAt(`/items/${ITEM}/evidence`);
    expect(await screen.findByText(/signed but not passing/)).toHaveTextContent('ET6 at 7.6');
  });
});

describe('the gate screens S7 raises', () => {
  it.each([
    ['E6', 'Locked test change', 'Approve the test change'],
    ['X3', 'New dependency', 'Approve the dependency'],
    ['E2', 'Constitution exception', 'Approve the exception'],
    ['X2', 'Protected-path change', 'Approve'],
  ])(
    '%s: shows what it binds and decides with a reason bound into the decision',
    async (gate, title, approve) => {
      const user = userEvent.setup();
      const m = mockApi(gateRoutes(gate));
      renderAt(`/cards/${CARD}`);
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      expect(screen.getByTestId('subject-hash')).toHaveTextContent(SUBJECT);
      expect(screen.getByRole('region', { name: 'What is being decided' })).toHaveTextContent(
        /station/,
      );
      await readyToDecide();
      await user.click(screen.getByLabelText(/I have read the evidence/));
      await user.type(screen.getByLabelText(/Reason/), 'Looked at the diff and the facts.');
      await user.click(screen.getByRole('button', { name: approve }));
      expect(await screen.findByTestId('receipt')).toHaveTextContent('#42');
      const d = decideCalls(m.calls);
      expect(d).toHaveLength(1);
      expect(d[0]?.body).toEqual({
        decision: 'approve',
        reason: 'Looked at the diff and the facts.',
        votes: [{ nonce: `nonce-${gate}` }],
      });
      expect(d[0]?.headers['x-csrf-token']).toBe('csrf-token-of-alice');
    },
  );

  it('Q1: the triage is a choice of finding; "confirmed" is the rejection of SECT', async () => {
    const user = userEvent.setup();
    const m = mockApi(gateRoutes('SECT'));
    renderAt(`/cards/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Test integrity quarantine' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Quarantined\./)).toBeInTheDocument();
    expect(screen.getByText('stub_probe_passed')).toBeInTheDocument();
    await readyToDecide();
    const record = screen.getByRole('button', { name: 'Record my finding' });
    expect(record).toBeDisabled();
    await user.click(screen.getByRole('radio', { name: /Confirmed: bent tests/ }));
    await user.click(screen.getByLabelText(/I have read the evidence/));
    await user.type(screen.getByLabelText(/Reason/), 'The oracle asserts a constant.');
    await user.click(record);
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({ decision: 'reject' });
  });

  it('refuses to send without a reason (nothing is decided)', async () => {
    const user = userEvent.setup();
    const m = mockApi(gateRoutes('E6'));
    renderAt(`/cards/${CARD}`);
    await screen.findByRole('heading', { level: 1, name: 'Locked test change' });
    await readyToDecide();
    await user.click(screen.getByLabelText(/I have read the evidence/));
    await user.click(screen.getByRole('button', { name: 'Reject (D2)' }));
    expect(screen.getByTestId('decide-issues')).toHaveTextContent(/goes on the ledger/);
    expect(decideCalls(m.calls)).toHaveLength(0);
  });

  it('X2 two-person: shows the first decision and lets a different person approve second', async () => {
    const user = userEvent.setup();
    const first = {
      ledger_seq: 40,
      actor: 'bob',
      decision: 'approve',
      at: '2026-11-12T09:00:00.000Z',
      sod_waiver: false,
    };
    const m = mockApi(
      gateRoutes(
        'X2',
        gateCard('X2', { decision_reason: 'Ownership move agreed in the team.' }),
        gateContext('X2', { decisions: [first] }),
      ),
    );
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('two-person')).toHaveTextContent(
      /1 of 2 approvals\. Bob Builder approved first \(ledger #40/,
    );
    expect(screen.getByTestId('patch-hash')).toHaveTextContent('9'.repeat(64));
    await readyToDecide();
    // the second approver binds the same payload: the first reason, read-only
    expect(screen.getByLabelText(/Reason/)).toHaveValue('Ownership move agreed in the team.');
    expect(screen.getByLabelText(/Reason/)).toHaveAttribute('readonly');
    await user.click(screen.getByLabelText(/I have read the evidence/));
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({
      reason: 'Ownership move agreed in the team.',
    });
  });

  it('X2 two-person: the first approver cannot be the second, and no form is prepared', async () => {
    const mine = {
      ledger_seq: 40,
      actor: 'alice',
      decision: 'approve',
      at: '2026-11-12T09:00:00.000Z',
      sod_waiver: false,
    };
    const m = mockApi(gateRoutes('X2', gateCard('X2'), gateContext('X2', { decisions: [mine] })));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('cant-decide')).toHaveTextContent(
      /You approved first \(1 of 2\)\. The two-person rule needs a different second person/,
    );
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(m.calls.some((c) => c.path.endsWith('/gate/prepare'))).toBe(false);
  });

  it('says why not, in the PDP’s words, to someone the policy refuses', async () => {
    const m = mockApi(
      gateRoutes(
        'E2',
        gateCard('E2', {
          may_decide: false,
          why_not: { code: 'pdp_denied', reasons: ['no_policy_permits'] },
        }),
      ),
    );
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('cant-decide')).toHaveTextContent(
      'None of your roles allows this here.',
    );
    expect(screen.getByTestId('deciders')).toHaveTextContent('Alice Admin');
    expect(screen.queryByLabelText(/Reason/)).toBeNull();
    expect(m.calls.some((c) => c.path.endsWith('/gate/prepare'))).toBe(false);
  });

  it('asks for a step-up where the gate needs one and binds the proof into the vote', async () => {
    const user = userEvent.setup();
    const routes = {
      ...gateRoutes(
        'E6',
        gateCard('E6'),
        gateContext('E6', { step_up: { required: true, bound_hash: SUBJECT } }),
      ),
      [`POST ${CARD_PATH}/gate/prepare`]: { json: prepared('E6', true) },
      'POST /api/step-up': {
        json: { status: 'ready', method: 'reconfirm', proof: 'proof-1', bound_hash: SUBJECT },
      },
    };
    const m = mockApi(routes);
    renderAt(`/cards/${CARD}`);
    await screen.findByRole('heading', { level: 1, name: 'Locked test change' });
    await readyToDecide();
    await user.click(screen.getByRole('button', { name: 'Confirm my identity' }));
    expect(await screen.findByTestId('stepup-ready')).toBeInTheDocument();
    const su = m.calls.find((c) => c.path === '/api/step-up');
    expect(su?.body).toMatchObject({ subject_hash: SUBJECT });
    await user.click(screen.getByLabelText(/I have read the evidence/));
    await user.type(screen.getByLabelText(/Reason/), 'Spec r3 moved the rounding.');
    await user.click(screen.getByRole('button', { name: 'Approve the test change' }));
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({
      votes: [{ nonce: 'nonce-E6', step_up: { proof: 'proof-1' } }],
    });
  });

  it('X3: licence and advisories it does not know read [unknown]', async () => {
    mockApi(gateRoutes('X3'));
    renderAt(`/cards/${CARD}`);
    const pkg = await screen.findByTestId('package');
    expect(pkg).toHaveTextContent('libphonenumber-js');
    expect(pkg).toHaveTextContent(/Licence\s*\[unknown\]/);
    expect(pkg).toHaveTextContent(/no advisory database/);
  });

  it('E2: shows the constitution report as text', async () => {
    mockApi(gateRoutes('E2'));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByTestId('constitution')).toHaveTextContent('C-EGRESS: violation');
  });
});

describe('X2 on an S0 record: the onboarding pack (M16)', () => {
  const S0 = '0190a000-0000-7000-8000-0000000000a1';
  const file = (path: string, source: string, c: string) => ({
    path,
    source,
    sha256: c.repeat(64),
    bytes: 120,
    protected_rule: 'factory',
  });
  const pack = (kind: 'light' | 'full', over: Record<string, unknown> = {}) => ({
    kind,
    s0_id: S0,
    repo: 'acme/app',
    base_sha: 'a'.repeat(40),
    branch: `agent/${S0}/${kind === 'light' ? 'onboarding-pack' : 'onboarding-full-pack'}`,
    patch_hash: SUBJECT,
    bound: true,
    intact: true,
    deciding_card: {
      card: kind === 'light' ? 'C2' : 'C3',
      card_id: '0190a000-0000-7000-8000-0000000000c2',
      payload_hash: 'e'.repeat(64),
    },
    files:
      kind === 'light'
        ? [
            file('.factory/knowledge/claims.yaml', 'claims', '1'),
            file('.github/CODEOWNERS', 'codeowners', '2'),
          ]
        : [file('.factory/oracle-lock.json', 'oracle_lock', '3'), file('specs/m.md', 'seed', '4')],
    codeowners:
      kind === 'light'
        ? {
            outcome: 'rendered',
            rendered: true,
            owners: [
              { principal_id: 'alice', login: 'alice-gh', reason: 'mapped' },
              { principal_id: 'carol', login: null, reason: 'no_linked_login' },
            ],
          }
        : null,
    oracle_lock:
      kind === 'full'
        ? {
            path: '.factory/oracle-lock.json',
            lock_hash: '5'.repeat(64),
            tests: 4,
            truncated: false,
            file_sha256: '3'.repeat(64),
          }
        : null,
    seeds:
      kind === 'full'
        ? [
            {
              seed_id: 'seed-1',
              area: 'packages/m',
              path: 'specs/m.md',
              text_sha256: '6'.repeat(64),
            },
          ]
        : [],
    ...over,
  });
  const s0ctx = (k: ReturnType<typeof pack>) =>
    gateContext('X2', {
      subject_kind: 's0_record',
      item_id: null,
      s0_id: S0,
      station: 'X2',
      step: k.kind === 'light' ? '0.2' : '0.3',
      check: null,
      head_sha: null,
      patch: { patch_hash: SUBJECT, source: 'bound_artefact', bound: true },
      onboarding_pack: k,
    });

  it('Light: the rendered files with their hashes, the patch, card 2 and CODEOWNERS; links to the record', async () => {
    mockApi(gateRoutes('X2', gateCard('X2'), s0ctx(pack('light'))));
    renderAt(`/cards/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Onboarding pack: protected paths' }),
    ).toBeInTheDocument();
    const p = screen.getByTestId('onboarding-pack');
    expect(within(p).getByTestId('patch-hash')).toHaveTextContent(SUBJECT);
    const files = within(p).getByTestId('pack-files');
    expect(files).toHaveTextContent('.factory/knowledge/claims.yaml');
    expect(files).toHaveTextContent('.github/CODEOWNERS');
    expect(files).toHaveTextContent('1'.repeat(16));
    expect(p).toHaveTextContent(/Card 2 payload/);
    const co = screen.getByTestId('pack-codeowners');
    expect(co).toHaveTextContent('@alice-gh');
    expect(co).toHaveTextContent('left out: no linked login');
    expect(screen.queryByTestId('pack-full')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open record' })).toHaveAttribute('href', `/s0/${S0}`);
  });

  it('Full: the oracle lock and the seeds card 3 made intended', async () => {
    mockApi(gateRoutes('X2', gateCard('X2'), s0ctx(pack('full'))));
    renderAt(`/cards/${CARD}`);
    const f = await screen.findByTestId('pack-full');
    expect(f).toHaveTextContent('.factory/oracle-lock.json');
    expect(f).toHaveTextContent(/Tests locked\s*4/);
    expect(f).toHaveTextContent('packages/m');
    expect(screen.queryByTestId('pack-codeowners')).not.toBeInTheDocument();
  });

  it('a pack that does not match its record says do not decide', async () => {
    mockApi(gateRoutes('X2', gateCard('X2'), s0ctx(pack('light', { intact: false }))));
    renderAt(`/cards/${CARD}`);
    expect(await screen.findByRole('alert')).toHaveTextContent(/Do not decide/);
  });
});
