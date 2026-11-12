# React Best Practices - Complete Document

> Vendored from davila7/claude-code-templates@82b59de, path
> `cli-tool/components/skills/web-development/react-best-practices/references/react-performance-guidelines.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict. See `.claude/THIRD_PARTY.md`.
>
> This document is compiled from the rule files in `rules/` (the single source; edit those, not this).

**Version 0.1.0** (Vercel Engineering, January 2026), adapted for the AISDLC portal: a
client-rendered React 19 + Vite SPA served by the bff under a strict content security policy, with
TanStack Query as its data layer. Next.js, React Server Components and SSR material is removed.

---

## Abstract

A performance guide for React applications, for agents and people. It contains rules across 7
categories, prioritized by impact from critical (eliminating waterfalls, reducing bundle size) to
incremental (advanced patterns). Each rule compares incorrect and correct code. Profile before
optimizing; correctness and the rules in AGENTS.md come before any speed gain.

---

## Table of Contents

1. Eliminating Waterfalls — **CRITICAL**
   - 1.1 Defer Await Until Needed
   - 1.2 Dependency-Based Parallelization
   - 1.3 Prevent Waterfall Chains in Service Handlers
   - 1.4 Promise.all() for Independent Operations
   - 1.5 Strategic Loading Boundaries
2. Bundle Size Optimization — **CRITICAL**
   - 2.1 Avoid Costly Barrel File Imports
   - 2.2 Conditional Module Loading
   - 2.3 Lazy-Load Heavy Components
   - 2.4 Preload Based on User Intent
3. Client-Side Data Fetching — **MEDIUM-HIGH**
   - 3.1 Deduplicate Global Event Listeners
   - 3.2 Use TanStack Query for Automatic Deduplication
4. Re-render Optimization — **MEDIUM**
   - 4.1 Defer State Reads to Usage Point
   - 4.2 Extract to Memoized Components
   - 4.3 Narrow Effect Dependencies
   - 4.4 Subscribe to Derived State
   - 4.5 Use Lazy State Initialization
   - 4.6 Use Transitions for Non-Urgent Updates
5. Rendering Performance — **MEDIUM**
   - 5.1 Animate SVG Wrapper Instead of SVG Element
   - 5.2 CSS content-visibility for Long Lists
   - 5.3 Hoist Static JSX Elements
   - 5.4 Optimize SVG Precision
   - 5.5 Use Activity Component for Show/Hide
   - 5.6 Use Explicit Conditional Rendering
6. JavaScript Performance — **LOW-MEDIUM**
   - 6.1 Batch DOM CSS Changes
   - 6.2 Build Index Maps for Repeated Lookups
   - 6.3 Cache Property Access in Loops
   - 6.4 Cache Repeated Function Calls
   - 6.5 Cache Storage API Calls
   - 6.6 Combine Multiple Array Iterations
   - 6.7 Early Length Check for Array Comparisons
   - 6.8 Early Return from Functions
   - 6.9 Hoist RegExp Creation
   - 6.10 Use Loop for Min/Max Instead of Sort
   - 6.11 Use Set/Map for O(1) Lookups
   - 6.12 Use toSorted() Instead of sort() for Immutability
7. Advanced Patterns — **LOW**
   - 7.1 Store Event Handlers in Refs
   - 7.2 useLatest for Stable Callback Refs

---

## 1. Eliminating Waterfalls

**Impact: CRITICAL**

Waterfalls are the #1 performance killer. Each sequential await adds full network latency. Eliminating them yields the largest gains.

### 1.1 Defer Await Until Needed

**Impact: HIGH (avoids blocking unused code paths)**

Move `await` operations into the branches where they're actually used to avoid blocking code paths that don't need them.

**Incorrect (blocks both branches):**

```typescript
async function handleRequest(userId: string, skipProcessing: boolean) {
  const userData = await fetchUserData(userId);

  if (skipProcessing) {
    // Returns immediately but still waited for userData
    return { skipped: true };
  }

  // Only this branch uses userData
  return processUserData(userData);
}
```

**Correct (only blocks when needed):**

```typescript
async function handleRequest(userId: string, skipProcessing: boolean) {
  if (skipProcessing) {
    // Returns immediately without waiting
    return { skipped: true };
  }

  // Fetch only when needed
  const userData = await fetchUserData(userId);
  return processUserData(userData);
}
```

**Another example (early return optimization):**

```typescript
// Incorrect: always fetches permissions
async function updateResource(resourceId: string, userId: string) {
  const permissions = await fetchPermissions(userId);
  const resource = await getResource(resourceId);

  if (!resource) {
    return { error: 'Not found' };
  }

  if (!permissions.canEdit) {
    return { error: 'Forbidden' };
  }

  return await updateResourceData(resource, permissions);
}

// Correct: fetches only when needed
async function updateResource(resourceId: string, userId: string) {
  const resource = await getResource(resourceId);

  if (!resource) {
    return { error: 'Not found' };
  }

  const permissions = await fetchPermissions(userId);

  if (!permissions.canEdit) {
    return { error: 'Forbidden' };
  }

  return await updateResourceData(resource, permissions);
}
```

This optimization is especially valuable when the skipped branch is frequently taken, or when the deferred operation is expensive.

### 1.2 Dependency-Based Parallelization

**Impact: CRITICAL (2-10× improvement)**

For operations with partial dependencies, start every task as early as its inputs allow. Plain
promises are enough; no helper library is needed (and none may be added without an exact pin and
review).

**Incorrect (profile waits for config unnecessarily):**

```typescript
const [user, config] = await Promise.all([fetchUser(), fetchConfig()]);
const profile = await fetchProfile(user.id);
```

**Correct (config and profile run in parallel):**

```typescript
const userPromise = fetchUser();
const configPromise = fetchConfig();
const profilePromise = userPromise.then((user) => fetchProfile(user.id));

const [user, config, profile] = await Promise.all([userPromise, configPromise, profilePromise]);
```

Every promise is awaited by the `Promise.all`, so a rejection is never left unhandled.

### 1.3 Prevent Waterfall Chains in Service Handlers

**Impact: CRITICAL (2-10× improvement)**

In a bff or service route handler, start independent reads immediately, even if you don't await
them yet.

**Incorrect (config waits for the session, data waits for both):**

```typescript
app.get('/api/example', async (req) => {
  const session = await sessions.require(req);
  const config = await readConfig();
  const data = await readData(session.principal_id);
  return { data, config };
});
```

**Correct (session and config start immediately):**

```typescript
app.get('/api/example', async (req) => {
  const sessionPromise = sessions.require(req);
  const configPromise = readConfig();
  const session = await sessionPromise;
  const [config, data] = await Promise.all([configPromise, readData(session.principal_id)]);
  return { data, config };
});
```

Limits in this repo:

- Authorisation comes first. Never start a read whose answer depends on who is asking before the
  session and the PDP decision are known, and never return anything if either fails (fail closed).
- Inside a database transaction, statements on one client run in order anyway; do not parallelise
  them. A transaction that writes the record and the ledger follows the lock order in AGENTS.md.

### 1.4 Promise.all() for Independent Operations

**Impact: CRITICAL (2-10× improvement)**

When async operations have no interdependencies, execute them concurrently using `Promise.all()`.

**Incorrect (sequential execution, 3 round trips):**

```typescript
const user = await fetchUser();
const posts = await fetchPosts();
const comments = await fetchComments();
```

**Correct (parallel execution, 1 round trip):**

```typescript
const [user, posts, comments] = await Promise.all([fetchUser(), fetchPosts(), fetchComments()]);
```

### 1.5 Strategic Loading Boundaries

**Impact: HIGH (faster first paint of the page frame)**

The portal is a client-rendered SPA: there are no async components. Instead of one page-level
spinner that waits for every query, let each section own its query and its loading state (or a
`Suspense` boundary around a `React.lazy` component), so the page frame renders at once.

**Incorrect (the whole page waits for the slowest query):**

```tsx
function CardPage({ id }: { id: string }) {
  const card = useCard(id);
  const artefacts = useCardArtefacts(id);
  if (card.isPending || artefacts.isPending) return <Loading />;
  // ...
}
```

**Correct (the frame and the card render; the artefacts section loads on its own):**

```tsx
function CardPage({ id }: { id: string }) {
  const card = useCard(id);
  if (card.isPending) return <Loading />;
  if (card.isError) return <ErrorNote error={card.error} />;
  return (
    <>
      <CardSummary card={card.data} />
      <GateArtefacts id={id} /> {/* its own query, its own loading and error state */}
    </>
  );
}
```

**When NOT to split:**

- Data needed to decide what the page is at all (who may decide, whether the card exists)
- When the person must see everything before acting: a decide control stays disabled until every
  piece of evidence it binds has loaded and is intact. Never let a decision proceed on partial data.
- Small, fast queries where the extra loading state only adds layout shift

---

## 2. Bundle Size Optimization

**Impact: CRITICAL**

Reducing initial bundle size improves Time to Interactive and Largest Contentful Paint.

### 2.1 Avoid Costly Barrel File Imports

**Impact: CRITICAL (200-800ms import cost, slow builds)**

**Barrel files** are entry points that re-export many modules (an `index.js` that does
`export * from './module'`). Large icon and component libraries can have thousands of re-exports;
importing one name can cost hundreds of milliseconds in development and slow builds.

In this repo:

- The portal has no icon or component library today. Adding one is a new dependency: exact pin and
  review first, and then import from its per-module entry points where it offers them.
- The workspace packages export TypeScript source through `src/index.ts` (AGENTS.md). Keep importing
  them by package name (`import { TierValues } from '@aisdlc/contracts'`); do not deep-import
  another package's internal files. `@aisdlc/contracts` is `"sideEffects": false`, so Vite drops what
  the portal does not use. Import types with `import type` (lint enforces it).
- Inside `services/web`, import components from their own files (as the code already does), not
  through a local `index.ts` that re-exports a folder.

**Incorrect (a hypothetical icon library through its barrel):**

```tsx
import { Check, X, Menu } from 'some-icon-library';
// loads every icon module the library re-exports
```

**Correct (only what you need, when the library supports it):**

```tsx
import Check from 'some-icon-library/icons/check';
import X from 'some-icon-library/icons/x';
```

Check the size effect with `npm run build -w @aisdlc/web` before and after.

Reference: [How we optimized package imports in Next.js](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js)
(background on the cost; its Next.js config option does not apply here)

### 2.2 Conditional Module Loading

**Impact: CRITICAL (loads large data only when needed)**

Load large data or modules only when a feature is activated.

**Example (lazy-load animation frames):**

```tsx
function AnimationPlayer({ enabled }: { enabled: boolean }) {
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || frames !== null) return;
    let live = true;
    import('./animation-frames.js')
      .then((mod) => {
        if (live) setFrames(mod.frames);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [enabled, frames]);

  if (failed) return <ErrorNote error={new Error('could not load the animation')} />;
  if (!frames) return <Loading />;
  return <Canvas frames={frames} />;
}
```

Vite emits `import()` targets as separate chunks from the same origin, which the portal's content
security policy (`script-src 'self'`) allows. Never load a chunk from another origin.

### 2.3 Lazy-Load Heavy Components

**Impact: CRITICAL (directly affects TTI and LCP)**

Use `React.lazy` with `Suspense` to load large components that are not needed on first render
(for example a page only some roles open, or a large viewer).

**Incorrect (the viewer bundles with the main chunk):**

```tsx
import { DiffViewer } from './diff-viewer';

function ArtefactPanel({ text }: { text: string }) {
  return <DiffViewer value={text} />;
}
```

**Correct (the viewer loads on demand):**

```tsx
import { lazy, Suspense } from 'react';

const DiffViewer = lazy(() => import('./diff-viewer').then((m) => ({ default: m.DiffViewer })));

function ArtefactPanel({ text }: { text: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <DiffViewer value={text} />
    </Suspense>
  );
}
```

Give the boundary an error state too (an error boundary around it), so a chunk that fails to load
shows an error and never an empty panel.

### 2.4 Preload Based on User Intent

**Impact: CRITICAL (reduces perceived latency)**

Preload heavy chunks before they're needed to reduce perceived latency.

**Example (preload on hover/focus):**

```tsx
const loadViewer = () => import('./diff-viewer');

function ViewerButton({ onClick }: { onClick: () => void }) {
  const preload = () => {
    void loadViewer();
  };

  return (
    <button type="button" onMouseEnter={preload} onFocus={preload} onClick={onClick}>
      Open the diff
    </button>
  );
}
```

Build the lazy component from the same function
(`lazy(() => loadViewer().then((m) => ({ default: m.DiffViewer })))`) so the preload and the render
share one module request. Preload on `onFocus` as well as hover, so keyboard users get the same benefit.

---

## 3. Client-Side Data Fetching

**Impact: MEDIUM-HIGH**

Automatic deduplication and efficient data fetching patterns reduce redundant network requests.

### 3.1 Deduplicate Global Event Listeners

**Impact: MEDIUM-HIGH (single listener for N components)**

When many component instances need the same global event, register one listener at module level and
fan out to subscribers, instead of one listener per instance. No library is needed.

**Incorrect (N instances = N listeners):**

```tsx
function useKeyboardShortcut(key: string, callback: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === key) callback();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key, callback]);
}
```

**Correct (N instances = 1 listener):**

```tsx
// Module-level registry: one window listener while at least one callback is registered
const keyCallbacks = new Map<string, Set<() => void>>();

const onKeyDown = (e: KeyboardEvent) => {
  if (!e.metaKey) return;
  keyCallbacks.get(e.key)?.forEach((cb) => cb());
};

function register(key: string, cb: () => void): () => void {
  if (keyCallbacks.size === 0) window.addEventListener('keydown', onKeyDown);
  const set = keyCallbacks.get(key) ?? new Set<() => void>();
  set.add(cb);
  keyCallbacks.set(key, set);
  return () => {
    set.delete(cb);
    if (set.size === 0) keyCallbacks.delete(key);
    if (keyCallbacks.size === 0) window.removeEventListener('keydown', onKeyDown);
  };
}

function useKeyboardShortcut(key: string, callback: () => void) {
  useEffect(() => register(key, callback), [key, callback]);
}
```

For a global value that components read (online status, a media query), `useSyncExternalStore`
with a module-level `subscribe` gives the same one-listener behaviour and tear-free reads.

Keyboard shortcuts must not override the browser's or assistive technology's keys, and every
shortcut action must also be reachable through a visible control (see the accessibility-auditor skill).

### 3.2 Use TanStack Query for Automatic Deduplication

**Impact: MEDIUM-HIGH (automatic deduplication)**

The portal's data layer is TanStack Query (`@tanstack/react-query`, pinned). It deduplicates the
same query across component instances, caches it and revalidates it. Do not add a second fetching
library.

**Incorrect (no deduplication, each instance fetches, no error state):**

```tsx
function InboxCount() {
  const [inbox, setInbox] = useState<PortalInbox | null>(null);
  useEffect(() => {
    void api.inbox().then(setInbox);
  }, []);
  // ...
}
```

**Correct (every instance shares one request and one cache entry):**

```tsx
function InboxCount() {
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: api.inbox });
  // render inbox.isPending / inbox.isError / inbox.data
}
```

**For mutations:** `useMutation`, then invalidate the keys the write changed. See the
tanstack-query-expert skill for the repo's patterns (no optimistic updates for decisions).

---

## 4. Re-render Optimization

**Impact: MEDIUM**

Reducing unnecessary re-renders minimizes wasted computation and improves UI responsiveness.

### 4.1 Defer State Reads to Usage Point

**Impact: MEDIUM (avoids unnecessary subscriptions)**

Don't subscribe to dynamic state (the URL, storage) if you only read it inside callbacks.

**Incorrect (re-renders on every URL change, reads the value only on click):**

```tsx
function CopyLinkButton({ cardId }: { cardId: string }) {
  const search = useLocationSearch(); // a hook that re-renders on every URL change

  const handleCopy = () => {
    const ref = new URLSearchParams(search).get('ref');
    void copyCardLink(cardId, { ref });
  };

  return (
    <button type="button" onClick={handleCopy}>
      Copy link
    </button>
  );
}
```

**Correct (reads on demand, no subscription):**

```tsx
function CopyLinkButton({ cardId }: { cardId: string }) {
  const handleCopy = () => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    void copyCardLink(cardId, { ref });
  };

  return (
    <button type="button" onClick={handleCopy}>
      Copy link
    </button>
  );
}
```

URL values are untrusted input: validate them before use.

### 4.2 Extract to Memoized Components

**Impact: MEDIUM (enables early returns)**

Extract expensive work into memoized components to enable early returns before computation.

**Incorrect (computes avatar even when loading):**

```tsx
function Profile({ user, loading }: Props) {
  const avatar = useMemo(() => {
    const id = computeAvatarId(user);
    return <Avatar id={id} />;
  }, [user]);

  if (loading) return <Skeleton />;
  return <div>{avatar}</div>;
}
```

**Correct (skips computation when loading):**

```tsx
const UserAvatar = memo(function UserAvatar({ user }: { user: User }) {
  const id = useMemo(() => computeAvatarId(user), [user]);
  return <Avatar id={id} />;
});

function Profile({ user, loading }: Props) {
  if (loading) return <Skeleton />;
  return (
    <div>
      <UserAvatar user={user} />
    </div>
  );
}
```

The portal does not use the React Compiler, so `memo` and `useMemo` are still applied by hand. Measure
with the React DevTools Profiler before adding them.

### 4.3 Narrow Effect Dependencies

**Impact: MEDIUM (minimizes effect re-runs)**

Specify primitive dependencies instead of objects to minimize effect re-runs.

**Incorrect (re-runs on any user field change):**

```tsx
useEffect(() => {
  console.log(user.id);
}, [user]);
```

**Correct (re-runs only when id changes):**

```tsx
useEffect(() => {
  console.log(user.id);
}, [user.id]);
```

**For derived state, compute outside effect:**

```tsx
// Incorrect: runs on width=767, 766, 765...
useEffect(() => {
  if (width < 768) {
    enableMobileMode();
  }
}, [width]);

// Correct: runs only on boolean transition
const isMobile = width < 768;
useEffect(() => {
  if (isMobile) {
    enableMobileMode();
  }
}, [isMobile]);
```

### 4.4 Subscribe to Derived State

**Impact: MEDIUM (reduces re-render frequency)**

Subscribe to derived boolean state instead of continuous values to reduce re-render frequency.
(`useWindowWidth` and `useMediaQuery` below are illustrations, not hooks the portal has.)

**Incorrect (re-renders on every pixel change):**

```tsx
function Sidebar() {
  const width = useWindowWidth(); // updates continuously
  const isMobile = width < 768;
  return <nav className={isMobile ? 'mobile' : 'desktop'} />;
}
```

**Correct (re-renders only when the boolean changes):**

```tsx
function Sidebar() {
  const isMobile = useMediaQuery('(max-width: 767px)'); // matchMedia + useSyncExternalStore
  return <nav className={isMobile ? 'mobile' : 'desktop'} />;
}
```

Often plain CSS media queries in `styles.css` remove the need for either hook.

### 4.5 Use Lazy State Initialization

**Impact: MEDIUM (wasted computation on every render)**

Pass a function to `useState` for expensive initial values. Without the function form, the
initializer runs on every render even though the value is only used once.

**Incorrect (runs on every render):**

```tsx
function FilteredList({ items }: { items: readonly Item[] }) {
  // buildSearchIndex() runs on EVERY render, even after initialization
  const [searchIndex] = useState(buildSearchIndex(items));
  const [query, setQuery] = useState('');

  return <SearchResults index={searchIndex} query={query} onQuery={setQuery} />;
}
```

**Correct (runs only once):**

```tsx
function FilteredList({ items }: { items: readonly Item[] }) {
  // buildSearchIndex() runs ONLY on initial render
  const [searchIndex] = useState(() => buildSearchIndex(items));
  const [query, setQuery] = useState('');

  return <SearchResults index={searchIndex} query={query} onQuery={setQuery} />;
}
```

**Reading stored preferences:** parse to `unknown` and validate; never trust the stored shape, and
never keep a credential, token or session data in web storage (the session is an HttpOnly cookie).

```tsx
type Prefs = { readonly compact: boolean };
const DEFAULT_PREFS: Prefs = { compact: false };

function readPrefs(): Prefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('prefs') ?? 'null');
    return typeof raw === 'object' &&
      raw !== null &&
      'compact' in raw &&
      typeof raw.compact === 'boolean'
      ? { compact: raw.compact }
      : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function PrefsPanel() {
  const [prefs, setPrefs] = useState(readPrefs); // the function itself, called once
  return <PrefsForm prefs={prefs} onChange={setPrefs} />;
}
```

Use lazy initialization when computing initial values from storage, building data structures
(indexes, maps), reading from the DOM, or performing heavy transformations.

For simple primitives (`useState(0)`), direct references (`useState(props.value)`), or cheap
literals (`useState({})`), the function form is unnecessary.

### 4.6 Use Transitions for Non-Urgent Updates

**Impact: MEDIUM (maintains UI responsiveness)**

Mark frequent, non-urgent state updates as transitions to maintain UI responsiveness.

**Incorrect (blocks UI on every scroll):**

```tsx
function ScrollTracker() {
  const [scrollY, setScrollY] = useState(0);
  useEffect(() => {
    const handler = () => setScrollY(window.scrollY);
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);
}
```

**Correct (non-blocking updates):**

```tsx
import { startTransition } from 'react';

function ScrollTracker() {
  const [scrollY, setScrollY] = useState(0);
  useEffect(() => {
    const handler = () => {
      startTransition(() => setScrollY(window.scrollY));
    };
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);
}
```

---

## 5. Rendering Performance

**Impact: MEDIUM**

Optimizing the rendering process reduces the work the browser needs to do.

### 5.1 Animate SVG Wrapper Instead of SVG Element

**Impact: MEDIUM (enables hardware acceleration)**

Many browsers don't have hardware acceleration for CSS3 animations on SVG elements. Wrap SVG in a `<div>` and animate the wrapper instead.

**Incorrect (animating SVG directly - no hardware acceleration):**

```tsx
function LoadingSpinner() {
  return (
    <svg className="animate-spin" width="24" height="24" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="10" stroke="currentColor" />
    </svg>
  );
}
```

**Correct (animating wrapper div - hardware accelerated):**

```tsx
function LoadingSpinner() {
  return (
    <div className="animate-spin">
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" stroke="currentColor" />
      </svg>
    </div>
  );
}
```

This applies to all CSS transforms and transitions (`transform`, `opacity`, `translate`, `scale`, `rotate`). The wrapper div allows browsers to use GPU acceleration for smoother animations.

### 5.2 CSS content-visibility for Long Lists

**Impact: MEDIUM (10× faster initial render)**

Apply `content-visibility: auto` to defer off-screen rendering (for example a long ledger page).

**CSS (in `styles.css`; the content security policy allows only same-origin stylesheets):**

```css
.ledger-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 80px;
}
```

**Example:**

```tsx
function LedgerList({ rows }: { rows: readonly Row[] }) {
  return (
    <ol className="ledger-list">
      {rows.map((row) => (
        <li key={row.id} className="ledger-row">
          <LedgerEntry row={row} />
        </li>
      ))}
    </ol>
  );
}
```

For 1000 rows, the browser skips layout and paint for the off-screen ones. Content stays in the DOM,
so find-in-page and screen readers still reach it.

### 5.3 Hoist Static JSX Elements

**Impact: MEDIUM (avoids re-creation)**

Extract static JSX outside components to avoid re-creation.

**Incorrect (recreates element every render):**

```tsx
function LoadingSkeleton() {
  return <div className="animate-pulse h-20 bg-gray-200" />;
}

function Container() {
  return <div>{loading && <LoadingSkeleton />}</div>;
}
```

**Correct (reuses same element):**

```tsx
const loadingSkeleton = <div className="animate-pulse h-20 bg-gray-200" />;

function Container() {
  return <div>{loading && loadingSkeleton}</div>;
}
```

This is especially helpful for large and static SVG nodes, which can be expensive to recreate on every render.

### 5.4 Optimize SVG Precision

**Impact: MEDIUM (reduces file size)**

Reduce SVG coordinate precision to decrease file size. The optimal precision depends on the
viewBox size, but in general reducing precision should be considered.

**Incorrect (excessive precision):**

```svg
<path d="M 10.293847 20.847362 L 30.938472 40.192837" />
```

**Correct (1 decimal place):**

```svg
<path d="M 10.3 20.8 L 30.9 40.2" />
```

**Automate with SVGO** (not a dependency of this repo; run the pinned version on demand and commit
only the optimised file):

```bash
npx svgo@4.1.0 --precision=1 --multipass icon.svg
```

### 5.5 Use Activity Component for Show/Hide

**Impact: MEDIUM (preserves state/DOM)**

Use React's `<Activity>` to preserve state/DOM for expensive components that frequently toggle visibility.

**Usage:**

```tsx
import { Activity } from 'react';

function Dropdown({ isOpen }: Props) {
  return (
    <Activity mode={isOpen ? 'visible' : 'hidden'}>
      <ExpensiveMenu />
    </Activity>
  );
}
```

Avoids expensive re-renders and state loss.

`<Activity>` is stable from React 19.2 (the portal pins 19.3.1). Hidden content keeps its state but its
effects are cleaned up; content that must not stay in the DOM when hidden (for example a decide
control a person may no longer use) should be unmounted instead.

### 5.6 Use Explicit Conditional Rendering

**Impact: MEDIUM (prevents rendering 0 or NaN)**

Use explicit ternary operators (`? :`) instead of `&&` for conditional rendering when the condition can be `0`, `NaN`, or other falsy values that render.

**Incorrect (renders "0" when count is 0):**

```tsx
function Badge({ count }: { count: number }) {
  return <div>{count && <span className="badge">{count}</span>}</div>;
}

// When count = 0, renders: <div>0</div>
// When count = 5, renders: <div><span class="badge">5</span></div>
```

**Correct (renders nothing when count is 0):**

```tsx
function Badge({ count }: { count: number }) {
  return <div>{count > 0 ? <span className="badge">{count}</span> : null}</div>;
}

// When count = 0, renders: <div></div>
// When count = 5, renders: <div><span class="badge">5</span></div>
```

---

## 6. JavaScript Performance

**Impact: LOW-MEDIUM**

Micro-optimizations for hot paths can add up to meaningful improvements.

### 6.1 Batch DOM CSS Changes

**Impact: MEDIUM (reduces reflows/repaints)**

Avoid changing styles one property at a time. Group multiple CSS changes together via classes or `cssText` to minimize browser reflows.

**Incorrect (multiple reflows):**

```typescript
function updateElementStyles(element: HTMLElement) {
  // Each line triggers a reflow
  element.style.width = '100px';
  element.style.height = '200px';
  element.style.backgroundColor = 'blue';
  element.style.border = '1px solid black';
}
```

**Correct (add class - single reflow):**

```typescript
// styles.css
.highlighted-box {
  width: 100px;
  height: 200px;
  background-color: blue;
  border: 1px solid black;
}

// JavaScript
function updateElementStyles(element: HTMLElement) {
  element.classList.add('highlighted-box')
}
```

**Correct (change cssText - single reflow):**

```typescript
function updateElementStyles(element: HTMLElement) {
  element.style.cssText = `
    width: 100px;
    height: 200px;
    background-color: blue;
    border: 1px solid black;
  `;
}
```

**React example:**

```tsx
// Incorrect: changing styles one by one
function Box({ isHighlighted }: { isHighlighted: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current && isHighlighted) {
      ref.current.style.width = '100px';
      ref.current.style.height = '200px';
      ref.current.style.backgroundColor = 'blue';
    }
  }, [isHighlighted]);

  return <div ref={ref}>Content</div>;
}

// Correct: toggle class
function Box({ isHighlighted }: { isHighlighted: boolean }) {
  return <div className={isHighlighted ? 'highlighted-box' : ''}>Content</div>;
}
```

Prefer CSS classes (in `styles.css`) over inline styles. Classes are cached by the browser and
provide better separation of concerns, and the portal's content security policy (`style-src 'self'`)
blocks `style` attributes in served HTML and injected `<style>` elements; setting `element.style` from
script still works, but a class is the default.

### 6.2 Build Index Maps for Repeated Lookups

**Impact: LOW-MEDIUM (1M ops to 2K ops)**

Multiple `.find()` calls by the same key should use a Map.

**Incorrect (O(n) per lookup):**

```typescript
function processOrders(orders: Order[], users: User[]) {
  return orders.map((order) => ({
    ...order,
    user: users.find((u) => u.id === order.userId),
  }));
}
```

**Correct (O(1) per lookup):**

```typescript
function processOrders(orders: Order[], users: User[]) {
  const userById = new Map(users.map((u) => [u.id, u]));

  return orders.map((order) => ({
    ...order,
    user: userById.get(order.userId),
  }));
}
```

Build map once (O(n)), then all lookups are O(1).
For 1000 orders × 1000 users: 1M ops → 2K ops.

### 6.3 Cache Property Access in Loops

**Impact: LOW-MEDIUM (reduces lookups)**

Cache object property lookups in hot paths.

**Incorrect (3 lookups × N iterations):**

```typescript
for (let i = 0; i < arr.length; i++) {
  process(obj.config.settings.value);
}
```

**Correct (1 lookup total):**

```typescript
const value = obj.config.settings.value;
const len = arr.length;
for (let i = 0; i < len; i++) {
  process(value);
}
```

### 6.4 Cache Repeated Function Calls

**Impact: MEDIUM-HIGH (avoid redundant computation)**

Use a module-level Map to cache the results of a pure function that is called repeatedly with the
same inputs during render.

**Incorrect (redundant computation):**

```tsx
function ProjectList({ projects }: { projects: readonly Project[] }) {
  return (
    <div>
      {projects.map((project) => {
        // slugify() called 100+ times for the same project names
        const slug = slugify(project.name);
        return <ProjectCard key={project.id} slug={slug} />;
      })}
    </div>
  );
}
```

**Correct (cached results):**

```tsx
// Module-level cache
const slugifyCache = new Map<string, string>();

function cachedSlugify(text: string): string {
  const hit = slugifyCache.get(text);
  if (hit !== undefined) return hit;
  const result = slugify(text);
  slugifyCache.set(text, result);
  return result;
}

function ProjectList({ projects }: { projects: readonly Project[] }) {
  return (
    <div>
      {projects.map((project) => (
        // Computed only once per unique project name
        <ProjectCard key={project.id} slug={cachedSlugify(project.name)} />
      ))}
    </div>
  );
}
```

Use a Map (not a hook) so it works everywhere: utilities, event handlers, not just components.

Only cache pure functions of their arguments. Never cache who the person is or what they may do:
that comes from `GET /api/me` and the PDP through TanStack Query, which revalidates it; a module-level
cache of it would outlive a logout or a role change. A cache that can grow without bound (keys from
user input) needs a size limit.

Reference: [How we made the Vercel Dashboard twice as fast](https://vercel.com/blog/how-we-made-the-vercel-dashboard-twice-as-fast)

### 6.5 Cache Storage API Calls

**Impact: LOW-MEDIUM (reduces expensive I/O)**

`localStorage` and `sessionStorage` are synchronous. When a hot path reads the same key repeatedly,
cache reads in memory.

**Incorrect (reads storage on every call):**

```typescript
function getDensity() {
  return localStorage.getItem('density') ?? 'comfortable';
}
// Called 10 times = 10 storage reads
```

**Correct (Map cache):**

```typescript
const storageCache = new Map<string, string | null>();

function getLocalStorage(key: string): string | null {
  if (!storageCache.has(key)) storageCache.set(key, localStorage.getItem(key));
  return storageCache.get(key) ?? null;
}

function setLocalStorage(key: string, value: string) {
  localStorage.setItem(key, value);
  storageCache.set(key, value); // keep cache in sync
}
```

Use a Map (not a hook) so it works everywhere: utilities, event handlers, not just components.

**Important:** if storage can change externally (another tab), invalidate the cache:

```typescript
window.addEventListener('storage', (e) => {
  if (e.key) storageCache.delete(e.key);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') storageCache.clear();
});
```

In this repo web storage holds per-browser conveniences only (a layout preference). Never store a
credential, token, CSRF value, session data or anything the server decides; the session is an
HttpOnly cookie that script cannot and must not read.

### 6.6 Combine Multiple Array Iterations

**Impact: LOW-MEDIUM (reduces iterations)**

Multiple `.filter()` or `.map()` calls iterate the array multiple times. Combine into one loop.

**Incorrect (3 iterations):**

```typescript
const admins = users.filter((u) => u.isAdmin);
const testers = users.filter((u) => u.isTester);
const inactive = users.filter((u) => !u.isActive);
```

**Correct (1 iteration):**

```typescript
const admins: User[] = [];
const testers: User[] = [];
const inactive: User[] = [];

for (const user of users) {
  if (user.isAdmin) admins.push(user);
  if (user.isTester) testers.push(user);
  if (!user.isActive) inactive.push(user);
}
```

### 6.7 Early Length Check for Array Comparisons

**Impact: HIGH (avoids expensive operations when lengths differ)**

When comparing arrays with expensive operations (sorting, deep equality, serialization), check lengths first. If lengths differ, the arrays cannot be equal.

In real-world applications, this optimization is especially valuable when the comparison runs in hot paths (event handlers, render loops).

**Incorrect (always runs expensive comparison):**

```typescript
function hasChanges(current: string[], original: string[]) {
  // Always sorts and joins, even when lengths differ
  return current.sort().join() !== original.sort().join();
}
```

Two O(n log n) sorts run even when `current.length` is 5 and `original.length` is 100. There is also overhead of joining the arrays and comparing the strings.

**Correct (O(1) length check first):**

```typescript
function hasChanges(current: string[], original: string[]) {
  // Early return if lengths differ
  if (current.length !== original.length) {
    return true;
  }
  // Only sort/join when lengths match
  const currentSorted = current.toSorted();
  const originalSorted = original.toSorted();
  for (let i = 0; i < currentSorted.length; i++) {
    if (currentSorted[i] !== originalSorted[i]) {
      return true;
    }
  }
  return false;
}
```

This new approach is more efficient because:

- It avoids the overhead of sorting and joining the arrays when lengths differ
- It avoids consuming memory for the joined strings (especially important for large arrays)
- It avoids mutating the original arrays
- It returns early when a difference is found

### 6.8 Early Return from Functions

**Impact: LOW-MEDIUM (avoids unnecessary computation)**

Return early when result is determined to skip unnecessary processing.

**Incorrect (processes all items even after finding answer):**

```typescript
function validateUsers(users: User[]) {
  let hasError = false;
  let errorMessage = '';

  for (const user of users) {
    if (!user.email) {
      hasError = true;
      errorMessage = 'Email required';
    }
    if (!user.name) {
      hasError = true;
      errorMessage = 'Name required';
    }
    // Continues checking all users even after error found
  }

  return hasError ? { valid: false, error: errorMessage } : { valid: true };
}
```

**Correct (returns immediately on first error):**

```typescript
function validateUsers(users: User[]) {
  for (const user of users) {
    if (!user.email) {
      return { valid: false, error: 'Email required' };
    }
    if (!user.name) {
      return { valid: false, error: 'Name required' };
    }
  }

  return { valid: true };
}
```

### 6.9 Hoist RegExp Creation

**Impact: LOW-MEDIUM (avoids recreation)**

Don't create a RegExp inside render. Hoist a constant pattern to module scope, or memoize one built
from input with `useMemo()`.

**Incorrect (new RegExp every render, and the query is used unescaped):**

```tsx
function Highlighter({ text, query }: { text: string; query: string }) {
  const regex = new RegExp(`(${query})`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) => (
        <Part key={i} text={part} />
      ))}
    </>
  );
}
```

**Correct (hoist constants, memoize and escape input-built patterns):**

```tsx
const SHA256_HEX = /^[0-9a-f]{64}$/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function Highlighter({ text, query }: { text: string; query: string }) {
  const regex = useMemo(() => new RegExp(`(${escapeRegExp(query)})`, 'gi'), [query]);
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) => (
        <Part key={i} text={part} />
      ))}
    </>
  );
}
```

Escaping matters beyond speed: an unescaped query is an injected pattern (and can be a slow one).

**Warning:** a global regex (`/g`) has mutable `lastIndex` state:

```typescript
const regex = /foo/g;
regex.test('foo'); // true, lastIndex = 3
regex.test('foo'); // false, lastIndex = 0
```

### 6.10 Use Loop for Min/Max Instead of Sort

**Impact: LOW (O(n) instead of O(n log n))**

Finding the smallest or largest element only requires a single pass through the array. Sorting is
wasteful and slower.

**Incorrect (O(n log n) - sort to find latest):**

```typescript
interface Project {
  id: string;
  name: string;
  updatedAt: number;
}

function getLatestProject(projects: readonly Project[]) {
  const sorted = projects.toSorted((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0];
}
```

Sorts the entire array just to find the maximum value.

**Correct (O(n) - single loop, strict-safe):**

With `noUncheckedIndexedAccess`, `projects[0]` is `Project | undefined`; iterate with `for...of`
instead of indexing, and return `null` for an empty array.

```typescript
function getLatestProject(projects: readonly Project[]): Project | null {
  let latest: Project | null = null;
  for (const p of projects) {
    if (latest === null || p.updatedAt > latest.updatedAt) latest = p;
  }
  return latest;
}

function getOldestAndNewest(projects: readonly Project[]): {
  oldest: Project | null;
  newest: Project | null;
} {
  let oldest: Project | null = null;
  let newest: Project | null = null;
  for (const p of projects) {
    if (oldest === null || p.updatedAt < oldest.updatedAt) oldest = p;
    if (newest === null || p.updatedAt > newest.updatedAt) newest = p;
  }
  return { oldest, newest };
}
```

Single pass through the array, no copying, no sorting.

**Alternative (Math.min/Math.max for small arrays):**

```typescript
const numbers = [5, 2, 8, 1, 9];
const min = Math.min(...numbers);
const max = Math.max(...numbers);
```

This works for small arrays but can fail for very large ones (argument count limits); use the loop
for reliability. Note `Math.min()` of an empty array is `Infinity`.

### 6.11 Use Set/Map for O(1) Lookups

**Impact: LOW-MEDIUM (O(n) to O(1))**

Convert arrays to Set/Map for repeated membership checks.

**Incorrect (O(n) per check):**

```typescript
const allowedIds: readonly string[] = loadAllowedIds();
const visible = items.filter((item) => allowedIds.includes(item.id));
```

**Correct (O(1) per check):**

```typescript
const allowedIds: ReadonlySet<string> = new Set(loadAllowedIds());
const visible = items.filter((item) => allowedIds.has(item.id));
```

This is a speed rule only: in the portal, what a person may see or do is decided by the server (the
PDP), never by a client-side allow list.

### 6.12 Use toSorted() Instead of sort() for Immutability

**Impact: MEDIUM (prevents mutation bugs in React state)**

`.sort()` mutates the array in place, which can cause bugs with React state and props. Use `.toSorted()` to create a new sorted array without mutation.

**Incorrect (mutates original array):**

```typescript
function UserList({ users }: { users: User[] }) {
  // Mutates the users prop array!
  const sorted = useMemo(
    () => users.sort((a, b) => a.name.localeCompare(b.name)),
    [users]
  )
  return <div>{sorted.map(renderUser)}</div>
}
```

**Correct (creates new array):**

```typescript
function UserList({ users }: { users: User[] }) {
  // Creates new sorted array, original unchanged
  const sorted = useMemo(
    () => users.toSorted((a, b) => a.name.localeCompare(b.name)),
    [users]
  )
  return <div>{sorted.map(renderUser)}</div>
}
```

**Why this matters in React:**

1. **Props/state mutations break React's immutability model** - React expects props and state to be treated as read-only
2. **Causes stale closure bugs** - Mutating arrays inside closures (callbacks, effects) can lead to unexpected behavior

**Browser support:**

`.toSorted()` is available in all modern browsers (Chrome 110+, Safari 16+, Firefox 115+, Node.js 20+). For older environments, use spread operator:

```typescript
// Fallback for older browsers
const sorted = [...items].sort((a, b) => a.value - b.value);
```

**Other immutable array methods:**

- `.toSorted()` - immutable sort
- `.toReversed()` - immutable reverse
- `.toSpliced()` - immutable splice
- `.with()` - immutable element replacement

---

## 7. Advanced Patterns

**Impact: LOW**

Advanced patterns for specific cases that require careful implementation.

### 7.1 Store Event Handlers in Refs

**Impact: LOW (stable subscriptions)**

Store callbacks in refs when used in effects that shouldn't re-subscribe on callback changes.

**Incorrect (re-subscribes on every render):**

```tsx
function useWindowEvent(event: string, handler: () => void) {
  useEffect(() => {
    window.addEventListener(event, handler);
    return () => window.removeEventListener(event, handler);
  }, [event, handler]);
}
```

**Correct (stable subscription):**

```tsx
function useWindowEvent(event: string, handler: () => void) {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const listener = () => handlerRef.current();
    window.addEventListener(event, listener);
    return () => window.removeEventListener(event, listener);
  }, [event]);
}
```

React 19.2 and later (the portal pins `react` 19.3.1) also offer `useEffectEvent` for the same
purpose: a function that always sees the latest props and state and is not an effect dependency.

### 7.2 useLatest for Stable Callback Refs

**Impact: LOW (prevents effect re-runs)**

Access latest values in callbacks without adding them to dependency arrays. Prevents effect re-runs while avoiding stale closures.

**Implementation:**

```typescript
function useLatest<T>(value: T) {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
```

**Incorrect (effect re-runs on every callback change):**

```tsx
function SearchInput({ onSearch }: { onSearch: (q: string) => void }) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    const timeout = setTimeout(() => onSearch(query), 300);
    return () => clearTimeout(timeout);
  }, [query, onSearch]);
}
```

**Correct (stable effect, fresh callback):**

```tsx
function SearchInput({ onSearch }: { onSearch: (q: string) => void }) {
  const [query, setQuery] = useState('');
  const onSearchRef = useLatest(onSearch);

  useEffect(() => {
    const timeout = setTimeout(() => onSearchRef.current(query), 300);
    return () => clearTimeout(timeout);
  }, [query]);
}
```

---

## References

1. [https://react.dev](https://react.dev)
2. [https://tanstack.com/query/v5](https://tanstack.com/query/v5)
3. [https://vite.dev](https://vite.dev)
4. [https://vercel.com/blog/how-we-optimized-package-imports-in-next-js](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js)
5. [https://vercel.com/blog/how-we-made-the-vercel-dashboard-twice-as-fast](https://vercel.com/blog/how-we-made-the-vercel-dashboard-twice-as-fast)
