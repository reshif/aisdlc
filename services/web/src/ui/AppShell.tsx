import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { NavIcon } from './icons';
import { Breadcrumb, TrailContext } from './page';

// The portal's shell: a compact top bar (wordmark, project switcher, search, the person's controls), a slim rail of
// group icons on the left (collapsed by default; expanded it is a two-level list), and in the page a header band
// with the breadcrumb and the pages of the current section as tabs. Under 860px the navigation is a drawer. The
// shell knows nothing of access: the caller passes only the entries the person may open, so an entry the person
// cannot open is not listed anywhere (rail, flyout, tabs, palette) and an empty group is not shown.

export interface ShellNavEntry {
  readonly id: string;
  readonly label: string;
  readonly to: string;
  readonly current: boolean;
  /** A count after the label (the inbox): its meaning is in `countLabel`. */
  readonly count?: number;
  readonly countLabel?: string;
  /** Sub-pages: they are tabs of the section's page header, never a second level in the sidebar. */
  readonly children?: readonly ShellNavEntry[];
}

export interface ShellNavGroup {
  readonly id: string;
  /** `null`: an unlabelled first group. */
  readonly label: string | null;
  readonly entries: readonly ShellNavEntry[];
}

export type RenderLink = (
  to: string,
  children: ReactNode,
  props: { className?: string; 'aria-current'?: 'page'; onClick?: () => void },
) => ReactNode;

const STORE_KEY = 'aisdlc.nav.collapsed';
const PHONE = '(max-width: 859px)';

const media = (q: string): boolean =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(q).matches
    : false;

/** Follows a media query (false where there is none, as in a test DOM). */
function useMedia(q: string): boolean {
  const [on, setOn] = useState(() => media(q));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const m = window.matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, [q]);
  return on;
}

/** The viewer's choice (per browser): `null` when none or when storage is unavailable. */
function readCollapsed(): boolean | null {
  try {
    const v = window.localStorage.getItem(STORE_KEY);
    return v === '1' ? true : v === '0' ? false : null;
  } catch {
    return null;
  }
}
const writeCollapsed = (v: boolean) => {
  try {
    window.localStorage.setItem(STORE_KEY, v ? '1' : '0');
  } catch {
    /* the choice lasts until the page closes */
  }
};

const anyCurrent = (e: ShellNavEntry): boolean => e.current || (e.children ?? []).some(anyCurrent);

/** A group's pages as tabs: each entry, then its sub-pages; a section that only points at its first page is skipped. */
function tabsOf(group: ShellNavGroup): ShellNavEntry[] {
  const out: ShellNavEntry[] = [];
  for (const e of group.entries) {
    const first = e.children?.[0];
    if (!(first && first.to === e.to)) out.push(e);
    for (const c of e.children ?? []) out.push(c);
  }
  return out;
}

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
  here,
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
  /** Ask for work, Stop agents, the inbox bell, the theme. */
  actions?: ReactNode;
  /** The avatar menu. */
  account?: ReactNode;
  /** `null` while signed out: no navigation at all. */
  nav: readonly ShellNavGroup[] | null;
  navFoot?: ReactNode;
  banners?: ReactNode;
  /** The page's name when it is in no group (the person's own pages): shown as the one breadcrumb. */
  here?: string;
  /** Changes on every navigation: the menu closes and focus goes to the content. */
  locationKey: string;
  renderLink: RenderLink;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => readCollapsed() ?? true);
  const phone = useMedia(PHONE);
  const toggle = () => {
    setCollapsed(!collapsed);
    writeCollapsed(!collapsed);
  };
  // the phone's menu is the drawer: always the full list
  const rail = collapsed && !phone;
  const navId = useId();
  const group = nav?.find((g) => g.entries.some(anyCurrent));
  const trail = useMemo(() => {
    const t = group ? tabsOf(group) : [];
    const inside = group ? (t.find((x) => x.current) ?? group.entries.find(anyCurrent)) : undefined;
    return [
      ...(group?.label ? [group.label] : []),
      ...(inside ? [inside.label] : []),
      ...(here ? [here] : []),
    ];
  }, [group, here]);
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
            <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M4 7h16M4 12h16M4 17h16"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
              />
            </svg>
            <span className="ui-sr">Menu</span>
          </button>
        ) : null}
        <div className="ui-top-brand">{brand}</div>
        {switcher ? <div className="ui-top-switch">{switcher}</div> : null}
        <div className="ui-top-search">{search}</div>
        <div className="ui-top-right">
          {status}
          {actions}
          {account}
        </div>
      </header>
      <div className={nav ? (rail ? 'ui-body ui-body-rail' : 'ui-body') : 'ui-body ui-body-bare'}>
        {nav ? (
          <>
            {open ? (
              <div className="ui-nav-scrim" aria-hidden="true" onClick={() => setOpen(false)} />
            ) : null}
            <nav
              id={navId}
              className={`ui-nav${open ? ' ui-nav-open' : ''}${rail ? ' ui-nav-rail' : ''}`}
              aria-label="Main"
              onKeyDown={onNavKey}
            >
              <button
                type="button"
                className="ui-nav-toggle"
                aria-expanded={!collapsed}
                aria-controls={navId}
                aria-label="Sidebar"
                title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
                onClick={toggle}
              >
                <NavIcon id={collapsed ? 'expand' : 'collapse'} />
                <span className="ui-nav-label">Collapse</span>
              </button>
              {rail ? (
                <Rail groups={nav} renderLink={renderLink} />
              ) : (
                <NavTree groups={nav} renderLink={renderLink} />
              )}
              {navFoot && !rail ? <div className="ui-nav-foot">{navFoot}</div> : null}
            </nav>
          </>
        ) : null}
        <main id="main" tabIndex={-1} ref={mainRef} className="ui-main">
          {nav ? <PageBand group={group} here={here} renderLink={renderLink} /> : null}
          {banners ? <div className="ui-banners">{banners}</div> : null}
          <TrailContext.Provider value={trail}>
            <div className="ui-content">{children}</div>
          </TrailContext.Provider>
        </main>
      </div>
    </div>
  );
}

/** The page header band: where you are (section, page) and the section's pages as tabs. */
function PageBand({
  group,
  here,
  renderLink,
}: {
  group: ShellNavGroup | undefined;
  here: string | undefined;
  renderLink: RenderLink;
}) {
  const tabs = group ? tabsOf(group) : [];
  const exact = tabs.find((t) => t.current);
  const inside = group ? (exact ?? group.entries.find(anyCurrent)) : undefined;
  const crumbs = group
    ? [
        ...(group.label ? [{ label: group.label }] : []),
        ...(inside
          ? [inside === exact ? { label: inside.label } : { label: inside.label, to: inside.to }]
          : []),
      ]
    : here
      ? [{ label: here }]
      : [];
  if (crumbs.length === 0 && tabs.length < 2) return null;
  return (
    <div className="ui-band">
      {crumbs.length > 0 ? (
        <div className="ui-band-crumbs">
          <Breadcrumb
            crumbs={crumbs}
            label="Location"
            renderLink={(to, text) => renderLink(to, text, {})}
          />
        </div>
      ) : null}
      {tabs.length > 1 ? (
        <nav className="ui-sectabs" aria-label={`${group?.label ?? 'Section'} pages`}>
          <ul>
            {tabs.map((e) => (
              <li key={e.id}>
                {renderLink(e.to, e.label, {
                  className: `ui-sectab${e.current ? ' ui-sectab-on' : ''}`,
                  ...(e.current ? { 'aria-current': 'page' as const } : {}),
                })}
              </li>
            ))}
          </ul>
        </nav>
      ) : null}
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
    <section
      className="ui-nav-sec"
      {...(group.label ? { 'aria-labelledby': hid } : { 'aria-label': 'Start' })}
    >
      {group.label ? (
        <h2 id={hid} className="ui-nav-h">
          {group.label}
        </h2>
      ) : null}
      <ul className="ui-nav-list">
        {group.entries.map((e) => (
          <li key={e.id}>{navLink(e, renderLink)}</li>
        ))}
      </ul>
    </section>
  );
}

/** One page of the sidebar or a flyout: icon, name, count. A page whose sub-page is open is still "here". */
function navLink(e: ShellNavEntry, renderLink: RenderLink, onClick?: () => void): ReactNode {
  const here = anyCurrent(e);
  return renderLink(
    e.to,
    <>
      <NavIcon id={e.id} />
      <span className="ui-nav-label">{e.label}</span>
      {e.count !== undefined && e.count > 0 ? ' ' : null}
      {e.count !== undefined && e.count > 0 ? (
        <span className="ui-nav-count">
          {e.count}
          {e.countLabel ? (
            <>
              {' '}
              <span className="ui-sr">{e.countLabel}</span>
            </>
          ) : null}
        </span>
      ) : null}
    </>,
    {
      className: 'ui-nav-link',
      ...(onClick ? { onClick } : {}),
      ...(here ? { 'aria-current': 'page' as const } : {}),
    },
  );
}

/** The collapsed navigation: one icon per group; it opens a flyout with the group's pages. */
function Rail({
  groups,
  renderLink,
}: {
  groups: readonly ShellNavGroup[];
  renderLink: RenderLink;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  return (
    <ul className="ui-rail-groups">
      {groups.map((g) => (
        <RailGroup
          key={g.id}
          group={g}
          open={openId === g.id}
          setOpen={(v) => setOpenId((cur) => (v ? g.id : cur === g.id ? null : cur))}
          renderLink={renderLink}
        />
      ))}
    </ul>
  );
}

function RailGroup({
  group,
  open,
  setOpen,
  renderLink,
}: {
  group: ShellNavGroup;
  open: boolean;
  setOpen: (v: boolean) => void;
  renderLink: RenderLink;
}) {
  const id = useId();
  const root = useRef<HTMLLIElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const focusFirst = useRef(false);
  // a flyout opened by a click stays until the next click or Escape; a hover one goes with the pointer
  const pinned = useRef(false);
  const name = group.label ?? 'Start';
  const here = group.entries.some(anyCurrent);
  const waiting = group.entries.reduce((n, e) => n + (e.count ?? 0), 0);
  const waitingLabel = group.entries.find((e) => e.count && e.countLabel)?.countLabel;
  useEffect(() => {
    if (open && focusFirst.current) {
      focusFirst.current = false;
      list.current?.querySelector('a')?.focus();
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) {
        pinned.current = false;
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open, setOpen]);
  const move = (by: number) => {
    const links = Array.from(list.current?.querySelectorAll('a') ?? []);
    const at = links.indexOf(document.activeElement as HTMLAnchorElement);
    links[(at + by + links.length) % links.length]?.focus();
  };
  return (
    <li
      ref={root}
      className="ui-rail-group"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => {
        if (!pinned.current) setOpen(false);
      }}
      onBlur={(e) => {
        if (open && !root.current?.contains(e.relatedTarget as Node | null)) {
          pinned.current = false;
          setOpen(false);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          pinned.current = false;
          setOpen(false);
          btn.current?.focus();
        } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          if (!open) {
            focusFirst.current = true;
            setOpen(true);
          } else move(e.key === 'ArrowDown' ? 1 : -1);
        } else if (e.key === 'Home' && open) {
          e.preventDefault();
          list.current?.querySelector('a')?.focus();
        }
      }}
    >
      <button
        ref={btn}
        type="button"
        className={`ui-rail-btn${here ? ' ui-rail-on' : ''}`}
        aria-label={waiting > 0 ? `${name}, ${waiting} ${waitingLabel ?? 'waiting'}` : name}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => {
          pinned.current = !(open && pinned.current);
          setOpen(pinned.current);
        }}
      >
        <NavIcon id={group.id} size={18} />
        {waiting > 0 ? <span className="ui-rail-dot" aria-hidden="true" /> : null}
      </button>
      <div id={id} className="ui-rail-fly" hidden={!open}>
        {open ? (
          <div className="ui-rail-fly-in">
            <p className="ui-rail-fly-h">{name}</p>
            <ul ref={list} className="ui-nav-list" aria-label={name}>
              {group.entries.map((e) => (
                <li key={e.id}>
                  {navLink(e, renderLink, () => {
                    pinned.current = false;
                    setOpen(false);
                  })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------- menus, the combobox and the command palette

/**
 * A button that opens a small panel (the avatar menu): a disclosure, not an ARIA menu, so its links and buttons
 * are ordinary tab stops. Escape and a click outside close it and focus goes back.
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

export interface ComboOption {
  readonly id: string;
  readonly label: string;
  /** A second, muted word (the kind of thing). */
  readonly hint?: string;
}

/**
 * A select-only combobox with a filter (the project switcher): a button that opens a popover with a search field
 * and a listbox. Arrows move, Home and End jump, Enter picks, Escape closes and focus returns to the button.
 */
export function Combobox({
  label,
  button,
  options,
  selected,
  onPick,
  placeholder = 'Find a project',
  empty = 'Nothing matches.',
  className,
}: {
  /** The accessible name of the button. */
  label: string;
  button: ReactNode;
  options: readonly ComboOption[];
  selected: string | null;
  onPick: (id: string) => void;
  placeholder?: string;
  empty?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const base = useId();
  const root = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const hits = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((o) => {
      const hay = `${o.label} ${o.hint ?? ''}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
  }, [options, q]);
  const active = hits[Math.min(at, hits.length - 1)];
  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const away = (e: MouseEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', away);
    return () => document.removeEventListener('mousedown', away);
  }, [open]);
  const show = () => {
    setQ('');
    setAt(
      Math.max(
        0,
        options.findIndex((o) => o.id === selected),
      ),
    );
    setOpen(true);
  };
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };
  const pick = (o: ComboOption | undefined) => {
    if (!o) return;
    close(false);
    onPick(o.id);
  };
  return (
    <div ref={root} className={`ui-menu ui-combo${className ? ` ${className}` : ''}`}>
      <button
        ref={btn}
        type="button"
        className="ui-menu-btn ui-combo-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${base}-pop`}
        aria-label={label}
        onClick={() => (open ? close(false) : show())}
      >
        {button}
      </button>
      <div id={`${base}-pop`} className="ui-menu-pop ui-menu-start ui-combo-pop" hidden={!open}>
        {open ? (
          <>
            <input
              ref={input}
              className="ui-combo-input"
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${base}-list`}
              aria-autocomplete="list"
              aria-label={placeholder}
              placeholder={placeholder}
              autoComplete="off"
              spellCheck={false}
              {...(active ? { 'aria-activedescendant': `${base}-o-${active.id}` } : {})}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setAt(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  close(true);
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setAt((v) => Math.min(v + 1, Math.max(hits.length - 1, 0)));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setAt((v) => Math.max(v - 1, 0));
                } else if (e.key === 'Home') {
                  e.preventDefault();
                  setAt(0);
                } else if (e.key === 'End') {
                  e.preventDefault();
                  setAt(Math.max(hits.length - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  pick(active);
                } else if (e.key === 'Tab') {
                  close(false);
                }
              }}
            />
            <ul id={`${base}-list`} role="listbox" aria-label={label} className="ui-combo-list">
              {hits.map((o) => (
                <li
                  key={o.id}
                  id={`${base}-o-${o.id}`}
                  role="option"
                  aria-selected={o.id === selected}
                  className={o === active ? 'ui-combo-on' : undefined}
                  onMouseMove={() => setAt(hits.indexOf(o))}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(o);
                  }}
                >
                  <span className="ui-combo-label">{o.label}</span>
                  {o.hint ? <span className="ui-combo-hint">{o.hint}</span> : null}
                  {o.id === selected ? (
                    <svg
                      className="ui-combo-check"
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  ) : null}
                </li>
              ))}
            </ul>
            {hits.length === 0 ? <p className="ui-combo-none">{empty}</p> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export interface PaletteItem {
  readonly id: string;
  readonly label: string;
  /** A second, muted word: the project's kind, the page's section. */
  readonly hint?: string;
  /** The heading the item is listed under ("Pages", "Projects"); items of one group are kept together. */
  readonly group?: string;
  /** A nav icon id. */
  readonly icon?: string;
  readonly to: string;
}

/**
 * ⌘K search: a dialog with one field and the matching places under their headings, arrow keys to move, Enter to
 * open, Escape to close. It searches what the caller gives it (the screens and projects the person may open); it
 * never shows something the nav would hide.
 */
export function CommandPalette({
  items,
  onPick,
  onClose,
  placeholder = 'Search pages and projects',
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
  // the matches, kept in their groups in the order the caller gave the groups
  const hits = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const found = items
      .filter((i) => {
        const hay = `${i.label} ${i.hint ?? ''} ${i.group ?? ''}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 30);
    const order: string[] = [];
    for (const i of found) if (!order.includes(i.group ?? '')) order.push(i.group ?? '');
    return order.flatMap((g) => found.filter((i) => (i.group ?? '') === g));
  }, [items, q]);
  const pick = (i: PaletteItem | undefined) => {
    if (!i) return;
    onPick(i.to);
    onClose();
  };
  const active = hits[Math.min(at, hits.length - 1)];
  const groups = [...new Set(hits.map((h) => h.group ?? ''))];
  return (
    <div
      className="ui-scrim ui-scrim-center ui-scrim-top"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="ui-palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="ui-palette-bar">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            ref={input}
            className="ui-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            {...(active ? { 'aria-activedescendant': `${listId}-${active.id}` } : {})}
            aria-label="Search"
            placeholder={placeholder}
            autoComplete="off"
            spellCheck={false}
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
          <kbd className="ui-kbd" aria-hidden="true">
            Esc
          </kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="ui-palette-list">
          {groups.map((g) => (
            <li key={g || '-'} role="presentation" className="ui-palette-grp">
              {g ? (
                <span className="ui-palette-gh" aria-hidden="true">
                  {g}
                </span>
              ) : null}
              <ul role="group" {...(g ? { 'aria-label': g } : {})}>
                {hits
                  .filter((i) => (i.group ?? '') === g)
                  .map((i) => (
                    <li
                      key={i.id}
                      id={`${listId}-${i.id}`}
                      role="option"
                      aria-selected={i === active}
                      className={i === active ? 'ui-palette-on' : undefined}
                      onMouseMove={() => setAt(hits.indexOf(i))}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        pick(i);
                      }}
                    >
                      {i.icon ? <NavIcon id={i.icon} size={16} /> : null}
                      <span className="ui-palette-label">{i.label}</span>
                      {i.hint ? <span className="ui-palette-hint">{i.hint}</span> : null}
                    </li>
                  ))}
              </ul>
            </li>
          ))}
        </ul>
        {hits.length === 0 ? (
          <p className="ui-palette-none">Nothing matches. Try another word.</p>
        ) : null}
        <div className="ui-palette-foot" aria-hidden="true">
          <span>
            <kbd className="ui-kbd">↑</kbd> <kbd className="ui-kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="ui-kbd">↵</kbd> to open
          </span>
          <span>
            <kbd className="ui-kbd">Esc</kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}
