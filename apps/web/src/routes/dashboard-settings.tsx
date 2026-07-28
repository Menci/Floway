import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import type { Route } from './+types/dashboard-settings';
import { changeOwnPassword } from '../api/auth';
import { Input } from '../components/ui/fluent-form-controls';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';

const {
  Button,
  Field,
  MessageBar,
  MessageBarBody,
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
    return { ok: false, error: values.error.issues[0]?.message ?? 'validation.passwordRequired' };
  }

  const result = await changeOwnPassword({
    currentPassword: values.data.currentPassword,
    newPassword: values.data.newPassword,
  });

  if (result.error) return { ok: false, error: result.error.message };
  return { ok: true };
}

export function meta() {
  return [{ title: 'Settings | Floway' }];
}

export default function DashboardSettings() {
  const { t } = useTranslation();
  const fetcher = useFetcher<SettingsActionData>();
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

  useEffect(() => {
    if (fetcher.data?.ok) reset();
  }, [fetcher.data, reset]);

  const submit = (values: PasswordFormValues) => {
    void fetcher.submit(values, { method: 'post' });
  };

  return (
    <section className="grid gap-[18px] max-w-[960px] min-w-0">
      <DashboardPageHeader description={t('dashboard.settings.description')} eyebrow={t('dashboard.settings.eyebrow')} title={t('dashboard.nav.settings')} />

      <Panel className="grid w-full max-w-[480px] gap-[18px] !p-[22px_24px] max-[680px]:!p-[18px]">
        <Text size={400} weight="semibold">
          {t('dashboard.settings.changePassword')}
        </Text>

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

          <Text size={200} className="text-fui-fg2 leading-[1.45]">
            {t('dashboard.settings.otherDevices')}
          </Text>

          {fetcher.data?.ok === false && (
            <MessageBar intent="error">
              <MessageBarBody>{t(fetcher.data.error)}</MessageBarBody>
            </MessageBar>
          )}
          {fetcher.data?.ok === true && (
            <MessageBar intent="success">
              <MessageBarBody>{t('dashboard.settings.passwordUpdated')}</MessageBarBody>
            </MessageBar>
          )}

          <div className="flex justify-end pt-1">
            <Button appearance="primary" disabled={saving} type="submit">
              {saving ? (
                <span className="inline-flex items-center gap-2">
                  <Spinner size="tiny" />
                  {t('dashboard.settings.saving')}
                </span>
              ) : (
                t('dashboard.settings.save')
              )}
            </Button>
          </div>
        </form>
      </Panel>
    </section>
  );
}
