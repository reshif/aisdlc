import type { ReactNode } from 'react';

// The portal's icons: inline SVG, one 24x24 grid, 1.75 stroke, currentColor (so a token colours them), always
// decorative (`aria-hidden`): the accessible name is the text beside or the label of the button around them.

function Svg({ children, size = 18 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      className="ui-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const ICONS: Readonly<Record<string, ReactNode>> = {
  // groups
  work: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3 13h18" />
    </>
  ),
  projects: (
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
  ),
  run: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m10 8.5 5 3.5-5 3.5v-7Z" />
    </>
  ),
  govern: (
    <>
      <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  // entries
  home: <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1v-8Z" />,
  inbox: (
    <>
      <path d="M3 13h5l1 3h6l1-3h5" />
      <path d="M5 5h14l2 8v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5l2-8Z" />
    </>
  ),
  items: (
    <>
      <path d="M9 6h11M9 12h11M9 18h11" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </>
  ),
  floor: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  onboard: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v8M8 12h8" />
    </>
  ),
  operate: <path d="M3 12h4l3-8 4 16 3-8h4" />,
  agents: (
    <>
      <rect x="5" y="8" width="14" height="11" rx="3" />
      <path d="M12 4v4M9 13v1.5M15 13v1.5M2 13v3M22 13v3" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </>
  ),
  integrations: (
    <>
      <path d="M9 3v5M15 3v5M6 8h12v4a6 6 0 0 1-12 0V8Z" />
      <path d="M12 18v3" />
    </>
  ),
  people_roles: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </>
  ),
  audit_log: (
    <>
      <path d="M6 3h9l4 4v14H6V3Z" />
      <path d="M14 3v5h5M9 13h7M9 17h7" />
    </>
  ),
  board: (
    <>
      <rect x="3" y="4" width="5" height="16" rx="1" />
      <rect x="10" y="4" width="5" height="10" rx="1" />
      <rect x="17" y="4" width="4" height="13" rx="1" />
    </>
  ),
  fleet: (
    <>
      <path d="m3 7 9-4 9 4-9 4-9-4Z" />
      <path d="m3 12 9 4 9-4M3 17l9 4 9-4" />
    </>
  ),
  evals: <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />,
  catalogue: (
    <>
      <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3V4Z" />
      <path d="M5 17a3 3 0 0 1 3-3h11" />
    </>
  ),
  people: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  teams: (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.5a6.5 6.5 0 0 1 3.5 5.5" />
    </>
  ),
  roles: <path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6l-7-3Z" />,
  access_requests: (
    <>
      <circle cx="8" cy="12" r="4" />
      <path d="M12 12h9M18 12v3" />
    </>
  ),
  who_can: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  ask_for_work: <path d="M12 5v14M5 12h14" />,
  assistant: <path d="M4 5h16v11H9l-5 4V5Z" />,
  my_notifications: <path d="M6 10a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Zm4 9a2 2 0 0 0 4 0" />,
  my_access: (
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  my_profile: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  // the sidebar toggle
  collapse: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M16 9l-3 3 3 3" />
    </>
  ),
  expand: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M13 9l3 3-3 3" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3" />,
};

/** The icon for a nav group or entry id (a plain dot for an id with none). */
export function NavIcon({ id, size }: { id: string; size?: number }) {
  return <Svg {...(size ? { size } : {})}>{ICONS[id] ?? ICONS['dot']}</Svg>;
}
