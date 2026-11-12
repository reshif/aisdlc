---
name: accessibility-auditor
description: Web accessibility guidance for the AISDLC portal (React + Vite SPA) - WCAG 2.2 AA, semantic HTML, ARIA, keyboard navigation, focus management and screen reader behaviour. Use when building or reviewing portal components and pages, fixing accessibility defects, or preparing an accessibility audit.
---

> Vendored from davila7/claude-code-templates@82b59de, path
> `cli-tool/components/skills/creative-design/accessibility-auditor/SKILL.md`, adapted for AISDLC on
> 2026-11-12; AGENTS.md wins on any conflict. See `.claude/THIRD_PARTY.md`.

# Accessibility Auditor

Guidance for building portal pages that people of all abilities can use. People decide gates in the
portal: if someone cannot perceive the evidence or operate the decide control, the factory cannot
work for them. The target is **WCAG 2.2 Level AA**.

## This repo

- The portal (`services/web`) is React 19 + Vite, served by the bff with a content security policy of
  `script-src 'self'` and `style-src 'self'`: **no inline `<script>`, no inline event-handler
  attributes, no `<style>` elements or `style` attributes in served HTML**. Examples below are JSX
  with handlers as props and styles in `styles.css`.
- The browser is not the authority: a control hidden or disabled for accessibility reasons never
  replaces the server's check, and a control the server would refuse must say why it is unavailable
  rather than silently disappear.
- Component tests use Testing Library (`@testing-library/react`, `user-event`, `jest-dom`); query by
  role and accessible name (`getByRole('button', { name: 'Approve' })`) so tests double as checks of
  the accessible tree.

## When to use this skill

- Building or changing a portal page, card form or shared component
- Reviewing a change for accessibility
- Fixing an accessibility defect
- Implementing ARIA attributes, landmarks, live regions, focus management
- Preparing an audit (the `accessibility-tester` agent runs one)

## WCAG principles (POUR)

1. **Perceivable**: people can perceive the information presented.
2. **Operable**: people can operate the interface.
3. **Understandable**: people can understand the information and the interface.
4. **Robust**: content works with current and future assistive technologies.

## Common issues and fixes

### 1. Missing text alternatives

**Problem:**

```tsx
<img src="/diagram.svg" />
```

**Solution:**

```tsx
{
  /* Informative image: describe the content or function */
}
<img src="/diagram.svg" alt="Stages S0 to S9 with the gate after each stage" />;

{
  /* Decorative image: empty alt */
}
<img src="/pattern.svg" alt="" />;

{
  /* An icon-only button: the name goes on the button */
}
<button type="button" aria-label="Close">
  <CloseIcon aria-hidden="true" />
</button>;
```

- Informative images describe the content or function
- Decorative images use `alt=""`
- Complex images (charts, diagrams) get a text equivalent nearby (a table or a summary)

### 2. Low colour contrast

**Problem:**

```css
/* #999999 on #ffffff is 2.85:1 - fails AA for normal text */
.muted {
  color: #999999;
  background: #ffffff;
}
```

**Solution:**

```css
/* #767676 on #ffffff is 4.54:1 - passes AA */
.muted {
  color: #767676;
  background: #ffffff;
}

/* #595959 on #ffffff is 7.0:1 - passes AAA */
.muted-strong {
  color: #595959;
  background: #ffffff;
}
```

**Requirements (WCAG 1.4.3, 1.4.6, 1.4.11):**

- Normal text: 4.5:1 minimum (AA), 7:1 enhanced (AAA)
- Large text (at least 24px, or at least 18.66px bold): 3:1 (AA), 4.5:1 (AAA)
- UI components, focus indicators and meaningful graphics: 3:1
- Never convey status by colour alone: a gate state or a badge also has text or an icon with a name

### 3. Non-semantic HTML

**Problem:**

```tsx
<div className="button" onClick={submit}>Submit</div>
<div className="heading">Inbox</div>
```

**Solution:**

```tsx
<button type="submit">Submit</button>
<h1>Inbox</h1>
<nav aria-label="Main">...</nav>
```

**Semantic elements:**

- `<button>` for actions, `<a href>` for navigation
- `<h1>` to `<h6>` in hierarchy (one `<h1>` per page)
- `<nav>`, `<main>`, `<aside>`, `<header>`, `<footer>`, `<section>` (with a heading) for landmarks
- `<ul>`, `<ol>`, `<li>` for lists; `<dl>` for term and value pairs
- `<table>` with `<th scope>` for tabular data (the ledger, gap lists)

### 4. Missing form labels

**Problem:**

```tsx
<input type="text" placeholder="Reason" />
```

**Solution:**

```tsx
{/* Explicit label */}
<label htmlFor="reason">Reason</label>
<textarea id="reason" aria-describedby="reason-hint reason-error" aria-invalid={error !== null} />
<p id="reason-hint">At least 10 characters. Bound into the ledger with the decision.</p>
{error !== null ? <p id="reason-error">{error}</p> : null}

{/* Visually hidden label (class in styles.css) for tight layouts */}
<label htmlFor="search" className="sr-only">Search</label>
<input id="search" type="search" />
```

- Every field has a programmatic label; placeholders are not labels
- Use `useId()` for ids in reusable components
- Group related controls with `<fieldset>` and `<legend>` (for example one disposition per gap)
- Errors name the field and say how to fix it, are linked with `aria-describedby`, and the field gets
  `aria-invalid`; on submit, move focus to the first invalid field or an error summary

### 5. Keyboard access

**Problem:**

```tsx
<div onClick={open}>Open card</div>
<a onClick={doSomething}>Action</a>
```

**Solution:**

```tsx
{
  /* Use a real button: Enter and Space work, focus works, the role is right */
}
<button type="button" onClick={open}>
  Open card
</button>;

{
  /* Only if a custom element is truly unavoidable */
}
<div
  role="button"
  tabIndex={0}
  onClick={open}
  onKeyDown={(e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  }}
>
  Open card
</div>;
```

**Keyboard requirements:**

- Every interactive element is reachable and operable by keyboard
- Focus is always visible (`:focus-visible` styles in `styles.css`, 3:1 contrast) and not hidden by
  sticky headers (WCAG 2.4.11)
- Tab order follows the visual order; no positive `tabIndex`
- A skip link to the main content
- No keyboard traps (except a modal dialog, which traps by design and closes on Escape)

### 6. Landmarks

**Problem:**

```tsx
<div className="header">...</div>
<div className="content">...</div>
```

**Solution:**

```tsx
<header>
  <nav aria-label="Main">...</nav>
</header>
<main id="main" tabIndex={-1}>
  <h1>Card 1: Census findings</h1>
  ...
</main>
<footer>...</footer>
```

Semantic elements carry their roles; do not add redundant `role="main"` and the like. One `<main>`
per page; label `<nav>` elements when there is more than one.

### 7. Dialogs

Prefer the native `<dialog>` element opened with `showModal()`: it makes the rest of the page inert,
traps focus, closes on Escape and returns focus to the opener in current browsers.

```tsx
function ConfirmDialog({ open, onClose, onConfirm }: ConfirmDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (d === null) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
      onClose={onClose}
    >
      <h2 id="confirm-title">Reject the plan?</h2>
      <p id="confirm-desc">The item goes back to S5. The decision is recorded in the ledger.</p>
      <button type="button" onClick={onConfirm}>
        Reject
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </dialog>
  );
}
```

**Dialog requirements:**

- A name (`aria-labelledby` the title) and, when useful, a description
- Focus moves into the dialog on open and back to the trigger on close
- Escape closes it; background content is inert
- If a custom dialog is unavoidable: `role="dialog"`, `aria-modal="true"`, a focus trap, `inert` on
  the background, and focus restoration

### 8. Skip link

```tsx
<a href="#main" className="skip-link">
  Skip to main content
</a>
```

```css
/* styles.css */
.skip-link {
  position: absolute;
  inset-inline-start: 0;
  top: -40px;
  padding: 8px;
  background: #000;
  color: #fff;
  z-index: 100;
}
.skip-link:focus {
  top: 0;
}
```

The target (`<main id="main" tabIndex={-1}>`) must be focusable so focus actually moves.

### 9. Route changes in a single-page app

A client-side navigation does not announce itself. On each route change, update `document.title`
and move focus to the new page's `<h1>` (with `tabIndex={-1}`) or to `<main>`, so screen reader and
keyboard users know the page changed.

## ARIA

The first rule of ARIA: use a native element when one exists. ARIA changes what assistive technology
is told, not how the element behaves.

**States:** `aria-checked`, `aria-disabled`, `aria-expanded`, `aria-hidden`, `aria-pressed`,
`aria-selected`, `aria-current` (the current page in navigation, the current step in a stepper)

**Properties:** `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-live`, `aria-required`,
`aria-invalid`, `aria-controls`

### Live regions

```tsx
{
  /* Polite: announced at the next pause */
}
<div role="status">{saving ? 'Saving the decision…' : ''}</div>;

{
  /* Assertive: interrupts; only for errors that need attention now */
}
<div role="alert">{error}</div>;
```

The live region must exist in the DOM before its content changes; render the container always and
change its text.

### Disclosure (accordion)

```tsx
const panelId = useId()

<button type="button" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
  Evidence
</button>
<div id={panelId} hidden={!open}>
  ...
</div>
```

### Tabs

```tsx
<div role="tablist" aria-label="Card sections">
  <button role="tab" id="tab-1" aria-selected={tab === 1} aria-controls="panel-1" tabIndex={tab === 1 ? 0 : -1}>
    Findings
  </button>
  <button role="tab" id="tab-2" aria-selected={tab === 2} aria-controls="panel-2" tabIndex={tab === 2 ? 0 : -1}>
    Owners
  </button>
</div>
<div role="tabpanel" id="panel-1" aria-labelledby="tab-1" hidden={tab !== 1}>...</div>
<div role="tabpanel" id="panel-2" aria-labelledby="tab-2" hidden={tab !== 2}>...</div>
```

Arrow keys move between tabs (roving `tabIndex`); Tab moves into the panel.

## Testing checklist

### Automated

- [ ] axe (browser extension, or the pinned CLI the `accessibility-tester` agent uses) on each page
- [ ] Component tests query by role and accessible name
- [ ] Contrast of text, focus indicators and UI components
- [ ] Heading hierarchy and landmarks
- [ ] Text alternatives

### Manual

- [ ] The whole flow by keyboard only (Tab, Shift+Tab, Enter, Space, Escape, arrow keys)
- [ ] A screen reader (NVDA with Firefox or Chrome, VoiceOver with Safari)
- [ ] Focus is visible and never hidden behind sticky content
- [ ] Form errors are announced and linked to their fields
- [ ] Dialogs trap and restore focus
- [ ] The skip link works
- [ ] Route changes move focus and update the title
- [ ] 200% zoom and 320 CSS px wide reflow without loss
- [ ] Windows High Contrast / `forced-colors: active` and `prefers-reduced-motion: reduce`
- [ ] Targets at least 24 by 24 CSS px (WCAG 2.5.8)
- [ ] Sign-in and step-up do not require a cognitive test (WCAG 3.3.8)

### Screen reader quick keys

**VoiceOver (macOS):** toggle Cmd + F5; navigate Control + Option + arrow keys; read all
Control + Option + A; rotor Control + Option + U.

**NVDA (Windows):** browse with arrow keys, focus mode with Tab; read all NVDA + Down Arrow; elements
list NVDA + F7.

**Scenarios:**

- Can a person understand the page structure from headings and landmarks?
- Are form labels clear and associated?
- Are errors and status changes announced?
- Can a person review the evidence and decide a gate without seeing the screen?

## Resources

**Tools:** axe DevTools (browser extension), Lighthouse (Chrome DevTools), Colour Contrast
Analyser, NVDA, VoiceOver.

**Guidelines:**

- WCAG 2.2 quick reference: https://www.w3.org/WAI/WCAG22/quickref/
- ARIA Authoring Practices Guide: https://www.w3.org/WAI/ARIA/apg/

Accessibility is a requirement from the first commit of a page, not a later pass.
