import { DeleteRegular, EditRegular, PlayRegular } from '@fluentui/react-icons';
import { useMemo, useState } from 'react';

import type { Route } from './+types/dashboard-admin-permissions';
import { requireDashboardAdmin } from './guards';
import { api, callApi } from '../api/client';
import { mapResult, mergeResults } from '../api/partial-results';
import type { AccessRecord, ControlPlaneGroup, ControlPlaneModel, ControlPlaneUser, UpstreamOption } from '../api/types';
import { AccessRecordDialog } from '../components/access-control/record-dialog';
import { permissionSummary } from '../components/access-control/records-section';
import { ScopeExpression, type ScopeExpressionData } from '../components/access-control/scope-expression';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { Dropdown } from '../components/ui/fluent-form-controls';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { SectionHeader } from '../components/ui/section-header';
import { TABLE_ACTIONS_WIDTH, TableActions, TableTrailingHeader } from '../components/ui/table-actions';
import { TableColumns } from '../components/ui/table-columns';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import { type TFunction, useTranslation } from '../i18n/translation';
import type { AccessScope } from '@floway-dev/gateway/browser';

const { Button, Field, Option, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow } = fluentComponents;

interface LoaderData {
  accessRecords: AccessRecord[] | null;
  groups: ControlPlaneGroup[] | null;
  models: ControlPlaneModel[] | null;
  upstreams: UpstreamOption[] | null;
  users: ControlPlaneUser[] | null;
  error: string | null;
}

const empty: Omit<LoaderData, 'error'> = { accessRecords: null, groups: null, models: null, upstreams: null, users: null };
const load = async (current: Omit<LoaderData, 'error'>, signal?: AbortSignal): Promise<LoaderData> => {
  const [records, groups, models, upstreams, users] = await Promise.all([
    callApi(() => api.api['access-records'].$get(undefined, { init: { signal } })),
    callApi(() => api.api.groups.$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
    callApi(() => api.api['upstream-options'].$get({ query: { view: 'all' } }, { init: { signal } })),
    callApi(() => api.api.users.$get(undefined, { init: { signal } })),
  ]);
  const merged = mergeResults(current, { accessRecords: records, groups, models: mapResult(models, body => body.data), upstreams, users });
  return { ...merged.values, error: merged.error };
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await load(empty);
}

export default function DashboardAdminPermissions({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [data, setData] = useState(loaderData);
  const [pageError, setPageError] = useState(loaderData.error);
  const editor = useDialogInvocation<{ record?: AccessRecord }>();
  const deleting = useDialogInvocation<AccessRecord>();
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const reload = async (signal: AbortSignal) => {
    const next = await load(data, signal);
    if (!signal.aborted) { setData(next); setPageError(next.error); }
  };
  const { refresh, refreshing } = useRefresh(reload);
  const { accessRecords, groups, models, upstreams, users } = data;
  const loaded = accessRecords !== null && groups !== null && models !== null && upstreams !== null && users !== null;
  const scopeData = useMemo<ScopeExpressionData>(() => ({ groups: groups ?? [], models: models ?? [], upstreams: upstreams ?? [], users: users ?? [] }), [groups, models, upstreams, users]);

  const remove = async (record: AccessRecord) => {
    setDeleteBusy(true);
    setDeleteError(null);
    const handle = toasts.start(t('dashboard.accessControl.toast.delete.pending'));
    const result = await callApi(() => api.api['access-records'][':id'].$delete({ param: { id: String(record.id) } }));
    setDeleteBusy(false);
    if (result.error) { handle.settle(); setDeleteError(result.error.message); return; }
    handle.succeed(t('dashboard.accessControl.toast.delete.success'));
    deleting.close();
    await refresh();
  };

  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions createDisabled={!loaded} createLabel={t('dashboard.accessControl.actions.add')} disabled={refreshing} onCreate={() => editor.open({})} onRefresh={() => void refresh()} refreshLabel={t('dashboard.accessControl.actions.refresh')} refreshing={refreshing} />}
      description={t('dashboard.pages.permissions')}
      title={t('dashboard.nav.permissions')}
    />
    {pageError && <OutcomeMessageBar onDismiss={() => setPageError(null)}>{pageError}</OutcomeMessageBar>}
    {!loaded ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
      <ResolveTester data={scopeData} />
      <ResourceListPanel>
        {accessRecords.length === 0 ? <ResourceListEmptyState>{t('dashboard.accessControl.empty')}</ResourceListEmptyState> : <ScrollArea axes="horizontal" className="min-w-0"><Table aria-label={t('dashboard.nav.permissions')} className="min-w-[820px]">
          <TableColumns widths={[null, null, null, '90px', TABLE_ACTIONS_WIDTH]} />
          <TableHeader><TableRow>
            <TableHeaderCell>{t('dashboard.accessControl.fields.principal')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.accessControl.fields.scope')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.accessControl.fields.permissions')}</TableHeaderCell>
            <TableHeaderCell>{t('dashboard.accessControl.fields.order')}</TableHeaderCell>
            <TableTrailingHeader>{t('dashboard.groupsManagement.table.actions')}</TableTrailingHeader>
          </TableRow></TableHeader>
          <TableBody>{accessRecords.map(record => <TableRow key={record.id}>
            <TableCell>{principalName(record, users, groups, t)}</TableCell>
            <TableCell><ScopeExpression data={scopeData} readOnly value={record.scope} /></TableCell>
            <TableCell>{permissionSummary(record.values, t)}</TableCell>
            <TableCell>{record.sortOrder}</TableCell>
            <TableCell><TableActions>
              <TooltipIconButton icon={<EditRegular />} label={t('dashboard.accessControl.actions.edit')} onClick={() => editor.open({ record })} />
              <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.accessControl.actions.delete')} onClick={() => { setDeleteError(null); deleting.open(record); }} />
            </TableActions></TableCell>
          </TableRow>)}</TableBody>
        </Table></ScrollArea>}
      </ResourceListPanel>
      {editor.invocation && <AccessRecordDialog data={scopeData} key={editor.invocation.key} onOpenChange={open => !open && editor.close()} onSaved={refresh} open={editor.isOpen} record={editor.invocation.value.record} suggestedSortOrder={Math.max(-1, ...accessRecords.map(record => record.sortOrder)) + 1} />}
      {deleting.invocation && <ConfirmDialog actionLabel={t('dashboard.accessControl.actions.delete')} busy={deleteBusy} error={deleteError} message={t('dashboard.accessControl.delete.message')} onConfirm={() => void remove(deleting.invocation!.value)} onDismissError={() => setDeleteError(null)} onOpenChange={open => !open && deleting.close()} open={deleting.isOpen} title={t('dashboard.accessControl.delete.title')} />}
    </>}
  </section>;
}

export function ResolveTester({ data }: { data: ScopeExpressionData }) {
  const { t } = useTranslation();
  const initialUser = data.users.find(user => !user.isAdmin) ?? data.users[0];
  const [userId, setUserId] = useState(initialUser?.id ?? 0);
  const [scope, setScope] = useState<AccessScope | null>(() => initialUser ? { kind: 'user', userId: initialUser.id } : null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target = scopeToTarget(scope);
  const run = async () => {
    if (!target || !userId) return;
    const response = await callApi(() => api.api['access-resolve'].$post({ json: { userId, target } }));
    if (response.error) {
      setError(response.error.message);
      setResult(null);
    } else {
      setResult(response.data.values);
      setError(null);
    }
  };
  return <Panel><div className="grid gap-3">
    <SectionHeader actions={<Button disabled={!target || !userId} icon={<PlayRegular />} onClick={() => void run()}>{t('dashboard.accessControl.actions.resolve')}</Button>} level={3} title={t('dashboard.accessControl.resolve.title')} />
    <div className="grid gap-3 md:grid-cols-2">
      <Field label={t('dashboard.accessControl.resolve.user')}><Dropdown onOptionSelect={(_, option) => option.optionValue && setUserId(Number(option.optionValue))} selectedOptions={[String(userId)]} value={data.users.find(user => user.id === userId)?.username ?? ''}>{data.users.map(user => <Option key={user.id} value={String(user.id)}>{user.username}</Option>)}</Dropdown></Field>
      <Field label={t('dashboard.accessControl.resolve.target')}><ScopeExpression data={data} onChange={setScope} value={scope} /></Field>
    </div>
    {result && <Field label={t('dashboard.accessControl.resolve.result')}><pre className="m-0 font-mono text-xs overflow-auto">{JSON.stringify(result, null, 2)}</pre></Field>}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
  </div></Panel>;
}

const principalName = (record: AccessRecord, users: ControlPlaneUser[], groups: ControlPlaneGroup[], t: TFunction) => record.principal.kind === 'user'
  ? t('dashboard.accessControl.principal.user', { name: users.find(user => user.id === record.principal.id)?.username ?? String(record.principal.id) })
  : t('dashboard.accessControl.principal.group', { name: groups.find(group => group.id === record.principal.id)?.name ?? String(record.principal.id) });
const scopeToTarget = (scope: AccessScope | null) => scope?.kind === 'upstream'
  ? { kind: 'upstream' as const, upstreamId: scope.upstreamId }
  : scope?.kind === 'upstreamModel' && scope.model.kind === 'exact'
    ? { kind: 'upstreamModel' as const, upstreamId: scope.upstreamId, modelId: scope.model.value }
    : scope?.kind === 'user' ? { kind: 'user' as const, userId: scope.userId } : null;
