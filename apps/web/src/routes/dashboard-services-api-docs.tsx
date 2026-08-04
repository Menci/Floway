import { requireDashboardSession } from './guards';
import { ApiDocsContent } from '../components/api-docs/content';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { useTranslation } from '../i18n/translation';

export async function clientLoader() {
  requireDashboardSession();
  return null;
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
