import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import type { Route } from './+types/dashboard-settings';
import { changeOwnPassword } from '../api/auth';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Input } from '../components/ui/fluent-form-controls';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { fluentComponents } from '../fluent';

const {
  Button,
  Field,
  Spinner,
  Text,
} = fluentComponents;

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

export async function clientAction({
  request,
}: Route.ClientActionArgs): Promise<SettingsActionData> {
  const formData = await request.formData();
  const values = passwordSchema.safeParse({
    currentPassword: String(formData.get('currentPassword') ?? ''),
    newPassword: String(formData.get('newPassword') ?? ''),
    confirmPassword: String(formData.get('confirmPassword') ?? ''),
  });

  if (!values.success) {
    return { ok: false, error: values.error.issues[0]!.message };
  }

  const result = await changeOwnPassword({
    currentPassword: values.data.currentPassword,
    newPassword: values.data.newPassword,
  });

  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Settings | Floway' }];
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

  // A dismissal names the result it dismissed rather than clearing a copy of
  // it, so the next submission's failure appears on its own account.
  const error = fetcher.data && !fetcher.data.ok && fetcher.data !== dismissed
    ? t(fetcher.data.error)
    : null;

  useEffect(() => {
    if (!fetcher.data?.ok) return;
    reset();
    toasts.succeed(t('dashboard.settings.passwordUpdated'));
  }, [fetcher.data, reset, t, toasts]);

  const submit = (values: PasswordFormValues) => {
    void fetcher.submit(values, { method: 'post' });
  };

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.settings.description')} title={t('dashboard.nav.settings')} />

      <Panel className="!grid w-full max-w-[480px] !gap-[18px]">
        <SectionHeader level={2} title={t('dashboard.settings.changePassword')} />

        <form className="grid gap-4" onSubmit={event => void handleSubmit(submit)(event)}>
          <Controller
            control={control}
            name="currentPassword"
            render={({ field }) => (
              <Field
                label={t('dashboard.settings.currentPassword')}
                required
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
                required
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
                required
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
            <Button appearance="primary" disabled={saving} icon={saving ? <Spinner size="tiny" /> : undefined} type="submit">
              {saving ? t('dashboard.settings.saving') : t('dashboard.settings.save')}
            </Button>
          </div>
        </form>
      </Panel>
    </section>
  );
}
