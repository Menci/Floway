import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

const dashboardTitleKeys = new Map<string, string>([
  ['/dashboard/playground', 'dashboard.nav.playground'],
  ['/dashboard/providers/upstreams', 'dashboard.nav.upstreams'],
  ['/dashboard/providers/search', 'dashboard.nav.search'],
  ['/dashboard/providers/proxy', 'dashboard.nav.proxy'],
  ['/dashboard/providers/model-aliases', 'dashboard.nav.modelAliases'],
  ['/dashboard/services/api-keys', 'dashboard.nav.apiKeys'],
  ['/dashboard/services/api-docs', 'dashboard.nav.apiDocs'],
  ['/dashboard/monitor/requests', 'dashboard.nav.requests'],
  ['/dashboard/monitor/usage', 'dashboard.nav.usage'],
  ['/dashboard/monitor/performance', 'dashboard.nav.performance'],
  ['/dashboard/admin/users', 'dashboard.nav.users'],
  ['/dashboard/admin/backup-restore', 'dashboard.nav.backupRestore'],
  ['/dashboard/settings', 'dashboard.nav.settings'],
]);

const titleKeyForPathname = (pathname: string) => {
  if (pathname === '/') return 'auth.login.title';
  if (pathname === '/dashboard') return 'dashboard.title';
  if (/^\/dashboard\/providers\/upstreams\/new\/[^/]+$/.test(pathname)) {
    return 'dashboard.upstreamEditor.documentTitleNew';
  }
  if (/^\/dashboard\/providers\/upstreams\/[^/]+$/.test(pathname)) {
    return 'dashboard.upstreamEditor.documentTitleEdit';
  }

  return dashboardTitleKeys.get(pathname) ?? 'app.title';
};

// The only writer of the document title. A route `meta` export cannot replace
// it: server rendering is off and the one prerendered route resolves no leaf,
// so `meta` reaches no static file and at runtime loses to this effect anyway,
// in English on a zh-Hans dashboard.
export function DocumentTitleSync() {
  const location = useLocation();
  const { i18n, t } = useTranslation();

  useEffect(() => {
    const title = t(titleKeyForPathname(location.pathname));
    window.document.title = t('app.documentTitle', { title });
  }, [i18n.language, location.pathname, t]);

  return null;
}
