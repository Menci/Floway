import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';

import { keyWriteBody, type KeySource } from './key-source';
import { KeySourceControl } from './key-source-control';
import type { MutationToastController, UpstreamOption } from './types';
import { UpstreamPicker } from './upstream-picker';
import { authFetch, callApi } from '../../api/auth';
import type { ApiKey } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { DialogShell } from '../ui/dialog-shell';
import { Input, Select } from '../ui/fluent-form-controls';
const { Button, DialogActions, DialogTitle, Field, MessageBar, MessageBarBody, Text } = fluentComponents;
type RetentionPreset = 'off' | '1h' | '6h' | '24h' | '7d' | 'custom';
interface KeyFormValues { name: string; keySource: KeySource; customKey: string; upstreamOverride: boolean; upstreamIds: string[]; retentionPreset: RetentionPreset; retentionCustom: string }
interface CreateKeyBody { name: string; upstream_ids: string[] | null; dump_retention_seconds: number | null; key_source: KeySource; custom_key?: string }
interface UpdateKeyBody { name: string; upstream_ids: string[] | null; dump_retention_seconds: number | null }
const retentionPresetSeconds = { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 } as const;
const dumpRetentionMaxSeconds = 10 * 365 * 24 * 60 * 60;
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
  const [showUpstreamTable, setShowUpstreamTable] = useState(false);

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
          retentionPreset: z.enum(['off', '1h', '6h', '24h', '7d', 'custom']),
          retentionCustom: z.string(),
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
          if (
            value.retentionPreset === 'custom' &&
            parseDuration(value.retentionCustom) === null
          ) {
            ctx.addIssue({
              code: 'custom',
              message: 'dashboard.apiKeys.validation.retentionInvalid',
              path: ['retentionCustom'],
            });
          }
        }),
    [isCreate],
  );

  const {
    control,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<KeyFormValues>({
    resolver: zodResolver(schema),
    defaultValues: keyFormDefaults(apiKey),
  });

  useEffect(() => {
    if (!open) {
      setShowUpstreamTable(false);
      return;
    }
    reset(keyFormDefaults(apiKey));
    setError(null);
    const timer = window.setTimeout(() => setShowUpstreamTable(true), 220);
    return () => window.clearTimeout(timer);
  }, [apiKey, open, reset]);

  const values = watch();
  const proposedRetention = retentionSecondsFromForm(values);
  const retentionWarning = retentionWarningText(
    apiKey?.dump_retention_seconds ?? null,
    proposedRetention,
    t,
  );

  const save = async (values: KeyFormValues) => {
    const retention = retentionSecondsFromForm(values);
    if (retention === 'invalid') return;

    setSaving(true);
    setError(null);
    const common = {
      name: values.name.trim(),
      upstream_ids: values.upstreamOverride ? values.upstreamIds : null,
      dump_retention_seconds: retention,
    };
    const mutationKind = isCreate ? 'create' : 'edit';
    const toastId = mutationToasts.start(mutationKind, common.name);
    const result = isCreate
      ? await callApi<ApiKey>(() =>
          authFetch('/api/keys', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              ...common,
              ...keyWriteBody(values.keySource, values.customKey),
            } satisfies CreateKeyBody),
          }))
      : await callApi<ApiKey>(() =>
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
        showTable={showUpstreamTable}
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

      <div className="grid gap-3 grid-cols-2 min-w-0 max-[900px]:grid-cols-1">
        <Controller
          control={control}
          name="retentionPreset"
          render={({ field }) => (
            <Field
              hint={t('dashboard.apiKeys.form.retentionHint')}
              label={t('dashboard.apiKeys.form.retention')}
            >
              <Select {...field} disabled={saving}>
                <option value="off">{t('dashboard.apiKeys.retention.off')}</option>
                <option value="1h">{t('dashboard.apiKeys.retention.1h')}</option>
                <option value="6h">{t('dashboard.apiKeys.retention.6h')}</option>
                <option value="24h">{t('dashboard.apiKeys.retention.24h')}</option>
                <option value="7d">{t('dashboard.apiKeys.retention.7d')}</option>
                <option value="custom">
                  {t('dashboard.apiKeys.retention.custom')}
                </option>
              </Select>
            </Field>
          )}
        />
        {values.retentionPreset === 'custom' && (
          <Controller
            control={control}
            name="retentionCustom"
            render={({ field }) => (
              <Field
                label={t('dashboard.apiKeys.form.retentionCustom')}
                validationMessage={
                  errors.retentionCustom?.message
                    ? t(errors.retentionCustom.message)
                    : undefined
                }
                validationState={errors.retentionCustom ? 'error' : undefined}
              >
                <Input
                  {...field}
                  disabled={saving}
                  placeholder={t('dashboard.apiKeys.form.retentionPlaceholder')}
                />
              </Field>
            )}
          />
        )}
      </div>

      {retentionWarning && (
        <MessageBar intent="warning">
          <MessageBarBody>{retentionWarning}</MessageBarBody>
        </MessageBar>
      )}

      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
    </DialogShell>
  );
}

const keyFormDefaults = (apiKey: ApiKey | null): KeyFormValues => {
  const retention = retentionPresetFromValue(apiKey?.dump_retention_seconds ?? null);
  return {
    name: apiKey?.name ?? '',
    keySource: 'generate',
    customKey: '',
    upstreamOverride: apiKey?.upstream_ids !== null && apiKey?.upstream_ids !== undefined,
    upstreamIds: apiKey?.upstream_ids ?? [],
    retentionPreset: retention.preset,
    retentionCustom: retention.custom,
  };
};

const retentionPresetFromValue = (
  seconds: number | null,
): { preset: RetentionPreset; custom: string } => {
  if (seconds === null) return { preset: 'off', custom: '' };
  for (const [preset, value] of Object.entries(retentionPresetSeconds)) {
    if (value === seconds) return { preset: preset as RetentionPreset, custom: '' };
  }
  if (seconds % 86400 === 0) return { preset: 'custom', custom: `${seconds / 86400}d` };
  if (seconds % 3600 === 0) return { preset: 'custom', custom: `${seconds / 3600}h` };
  if (seconds % 60 === 0) return { preset: 'custom', custom: `${seconds / 60}m` };
  return { preset: 'custom', custom: `${seconds}s` };
};

const retentionSecondsFromForm = (
  values: Pick<KeyFormValues, 'retentionPreset' | 'retentionCustom'>,
): number | null | 'invalid' => {
  if (values.retentionPreset === 'off') return null;
  if (values.retentionPreset === 'custom') {
    return parseDuration(values.retentionCustom) ?? 'invalid';
  }
  return retentionPresetSeconds[values.retentionPreset];
};

const parseDuration = (value: string): number | null => {
  const trimmed = value.trim().toLowerCase();
  const match = /^(\d+)\s*([smhd])?$/.exec(trimmed);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = match[2] ?? 's';
  const multiplier = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  const seconds = amount * multiplier;
  return seconds <= dumpRetentionMaxSeconds ? seconds : null;
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
