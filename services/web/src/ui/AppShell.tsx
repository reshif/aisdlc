import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

// The portal's shell (the skeleton's screen 1): a top bar (logo, project switcher, search, emergency-stop state,
// notifications, the person), the grouped left navigation and the content. Under 860px the navigation collapses
// into a menu (a drawer over the page). The shell knows nothing of access: the caller passes only the entries the
// person may open, so "an entry the person cannot open is not listed; an empty group is not shown".

export interface ShellNavEntry {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly current: boolean;
  /** A count after the label (the inbox): its meaning is in `countLabel`. */
  readonly count?: number;
  readonly countLabel?: string;
  /** Sub-entries, listed under the entry while it (or one of them) is current. */
  readonly children?: readonly ShellNavEntry[];
}

export interface ShellNavGroup {
  readonly id: string;
  /** `null`: the first, unlabelled group (Home, Inbox). */
  readonly label: string | null;
  readonly entries: readonly ShellNavEntry[];
}

export type RenderLink = (
  to: string,
  children: ReactNode,
  props: { className?: string; 'aria-current'?: 'page'; onClick?: () => void },
) => ReactNode;

export function AppShell({
  brand,
  switcher,
  search,
  status,
  actions,
  account,
  nav,
  navFoot,
  banners,
  locationKey,
  renderLink,
  children,
}: {
  /** The logo, as a link home. */
  brand: ReactNode;
  switcher?: ReactNode;
  search?: ReactNode;
  /** The emergency-stop state pill. */
  status?: ReactNode;
  /** Bell, Ask for work, Stop agents. */
  actions?: ReactNode;
  /** The avatar menu. */
  account?: ReactNode;
  /** `null` while signed out: no navigation at all. */
  nav: readonly ShellNavGroup[] | null;
  navFoot?: ReactNode;
  banners?: ReactNode;
  /** Changes on every navigation: the menu closes and focus goes to the content. */
  locationKey: string;
  renderLink: RenderLink;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const navId = useId();
  const mainRef = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    setOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [locationKey]);

  const onNavKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div className="ui-app">
      <a className="ui-skip" href="#main">
        Skip to content
      </a>
      <header className="ui-top">
        {nav ? (
          <button
            type="button"
            className="ui-iconbtn ui-top-menu"
            aria-expanded={open}
            aria-controls={navId}
            onClick={() => setOpen((v) => !v)}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
            <span className="ui-sr">Menu</span>
          </button>
        ) : null}
        <div className="ui-top-brand">{brand}</div>
        {switcher ? <div className="ui-top-switch">{switcher}</div> : null}
        {search ? <div className="ui-top-search">{search}</div> : <div className="ui-top-fill" />}
        <div className="ui-top-right">
          {status}
          {actions}
          {account}
        </div>
      </header>
      <div className={nav ? 'ui-body' : 'ui-body ui-body-bare'}>
        {nav ? (
          <>
            {open ? (
              <div className="ui-nav-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
            ) : null}
            <nav
              id={navId}
              className={open ? 'ui-nav ui-nav-open' : 'ui-nav'}
              aria-label="Main"
              onKeyDown={onNavKey}
            >
              <NavTree groups={nav} renderLink={renderLink} />
              {navFoot ? <div className="ui-nav-foot">{navFoot}</div> : null}
            </nav>
          </>
        ) : null}
        <main id="main" tabIndex={-1} ref={mainRef} className="ui-main">
          {banners ? <div className="ui-banners">{banners}</div> : null}
          {children}
        </main>
      </div>
    </div>
  );
}

function NavTree({
  groups,
  renderLink,
}: {
  groups: readonly ShellNavGroup[];
  renderLink: RenderLink;
}) {
  return (
    <>
      {groups.map((g) => (
        <NavSection key={g.id} group={g} renderLink={renderLink} />
      ))}
    </>
  );
}

function NavSection({ group, renderLink }: { group: ShellNavGroup; renderLink: RenderLink }) {
  const hid = useId();
  return (
    <section {...(group.label ? { 'aria-labelledby': hid } : { 'aria-label': 'Start' })}>
      {group.label ? (
        <h2 id={hid} className="ui-nav-h">
          {group.label}
        </h2>
      ) : null}
      <ul className="ui-nav-list">
        {group.entries.map((e) => (
          <NavItem key={e.id} entry={e} renderLink={renderLink} depth={0} />
        ))}
      </ul>
    </section>
  );
}

const anyCurrent = (e: ShellNavEntry): boolean => e.current || (e.children ?? []).some(anyCurrent);

function NavItem({
  entry,
  renderLink,
  depth,
}: {
  entry: ShellNavEntry;
  renderLink: RenderLink;
  depth: number;
}) {
  const kids = entry.children ?? [];
  const expanded = kids.length > 0 && anyCurrent(entry);
  // the parent of a current child is "in" the section, not the page itself
  const here = entry.current && !kids.some(anyCurrent);
  return (
    <li>
      {renderLink(
        entry.to,
        <>
          <span className="ui-nav-label">{entry.label}</span>
          {entry.count !== undefined && entry.count > 0 ? ' ' : null}
          {entry.count !== undefined && entry.count > 0 ? (
            <span className="ui-nav-count">
              {entry.count}
              {entry.countLabel ? (
                <>
                  {' '}
                  <span className="ui-sr">{entry.countLabel}</span>
                </>
              ) : null}
            </span>
          ) : null}
        </>,
        {
          className: `ui-nav-link${depth > 0 ? ' ui-nav-sub' : ''}${expanded && !here ? ' ui-nav-in' : ''}`,
          ...(here ? { 'aria-current': 'page' as const } : {}),
        },
      )}
      {expanded ? (
        <ul className="ui-nav-list">
          {kids.map((k) => (
            <NavItem key={k.id} entry={k} renderLink={renderLink} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------- menus and the command palette

/**
 * A button that opens a small panel (the avatar menu, the project switcher): a disclosure, not an ARIA menu, so
 * its links and buttons are ordinary tab stops. Escape and a click outside close it and focus goes back.
 */
export function MenuButton({
  label,
  button,
  children,
  align = 'end',
  className,
}: {
  /** The accessible name of the button. */
  label: string;
  /** What the button shows (initials, a project name). Defaults to the label. */
  button?: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'start' | 'end';
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const close = () => {
    setOpen(false);
    btn.current?.focus();
  };
  return (
    <div
      ref={root}
      className={`ui-menu${className ? ` ${className}` : ''}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close();
        }
      }}
    >
      <button
        ref={btn}
        type="button"
        className="ui-menu-btn"
        aria-expanded={open}
        aria-controls={id}
        {...(button ? { 'aria-label': label } : {})}
        onClick={() => setOpen((v) => !v)}
      >
        {button ?? label}
      </button>
      <div id={id} className={`ui-menu-pop ui-menu-${align}`} hidden={!open}>
        {open ? children(close) : null}
      </div>
    </div>
  );
}

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  /** A second line: the group, the project. */
  readonly hint?: string;
  readonly to: string;
}

/**
 * ⌘K search: a dialog with one field and the matching places, arrow keys to move, Enter to open. It searches what
 * the caller gives it (the screens and projects the person may open); it never shows something the nav would hide.
 */
export function CommandPalette({
  items,
  onPick,
  onClose,
  placeholder = 'Search screens and projects',
}: {
  items: readonly PaletteItem[];
  onPick: (to: string) => void;
  onClose: () => void;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const back = useRef<HTMLElement | null>(null);
  useEffect(() => {
    back.current = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => back.current?.focus?.();
  }, []);
  const hits = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return items
      .filter((i) => {
        const hay = `${i.label} ${i.hint ?? ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 12);
  }, [items, q]);
  const pick = (i: PaletteItem | undefined) => {
    if (!i) return;
    onPick(i.to);
    onClose();
  };
  const active = hits[Math.min(at, hits.length - 1)];
  return (
    <div
      className="ui-scrim ui-scrim-center ui-scrim-top"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ui-palette" role="dialog" aria-modal="true" aria-label="Search">
        <input
          ref={input}
          className="ui-input ui-palette-input"
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          {...(active ? { 'aria-activedescendant': `${listId}-${active.id}` } : {})}
          aria-label="Search"
          placeholder={placeholder}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setAt(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              onClose();
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setAt((v) => Math.min(v + 1, Math.max(hits.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setAt((v) => Math.max(v - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(active);
            } else if (e.key === 'Tab') {
              e.preventDefault();
            }
          }}
        />
        <ul id={listId} role="listbox" aria-label="Results" className="ui-palette-list">
          {hits.map((i) => (
            <li
              key={i.id}
              id={`${listId}-${i.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'ui-palette-on' : undefined}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(i);
              }}
            >
              <span>{i.label}</span>
              {i.hint ? <span className="ui-palette-hint">{i.hint}</span> : null}
            </li>
          ))}
        </ul>
        {hits.length === 0 ? (
          <p className="ui-palette-none">Nothing matches. Try another word.</p>
        ) : null}
      </div>
    </div>
  );
}
