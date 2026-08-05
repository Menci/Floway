import { useCallback, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-providers-proxy';
import { requireDashboardAdmin } from './guards';
import { api, callApi, callApiNoContent } from '../api/client';
import type { ProxyRecord, BackoffRow } from '../api/types';
import { ProxyDialog } from '../components/proxy/dialog';
import { ProxyList } from '../components/proxy/list';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';

// `null` is a fetch that failed, distinct from a deployment that genuinely has
// no proxy: an empty list invites a second copy of a proxy that already exists.
interface LoaderData {
  proxies: ProxyRecord[] | null;
  backoffs: BackoffRow[] | null;
  error: string | null;
}

const loadPageData = async (): Promise<LoaderData> => {
  const [proxiesRes, backoffsRes] = await Promise.all([
    callApi(() => api.api.proxies.$get()),
    callApi(() => api.api.proxies.backoffs.$get()),
  ]);
  return {
    proxies: proxiesRes.data ?? null,
    backoffs: backoffsRes.data ?? null,
    error: proxiesRes.error?.message ?? backoffsRes.error?.message ?? null,
  };
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadPageData();
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
    // Set together or not at all: a torn pair shows proxies from one round trip
    // beside backoffs from another.
    if (signal.aborted) return;
    if (proxiesRes.data) setProxies(proxiesRes.data);
    if (backoffsRes.data) setBackoffs(backoffsRes.data);
    setLoadError(proxiesRes.error?.message ?? backoffsRes.error?.message ?? null);
  }, []);

  const { refresh, refreshing } = useRefresh(refreshProxies);

  const loaded = proxies !== null && backoffs !== null;

  const handleDeleteConfirm = useCallback(async (target: ProxyRecord) => {
    setMutating(true);
    setDeleteError(null);

    const handle = toasts.start(t('dashboard.proxy.toast.delete.pending', { name: target.name }));
    const result = await callApiNoContent(() => api.api.proxies[':id'].$delete({ param: { id: target.id } }));

    setMutating(false);
    if (result.error) {
      handle.settle();
      const raw = result.error.raw;
      // Only the 409 member of the delete route's failure union names the
      // upstreams still pointing at this proxy.
      const referencing = raw && 'referencing_upstream_ids' in raw ? raw.referencing_upstream_ids : [];
      if (referencing.length > 0) {
        setDeleteError(
          `${t('dashboard.proxy.delete.conflict')} ${t('dashboard.proxy.delete.conflictWithIds', { ids: referencing.join(', ') })}`,
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
          createDisabled={!loaded}
          createLabel={t('dashboard.proxy.actions.create')}
          disabled={mutating}
          onCreate={() => editorDialog.open(null)}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.proxy.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.proxy.description')}
        title={t('dashboard.nav.proxy')}
      />

      {loadError && (
        <OutcomeMessageBar onDismiss={() => setLoadError(null)}>{loadError}</OutcomeMessageBar>
      )}

      {!loaded ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
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

        {deleteDialog.invocation && <ConfirmDialog
          open={deleteDialog.isOpen}
          actionLabel={t('dashboard.proxy.actions.delete')}
          busy={mutating}
          error={deleteError}
          key={deleteDialog.invocation.key}
          message={t('dashboard.proxy.delete.message', { name: deleteDialog.invocation.value.name })}
          onConfirm={() => void handleDeleteConfirm(deleteDialog.invocation!.value)}
          onDismissError={() => setDeleteError(null)}
          onOpenChange={open => { if (!open) deleteDialog.close(); }}
          title={t('dashboard.proxy.delete.title')}
        />}
      </>}
    </section>
  );
}
