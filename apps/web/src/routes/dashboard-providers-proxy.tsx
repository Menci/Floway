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
import { Panel } from '../components/ui/panel';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri } from '@floway-dev/proxy/url';

const { Button, MessageBar, MessageBarBody, Text } = fluentComponents;

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
  const [saveSuccess, setSaveSuccess] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ProxyTestResult | null>(null);

  // Save/Test diagnostics describe one exact draft. Once the operator edits
  // any field, remove stale failures (and the saved confirmation) so the form
  // no longer presents feedback for values that are not on screen anymore.
  const structuredUrl = config.host.trim()
    ? formatProxyUri({ ...config, name: formName.trim() })
    : '';
  const urlInput = urlDraft ?? structuredUrl;
  const dialTimeout = parseDialTimeoutInput(dialTimeoutInput);
  const draftSignature = JSON.stringify([config, dialTimeoutInput, formName, urlDraft]);
  const [diagnosedDraft, setDiagnosedDraft] = useState(draftSignature);
  if (diagnosedDraft !== draftSignature) {
    setDiagnosedDraft(draftSignature);
    setSaveError(null);
    setSaveSuccess(false);
    setTestResult(current => current?.ok ? current : null);
  }

  const [deleteTarget, setDeleteTarget] = useState<ProxyRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  const updateStructuredConfig = useCallback<Dispatch<SetStateAction<ProxyConfig>>>(update => {
    setConfig(update);
    setUrlDraft(null);
    setUrlError(null);
  }, []);

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

  const clearForm = useCallback((saved = false) => {
    const blank = defaultsFor('http', { host: '', port: 0, name: '' });
    setEditingId(null);
    setFormName('');
    setConfig(blank);
    setUrlDraft(null);
    setUrlError(null);
    setDialTimeoutInput('');
    setDiagnosedDraft(JSON.stringify([blank, '', '', null]));
    setSaveSuccess(saved);
    setSaveError(null);
    setTestResult(null);
  }, []);

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
    setSaveSuccess(false);
    setSaveError(null);
    setTestResult(null);
  }, []);

  const handleUrlChange = useCallback((value: string) => {
    setUrlDraft(value);
    if (!value.trim()) {
      setUrlError(null);
      return;
    }
    const parsed = parseProxyInput(value.trim());
    setUrlError(parsed.error);
    if (parsed.config) setConfig(parsed.config);
  }, []);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const trimmedName = formName.trim();
    if (!trimmedName) {
      setSaveError(t('dashboard.proxy.validation.nameRequired'));
      setSaving(false);
      return;
    }

    const builtUrl = urlInput.trim();
    if (!builtUrl || urlError) {
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

    clearForm(true);
    await refreshProxies();
  }, [formName, urlInput, urlError, dialTimeout, editingId, clearForm, refreshProxies, t]);

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
  const canSave = formName.trim() !== '' && canTest;

  if (!user.isAdmin) {
    return (
      <section className="grid gap-[18px] min-w-0">
        <DashboardPageHeader description={t('dashboard.proxy.description')} eyebrow={t('dashboard.groups.providers')} title={t('dashboard.proxy.heading')} />
        <AdminOnlyNotice />
      </section>
    );
  }

  return (
    <section className="grid gap-[18px] min-w-0">
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

      <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-[18px] items-start min-w-0 max-[900px]:grid-cols-1">
        {loadError && proxies.length === 0
          ? <Panel className="grid gap-3 !p-[22px_24px]">
              <Text className="text-fui-fg2">{loadError}</Text>
              <Button className="w-fit" onClick={() => void refreshProxies()}>{t('dashboard.proxy.actions.refresh')}</Button>
            </Panel>
          : <ProxyList proxies={proxies} onAdd={() => clearForm()} onDelete={setDeleteTarget} onEdit={handleEdit} onRefresh={() => void refreshProxies()} />}
        <div className="grid gap-[18px] min-w-0">
          {editingId !== null && <ProxyBackoffPanel
            backoffs={backoffs}
            onReset={() => void refreshProxies()}
            proxyId={editingId}
          />}
          <ProxyForm
            canSave={canSave}
            canTest={canTest}
            config={config}
            dialTimeoutInput={dialTimeoutInput}
            editing={editingId !== null}
            formName={formName}
            onCancel={() => clearForm()}
            onConfigChange={updateStructuredConfig}
            onDialTimeoutChange={setDialTimeoutInput}
            onKindChange={handleKindChange}
            onNameChange={setFormName}
            onPortChange={setPort}
            onSave={() => void handleSave()}
            onTest={() => void handleTest()}
            onUrlChange={handleUrlChange}
            saveError={saveError}
            saveSuccess={saveSuccess}
            saving={saving}
            testResult={testResult}
            testing={testing}
            urlError={urlError}
            urlInput={urlInput}
          />
        </div>
      </div>

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
