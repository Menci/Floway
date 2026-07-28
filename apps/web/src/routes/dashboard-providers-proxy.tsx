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
import { Panel } from '../components/ui/panel';
import { ResourceListToolbar } from '../components/ui/resource-list-toolbar';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri } from '@floway-dev/proxy/url';

const { Button, DialogActions, DialogTitle, MessageBar, MessageBarBody, Spinner } = fluentComponents;

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

export default function DashboardProvidersProxy({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();

  const [proxies, setProxies] = useState(loaderData.proxies);
  const [loadError, setLoadError] = useState(loaderData.error);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [backoffs, setBackoffs] = useState(loaderData.backoffs);
  const [formName, setFormName] = useState('');
  const [config, setConfig] = useState<ProxyConfig>(
    defaultsFor('http', { host: '', port: 0, name: '' }),
  );
  const [urlDraft, setUrlDraft] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [dialTimeoutInput, setDialTimeoutInput] = useState('');

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);
  const structuredUrl = config.host.trim()
    ? formatProxyUri({ ...config, name: formName.trim() })
    : '';
  const urlInput = urlDraft ?? structuredUrl;
  const dialTimeout = parseDialTimeoutInput(dialTimeoutInput);
  const clearDiagnostics = useCallback(() => {
    setSaveError(null);
    setTestResult(null);
  }, []);

  const [deleteTarget, setDeleteTarget] = useState<ProxyRecord | null>(null);
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

  const updateStructuredConfig = useCallback<Dispatch<SetStateAction<ProxyConfig>>>(update => {
    setConfig(update);
    setUrlDraft(null);
    setUrlError(null);
    clearDiagnostics();
  }, [clearDiagnostics]);

  const handleKindChange = useCallback(
    (_: unknown, data: { optionValue?: string }) => {
      if (!data.optionValue) return;
      const next = data.optionValue as FormKind;
      updateStructuredConfig(prev =>
        defaultsFor(next, {
          host: prev.host,
          port: prev.port,
          name: prev.name,
        }));
    },
    [updateStructuredConfig],
  );

  const setPort = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const n = trimmed === '' ? 0 : Number(trimmed);
    updateStructuredConfig(prev => ({ ...prev, port: Number.isFinite(n) ? n : 0 } as ProxyConfig));
  }, [updateStructuredConfig]);

  const clearForm = useCallback(() => {
    const blank = defaultsFor('http', { host: '', port: 0, name: '' });
    setEditingId(null);
    setFormName('');
    setConfig(blank);
    setUrlDraft(null);
    setUrlError(null);
    setDialTimeoutInput('');
    setSaveError(null);
    setTestResult(null);
  }, []);

  const openCreate = useCallback(() => {
    clearForm();
    setDialogOpen(true);
  }, [clearForm]);

  const handleEdit = useCallback((proxy: ProxyRecord) => {
    setEditingId(proxy.id);
    setFormName(proxy.name);
    setDialTimeoutInput(
      proxy.dial_timeout_seconds != null
        ? String(proxy.dial_timeout_seconds)
        : '',
    );
    const parsed = parseProxyInput(proxy.url);
    setConfig(parsed.config ?? defaultsFor('http', { host: '', port: 0, name: '' }));
    setUrlDraft(proxy.url);
    setUrlError(parsed.error);
    setSaveError(null);
    setTestResult(null);
    setDialogOpen(true);
  }, []);

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

  const handleNameChange = useCallback((value: string) => {
    clearDiagnostics();
    setFormName(value);
  }, [clearDiagnostics]);

  const handleDialTimeoutChange = useCallback((value: string) => {
    clearDiagnostics();
    setDialTimeoutInput(value);
  }, [clearDiagnostics]);

  const handleSave = useCallback(async () => {
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

    const body = {
      name: trimmedName,
      url: builtUrl,
      dial_timeout_seconds: dialTimeout.value,
    };

    const isEdit = editingId !== null;
    const result = isEdit
      ? await callApi(() => api.api.proxies[':id'].$patch({ param: { id: editingId }, json: body }))
      : await callApi(() => api.api.proxies.$post({ json: body }));

    setSaving(false);
    if (result.error) {
      setSaveError(result.error.message);
      return;
    }

    await refreshProxies();
    setDialogOpen(false);
    clearForm();
  }, [clearForm, config.host, config.port, dialTimeout, editingId, formName, refreshProxies, t, urlError, urlInput]);

  const handleTest = useCallback(async () => {
    const builtUrl = urlInput.trim();

    setTesting(true);
    setTestResult(null);

    const result = await callApi(() => api.api.proxies.test.$post({
      json: {
        url: builtUrl,
        ...(dialTimeout.value === null ? {} : { dial_timeout_seconds: dialTimeout.value }),
      },
    }));
    setTestResult(result.error ? { ok: false, error: result.error.message } : result.data);
    setTesting(false);
  }, [dialTimeout, urlInput]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);

    const result = await callApi(() => api.api.proxies[':id'].$delete({ param: { id: deleteTarget.id } }));

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
      setDeleteTarget(null);
      return;
    }

    setDeleteTarget(null);
    await refreshProxies();
  }, [deleteTarget, refreshProxies, t]);

  const canTest = urlInput.trim() !== '' && urlError === null && dialTimeout.error === null && config.host.trim() !== '' && isValidPort(config.port);
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
      <DashboardPageHeader description={t('dashboard.proxy.description')} eyebrow={t('dashboard.groups.providers')} title={t('dashboard.proxy.heading')} />

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

      <Panel className="grid gap-[14px] min-w-0 !p-[18px] overflow-hidden">
        <ResourceListToolbar
          createLabel={t('dashboard.proxy.addTitle')}
          detail={t('dashboard.proxy.count', { count: proxies.length })}
          onCreate={openCreate}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.proxy.actions.refresh')}
          refreshing={refreshing}
          title={t('dashboard.proxy.listTitle')}
        />
        <ProxyList proxies={proxies} onDelete={setDeleteTarget} onEdit={handleEdit} />
      </Panel>

      <DialogShell
        actions={<DialogActions>
          <Button className="!whitespace-nowrap" disabled={saving || testing} onClick={() => setDialogOpen(false)} type="button">{t('common.cancel')}</Button>
          <Button
            className="!whitespace-nowrap"
            disabled={!canTest || saving || testing}
            icon={testing ? <Spinner size="tiny" /> : undefined}
            onClick={() => void handleTest()}
            type="button"
          >
            {testing ? t('dashboard.proxy.actions.testing') : t('dashboard.proxy.actions.test')}
          </Button>
          <Button
            appearance="primary"
            className="!whitespace-nowrap"
            disabled={saving || testing}
            icon={saving ? <Spinner size="tiny" /> : undefined}
            type="submit"
          >
            {saving ? t('dashboard.proxy.actions.saving') : t('dashboard.proxy.actions.save')}
          </Button>
        </DialogActions>}
        onOpenChange={(_, data) => {
          if (!saving && !testing) setDialogOpen(data.open);
        }}
        onSubmit={() => void handleSave()}
        open={dialogOpen}
        title={<DialogTitle>{editingId === null ? t('dashboard.proxy.addTitle') : t('dashboard.proxy.editTitle')}</DialogTitle>}
      >
        {editingId !== null && (
          <ProxyBackoffPanel
            backoffs={backoffs}
            onReset={() => void refreshProxies()}
            proxyId={editingId}
          />
        )}
        <ProxyForm
          config={config}
          dialTimeoutInput={dialTimeoutInput}
          formName={formName}
          onConfigChange={updateStructuredConfig}
          onDialTimeoutChange={handleDialTimeoutChange}
          onKindChange={handleKindChange}
          onNameChange={handleNameChange}
          onPortChange={setPort}
          onUrlChange={handleUrlChange}
          saveError={saveError}
          testResult={testResult}
          urlError={urlError}
          urlInput={urlInput}
        />
      </DialogShell>

      {deleteTarget && (
        <ConfirmDialog
          actionLabel={
            deleting
              ? t('dashboard.proxy.actions.deleting')
              : t('dashboard.proxy.actions.delete')
          }
          busy={deleting}
          message={t('dashboard.proxy.delete.message', {
            name: deleteTarget.name,
          })}
          onConfirm={() => void handleDeleteConfirm()}
          onOpenChange={open => {
            if (!open && !deleting) setDeleteTarget(null);
          }}
          open
          title={t('dashboard.proxy.delete.title')}
        />
      )}
    </section>
  );
}
