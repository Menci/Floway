import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import { useDashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ProxyConflictBody, ProxyRecord, BackoffRow } from '../api/types';
import { AdminOnlyNotice } from '../components/admin-only-notice';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { fluentComponents } from '../fluent';
import type { Route } from './+types/dashboard-providers-proxy';
import { getSessionToken } from '../auth/session';
import { ProxyBackoffPanel } from '../components/proxy/proxy-backoff-panel';
import { defaultsFor, isValidPort, parseDialTimeoutInput, parseProxyInput, type FormKind } from '../components/proxy/proxy-config';
import { ProxyForm, type ProxyTestResult } from '../components/proxy/proxy-form';
import { ProxyList } from '../components/proxy/proxy-list';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DialogShell } from '../components/ui/dialog-shell';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri } from '@floway-dev/proxy/url';

const { Button, DialogActions, DialogTitle, MessageBar, MessageBarBody, Spinner, Text } = fluentComponents;

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
  return await loadPageData();
}
export function meta({}: Route.MetaArgs) { return [{ title: 'Proxy | Floway' }]; }

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

function ProxyDialog({ backoffs, onDismiss, open, onSaved, record }: {
  backoffs: BackoffRow[];
  onDismiss: () => void;
  open: boolean;
  onSaved: () => Promise<void>;
  record: ProxyRecord | null;
}) {
  const { t } = useTranslation();
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
    setSaving(true);
    setSaveError(null);
    const trimmedName = formName.trim();
    if (!trimmedName) {
      setSaveError(t('dashboard.proxy.validation.nameRequired'));
      setSaving(false);
      return;
    }
    const builtUrl = urlInput.trim();
    if (!builtUrl || urlError || !config.host.trim() || !isValidPort(config.port)) {
      setSaveError(urlError ?? t('dashboard.proxy.validation.urlRequired'));
      setSaving(false);
      return;
    }
    if (dialTimeout.error) {
      setSaveError(t(`dashboard.proxy.validation.timeout.${dialTimeout.error}`));
      setSaving(false);
      return;
    }
    const body = { name: trimmedName, url: builtUrl, dial_timeout_seconds: dialTimeout.value };
    const result = editingId === null
      ? await callApi(() => api.api.proxies.$post({ json: body }))
      : await callApi(() => api.api.proxies[':id'].$patch({ param: { id: editingId }, json: body }));
    if (result.error) {
      setSaveError(result.error.message);
      setSaving(false);
      return;
    }
    onDismiss();
    await onSaved();
  }, [config.host, config.port, dialTimeout, editingId, formName, onDismiss, onSaved, t, urlError, urlInput]);
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
  const canTest = urlInput.trim() !== '' && urlError === null && dialTimeout.error === null && config.host.trim() !== '' && isValidPort(config.port);

  return <DialogShell
    open={open}
    actions={<DialogActions>
      <Button className="!whitespace-nowrap" disabled={saving || testing} onClick={onDismiss} type="button">{t('common.cancel')}</Button>
      <Button className="!whitespace-nowrap" disabled={!canTest || saving || testing} icon={testing ? <Spinner size="tiny" /> : undefined} onClick={() => void handleTest()} type="button">{testing ? t('dashboard.proxy.actions.testing') : t('dashboard.proxy.actions.test')}</Button>
      <Button appearance="primary" className="!whitespace-nowrap" disabled={saving || testing} icon={saving ? <Spinner size="tiny" /> : undefined} type="submit">{saving ? t('dashboard.proxy.actions.saving') : t('dashboard.proxy.actions.save')}</Button>
    </DialogActions>}
    onOpenChange={(_, data) => {
      if (!data.open && !saving && !testing && !draftDirty) onDismiss();
    }}
    onSubmit={() => void handleSave()}
    title={<DialogTitle>{editingId === null ? t('dashboard.proxy.addTitle') : t('dashboard.proxy.editTitle')}</DialogTitle>}
  >
    {editingId !== null && <ProxyBackoffPanel backoffs={backoffs} onReset={() => void onSaved()} proxyId={editingId} />}
    <ProxyForm
      config={config}
      dialTimeoutInput={dialTimeoutInput}
      formName={formName}
      onConfigChange={updateStructuredConfig}
      onDialTimeoutChange={value => { clearDiagnostics(); setDialTimeoutInput(value); }}
      onKindChange={handleKindChange}
      onNameChange={value => { clearDiagnostics(); setFormName(value); }}
      onPortChange={setPort}
      onUrlChange={handleUrlChange}
      showValidation={showValidation}
      urlError={urlError}
      urlInput={urlInput}
    />
    {testResult && <MessageBar intent={testResult.ok ? 'success' : 'error'}><MessageBarBody><div className="grid gap-1"><Text size={200} weight="semibold">{testResult.ok ? t('dashboard.proxy.test.ok') : t('dashboard.proxy.test.failed', { error: testResult.error })}</Text>{testResult.ok && <Text size={200} className="text-fui-fg3">{t('dashboard.proxy.test.egressIp', { ip: testResult.egress_ip })}</Text>}</div></MessageBarBody></MessageBar>}
    {saveError && <MessageBar intent="error"><MessageBarBody>{saveError}</MessageBarBody></MessageBar>}
  </DialogShell>;
}

export default function DashboardProvidersProxy({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();

  const [proxies, setProxies] = useState(loaderData.proxies);
  const [loadError, setLoadError] = useState(loaderData.error);

  const [backoffs, setBackoffs] = useState(loaderData.backoffs);
  const editorDialog = useDialogInvocation<ProxyRecord | null>();
  const [deleteTarget, setDeleteTarget] = useState<ProxyRecord | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refreshProxies = useCallback(async () => {
    setLoadError(null);
    const [proxiesRes, backoffsRes] = await Promise.all([
      callApi(() => api.api.proxies.$get()),
      callApi(() => api.api.proxies.backoffs.$get()),
    ]);
    if (proxiesRes.data) setProxies(proxiesRes.data);
    if (backoffsRes.data) setBackoffs(backoffsRes.data);
    setLoadError(proxiesRes.error?.message ?? backoffsRes.error?.message ?? null);
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await refreshProxies();
    setRefreshing(false);
  }, [refreshProxies]);

  const handleDeleteConfirm = useCallback(async (target: ProxyRecord) => {
    setDeleting(true);
    setDeleteError(null);

    const result = await callApi(() => api.api.proxies[':id'].$delete({ param: { id: target.id } }));

    setDeleting(false);
    if (result.error) {
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
      setDeleteOpen(false);
      return;
    }

    setDeleteOpen(false);
    await refreshProxies();
  }, [refreshProxies, t]);

  if (!user.isAdmin) {
    return (
      <section className="dashboard-page">
        <DashboardPageHeader description={t('dashboard.proxy.description')} eyebrow={t('dashboard.groups.providers')} title={t('dashboard.proxy.heading')} />
        <AdminOnlyNotice />
      </section>
    );
  }

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
        eyebrow={t('dashboard.groups.providers')}
        title={t('dashboard.proxy.heading')}
      />

      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      {deleteError && (
        <MessageBar intent="error">
          <MessageBarBody>{deleteError}</MessageBarBody>
        </MessageBar>
      )}

      <ResourceListPanel>
        <ProxyList disabled={refreshing || deleting} proxies={proxies} onDelete={target => { setDeleteTarget(target); setDeleteOpen(true); }} onEdit={editorDialog.open} />
      </ResourceListPanel>

      {editorDialog.invocation && <ProxyDialog
        open={editorDialog.isOpen}
        backoffs={backoffs}
        key={editorDialog.invocation.key}
        onDismiss={editorDialog.close}
        onSaved={refreshProxies}
        record={editorDialog.invocation.value}
      />}

      {deleteTarget && (
        <ConfirmDialog
          open={deleteOpen}
          actionLabel={
            deleting
              ? t('dashboard.proxy.actions.deleting')
              : t('dashboard.proxy.actions.delete')
          }
          busy={deleting}
          message={t('dashboard.proxy.delete.message', {
            name: deleteTarget.name,
          })}
          onConfirm={() => void handleDeleteConfirm(deleteTarget)}
          onOpenChange={open => {
            if (!deleting) setDeleteOpen(open);
          }}
          title={t('dashboard.proxy.delete.title')}
        />
      )}
    </section>
  );
}
