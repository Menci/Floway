import { DeleteRegular, EditRegular, WarningRegular } from '@fluentui/react-icons';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-model-aliases';
import { useDashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ControlPlaneModel, ModelAlias } from '../api/types';
import { getSessionToken } from '../auth/session';
import { AdminOnlyNotice } from '../components/admin-only-notice';
import { AliasDialog } from '../components/model-alias/alias-dialog';
import { mergeModelAliasesPageData } from '../components/model-alias/load-data';
import { computeAliasWarnings } from '../components/model-alias/warnings';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { TableActions, TableActionsHeader } from '../components/ui/table-actions';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { fluentComponents } from '../fluent';

const { MessageBar, MessageBarBody, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip } = fluentComponents;

interface LoaderData {
  catalog: { aliases: ModelAlias[]; models: ControlPlaneModel[] | null };
  error: string | null;
  modelsError: string | null;
}

const loadPageData = async (current: LoaderData['catalog']): Promise<LoaderData> => {
  const [aliasResult, modelResult] = await Promise.all([
    callApi(() => api.api.aliases.$get()),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
  ]);
  const catalog = mergeModelAliasesPageData(current, aliasResult, modelResult);
  return {
    catalog: { aliases: catalog.aliases, models: catalog.models },
    error: aliasResult.error?.message ?? null,
    modelsError: modelResult.error?.message ?? null,
  };
};

export async function clientLoader(): Promise<LoaderData> {
  if (!getSessionToken()) throw redirect('/');
  return await loadPageData({ aliases: [], models: null });
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Model Aliases | Floway' }];
}

export default function DashboardProvidersModelAliases({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const toasts = useOutcomeToasts();
  const [catalog, setCatalog] = useState(loaderData.catalog);
  const { aliases, models } = catalog;
  const [error, setError] = useState(loaderData.error);
  const [modelsError, setModelsError] = useState(loaderData.modelsError);
  const editorDialog = useDialogInvocation<ModelAlias | null>();
  const deleteDialog = useDialogInvocation<ModelAlias>();
  const [mutating, setMutating] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    const next = await loadPageData(catalog);
    setCatalog(next.catalog);
    setError(next.error);
    setModelsError(next.modelsError);
  }, [catalog]);

  const refresh = async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  };

  const header = <DashboardPageHeader
    actions={user.isAdmin ? <ResourceListActions
      createLabel={t('dashboard.modelAliases.actions.create')}
      onCreate={() => editorDialog.open(null)}
      onRefresh={() => void refresh()}
      refreshLabel={t('dashboard.modelAliases.actions.refresh')}
      refreshing={refreshing}
    /> : undefined}
    description={t('dashboard.modelAliases.description')}
    eyebrow={t('dashboard.groups.providers')}
    title={t('dashboard.modelAliases.heading')}
  />;
  if (!user.isAdmin) return <section className="dashboard-page">{header}<AdminOnlyNotice /></section>;

  const deleteAlias = async (target: ModelAlias) => {
    setMutating(true); setError(null);
    try {
      const response = await api.api.aliases[':name'].$delete({ param: { name: target.name } });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { const body = await response.json() as { error?: string }; message = body.error ?? message; } catch { /* status fallback */ }
        setError(message);
      } else {
        deleteDialog.close(); await load();
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    setMutating(false);
  };

  return <section className="dashboard-page">
    {header}
    {error && <MessageBar intent="error"><MessageBarBody>{t('dashboard.modelAliases.errors.message', { message: error })}</MessageBarBody></MessageBar>}
    {modelsError && <MessageBar intent="warning"><MessageBarBody>{t('dashboard.modelAliases.errors.models', { message: modelsError })}</MessageBarBody></MessageBar>}
    <ResourceListPanel rowHeight="56px">
      {aliases.length === 0 ? <ResourceListEmptyState>{t('dashboard.modelAliases.empty')}</ResourceListEmptyState> : <ScrollArea axes="horizontal"><Table aria-label={t('dashboard.modelAliases.listTitle')} className="w-full min-w-[760px] table-fixed"><TableHeader><TableRow><TableHeaderCell>{t('dashboard.modelAliases.columns.alias')}</TableHeaderCell><TableHeaderCell className="!w-[88px]">{t('dashboard.modelAliases.columns.kind')}</TableHeaderCell><TableHeaderCell className="!w-[88px]">{t('dashboard.modelAliases.columns.targets')}</TableHeaderCell><TableHeaderCell className="!w-[120px]">{t('dashboard.modelAliases.columns.selection')}</TableHeaderCell><TableHeaderCell className="!w-[96px]">{t('dashboard.modelAliases.columns.visibility')}</TableHeaderCell><TableActionsHeader className="!w-[88px]">{t('dashboard.modelAliases.columns.actions')}</TableActionsHeader></TableRow></TableHeader><TableBody>{aliases.map(alias => {
        const warnings = computeAliasWarnings(alias, models);
        return <TableRow key={alias.name}><TableCell className="overflow-hidden"><div className="flex items-center gap-2 min-w-0 max-w-full"><div className="grid gap-[3px] min-w-0 flex-1 overflow-hidden"><Text block className="overflow-hidden text-ellipsis whitespace-nowrap" title={alias.display_name ?? alias.name} wrap={false}>{alias.display_name ?? alias.name}</Text><Text block size={200} className="font-mono text-fui-fg2 overflow-hidden text-ellipsis whitespace-nowrap" title={alias.name} wrap={false}>{alias.name}</Text></div>{warnings.length > 0 && <Tooltip content={warnings.map(warning => t(`dashboard.modelAliases.warnings.${warning.key}`, warning.values)).join('\n')} relationship="description"><WarningRegular aria-label={t('dashboard.modelAliases.warnings.label')} className="flex-none" /></Tooltip>}</div></TableCell><TableCell>{t(`dashboard.modelAliases.kind.${alias.kind}`)}</TableCell><TableCell>{t('dashboard.modelAliases.target.count', { count: alias.targets.length })}</TableCell><TableCell>{t(`dashboard.modelAliases.selection.${alias.selection === 'first-available' ? 'first' : 'random'}`)}</TableCell><TableCell>{alias.visible_in_models_list ? t('dashboard.modelAliases.visibility.visible') : t('dashboard.modelAliases.visibility.hidden')}</TableCell><TableCell><TableActions><TooltipIconButton disabled={refreshing || mutating} icon={<EditRegular />} label={t('dashboard.modelAliases.actions.editNamed', { name: alias.name })} onClick={() => editorDialog.open(alias)} /><TooltipIconButton danger disabled={refreshing || mutating} icon={<DeleteRegular />} label={t('dashboard.modelAliases.actions.deleteNamed', { name: alias.name })} onClick={() => deleteDialog.open(alias)} /></TableActions></TableCell></TableRow>;
      })}</TableBody></Table></ScrollArea>}
    </ResourceListPanel>
    {editorDialog.invocation && <AliasDialog open={editorDialog.isOpen} aliases={aliases} key={editorDialog.invocation.key} models={models} onOpenChange={open => { if (!open) editorDialog.close(); }} onSaved={load} record={editorDialog.invocation.value} />}
    {deleteDialog.invocation && <ConfirmDialog open={deleteDialog.isOpen} busy={mutating} key={deleteDialog.invocation.key} onOpenChange={open => { if (!mutating && !open) deleteDialog.close(); }} title={t('dashboard.modelAliases.delete.title')} message={t('dashboard.modelAliases.delete.message', { name: deleteDialog.invocation.value.name })} actionLabel={mutating ? t('dashboard.modelAliases.actions.deleting') : t('dashboard.modelAliases.actions.delete')} onConfirm={() => void deleteAlias(deleteDialog.invocation!.value)} />}
  </section>;
}
