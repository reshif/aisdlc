import { GATES, GateIdValues, STEPS } from '@aisdlc/contracts';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import {
  ActorGlyph,
  Card,
  Chip,
  Drawer,
  EmptyState,
  ErrorState,
  GateTag,
  LockedButton,
  Modal,
  PageHead,
  Pill,
  Stat,
  Stats,
  Steps,
  Table,
  Tabs,
  Timeline,
  ToastProvider,
  useToast,
} from '../src/ui';

// The component library: roles, names and keyboard behaviour, and vocabulary from the contracts.

describe('surfaces', () => {
  it('PageHead has one h1, breadcrumbs as a navigation and the actions', () => {
    render(
      <PageHead
        eyebrow="Projects"
        title="Payments"
        sub="One project."
        crumbs={[{ label: 'Projects', to: '/' }, { label: 'Payments' }]}
        actions={<button type="button">Do</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Payments' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Projects' })).toHaveAttribute('href', '/');
    expect(within(crumbs).getByText('Payments')).toHaveAttribute('aria-current', 'page');
  });

  it('Card is a region named by its title; Stats is a labelled list of stats', () => {
    render(
      <>
        <Card title="Health">body</Card>
        <Stats label="Today">
          <Stat label="Projects" value={3} detail="one onboarding" tone="warn" />
        </Stats>
      </>,
    );
    expect(screen.getByRole('region', { name: 'Health' })).toHaveTextContent('body');
    const stats = screen.getByRole('list', { name: 'Today' });
    expect(within(stats).getByRole('listitem')).toHaveTextContent('Projects3one onboarding');
  });

  it('Table has a caption as its name, row headers, and the empty state instead of no rows', () => {
    const cols = [
      { key: 'n', header: 'Name', rowHeader: true, render: (r: { n: string }) => r.n },
      {
        key: 'l',
        header: 'Len',
        align: 'right' as const,
        render: (r: { n: string }) => r.n.length,
      },
    ];
    const { rerender } = render(
      <Table caption="Things" columns={cols} rows={[{ n: 'ab' }]} rowKey={(r) => r.n} />,
    );
    const t = screen.getByRole('table', { name: 'Things' });
    expect(within(t).getByRole('rowheader', { name: 'ab' })).toBeInTheDocument();
    rerender(
      <Table
        caption="Things"
        columns={cols}
        rows={[]}
        rowKey={(r) => r.n}
        empty={<EmptyState title="Nothing yet" />}
      />,
    );
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Nothing yet' })).toBeInTheDocument();
  });
});

describe('vocabulary from the contracts', () => {
  it('a GateTag exists for every gate the contracts define, named with the flow title', () => {
    render(
      <>
        {GateIdValues.map((g) => (
          <GateTag key={g} gate={g} />
        ))}
      </>,
    );
    for (const g of GateIdValues) {
      const tag = screen.getByRole('img', { name: new RegExp(`^${g},`) });
      expect(tag.className).toContain(`ui-gtag-${GATES[g].family}`);
    }
  });

  it('a Chip names its lane in words; a Pill is words, colour only repeats them', () => {
    render(
      <>
        <Chip itemKey="W-12" lane="L0" />
        <Pill tone="bad">blocked</Pill>
      </>,
    );
    expect(screen.getByText('lane L0 hotfix')).toBeInTheDocument();
    expect(screen.getByText('blocked')).toHaveClass('ui-pill-bad');
  });

  it('ActorGlyph and Steps read the actor and title of a step from STEPS', () => {
    render(
      <>
        <ActorGlyph actor="D+A" />
        <Steps
          label="S0"
          steps={[
            { id: '0.1', mark: 'done' },
            { id: '0.2', mark: 'now' },
            { id: '0.3', mark: 'todo' },
          ]}
        />
      </>,
    );
    expect(screen.getAllByRole('img', { name: 'acted by: deterministic and agent' })).toHaveLength(
      2,
    ); // the glyph above, and 0.1's (D+A)
    const steps = screen.getByRole('list', { name: 'S0' });
    const now = within(steps).getAllByRole('listitem')[1] as HTMLElement;
    expect(now).toHaveAttribute('aria-current', 'step');
    expect(now).toHaveTextContent(STEPS['0.2'].title);
  });

  it('Timeline says who acted in words', () => {
    render(
      <Timeline
        label="History"
        events={[{ id: '1', when: '09:12', kind: 'gate', title: 'G2 approved' }]}
      />,
    );
    expect(screen.getByRole('list', { name: 'History' })).toHaveTextContent('gate: G2 approved');
  });
});

describe('keyboard', () => {
  function TabsHarness() {
    const [sel, setSel] = useState('a');
    return (
      <Tabs
        label="Views"
        selected={sel}
        onSelect={setSel}
        tabs={[
          { id: 'a', label: 'Overview' },
          { id: 'b', label: 'Work', count: 3 },
          { id: 'c', label: 'Audit' },
        ]}
      >
        panel {sel}
      </Tabs>
    );
  }

  it('Tabs: one tab stop, arrows and Home/End move and select, the panel is labelled', async () => {
    const user = userEvent.setup();
    render(<TabsHarness />);
    const list = screen.getByRole('tablist', { name: 'Views' });
    const [a, b, c] = within(list).getAllByRole('tab') as [HTMLElement, HTMLElement, HTMLElement];
    expect(a).toHaveAttribute('tabindex', '0');
    expect(b).toHaveAttribute('tabindex', '-1');
    a.focus();
    await user.keyboard('{ArrowRight}');
    expect(b).toHaveFocus();
    expect(b).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel', { name: /Work/ })).toHaveTextContent('panel b');
    await user.keyboard('{End}');
    expect(c).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(a).toHaveFocus();
  });

  function OverlayHarness({ kind }: { kind: 'modal' | 'drawer' }) {
    const [open, setOpen] = useState(false);
    const Box = kind === 'modal' ? Modal : Drawer;
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
        <Box open={open} title="Details" onClose={() => setOpen(false)}>
          <input aria-label="Note" />
        </Box>
      </>
    );
  }

  for (const kind of ['modal', 'drawer'] as const) {
    it(`${kind}: a modal dialog, focus inside, Tab stays inside, Escape closes and focus returns`, async () => {
      const user = userEvent.setup();
      render(<OverlayHarness kind={kind} />);
      const opener = screen.getByRole('button', { name: 'Open' });
      await user.click(opener);
      const dialog = screen.getByRole('dialog', { name: 'Details' });
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
      await user.tab();
      expect(within(dialog).getByRole('textbox', { name: 'Note' })).toHaveFocus();
      await user.tab();
      expect(within(dialog).getByRole('button', { name: 'Close' })).toHaveFocus();
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(opener).toHaveFocus();
    });
  }

  it('LockedButton is reachable, says it is unavailable, and on press shows why and how to ask', async () => {
    const user = userEvent.setup();
    render(
      <LockedButton
        label="Decide G2"
        reason="None of your roles allows this here."
        request={<a href="/me/access">Request access</a>}
      />,
    );
    const b = screen.getByRole('button', { name: /Decide G2/ });
    expect(b).toHaveAttribute('aria-disabled', 'true');
    expect(b).toHaveAccessibleDescription('None of your roles allows this here.');
    expect(screen.queryByRole('link', { name: 'Request access' })).toBeNull();
    await user.tab();
    expect(b).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('note')).toHaveTextContent('None of your roles allows this here.');
    expect(screen.getByRole('link', { name: 'Request access' })).toHaveAttribute(
      'href',
      '/me/access',
    );
  });

  it('Toast: a polite live region, dismissable', async () => {
    const user = userEvent.setup();
    function Say() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => toast('Saved')}>
          Save
        </button>
      );
    }
    render(
      <ToastProvider ms={0}>
        <Say />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const region = screen.getByRole('status', { name: 'Notifications' });
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Saved');
    await act(() => user.click(screen.getByRole('button', { name: 'Dismiss: Saved' })));
    expect(region).not.toHaveTextContent('Saved');
  });
});

describe('ErrorState', () => {
  it('403 says why; 404 is one text whatever the cause and ignores any reason', () => {
    const { rerender, container } = render(<ErrorState status={403} reason="audit.read denied" />);
    expect(screen.getByRole('alert')).toHaveTextContent('audit.read denied');
    rerender(<ErrorState status={404} reason="project secret is confidential" />);
    const invisible = container.innerHTML;
    expect(screen.getByRole('alert')).not.toHaveTextContent('confidential');
    rerender(<ErrorState status={404} />);
    expect(container.innerHTML).toBe(invisible);
  });
});
