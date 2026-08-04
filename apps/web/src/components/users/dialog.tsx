import { PersonKey24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { api, callApi } from '../../api/client';
import type { ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { SettingsCard, SettingsSwitch } from '../ui/settings-card';
import { useDiscardGuard } from '../ui/use-discard-guard';
import { UpstreamAccessControl } from '../upstreams/access-control';
import { refineUpstreamAccess } from '../upstreams/access-validation';

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
      refineUpstreamAccess(value, ctx);
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

  const save = async (form: UserFormValues) => {
    // disabledFocusable leaves the submit button submittable while saving, so this guard is what makes the second press inert.
    if (saving) return;
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
          <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" disabledFocusable={saving} type="submit">
            {mode === 'create' ? t('dashboard.users.actions.create') : t('dashboard.users.actions.save')}
          </Button>
        </DialogActions>
      }
      onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
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
      {mode === 'create' && (
        <MessageBar intent="info"><MessageBarBody>{t('dashboard.users.createdDefaultKey')}</MessageBarBody></MessageBar>
      )}
      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    </DialogShell></>
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
