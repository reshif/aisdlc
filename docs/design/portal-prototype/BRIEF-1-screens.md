# Brief: AISDLC portal prototype (one HTML page, many screens)

We are building a high-fidelity, clickable HTML prototype of the COMPLETE end-state portal of AISDLC, a governed AI
software factory (work moves through stages S1-S9 with gates; humans decide gates; everything lands in a signed ledger).
The user will judge this by how real, dense and well-designed every screen is. They already rejected a thin version as
"pathetic". Every screen must look like a finished product screen full of believable example data, not a wireframe.

## Where things are
- Prototype dir: /tmp/claude-0/-home-user/fd91d272-8d85-5423-ac89-51234d5138f6/scratchpad/portal2
  - src/base.css   design tokens and component CSS (READ IT; do not edit)
  - src/core.js    shared data, helpers, router, shell (READ IT FULLY; do not edit)
  - src/<your file>.js  the ONLY file you write (plus optionally src/<your file>.css for extra CSS)
  - assemble.mjs   `node assemble.mjs <out.html>` concatenates everything into one page
  - shoot.cjs      `node shoot.cjs <abs out.html> <outdir> route1 route2 ...` screenshots routes (env W=, H=, FULL=1) and prints console errors and horizontal overflow
- Repo with the specs (source of truth for behaviour and vocabulary): /home/user/aisdlc
  - docs/specs/domain-model.md (entities per bounded context; §3.x, §5.3 quality views, §7 floor), docs/specs/flow-corrected.mmd
    (lifecycle, gates, back-edges B1-B28, ET triggers), docs/specs/onboarding-roadmap.md (S0, cards, PRR, levels),
    docs/specs/gateway-api.md, docs/PLAN.md (milestones M0-M20), AGENTS.md (one-paragraph summary of every package)
  - services/web/src: the real React portal so far (cards C1/C4/C5/SECR, PRR, ledger, inbox, item pages) for real wording
  Read the parts relevant to your screens so the content uses the factory's real terms (step ids like 6.4, gates like G3,
  back-edges like B13, ET triggers, lanes L0-L8, onboarding levels Census/Light/Full, PRR, mode C/E, step-up, SoD, etc.).

## How a view is written
```js
A.view('board', { label: 'Board', group: 'Work', icon: 'board',          // group: Work|Projects|Operate|Quality|Govern
  badge: () => ({ n: 3, hot: true }),                                      // optional rail badge
  render: (params) => `...html string...`,                                  // return the main area HTML
  mount: (root, params) => { /* wire interactivity; optional */ },
  unmount: () => {} });                                                     // optional (clear timers)
// parametrised, hidden from the rail:
A.view('item', { nav: false, parent: 'items', match: /^item-(.+)$/, render: ([key]) => ... });
```
Routes are plain hashes (`#board`, `#item-W-31`, `#gate-G3-W-27`). Only letters, digits and hyphens. Links: `<a href="#item-W-31">`
or any element with `data-go="item-W-31"`. Other global attributes: `data-toast="text"` shows a toast; `data-peek="W-31"` opens the
item quick-look drawer; `data-close` closes overlays; tabs via `A.tabs(group, [{id,label,n,html}])` switch themselves.
Helpers (see core.js): A.pageHead, A.card, A.stats, A.kv, A.table(cols, rows, {href}), A.tabs, A.steps(stage, step), A.chip(item),
A.ichip(key), A.lane(lane), A.gate(id), A.statePill, A.pill(text, kind), A.health, A.hash, A.avatar/A.avatars/A.who, A.glyph('A'|'D'|'H'),
A.actors, A.meter(used, cap), A.spark(values), A.cents, A.icon(name), A.toast, A.drawer(html), A.modal(html), A.peek(key), A.empty.
Shared data: A.data.{LANES, LANE_GROUPS, STEPS, STAGES, GATES, BACK_EDGES, PEOPLE, ME ('ar', the signed-in user Alex Rivera),
TEAMS, PROJECTS, ITEMS, AGENTS, SESSIONS, LEDGER}; A.item(key), A.project(id), A.person(id), A.agent(id), A.itemsOf(projectId),
A.waitingOnMe(), A.state.project (the project picked in the top bar; respect it where a screen is per project).
Use the shared items/people/agents so screens agree with each other (W-31 is in pod 1 on the floor, so its item page shows S6 6.4,
unit u2 of 3, session ses-7f21, etc.). Add screen-specific example data inside your own file as constants.

## Design rules
- Dark control-room look already defined in base.css: Barlow Condensed headings (var(--display)), IBM Plex Sans body, IBM Plex Mono
  for ids, hashes, step ids. Gold diamond = gate, orange = back-edge, blue = handoff, red = quarantine/danger, purple robot = agent,
  grey console = deterministic step, teal person = human. Use the tokens (var(--...)); never hard-code a colour that is not a token,
  except inside SVG charts where you still use tokens via fill="var(--x)".
- Use the existing classes (.card, .stats, .tbl, .kv, .pill, .btn, .tabs, .tl timeline, .steps, .split, .grid .g2/.g3/.g4, .li list rows,
  .banner, .fence for quoted agent/repo text, pre.code). Add new CSS only for things that genuinely need it, in src/<yourfile>.css,
  with class names prefixed by your group (e.g. .wk-board-col) so nothing collides.
- Dense but calm. Summary first (stats or a status line), then detail. Every screen has a page head with a clear title and one-line
  subtitle written for the person using it (plain words, active voice). State visible at a glance (pills, chips, meters).
- Real content everywhere. No lorem ipsum, no "TODO", no empty placeholders unless it is a designed empty state.
- Actions are buttons that would call a route; the PDP decides. Make buttons do something visible in the prototype (toast, modal with
  a confirm step, drawer, state change). The viewer cannot show alert/confirm/prompt; build confirmation into the page.
- Must work at phone width (~400px): no page-level horizontal scroll (tables live in .tbl-wrap which scrolls). Check with W=400.
- Vanilla JS only, no libraries. Keep your file self-contained; do not touch globals other than A.view and your own constants
  (wrap your file in an IIFE).

## Verify before you finish
1. `node assemble.mjs /tmp/claude-0/-home-user/fd91d272-8d85-5423-ac89-51234d5138f6/scratchpad/portal2/test-<group>.html`
   (use your own output name; other people assemble at the same time).
2. Screenshot every one of your routes at W=1440 FULL=1 and at W=400, read the PNGs (Read tool) and fix what looks wrong,
   cramped, misaligned or empty. Zero console errors, no OVERFLOW-X.
3. Report back: the routes you added (one line each) and anything you could not do. Keep the report short.
