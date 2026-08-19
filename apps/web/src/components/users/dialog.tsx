import { PersonKey24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { api, callApi } from '../../api/client';
import type { ControlPlaneModel, ControlPlaneUser, OAuth2Account, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { OAuth2AccountList } from '../oauth2/accounts';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { SectionHeader } from '../ui/section-header';
import { SettingsCard, SettingsSwitch } from '../ui/settings-card';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useDiscardGuard } from '../ui/use-discard-guard';
import { UpstreamAccessControl } from '../upstreams/access-control';

const {
  Button,
  DialogActions,
  DialogTitle,
  Field,
  MessageBar,
  MessageBarBody,
} = fluentComponents;

interface UserFormValues {
  username: string;
  password: string;
  isAdmin: boolean;
  upstreamOverride: boolean;
  upstreamIds: string[];
}

interface UserDialogCommonProps {
  actorId: number;
  models: ControlPlaneModel[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: (userId?: number) => Promise<void>;
  upstreams: UpstreamOption[];
}

type UserDialogProps = UserDialogCommonProps & (
  | { mode: 'create'; user?: never }
  | { mode: 'edit'; user: ControlPlaneUser }
);

export function UserDialog(props: UserDialogProps) {
  const { actorId, mode, models, onOpenChange, onSaved, upstreams } = props;
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const user = props.mode === 'edit' ? props.user : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oauth2Accounts, setOAuth2Accounts] = useState<OAuth2Account[] | null>(null);
  const [oauth2Error, setOAuth2Error] = useState<string | null>(null);
  const [unlinkingProvider, setUnlinkingProvider] = useState<string | null>(null);
  const unlinkDialog = useDialogInvocation<OAuth2Account>();
  const schema = useMemo(
    () => z.object({
      username: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/, 'dashboard.users.validation.username'),
      password: z.string().max(1024, 'dashboard.users.validation.passwordMax'),
      isAdmin: z.boolean(),
      upstreamOverride: z.boolean(),
      upstreamIds: z.array(z.string()),
    }).superRefine((value, ctx) => {
      if (mode === 'create' && !value.password) {
        ctx.addIssue({ code: 'custom', message: 'dashboard.users.validation.passwordRequired', path: ['password'] });
      }
    }),
    [mode],
  );
  const { control, handleSubmit, setValue, formState: { errors } } =
    useForm<UserFormValues>({
      resolver: zodResolver(schema),
      defaultValues: userFormDefaults(user),
    });
  const values = useWatch({ control }) as UserFormValues;
  const adminLocked = props.mode === 'edit' && (props.user.id === 1 || props.user.id === actorId);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });

  useEffect(() => {
    if (user === null) return;
    const targetId = user.id;
    const controller = new AbortController();
    void callApi(() => api.api.users[':id']['oauth2-accounts'].$get({
      param: { id: String(targetId) },
    }, { init: { signal: controller.signal } })).then(result => {
      if (controller.signal.aborted) return;
      if (result.error) setOAuth2Error(result.error.message);
      else setOAuth2Accounts(result.data.accounts);
    });
    return () => controller.abort();
  }, [user]);

  const unlinkOAuth2 = async (account: OAuth2Account) => {
    if (props.mode !== 'edit' || unlinkingProvider !== null) return;
    setUnlinkingProvider(account.provider_id);
    setOAuth2Error(null);
    const result = await callApi(() => api.api.users[':id']['oauth2-accounts'][':provider'].$delete({
      param: { id: String(props.user.id), provider: account.provider_id },
    }));
    setUnlinkingProvider(null);
    if (result.error) {
      setOAuth2Error(result.error.message);
      return;
    }
    unlinkDialog.close();
    setOAuth2Accounts(result.data.accounts);
    toasts.succeed(t('dashboard.oauth2.accounts.unlinked', { provider: account.provider_display_name }));
  };

  const save = async (form: UserFormValues) => {
    // disabledFocusable leaves the submit button submittable while saving, so this guard is what makes the second press inert.
    if (saving || unlinkingProvider !== null) return;
    setSaving(true);
    setError(null);
    try {
      const username = form.username.trim();
      const upstreamIds = form.upstreamOverride ? form.upstreamIds : null;
      const handle = toasts.start(t(`dashboard.users.toast.${mode}.pending`, { username }));
      const result = props.mode === 'create'
        ? await callApi(() => api.api.users.$post({
            json: {
              username,
              password: form.password,
              isAdmin: form.isAdmin,
              upstreamIds,
            },
          }))
        : await callApi(() => api.api.users[':id'].$patch({
            param: { id: String(props.user.id) }, json: {
              username,
              ...(!adminLocked ? { isAdmin: form.isAdmin } : {}),
              upstreamIds,
            },
          }));
      if (result.error) {
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t(`dashboard.users.toast.${mode}.success`, { username }));
      await onSaved(props.mode === 'edit' ? props.user.id : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>{discardConfirmation}<DialogShell
      width="editor"
      open={props.open}
      actions={
        <DialogActions>
          <Button disabled={saving || unlinkingProvider !== null} onClick={requestClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" disabledFocusable={saving || unlinkingProvider !== null} type="submit">
            {mode === 'create' ? t('dashboard.users.actions.create') : t('dashboard.users.actions.save')}
          </Button>
        </DialogActions>
      }
      onOpenChange={(_, data) => { if (!data.open && !saving && unlinkingProvider === null) requestClose(); }}
      onSubmit={() => void handleSubmit(save)()}
      title={<DialogTitle>{props.mode === 'create'
        ? t('dashboard.users.dialog.createTitle')
        : t('dashboard.users.dialog.editTitle', { username: props.user.username })}</DialogTitle>}
    >
      <Controller
        control={control}
        name="username"
        render={({ field }) => (
          <Field
            hint={t('dashboard.users.form.usernameHint')}
            label={t('dashboard.users.form.username')}
            validationMessage={errors.username?.message ? t(errors.username.message) : undefined}
            validationState={errors.username ? 'error' : undefined}
          >
            <Input {...field} autoComplete="off" disabled={saving} />
          </Field>
        )}
      />
      {mode === 'create' && (
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <Field
              label={t('dashboard.users.form.password')}
              validationMessage={errors.password?.message ? t(errors.password.message) : undefined}
              validationState={errors.password ? 'error' : undefined}
            >
              <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
            </Field>
          )}
        />
      )}
      <SettingsCard
        action={<SettingsSwitch
          checked={values.isAdmin}
          disabled={saving || adminLocked}
          label={t('dashboard.users.form.administrator')}
          onChange={checked => setValue('isAdmin', checked, { shouldValidate: true })}
        />}
        description={adminLocked
          ? t(props.mode === 'edit' && props.user.id === 1 ? 'dashboard.users.form.userOneLocked' : 'dashboard.users.form.selfLocked')
          : t('dashboard.users.form.administratorDescription')}
        header={t('dashboard.users.form.administrator')}
        icon={<PersonKey24Regular />}
      />
      <UpstreamAccessControl
        available={upstreams}
        disabled={saving}
        error={errors.upstreamIds?.message ? t(errors.upstreamIds.message) : null}
        ids={values.upstreamIds}
        models={models}
        onChange={next => {
          setValue('upstreamOverride', next.override, { shouldValidate: true });
          setValue('upstreamIds', next.ids, { shouldValidate: true });
        }}
        override={values.upstreamOverride}
      />
      {mode === 'edit' && <div className="grid gap-3">
        <SectionHeader
          description={t('dashboard.oauth2.accounts.adminDescription')}
          level={2}
          title={t('dashboard.oauth2.accounts.title')}
        />
        <OAuth2AccountList
          accounts={oauth2Accounts}
          busyProvider={unlinkingProvider}
          disabled={saving}
          failed={oauth2Error !== null}
          onUnlink={unlinkDialog.open}
        />
        {oauth2Error && <OutcomeMessageBar onDismiss={() => setOAuth2Error(null)}>{oauth2Error}</OutcomeMessageBar>}
      </div>}
      {mode === 'create' && (
        <MessageBar intent="info"><MessageBarBody>{t('dashboard.users.createdDefaultKey')}</MessageBarBody></MessageBar>
      )}
      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    </DialogShell>
    {unlinkDialog.invocation && <ConfirmDialog
      open={unlinkDialog.isOpen}
      actionLabel={t('dashboard.oauth2.accounts.unlink')}
      busy={unlinkingProvider !== null}
      message={t('dashboard.oauth2.accounts.unlinkMessage', {
        provider: unlinkDialog.invocation.value.provider_display_name,
        login: unlinkDialog.invocation.value.provider_login,
      })}
      onConfirm={() => void unlinkOAuth2(unlinkDialog.invocation!.value)}
      onOpenChange={open => { if (!open && unlinkingProvider === null) unlinkDialog.close(); }}
      title={t('dashboard.oauth2.accounts.unlinkTitle')}
    />}</>
  );
}

const userFormDefaults = (user: ControlPlaneUser | null): UserFormValues => {
  return {
    username: user?.username ?? '',
    password: '',
    isAdmin: user?.isAdmin ?? false,
    upstreamOverride: user?.upstreamIds !== null && user?.upstreamIds !== undefined,
    upstreamIds: user?.upstreamIds ?? [],
  };
};
