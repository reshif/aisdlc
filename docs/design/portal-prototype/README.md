# Portal prototype

A clickable design reference for the complete AISDLC portal. It is plain browser JavaScript with example data held in memory. It is not the product: that is `services/web`. What it covers and what is missing: [`../portal-coverage.md`](../portal-coverage.md).

## Build and open

```bash
node docs/design/portal-prototype/assemble.mjs "$PWD/portal.html"
```

Then open `portal.html` in a browser. Switch accounts from the user menu in the top right to see how access changes.

## Screenshot

```bash
AS=ar W=1440 FULL=1 node docs/design/portal-prototype/shoot.cjs "$PWD/portal.html" /tmp/shots home floor inbox
```

`AS` is the account to sign in as: lt, oh, rb, ar, pm, dn, ks, jm, mw, nf or tb, or `out` for signed out.

## Layout

| File | Contents |
|---|---|
| `src/base.css` | design tokens and components |
| `src/core.js` | vocabulary, example data, helpers, router, shell |
| `src/access.js` | roles, actions, gate policies, bindings, accounts, the permission engine |
| `src/shell.js` | sign-in, user menu, Home, My access |
| `src/floor.js` | Floor and Fleet |
| `src/views-work.js` | work screens |
| `src/views-decide.js` | decisions and projects |
| `src/views-operate.js` | operations |
| `src/views-govern.js` | quality and governance |
| `src/views-admin.js` | identity and access admin |

`BRIEF-1-screens.md` and `BRIEF-2-access.md` are the briefs the screens were built to.
