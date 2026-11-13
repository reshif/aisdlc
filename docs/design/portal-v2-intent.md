# Portal v2: intent

Status: agreed with the owner on 2026-11-13. This is what the portal must become; how each part is built follows in
the glossary, the screen map and the squads' plans.

## Goal

One portal from which the factory owner sets up, runs, changes and cleans up the whole factory, without the command
line, in words an ordinary engineer understands. Built on two agreed designs:

- the **sign-in page** (option A: company SSO first, a local account second, the approval card beside the headline);
- the **skeleton** on the "AISDLC portal layouts" canvas, page "AISDLC skeleton": one shell, Home (needs you), Decide
  a gate (evidence first, decision rail), Work item (stage strip, tabs, properties), Project (catalogue page with the
  readiness scorecard), Onboard (agent-led), Settings (change, preview, approve).

The current portal and the prototype are not the reference for look or structure; the skeleton is.

## The seven problems

1. **Vocabulary.** Users see plain words, not codes (S0–S9, G0–G6, L0–L8, M1, Census/Light/Full, B-codes, X1, PRR,
   KRL). Codes appear only as small secondary labels where an auditor needs them. One glossary in the code drives every
   label, so a term cannot drift between screens; it is approved by the owner before screens are built.
2. **Integrations configurable in the portal**: GitHub (the Apps, which repos, the required check), model providers
   and the model per agent, Slack and email; each with a test and its health.
3. **Everything configurable by the factory owner, nothing hard-coded**: lanes and their rules, which gates exist and
   who decides them, limits, budgets, models per agent, agents on or off, turns and timeouts, notifications,
   retention, sandbox caps, the repos agents may code on. A change shows its effect before it is saved.
4. **Agent-led onboarding.** An onboarding agent reads the repo, works out owners, tests, branch protection and agent
   instructions, and proposes fixes as pull requests (CODEOWNERS, protect-main, AGENTS.md). The person reviews one
   summary, adjusts, and signs off once. The cards remain the record underneath, not the user's workflow.
5. **Create, edit and delete every object from the portal**: projects, repos, people, teams, roles, integrations,
   configuration, agents.
6. **The onboarded repo's whole life**: edit its settings, change its level, re-onboard, pause agents on it, remove it.
7. **A fully working frontend**: every button does something real; no "not built" screens; nothing is possible only
   from the command line.

And throughout: what is set in onboarding or settings shows the same everywhere (floor, gates, items, inbox,
notifications), read from one source.

## Decisions (2026-11-13)

| Topic | Decision |
| --- | --- |
| Secrets | Entered in the portal into a **write-only** field and stored in **HashiCorp Vault** (local prod: a real Vault server in the stack, persistent storage, unsealed automatically on the owner's machine). Never shown again after saving; never in the record, a log or the browser after submit. Production later: **AWS Secrets Manager** behind the same port. |
| Delete | **Delete means delete.** Deleting an object removes all its data and content from the factory: documents, code, names, settings, record events, read models, stored packs. The ledger keeps only each entry's hash so the chain still verifies; nothing about the deleted object can be read or restored. |
| Factory admin | **Nothing applies to the factory admin**: may change anything anywhere, override any gate, skip or decide any onboarding step alone, change any rule alone, act alone where others need two people. Every such action is still **recorded** (who, what, a reason) so the audit trail has no holes; recording never blocks it. The factory still never merges a PR itself: a person merges on GitHub (GitHub's protection, not a factory rule). |
| Sign-in | **Keycloak** as the identity provider (OpenID Connect) for local prod; any OIDC provider in production. Local username and password accounts live in Keycloak, for the factory admin(s) as break-glass. |
| Phone | Chosen by the lead designers: the inbox, deciding and the kill switch work on a phone; admin screens are desktop-first. |
| Glossary | Drafted first and approved by the owner before any screen is built. |

## How it is built

An agent team works on the portal only (`services/web`, the bff and the core routes the screens need); no side paths
in the command line or the prototype:

- **Lead design engineer**: the glossary, the screen map, the rules every screen follows.
- **Design-system engineer**: the component library from the skeleton and the sign-in look, light and dark, WCAG 2.2 AA.
- **Feature squads**, each owning screens end to end (screen, API, tests): shell and Home; Decide and Work item;
  projects and agent-led onboarding; settings and integrations (incl. Vault); people, admin and lifecycle (delete).
- **QA**: every screen as each test person; every button does what it says.
- **Challenger**: "would a new engineer understand this screen?"

Order: glossary and screen map (owner approves) → design system → squads in parallel → QA and challenger → hand-off.

## Done when

- every screen of the screen map is built on real APIs, in plain language, on phone where the table says so;
- everything in "the seven problems" works from the portal alone;
- QA passes as every test person, and the challenger's review has no open blocker;
- the request-to-PR journey and the restore drill stay green in CI.
