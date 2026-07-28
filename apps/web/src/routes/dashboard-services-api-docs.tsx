import { useTranslation } from 'react-i18next';

import { ApiDocsContent } from '../components/api-docs/api-docs-content';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';

export function meta() {
  return [{ title: 'API Docs | Floway' }];
}

export default function DashboardServicesApiDocs() {
  const { t } = useTranslation();
  return (
    <section className="grid gap-[18px] max-w-[1200px] min-w-0">
      <DashboardPageHeader description={t('dashboard.pages.apiDocs')} eyebrow={t('dashboard.groups.services')} title={t('dashboard.nav.apiDocs')} />
      <ApiDocsContent />
    </section>
  );
}
