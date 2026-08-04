import { useCallback, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-admin-users';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import { mapResult, mergeResults } from '../api/partial-results';
import type { ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../api/types';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { UserDialog } from '../components/users/dialog';
import { PasswordDialog } from '../components/users/password-dialog';
import { UsersTable } from '../components/users/table';
import { useAuthStore } from '../stores/auth-store';

// `null` is a failed fetch, not an empty deployment: a gateway always has a user.
interface LoaderData {
  users: ControlPlaneUser[] | null;
  upstreams: UpstreamOption[] | null;
  models: ControlPlaneModel[] | null;
  error: string | null;
}

const loadPageData = async (
  current: Pick<LoaderData, 'users' | 'upstreams' | 'models'>,
  signal?: AbortSignal,
): Promise<LoaderData> => {
  const [usersResult, upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api.users.$get(undefined, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
  ]);
  const { values, error } = mergeResults(current, {
    users: usersResult,
    upstreams: upstreamsResult,
    models: mapResult(modelsResult, body => body.data),
  });
  return { ...values, error };
};

const unloadedPageData: Pick<LoaderData, 'users' | 'upstreams' | 'models'> = { users: null, upstreams: null, models: null };

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadPageData(unloadedPageData);
}

export default function DashboardAdminUsers({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user: actor } = useDashboardOutletContext();
  const refreshAuth = useAuthStore(state => state.refresh);
  const toasts = useOutcomeToasts();
  const [data, setData] = useState<LoaderData>(loaderData);
  const [pageError, setPageError] = useState<string | null>(loaderData.error);
  const editorDialog = useDialogInvocation<{ kind: 'create' } | { kind: 'edit'; user: ControlPlaneUser }>();
  const passwordDialog = useDialogInvocation<ControlPlaneUser>();
  const deleteDialog = useDialogInvocation<ControlPlaneUser>();

  // The error belongs to its attempt, so opening another user's dialog clears it.
  const openDeleteDialog = (target: ControlPlaneUser) => {
    setDeleteError(null);
    deleteDialog.open(target);
  };
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = useCallback(async (signal: AbortSignal) => {
    const next = await loadPageData(data, signal);
    if (signal.aborted) return;
    setData(next);
    setPageError(next.error);
  }, [data]);
  const { refresh, refreshing } = useRefresh(reload);

  const afterSaved = async (savedId?: number) => {
    await refresh();
    if (savedId !== actor.id) return;

    const refreshed = await refreshAuth();
    if (!refreshed) {
      const error = useAuthStore.getState().error;
      if (error) setPageError(error.message);
    }
  };

  const deleteUser = async (target: ControlPlaneUser) => {
    setDeleting(true);
    setDeleteError(null);
    const handle = toasts.start(t('dashboard.users.toast.delete.pending', { username: target.username }));
    const result = await callApi(() =>
      api.api.users[':id'].$delete({ param: { id: String(target.id) } }));
    setDeleting(false);
    if (result.error) {
      handle.settle();
      setDeleteError(result.error.message);
      return;
    }
    deleteDialog.close();
    handle.succeed(t('dashboard.users.toast.delete.success', { username: target.username }));
    await refresh();
  };

  const { models, upstreams, users } = data;
  const loaded = users !== null && models !== null && upstreams !== null;

  return (
    <section className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createDisabled={!loaded}
          createLabel={t('dashboard.users.actions.create')}
          disabled={deleting}
          onCreate={() => editorDialog.open({ kind: 'create' })}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.users.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.pages.users')}
        title={t('dashboard.nav.users')}
      />

      {pageError && (
        <OutcomeMessageBar onDismiss={() => setPageError(null)}>
          {pageError}
        </OutcomeMessageBar>
      )}

      {!loaded ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
        <ResourceListPanel>
          <UsersTable
            actorId={actor.id}
            disabled={refreshing || deleting}
            onDelete={openDeleteDialog}
            onEdit={user => editorDialog.open({ kind: 'edit', user })}
            onResetPassword={passwordDialog.open}
            users={users}
          />
        </ResourceListPanel>

        {editorDialog.invocation?.value.kind === 'create' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          key={editorDialog.invocation.key}
          mode="create"
          models={models}
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={() => afterSaved()}
          upstreams={upstreams}
        />}
        {editorDialog.invocation?.value.kind === 'edit' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          key={editorDialog.invocation.key}
          mode="edit"
          models={models}
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={afterSaved}
          upstreams={upstreams}
          user={editorDialog.invocation.value.user}
        />}
        {passwordDialog.invocation && <PasswordDialog
          open={passwordDialog.isOpen}
          key={passwordDialog.invocation.key}
          onOpenChange={open => { if (!open) passwordDialog.close(); }}
          onSaved={refresh}
          user={passwordDialog.invocation.value}
        />}
        {deleteDialog.invocation && <ConfirmDialog
          open={deleteDialog.isOpen}
          actionLabel={t('dashboard.users.actions.delete')}
          busy={deleting}
          error={deleteError}
          key={deleteDialog.invocation.key}
          message={t('dashboard.users.delete.message', {
            username: deleteDialog.invocation.value.username,
          })}
          onConfirm={() => void deleteUser(deleteDialog.invocation!.value)}
          onDismissError={() => setDeleteError(null)}
          onOpenChange={open => { if (!open) deleteDialog.close(); }}
          title={t('dashboard.users.delete.title')}
        />}
      </>}
    </section>
  );
}
