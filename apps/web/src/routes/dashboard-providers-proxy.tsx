import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import { authFetch, callApi } from '../api/auth';
import { api } from '../api/client';
import type { ProxyConflictBody, ProxyRecord, BackoffRow } from '../api/types';
import type { Route } from './+types/dashboard-providers-proxy';
import { defaultsFor, isValidPort, parseSavedUrl, type FormKind } from '../components/proxy/proxy-config';
import { PageLoadingPanel } from '../components/ui/page-loading-panel';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';
import { useDashboardOutletContext } from './dashboard';
import { getSessionToken } from '../auth/session';
import { ProxyBackoffPanel } from '../components/proxy/proxy-backoff-panel';
import { ProxyForm } from '../components/proxy/proxy-form';
import { ProxyList } from '../components/proxy/proxy-list';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import type { ProxyConfig } from '@floway-dev/proxy/proxy-config';
import { formatProxyUri } from '@floway-dev/proxy/url';

const { MessageBar, MessageBarBody, Text } = fluentComponents;

function ProxyPageHeader() {
  const { t } = useTranslation();
  return <header className="grid gap-[6px]"><Text size={200} weight="semibold" className="text-fui-fg2 leading-[1.2] uppercase">{t('dashboard.groups.providers')}</Text><Text size={700} weight="semibold">{t('dashboard.proxy.heading')}</Text><Text size={300} className="text-fui-fg2 leading-[1.45] max-w-[760px]">{t('dashboard.proxy.description')}</Text></header>;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export async function clientLoader() { if (!getSessionToken()) throw redirect('/'); return null; }
export function meta({}: Route.MetaArgs) { return [{ title: 'Proxy | Floway' }]; }

export default function DashboardProvidersProxy() {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();

  // ---- data ----
  const [proxies, setProxies] = useState<ProxyRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ---- form ----
  const [editingId, setEditingId] = useState<string | null>(null);
  const [backoffs, setBackoffs] = useState<BackoffRow[]>([]);
  const [formName, setFormName] = useState('');
  // Config is always set — defaults to HTTP so the structured form is always visible.
  const [config, setConfig] = useState<ProxyConfig>(
    defaultsFor('http', { host: '', port: 0, name: '' }),
  );
  const [dialTimeoutInput, setDialTimeoutInput] = useState('');

  // ---- save ----
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // ---- test ----
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    egress_ip?: string;
    error?: string;
  } | null>(null);

  // Save/Test diagnostics describe one exact draft. Once the operator edits
  // any field, remove stale failures (and the saved confirmation) so the form
  // no longer presents feedback for values that are not on screen anymore.
  const draftSignature = JSON.stringify([config, dialTimeoutInput, formName]);
  const [diagnosedDraft, setDiagnosedDraft] = useState(draftSignature);
  if (diagnosedDraft !== draftSignature) {
    setDiagnosedDraft(draftSignature);
    setSaveError(null);
    setSaveSuccess(false);
    setTestResult(current => current?.ok ? current : null);
  }

  // ---- delete ----
  const [deleteTarget, setDeleteTarget] = useState<ProxyRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ---- load data ----
  const refreshProxies = useCallback(async () => {
    const [proxiesRes, backoffsRes] = await Promise.all([
      callApi<ProxyRecord[]>(() => api.api.proxies.$get()),
      callApi<BackoffRow[]>(() => api.api.proxies.backoffs.$get()),
    ]);
    if (proxiesRes.data) setProxies(proxiesRes.data);
    if (backoffsRes.data) setBackoffs(backoffsRes.data);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [proxiesRes, backoffsRes] = await Promise.all([
        callApi<ProxyRecord[]>(() => api.api.proxies.$get()),
        callApi<BackoffRow[]>(() => api.api.proxies.backoffs.$get()),
      ]);
      if (cancelled) return;
      if (proxiesRes.error) {
        setLoadError(proxiesRes.error.message);
      } else if (proxiesRes.data) {
        setProxies(proxiesRes.data);
      }
      if (backoffsRes.data) setBackoffs(backoffsRes.data);
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- form: protocol switch ----

  const handleKindChange = useCallback(
    (_: unknown, data: { optionValue?: string }) => {
      if (!data.optionValue) return;
      const next = data.optionValue as FormKind;
      setConfig(prev =>
        defaultsFor(next, {
          host: prev.host,
          port: prev.port,
          name: prev.name,
        }));
    },
    [],
  );

  // ---- form: per-kind field updaters ----

  const setPort = useCallback((raw: string) => {
    const trimmed = raw.trim();
    const n = trimmed === '' ? 0 : Number(trimmed);
    setConfig(prev => ({ ...prev, port: Number.isFinite(n) ? n : 0 } as ProxyConfig));
  }, []);

  const clearForm = useCallback(() => {
    setEditingId(null);
    setFormName('');
    setConfig(defaultsFor('http', { host: '', port: 0, name: '' }));
    setDialTimeoutInput('');
    setSaveSuccess(false);
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
    const parsed = parseSavedUrl(proxy.url);
    setConfig(parsed ?? defaultsFor('http', { host: '', port: 0, name: '' }));
    setSaveSuccess(false);
    setSaveError(null);
    setTestResult(null);
  }, []);

  // ---- save ----

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setSaveSuccess(false);

    const trimmedName = formName.trim();
    if (!trimmedName) {
      setSaveError('Name is required');
      setSaving(false);
      return;
    }

    // Build URL from structured config — secrets never shown in UI
    const builtUrl = formatProxyUri({ ...config, name: trimmedName });

    const timeoutParsed = (() => {
      const raw = dialTimeoutInput.trim();
      if (raw === '') return { value: null };
      if (!/^[1-9][0-9]*$/.test(raw)) return { error: 'Must be a positive integer' as const };
      const n = Number(raw);
      if (n > 600) return { error: 'Must be at most 600 seconds' as const };
      return { value: n };
    })();

    if ('error' in timeoutParsed) {
      setSaveError(`Dial timeout: ${timeoutParsed.error}`);
      setSaving(false);
      return;
    }

    const body: Record<string, unknown> = {
      name: trimmedName,
      url: builtUrl,
      dial_timeout_seconds: timeoutParsed.value,
    };

    const isEdit = editingId !== null;
    const result = await callApi<ProxyRecord>(() =>
      authFetch(
        isEdit
          ? `/api/proxies/${encodeURIComponent(editingId!)}`
          : '/api/proxies',
        {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      ));

    setSaving(false);
    if (result.error) {
      setSaveError(result.error.message);
      return;
    }

    setSaveSuccess(true);
    clearForm();
    await refreshProxies();
  }, [formName, config, dialTimeoutInput, editingId, clearForm, refreshProxies]);

  // ---- test ----

  const handleTest = useCallback(async () => {
    const builtUrl = formatProxyUri(config);

    setTesting(true);
    setTestResult(null);

    const timeoutParsed = (() => {
      const raw = dialTimeoutInput.trim();
      if (raw === '') return { value: null };
      const n = Number(raw);
      if (!isNaN(n) && n > 0 && n <= 600) return { value: n };
      return { value: null };
    })();

    const body: Record<string, unknown> = {
      url: builtUrl,
    };
    if (timeoutParsed.value != null) {
      body.dial_timeout_seconds = timeoutParsed.value;
    }

    try {
      const response = await authFetch('/api/proxies/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as {
        ok: boolean;
        egress_ip?: string;
        error?: string;
      };
      setTestResult(data);
    } catch (e) {
      setTestResult({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTesting(false);
    }
  }, [config, dialTimeoutInput]);

  // ---- delete ----

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);

    const result = await callApi<{ ok: true }>(() =>
      authFetch(`/api/proxies/${encodeURIComponent(deleteTarget.id)}`, {
        method: 'DELETE',
      }));

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

  // ---- derived form state ----

  const canSave = formName.trim() !== '' && config.host.trim() !== '' && isValidPort(config.port);

  // ---- admin guard ----
  if (!user.isAdmin) {
    return (
      <section className="grid gap-[18px] min-w-0">
        <ProxyPageHeader />
        <Panel className="!p-[22px_24px]">
          <div className="grid gap-[10px] max-w-[680px]">
            <Text
              size={300}
              weight="semibold"
              style={{ color: 'light-dark(#0f6cbd, #75b6f7)' }}
            >
              {t('dashboard.pages.adminOnly')}
            </Text>
            <Text size={300} className="text-fui-fg3">
              {t('dashboard.pages.adminOnlyDescription')}
            </Text>
          </div>
        </Panel>
      </section>
    );
  }

  // ---- loading ----
  if (loading) {
    return (
      <section className="grid gap-[18px] min-w-0">
        <ProxyPageHeader />
        <PageLoadingPanel label={t('common.loading')} />
      </section>
    );
  }

  // ---- main render ----
  return (
    <section className="grid gap-[18px] min-w-0">
      {/* Page header */}
      <ProxyPageHeader />

      {/* Load error */}
      {loadError && (
        <MessageBar intent="error">
          <MessageBarBody>{loadError}</MessageBarBody>
        </MessageBar>
      )}

      {/* Delete conflict error */}
      {deleteError && (
        <MessageBar intent="error">
          <MessageBarBody>{deleteError}</MessageBarBody>
        </MessageBar>
      )}

      <div className="grid grid-cols-[minmax(0,1fr)_420px] gap-[18px] items-start min-w-0 max-[900px]:grid-cols-1">
        <ProxyList proxies={proxies} onAdd={clearForm} onDelete={setDeleteTarget} onEdit={handleEdit} onRefresh={() => void refreshProxies()} />
        <div className="grid gap-[18px] min-w-0">
          {editingId !== null && <ProxyBackoffPanel
            backoffs={backoffs}
            onReset={() => void refreshProxies()}
            proxyId={editingId}
          />}
          <ProxyForm
            canSave={canSave}
            config={config}
            dialTimeoutInput={dialTimeoutInput}
            editing={editingId !== null}
            formName={formName}
            onCancel={clearForm}
            onConfigChange={setConfig}
            onDialTimeoutChange={setDialTimeoutInput}
            onKindChange={handleKindChange}
            onNameChange={setFormName}
            onPortChange={setPort}
            onSave={() => void handleSave()}
            onTest={() => void handleTest()}
            saveError={saveError}
            saveSuccess={saveSuccess}
            saving={saving}
            testResult={testResult}
            testing={testing}
          />
        </div>
      </div>

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <ConfirmDialog
          actionLabel={
            deleting
              ? t('dashboard.proxy.actions.deleting')
              : t('dashboard.proxy.actions.delete')
          }
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
