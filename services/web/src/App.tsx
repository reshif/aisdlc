import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { ApiError, api, type Me } from './api';
import { ErrorNote, Loading } from './components/Notice';
import { CardPage } from './pages/CardPage';
import { OnboardPage } from './pages/Onboard';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { ProjectListPage } from './pages/ProjectList';
import { S0Page } from './pages/S0Page';
import { Link, NavContext, useRoute, type Route } from './router';

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        // A refusal (4xx) will not change by asking again; a network or server failure may.
        retry: (count, e) =>
          !(e instanceof ApiError && e.status >= 400 && e.status < 500) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 1000,
      },
    },
  });
}

export function App({ client }: { client?: QueryClient }) {
  const [qc] = useState(() => client ?? createQueryClient());
  return (
    <QueryClientProvider client={qc}>
      <Portal />
    </QueryClientProvider>
  );
}

/** The signed-in person, or `null` when the bff says there is no session. */
function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    refetchInterval: 60_000,
  });
}

function Portal() {
  const { route, navigate } = useRoute();
  const me = useMe();
  const mainRef = useRef<HTMLElement>(null);

  // After a navigation the focus goes to the page, so a keyboard or screen reader user starts at its top.
  const here = JSON.stringify(route);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [here]);

  return (
    <NavContext.Provider value={navigate}>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="top">
        <div className="top-inner">
          <Link to="/" className="brand">
            AISDLC Factory
          </Link>
          {me.data ? (
            <nav aria-label="Main">
              <Link to="/">Projects</Link>
              {me.data.actions.fleet.includes('project.onboard') ? (
                <Link to="/onboard">Onboard a repo</Link>
              ) : null}
            </nav>
          ) : null}
          <div className="who">{me.data ? <Account me={me.data} /> : null}</div>
        </div>
      </header>
      <main id="main" tabIndex={-1} ref={mainRef}>
        {me.isPending ? <Loading what="your session" /> : null}
        {me.isError ? <ErrorNote error={me.error} retry={() => void me.refetch()} /> : null}
        {me.data === null ? <SignedOut /> : null}
        {me.data ? <Page route={route} me={me.data} /> : null}
      </main>
    </NavContext.Provider>
  );
}

function SignedOut() {
  return (
    <section aria-labelledby="signin-h">
      <h1 id="signin-h">Sign in</h1>
      <p>
        The factory takes work through a governed lifecycle, and people decide the gates. Sign in to
        see your projects and cards.
      </p>
      {/* A plain link: the bff starts the sign-in and sends the browser to the identity provider. */}
      <a className="btn" href="/auth/login">
        Sign in
      </a>
    </section>
  );
}

function Account({ me }: { me: Me }) {
  const qc = useQueryClient();
  const out = useMutation({
    mutationFn: () => api.logout(me.csrf_token),
    // The session is gone on the server: forget everything it let us read. Whatever happened, the next
    // question is "who am I", and the bff answers 401 once the session has ended.
    onSuccess: () => {
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      qc.setQueryData(['me'], null);
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['me'] }),
  });
  return (
    <>
      <span className="who-name" title={me.principal.principal_id}>
        {me.principal.display_name}
      </span>
      <button
        type="button"
        className="btn btn-quiet"
        onClick={() => out.mutate()}
        disabled={out.isPending}
      >
        Sign out
      </button>
    </>
  );
}

function Page({ route, me }: { route: Route; me: Me }) {
  const mayOnboard = me.actions.fleet.includes('project.onboard');
  switch (route.name) {
    case 'home':
      return <ProjectListPage canOnboard={mayOnboard} />;
    case 'onboard':
      return <OnboardPage csrf={me.csrf_token} mayOnboard={mayOnboard} />;
    case 'project':
      return <ProjectDetailPage id={route.id} />;
    case 's0':
      return <S0Page id={route.id} />;
    case 'card':
      return <CardPage id={route.id} />;
    case 'notfound':
      return (
        <>
          <h1>Page not found</h1>
          <p>
            <Link to="/">Back to projects</Link>
          </p>
        </>
      );
  }
}
