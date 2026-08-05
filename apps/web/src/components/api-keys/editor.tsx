import { Database24Regular, History24Regular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { RetentionField, parsedRetention, type RetentionValue } from './retention-field';
import { keySourceFields, keyWriteBody, refineKeySource, type KeySource } from './source';
import { KeySourceControl } from './source-field';
import { api, callApi } from '../../api/client';
import type { ApiKey, ControlPlaneModel, UpstreamOption } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { type TFunction, useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { Input } from '../ui/fluent-form-controls';
import { OpenLinkLabel } from '../ui/open-link-label';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { RouteLink } from '../ui/route-link';
import { useDiscardGuard } from '../ui/use-discard-guard';
import { UpstreamAccessControl } from '../upstreams/access-control';
import { refineUpstreamAccess } from '../upstreams/access-validation';

const { Button, DialogActions, DialogTitle, Field } = fluentComponents;

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
          ...keySourceFields,
          upstreamOverride: z.boolean(),
          upstreamIds: z.array(z.string()),
          dumpRetention: z.union([z.number(), z.null(), z.literal('invalid')]),
          responsesRetention: z.union([z.number(), z.literal('invalid')]),
        })
        .superRefine((value, ctx) => {
          refineUpstreamAccess(value, ctx);
          // Rotation always re-reads the source; creation is the only other
          // moment a key's own text is set.
          if (isCreate) refineKeySource(value, ctx);
          for (const field of ['dumpRetention', 'responsesRetention'] as const) {
            if (value[field] === 'invalid') {
              ctx.addIssue({
                code: 'custom',
                message: 'dashboard.apiKeys.retention.invalid',
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
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });
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
    // The submit button stays focusable while this runs, so refusing here is
    // what makes a second press inert.
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const common = {
        name: values.name.trim(),
        upstream_ids: values.upstreamOverride ? values.upstreamIds : null,
        dump_retention_seconds: parsedRetention(values.dumpRetention),
        responses_retention_seconds: parsedRetention(values.responsesRetention),
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
        handle.settle();
        setError(result.error.message);
        return;
      }
      onOpenChange(false);
      handle.succeed(t(`dashboard.apiKeys.toast.${mutationKind}.success`, { name: common.name }));
      await onSaved(result.data);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>{discardConfirmation}<DialogShell
      width="editor"
      open={props.open}
      onOpenChange={(_, data) => { if (!data.open && !saving) requestClose(); }}
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
          <Button disabled={saving} onClick={requestClose}>
            {t('common.cancel')}
          </Button>
          <Button appearance="primary" disabledFocusable={saving} type="submit">
            {isCreate ? t('dashboard.apiKeys.actions.create') : t('dashboard.apiKeys.actions.save')}
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
              disabled={saving}
              icon={<History24Regular />}
              label={t('dashboard.apiKeys.form.retention')}
              offLabel={t('dashboard.apiKeys.retention.offCapture')}
              offValue={null}
              presets={dumpRetentionPresets}
              value={field.value}
              onChange={field.onChange}
            >
              {apiKey !== null && field.value !== null && field.value !== 'invalid'
                ? <RouteLink to={`/dashboard/monitor/requests?key=${encodeURIComponent(apiKey.id)}`}>
                    <OpenLinkLabel>{t('dashboard.apiKeys.form.viewCapturedRequests')}</OpenLinkLabel>
                  </RouteLink>
                : undefined}
            </RetentionField>
            {/* Outside the row: a consequence of saving that the operator has
                not opened the row to read is one they will not read at all. */}
            {retentionWarning !== null && (
              <OutcomeMessageBar intent="warning">{retentionWarning}</OutcomeMessageBar>
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
              disabled={saving}
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
              <OutcomeMessageBar intent="warning">{responsesRetentionWarning}</OutcomeMessageBar>
            )}
          </>
        )}
      />

      {error && (
        <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>
      )}
    </DialogShell></>
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
  prefix: 'dashboard.apiKeys.retention.warning' | 'dashboard.apiKeys.retention.responsesWarning',
  t: TFunction,
) => {
  if (previous === null || previous === 0 || next === 'invalid') return null;
  if (next === null || next === 0) return t(`${prefix}Disable`);
  if (next < previous) return t(`${prefix}Shrink`);
  return null;
};
