import { PersonRibbon24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import type { DirectoryGroupOption } from './directory';
import { api, callApi } from '../../api/client';
import type { ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { UserGroupsField } from '../groups/field';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { SettingsCard, SettingsSwitch } from '../ui/settings-card';
import { useDiscardGuard } from '../ui/use-discard-guard';

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
  groupIds: string[];
}

interface UserDialogCommonProps {
  actorId: number;
  groups: readonly DirectoryGroupOption[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: (userId?: number) => Promise<void>;
}

type UserDialogProps = UserDialogCommonProps & (
  | { mode: 'create'; user?: never }
  | { mode: 'edit'; user: ControlPlaneUser; groupIds: readonly number[] }
);

export function UserDialog(props: UserDialogProps) {
  const { actorId, mode, onOpenChange, onSaved } = props;
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const user = props.mode === 'edit' ? props.user : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = useMemo(
    () => z.object({
      username: z.string().regex(/^[a-zA-Z0-9_.-]{1,64}$/, 'directory.users.validation.username'),
      password: z.string().max(1024, 'directory.users.validation.passwordMax'),
      isAdmin: z.boolean(),
      groupIds: z.array(z.string()),
    }).superRefine((value, ctx) => {
      if (mode === 'create' && !value.password) {
        ctx.addIssue({ code: 'custom', message: 'directory.users.validation.passwordRequired', path: ['password'] });
      }
    }),
    [mode],
  );
  const { control, handleSubmit, setValue, formState: { errors } } =
    useForm<UserFormValues>({
      resolver: zodResolver(schema),
      defaultValues: userFormDefaults(user, props.mode === 'edit' ? props.groupIds : []),
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
      const handle = toasts.start(t(`directory.users.toast.${mode}.pending`, { username }));
      const result = props.mode === 'create'
        ? await callApi(() => api.api.users.$post({
            json: {
              username,
              password: form.password,
              isAdmin: form.isAdmin,
              groupIds: form.groupIds.map(Number),
            },
          }))
        : await callApi(() => api.api.users[':id'].$patch({
            param: { id: String(props.user.id) }, json: {
              username,
              ...(!adminLocked ? { isAdmin: form.isAdmin } : {}),
              groupIds: form.groupIds.map(Number),
            },
          }));
      if (result.error) {
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t(`directory.users.toast.${mode}.success`, { username }));
      await onSaved(props.mode === 'edit' ? props.user.id : undefined);
    } finally {
      setSaving(false);
    }
  };

  return (
    <DialogShell
      nestedDialogs={discardConfirmation}
      width="editor"
      open={props.open}
      actions={
        <DialogActions>
          <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
          <Button appearance="primary" disabledFocusable={saving} type="submit">
            {mode === 'create' ? t('directory.users.actions.create') : t('directory.users.actions.save')}
          </Button>
        </DialogActions>
      }
      onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
      onSubmit={() => void handleSubmit(save)()}
      title={<DialogTitle>{props.mode === 'create'
        ? t('directory.users.dialog.createTitle')
        : t('directory.users.dialog.editTitle', { username: props.user.username })}</DialogTitle>}
    >
      <Controller
        control={control}
        name="username"
        render={({ field }) => (
          <Field
            hint={t('directory.users.form.usernameHint')}
            label={t('directory.users.form.username')}
            validationMessage={errors.username?.message ? t(errors.username.message) : undefined}
            validationState={errors.username ? 'error' : undefined}
          >
            <Input {...field} autoComplete="off" disabled={saving} spellCheck={false} />
          </Field>
        )}
      />
      <Controller control={control} name="groupIds" render={({ field }) => <UserGroupsField disabled={saving} groups={props.groups} onChange={field.onChange} value={field.value} />} />
      {mode === 'create' && (
        <Controller
          control={control}
          name="password"
          render={({ field }) => (
            <Field
              label={t('directory.users.form.password')}
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
          label={t('directory.users.form.administrator')}
          onChange={checked => setValue('isAdmin', checked, { shouldValidate: true })}
        />}
        description={adminLocked
          ? t(props.mode === 'edit' && props.user.id === 1 ? 'directory.users.form.userOneLocked' : 'directory.users.form.selfLocked')
          : t('directory.users.form.administratorDescription')}
        header={t('directory.users.form.administrator')}
        icon={<PersonRibbon24Regular />}
      />
      {mode === 'create' && (
        <MessageBar intent="info"><MessageBarBody>{t('directory.users.createdDefaultKey')}</MessageBarBody></MessageBar>
      )}
      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    </DialogShell>
  );
}

const userFormDefaults = (user: ControlPlaneUser | null, groupIds: readonly number[]): UserFormValues => {
  return {
    username: user?.username ?? '',
    password: '',
    isAdmin: user?.isAdmin ?? false,
    groupIds: groupIds.map(String),
  };
};
