import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect, useOutletContext } from 'react-router';

import type { DashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ApiKey } from '../api/types';
import { getSessionToken } from '../auth/session';
import type { Route } from './+types/dashboard-services-api-keys';
import { AgentSetupCard } from '../components/api-keys/agent-setup-card';
import type { AgentSetupLease } from '../components/api-keys/agent-setup-contract';
import { KeyDialog } from '../components/api-keys/key-editor';
import { KeysTable } from '../components/api-keys/keys-table';
import { modelsForAgentSetup } from '../components/api-keys/model-reachability';
import { RotateKeyDialog } from '../components/api-keys/rotate-key-dialog';
import type { ApiKeysPageData } from '../components/api-keys/types';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';

const selectedKeyStorageKey = 'floway-agent-setup-selected-key';
interface LoaderData extends ApiKeysPageData {
  selectedKeyId: string;
  setupError: string | null;
  setupLease: AgentSetupLease | null;
}

const loadInitialPageData = async (): Promise<ApiKeysPageData> => {
  const [keysRes, upstreamsRes, modelsRes] = await Promise.all([
    callApi(() => api.api.keys.$get()),
    callApi(() => api.api['upstream-options'].$get()),
    callApi(() => api.api.models.$get({ query: { include_unlisted: 'true' } })),
  ]);
  const error = keysRes.error?.message ?? upstreamsRes.error?.message ?? modelsRes.error?.message ?? null;
  return {
    keys: keysRes.data ?? [],
    upstreams: upstreamsRes.data ?? [],
    models: modelsRes.data?.data ?? [],
    error,
  };
};

export async function clientLoader(): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  const data = await loadInitialPageData();
  const stored = localStorage.getItem(selectedKeyStorageKey) ?? '';
  const selectedKeyId = data.keys.some(key => key.id === stored) ? stored : '';
  if (!selectedKeyId) return { ...data, selectedKeyId, setupError: null, setupLease: null };
  const setup = await callApi(() => api.api.setup.$post({ json: { apiKeyId: selectedKeyId } }));
  return { ...data, selectedKeyId, setupError: setup.error?.message ?? null, setupLease: setup.data ?? null };
}
export function meta({}: Route.MetaArgs) { return [{ title: 'API Keys | Floway' }]; }

export default function DashboardServicesApiKeys({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useOutletContext<DashboardOutletContext>();
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [data, setData] = useState<ApiKeysPageData>(loaderData);
  const [selectedKeyId, setSelectedKeyId] = useState(loaderData.selectedKeyId);
  const [pageError, setPageError] = useState(loaderData.error);
  const [refreshing, setRefreshing] = useState(false);
  const editorDialog = useDialogInvocation<{ kind: 'create' } | { kind: 'edit'; apiKey: ApiKey }>();
  const rotateDialog = useDialogInvocation<ApiKey>();
  const deleteDialog = useDialogInvocation<ApiKey>();
  const [deletingKey, setDeletingKey] = useState(false);
  const [copiedTag, setCopiedTag] = useState<string | null>(null);
  const [copyFailedTag, setCopyFailedTag] = useState<string | null>(null);

  const selectedKey = data.keys.find(key => key.id === selectedKeyId) ?? null;
  const agentSetupModels = selectedKey
    ? modelsForAgentSetup(data.models, selectedKey.upstream_ids, user.upstreamIds)
    : [];
  useEffect(() => {
    if (selectedKeyId) localStorage.setItem(selectedKeyStorageKey, selectedKeyId);
    else localStorage.removeItem(selectedKeyStorageKey);
  }, [selectedKeyId]);

  const toasts = useOutcomeToasts();

  const reload = async () => {
    setPageError(null);
    const [keysRes, upstreamsRes, modelsRes] = await Promise.all([
      callApi(() => api.api.keys.$get()),
      callApi(() => api.api['upstream-options'].$get()),
      callApi(() => api.api.models.$get({ query: { include_unlisted: 'true' } })),
    ]);

    const error =
      keysRes.error?.message ??
      upstreamsRes.error?.message ??
      modelsRes.error?.message ??
      null;
    setPageError(error);
    if (keysRes.error) return;

    const next = {
      keys: keysRes.data,
      upstreams: upstreamsRes.data ?? data.upstreams,
      models: modelsRes.data?.data ?? data.models,
      error,
    };
    setData(next);
    setSelectedKeyId(current =>
      next.keys.some(key => key.id === current) ? current : '');
  };

  const refresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  const copyToClipboard = async (text: string, tag: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyFailedTag(null);
      setCopiedTag(tag);
      window.setTimeout(() => {
        setCopiedTag(current => (current === tag ? null : current));
      }, 1500);
    } catch {
      setCopiedTag(null);
      setCopyFailedTag(tag);
      window.setTimeout(() => {
        setCopyFailedTag(current => (current === tag ? null : current));
      }, 2000);
    }
  };

  const deleteKey = async (key: ApiKey) => {
    setDeleteError(null);
    setDeletingKey(true);
    const handle = toasts.start(t('dashboard.apiKeys.toast.delete.pending', { name: key.name }));
    const result = await callApi(() => api.api.keys[':id'].$delete({ param: { id: key.id } }));
    setDeletingKey(false);
    if (result.error) {
      handle.settle();
      setDeleteError(result.error.message);
      return;
    }
    deleteDialog.close();
    handle.succeed(t('dashboard.apiKeys.toast.delete.success', { name: key.name }));
    await reload();
  };

  return (
    <div className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createLabel={t('dashboard.apiKeys.actions.create')}
          disabled={deletingKey}
          onCreate={() => editorDialog.open({ kind: 'create' })}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.apiKeys.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.pages.apiKeys')}
        eyebrow={t('dashboard.groups.services')}
        title={t('dashboard.nav.apiKeys')}
      />

      {pageError && (
        <OutcomeMessageBar onDismiss={() => setPageError(null)}>{pageError}</OutcomeMessageBar>
      )}

      <ResourceListPanel>
        <KeysTable
          copiedTag={copiedTag}
          copyFailedTag={copyFailedTag}
          disabled={refreshing || deletingKey}
          keys={data.keys}
          onCopy={(text, tag) => void copyToClipboard(text, tag)}
          onDelete={deleteDialog.open}
          onEdit={apiKey => editorDialog.open({ kind: 'edit', apiKey })}
          onRotate={rotateDialog.open}
          onSelect={setSelectedKeyId}
          selectedKeyId={selectedKey?.id ?? ''}
          upstreams={data.upstreams}
        />
      </ResourceListPanel>

      <Panel className="grid gap-[14px] min-w-0 !p-[18px]">
        <AgentSetupCard
          copiedTag={copiedTag}
          copyFailedTag={copyFailedTag}
          initialApiKeyId={loaderData.selectedKeyId || null}
          initialError={loaderData.setupError}
          initialLease={loaderData.setupLease}
          models={agentSetupModels}
          onCopy={(text, tag) => void copyToClipboard(text, tag)}
          selectedKey={selectedKey}
        />
      </Panel>

      {editorDialog.invocation?.value.kind === 'create' && <KeyDialog
        open={editorDialog.isOpen}
        key={editorDialog.invocation.key}
        models={data.models}
        mode="create"
        onOpenChange={open => { if (!open) editorDialog.close(); }}
        onSaved={async key => { await reload(); setSelectedKeyId(key.id); }}
        upstreams={data.upstreams}
        userUpstreamIds={user.upstreamIds}
      />}
      {editorDialog.invocation?.value.kind === 'edit' && <KeyDialog
        open={editorDialog.isOpen}
        apiKey={editorDialog.invocation.value.apiKey}
        key={editorDialog.invocation.key}
        models={data.models}
        mode="edit"
        onOpenChange={open => { if (!open) editorDialog.close(); }}
        onSaved={async () => { await reload(); }}
        upstreams={data.upstreams}
        userUpstreamIds={user.upstreamIds}
      />}
      {rotateDialog.invocation && <RotateKeyDialog
        open={rotateDialog.isOpen}
        apiKey={rotateDialog.invocation.value}
        key={rotateDialog.invocation.key}
        onOpenChange={open => { if (!open) rotateDialog.close(); }}
        onSaved={reload}
      />}
      {deleteDialog.invocation && <ConfirmDialog
        open={deleteDialog.isOpen}
        actionLabel={t('dashboard.apiKeys.actions.delete')}
        busy={deletingKey}
        error={deleteError}
        onDismissError={() => setDeleteError(null)}
        message={t('dashboard.apiKeys.delete.message', {
          name: deleteDialog.invocation.value.name,
        })}
        onConfirm={() => {
          if (!deletingKey) void deleteKey(deleteDialog.invocation!.value);
        }}
        onOpenChange={open => {
          if (!deletingKey && !open) deleteDialog.close();
        }}
        key={deleteDialog.invocation.key}
        title={t('dashboard.apiKeys.delete.title')}
      />}
    </div>
  );
}
