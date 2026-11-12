# Third-party Claude Code components

The skills in `.claude/skills/` and the agent in `.claude/agents/` were vendored by hand (raw files read
and reviewed; the `npx claude-code-templates` installer was not run) from
[davila7/claude-code-templates](https://github.com/davila7/claude-code-templates) at commit
`82b59de18b544e7269b8b8bd8b09b0ba2ca924a1`, and adapted for this repository on 2026-11-12.
AGENTS.md wins on any conflict with them.

The collection repository is MIT licensed ("Copyright (c) 2025 Daniel (San) Ávila", `LICENSE` at that
commit). Its README says catalogue items keep their original licence and attribution and lists the
sources it draws on; none of the five items below is attributed there by name. This repository is MIT.

| Item                          | Source path (at 82b59de)                                                                     | Licence as found                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| skill `zod-validation-expert` | `cli-tool/components/skills/web-development/zod-validation-expert/SKILL.md`                  | No licence field (metadata `source: community`); collection repo MIT; item upstream not identified                                                                                                                                                                                                                                                 |
| skill `tanstack-query-expert` | `cli-tool/components/skills/web-development/tanstack-query-expert/SKILL.md`                  | No licence field (metadata `source: community`); collection repo MIT; item upstream not identified                                                                                                                                                                                                                                                 |
| skill `react-best-practices`  | `cli-tool/components/skills/web-development/react-best-practices/` (SKILL.md, `references/`) | `license: MIT`, author Vercel Engineering (frontmatter). Upstream: [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) `skills/react-best-practices/` (named by the item's `download_rules.sh`); that repository's README states "License: MIT" and its SKILL.md `license: MIT` (checked at `1a2c79d`); it has no LICENSE file |
| skill `accessibility-auditor` | `cli-tool/components/skills/creative-design/accessibility-auditor/SKILL.md`                  | No licence field; collection repo MIT; item upstream not identified                                                                                                                                                                                                                                                                                |
| agent `accessibility-tester`  | `cli-tool/components/agents/accessibility/accessibility-tester.md`                           | No licence field; collection repo MIT; item upstream not identified                                                                                                                                                                                                                                                                                |

Every vendored file starts with (or, after its frontmatter, carries) a header naming its source path,
the commit, the adaptation date and that AGENTS.md wins.

## What was changed

Common to all items: the vendoring header; examples rewritten for this stack (React 19 + Vite SPA
served by the bff under a strict content security policy, TanStack Query, Zod 4 from
`@aisdlc/contracts`, TypeScript strict with `noUncheckedIndexedAccess` and
`exactOptionalPropertyTypes`, no `any`); no new dependency implied without an exact version; Prettier
formatting.

### zod-validation-expert

- Examples moved from Zod 3 to Zod 4 (the repo pins `zod` 4.6.7): `z.email()`/`z.uuid()`/`z.url()`,
  `z.iso.*`, the `error` parameter, `z.config({ customError })` instead of `z.setErrorMap`/`ZodIssueCode`,
  `z.flattenError`/`z.treeifyError` instead of `.flatten()`/`.format()`, `z.stringbool()`.
- Added "the rules of this repo": schemas defined once in `packages/contracts`, enums never re-declared
  (the `X`/`XValues` pattern), portal forms generated from contract JSON Schema and checked by
  `services/web/src/lib/schema.ts`, the server validating again, fail closed.
- Removed the React Hook Form, Next.js Server Actions and tRPC sections (not in the stack; would imply
  new dependencies) and replaced them with portal forms, service boundaries and configuration
  (`file:` secret references).
- Removed `z.any()` and the `prevState: any` example; use `z.unknown()`.

### tanstack-query-expert

- Removed the Next.js App Router sections (provider in `app/providers.tsx`, server prefetch and
  `HydrationBoundary`): the portal has no server rendering.
- Examples use the portal's real seams: `api.ts` (`request`, `ApiError`, CSRF on writes),
  `createQueryClient` in `App.tsx`, the existing query keys.
- Optimistic updates restricted: never for decisions, gates, ledger entries or anything the server
  signs or hashes (the record is the source of truth); the example is typed (no `any`).
- "Never fetch in useEffect" kept; added fail-closed error handling and no retry of 4xx.

### react-best-practices

- Removed the Next.js / RSC material: the whole "Server-Side Performance" section
  (`server-cache-lru`, `server-cache-react`, `server-parallel-fetching`, `server-serialization`:
  RSC-only, and `lru-cache` with `any`), `rendering-hydration-no-flicker` (SSR, and its inline
  `<script>` is forbidden by the portal's CSP), `bundle-defer-third-party` (analytics loading; the
  portal has no telemetry or third-party scripts), `next/dynamic` and `next.config.js` examples.
- Removed `references/rules/download_rules.sh` (a script that fetched rule files from GitHub with curl).
- Rewritten: `async-dependencies` (plain promises instead of the `better-all` library),
  `async-api-routes` (bff handlers; authorisation first, no parallel statements in a transaction),
  `async-suspense-boundaries` (SPA loading boundaries; decide controls wait for all evidence),
  `bundle-barrel-imports` (workspace packages, `sideEffects: false`), `bundle-dynamic-imports`
  (`React.lazy`), `bundle-conditional` (fixed an undefined `setEnabled`), `bundle-preload`,
  `client-event-listeners` (module-level registry instead of SWR), `client-swr-dedup` renamed
  `client-query-dedup` (TanStack Query instead of SWR), `rerender-defer-reads` (no `useSearchParams`),
  `rerender-derived-state` (fixed invalid JSX), `rerender-lazy-state-init` (typed, validated storage
  read; no credentials in web storage), `rendering-content-visibility`, `rendering-svg-precision`
  (`npx svgo@4.1.0`), `js-cache-function-results` (removed a `document.cookie` login check; never cache
  identity or permissions), `js-cache-storage` (removed cookie caching), `js-hoist-regexp` (escape
  input-built patterns), `js-min-max-loop` (safe under `noUncheckedIndexedAccess`),
  `js-set-map-lookups` (valid syntax; the server decides access), `js-batch-dom-css` (CSP note).
- Notes added to `rendering-activity`, `rerender-memo`, `advanced-event-handler-refs` (React 19.2+
  `Activity`/`useEffectEvent`, no React Compiler).
- `_sections.md` renumbered without the server section. `react-performance-guidelines.md` is now
  compiled from the rule files (same order as upstream) instead of a second hand-kept copy.
- SKILL.md: description, quick reference, metrics (INP instead of FID) and resources adapted.

### accessibility-auditor

- Examples rewritten as JSX that fits the CSP (no inline `onclick`, `<script>` or `<style>`), dialog
  example using the native `<dialog>` with `showModal()`, added single-page-app route-change focus,
  `useId`, and Testing Library role queries.
- Fixed a factual error: upstream said `#767676` on white is 2.5:1 and fails; it is 4.54:1 and passes
  AA. The failing example is now `#999999` (2.85:1). Large-text threshold corrected to 24px / 18.66px
  bold (upstream said 18px / 14px).
- Target raised from WCAG 2.1 to 2.2 AA; removed redundant `role` attributes on semantic landmarks.
- Removed the "Accessibility Statement" template (placeholder contact details; not part of the
  portal) and the "disable JavaScript" check (the portal is an SPA).

### accessibility-tester (agent)

- Tools reduced to `Read, Grep, Glob, Bash`: `WebFetch` and `WebSearch` removed (only used to check
  legal deadlines; no fetching of outside content is needed for an assessment).
- Kept assessment-only and made it explicit: no file writes, installs, config changes or commits;
  Bash only for read-only inspection and the pinned scanners; local `localhost` targets only.
- Every `npx` tool pinned exactly: `@axe-core/cli@4.14.0`, `lighthouse@13.6.0`, `pa11y@10.0.0`
  (and `@axe-core/playwright@4.14.0` only as a recommendation for a person to add). Removed
  `npx playwright test --grep @a11y` and the `npm view axe-core version` check (unpinned, and the repo
  has no such tests); the agent reports the versions the pinned tools used.
- Pointed at the portal (`http://localhost:8340` on the compose stack, sign-in caveat) and
  `platform/compose/e2e-portal.mjs`.
- Removed the legal compliance mapping and its time-sensitive deadline claims (ADA, Section 508, EAA)
  from the method and the scorecard; legal conformance is out of scope.
- Removed "Integration with Other Agents" (those agents do not exist here) and the second example;
  the description's example now uses a real portal file.
