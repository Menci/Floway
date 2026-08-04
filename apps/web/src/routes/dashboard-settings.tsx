import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-settings';
import { requireDashboardSession } from './guards';
import { changeOwnPassword } from '../api/auth';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Input } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { fluentComponents } from '../fluent';

const {
  Button,
  Field,
  Text,
} = fluentComponents;

export async function clientLoader() {
  requireDashboardSession();
  return null;
}

const passwordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, 'dashboard.settings.validation.currentPasswordRequired')
      .max(1024, 'validation.passwordMax'),
    newPassword: z
      .string()
      .min(1, 'dashboard.settings.validation.newPasswordRequired')
      .max(1024, 'validation.passwordMax'),
    confirmPassword: z.string(),
  })
  .refine(values => values.newPassword === values.confirmPassword, {
    message: 'dashboard.settings.validation.passwordMismatch',
    path: ['confirmPassword'],
  });

type PasswordFormValues = z.infer<typeof passwordSchema>;

type SettingsActionData =
  | { ok: true }
  | { ok: false; error: string };

const submittedField = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  if (typeof value !== 'string') throw new TypeError(`Password form submitted without ${name}`);
  return value;
};

export async function clientAction({
  request,
}: Route.ClientActionArgs): Promise<SettingsActionData> {
  const formData = await request.formData();
  const result = await changeOwnPassword({
    currentPassword: submittedField(formData, 'currentPassword'),
    newPassword: submittedField(formData, 'newPassword'),
  });

  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export default function DashboardSettings() {
  const { t } = useTranslation();
  const fetcher = useFetcher<SettingsActionData>();
  const toasts = useOutcomeToasts();
  const [dismissed, setDismissed] = useState<SettingsActionData | null>(null);
  const saving = fetcher.state !== 'idle';
  const {
    control,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<PasswordFormValues>({
    resolver: zodResolver(passwordSchema),
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });

  // A dismissal names the result it dismissed rather than clearing a copy, so the
  // next submission's failure appears on its own account. The gateway's message
  // is prose, not a message key: `t` would read its first colon as a namespace
  // separator and hand back the tail.
  const error = fetcher.data && !fetcher.data.ok && fetcher.data !== dismissed
    ? fetcher.data.error
    : null;

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    reset();
    toasts.succeed(t('dashboard.settings.passwordUpdated'));
  }, [fetcher.data, reset, t, toasts]);

  const submit = (values: PasswordFormValues) => {
    // `disabledFocusable` leaves the native disabled attribute off, so a second
    // Enter still submits; refusing here is what makes the button inert.
    if (saving) return;
    void fetcher.submit(values, { method: 'post' });
  };

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.settings.description')} title={t('dashboard.nav.settings')} />

      <Panel className={`${PANEL_STACK_CLASS} w-full max-w-[480px]`}>
        <SectionHeader level={2} title={t('dashboard.settings.changePassword')} />

        <form className="grid gap-4" onSubmit={event => void handleSubmit(submit)(event)}>
          <Controller
            control={control}
            name="currentPassword"
            render={({ field }) => (
              <Field
                label={t('dashboard.settings.currentPassword')}
                validationMessage={errors.currentPassword?.message ? t(errors.currentPassword.message) : undefined}
                validationState={errors.currentPassword ? 'error' : undefined}
              >
                <Input {...field} autoComplete="current-password" disabled={saving} type="password" />
              </Field>
            )}
          />

          <Controller
            control={control}
            name="newPassword"
            render={({ field }) => (
              <Field
                label={t('dashboard.settings.newPassword')}
                validationMessage={errors.newPassword?.message ? t(errors.newPassword.message) : undefined}
                validationState={errors.newPassword ? 'error' : undefined}
              >
                <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
              </Field>
            )}
          />

          <Controller
            control={control}
            name="confirmPassword"
            render={({ field }) => (
              <Field
                label={t('dashboard.settings.confirmPassword')}
                validationMessage={errors.confirmPassword?.message ? t(errors.confirmPassword.message) : undefined}
                validationState={errors.confirmPassword ? 'error' : undefined}
              >
                <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
              </Field>
            )}
          />

          <Text size={200} className="text-fui-fg2">
            {t('dashboard.settings.otherDevices')}
          </Text>

          {error && (
            <OutcomeMessageBar onDismiss={() => setDismissed(fetcher.data ?? null)}>{error}</OutcomeMessageBar>
          )}

          <div className="flex justify-end pt-1">
            <Button appearance="primary" disabledFocusable={saving} type="submit">
              {t('dashboard.settings.save')}
            </Button>
          </div>
        </form>
      </Panel>
    </section>
  );
}
