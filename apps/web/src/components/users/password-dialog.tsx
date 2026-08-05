import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { api, callApi } from '../../api/client';
import type { ControlPlaneUser } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { useDiscardGuard } from '../ui/use-discard-guard';

const { Button, DialogActions, DialogTitle, Field } = fluentComponents;

interface PasswordFormValues {
  password: string;
  confirmation: string;
}

export function PasswordDialog({ onOpenChange, open, onSaved, user }: {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: () => Promise<void>;
  user: ControlPlaneUser;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const schema = useMemo(() => z.object({
    password: z.string().min(1, 'dashboard.users.validation.passwordRequired').max(1024, 'dashboard.users.validation.passwordMax'),
    confirmation: z.string(),
  }).refine(value => value.password === value.confirmation, {
    message: 'dashboard.users.validation.passwordMismatch',
    path: ['confirmation'],
  }), []);
  const { control, handleSubmit, formState: { errors } } = useForm<PasswordFormValues>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirmation: '' },
  });
  // useWatch is typed DeepPartial, but both fields have a default.
  const values = useWatch({ control }) as PasswordFormValues;
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });
  const save = async (form: PasswordFormValues) => {
    // disabledFocusable leaves the submit button able to resubmit the form, so the guard is what makes a second press inert.
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const handle = toasts.start(t('dashboard.users.toast.password.pending', { username: user.username }));
      const result = await callApi(() => api.api.users[':id'].$patch({
        param: { id: String(user.id) },
        json: { password: form.password },
      }));
      if (result.error) {
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t('dashboard.users.toast.password.success', { username: user.username }));
      await onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>{discardConfirmation}<DialogShell
      open={open}
      actions={<DialogActions>
        <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
        <Button appearance="primary" disabledFocusable={saving} type="submit">
          {t('dashboard.users.actions.save')}
        </Button>
      </DialogActions>}
      onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
      onSubmit={() => void handleSubmit(save)()}
      title={<DialogTitle>{t('dashboard.users.dialog.passwordTitle', { username: user.username })}</DialogTitle>}
    >
      <Controller control={control} name="password" render={({ field }) => (
        <Field
          label={t('dashboard.users.form.newPassword')}
          validationMessage={errors.password?.message ? t(errors.password.message) : undefined}
          validationState={errors.password ? 'error' : undefined}
        >
          <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
        </Field>
      )} />
      <Controller control={control} name="confirmation" render={({ field }) => (
        <Field
          label={t('dashboard.users.form.confirmPassword')}
          validationMessage={errors.confirmation?.message ? t(errors.confirmation.message) : undefined}
          validationState={errors.confirmation ? 'error' : undefined}
        >
          <Input {...field} autoComplete="new-password" disabled={saving} type="password" />
        </Field>
      )} />
      {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    </DialogShell></>
  );
}
