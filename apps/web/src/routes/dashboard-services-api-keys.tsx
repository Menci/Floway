import { useEffect, useId, useRef, useState } from 'react';
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
import type { ApiKeysPageData, MutationToastController } from '../components/api-keys/types';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { Panel } from '../components/ui/panel';
import { ResourceListPanel, ResourceListToolbar } from '../components/ui/resource-list-toolbar';
import { fluentComponents } from '../fluent';

const { MessageBar, MessageBarBody, Spinner, Toast, Toaster, ToastTitle, useToastController } = fluentComponents;
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
  const toasterId = useId();
  const mutationToastId = useId();
  const mutationToastSequence = useRef(0);
  const { dispatchToast, updateToast } = useToastController(toasterId);
  const [data, setData] = useState<ApiKeysPageData>(loaderData);
  const [selectedKeyId, setSelectedKeyId] = useState(loaderData.selectedKeyId);
  const [pageError, setPageError] = useState(loaderData.error);
  const [refreshing, setRefreshing] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ApiKey | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ApiKey | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ApiKey | null>(null);
  const [deletingKey, setDeletingKey] = useState(false);
  const [deleteSnapName, setDeleteSnapName] = useState('');
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

  const mutationToasts: MutationToastController = {
    start: (kind, name) => {
      const toastId = `${mutationToastId}-${mutationToastSequence.current++}`;
      dispatchToast(
        <Toast>
          <ToastTitle media={<Spinner size="tiny" />}>
            {t(`dashboard.apiKeys.toast.${kind}.pending`, { name })}
          </ToastTitle>
        </Toast>,
        { toastId, timeout: -1 },
      );
      return toastId;
    },
    succeed: (toastId, kind, name) => {
      updateToast({
        content: (
          <Toast>
            <ToastTitle>{t(`dashboard.apiKeys.toast.${kind}.success`, { name })}</ToastTitle>
          </Toast>
        ),
        intent: 'success',
        toastId,
        timeout: 3000,
      });
    },
    fail: (toastId, kind, name, message) => {
      updateToast({
        content: (
          <Toast>
            <ToastTitle>
              {t(`dashboard.apiKeys.toast.${kind}.error`, { name, message })}
            </ToastTitle>
          </Toast>
        ),
        intent: 'error',
        toastId,
        timeout: 5000,
      });
    },
  };

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
    setPageError(null);
    setDeletingKey(true);
    const toastId = mutationToasts.start('delete', key.name);
    const result = await callApi(() => api.api.keys[':id'].$delete({ param: { id: key.id } }));
    setDeletingKey(false);
    if (result.error) {
      mutationToasts.fail(toastId, 'delete', key.name, result.error.message);
      setPageError(result.error.message);
      return;
    }
    setDeleteTarget(null);
    mutationToasts.succeed(toastId, 'delete', key.name);
    await reload();
  };

  return (
    <div className="dashboard-page">
      <Toaster toasterId={toasterId} position="top-end" />

      <DashboardPageHeader
        description={t('dashboard.pages.apiKeys')}
        eyebrow={t('dashboard.groups.services')}
        title={t('dashboard.nav.apiKeys')}
      />

      {pageError && (
        <MessageBar intent="error">
          <MessageBarBody>{pageError}</MessageBarBody>
        </MessageBar>
      )}

      <ResourceListPanel>
        <ResourceListToolbar
          createLabel={t('dashboard.apiKeys.actions.create')}
          detail={t('dashboard.apiKeys.count', { count: data.keys.length })}
          disabled={deletingKey}
          onCreate={() => setCreateOpen(true)}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.apiKeys.actions.refresh')}
          refreshing={refreshing}
          title={t('dashboard.apiKeys.table.title')}
        />
        <KeysTable
          copiedTag={copiedTag}
          copyFailedTag={copyFailedTag}
          disabled={refreshing || deletingKey}
          keys={data.keys}
          onCopy={(text, tag) => void copyToClipboard(text, tag)}
          onDelete={key => { setDeleteSnapName(key.name); setDeleteTarget(key); }}
          onEdit={setEditTarget}
          onRotate={setRotateTarget}
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

      <KeyDialog
        apiKey={null}
        key={createOpen ? 'create-open' : 'create-closed'}
        mode="create"
        onOpenChange={setCreateOpen}
        onSaved={async key => { await reload(); setSelectedKeyId(key.id); }}
        mutationToasts={mutationToasts}
        open={createOpen}
        upstreams={data.upstreams}
        userUpstreamIds={user.upstreamIds}
      />
      <KeyDialog
        apiKey={editTarget}
        key={editTarget?.id ?? 'edit-closed'}
        mode="edit"
        onOpenChange={open => {
          if (!open) setEditTarget(null);
        }}
        onSaved={async () => { await reload(); }}
        mutationToasts={mutationToasts}
        open={editTarget !== null}
        upstreams={data.upstreams}
        userUpstreamIds={user.upstreamIds}
      />
      <RotateKeyDialog
        apiKey={rotateTarget}
        key={rotateTarget?.id ?? 'closed'}
        onOpenChange={open => {
          if (!open) setRotateTarget(null);
        }}
        onSaved={reload}
        mutationToasts={mutationToasts}
        open={rotateTarget !== null}
      />
      <ConfirmDialog
        actionLabel={t('dashboard.apiKeys.actions.delete')}
        busy={deletingKey}
        message={t('dashboard.apiKeys.delete.message', {
          name: deleteSnapName,
        })}
        onConfirm={() => {
          if (deleteTarget && !deletingKey) void deleteKey(deleteTarget);
        }}
        onOpenChange={open => {
          if (!open && !deletingKey) setDeleteTarget(null);
        }}
        open={deleteTarget !== null}
        title={t('dashboard.apiKeys.delete.title')}
      />
    </div>
  );
}
