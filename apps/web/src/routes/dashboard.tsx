import { NavigationRegular } from '@fluentui/react-icons';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Outlet,
  redirect,
  useLocation,
  useNavigate,
  useOutletContext,
} from 'react-router';

import type { Route } from './+types/dashboard';
import type { AuthUser } from '../api/auth';
import { getSessionToken } from '../auth/session';
import { FlowayLogo } from '../components/logo';
import { Sidebar } from '../components/sidebar';
import { PageLoading } from '../components/ui/page-loading';
import { PageShell } from '../components/ui/page-shell';
import { fluentComponents } from '../fluent';
import { useAuthStore } from '../stores/auth-store';

const { Button, DrawerBody, OverlayDrawer } = fluentComponents;

export type DashboardOutletContext = {
  user: AuthUser;
};

export async function clientLoader() {
  if (!getSessionToken()) throw redirect('/');
  return null;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Dashboard | Floway' }];
}

export default function Dashboard({}: Route.ComponentProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const initialize = useAuthStore(state => state.initialize);
  const status = useAuthStore(state => state.status);
  const user = useAuthStore(state => state.user);
  const error = useAuthStore(state => state.error);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const { pathname } = useLocation();
  const upstreamEditor = /^\/dashboard\/providers\/upstreams\/(?:new\/[^/]+|[^/]+)$/.test(pathname);
  const requestsInspector = pathname === '/dashboard/monitor/requests';
  const playground = pathname === '/dashboard/playground';

  useEffect(() => {
    void initialize();
  }, [initialize]);

  useEffect(() => {
    if (status === 'unauthenticated') void navigate('/', { replace: true });
  }, [navigate, status]);

  if (status === 'error') {
    return (
      <PageShell>
        <p className="text-fui-fg2">{error}</p>
      </PageShell>
    );
  }

  if (!user) {
    return <PageLoading label={t('common.loading')} viewport />;
  }

  return (
    <>
      <a
        className="fixed left-3 top-3 z-[100000] -translate-y-20 rounded-md bg-fui-bg1 px-3 py-2 text-fui-fg1 shadow-lg focus:translate-y-0"
        href="#dashboard-main"
      >
        {t('dashboard.nav.skip')}
      </a>
      <div className="grid grid-cols-[290px_minmax(0,1fr)] h-screen min-h-0 max-[900px]:grid-cols-1 max-[900px]:grid-rows-[58px_minmax(0,1fr)]">
        <div className="max-[900px]:hidden">
          <Sidebar user={user} />
        </div>
        <header className="hidden max-[900px]:flex items-center gap-3 border-b border-b-solid border-fui-stroke1 px-4">
          <Button
            appearance="subtle"
            aria-label={t('dashboard.nav.open')}
            icon={<NavigationRegular />}
            onClick={() => setNavigationOpen(true)}
          />
          <FlowayLogo size="compact" />
        </header>
        <main id="dashboard-main" tabIndex={-1} className={upstreamEditor || requestsInspector || playground
          ? 'min-h-0 overflow-hidden p-[22px_28px_28px] max-[1100px]:overflow-y-auto max-[680px]:p-4'
          : 'min-h-0 overflow-y-auto p-[22px_28px_28px] [scrollbar-gutter:stable] max-[680px]:p-4'}>
          <Outlet context={{ user } satisfies DashboardOutletContext} />
        </main>
      </div>
      <OverlayDrawer
        aria-label={t('dashboard.nav.label')}
        onOpenChange={(_, data) => setNavigationOpen(data.open)}
        open={navigationOpen}
        position="start"
      >
        <DrawerBody className="!p-0">
          <Sidebar onNavigate={() => setNavigationOpen(false)} user={user} />
        </DrawerBody>
      </OverlayDrawer>
    </>
  );
}

export function useDashboardOutletContext() {
  return useOutletContext<DashboardOutletContext>();
}
