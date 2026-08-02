import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';

import { ProxyBackoffPanel } from './proxy-backoff-panel';
import { defaultsFor, parseDialTimeoutInput, parseProxyInput, proxyDraftIssues, type FormKind } from './proxy-config';
import { ProxyForm, type ProxyTestResult } from './proxy-form';
import { api, callApi } from '../../api/client';
import type { ProxyRecord, BackoffRow } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { DialogShell } from '../ui/dialog-shell';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri } from '@floway-dev/proxy/url';

const { Button, DialogActions, DialogTitle, MessageBar, MessageBarBody, Text } = fluentComponents;

const proxyDraftSignature = (name: string, config: ProxyConfig, urlDraft: string | null, dialTimeout: string) =>
  JSON.stringify([name, config, urlDraft, dialTimeout]);

const proxyDialogDraft = (record: ProxyRecord | null) => {
  if (record === null) {
    const config = defaultsFor('http', { host: '', port: 0, name: '' });
    return {
      config,
      dialTimeoutInput: '',
      editingId: null,
      formName: '',
      initialDraft: proxyDraftSignature('', config, null, ''),
      urlDraft: null,
      urlError: null,
    };
  }
  const parsed = parseProxyInput(record.url);
  if (parsed.config === null) throw new Error(parsed.error);
  const dialTimeoutInput = record.dial_timeout_seconds == null ? '' : String(record.dial_timeout_seconds);
  return {
    config: parsed.config,
    dialTimeoutInput,
    editingId: record.id,
    formName: record.name,
    initialDraft: proxyDraftSignature(record.name, parsed.config, record.url, dialTimeoutInput),
    urlDraft: record.url,
    urlError: parsed.error,
  };
};

export function ProxyDialog({ backoffs, onOpenChange, open, onSaved, record }: {
  backoffs: BackoffRow[];
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onSaved: () => Promise<void>;
  record: ProxyRecord | null;
}) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [initial] = useState(() => proxyDialogDraft(record));
  const { editingId, initialDraft } = initial;
  const [formName, setFormName] = useState(initial.formName);
  const [config, setConfig] = useState<ProxyConfig>(initial.config);
  const [urlDraft, setUrlDraft] = useState<string | null>(initial.urlDraft);
  const [urlError, setUrlError] = useState<string | null>(initial.urlError);
  const [dialTimeoutInput, setDialTimeoutInput] = useState(initial.dialTimeoutInput);
  const [saving, setSaving] = useState(false);
  const [showValidation, setShowValidation] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const structuredUrl = config.host.trim() ? formatProxyUri({ ...config, name: formName.trim() }) : '';
  const urlInput = urlDraft ?? structuredUrl;
  const dialTimeout = parseDialTimeoutInput(dialTimeoutInput);
  // Withheld until save: a form that reddens as it is filled in says nothing the operator did not know.
  const issues = proxyDraftIssues({ config, name: formName, url: urlInput });
  const draftDirty = initialDraft !== proxyDraftSignature(formName, config, urlDraft, dialTimeoutInput);
  const clearDiagnostics = useCallback(() => {
    setSaveError(null);
    setTestResult(null);
  }, []);
  const updateStructuredConfig = useCallback<Dispatch<SetStateAction<ProxyConfig>>>(update => {
    setConfig(update);
    setUrlDraft(null);
    setUrlError(null);
    clearDiagnostics();
  }, [clearDiagnostics]);
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
  const handleUrlChange = useCallback((value: string) => {
    clearDiagnostics();
    setUrlDraft(value);
    if (!value.trim()) {
      setUrlError(null);
      return;
    }
    const parsed = parseProxyInput(value.trim());
    setUrlError(parsed.error);
    if (parsed.config) setConfig(parsed.config);
  }, [clearDiagnostics]);
  const handleSave = useCallback(async () => {
    setShowValidation(true);
    setSaveError(null);
    // The submit button stays focusable while saving, so a second press re-enters here.
    if (saving) return;
    if (Object.keys(proxyDraftIssues({ config, name: formName, url: urlInput })).length > 0
      || urlError !== null || dialTimeout.error !== null) return;
    setSaving(true);
    const body = { name: formName.trim(), url: urlInput.trim(), dial_timeout_seconds: dialTimeout.value };
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
    onOpenChange(false);
    handle.succeed(t('dashboard.proxy.actions.saveSuccess'));
    await onSaved();
  }, [config, dialTimeout.error, dialTimeout.value, editingId, formName, onOpenChange, onSaved, saving, t, toasts, urlError, urlInput]);
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
  }, [dialTimeout, urlInput]);
  // Testing only dials: it needs a reachable endpoint and a timeout, nothing else the record carries.
  const canTest = issues.url === undefined && issues.host === undefined && issues.port === undefined
    && urlError === null && dialTimeout.error === null;

  return <DialogShell
    open={open}
    actions={<DialogActions>
      <Button className="!whitespace-nowrap" disabled={saving || testing} onClick={() => onOpenChange(false)} type="button">{t('common.cancel')}</Button>
      <Button className="!whitespace-nowrap" disabled={!canTest || saving} disabledFocusable={testing} onClick={() => void handleTest()} type="button">{t('dashboard.proxy.actions.test')}</Button>
      <Button appearance="primary" className="!whitespace-nowrap" disabled={testing} disabledFocusable={saving} type="submit">{t('dashboard.proxy.actions.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, data) => {
      if (!data.open && !saving && !testing && !draftDirty) onOpenChange(data.open);
    }}
    onSubmit={() => void handleSave()}
    title={<DialogTitle>{editingId === null ? t('dashboard.proxy.addTitle') : t('dashboard.proxy.editTitle')}</DialogTitle>}
  >
    {editingId !== null && <ProxyBackoffPanel backoffs={backoffs} onReset={() => void onSaved()} proxyId={editingId} />}
    <ProxyForm
      config={config}
      dialTimeoutError={dialTimeout.error}
      dialTimeoutInput={dialTimeoutInput}
      formName={formName}
      issues={showValidation ? issues : {}}
      onConfigChange={updateStructuredConfig}
      onDialTimeoutChange={value => { clearDiagnostics(); setDialTimeoutInput(value); }}
      onKindChange={handleKindChange}
      onNameChange={value => { clearDiagnostics(); setFormName(value); }}
      onPortChange={setPort}
      onUrlChange={handleUrlChange}
      urlError={urlError}
      urlInput={urlInput}
    />
    {testResult && <MessageBar intent={testResult.ok ? 'success' : 'error'}><MessageBarBody><div className="grid gap-1"><Text size={200} weight="semibold">{testResult.ok ? t('dashboard.proxy.test.ok') : t('dashboard.proxy.test.failed', { error: testResult.error })}</Text>{testResult.ok && <Text size={200} className="text-fui-fg3">{t('dashboard.proxy.test.egressIp', { ip: testResult.egress_ip })}</Text>}</div></MessageBarBody></MessageBar>}
    {saveError && <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>}
  </DialogShell>;
}
