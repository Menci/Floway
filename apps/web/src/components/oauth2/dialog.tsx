import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';

import { oauth2ProviderBody, oauth2ProviderFormDefaults, oauth2ProviderFormSchema, type OAuth2ClientAuthentication, type OAuth2ProviderFormValues } from './form';
import { api, callApi } from '../../api/client';
import type { OAuth2Provider } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { Dropdown, Input, Textarea } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { SecretInput } from '../ui/secret-input';
import { SettingsCard, SettingsSwitch } from '../ui/settings-card';
import { useDiscardGuard } from '../ui/use-discard-guard';

const { Button, DialogActions, DialogTitle, Field, Option } = fluentComponents;

const CLIENT_AUTHENTICATION: OAuth2ClientAuthentication[] = ['client_secret_post', 'client_secret_basic'];

export function OAuth2ProviderDialog({ onOpenChange, onSaved, open, provider }: {
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
  open: boolean;
  provider: OAuth2Provider | null;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const mode = provider === null ? 'create' : 'edit';
  const schema = useMemo(() => oauth2ProviderFormSchema(mode), [mode]);
  const [defaultValues] = useState(() => oauth2ProviderFormDefaults(provider));
  const { control, formState: { errors }, handleSubmit, setValue } = useForm<OAuth2ProviderFormValues>({
    defaultValues,
    resolver: zodResolver(schema),
  });
  const values = useWatch({ control }) as OAuth2ProviderFormValues;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });

  const message = (field: keyof OAuth2ProviderFormValues) => {
    const value = errors[field]?.message;
    return typeof value === 'string' ? t(value) : undefined;
  };

  const save = async (form: OAuth2ProviderFormValues) => {
    if (saving) return;
    setSaving(true);
    setSaveError(null);
    const body = oauth2ProviderBody(form);
    const name = body.display_name;
    const handle = toasts.start(t(`dashboard.oauth2.toast.${mode}.pending`, { name }));
    const result = provider === null
      ? await callApi(() => api.api.oauth2.providers.$post({
          json: {
            id: form.id.trim(),
            client_secret: form.clientSecret.trim(),
            ...body,
          },
        }))
      : await callApi(() => api.api.oauth2.providers[':id'].$put({
          param: { id: provider.id },
          json: {
            ...body,
            ...(form.clientSecret.trim() === '' ? {} : { client_secret: form.clientSecret.trim() }),
          },
        }));
    if (result.error) {
      handle.settle();
      setSaveError(result.error.message);
      setSaving(false);
      return;
    }
    close();
    handle.succeed(t(`dashboard.oauth2.toast.${mode}.success`, { name }));
    await onSaved();
  };

  return <>{discardConfirmation}<DialogShell
    width="editor"
    open={open}
    actions={<DialogActions>
      <Button disabled={saving} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button appearance="primary" disabledFocusable={saving} type="submit">{t('dashboard.oauth2.actions.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
    onSubmit={() => void handleSubmit(save)()}
    title={<DialogTitle>{provider === null
      ? t('dashboard.oauth2.dialog.createTitle')
      : t('dashboard.oauth2.dialog.editTitle', { name: provider.display_name })}</DialogTitle>}
  >
    <SettingsCard
      action={<SettingsSwitch
        checked={values.enabled}
        disabled={saving}
        label={t('dashboard.oauth2.form.enabled')}
        onChange={enabled => setValue('enabled', enabled)}
      />}
      description={t('dashboard.oauth2.form.enabledHint')}
      header={t('dashboard.oauth2.form.enabled')}
    />

    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Controller control={control} name="id" render={({ field }) => <Field
        hint={t('dashboard.oauth2.form.idHint')}
        label={t('dashboard.oauth2.form.id')}
        validationMessage={message('id')}
        validationState={errors.id ? 'error' : undefined}
      ><Input {...field} className="font-mono" disabled={saving || provider !== null} /></Field>} />
      <Controller control={control} name="displayName" render={({ field }) => <Field
        label={t('dashboard.oauth2.form.displayName')}
        validationMessage={message('displayName')}
        validationState={errors.displayName ? 'error' : undefined}
      ><Input {...field} disabled={saving} /></Field>} />
    </div>

    <Controller control={control} name="clientId" render={({ field }) => <Field
      label={t('dashboard.oauth2.form.clientId')}
      validationMessage={message('clientId')}
      validationState={errors.clientId ? 'error' : undefined}
    ><Input {...field} className="font-mono" disabled={saving} /></Field>} />

    <Controller control={control} name="clientSecret" render={({ field }) => <Field
      hint={provider?.client_secret_configured ? t('dashboard.oauth2.form.clientSecretPreserved') : undefined}
      label={t('dashboard.oauth2.form.clientSecret')}
      validationMessage={message('clientSecret')}
      validationState={errors.clientSecret ? 'error' : undefined}
    ><SecretInput {...field} disabled={saving} /></Field>} />

    <Controller control={control} name="authorizationEndpoint" render={({ field }) => <Field
      label={t('dashboard.oauth2.form.authorizationEndpoint')}
      validationMessage={message('authorizationEndpoint')}
      validationState={errors.authorizationEndpoint ? 'error' : undefined}
    ><Input {...field} className="font-mono" disabled={saving} /></Field>} />
    <Controller control={control} name="tokenEndpoint" render={({ field }) => <Field
      label={t('dashboard.oauth2.form.tokenEndpoint')}
      validationMessage={message('tokenEndpoint')}
      validationState={errors.tokenEndpoint ? 'error' : undefined}
    ><Input {...field} className="font-mono" disabled={saving} /></Field>} />
    <Controller control={control} name="userInfoEndpoint" render={({ field }) => <Field
      label={t('dashboard.oauth2.form.userInfoEndpoint')}
      validationMessage={message('userInfoEndpoint')}
      validationState={errors.userInfoEndpoint ? 'error' : undefined}
    ><Input {...field} className="font-mono" disabled={saving} /></Field>} />

    <Controller control={control} name="accessPolicy" render={({ field }) => <Field
      hint={t('dashboard.oauth2.form.accessPolicyHint')}
      label={t('dashboard.oauth2.form.accessPolicy')}
      validationMessage={message('accessPolicy')}
      validationState={errors.accessPolicy ? 'error' : undefined}
    ><Textarea
        {...field}
        className="font-mono"
        disabled={saving}
        placeholder={t('dashboard.oauth2.form.accessPolicyPlaceholder')}
        rows={9}
      /></Field>} />

    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Controller control={control} name="scopes" render={({ field }) => <Field
        hint={t('dashboard.oauth2.form.scopesHint')}
        label={t('dashboard.oauth2.form.scopes')}
      ><Input {...field} className="font-mono" disabled={saving} /></Field>} />
      <Controller control={control} name="clientAuthentication" render={({ field }) => <Field label={t('dashboard.oauth2.form.clientAuthentication')}>
        <Dropdown
          disabled={saving}
          onOptionSelect={(_, data) => data.optionValue !== undefined && field.onChange(data.optionValue)}
          selectedOptions={[field.value]}
          value={t(`dashboard.oauth2.clientAuthentication.${field.value}`)}
        >
          {CLIENT_AUTHENTICATION.map(value => <Option key={value} value={value}>{t(`dashboard.oauth2.clientAuthentication.${value}`)}</Option>)}
        </Dropdown>
      </Field>} />
    </div>

    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Controller control={control} name="userIdClaim" render={({ field }) => <Field
        hint={t('dashboard.oauth2.form.claimHint')}
        label={t('dashboard.oauth2.form.userIdClaim')}
        validationMessage={message('userIdClaim')}
        validationState={errors.userIdClaim ? 'error' : undefined}
      ><Input {...field} className="font-mono" disabled={saving} /></Field>} />
      <Controller control={control} name="usernameClaim" render={({ field }) => <Field
        hint={t('dashboard.oauth2.form.claimHint')}
        label={t('dashboard.oauth2.form.usernameClaim')}
        validationMessage={message('usernameClaim')}
        validationState={errors.usernameClaim ? 'error' : undefined}
      ><Input {...field} className="font-mono" disabled={saving} /></Field>} />
    </div>

    <Controller control={control} name="authorizationParams" render={({ field }) => <Field
      hint={t('dashboard.oauth2.form.authorizationParamsHint')}
      label={t('dashboard.oauth2.form.authorizationParams')}
      validationMessage={message('authorizationParams')}
      validationState={errors.authorizationParams ? 'error' : undefined}
    ><Textarea {...field} className="font-mono" disabled={saving} rows={5} /></Field>} />

    {saveError && <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>}
  </DialogShell></>;
}
