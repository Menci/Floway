import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { z } from 'zod';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-admin-site-settings';
import { requireDashboardAdmin } from './guards';
import { getSiteSettings, putSiteSettings } from '../api/site-settings';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Input } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { fluentComponents } from '../fluent';
import { useSiteSettingsStore } from '../stores/site-settings-store';

const {
  Button,
  Field,
} = fluentComponents;

// The gateway's siteSettingsBody and the site_settings column both enforce this
// bound; a client that accepted more would only surface the server's rejection
// after a round trip.
const SITE_NAME_MAX_LENGTH = 64;

interface LoaderData {
  siteName: string | null;
  error: string | null;
}

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  const result = await getSiteSettings();
  return result.error
    ? { siteName: null, error: result.error.message }
    : { siteName: result.data.site_name, error: null };
}

const siteNameSchema = z.object({
  siteName: z
    .string()
    .max(SITE_NAME_MAX_LENGTH, 'dashboard.siteSettings.validation.tooLong'),
});

type SiteNameFormValues = z.infer<typeof siteNameSchema>;

export default function DashboardAdminSiteSettings({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const setSiteName = useSiteSettingsStore(state => state.setSiteName);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SiteNameFormValues>({
    resolver: zodResolver(siteNameSchema),
    defaultValues: { siteName: loaderData.siteName ?? '' },
  });

  useEffect(() => {
    reset({ siteName: loaderData.siteName ?? '' });
  }, [loaderData.siteName, reset]);

  const submit = async (values: SiteNameFormValues) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const trimmed = values.siteName.trim();
    const result = await putSiteSettings({ site_name: trimmed === '' ? null : trimmed });
    setSaving(false);
    if (result.error) {
      setSaveError(result.error.message);
      return;
    }
    // The wordmark and title read the store, so the page and the rest of the
    // dashboard agree without another round trip. The field takes the stored
    // form too: the gateway trims and maps a blank to NULL, and leaving the
    // typed whitespace there would show a value the deployment does not hold.
    setSiteName(result.data.site_name);
    reset({ siteName: result.data.site_name ?? '' });
    toasts.succeed(t('dashboard.siteSettings.updated'));
  };

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.siteSettings.description')} title={t('dashboard.nav.siteSettings')} />

      {/* A failed read is not an empty setting: offering the form would let a
          save overwrite a name this page never saw. */}
      {loaderData.error
        ? <OutcomeMessageBar>{loaderData.error}</OutcomeMessageBar>
        : <Panel className={`${PANEL_STACK_CLASS} w-full max-w-[480px]`}>
            <SectionHeader level={2} title={t('dashboard.siteSettings.branding')} />

            <form className="grid gap-4" onSubmit={event => void handleSubmit(submit)(event)}>
              <Controller
                control={control}
                name="siteName"
                render={({ field }) => (
                  <Field
                    hint={t('dashboard.siteSettings.nameHint')}
                    label={t('dashboard.siteSettings.name')}
                    validationMessage={errors.siteName?.message ? t(errors.siteName.message, { max: SITE_NAME_MAX_LENGTH }) : undefined}
                    validationState={errors.siteName ? 'error' : undefined}
                  >
                    <Input
                      {...field}
                      disabled={saving}
                      maxLength={SITE_NAME_MAX_LENGTH}
                      placeholder={t('dashboard.siteSettings.namePlaceholder')}
                    />
                  </Field>
                )}
              />

              {saveError && (
                <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>
              )}

              <div className="flex justify-end pt-1">
                <Button appearance="primary" disabledFocusable={saving} type="submit">
                  {t('dashboard.siteSettings.save')}
                </Button>
              </div>
            </form>
          </Panel>}
    </section>
  );
}
