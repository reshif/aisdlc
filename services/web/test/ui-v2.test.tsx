import { GLOSSARY, label } from '@aisdlc/contracts';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  AppShell,
  CommandPalette,
  ConfirmDelete,
  DecisionRail,
  EmptyState,
  ErrorState,
  EvidenceGrid,
  InfoTip,
  MenuButton,
  NeedsYouTable,
  PageHeader,
  PropertiesPanel,
  Scorecard,
  SecretField,
  StageStrip,
  Stepper,
  Term,
  WireTerm,
  orderNeedsYou,
  type NeedsYouRow,
  type ShellNavGroup,
} from '../src/ui';

// Portal v2's layout components: their roles, names and keyboard behaviour, and that every word they print is
// the glossary's (a code appears only as the chip the glossary allows).

const link = (to: string, children: ReactNode, className?: string) => (
  <a href={to} {...(className ? { className } : {})}>
    {children}
  </a>
);

describe('Term', () => {
  it('shows the plain label with the tooltip; the code only where the glossary keeps it', () => {
    const { rerender, container } = render(<Term family="gate" value="G3" />);
    expect(container).toHaveTextContent(/^Approve the plan$/);
    expect(container.querySelector('.ui-term')).toHaveAttribute('title', GLOSSARY.gate.G3.explain);
    rerender(<Term family="gate" value="G3" showCode />);
    expect(container).toHaveTextContent('Approve the plan G3');
    // a stage's code is for the audit screens only
    rerender(<Term family="stage" value="S4" showCode />);
    expect(container).toHaveTextContent(/^Design$/);
    rerender(<Term family="stage" value="S4" showCode audience="audit" />);
    expect(container).toHaveTextContent('Design S4');
    // an item phase never shows its code
    rerender(<Term family="phase" value="Handoff" showCode audience="audit" />);
    expect(container).toHaveTextContent(/^Needs a person$/);
  });

  it('a value off the wire the glossary does not have is "Unknown", never the raw code', () => {
    const { container } = render(<WireTerm family="gate" value="G9" showCode />);
    expect(container).toHaveTextContent(/^Unknown$/);
  });

  it('InfoTip opens its note on press and closes on Escape', async () => {
    const user = userEvent.setup();
    render(<InfoTip about="Readiness scorecard" text="What this repo is ready for." />);
    const b = screen.getByRole('button', { name: 'About Readiness scorecard' });
    await user.click(b);
    expect(b).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('note')).toHaveTextContent('What this repo is ready for.');
    await user.keyboard('{Escape}');
    expect(b).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('AppShell', () => {
  const NAV: ShellNavGroup[] = [
    {
      id: 'work',
      label: 'Work',
      entries: [
        { id: 'home', label: 'Home', to: '/', current: false },
        {
          id: 'inbox',
          label: 'Inbox',
          to: '/inbox',
          current: false,
          count: 3,
          countLabel: 'waiting on you',
        },
      ],
    },
    {
      id: 'run',
      label: 'Run',
      entries: [
        {
          id: 'operate',
          label: 'Operate',
          to: '/kill',
          current: false,
          children: [
            { id: 'stop', label: 'Emergency stop', to: '/kill', current: true },
            { id: 'health', label: 'Health', to: '/health', current: false },
          ],
        },
        {
          id: 'agents',
          label: 'Agents',
          to: '/agents',
          current: false,
          children: [{ id: 'evals', label: 'Evaluations', to: '/evals', current: false }],
        },
      ],
    },
  ];
  const renderShell = (key = 'a') =>
    render(
      <AppShell
        brand={<a href="/">AISDLC</a>}
        nav={NAV}
        locationKey={key}
        renderLink={(to, children, props) => (
          <a href={to} {...props}>
            {children}
          </a>
        )}
      >
        <p>Content</p>
      </AppShell>,
    );

  it('groups the nav under headings; sub-pages are tabs of the page header, not a second level', () => {
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('heading', { name: 'Run' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Inbox 3 waiting on you' })).toBeInTheDocument();
    // a page whose sub-page is open is the page "here"; the sub-pages are not in the sidebar
    expect(within(nav).getByRole('link', { name: 'Operate' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).queryByRole('link', { name: 'Emergency stop' })).toBeNull();
    expect(within(nav).queryByRole('link', { name: 'Evaluations' })).toBeNull();
    // the header band: the trail, then the section's pages with their sub-pages (Operate points at its first page)
    const trail = screen.getByRole('navigation', { name: 'Location' });
    expect(within(trail).getByText('Run')).toBeInTheDocument();
    expect(within(trail).getByText('Emergency stop')).toHaveAttribute('aria-current', 'page');
    const tabs = screen.getByRole('navigation', { name: 'Run pages' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Emergency stop', 'Health', 'Agents', 'Evaluations']);
    expect(within(tabs).getByRole('link', { name: 'Emergency stop' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(tabs).getByRole('link', { name: 'Health' })).not.toHaveAttribute('aria-current');
  });

  it('starts as a rail of group icons; the toggle at the top of the nav expands it', async () => {
    const user = userEvent.setup();
    window.localStorage.removeItem('aisdlc.nav.collapsed');
    renderShell();
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const toggle = within(nav).getByRole('button', { name: 'Sidebar' });
    // the first thing in the navigation, before the group icons
    expect(nav.firstElementChild).toBe(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('link', { name: 'Home' })).toBeNull();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Home' })).toBeInTheDocument();
  });

  it('the menu button opens and closes the nav on a phone; Escape closes it; main is the landmark', async () => {
    const user = userEvent.setup();
    renderShell();
    const menu = screen.getByRole('button', { name: 'Menu' });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(menu).toHaveAttribute('aria-controls', nav.id);
    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(nav.className).toContain('ui-nav-open');
    within(nav).getByRole('link', { name: 'Home' }).focus();
    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main');
    expect(screen.getByRole('link', { name: 'Skip to content' })).toHaveAttribute('href', '#main');
  });

  it('a navigation closes the menu and moves focus to the content', async () => {
    const user = userEvent.setup();
    const { rerender } = renderShell('a');
    await user.click(screen.getByRole('button', { name: 'Menu' }));
    rerender(
      <AppShell
        brand={<a href="/">AISDLC</a>}
        nav={NAV}
        locationKey="b"
        renderLink={(to, children, props) => (
          <a href={to} {...props}>
            {children}
          </a>
        )}
      >
        <p>Other</p>
      </AppShell>,
    );
    expect(screen.getByRole('button', { name: 'Menu' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('signed out: no nav and no menu button', () => {
    render(
      <AppShell
        brand={<a href="/">AISDLC</a>}
        nav={null}
        locationKey="x"
        renderLink={(to, children) => <a href={to}>{children}</a>}
      >
        <p>Sign in</p>
      </AppShell>,
    );
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Menu' })).toBeNull();
  });

  it('MenuButton: a disclosure; Escape and a click outside close it, focus goes back', async () => {
    const user = userEvent.setup();
    render(
      <>
        <MenuButton label="Account: Ana Ruiz" button={<span>AR</span>}>
          {(close) => (
            <button type="button" onClick={close}>
              My access
            </button>
          )}
        </MenuButton>
        <p>outside</p>
      </>,
    );
    const b = screen.getByRole('button', { name: 'Account: Ana Ruiz' });
    expect(screen.queryByRole('button', { name: 'My access' })).toBeNull();
    await user.click(b);
    await user.click(screen.getByRole('button', { name: 'My access' }));
    expect(b).toHaveAttribute('aria-expanded', 'false');
    expect(b).toHaveFocus();
    await user.click(b);
    await user.click(screen.getByText('outside'));
    expect(b).toHaveAttribute('aria-expanded', 'false');
  });

  it('CommandPalette: filters by every word, arrows move, Enter opens, Escape closes', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(
      <CommandPalette
        items={[
          { id: '1', label: 'Inbox', to: '/inbox' },
          { id: '2', label: 'Decision log', to: '/ledger' },
          { id: '3', label: 'payments-api', hint: 'Project', to: '/projects/payments-api' },
        ]}
        onPick={onPick}
        onClose={onClose}
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Search' });
    expect(box).toHaveFocus();
    await user.type(box, 'pay proj');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.clear(box);
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Decision log' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('/ledger');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('CommandPalette groups', () => {
  it('lists matches under their headings, keeps the groups together, and reads the hint', async () => {
    const user = userEvent.setup();
    render(
      <CommandPalette
        items={[
          { id: '1', label: 'Inbox', group: 'Pages', hint: 'Work', to: '/inbox' },
          { id: '2', label: 'payments-api', group: 'Projects', to: '/projects/payments-api' },
          { id: '3', label: 'Integrations', group: 'Pages', hint: 'Govern', to: '/integrations' },
        ]}
        onPick={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const pages = screen.getByRole('group', { name: 'Pages' });
    expect(
      within(pages)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['InboxWork', 'IntegrationsGovern']);
    expect(
      within(screen.getByRole('group', { name: 'Projects' })).getAllByRole('option'),
    ).toHaveLength(1);
    // the section is searchable too
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'govern');
    expect(screen.getAllByRole('option')).toHaveLength(1);
    await user.clear(screen.getByRole('combobox', { name: 'Search' }));
    await user.type(screen.getByRole('combobox', { name: 'Search' }), 'zzz');
    expect(screen.getByText('Nothing matches. Try another word.')).toBeInTheDocument();
  });

  it('Escape closes it and ArrowUp stops at the first match', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <CommandPalette
        items={[
          { id: '1', label: 'Inbox', to: '/inbox' },
          { id: '2', label: 'Items', to: '/items' },
        ]}
        onPick={vi.fn()}
        onClose={onClose}
      />,
    );
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('option', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('option', { name: 'Items' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});

describe('PageHeader', () => {
  it('a breadcrumb navigation, one h1, the facts line and the status', () => {
    render(
      <PageHeader
        title="Add farewell() greeting"
        crumbs={[{ label: 'payments-api', to: '/p' }, { label: 'PAY-42' }]}
        meta="Small change · Daniel Novak"
        status={<span>In code review</span>}
        actions={<button type="button">Open PR</button>}
      />,
    );
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'payments-api' })).toHaveAttribute(
      'href',
      '/p',
    );
    expect(within(crumbs).getByText('PAY-42')).toHaveAttribute('aria-current', 'page');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByText('Small change · Daniel Novak')).toBeInTheDocument();
  });
});

describe('NeedsYouTable', () => {
  const rows: NeedsYouRow[] = [
    {
      id: 'a',
      kind: { kind: 'gate', gate: 'G4' },
      what: 'Add farewell()',
      project: 'payments-api',
      item: 'PAY-42',
      due: { text: 'Due in 2 h', at: '2026-11-13T12:00:00Z' },
      to: '/cards/a',
    },
    {
      id: 'b',
      kind: { kind: 'gate', gate: 'G2' },
      what: 'Export invoices',
      project: 'web',
      due: { text: 'Overdue by 1 working day', overdue: true, at: '2026-11-14T09:00:00Z' },
      to: '/cards/b',
    },
    {
      id: 'c',
      kind: { kind: 'questions' },
      what: 'Rounding',
      project: 'ledger',
      due: { text: 'Pauses Friday', at: '2026-11-13T08:00:00Z' },
      to: '/items/c',
    },
  ];

  it('plain approval names, overdue first then by due time, one verb per row', () => {
    render(<NeedsYouTable rows={rows} renderLink={link} />);
    const body = screen.getAllByRole('row').slice(1);
    expect(body.map((r) => within(r).getByRole('rowheader').textContent)).toEqual([
      'Approve the spec',
      'Questions asked',
      'Code review',
    ]);
    expect(screen.queryByText('G4')).toBeNull();
    expect(screen.getByRole('link', { name: 'Decide: Add farewell()' })).toHaveAttribute(
      'href',
      '/cards/a',
    );
    expect(screen.getByRole('link', { name: 'Answer: Rounding' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Needs you' })).toBeInTheDocument();
  });

  it('auditors get the code chip; nothing to show is said in words', () => {
    const { rerender } = render(<NeedsYouTable rows={rows} renderLink={link} showCodes />);
    expect(screen.getByText('G4')).toHaveClass('ui-code');
    rerender(<NeedsYouTable rows={[]} renderLink={link} empty="Nothing needs you." />);
    expect(screen.getByText('Nothing needs you.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('orderNeedsYou is stable for rows without a time', () => {
    const a = { ...rows[0], id: 'x', due: { text: 'Some time' } } as NeedsYouRow;
    expect(orderNeedsYou([a, rows[0] as NeedsYouRow]).map((r) => r.id)).toEqual(['a', 'x']);
  });
});

describe('StageStrip', () => {
  it('names every stage of the track; the current one is the current step', () => {
    render(<StageStrip current="S6" waitingOn="Waiting for a coding slot" />);
    const list = screen.getByRole('list', { name: /Stage 6 of 9: Build/ });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(9);
    expect(items[0]).toHaveTextContent(`${label('stage', 'S1')}, done`);
    expect(items[5]).toHaveAttribute('aria-current', 'step');
    expect(items[5]).toHaveTextContent('Build, now');
    expect(items[8]).toHaveTextContent('Close, not started');
    expect(list.textContent).not.toMatch(/S\d/);
  });

  it('a stage not on the track says so', () => {
    render(<StageStrip current="S3" marks={{ S2: 'skipped' }} />);
    expect(screen.getByText(/Research/).closest('li')).toHaveTextContent('not on this track');
  });
});

describe('EvidenceGrid and DecisionRail', () => {
  it('unknown reads "Unknown (not passed)", never a pass; a tile opens its detail', async () => {
    const user = userEvent.setup();
    function Host() {
      const [sel, setSel] = useState<string | null>(null);
      return (
        <EvidenceGrid
          selected={sel}
          onOpen={setSel}
          tiles={[
            { id: 'a', title: 'Build and tests', verdict: 'passed' },
            { id: 'b', title: 'Matches the spec', verdict: 'unknown' },
            { id: 'c', title: 'Evidence pack', detail: 'Signed for commit 3f2a91c' },
          ]}
        />
      );
    }
    render(<Host />);
    const grid = screen.getByRole('list', { name: 'Evidence' });
    expect(within(grid).getByRole('button', { name: /Matches the spec/ })).toHaveTextContent(
      'Unknown (not passed)',
    );
    const pack = within(grid).getByRole('button', { name: /Evidence pack/ });
    await user.click(pack);
    expect(pack).toHaveAttribute('aria-pressed', 'true');
  });

  it('the three verbs in order; a send-back needs a reason; approve decides', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(
      <DecisionRail
        who="Alex Rivera decides."
        access={{ state: 'allow' }}
        twoPerson={{ have: 1, need: 2, by: ['Ana Ruiz'] }}
        sendBack="1 of 2 tries left"
        onDecide={onDecide}
      />,
    );
    const rail = screen.getByRole('complementary', { name: 'Your decision' });
    const verbs = within(rail)
      .getAllByRole('button')
      .filter((b) => b.className.includes('ui-btn-block'))
      .map((b) => b.textContent);
    expect(verbs).toEqual(['Approve', 'Request changes: 1 of 2 tries left', 'Reject']);
    expect(rail).toHaveTextContent('Needs two people: 1 of 2 (approved by Ana Ruiz)');
    await user.click(within(rail).getByRole('button', { name: /Request changes/ }));
    expect(onDecide).not.toHaveBeenCalled();
    expect(within(rail).getByRole('textbox', { name: 'Reason' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    await user.type(within(rail).getByRole('textbox', { name: 'Reason' }), 'Name the test');
    await user.click(within(rail).getByRole('button', { name: /Request changes/ }));
    expect(onDecide).toHaveBeenLastCalledWith('request_changes', 'Name the test');
    await user.click(within(rail).getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenLastCalledWith('approve', 'Name the test');
  });

  it('a person who may not decide sees why and how to ask, and no verb', () => {
    render(
      <DecisionRail
        who="Rana Begum decides."
        access={{
          state: 'deny',
          reason: 'Only the design and plan approver can approve this. Ask Rana Begum.',
          request: <a href="/me/access">Request access</a>,
        }}
        onDecide={() => undefined}
      />,
    );
    expect(screen.getByRole('note')).toHaveTextContent('Ask Rana Begum');
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Request access' })).toBeInTheDocument();
  });

  it('pending access: the verbs are there but disabled until the answer comes', () => {
    render(<DecisionRail who="x" access={{ state: 'pending' }} onDecide={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Checking whether you may decide');
  });

  it('a factory admin deciding outside the rules is told so and must give a reason to approve', async () => {
    const user = userEvent.setup();
    const onDecide = vi.fn();
    render(<DecisionRail who="x" access={{ state: 'allow' }} adminOverride onDecide={onDecide} />);
    expect(screen.getByText('Decide as factory admin')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).not.toHaveBeenCalled();
  });
});

describe('PropertiesPanel, Scorecard, Stepper', () => {
  it('PropertiesPanel is a labelled aside with a definition list and the actions', () => {
    render(
      <PropertiesPanel
        rows={[{ label: 'Track', value: 'Small change' }]}
        actions={<button type="button">Hand back</button>}
      />,
    );
    const aside = screen.getByRole('complementary', { name: 'Properties' });
    expect(within(aside).getByText('Track').tagName).toBe('DT');
    expect(within(aside).getByRole('heading', { name: 'What you can do' })).toBeInTheDocument();
  });

  it('Scorecard counts what is met; unknown is said, never a tick', () => {
    render(
      <Scorecard
        title="Readiness scorecard"
        items={[
          { id: '1', label: 'Tests run and pass', state: 'met' },
          { id: '2', label: 'Agent tooling checked', state: 'unknown' },
          { id: '3', label: 'Repo facts confirmed', state: 'not_met', detail: '84%' },
          { id: '4', label: 'Network needs declared', state: 'na' },
        ]}
      />,
    );
    const card = screen.getByRole('region', { name: 'Readiness scorecard' });
    expect(card).toHaveTextContent('1 of 3 met');
    const unknown = within(card).getByText('Agent tooling checked').closest('li') as HTMLElement;
    expect(unknown).toHaveTextContent('Unknown');
    expect(unknown.className).toContain('ui-score-unknown');
  });

  it('Stepper marks the current step and says each state', () => {
    render(
      <Stepper
        label="Settings change steps"
        steps={[
          { id: 'a', label: 'Change', state: 'done' },
          { id: 'b', label: 'Preview', state: 'current' },
          { id: 'c', label: 'Approve a settings change', state: 'todo' },
        ]}
      />,
    );
    const steps = within(screen.getByRole('list', { name: 'Settings change steps' })).getAllByRole(
      'listitem',
    );
    expect(steps[1]).toHaveAttribute('aria-current', 'step');
    expect(steps[0]).toHaveTextContent('Change, done');
  });
});

describe('SecretField', () => {
  it('a stored secret reads "Set · last changed", never its value; replacing it clears what was typed', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const { container } = render(
      <SecretField label="GitHub App private key" isSet lastChanged="2 h ago" onSave={onSave} />,
    );
    expect(screen.getByText('Set · last changed 2 h ago')).toBeInTheDocument();
    expect(container.querySelector('input')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Replace secret' }));
    const input = screen.getByLabelText(/Paste secret/);
    expect(input).toHaveAttribute('type', 'password');
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    await user.type(input, 's3cr3t-value');
    await user.click(screen.getByRole('button', { name: 'Save secret' }));
    expect(onSave).toHaveBeenCalledWith('s3cr3t-value');
    // the value is gone from the page as soon as it is handed over
    expect(container.innerHTML).not.toContain('s3cr3t-value');
    expect(container.querySelector('input')).toBeNull();
  });

  it('not set: the field is open; Save waits for text', () => {
    render(<SecretField label="Slack webhook" isSet={false} onSave={() => undefined} />);
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save secret' })).toBeDisabled();
  });
});

describe('ConfirmDelete', () => {
  it('names what it destroys; the red button waits for the exact name', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <ConfirmDelete
        open
        kind="project"
        name="payments-api"
        consequences="Its items, documents and history."
        onConfirm={onConfirm}
        onClose={() => undefined}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Delete project payments-api?' });
    const go = within(dialog).getByRole('button', { name: 'Delete project payments-api' });
    expect(go).toBeDisabled();
    const box = within(dialog).getByRole('textbox', { name: /to confirm/ });
    await user.type(box, 'payments-ap');
    expect(go).toBeDisabled();
    await user.type(box, 'i');
    expect(go).toBeEnabled();
    await user.click(go);
    expect(onConfirm).toHaveBeenCalledOnce();
  });
});

describe('EmptyState and ErrorState', () => {
  it('say what will appear and how; 403 says why and who to ask; 404 is "Not found"', () => {
    render(
      <>
        <EmptyState title="No work yet." action={<button type="button">Ask for work</button>} />
        <ErrorState status={403} reason="Only a project admin can." ask="Ask Rana Begum." />
      </>,
    );
    expect(screen.getByRole('heading', { name: 'No work yet.' })).toBeInTheDocument();
    const a = screen.getByRole('alert');
    expect(a).toHaveTextContent("You can't open this");
    expect(a).toHaveTextContent('Ask Rana Begum.');
  });

  it('404 is "Not found", the same for missing and invisible', () => {
    render(<ErrorState status={404} reason="secret" />);
    expect(screen.getByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret');
  });
});
