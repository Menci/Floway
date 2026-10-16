import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-admin-users';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import { mapResult, mergeResults } from '../api/partial-results';
import type { AccessRecord, ControlPlaneGroup, ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../api/types';
import type { ScopeExpressionData } from '../components/access-control/scope-expression';
import { GroupDialog } from '../components/groups/dialog';
import { GroupsTable } from '../components/groups/table';
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
import { fluentComponents } from '../fluent';
import { useAuthStore } from '../stores/auth-store';

const { Tab, TabList } = fluentComponents;

// `null` is a failed fetch, not an empty deployment: a gateway always has a user.
interface LoaderData {
  users: ControlPlaneUser[] | null;
  groups: ControlPlaneGroup[] | null;
  accessRecords: AccessRecord[] | null;
  upstreams: UpstreamOption[] | null;
  models: ControlPlaneModel[] | null;
  error: string | null;
}

const loadPageData = async (
  current: Pick<LoaderData, 'users' | 'groups' | 'accessRecords' | 'upstreams' | 'models'>,
  signal?: AbortSignal,
): Promise<LoaderData> => {
  const [usersResult, groupsResult, accessRecordsResult, upstreamsResult, modelsResult] = await Promise.all([
    callApi(() => api.api.users.$get(undefined, { init: { signal } })),
    callApi(() => api.api.groups.$get(undefined, { init: { signal } })),
    callApi(() => api.api['access-records'].$get(undefined, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get({ query: { view: 'all' } }, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
  ]);
  const { values, error } = mergeResults(current, {
    users: usersResult,
    groups: groupsResult,
    accessRecords: accessRecordsResult,
    upstreams: upstreamsResult,
    models: mapResult(modelsResult, body => body.data),
  });
  return { ...values, error };
};

const unloadedPageData: Pick<LoaderData, 'users' | 'groups' | 'accessRecords' | 'upstreams' | 'models'> = {
  users: null, groups: null, accessRecords: null, upstreams: null, models: null,
};

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
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get('tab') === 'groups' ? 'groups' : 'users';
  const setTab = (next: 'users' | 'groups') => setSearchParams(current => {
    const params = new URLSearchParams(current);
    if (next === 'users') params.delete('tab'); else params.set('tab', 'groups');
    return params;
  }, { replace: true });
  const editorDialog = useDialogInvocation<{ kind: 'create' } | { kind: 'edit'; user: ControlPlaneUser }>();
  const passwordDialog = useDialogInvocation<ControlPlaneUser>();
  const deleteDialog = useDialogInvocation<ControlPlaneUser>();
  const groupDialog = useDialogInvocation<{ group?: ControlPlaneGroup }>();
  const deleteGroupDialog = useDialogInvocation<ControlPlaneGroup>();
  const [groupAfterUserExit, setGroupAfterUserExit] = useState<ControlPlaneGroup | null>(null);

  // The error belongs to its attempt, so opening another user's dialog clears it.
  const openDeleteDialog = (target: ControlPlaneUser) => {
    setDeleteError(null);
    deleteDialog.open(target);
  };
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [deleteGroupError, setDeleteGroupError] = useState<string | null>(null);

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

  const deleteGroup = async (target: ControlPlaneGroup) => {
    setDeletingGroup(true);
    setDeleteGroupError(null);
    const handle = toasts.start(t('dashboard.groupsManagement.toast.delete.pending', { name: target.name }));
    const result = await callApi(() => api.api.groups[':id'].$delete({ param: { id: String(target.id) } }));
    setDeletingGroup(false);
    if (result.error) {
      handle.settle();
      setDeleteGroupError(result.error.message);
      return;
    }
    deleteGroupDialog.close();
    handle.succeed(t('dashboard.groupsManagement.toast.delete.success', { name: target.name }));
    await refresh();
  };

  const { accessRecords, groups, models, upstreams, users } = data;
  const loaded = users !== null && groups !== null && accessRecords !== null && upstreams !== null && models !== null;
  const accessData = useMemo<ScopeExpressionData>(() => ({
    groups: groups ?? [], models: models ?? [], upstreams: upstreams ?? [], users: users ?? [],
  }), [groups, models, upstreams, users]);

  return (
    <section className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          createDisabled={!loaded}
          createLabel={t(tab === 'users' ? 'dashboard.users.actions.create' : 'dashboard.groupsManagement.actions.create')}
          disabled={deleting}
          onCreate={() => tab === 'users' ? editorDialog.open({ kind: 'create' }) : groupDialog.open({})}
          onRefresh={() => void refresh()}
          refreshLabel={t(tab === 'users' ? 'dashboard.users.actions.refresh' : 'dashboard.groupsManagement.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.pages.users')}
        title={t('dashboard.nav.users')}
      />

      <TabList aria-label={t('dashboard.nav.users')} onTabSelect={(_, event) => setTab(event.value === 'groups' ? 'groups' : 'users')} selectedValue={tab}>
        <Tab value="users">{t('dashboard.users.tabs.users')}</Tab>
        <Tab value="groups">{t('dashboard.users.tabs.groups')}</Tab>
      </TabList>

      {pageError && (
        <OutcomeMessageBar onDismiss={() => setPageError(null)}>
          {pageError}
        </OutcomeMessageBar>
      )}

      {!loaded ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
        <ResourceListPanel>
          {tab === 'users' ? <UsersTable
            actorId={actor.id}
            disabled={refreshing || deleting}
            onDelete={openDeleteDialog}
            onEdit={user => editorDialog.open({ kind: 'edit', user })}
            onResetPassword={passwordDialog.open}
            users={users}
          /> : <GroupsTable
            disabled={refreshing || deletingGroup}
            groups={groups}
            onDelete={group => { setDeleteGroupError(null); deleteGroupDialog.open(group); }}
            onEdit={group => groupDialog.open({ group })}
          />}
        </ResourceListPanel>

        {editorDialog.invocation?.value.kind === 'create' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          accessData={accessData}
          accessRecords={accessRecords}
          groups={groups}
          key={editorDialog.invocation.key}
          mode="create"
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={() => afterSaved()}
          onAccessChanged={refresh}
        />}
        {editorDialog.invocation?.value.kind === 'edit' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          accessData={accessData}
          accessRecords={accessRecords}
          groups={groups}
          key={editorDialog.invocation.key}
          mode="edit"
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onExited={() => {
            if (groupAfterUserExit === null) return;
            setTab('groups');
            groupDialog.open({ group: groupAfterUserExit });
            setGroupAfterUserExit(null);
          }}
          onOpenGroup={group => {
            setGroupAfterUserExit(group);
          }}
          onSaved={afterSaved}
          onAccessChanged={refresh}
          user={editorDialog.invocation.value.user}
        />}
        {groupDialog.invocation && <GroupDialog
          accessData={accessData}
          accessRecords={accessRecords}
          group={groupDialog.invocation.value.group}
          key={groupDialog.invocation.key}
          onAccessChanged={refresh}
          onOpenChange={open => { if (!open) groupDialog.close(); }}
          onSaved={refresh}
          open={groupDialog.isOpen}
          users={users}
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
        {deleteGroupDialog.invocation && <ConfirmDialog
          actionLabel={t('dashboard.groupsManagement.actions.delete')}
          busy={deletingGroup}
          error={deleteGroupError}
          message={t('dashboard.groupsManagement.delete.message', { name: deleteGroupDialog.invocation.value.name })}
          onConfirm={() => void deleteGroup(deleteGroupDialog.invocation!.value)}
          onDismissError={() => setDeleteGroupError(null)}
          onOpenChange={open => { if (!open) deleteGroupDialog.close(); }}
          open={deleteGroupDialog.isOpen}
          title={t('dashboard.groupsManagement.delete.title')}
        />}
      </>}
    </section>
  );
}
