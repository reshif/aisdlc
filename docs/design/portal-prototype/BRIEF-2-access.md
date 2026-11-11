# Brief 2: make every screen obey who you are (enterprise access model)

Read BRIEF.md first (layout, helpers, verification), then this. The prototype now has sign-in, accounts, and a
permission engine that mirrors the repo's real access model. The user wants an enterprise-grade portal where
"who can do what, where" is fully thought through and visibly reflected: different accounts see different
navigation, data and buttons, and every denial explains itself. Not a set of pretty pages: a coherent system.

## The access model (read src/access.js and src/shell.js fully; do not edit them, nor core.js/base.css)
Ground truth in the repo: packages/contracts/src/entities/access.ts (ROLE_CATALOGUE), policy.ts (ACTION_CATALOGUE),
gate-lifecycle.ts (GATE_POLICIES), projects.ts (TWO_PERSON_GATES).
- A **role binding** = person + role + scope (fleet | team | project). 14 roles: project.admin, requester, intent_approver,
  design_approver, code_owner, release_approver, exception_approver, security_approver, onboarding_signer, kill_holder,
  viewer; factory.admin, factory.onboarder, factory.auditor. Each role has a view level (V1 positions only, V2 content,
  V3 audit/settings/access) and a data class (D0 none, D1 artefacts and titles, D2 transcripts, secrets findings, tripwire evidence).
- **Actions** (A.access.ACTIONS) are what the PDP is asked. Rows marked `proposed: true` are portal rows not yet in the
  catalogue (show a small "proposed" tag where you list actions).
- **Gates**: each gate is decided by one slot (GATE_POLICY). factory.admin decides no gate unless it holds the slot.
  Cross-cutting: own request blocked (except G6), plan author / code author SoD, two-person for X1 X2 E2 M4, step-up for
  G5, M4 and G4 with a sensitive path; an active kill blocks approvals. All in `A.decideCheck(gate, key)`.
- **Confidential** projects (Identity Hub) do not exist for people without a role on them; fleet roles see a collapsed row.

## API you must use
- `A.me()` the signed-in person id (NEVER capture A.data.ME or 'ar' at load time; read at render time). `A.session`.
- `A.can(action, res)`, `A.why(action, res)` -> {allow, reason, policy, need, via}. res = {type:'Fleet'|'Project'|'Item'|'Gate'|'Card'|'Lane'|'Team', project, gate, item}.
- `A.act(label, action, res, {cls, href, go, attrs, icon})` renders the button: enabled when allowed, otherwise a dashed
  locked button that opens the "why" drawer (with "Request access"). Use it for EVERY action button you have.
  For custom buttons with your own handlers, check `A.can` first and render `A.act(...)` (locked) when denied.
- `A.decideCheck(gate, key)` -> {allow, rules:[{ok, info, text}], stepUp, twoPerson, policy}. Decision panels show the rules.
- `A.stepUpModal(done, why)`, `A.stepUpValid()`.
- `A.visibleProjects()`, `A.visibleItems()`, `A.canSeeProject(id)`, `A.viewLevel(project)` (0-3), `A.dataClass(project)` (-1..2),
  `A.redactedTitle(item)`, `A.myRolesOn(project)`, `A.bindingsOf(pid)`, `A.persona()`, `A.access.{ROLES, ROLE, ACTIONS, GATE_POLICY, BINDINGS, ACCOUNTS, SIGNINS}`, `A.ACCESS_REQUESTS`.
- `A.forbidden(action, res, title)` a full 403 body. `A.explainDrawer(action, res)`. `A.myDecisions()`, `A.inboxCount()`.
- Route guard: a view may declare `access: (params) => ({ action, res })`; the router shows the 403 page when denied and
  hides the rail link when `access([])` is denied (or declare `navAccess: () => bool`). Add `access` to every view.
- The top-bar project picker (`A.state.project`) only lists projects you can see.

## Rules for every screen
1. Declare `access` on every view (see the per-screen table in your task). Nav only shows what the person may open.
2. Lists contain only what the person may see (A.visibleItems/visibleProjects). Never show items of a project you
   cannot see. Counts and badges are computed from the same filtered data and for A.me().
3. Content follows the data class: below D1 show no titles (A.redactedTitle), no artefact text, no PR diff; below D2 no
   transcripts, tool-call logs, tripwire evidence or secret-finding details (show a "hidden: needs D2" placeholder with
   the why button). Hide, do not blur.
4. Every action is A.act / A.can-guarded. A denied action stays visible as a locked button when the person can see the
   thing it acts on (so they learn who can), and is omitted when the whole area is not theirs.
5. Remove any "prototype: act as …" switches. Instead, where a gate is not yours, list WHO can decide it (names from
   A.access.BINDINGS for that slot on that project) and add a small dev hint: "Switch account to try it" linking to the
   user menu (`document.getElementById('me-btn').click()`).
6. Tabs must each have a clear purpose; remove or merge tabs that duplicate another screen; tab labels say what's in them.
7. Keep everything that already works; improve, don't rewrite from scratch.

## Verify (in addition to BRIEF.md)
`AS=<pid>` makes shoot.cjs sign in as that account before loading (pids: lt factory owner, rb project admin, ar approver,
pm product owner, dn engineer, ks security, jm exception approver, nf auditor, tb viewer; `AS=out` = signed out). File names
get the pid prefix. Check your routes at least as ar, tb, nf, lt (and the persona your screens are about), W=1440 and W=400.
Zero console errors; no OVERFLOW-X. Assemble to your own output file name. Report briefly: per route the access rule you
applied and what changes per account.
