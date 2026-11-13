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

/** The rail is ready once the approval is prepared and its evidence reported as viewed. */
async function readyToDecide() {
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled());
}

async function openVerify() {
  await userEvent.click(await screen.findByRole('tab', { name: 'Verify' }));
}

describe('the Verify tab of the item page', () => {
  it('shows the five checks with facts and findings, the raised gate and gate-check, at V2', async () => {
    mockApi(itemRoutes());
    renderAt(`/items/${ITEM}`);
    await openVerify();
    expect(screen.getByRole('tab', { name: 'Verify' })).toHaveAttribute('aria-selected', 'true');
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
    await openVerify();
    expect(await screen.findByTestId('withheld')).toHaveTextContent(/hidden/);
    expect(screen.queryByText('CODEOWNERS changed')).toBeNull();
  });

  it('reads an unreachable gate-check as unknown, never success', async () => {
    mockApi(itemRoutes({ [`GET ${ITEM_PATH}/gate-check`]: { json: gateCheckView('unknown') } }));
    renderAt(`/items/${ITEM}`);
    await openVerify();
    const s = await screen.findByTestId('gate-check-status');
    expect(s).toHaveAttribute('data-outcome', 'unknown');
    expect(s).not.toHaveTextContent('success');
  });

  it('offers no Verify tab below view level V2 and never asks for the results', async () => {
    const m = mockApi(itemRoutes({ 'GET /api/me/access': { json: accessAt('V1', 'D0') } }));
    renderAt(`/items/${ITEM}`);
    expect(await screen.findByTestId('verify-hidden')).toHaveTextContent(/view level details/);
    expect(screen.queryByRole('tab', { name: 'Verify' })).toBeNull();
    expect(m.calls.some((c) => c.path.includes('/verify'))).toBe(false);
  });

  it('links to the pack once 7.6 signed one', async () => {
    mockApi(
      itemRoutes({ [`GET ${ITEM_PATH}/verify`]: { json: verifyView({ pack: packSummary() }) } }),
    );
    renderAt(`/items/${ITEM}`);
    await openVerify();
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

describe('deciding the approvals S7 raises (portal v2 Decide)', () => {
  it.each([
    ['E6', 'Change a locked test'],
    ['X3', 'Allow new dependency'],
    ['E2', 'Allow a rule exception'],
    ['X2', 'Allow protected-file change'],
    ['E4', 'Choose what happens next'],
  ])(
    '%s: says what it binds and decides with a reason bound into the decision',
    async (gate, title) => {
      const user = userEvent.setup();
      const m = mockApi(gateRoutes(gate));
      renderAt(`/decide/${CARD}`);
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      // what it binds, in words: never a raw hash or code on the decision screen
      const what = screen.getByTestId('what');
      expect(within(what).getByTestId('binds')).toHaveTextContent('The track and its approvals');
      expect(what).not.toHaveTextContent(SUBJECT);
      expect(what).toHaveTextContent(`For commit ${HEAD.slice(0, 7)}`);
      await readyToDecide();
      await user.type(screen.getByLabelText('Reason'), 'Looked at the diff and the facts.');
      await user.click(screen.getByRole('button', { name: 'Approve' }));
      expect(await screen.findByTestId('receipt')).toHaveTextContent('decision log entry 42');
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

  it('the old /cards link opens the same screen', async () => {
    mockApi(gateRoutes('E6'));
    renderAt(`/cards/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Change a locked test' }),
    ).toBeInTheDocument();
  });

  it('security review: approve is a false alarm, reject confirms the hold', async () => {
    const user = userEvent.setup();
    const m = mockApi(gateRoutes('SECT'));
    renderAt(`/decide/${CARD}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Security review' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('what')).toHaveTextContent(/Approve if it was a false alarm/);
    await user.click(screen.getByRole('button', { name: /What this approval is about/ }));
    expect(screen.getByText('stub_probe_passed')).toBeInTheDocument();
    await readyToDecide();
    await user.type(screen.getByLabelText('Reason'), 'The test asserts a constant.');
    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({ decision: 'reject' });
  });

  it('refuses to send a refusal without a reason (nothing is decided)', async () => {
    const user = userEvent.setup();
    const m = mockApi(gateRoutes('E6'));
    renderAt(`/decide/${CARD}`);
    await screen.findByRole('heading', { level: 1, name: 'Change a locked test' });
    await readyToDecide();
    await user.click(screen.getByRole('button', { name: /^Reject/ }));
    expect(screen.getByText(/Say why: a reason is saved/)).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toHaveAttribute('aria-invalid', 'true');
    expect(decideCalls(m.calls)).toHaveLength(0);
  });

  it('two people: shows the first approval and the second approver binds the same reason', async () => {
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
    renderAt(`/decide/${CARD}`);
    expect(await screen.findByText(/Needs two people: 1 of 2/)).toHaveTextContent(
      'approved by Bob Builder',
    );
    expect(screen.getByTestId('history')).toHaveTextContent('Bob Builder');
    await user.click(screen.getByRole('button', { name: /What this approval is about/ }));
    expect(screen.getByTestId('patch-hash')).toHaveTextContent('9'.repeat(64));
    await readyToDecide();
    expect(screen.getByLabelText('Reason')).toHaveValue('Ownership move agreed in the team.');
    expect(screen.getByLabelText('Reason')).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({
      reason: 'Ownership move agreed in the team.',
    });
  });

  it('two people: the first approver cannot be the second, and nothing is prepared', async () => {
    const mine = {
      ledger_seq: 40,
      actor: 'alice',
      decision: 'approve',
      at: '2026-11-12T09:00:00.000Z',
      sod_waiver: false,
    };
    const m = mockApi(gateRoutes('X2', gateCard('X2'), gateContext('X2', { decisions: [mine] })));
    renderAt(`/decide/${CARD}`);
    expect(await screen.findByText(/You approved first \(1 of 2\)/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(m.calls.some((c) => c.path.endsWith('/gate/prepare'))).toBe(false);
  });

  it('forbidden: says why and who to ask; the evidence stays readable and nothing is prepared', async () => {
    const m = mockApi(
      gateRoutes(
        'E2',
        gateCard('E2', {
          may_decide: false,
          why_not: { code: 'pdp_denied', reasons: ['no_policy_permits'] },
        }),
      ),
    );
    renderAt(`/decide/${CARD}`);
    expect(await screen.findByRole('note')).toHaveTextContent(
      'None of your roles lets you decide this approval on testbed. Ask Alice Admin and Bob Builder.',
    );
    expect(screen.getByTestId('deciders')).toHaveTextContent('Alice Admin');
    expect(screen.getByRole('link', { name: 'Request access' })).toHaveAttribute(
      'href',
      '/me/access',
    );
    expect(screen.queryByLabelText('Reason')).toBeNull();
    expect(screen.getByTestId('evidence')).toBeInTheDocument();
    expect(m.calls.some((c) => c.path.endsWith('/gate/prepare'))).toBe(false);
  });

  it("asks to confirm it's you where the approval needs it and binds the proof into the vote", async () => {
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
    renderAt(`/decide/${CARD}`);
    await screen.findByRole('heading', { level: 1, name: 'Change a locked test' });
    await readyToDecide();
    await user.click(screen.getByRole('button', { name: "Confirm it's you" }));
    expect(await screen.findByText('It is you: decide now.')).toBeInTheDocument();
    expect(m.calls.find((c) => c.path === '/api/step-up')?.body).toMatchObject({
      subject_hash: SUBJECT,
    });
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByTestId('receipt');
    expect(decideCalls(m.calls)[0]?.body).toMatchObject({
      votes: [{ nonce: 'nonce-E6', step_up: { proof: 'proof-1' } }],
    });
  });

  it('the factory admin decides outside the rules with a reason, sent as the override', async () => {
    const user = userEvent.setup();
    const admin = {
      ...accessAt('V2'),
      bindings: [
        ...accessAt('V2').bindings,
        {
          binding_id: 'b-admin',
          role_id: 'factory.admin',
          scope: { kind: 'fleet', ref: 'fleet' },
          project_id: null,
          blockers: [],
        },
      ],
    };
    const m = mockApi({
      ...gateRoutes(
        'E2',
        gateCard('E2', { may_decide: false, why_not: { code: 'not_slot_holder', reasons: [] } }),
      ),
      'GET /api/me/access': { json: admin },
    });
    renderAt(`/decide/${CARD}`);
    await user.click(await screen.findByRole('button', { name: 'Decide as factory admin' }));
    expect(m.calls.some((c) => c.path.endsWith('/gate/prepare'))).toBe(false);
    // approving outside the rules needs a reason too
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(decideCalls(m.calls)).toHaveLength(0);
    await user.type(screen.getByLabelText('Reason'), 'Approver on leave; risk accepted.');
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    await screen.findByTestId('receipt');
    const header = encodeURIComponent('Approver on leave; risk accepted.');
    for (const p of ['/gate/prepare', '/gate/evidence', '/gate/decide']) {
      expect(m.calls.find((c) => c.path.endsWith(p))?.headers['x-aisdlc-override-reason']).toBe(
        header,
      );
    }
  });

  it('X3: licence and advisories it does not know read unknown', async () => {
    const user = userEvent.setup();
    mockApi(gateRoutes('X3'));
    renderAt(`/decide/${CARD}`);
    await user.click(await screen.findByRole('button', { name: /What this approval is about/ }));
    const pkg = await screen.findByTestId('package');
    expect(pkg).toHaveTextContent('libphonenumber-js');
    expect(pkg).toHaveTextContent(/Licence\s*\[unknown\]/);
  });

  it('E2: shows the factory rules report as text', async () => {
    const user = userEvent.setup();
    mockApi(gateRoutes('E2'));
    renderAt(`/decide/${CARD}`);
    await user.click(await screen.findByRole('button', { name: /What this approval is about/ }));
    expect(await screen.findByTestId('constitution')).toHaveTextContent('C-EGRESS: violation');
  });

  it('a phone gets the decision as a bottom sheet the person opens', async () => {
    const user = userEvent.setup();
    mockApi(gateRoutes('E6'));
    renderAt(`/decide/${CARD}`);
    await screen.findByRole('heading', { level: 1, name: 'Change a locked test' });
    const toggle = screen.getByRole('button', { name: 'Decide' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  });
});

describe('the onboarding files change on an onboarding record', () => {
  const S0 = '0190a000-0000-7000-8000-0000000000a1';
  const file = (path: string, source: string, c: string) => ({
    path,
    source,
    sha256: c.repeat(64),
    bytes: 120,
    protected_rule: 'factory',
  });
  const pack = (over: Record<string, unknown> = {}) => ({
    kind: 'light',
    s0_id: S0,
    repo: 'acme/app',
    base_sha: 'a'.repeat(40),
    branch: `agent/${S0}/onboarding-pack`,
    patch_hash: SUBJECT,
    bound: true,
    intact: true,
    deciding_card: {
      card: 'C2',
      card_id: '0190a000-0000-7000-8000-0000000000c2',
      payload_hash: 'e'.repeat(64),
    },
    files: [
      file('.factory/knowledge/claims.yaml', 'claims', '1'),
      file('.github/CODEOWNERS', 'codeowners', '2'),
    ],
    codeowners: {
      outcome: 'rendered',
      rendered: true,
      owners: [{ principal_id: 'alice', login: 'alice-gh', reason: 'mapped' }],
    },
    oracle_lock: null,
    seeds: [],
    ...over,
  });
  const ctx = (k: ReturnType<typeof pack>) =>
    gateContext('X2', {
      subject_kind: 's0_record',
      item_id: null,
      s0_id: S0,
      station: 'X2',
      step: '0.2',
      check: null,
      head_sha: null,
      patch: { patch_hash: SUBJECT, source: 'bound_artefact', bound: true },
      onboarding_pack: k,
    });

  it('shows the files it binds in the detail, and says do not decide when they do not match', async () => {
    const user = userEvent.setup();
    mockApi(gateRoutes('X2', gateCard('X2', { item_id: null }), ctx(pack())));
    const { unmount } = renderAt(`/decide/${CARD}`);
    await user.click(await screen.findByRole('button', { name: /What this approval is about/ }));
    const files = within(screen.getByTestId('onboarding-pack')).getByTestId('pack-files');
    expect(files).toHaveTextContent('.github/CODEOWNERS');
    unmount();
    mockApi(gateRoutes('X2', gateCard('X2', { item_id: null }), ctx(pack({ intact: false }))));
    renderAt(`/decide/${CARD}`);
    await user.click(await screen.findByRole('button', { name: /What this approval is about/ }));
    expect(await screen.findByText(/Do not decide/)).toBeInTheDocument();
  });
});
