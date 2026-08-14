import { useCallback, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-services-api-keys';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardSession } from './guards';
import { api, callApi } from '../api/client';
import { mapResult, mergeResults } from '../api/partial-results';
import type { ApiKey, ControlPlaneModel, UpstreamOption } from '../api/types';
import type { AgentSetupLease } from '../components/api-keys/agent-setup';
import { AgentSetupCard } from '../components/api-keys/agent-setup-card';
import { KeyDialog } from '../components/api-keys/editor';
import { RotateKeyDialog } from '../components/api-keys/rotate-dialog';
import { KeysTable } from '../components/api-keys/table';
import { effectiveUpstreamCap, reachableModels } from '../components/models/reachability';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { useCopyToClipboard } from '../components/ui/use-copy-to-clipboard';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';

const selectedKeyStorageKey = 'floway-agent-setup-selected-key';

// `null` is a fetch that failed, distinct from a deployment that genuinely holds
// no keys: an empty table invites a second copy of a key that already exists.
interface ApiKeysPageData {
  keys: ApiKey[] | null;
  upstreams: UpstreamOption[] | null;
  models: ControlPlaneModel[] | null;
  error: string | null;
}

interface LoaderData extends ApiKeysPageData {
  selectedKeyId: string;
  setupError: string | null;
  setupLease: AgentSetupLease | null;
}

const loadPageData = async (
  current: Pick<ApiKeysPageData, 'keys' | 'upstreams' | 'models'>,
  signal?: AbortSignal,
): Promise<ApiKeysPageData> => {
  const [keysRes, upstreamsRes, modelsRes] = await Promise.all([
    callApi(() => api.api.keys.$get(undefined, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { include_unlisted: 'true' } }, { init: { signal } })),
  ]);
  const { values, error } = mergeResults(current, {
    keys: keysRes,
    upstreams: upstreamsRes,
    models: mapResult(modelsRes, body => body.data),
  });
  return { ...values, error };
};

const unloadedPageData: Pick<ApiKeysPageData, 'keys' | 'upstreams' | 'models'> = { keys: null, upstreams: null, models: null };

export async function clientLoader(): Promise<LoaderData> {
  requireDashboardSession();
  const data = await loadPageData(unloadedPageData);
  const stored = localStorage.getItem(selectedKeyStorageKey) ?? '';
  const selectedKeyId = data.keys?.some(key => key.id === stored) ? stored : '';
  if (!selectedKeyId) return { ...data, selectedKeyId, setupError: null, setupLease: null };
  const setup = await callApi(() => api.api.setup.$post({ json: { apiKeyId: selectedKeyId } }));
  return { ...data, selectedKeyId, setupError: setup.error?.message ?? null, setupLease: setup.data ?? null };
}

export default function DashboardServicesApiKeys({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const [data, setData] = useState<ApiKeysPageData>(loaderData);
  const [selectedKeyId, setSelectedKeyId] = useState(loaderData.selectedKeyId);
  const [pageError, setPageError] = useState(loaderData.error);
  const editorDialog = useDialogInvocation<{ kind: 'create' } | { kind: 'edit'; apiKey: ApiKey }>();
  const rotateDialog = useDialogInvocation<ApiKey>();
  const deleteDialog = useDialogInvocation<ApiKey>();
  const [deletingKey, setDeletingKey] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The error belongs to the attempt that produced it, not to the dialog.
  const openDeleteDialog = (target: ApiKey) => {
    setDeleteError(null);
    deleteDialog.open(target);
  };
  const clipboard = useCopyToClipboard();

  const selectedKey = data.keys?.find(key => key.id === selectedKeyId) ?? null;
  const agentSetupModels = selectedKey && data.models
    ? reachableModels(data.models, effectiveUpstreamCap(selectedKey.upstream_ids, user.upstreamIds))
    : [];

  // Written where the picking happens rather than mirrored off rendered state:
  // the loader answers with no id whenever the key list did not arrive, so an
  // effect watching that would erase a selection the next load would restore.
  const selectKey = (id: string) => {
    setSelectedKeyId(id);
    if (id) localStorage.setItem(selectedKeyStorageKey, id);
    else localStorage.removeItem(selectedKeyStorageKey);
  };

  const toasts = useOutcomeToasts();

  const reload = useCallback(async (signal: AbortSignal) => {
    const next = await loadPageData(data, signal);
    if (signal.aborted) return;
    setData(next);
    setPageError(next.error);
    // A key the reload no longer lists is gone rather than merely unfetched:
    // `loadPageData` keeps the keys it already had when the request fails.
    if (!next.keys?.some(key => key.id === selectedKeyId)) selectKey('');
  }, [data, selectedKeyId]);

  const { refresh, refreshing } = useRefresh(reload);

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
    await refresh();
  };

  const { keys, models, upstreams } = data;
  const loaded = keys !== null && models !== null && upstreams !== null;

  return (
    <section className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createDisabled={!loaded}
          createLabel={t('dashboard.apiKeys.actions.create')}
          disabled={deletingKey}
          onCreate={() => editorDialog.open({ kind: 'create' })}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.apiKeys.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.pages.apiKeys')}
        title={t('dashboard.nav.apiKeys')}
      />

      {pageError && (
        <OutcomeMessageBar onDismiss={() => setPageError(null)}>{pageError}</OutcomeMessageBar>
      )}

      {!loaded ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
        <ResourceListPanel>
          <KeysTable
            disabled={refreshing || deletingKey}
            keys={keys}
            onDelete={openDeleteDialog}
            onEdit={apiKey => editorDialog.open({ kind: 'edit', apiKey })}
            onRotate={rotateDialog.open}
            onSelect={selectKey}
            clipboard={clipboard}
            selectedKeyId={selectedKey?.id ?? ''}
            upstreams={upstreams}
          />
        </ResourceListPanel>

        <Panel className="min-w-0">
          <AgentSetupCard
            initialApiKeyId={loaderData.selectedKeyId || null}
            initialError={loaderData.setupError}
            initialLease={loaderData.setupLease}
            models={agentSetupModels}
            clipboard={clipboard}
            selectedKey={selectedKey}
          />
        </Panel>

        {editorDialog.invocation?.value.kind === 'create' && <KeyDialog
          open={editorDialog.isOpen}
          key={editorDialog.invocation.key}
          models={models}
          mode="create"
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={async key => { await refresh(); selectKey(key.id); }}
          upstreams={upstreams}
          userUpstreamIds={user.upstreamIds}
        />}
        {editorDialog.invocation?.value.kind === 'edit' && <KeyDialog
          open={editorDialog.isOpen}
          apiKey={editorDialog.invocation.value.apiKey}
          key={editorDialog.invocation.key}
          models={models}
          mode="edit"
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={refresh}
          upstreams={upstreams}
          userUpstreamIds={user.upstreamIds}
        />}
        {rotateDialog.invocation && <RotateKeyDialog
          open={rotateDialog.isOpen}
          apiKey={rotateDialog.invocation.value}
          key={rotateDialog.invocation.key}
          onOpenChange={open => { if (!open) rotateDialog.close(); }}
          onSaved={refresh}
        />}
        {deleteDialog.invocation && <ConfirmDialog
          open={deleteDialog.isOpen}
          actionLabel={t('dashboard.apiKeys.actions.delete')}
          busy={deletingKey}
          error={deleteError}
          key={deleteDialog.invocation.key}
          message={t('dashboard.apiKeys.delete.message', {
            name: deleteDialog.invocation.value.name,
          })}
          onConfirm={() => void deleteKey(deleteDialog.invocation!.value)}
          onDismissError={() => setDeleteError(null)}
          onOpenChange={open => { if (!open) deleteDialog.close(); }}
          title={t('dashboard.apiKeys.delete.title')}
        />}
      </>}
    </section>
  );
}
