import { AddRegular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useFetcher } from 'react-router';
import { z } from 'zod';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-settings';
import { requireDashboardSession } from './guards';
import { changeOwnPassword } from '../api/auth';
import { api, callApi } from '../api/client';
import type { OAuth2Account } from '../api/types';
import { OAuth2AccountList } from '../components/oauth2/accounts';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Input } from '../components/ui/fluent-form-controls';
import { PANEL_STACK_CLASS } from '../components/ui/layout';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { SectionHeader } from '../components/ui/section-header';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { fluentComponents } from '../fluent';

const {
  Button,
  Field,
  Text,
} = fluentComponents;

interface SettingsLoaderData {
  accounts: OAuth2Account[] | null;
  providers: Array<{ id: string; displayName: string }> | null;
  error: string | null;
  bindingSucceeded: boolean;
}

const loadOAuth2Accounts = async (): Promise<Omit<SettingsLoaderData, 'bindingSucceeded'>> => {
  const [accountsResult, providersResult] = await Promise.all([
    callApi(() => api.api.users.me['oauth2-accounts'].$get()),
    callApi(() => api.auth.oauth2.providers.$get()),
  ]);
  return {
    accounts: accountsResult.error ? null : accountsResult.data.accounts,
    providers: providersResult.error ? null : providersResult.data.providers,
    error: accountsResult.error?.message ?? providersResult.error?.message ?? null,
  };
};

export async function clientLoader(): Promise<SettingsLoaderData> {
  requireDashboardSession();
  const data = await loadOAuth2Accounts();
  const fragment = new URLSearchParams(window.location.hash.slice(1));
  const bindingSucceeded = fragment.get('oauth2_binding') === 'success';
  const bindingError = fragment.get('oauth2_binding_error');
  if (bindingSucceeded || bindingError !== null) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  }
  return {
    ...data,
    error: data.error ?? bindingError,
    bindingSucceeded,
  };
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

export default function DashboardSettings({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const fetcher = useFetcher<SettingsActionData>();
  const toasts = useOutcomeToasts();
  const [dismissed, setDismissed] = useState<SettingsActionData | null>(null);
  const [oauth2Data, setOAuth2Data] = useState(loaderData);
  const [oauth2Error, setOAuth2Error] = useState(loaderData.error);
  const [bindingProvider, setBindingProvider] = useState<string | null>(null);
  const [unlinkingProvider, setUnlinkingProvider] = useState<string | null>(null);
  const unlinkDialog = useDialogInvocation<OAuth2Account>();
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

  useEffect(() => {
    if (loaderData.bindingSucceeded) toasts.succeed(t('dashboard.oauth2.accounts.bound'));
  }, [loaderData.bindingSucceeded, t, toasts]);

  const availableProviders = useMemo(() => {
    if (oauth2Data.accounts === null || oauth2Data.providers === null) return [];
    const bound = new Set(oauth2Data.accounts.map(account => account.provider_id));
    return oauth2Data.providers.filter(provider => !bound.has(provider.id));
  }, [oauth2Data]);

  const bind = async (provider: { id: string; displayName: string }) => {
    if (bindingProvider !== null) return;
    setBindingProvider(provider.id);
    setOAuth2Error(null);
    const result = await callApi(() => api.auth.oauth2[':provider'].bind.start.$post({
      param: { provider: provider.id },
    }));
    if (result.error) {
      setOAuth2Error(result.error.message);
      setBindingProvider(null);
      return;
    }
    window.location.assign(result.data.authorizationUrl);
  };

  const unlink = async (account: OAuth2Account) => {
    if (unlinkingProvider !== null) return;
    setUnlinkingProvider(account.provider_id);
    setOAuth2Error(null);
    const result = await callApi(() => api.api.users.me['oauth2-accounts'][':provider'].$delete({
      param: { provider: account.provider_id },
    }));
    setUnlinkingProvider(null);
    if (result.error) {
      setOAuth2Error(result.error.message);
      return;
    }
    unlinkDialog.close();
    setOAuth2Data(current => ({ ...current, accounts: result.data.accounts, error: null }));
    toasts.succeed(t('dashboard.oauth2.accounts.unlinked', { provider: account.provider_display_name }));
  };

  const submit = (values: PasswordFormValues) => {
    // `disabledFocusable` leaves the native disabled attribute off, so a second
    // Enter still submits; refusing here is what makes the button inert.
    if (saving) return;
    void fetcher.submit(values, { method: 'post' });
  };

  return (
    <section className="dashboard-page max-w-[960px]">
      <DashboardPageHeader description={t('dashboard.settings.description')} title={t('dashboard.nav.settings')} />

      <Panel className={`${PANEL_STACK_CLASS} w-full max-w-[640px]`}>
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
      <Panel className={`${PANEL_STACK_CLASS} w-full max-w-[640px]`}>
        <SectionHeader
          description={t('dashboard.oauth2.accounts.description')}
          level={2}
          title={t('dashboard.oauth2.accounts.title')}
        />

        {availableProviders.length > 0 && <div className="flex flex-wrap gap-2">
          {availableProviders.map(provider => <Button
            disabled={unlinkingProvider !== null}
            disabledFocusable={bindingProvider !== null}
            icon={<AddRegular />}
            key={provider.id}
            onClick={() => void bind(provider)}
          >{t('dashboard.oauth2.accounts.bind', { provider: provider.displayName })}</Button>)}
        </div>}

        <OAuth2AccountList
          accounts={oauth2Data.accounts}
          busyProvider={unlinkingProvider}
          disabled={bindingProvider !== null}
          failed={oauth2Data.accounts === null && oauth2Error !== null}
          onUnlink={unlinkDialog.open}
        />

        {oauth2Error && <OutcomeMessageBar onDismiss={() => setOAuth2Error(null)}>{oauth2Error}</OutcomeMessageBar>}
      </Panel>

      {unlinkDialog.invocation && <ConfirmDialog
        open={unlinkDialog.isOpen}
        actionLabel={t('dashboard.oauth2.accounts.unlink')}
        busy={unlinkingProvider !== null}
        message={t('dashboard.oauth2.accounts.unlinkMessage', {
          provider: unlinkDialog.invocation.value.provider_display_name,
          login: unlinkDialog.invocation.value.provider_login,
        })}
        onConfirm={() => void unlink(unlinkDialog.invocation!.value)}
        onOpenChange={open => { if (!open && unlinkingProvider === null) unlinkDialog.close(); }}
        title={t('dashboard.oauth2.accounts.unlinkTitle')}
      />}
    </section>
  );
}
