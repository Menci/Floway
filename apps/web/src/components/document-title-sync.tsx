import { useEffect } from 'react';
import { useLocation } from 'react-router';

import { useTranslation } from '../i18n/translation';
import { pageLabelKeys } from './sidebar/pages';
import { useSiteSettings } from './site-settings-context';

const titleKeyForPathname = (pathname: string) => {
  if (pathname === '/') return 'auth.login.title';
  if (pathname === '/dashboard') return 'dashboard.title';
  if (/^\/dashboard\/providers\/upstreams\/new\/[^/]+$/.test(pathname)) {
    return 'dashboard.upstreamEditor.documentTitleNew';
  }
  if (/^\/dashboard\/providers\/upstreams\/[^/]+$/.test(pathname)) {
    return 'dashboard.upstreamEditor.documentTitleEdit';
  }

  return pageLabelKeys.get(pathname) ?? 'app.title';
};

// The only writer of the document title. A route `meta` export cannot replace
// it: server rendering is off and the one prerendered route resolves no leaf,
// so `meta` reaches no static file and at runtime loses to this effect anyway,
// in English on a zh-Hans dashboard.
export function DocumentTitleSync() {
  const location = useLocation();
  const { i18n, t } = useTranslation();
  const { name } = useSiteSettings();

  useEffect(() => {
    const title = t(titleKeyForPathname(location.pathname));
    window.document.title = t('app.documentTitle', { siteName: name, title });
  }, [i18n.language, location.pathname, name, t]);

  return null;
}
