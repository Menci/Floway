import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-proxy';
import { api, callApi, callApiNoContent } from '../api/client';
import type { ProxyConflictBody, ProxyRecord, BackoffRow } from '../api/types';
import { requireAdmin } from '../auth/require-admin';
import { getSessionToken } from '../auth/session';
import { ProxyBackoffPanel } from '../components/proxy/proxy-backoff-panel';
import { defaultsFor, parseDialTimeoutInput, parseProxyInput, proxyDraftIssues, type FormKind } from '../components/proxy/proxy-config';
import { ProxyForm, type ProxyTestResult } from '../components/proxy/proxy-form';
import { ProxyList } from '../components/proxy/proxy-list';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { DialogShell } from '../components/ui/dialog-shell';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri } from '@floway-dev/proxy/url';

const { Button, DialogActions, DialogTitle, MessageBar, MessageBarBody, Text } = fluentComponents;

const proxyDraftSignature = (name: string, config: ProxyConfig, urlDraft: string | null, dialTimeout: string) =>
  JSON.stringify([name, config, urlDraft, dialTimeout]);

interface LoaderData {
  proxies: ProxyRecord[];
  backoffs: BackoffRow[];
  error: string | null;
}

const loadPageData = async (): Promise<LoaderData> => {
  const [proxiesRes, backoffsRes] = await Promise.all([
    callApi(() => api.api.proxies.$get()),
    callApi(() => api.api.proxies.backoffs.$get()),
  ]);
  return {
    proxies: proxiesRes.data ?? [],
    backoffs: backoffsRes.data ?? [],
    error: proxiesRes.error?.message ?? backoffsRes.error?.message ?? null,
  };
};

export async function clientLoader(): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  if (!(await requireAdmin())) throw redirect('/dashboard/services/api-keys');
  return await loadPageData();
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Proxy | Floway' }];
}

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

function ProxyDialog({ backoffs, onOpenChange, open, onSaved, record }: {
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
  // Nothing is refused until the operator asks to save: every one of these has
  // a field of its own to say so on, and a form that reddens as it is filled in
  // says nothing the operator did not already know.
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
    // The button stays focusable while saving, so the form can still be
    // submitted from it; this is what makes the second press do nothing.
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
  // Testing asks a narrower question than saving: it dials, so it needs a
  // reachable endpoint and a timeout to dial under, and nothing else the record
  // would carry.
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

export default function DashboardProvidersProxy({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();

  const [proxies, setProxies] = useState(loaderData.proxies);
  const [loadError, setLoadError] = useState(loaderData.error);

  const [backoffs, setBackoffs] = useState(loaderData.backoffs);
  const editorDialog = useDialogInvocation<ProxyRecord | null>();
  const deleteDialog = useDialogInvocation<ProxyRecord>();
  const [mutating, setMutating] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The error belongs to the attempt that produced it. Opening the dialog for
  // another proxy starts a new attempt, so the previous one's failure is
  // cleared here rather than waiting for a dismissal that may never come.
  const openDeleteDialog = (target: ProxyRecord) => {
    setDeleteError(null);
    deleteDialog.open(target);
  };

  const refreshProxies = useCallback(async (signal: AbortSignal) => {
    setLoadError(null);
    const [proxiesRes, backoffsRes] = await Promise.all([
      callApi(() => api.api.proxies.$get(undefined, { init: { signal } })),
      callApi(() => api.api.proxies.backoffs.$get(undefined, { init: { signal } })),
    ]);
    // The two lists are set together or not at all: a torn pair shows proxies
    // from one round trip beside backoffs from another.
    if (signal.aborted) return;
    if (proxiesRes.data) setProxies(proxiesRes.data);
    if (backoffsRes.data) setBackoffs(backoffsRes.data);
    setLoadError(proxiesRes.error?.message ?? backoffsRes.error?.message ?? null);
  }, []);

  const { refresh, refreshing } = useRefresh(refreshProxies);

  const handleDeleteConfirm = useCallback(async (target: ProxyRecord) => {
    setMutating(true);
    setDeleteError(null);

    const handle = toasts.start(t('dashboard.proxy.toast.delete.pending', { name: target.name }));
    const result = await callApiNoContent(() => api.api.proxies[':id'].$delete({ param: { id: target.id } }));

    setMutating(false);
    if (result.error) {
      handle.settle();
      const raw = result.error.raw as ProxyConflictBody | undefined;
      if (
        raw?.referencing_upstream_ids &&
        raw.referencing_upstream_ids.length > 0
      ) {
        setDeleteError(
          `${t('dashboard.proxy.delete.conflict')} ${t('dashboard.proxy.delete.conflictWithIds', { ids: raw.referencing_upstream_ids.join(', ') })}`,
        );
      } else {
        setDeleteError(result.error.message);
      }
      return;
    }

    deleteDialog.close();
    handle.succeed(t('dashboard.proxy.toast.delete.success', { name: target.name }));
    await refresh();
  }, [deleteDialog, refresh, t, toasts]);

  return (
    <section className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createLabel={t('dashboard.proxy.actions.create')}
          onCreate={() => editorDialog.open(null)}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.proxy.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.proxy.description')}
        title={t('dashboard.proxy.heading')}
      />

      {loadError && (
        <OutcomeMessageBar onDismiss={() => setLoadError(null)}>{loadError}</OutcomeMessageBar>
      )}

      <ResourceListPanel>
        <ProxyList disabled={refreshing || mutating} proxies={proxies} onDelete={openDeleteDialog} onEdit={editorDialog.open} />
      </ResourceListPanel>

      {editorDialog.invocation && <ProxyDialog
        open={editorDialog.isOpen}
        backoffs={backoffs}
        key={editorDialog.invocation.key}
        onOpenChange={open => { if (!open) editorDialog.close(); }}
        onSaved={refresh}
        record={editorDialog.invocation.value}
      />}

      {deleteDialog.invocation && (
        <ConfirmDialog
          open={deleteDialog.isOpen}
          actionLabel={t('dashboard.proxy.actions.delete')}
          busy={mutating}
          error={deleteError}
          key={deleteDialog.invocation.key}
          message={t('dashboard.proxy.delete.message', {
            name: deleteDialog.invocation.value.name,
          })}
          onConfirm={() => void handleDeleteConfirm(deleteDialog.invocation!.value)}
          onDismissError={() => setDeleteError(null)}
          onOpenChange={open => {
            if (!open) deleteDialog.close();
          }}
          title={t('dashboard.proxy.delete.title')}
        />
      )}
    </section>
  );
}
