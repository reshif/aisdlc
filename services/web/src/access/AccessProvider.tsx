import {
  DECISION_BATCH_MAX,
  type ActionId,
  type DecisionAnswer,
  type DecisionQuery,
  type MyAccessView,
  type PdpResource,
} from '@aisdlc/contracts';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react';
import { api, type Me } from '../api';
import { Link } from '../router';
import { LockedButton } from '../ui';
import { reasonText } from './reasons';

// The client side of access (portal-coverage §6 step 2). It ASKS the server and only ever uses the
// answer to hide a link or lock a button: it grants nothing, and every write is decided by the PDP
// on the server whatever this says. Unknown, pending or failed reads as "not allowed".
//
//   <AccessProvider me>               owns the CSRF token and a batcher for /api/me/decisions
//   useAccess()                       GET /api/me/access (bindings, view level, data class)
//   useCan(action, resource)          one PDP answer, batched with the others asked in the same tick
//   <Guarded action resource>         the children when allowed; else nothing or a LockedButton

type Send = (queries: readonly DecisionQuery[]) => Promise<readonly DecisionAnswer[]>;

/** Collects the questions of one render pass and asks them in batches of at most DECISION_BATCH_MAX. */
export class DecisionBatcher {
  private queue: Array<{
    q: DecisionQuery;
    resolve: (a: DecisionAnswer) => void;
    reject: (e: unknown) => void;
  }> = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly send: Send) {}

  load(q: DecisionQuery): Promise<DecisionAnswer> {
    return new Promise((resolve, reject) => {
      this.queue.push({ q, resolve, reject });
      this.timer ??= setTimeout(() => void this.flush(), 0);
    });
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const all = this.queue;
    this.queue = [];
    for (let i = 0; i < all.length; i += DECISION_BATCH_MAX) {
      const chunk = all.slice(i, i + DECISION_BATCH_MAX);
      try {
        const answers = await this.send(chunk.map((c) => c.q));
        chunk.forEach((c, k) => {
          const a = answers[k];
          // An answer that is missing or about something else is a deny, never a guess.
          if (a && a.action === c.q.action && sameResource(a.resource, c.q.resource)) c.resolve(a);
          else c.resolve({ ...c.q, allow: false, reasons: ['unavailable'] });
        });
      } catch (e) {
        for (const c of chunk) c.reject(e);
      }
    }
  }
}

export const resourceKey = (r: PdpResource): string =>
  JSON.stringify([r.type, r.id, r.project, r.lane, r.item, r.gate_id]);
const sameResource = (a: PdpResource, b: PdpResource) => resourceKey(a) === resourceKey(b);

interface AccessContextValue {
  readonly me: Me;
  readonly batcher: DecisionBatcher;
}
const AccessContext = createContext<AccessContextValue | null>(null);

export function AccessProvider({ me, children }: { me: Me; children: ReactNode }) {
  const csrf = useRef(me.csrf_token);
  csrf.current = me.csrf_token;
  const batcher = useMemo(
    () =>
      new DecisionBatcher(
        async (queries) => (await api.decisions(queries, csrf.current)).decisions,
      ),
    [],
  );
  const value = useMemo(() => ({ me, batcher }), [me, batcher]);
  return <AccessContext.Provider value={value}>{children}</AccessContext.Provider>;
}

function useAccessContext(): AccessContextValue {
  const c = useContext(AccessContext);
  if (!c) throw new Error('useCan and useAccess need an <AccessProvider>');
  return c;
}

/** The signed-in person as `/api/me` told it (the per-project actions in it are hints, like every answer here). */
export function useMe(): Me {
  return useAccessContext().me;
}

/** GET /api/me/access for the signed-in person. */
export function useAccess(): UseQueryResult<MyAccessView> {
  const { me } = useAccessContext();
  return useQuery({
    queryKey: ['access', me.principal.principal_id],
    queryFn: () => api.myAccess(),
    staleTime: 30_000,
  });
}

export type Can =
  | { readonly state: 'pending' }
  | { readonly state: 'allow'; readonly reasons: readonly string[] }
  | { readonly state: 'deny'; readonly reasons: readonly string[] };

/** The PDP's answer for this person; `pending` until it arrives, `deny` if asking failed. */
export function useCan(action: ActionId, resource: PdpResource): Can {
  const { me, batcher } = useAccessContext();
  const q = useQuery({
    queryKey: ['can', me.principal.principal_id, action, resourceKey(resource)],
    queryFn: () => batcher.load({ action, resource }),
    staleTime: 30_000,
    retry: false,
  });
  if (q.isPending) return { state: 'pending' };
  if (q.isError) return { state: 'deny', reasons: ['unavailable'] };
  return q.data.allow
    ? { state: 'allow', reasons: q.data.reasons }
    : { state: 'deny', reasons: q.data.reasons };
}

/** Where a person asks for the access an action needs (the My access page, with the action named). */
export function requestAccessHref(action: ActionId, resource: PdpResource): string {
  const qs = new URLSearchParams({ want: action });
  const project = resource.type === 'Project' ? resource.id : resource.project;
  if (project !== null) qs.set('project', project);
  if (resource.gate_id !== null) qs.set('gate', resource.gate_id);
  return `/me/access?${qs}`;
}

/**
 * Shows `children` when the PDP allows `action` on `resource`. Otherwise `mode="hide"` shows
 * `fallback` (nothing by default) and `mode="lock"` a LockedButton named `label` with the PDP's
 * reason and a "Request access" link. While the answer is pending nothing actionable is shown.
 */
export function Guarded({
  action,
  resource,
  mode = 'lock',
  label,
  fallback = null,
  children,
}: {
  action: ActionId;
  resource: PdpResource;
  mode?: 'hide' | 'lock';
  /** The locked button's text (mode="lock"). */
  label?: string;
  fallback?: ReactNode;
  children: ReactNode;
}) {
  const can = useCan(action, resource);
  if (can.state === 'allow') return <>{children}</>;
  if (mode === 'hide') return <>{fallback}</>;
  if (can.state === 'pending') {
    return (
      <button type="button" className="ui-btn" disabled aria-busy="true">
        {label ?? action}
      </button>
    );
  }
  return (
    <LockedButton
      label={label ?? action}
      reason={reasonText(action, can.reasons)}
      request={
        can.reasons[0] === 'not_visible' ? null : (
          <Link to={requestAccessHref(action, resource)}>Request access</Link>
        )
      }
    />
  );
}
