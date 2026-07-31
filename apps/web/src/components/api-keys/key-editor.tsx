import { Database24Regular, History24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import { z } from 'zod';

import { keyWriteBody, type KeySource } from './key-source';
import { KeySourceControl } from './key-source-control';
import { RetentionField, type RetentionValue } from './retention-field';
import type { UpstreamOption } from './types';
import { callApi } from '../../api/auth';
import { api } from '../../api/client';
import type { ApiKey, ControlPlaneModel } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { OpenLinkLabel } from '../ui/open-link-label';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { UpstreamAccessControl } from '../upstreams/upstream-access-control';
const { Button, DialogActions, DialogTitle, Field, MessageBar, MessageBarBody } = fluentComponents;
interface KeyFormValues { name: string; keySource: KeySource; customKey: string; upstreamOverride: boolean; upstreamIds: string[]; dumpRetention: RetentionValue; responsesRetention: Exclude<RetentionValue, null> }
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
interface KeyDialogCommonProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: (key: ApiKey) => Promise<void>;
  models: ControlPlaneModel[];
  upstreams: UpstreamOption[];
  userUpstreamIds: string[] | null;
}

type KeyDialogProps = KeyDialogCommonProps & (
  | { mode: 'create'; apiKey?: never }
  | { mode: 'edit'; apiKey: ApiKey }
);

export function KeyDialog(props: KeyDialogProps) {
  const { mode, models, onOpenChange, onSaved, upstreams, userUpstreamIds } = props;
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const isCreate = mode === 'create';
  const apiKey = props.mode === 'edit' ? props.apiKey : null;
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
              message: 'dashboard.upstreamAccess.validation',
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
  // Both retentions are enforced by the same expiration sweep, so shortening
  // either one strands what already sits outside the new window. The Responses
  // side is worth saying out loud twice over: a client holds those ids and asks
  // for them back.
  const retentionWarning = retentionWarningText(
    apiKey?.dump_retention_seconds ?? null,
    values.dumpRetention,
    'dashboard.apiKeys.retention.warning',
    t,
  );
  const responsesRetentionWarning = retentionWarningText(
    apiKey?.responses_retention_seconds ?? null,
    values.responsesRetention,
    'dashboard.apiKeys.retention.responsesWarning',
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
    const handle = toasts.start(t(`dashboard.apiKeys.toast.${mutationKind}.pending`, { name: common.name }));
    const result = props.mode === 'create'
      ? await callApi(() => api.api.keys.$post({
          json: { ...common, ...keyWriteBody(values.keySource, values.customKey) },
        }))
      : await callApi(() => api.api.keys[':id'].$patch({
          param: { id: props.apiKey.id },
          json: common,
        }));
    if (result.error) {
      setSaving(false);
      handle.settle();
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    handle.succeed(t(`dashboard.apiKeys.toast.${mutationKind}.success`, { name: common.name }));
    await onSaved(result.data);
  };

  return (
    <DialogShell
      maxWidth="720px"
      open={props.open}
      onOpenChange={(_, data) => !saving && onOpenChange(data.open)}
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

      <UpstreamAccessControl
        available={visibleUpstreams}
        disabled={saving}
        error={errors.upstreamIds?.message ? t(errors.upstreamIds.message) : null}
        ids={values.upstreamIds}
        models={models}
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
          <>
            <RetentionField
              description={t('dashboard.apiKeys.form.retentionHint')}
              icon={<History24Regular />}
              label={t('dashboard.apiKeys.form.retention')}
              offLabel={t('dashboard.apiKeys.retention.offCapture')}
              offValue={null}
              presets={dumpRetentionPresets}
              value={field.value}
              onChange={field.onChange}
            >
              {apiKey !== null && field.value !== null && field.value !== 'invalid'
                ? <Link className="text-fui-brand1 no-underline hover:underline" to={`/dashboard/monitor/requests?key=${encodeURIComponent(apiKey.id)}`}>
                    <OpenLinkLabel>{t('dashboard.apiKeys.form.viewCapturedRequests')}</OpenLinkLabel>
                  </Link>
                : undefined}
            </RetentionField>
            {/* Outside the row rather than behind its disclosure: this is what
                saving is about to do, and a consequence the operator has not
                opened the row to read is one they will not read at all. */}
            {retentionWarning !== null && (
              <MessageBar intent="warning"><MessageBarBody>{retentionWarning}</MessageBarBody></MessageBar>
            )}
          </>
        )}
      />

      <Controller
        control={control}
        name="responsesRetention"
        render={({ field }) => (
          <>
            <RetentionField
              customInputUnit="days"
              description={t('dashboard.apiKeys.form.responsesRetentionHint')}
              icon={<Database24Regular />}
              label={t('dashboard.apiKeys.form.responsesRetention')}
              maximumSeconds={RESPONSES_RETENTION_MAX_SECONDS}
              minimumSeconds={86400}
              offLabel={t('dashboard.apiKeys.retention.offPersist')}
              offValue={0}
              presets={responsesRetentionPresets}
              value={field.value}
              onChange={field.onChange}
            />
            {responsesRetentionWarning !== null && (
              <MessageBar intent="warning"><MessageBarBody>{responsesRetentionWarning}</MessageBarBody></MessageBar>
            )}
          </>
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

// `null` and `0` are the same statement in different fields -- keep nothing --
// so both read as the retention being off.
const retentionWarningText = (
  previous: number | null,
  next: number | null | 'invalid',
  prefix: string,
  t: ReturnType<typeof useTranslation>['t'],
) => {
  if (previous === null || previous === 0 || next === 'invalid') return null;
  if (next === null || next === 0) return t(`${prefix}Disable`);
  if (next < previous) return t(`${prefix}Shrink`);
  return null;
};
