import { ProjectSettingsPage } from './pages/ProjectSettingsPage';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { AccessProvider, reasonText } from './access';
import { ApiError, api, type Me } from './api';
import { ErrorNote, Loading } from './components/Notice';
import { PackPage } from './pages/PackPage';
import { LedgerPage } from './pages/LedgerPage';
import { PrrPage } from './pages/PrrPage';
import { IssueTwinPage } from './pages/IssueTwinPage';
import { DriftPage, ReaffirmPage } from './pages/DriftPage';
import { RevisionPage } from './pages/RevisionPage';
import { OnboardStart } from './onboard/OnboardStart';
import { OnboardRecord } from './onboard/OnboardRecord';
import { ProjectPage } from './projects/ProjectPage';
import { KnowledgePage } from './pages/KnowledgePage';
import { ProjectsPage } from './projects/ProjectsPage';
import { ConfigKeyPage, ConfigListPage } from './pages/ConfigPages';
import { MyAccessPage } from './pages/MyAccessPage';
import { NotificationPrefsPage, NotificationsPage } from './pages/NotificationsPage';
import { AskPage } from './assistant/AskPage';
import { AskScreen } from './work/AskScreen';
import { DecideScreen } from './work/DecideScreen';
import { HomeScreen } from './work/HomeScreen';
import { InboxScreen } from './work/InboxScreen';
import { ItemScreen } from './work/ItemScreen';
import { ItemsScreen } from './work/ItemsScreen';
import { CloseoutPage } from './pages/CloseoutPage';
import { LearnPage } from './pages/LearnPage';
import { FactoryRevisionPage } from './pages/FactoryRevisionPage';
import { AccessGrantPage, AccessRequestsPage } from './pages/AccessPages';
import { FloorPage } from './floor/FloorPage';
import { FleetPage } from './floor/FleetPage';
import { AgentsPage, EvalsPage, IntegrationsPage, ModelsPage } from './pages/QualityPages';
import { AgentPage } from './pages/AgentPage';
import {
  ControlsPage,
  HealthPage,
  KillPage,
  SandboxesPage,
  SchedulerPage,
} from './pages/OperatePages';
import { AuditPage, CataloguePage, FleetLedgerPage } from './pages/GovernPages';
import { BudgetsPage, CostPage } from './pages/SpendPages';
import { ExplainPage, PeoplePage, RolesPage, TeamsPage } from './pages/AdminPages';
import { guardAction, guardOf, guardPasses } from './shell/nav';

import { Link, NavContext, STATIC_SCREENS, useRoute, type Route } from './router';
import { Shell } from './shell/Shell';
import { DesignPage } from './design/DesignPage';
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
        {me.data ? (
          <AccessProvider me={me.data}>
            <Shell me={me.data} route={route}>
              <Page route={route} me={me.data} />
            </Shell>
          </AccessProvider>
        ) : (
          <Shell me={null} route={route}>
            {me.isPending ? <Loading what="your session" /> : null}
            {me.isError ? <ErrorNote error={me.error} retry={() => void me.refetch()} /> : null}
            {me.data === null ? <SignedOut /> : null}
          </Shell>
        )}
      </ToastProvider>
    </NavContext.Provider>
  );
}

/** `/auth/login`, with the page in the address bar as where to come back to (not for `/`, which is the default). */
export function signInHref(loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location) {
  const here = `${loc.pathname}${loc.search}${loc.hash}`;
  return here === '/' || here === ''
    ? '/auth/login'
    : `/auth/login?return_to=${encodeURIComponent(here)}`;
}

function SignedOut() {
  return (
    <section aria-labelledby="signin-h" className="signin">
      <PageHead
        title={<span id="signin-h">Sign in</span>}
        sub="The factory takes work through a governed lifecycle, and people decide the gates. Sign in to see your projects and cards."
      />
      {/* A plain link: the bff starts the sign-in and sends the browser to the identity provider, then
          back to the page that was asked for (P2-18; the bff keeps only a same-origin path). */}
      <a className="btn" href={signInHref()}>
        Sign in
      </a>
    </section>
  );
}

/**
 * A screen the navigation would not list for this person is a 403 with the policy's reason, before any
 * call: the server refuses the reads anyway, this only saves the person a broken page.
 */
function Screen({ me, route, children }: { me: Me; route: Route; children: ReactNode }) {
  // an agent's page is guarded as the agent list is
  const path =
    route.name === 'agent'
      ? '/agents'
      : Object.entries(STATIC_SCREENS).find(([, n]) => n === route.name)?.[0];
  const guard = path ? guardOf(path) : null;
  if (guard && !guardPasses(guard, me)) {
    const action = guardAction(guard);
    return (
      <ErrorState
        status={403}
        {...(action ? { reason: reasonText(action, ['no_policy_permits']) } : {})}
        action={<Link to="/me/access">See my access</Link>}
      />
    );
  }
  return <>{children}</>;
}

function Page({ route, me }: { route: Route; me: Me }) {
  return (
    <Screen me={me} route={route}>
      <PageBody route={route} me={me} />
    </Screen>
  );
}

function PageBody({ route, me }: { route: Route; me: Me }) {
  const mayOnboard = me.actions.fleet.includes('project.onboard');
  const csrf = me.csrf_token;
  switch (route.name) {
    case 'home':
      return <HomeScreen me={me} />;
    case 'projects':
      return <ProjectsPage canOnboard={mayOnboard} />;
    case 'floor':
      return <FloorPage me={me} />;
    case 'fleet':
      return <FleetPage />;
    case 'items':
    case 'board':
      return <ItemsScreen key={route.name} me={me} />;
    case 'agents':
      return <AgentsPage />;
    case 'agent':
      return <AgentPage id={route.id} />;
    case 'evals':
      return <EvalsPage />;
    case 'models':
      return <ModelsPage csrf={csrf} />;
    case 'integrations':
      return <IntegrationsPage />;
    case 'scheduler':
      return <SchedulerPage />;
    case 'sandboxes':
      return <SandboxesPage />;
    case 'controls':
      return <ControlsPage csrf={csrf} />;
    case 'kill':
      return <KillPage csrf={csrf} />;
    case 'health':
      return <HealthPage />;
    case 'budgets':
      return <BudgetsPage />;
    case 'cost':
      return <CostPage />;
    case 'fleetLedger':
      return <FleetLedgerPage me={me} />;
    case 'audit':
      return <AuditPage csrf={csrf} />;
    case 'catalogue':
      return <CataloguePage />;
    case 'people':
      return <PeoplePage me={me} />;
    case 'teams':
      return <TeamsPage />;
    case 'roles':
      return <RolesPage />;
    case 'accessRequests':
      return <AccessRequestsPage me={me} />;
    case 'explain':
      return <ExplainPage me={me} />;
    case 'onboard':
      return <OnboardStart csrf={me.csrf_token} mayOnboard={mayOnboard} />;
    case 'project':
      return <ProjectPage key={route.id} id={route.id} me={me} />;
    case 'onboardRecord':
      return <OnboardRecord key={route.id} id={route.id} me={me} />;
    case 'card':
    case 'decide':
      return <DecideScreen key={route.id} id={route.id} me={me} csrf={csrf} />;
    case 'item':
      return <ItemScreen key={route.id} id={route.id} me={me} csrf={csrf} />;
    case 'pack':
      return <PackPage id={route.id} />;
    case 'closeout':
      return <CloseoutPage id={route.id} csrf={csrf} />;
    case 'learn':
      return <LearnPage project={route.id} csrf={csrf} />;
    case 'accessGrant':
      return <AccessGrantPage id={route.id} csrf={csrf} />;
    case 'factoryRevision':
      return <FactoryRevisionPage gate={route.id} csrf={csrf} me={me.principal.principal_id} />;
    case 'inbox':
      return <InboxScreen me={me} />;
    case 'revision':
      return <RevisionPage gate={route.id} csrf={me.csrf_token} />;
    case 'projectSettings':
      return <ProjectSettingsPage id={route.id} csrf={me.csrf_token} />;
    case 'readiness':
      return <PrrPage project={route.id} />;
    case 'knowledge':
      return <KnowledgePage project={route.id} />;
    case 'issues':
      return <IssueTwinPage project={route.id} csrf={me.csrf_token} />;
    case 'drift':
      return <DriftPage project={route.id} csrf={me.csrf_token} />;
    case 'reaffirm':
      return (
        <ReaffirmPage project={route.id} repo={route.repo} path={route.path} csrf={me.csrf_token} />
      );
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
    case 'ask':
      return <AskPage csrf={me.csrf_token} who={me.principal.display_name} />;
    case 'askForWork':
      return <AskScreen key={route.project ?? ''} project={route.project} csrf={csrf} />;
    case 'notifications':
      return <NotificationsPage />;
    case 'notificationPrefs':
      return <NotificationPrefsPage csrf={me.csrf_token} />;
    case 'design':
      return <DesignPage />;
    case 'notfound':
      return <ErrorState status={404} action={<Link to="/">Back home</Link>} />;
  }
}
