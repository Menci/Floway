import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { ProxyBackoffPanel } from './backoff-panel';
import {
  defaultsFor,
  parseDialTimeoutInput,
  parseProxyInput,
  proxyDraftIssues,
  proxyDraftUrl,
  type FormKind,
  type ProxyFormValues,
} from './config';
import { ProxyForm, type ProxyTestResult } from './form';
import { api, callApi } from '../../api/client';
import type { ProxyRecord, BackoffRow } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DialogShell } from '../ui/dialog-shell';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { useDiscardGuard } from '../ui/use-discard-guard';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';

const { Button, DialogActions, DialogTitle } = fluentComponents;

const proxyDialogDefaults = (record: ProxyRecord | null): ProxyFormValues => {
  if (record === null) {
    return {
      config: defaultsFor('http', { host: '', port: 0, name: '' }),
      dialTimeout: '',
      name: '',
      url: null,
    };
  }
  const parsed = parseProxyInput(record.url);
  if (parsed.config === null) throw new Error(parsed.error);
  return {
    config: parsed.config,
    dialTimeout: record.dial_timeout_seconds == null ? '' : String(record.dial_timeout_seconds),
    name: record.name,
    url: record.url,
  };
};

const proxySchema = z.object({
  config: z.custom<ProxyConfig>(),
  dialTimeout: z.string(),
  name: z.string(),
  url: z.string().nullable(),
}).superRefine((values, ctx) => {
  const issues = proxyDraftIssues(values);
  for (const [path, message] of [
    [['name'], issues.name],
    [['url'], issues.url],
    [['dialTimeout'], issues.dialTimeout],
    ...Object.entries(issues.config).map(([field, message]) => [['config', field], message] as const),
  ] as const) {
    if (message !== undefined) ctx.addIssue({ code: 'custom', message, path: [...path] });
  }
});

export function ProxyDialog({ backoffs, onOpenChange, open, onSaved, record }: {
  backoffs: BackoffRow[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: () => Promise<void>;
  record: ProxyRecord | null;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [editingId] = useState(() => record?.id ?? null);
  const [defaultValues] = useState(() => proxyDialogDefaults(record));
  const {
    clearErrors,
    control,
    formState: { errors, isSubmitted },
    getValues,
    handleSubmit,
    setValue,
    trigger,
  } = useForm<ProxyFormValues>({ defaultValues, resolver: zodResolver(proxySchema) });
  // useWatch is typed DeepPartial, but every field of the draft has a default.
  const values = useWatch({ control }) as ProxyFormValues;
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const urlInput = proxyDraftUrl(values);
  const dialTimeout = parseDialTimeoutInput(values.dialTimeout);
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const { discardConfirmation, requestClose } = useDiscardGuard({ onClose: close, values });
  const clearDiagnostics = useCallback(() => {
    setSaveError(null);
    setTestResult(null);
  }, []);
  // The form's messages wait for the first save press and then track every edit,
  // which is what react-hook-form does on its own for the inputs it observes.
  // These values reach it through setValue, so the revalidation is spelled out.
  const revalidate = useCallback(() => {
    if (isSubmitted) void trigger();
  }, [isSubmitted, trigger]);
  const updateStructuredConfig = useCallback((update: (previous: ProxyConfig) => ProxyConfig) => {
    setValue('config', update(getValues('config')));
    setValue('url', null);
    clearErrors('url');
    clearDiagnostics();
    revalidate();
  }, [clearDiagnostics, clearErrors, getValues, revalidate, setValue]);
  const handleKindChange = useCallback((_: unknown, data: { optionValue?: string }) => {
    if (!data.optionValue) return;
    const next = data.optionValue as FormKind;
    updateStructuredConfig(previous => defaultsFor(next, { host: previous.host, port: previous.port, name: previous.name }));
  }, [updateStructuredConfig]);
  const setPort = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const value = trimmed === '' ? 0 : Number(trimmed);
    updateStructuredConfig(previous => ({ ...previous, port: Number.isFinite(value) ? value : 0 } as ProxyConfig));
  }, [updateStructuredConfig]);
  const handleNameChange = useCallback((value: string) => {
    clearDiagnostics();
    setValue('name', value);
    revalidate();
  }, [clearDiagnostics, revalidate, setValue]);
  const handleUrlChange = useCallback((value: string) => {
    clearDiagnostics();
    setValue('url', value);
    const parsed = value.trim() ? parseProxyInput(value.trim()) : null;
    if (parsed?.config) setValue('config', parsed.config);
    // A parse failure is about text the operator has already typed, so it does
    // not wait for the save press the way a still-empty field does.
    if (value.trim()) void trigger('url');
    else clearErrors('url');
    revalidate();
  }, [clearDiagnostics, clearErrors, revalidate, setValue, trigger]);
  const handleDialTimeoutChange = useCallback((value: string) => {
    clearDiagnostics();
    setValue('dialTimeout', value);
    void trigger('dialTimeout');
    revalidate();
  }, [clearDiagnostics, revalidate, setValue, trigger]);
  const save = useCallback(async (form: ProxyFormValues) => {
    setSaveError(null);
    // The submit button stays focusable while saving, so a second press re-enters here.
    if (saving) return;
    setSaving(true);
    const timeout = parseDialTimeoutInput(form.dialTimeout);
    const body = { name: form.name.trim(), url: proxyDraftUrl(form).trim(), dial_timeout_seconds: timeout.value };
    const handle = toasts.start(t('dashboard.proxy.toast.save.pending', { name: body.name }));
    const result = editingId === null
      ? await callApi(() => api.api.proxies.$post({ json: body }))
      : await callApi(() => api.api.proxies[':id'].$patch({ param: { id: editingId }, json: body }));
    if (result.error) {
      handle.settle();
      setSaveError(result.error.message);
      setSaving(false);
      return;
    }
    close();
    handle.succeed(t('dashboard.proxy.toast.save.success', { name: body.name }));
    await onSaved();
  }, [close, editingId, onSaved, saving, t, toasts]);
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const result = await callApi(() => api.api.proxies.test.$post({
      json: {
        url: urlInput.trim(),
        ...(dialTimeout.value === null ? {} : { dial_timeout_seconds: dialTimeout.value }),
      },
    }));
    setTestResult(result.error ? { ok: false, error: result.error.message } : result.data);
    setTesting(false);
  }, [dialTimeout.value, urlInput]);
  // Testing only dials: it needs a reachable endpoint and a timeout, nothing else
  // the record carries, so it reads the draft rather than the messages the form
  // has decided to show yet.
  const canTest = useMemo(() => {
    const issues = proxyDraftIssues(values);
    return issues.url === undefined && issues.dialTimeout === undefined
      && issues.config.host === undefined && issues.config.port === undefined;
  }, [values]);

  return <>{discardConfirmation}<DialogShell
    open={open}
    actions={<DialogActions>
      <Button className="!whitespace-nowrap" disabled={saving || testing} onClick={requestClose}>{t('common.cancel')}</Button>
      <Button className="!whitespace-nowrap" disabled={!canTest || saving} disabledFocusable={testing} onClick={() => void handleTest()}>{t('dashboard.proxy.actions.test')}</Button>
      <Button appearance="primary" className="!whitespace-nowrap" disabled={testing} disabledFocusable={saving} type="submit">{t('dashboard.proxy.actions.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, data) => {
      if (!data.open && !saving && !testing) requestClose();
    }}
    onSubmit={() => void handleSubmit(save)()}
    title={<DialogTitle>{editingId === null ? t('dashboard.proxy.addTitle') : t('dashboard.proxy.editTitle')}</DialogTitle>}
  >
    {editingId !== null && <ProxyBackoffPanel backoffs={backoffs} onReset={() => void onSaved()} proxyId={editingId} />}
    <ProxyForm
      config={values.config}
      dialTimeoutInput={values.dialTimeout}
      errors={errors}
      formName={values.name}
      onConfigChange={updateStructuredConfig}
      onDialTimeoutChange={handleDialTimeoutChange}
      onKindChange={handleKindChange}
      onNameChange={handleNameChange}
      onPortChange={setPort}
      onUrlChange={handleUrlChange}
      urlInput={urlInput}
    />
    {testResult && <OutcomeMessageBar
      intent={testResult.ok ? 'success' : 'error'}
      onDismiss={() => setTestResult(null)}
      title={testResult.ok ? t('dashboard.proxy.test.ok') : t('dashboard.proxy.test.failed')}
    >{testResult.ok ? t('dashboard.proxy.test.egressIp', { ip: testResult.egress_ip }) : testResult.error}</OutcomeMessageBar>}
    {saveError && <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>}
  </DialogShell></>;
}
