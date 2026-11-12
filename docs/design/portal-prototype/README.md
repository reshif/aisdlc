# AISDLC portal: final product design

A clickable design reference for the whole portal (`services/web` is built from it). Plain browser JavaScript, example data in
memory, one self-contained page. Where it and the specs disagree, the specs win (see "Spec decisions" below).

## Build, open, test

```bash
node assemble.mjs aisdlc-portal.html            # one page; fonts from Google Fonts, no other external file
AS=lt FULL=1 node shoot.cjs "$PWD/aisdlc-portal.html" /tmp/shots home config   # screenshots as an account
node ../tools/persona.cjs "$PWD/aisdlc-portal.html" [lt,ar,…] [--w=390] [--contrast]   # every route as every persona
node ../tools/flow.cjs "$PWD/aisdlc-portal.html"   # propose sandbox.caps as lt, lt cannot decide, oh approves, value in force
```

Accounts (dev IdP): lt factory owner, oh deputy factory admin, rb project admin, ar approver and code owner, pm product owner,
dn engineer, ks security, jm exception approver, mw web lead onboarding Mobile App, nf auditor, tb viewer guest.

## Files

| File | Contents |
|---|---|
| `src/base.css`, `src/*.css` | tokens and components; `cfg.css` the configuration pattern; `views-quality.css` quality, M14, onboarding console |
| `src/core.js` | vocabulary, example data (agents = the real registry of `packages/agents`), helpers, router, shell |
| `src/access.js` | roles, actions, gate policies, bindings, accounts, the permission engine (`A.why`, `A.can`, `A.act`, `A.decideCheck`) |
| `src/shell.js` | sign-in, user menu, Home, My access, 404 |
| `src/floor.js` | Floor and Fleet |
| `src/views-work.js` | board, items, item page, ask for work, ask the factory |
| `src/views-decide.js` | inbox, gate and card shell, projects, project page, onboard wizard, S0, readiness, issue twin |
| `src/views-operate.js` | scheduler, sandboxes, controls, kill switch, health, notifications |
| `src/views-govern.js` | ledger, audit, catalogue |
| `src/views-admin.js` | organisation and sign-in, people, teams, roles, access requests, who can do what, sign-ins and sessions |
| `src/cfg.js` | **the one configuration pattern**: key registry with schema descriptions, layer revisions (factory, per project), in force + lineage, form from schema, canonical-JSON diff, validation (schema + the key's rules), propose (supersedes the pending one), M1 deciders, publish |
| `src/views-config.js` | Govern › Configuration index, the setting page `cfg-<key>[@project]`, the M1 card of a revision |
| `src/views-quality.js` | Agents, agent page, Evals, Models and routes, Integrations |
| `src/views-m14.js` | S7 checks 7.1–7.5 on the item, Evidence Pack viewer, gate-check verdicts, gates Q1 E6 X2 X3 E2 X4 |
| `src/views-onboard.js` | card 2 (claims, instruction-file sections vs the factory template), card 3, G5 on card 4, the onboarding agent console |

## Routes

Rail (shown only when the PDP allows): Home · Work: floor, fleet, board, items, ask, chat, inbox · Projects: projects, onboard,
issues · Operate: capacity, sessions, controls, kill, health · Quality: agents, evals, **models**, integrations · Govern:
notifications, ledger, audit, catalogue, **config** · Admin: org, people, teams, roles, access-requests, access-explain, signins.

Deep routes: `item-<KEY>`, **`pack-<KEY>`**, `gate-<G>-<KEY>` (incl. **Q1, E6, X2, X3, E2**, `gate-X4-merge-payments-417`,
`gate-M1-<revision>` e.g. `gate-M1-fac-r20`, `gate-M1-cfg-r7`), `card-<C>-<project>` (incl. **C2, C3**), `project-<id>`,
`s0-<id>`, `readiness-<id>`, `agent-<id>`, **`cfg-<key>`** and **`cfg-<key>@<project>`**, `my-access`. `gateway` still
works (renders Models and routes). A route you may not open is a 403 with the reason and "ask for access"; something you
cannot see (confidential project, unknown key) is the same 404 as a missing one.

## What changed from the prototype

- **One configuration pattern** (`cfg.js`) used by every setting: in force with lineage (layer revision, hash, proposer, M1
  decider, ledger), a draft form generated from a schema description that mirrors the contracts' Zod schemas, live checks
  (schema + cross-key/tier rules such as coding ≤ total, routes name a model, D3 impossible, T2 gating floor, no bot on the
  bypass list, no self-grant in the role map), canonical-JSON diff, Propose (opens M1; supersedes the layer's pending
  revision, with a warning), pending, history and rollback-as-new-revision, "what the reader answers". Secret fields take only
  `file:`/`env:` references and refuse anything that looks like a value. Locked buttons explain themselves (`A.act`, or a
  "not built" drawer for keys the backend does not have yet).
- **Configuration index** of every key of portal-config §1.1 plus decided-but-not-built keys (factory M1 policy, instruction
  template, onboarding image, Light/Full values, notification channels, G5 release, WIP limit, default envelope), each marked.
- **Quality** rebuilt: Agents from the real registry (A7, A8, A10 unbound; prompt sha256 from `prompts.lock.json`; contract,
  tools, data class, model allow-list, budget), "change an agent = PR + eval gate", no on/off switch; Evals as run history only
  (candidate PR gates, baselines, gate rules, CLI); Models and routes (env × data class grid, D3 never, per-agent effective
  model vs allow-list, runtime budget groups, deployment bounds); Integrations (rows, health with 2-minute unknown, credential
  references, build result, test connection = reported health only, rotation flow, installs, D11).
- **Project settings** tab: tiles into the pattern for role map, two-person, gating profile, kill delegations, G5 release,
  WIP, default envelope (M15), plus the repo's rows of factory keys (merge bypass list, DEC-18 allow-list, installs) and what
  is not a setting (per-area levels, protected paths, GitHub repo settings).
- **Operate**: one coding slot (CODING_SESSION_CAP 1, caps 4/1) everywhere incl. the floor; live slots from the controller,
  caps and allow-list tiles, session policy; kill scopes limited to the contract vocabulary (fleet, project, lane, session),
  "who can kill" from the role map and delegations.
- **M14**: S7 tab per check with facts and findings, the signed Evidence Pack viewer with `aisdlc-verify-pack` and the
  gate-check verdict history; gate screens Q1, E6, X2 (two-person, patch hash), X3, E2 (constitution report), X4 (bypass merge,
  SoD on the merger). New items W-40..W-43; W-25 now waits on E2.
- **Onboarding**: card 2 with claims, evidence and AGENTS.md/CLAUDE.md sections accepted or rejected by the template (fenced
  guidance, X2 edit for rejected ones), per-area levels, card 3 (not requested), G5 choice on card 4, and the onboarding agent
  console on the S0 page (citations, drafts, proposal buttons through the PDP, refusals, stale-head notice, budget).
- **Admin**: sign-in/session settings shown read-only as deployment settings (no `identity.settings` key exists); project
  bindings go through the role map; no self-grant; access requests carry an expiry; M3 button removed (code + bundle).
- **Clean-up**: catalogue is 1.3.0 (1.4.0 is the open PR with the 2026-11-11 eligibility decision), DeepSeek/model kill
  narrative replaced, contrast raised (faint and muted text, L6/L8 chips), focusable clickable rows, no horizontal scroll at
  390 px, oh added as an account.

## Spec decisions where the brief and the specs differ (specs followed)

- Routes are (environment, data class) → model; there are no per-agent routes or fallbacks, and budget limits come from
  contracts, so Models and routes shows them read-only.
- Agent prompts and contracts are code (PR + eval gate); no on/off switch (gap 14).
- Factory M1 has no decider in code: the screens show the decided rule (a factory admin other than the proposer) and say so.
- Session policy, SSO and step-up mode are deployment settings, read only.
- Notifications are M18: the screen is marked as design with example numbers.
