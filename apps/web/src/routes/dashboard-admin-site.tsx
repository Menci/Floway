import { zodResolver } from '@hookform/resolvers/zod';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { useRevalidator } from 'react-router';
import { z } from 'zod';

import { requireDashboardAdmin } from './guards';
import { updateSiteSettings } from '../api/site-settings';
import { useSiteSettings } from '../components/site-settings-context';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Input } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { fluentComponents } from '../fluent';
import { useTranslation } from '../i18n/translation';

const { Button, Field } = fluentComponents;

export async function clientLoader() {
  await requireDashboardAdmin();
  return null;
}

const siteNameSchema = z.object({
  name: z.string()
    .trim()
    .min(1, 'dashboard.siteSettings.validation.required')
    .max(64, 'dashboard.siteSettings.validation.max'),
});

type SiteNameFormValues = z.infer<typeof siteNameSchema>;

export default function DashboardAdminSite() {
  const { name } = useSiteSettings();
  const { t } = useTranslation();
  const revalidator = useRevalidator();
  const toasts = useOutcomeToasts();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const {
    formState: { errors },
    handleSubmit,
    register,
  } = useForm<SiteNameFormValues>({
    resolver: zodResolver(siteNameSchema),
    values: { name },
  });

  const save = async (values: SiteNameFormValues) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    const result = await updateSiteSettings(values);
    if (result.error) {
      setError(result.error.message);
      setSaving(false);
      return;
    }
    await revalidator.revalidate();
    setSaving(false);
    toasts.succeed(t('dashboard.siteSettings.saved'));
  };

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.pages.site')} title={t('dashboard.nav.site')} />

      <Panel className={`${PANEL_STACK_CLASS} w-full max-w-[480px]`}>
        <SectionHeader description={t('dashboard.siteSettings.description')} level={2} title={t('dashboard.siteSettings.heading')} />

        <form className="grid gap-4" onSubmit={event => void handleSubmit(save)(event)}>
          <Field
            hint={t('dashboard.siteSettings.nameHint')}
            label={t('dashboard.siteSettings.name')}
            validationMessage={errors.name?.message ? t(errors.name.message) : undefined}
            validationState={errors.name ? 'error' : undefined}
          >
            <Input {...register('name')} autoComplete="off" disabled={saving} maxLength={64} />
          </Field>

          {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}

          <div className="flex justify-end pt-1">
            <Button appearance="primary" disabledFocusable={saving} type="submit">
              {t('dashboard.siteSettings.save')}
            </Button>
          </div>
        </form>
      </Panel>
    </section>
  );
}
