import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { AccessProvider } from './access';
import { ApiError, api, type Me } from './api';
import { ErrorNote, Loading } from './components/Notice';
import { CardPage } from './pages/CardPage';
import { InboxPage } from './pages/InboxPage';
import { ItemPage } from './pages/ItemPage';
import { PackPage } from './pages/PackPage';
import { LedgerPage } from './pages/LedgerPage';
import { PrrPage } from './pages/PrrPage';
import { RevisionPage } from './pages/RevisionPage';
import { OnboardPage } from './pages/Onboard';
import { ProjectDetailPage } from './pages/ProjectDetail';
import { ProjectListPage } from './pages/ProjectList';
import { S0Page } from './pages/S0Page';
import { ConfigKeyPage, ConfigListPage } from './pages/ConfigPages';
import { MyAccessPage } from './pages/MyAccessPage';
import { Link, NavContext, useRoute, type Route } from './router';
import { Shell } from './shell/Shell';
import { ErrorState, PageHead, ToastProvider } from './ui';

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
  return (
    <NavContext.Provider value={navigate}>
      <ToastProvider>
        <Shell me={me.data ?? null} route={route}>
          {me.isPending ? <Loading what="your session" /> : null}
          {me.isError ? <ErrorNote error={me.error} retry={() => void me.refetch()} /> : null}
          {me.data === null ? <SignedOut /> : null}
          {me.data ? (
            <AccessProvider me={me.data}>
              <Page route={route} me={me.data} />
            </AccessProvider>
          ) : null}
        </Shell>
      </ToastProvider>
    </NavContext.Provider>
  );
}

function SignedOut() {
  return (
    <section aria-labelledby="signin-h" className="signin">
      <PageHead
        title={<span id="signin-h">Sign in</span>}
        sub="The factory takes work through a governed lifecycle, and people decide the gates. Sign in to see your projects and cards."
      />
      {/* A plain link: the bff starts the sign-in and sends the browser to the identity provider. */}
      <a className="btn" href="/auth/login">
        Sign in
      </a>
    </section>
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
      return <CardPage id={route.id} csrf={me.csrf_token} me={me.principal.principal_id} />;
    case 'item':
      return <ItemPage id={route.id} csrf={me.csrf_token} />;
    case 'pack':
      return <PackPage id={route.id} />;
    case 'inbox':
      return <InboxPage />;
    case 'revision':
      return <RevisionPage gate={route.id} csrf={me.csrf_token} />;
    case 'readiness':
      return <PrrPage project={route.id} />;
    case 'ledger':
      return (
        <LedgerPage
          project={route.id}
          {...(new URLSearchParams(window.location.search).get('s0')
            ? { s0: new URLSearchParams(window.location.search).get('s0') as string }
            : {})}
        />
      );
    case 'access':
      return <MyAccessPage />;
    case 'config':
      return <ConfigListPage />;
    case 'configKey':
      return <ConfigKeyPage configKey={route.key} csrf={me.csrf_token} />;
    case 'notfound':
      return <ErrorState status={404} action={<Link to="/">Back to projects</Link>} />;
  }
}
