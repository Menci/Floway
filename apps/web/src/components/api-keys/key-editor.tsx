import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { keyWriteBody, type KeySource } from './key-source';
import { KeySourceControl } from './key-source-control';
import { RetentionField, type RetentionValue } from './retention-field';
import type { MutationToastController, UpstreamOption } from './types';
import { UpstreamPicker } from './upstream-picker';
import { authFetch, callJson } from '../../api/auth';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
const { Button, DialogActions, DialogTitle, Field, MessageBar, MessageBarBody, Link } = fluentComponents;
interface KeyFormValues { name: string; keySource: KeySource; customKey: string; upstreamOverride: boolean; upstreamIds: string[]; dumpRetention: RetentionValue; responsesRetention: Exclude<RetentionValue, null> }
interface CreateKeyBody { name: string; upstream_ids: string[] | null; dump_retention_seconds: number | null; responses_retention_seconds: number; key_source: KeySource; custom_key?: string }
interface UpdateKeyBody { name: string; upstream_ids: string[] | null; dump_retention_seconds: number | null; responses_retention_seconds: number }
const RESPONSES_RETENTION_MAX_SECONDS = 10 * 365 * 86400;

const DUMP_RETENTION_PRESETS = [
  { seconds: 3600, labelKey: 'oneHour' },
  { seconds: 6 * 3600, labelKey: 'sixHours' },
  { seconds: 24 * 3600, labelKey: 'oneDay' },
  { seconds: 7 * 86400, labelKey: 'sevenDays' },
] as const;

const RESPONSES_RETENTION_PRESETS = [
  { seconds: 7 * 86400, labelKey: 'sevenDays' },
  { seconds: 30 * 86400, labelKey: 'thirtyDays' },
] as const;
export function KeyDialog({
  apiKey,
  mode,
  mutationToasts,
  onOpenChange,
  onSaved,
  open,
  upstreams,
  userUpstreamIds,
}: {
  apiKey: ApiKey | null;
  mode: 'create' | 'edit';
  mutationToasts: MutationToastController;
  onOpenChange: (open: boolean) => void;
  onSaved: (key: ApiKey) => Promise<void>;
  open: boolean;
  upstreams: UpstreamOption[];
  userUpstreamIds: string[] | null;
}) {
  const { t } = useTranslation();
  const isCreate = mode === 'create';
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const visibleUpstreams = useMemo(() => {
    if (userUpstreamIds === null) return upstreams;
    const allowed = new Set(userUpstreamIds);
    return upstreams.filter(upstream => allowed.has(upstream.id));
  }, [upstreams, userUpstreamIds]);

  const schema = useMemo(
    () =>
      z
        .object({
          name: z.string().trim().min(1, 'dashboard.apiKeys.validation.nameRequired'),
          keySource: z.enum(['generate', 'custom']),
          customKey: z.string(),
          upstreamOverride: z.boolean(),
          upstreamIds: z.array(z.string()),
          dumpRetention: z.union([z.number(), z.null(), z.literal('invalid')]),
          responsesRetention: z.union([z.number(), z.literal('invalid')]),
        })
        .superRefine((value, ctx) => {
          if (value.upstreamOverride && value.upstreamIds.length === 0) {
            ctx.addIssue({
              code: 'custom',
              message: 'dashboard.apiKeys.validation.upstreamRequired',
              path: ['upstreamIds'],
            });
          }
          if (isCreate && value.keySource === 'custom' && !value.customKey.trim()) {
            ctx.addIssue({
              code: 'custom',
              message: 'dashboard.apiKeys.validation.customKeyRequired',
              path: ['customKey'],
            });
          }
          for (const field of ['dumpRetention', 'responsesRetention'] as const) {
            if (value[field] === 'invalid') {
              ctx.addIssue({
                code: 'custom',
                message: 'dashboard.apiKeys.validation.retentionInvalid',
                path: [field],
              });
            }
          }
        }),
    [isCreate],
  );

  const {
    control,
    handleSubmit,
    setValue,
    formState: { errors },
  } = useForm<KeyFormValues>({
    resolver: zodResolver(schema),
    defaultValues: keyFormDefaults(apiKey),
  });

  const values = useWatch({ control }) as KeyFormValues;
  const dumpRetentionPresets = DUMP_RETENTION_PRESETS.map(preset => ({
    seconds: preset.seconds,
    label: t(`dashboard.apiKeys.retention.presets.${preset.labelKey}`),
  }));
  const responsesRetentionPresets = RESPONSES_RETENTION_PRESETS.map(preset => ({
    seconds: preset.seconds,
    label: t(`dashboard.apiKeys.retention.presets.${preset.labelKey}`),
  }));
  const retentionWarning = retentionWarningText(
    apiKey?.dump_retention_seconds ?? null,
    values.dumpRetention,
    t,
  );

  const save = async (values: KeyFormValues) => {
    if (values.dumpRetention === 'invalid' || values.responsesRetention === 'invalid') return;

    setSaving(true);
    setError(null);
    const common = {
      name: values.name.trim(),
      upstream_ids: values.upstreamOverride ? values.upstreamIds : null,
      dump_retention_seconds: values.dumpRetention,
      responses_retention_seconds: values.responsesRetention,
    };
    const mutationKind = isCreate ? 'create' : 'edit';
    const toastId = mutationToasts.start(mutationKind, common.name);
    const result = isCreate
      ? await callJson<ApiKey>(() =>
          authFetch('/api/keys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...common,
              ...keyWriteBody(values.keySource, values.customKey),
            } satisfies CreateKeyBody),
          }))
      : await callJson<ApiKey>(() =>
          authFetch(`/api/keys/${encodeURIComponent(apiKey!.id)}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(common satisfies UpdateKeyBody),
          }));
    setSaving(false);

    if (result.error) {
      mutationToasts.fail(toastId, mutationKind, common.name, result.error.message);
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    mutationToasts.succeed(toastId, mutationKind, common.name);
    await onSaved(result.data);
  };

  return (
    <DialogShell
      open={open}
      onOpenChange={(_, data) => onOpenChange(data.open)}
      onSubmit={() => void handleSubmit(save)()}
      title={
        <DialogTitle>
          {isCreate
            ? t('dashboard.apiKeys.dialog.createTitle')
            : t('dashboard.apiKeys.dialog.editTitle')}
        </DialogTitle>
      }
      actions={
        <DialogActions>
          <Button disabled={saving} onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button appearance="primary" disabled={saving} type="submit">
            {saving
              ? t('dashboard.apiKeys.actions.saving')
              : isCreate
                ? t('dashboard.apiKeys.actions.create')
                : t('dashboard.apiKeys.actions.save')}
          </Button>
        </DialogActions>
      }
    >
      <Controller
        control={control}
        name="name"
        render={({ field }) => (
          <Field
            label={t('dashboard.apiKeys.form.name')}
            validationMessage={errors.name?.message ? t(errors.name.message) : undefined}
            validationState={errors.name ? 'error' : undefined}
          >
            <Input {...field} disabled={saving} />
          </Field>
        )}
      />

      <UpstreamPicker
        available={visibleUpstreams}
        disabled={saving}
        error={errors.upstreamIds?.message ? t(errors.upstreamIds.message) : null}
        ids={values.upstreamIds}
        override={values.upstreamOverride}
        onChange={next => {
          setValue('upstreamOverride', next.override, { shouldValidate: true });
          setValue('upstreamIds', next.ids, { shouldValidate: true });
        }}
      />

      {isCreate && (
        <KeySourceControl
          customKey={values.customKey}
          disabled={saving}
          error={errors.customKey?.message ? t(errors.customKey.message) : undefined}
          onCustomKeyChange={value => setValue('customKey', value, { shouldValidate: true })}
          onSourceChange={value => setValue('keySource', value, { shouldValidate: true })}
          source={values.keySource}
        />
      )}

      <Controller
        control={control}
        name="dumpRetention"
        render={({ field }) => (
          <RetentionField
            description={t('dashboard.apiKeys.form.retentionHint')}
            label={t('dashboard.apiKeys.form.retention')}
            offLabel={t('dashboard.apiKeys.retention.offCapture')}
            offValue={null}
            presets={dumpRetentionPresets}
            value={field.value}
            onChange={field.onChange}
          >
            {retentionWarning !== null && (
              <MessageBar intent="warning"><MessageBarBody>{retentionWarning}</MessageBarBody></MessageBar>
            )}
            {apiKey !== null && field.value !== null && field.value !== 'invalid' && (
              <Link href={`/dashboard/monitor/requests?key=${encodeURIComponent(apiKey.id)}`}>
                {t('dashboard.apiKeys.form.viewCapturedRequests')}
              </Link>
            )}
          </RetentionField>
        )}
      />

      <Controller
        control={control}
        name="responsesRetention"
        render={({ field }) => (
          <RetentionField
            customInputUnit="days"
            description={t('dashboard.apiKeys.form.responsesRetentionHint')}
            label={t('dashboard.apiKeys.form.responsesRetention')}
            maximumSeconds={RESPONSES_RETENTION_MAX_SECONDS}
            minimumSeconds={86400}
            offLabel={t('dashboard.apiKeys.retention.offPersist')}
            offValue={0}
            presets={responsesRetentionPresets}
            value={field.value}
            onChange={field.onChange}
          />
        )}
      />

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
    </DialogShell>
  );
}

const keyFormDefaults = (apiKey: ApiKey | null): KeyFormValues => {
  return {
    name: apiKey?.name ?? '',
    keySource: 'generate',
    customKey: '',
    upstreamOverride: apiKey?.upstream_ids !== null && apiKey?.upstream_ids !== undefined,
    upstreamIds: apiKey?.upstream_ids ?? [],
    dumpRetention: apiKey?.dump_retention_seconds ?? null,
    responsesRetention: apiKey?.responses_retention_seconds ?? 0,
  };
};

const retentionWarningText = (
  previous: number | null,
  next: number | null | 'invalid',
  t: ReturnType<typeof useTranslation>['t'],
) => {
  if (previous === null || next === 'invalid') return null;
  if (next === null) return t('dashboard.apiKeys.retention.warningDisable');
  if (next < previous) return t('dashboard.apiKeys.retention.warningShrink');
  return null;
};
