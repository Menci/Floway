import { useTranslation } from 'react-i18next';

import type { Route } from './+types/dashboard-services-api-docs';
import { ApiDocsContent } from '../components/api-docs/api-docs-content';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';

export function meta({}: Route.MetaArgs) {
  return [{ title: 'API Docs | Floway' }];
}

export default function DashboardServicesApiDocs() {
  const { t } = useTranslation();
  return (
    <section className="dashboard-page max-w-[1200px]">
      <DashboardPageHeader description={t('dashboard.pages.apiDocs')} title={t('dashboard.nav.apiDocs')} />
      <ApiDocsContent />
    </section>
  );
}
