import { AddRegular, SearchRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { ShouldRevalidateFunctionArgs } from 'react-router';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-admin-users';
import { useDashboardOutletContext } from './dashboard';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import { mergeResults } from '../api/partial-results';
import type { ControlPlaneGroup, ControlPlaneUser, ControlPlaneUserDirectory } from '../api/types';
import { GroupDialog } from '../components/groups/dialog';
import { GroupsMasterDetail } from '../components/groups/master-detail';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Input } from '../components/ui/fluent-form-controls';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListPanel } from '../components/ui/resource-list';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { UserDialog } from '../components/users/dialog';
import { indexUserDirectory, type DirectoryGroupOption } from '../components/users/directory';
import { PasswordDialog } from '../components/users/password-dialog';
import { UsersTable } from '../components/users/table';
import { fluentComponents } from '../fluent';
import { useAuthStore } from '../stores/auth-store';

const { Button, Tab, TabList, Text } = fluentComponents;

// `null` is a failed fetch, not an empty deployment: a gateway always has a user.
interface LoaderData {
  directory: ControlPlaneUserDirectory | null;
  error: string | null;
}

const loadPageData = async (
  current: Pick<LoaderData, 'directory'>,
  signal?: AbortSignal,
): Promise<LoaderData> => {
  const directoryResult = await callApi(() => api.api['user-directory'].$get(undefined, { init: { signal } }));
  const { values, error } = mergeResults(current, {
    directory: directoryResult,
  });
  return { ...values, error };
};

const unloadedPageData: Pick<LoaderData, 'directory'> = {
  directory: null,
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadPageData(unloadedPageData);
}

export const shouldRevalidate = ({ currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) =>
  currentUrl.pathname !== nextUrl.pathname && defaultShouldRevalidate;

export default function DashboardAdminUsers({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user: actor } = useDashboardOutletContext();
  const refreshAuth = useAuthStore(state => state.refresh);
  const toasts = useOutcomeToasts();
  const [data, setData] = useState<LoaderData>(loaderData);
  const [pageError, setPageError] = useState<string | null>(loaderData.error);
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedGroupId = searchParams.has('group') ? Number(searchParams.get('group')) : null;
  const [changingMember, setChangingMember] = useState(false);
  const tab = searchParams.get('tab') === 'groups' ? 'groups' : 'users';
  const [search, setSearch] = useState<{ tab: 'users' | 'groups'; query: string }>({ tab, query: '' });
  const query = search.tab === tab ? search.query : '';
  const setQuery = (query: string) => setSearch({ tab, query });
  const setTab = (next: 'users' | 'groups') => setSearchParams(current => {
    const params = new URLSearchParams(current);
    if (next === 'users') params.delete('tab'); else params.set('tab', 'groups');
    return params;
  });
  const setSelectedGroupId = (id: number) => setSearchParams(current => {
    const params = new URLSearchParams(current);
    params.set('tab', 'groups');
    params.set('group', String(id));
    return params;
  });
  const editorDialog = useDialogInvocation<({ kind: 'create' } | { kind: 'edit'; user: ControlPlaneUser; groupIds: readonly number[] }) & { groups: readonly DirectoryGroupOption[] }>();
  const passwordDialog = useDialogInvocation<ControlPlaneUser>();
  const deleteDialog = useDialogInvocation<ControlPlaneUser>();
  const groupDialog = useDialogInvocation<{ group?: ControlPlaneGroup }>();
  const deleteGroupDialog = useDialogInvocation<ControlPlaneGroup>();

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
  const busy = refreshing || deleting || deletingGroup || changingMember;

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

  const { directory } = data;
  const directoryIndex = useMemo(() => directory === null ? null : indexUserDirectory(directory), [directory]);
  const users = directory?.users ?? null;
  const groups = directory?.groups ?? null;
  const loaded = users !== null && groups !== null;
  const needle = query.trim().toLowerCase();
  const visibleUsers = users?.filter(user => user.username.toLowerCase().includes(needle));
  const visibleGroups = groups?.filter(group => group.name.toLowerCase().includes(needle));
  const activeGroupId = visibleGroups?.find(group => group.id === selectedGroupId)?.id ?? visibleGroups?.[0]?.id;
  useEffect(() => {
    if (tab !== 'groups' || groups === null || (needle && activeGroupId === undefined)) return;
    const canonicalId = activeGroupId === undefined ? null : String(activeGroupId);
    if (searchParams.get('group') === canonicalId) return;
    setSearchParams(current => {
      const params = new URLSearchParams(current);
      if (canonicalId === null) params.delete('group'); else params.set('group', canonicalId);
      return params;
    }, { replace: true });
  }, [activeGroupId, groups, needle, searchParams, setSearchParams, tab]);

  const changeMember = async (group: ControlPlaneGroup, user: ControlPlaneUser, included: boolean): Promise<string | null> => {
    setChangingMember(true);
    const param = { id: String(group.id), userId: String(user.id) };
    try {
      const result = included
        ? await callApi(() => api.api.groups[':id'].members[':userId'].$put({ param }))
        : await callApi(() => api.api.groups[':id'].members[':userId'].$delete({ param }));
      if (result.error) {
        if (included) setPageError(result.error.message);
        return result.error.message;
      }
      await refresh();
      return null;
    } finally {
      setChangingMember(false);
    }
  };

  return (
    <section aria-busy={busy} className="dashboard-page">
      <DashboardPageHeader
        actions={<ResourceListActions
          disabled={deleting || deletingGroup || changingMember}
          onRefresh={() => void refresh()}
          refreshLabel={t('dashboard.users.actions.refresh')}
          refreshing={refreshing}
        />}
        description={t('dashboard.pages.users')}
        title={t('dashboard.nav.users')}
      />

      <div className="flex items-center justify-between gap-3 flex-wrap -mb-1">
        <TabList aria-label={t('dashboard.nav.users')} onTabSelect={(_, event) => { setTab(event.value === 'groups' ? 'groups' : 'users'); setQuery(''); }} selectedValue={tab}>
          <Tab value="users"><span className="inline-flex items-baseline gap-1.5"><span className="floway-control-label">{t('dashboard.users.tabs.users')}</span>{users && <Text className="floway-control-label text-fui-fg3 proportional-nums">{users.length}</Text>}</span></Tab>
          <Tab value="groups"><span className="inline-flex items-baseline gap-1.5"><span className="floway-control-label">{t('dashboard.users.tabs.groups')}</span>{groups && <Text className="floway-control-label text-fui-fg3 proportional-nums">{groups.length}</Text>}</span></Tab>
        </TabList>
        <div className="flex items-center gap-2 max-w-full">
          <Input aria-label={t(tab === 'users' ? 'dashboard.users.search' : 'dashboard.groupsManagement.search')} autoComplete="off" className="w-[260px]" contentBefore={<SearchRegular />} onChange={(_, value) => setQuery(value.value)} placeholder={t(tab === 'users' ? 'dashboard.users.search' : 'dashboard.groupsManagement.search')} spellCheck={false} value={query} />
          <Button
            appearance="primary"
            className="flex-none whitespace-nowrap"
            disabled={!loaded || busy}
            icon={<AddRegular />}
            onClick={() => tab === 'users' ? editorDialog.open({ kind: 'create', groups: directoryIndex!.groupOptions }) : groupDialog.open({})}
          >{t(tab === 'users' ? 'dashboard.users.actions.create' : 'dashboard.groupsManagement.actions.create')}</Button>
        </div>
      </div>

      {pageError && (
        <OutcomeMessageBar onDismiss={() => setPageError(null)}>
          {pageError}
        </OutcomeMessageBar>
      )}

      {!loaded ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
        {tab === 'users' ? <ResourceListPanel><UsersTable
          actorId={actor.id}
          disabled={busy}
          onDelete={openDeleteDialog}
          onEdit={user => editorDialog.open({ kind: 'edit', user, groupIds: directoryIndex!.groupsByUser.get(user.id)!.map(group => group.id), groups: directoryIndex!.groupOptions })}
          onResetPassword={passwordDialog.open}
          users={visibleUsers!}
          groupsByUser={directoryIndex!.groupsByUser}
        /></ResourceListPanel> : needle && visibleGroups!.length === 0 ? <Panel><EmptyStateLine>{t('dashboard.groupsManagement.noMatches')}</EmptyStateLine></Panel> : <GroupsMasterDetail
          disabled={busy}
          groups={visibleGroups!}
          membersByGroup={directoryIndex!.membersByGroup}
          users={users}
          selectedId={activeGroupId ?? null}
          onSelect={setSelectedGroupId}
          onCreate={() => groupDialog.open({})}
          onMemberChange={changeMember}
          onDelete={group => { setDeleteGroupError(null); deleteGroupDialog.open(group); }}
          onEdit={group => groupDialog.open({ group })}
        />}

        {editorDialog.invocation?.value.kind === 'create' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          key={editorDialog.invocation.key}
          mode="create"
          groups={editorDialog.invocation.value.groups}
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={() => afterSaved()}
        />}
        {editorDialog.invocation?.value.kind === 'edit' && <UserDialog
          open={editorDialog.isOpen}
          actorId={actor.id}
          key={editorDialog.invocation.key}
          mode="edit"
          groupIds={editorDialog.invocation.value.groupIds}
          groups={editorDialog.invocation.value.groups}
          onOpenChange={open => { if (!open) editorDialog.close(); }}
          onSaved={afterSaved}
          user={editorDialog.invocation.value.user}
        />}
        {groupDialog.invocation && <GroupDialog
          group={groupDialog.invocation.value.group}
          groups={groups}
          key={groupDialog.invocation.key}
          onOpenChange={open => { if (!open) groupDialog.close(); }}
          onSaved={async id => { await refresh(); setSelectedGroupId(id); }}
          open={groupDialog.isOpen}
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
