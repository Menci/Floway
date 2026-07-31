import { DeleteRegular, EditRegular, WarningRegular } from '@fluentui/react-icons';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-model-aliases';
import { api, callApi, callApiNoContent } from '../api/client';
import type { ControlPlaneModel, ModelAlias } from '../api/types';
import { requireAdmin } from '../auth/require-admin';
import { getSessionToken } from '../auth/session';
import { AliasDialog } from '../components/model-alias/alias-dialog';
import { mergeModelAliasesPageData } from '../components/model-alias/load-data';
import { computeAliasWarnings } from '../components/model-alias/warnings';
import { indexCatalog } from '../components/models/catalog-index';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { TableActions, TableActionsHeader, TableCentredCell, TableCentredHeader } from '../components/ui/table-actions';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';

const { Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip } = fluentComponents;

interface LoaderData {
  catalog: { aliases: ModelAlias[]; models: ControlPlaneModel[] | null };
  error: string | null;
  modelsError: string | null;
}

const loadPageData = async (current: LoaderData['catalog'], signal?: AbortSignal): Promise<LoaderData> => {
  const [aliasResult, modelResult] = await Promise.all([
    callApi(() => api.api.aliases.$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
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
  if (!(await requireAdmin())) throw redirect('/dashboard/services/api-keys');
  return await loadPageData({ aliases: [], models: null });
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Model Aliases | Floway' }];
}

export default function DashboardProvidersModelAliases({ loaderData }: Route.ComponentProps) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [catalog, setCatalog] = useState(loaderData.catalog);
  const { aliases, models } = catalog;
  const modelIndex = useMemo(() => models === null ? null : indexCatalog(models), [models]);
  const [error, setError] = useState(loaderData.error);
  const [modelsError, setModelsError] = useState(loaderData.modelsError);
  const editorDialog = useDialogInvocation<ModelAlias | null>();
  const deleteDialog = useDialogInvocation<ModelAlias>();
  const [mutating, setMutating] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // The error belongs to the attempt that produced it. Opening the dialog for
  // another alias starts a new attempt, so the previous one's failure is
  // cleared here rather than waiting for a dismissal that may never come.
  const openDeleteDialog = (target: ModelAlias) => {
    setDeleteError(null);
    deleteDialog.open(target);
  };

  const load = useCallback(async (signal: AbortSignal) => {
    const next = await loadPageData(catalog, signal);
    if (signal.aborted) return;
    setCatalog(next.catalog);
    setError(next.error);
    setModelsError(next.modelsError);
  }, [catalog]);

  const { refresh, refreshing } = useRefresh(load);

  const header = <DashboardPageHeader
    actions={<ResourceListActions
      createLabel={t('dashboard.modelAliases.actions.create')}
      onCreate={() => editorDialog.open(null)}
      onRefresh={() => void refresh()}
      refreshLabel={t('dashboard.modelAliases.actions.refresh')}
      refreshing={refreshing}
    />}
    description={t('dashboard.modelAliases.description')}
    title={t('dashboard.modelAliases.heading')}
  />;

  const deleteAlias = async (target: ModelAlias) => {
    setMutating(true);
    setDeleteError(null);
    const handle = toasts.start(t('dashboard.modelAliases.toast.delete.pending', { name: target.name }));
    const result = await callApiNoContent(() => api.api.aliases[':id'].$delete({ param: { id: target.id } }));
    setMutating(false);
    if (result.error) {
      handle.settle();
      setDeleteError(result.error.message);
      return;
    }
    deleteDialog.close();
    handle.succeed(t('dashboard.modelAliases.toast.delete.success', { name: target.name }));
    await refresh();
  };

  return <section className="dashboard-page">
    {header}
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{t('dashboard.modelAliases.errors.message', { message: error })}</OutcomeMessageBar>}
    {modelsError && <OutcomeMessageBar intent="warning" onDismiss={() => setModelsError(null)}>{t('dashboard.modelAliases.errors.models', { message: modelsError })}</OutcomeMessageBar>}
    <ResourceListPanel rowHeight="56px">
      {aliases.length === 0 ? <ResourceListEmptyState>{t('dashboard.modelAliases.empty')}</ResourceListEmptyState> : <ScrollArea axes="horizontal"><Table aria-label={t('dashboard.modelAliases.listTitle')} className="w-full min-w-[760px] table-fixed"><TableHeader><TableRow><TableHeaderCell>{t('dashboard.modelAliases.columns.alias')}</TableHeaderCell><TableCentredHeader className="!w-[88px]">{t('dashboard.modelAliases.columns.kind')}</TableCentredHeader><TableCentredHeader className="!w-[88px]">{t('dashboard.modelAliases.columns.targets')}</TableCentredHeader><TableCentredHeader className="!w-[120px]">{t('dashboard.modelAliases.columns.selection')}</TableCentredHeader><TableCentredHeader className="!w-[96px]">{t('dashboard.modelAliases.columns.visibility')}</TableCentredHeader><TableActionsHeader className="!w-[88px]">{t('dashboard.modelAliases.columns.actions')}</TableActionsHeader></TableRow></TableHeader><TableBody>{aliases.map(alias => {
        const warnings = computeAliasWarnings(alias, modelIndex);
        return <TableRow key={alias.name}><TableCell className="overflow-hidden"><div className="flex items-center gap-2 min-w-0 max-w-full"><div className="grid gap-[3px] min-w-0 flex-1 overflow-hidden"><Text block className="overflow-hidden text-ellipsis whitespace-nowrap" title={alias.display_name ?? alias.name} wrap={false}>{alias.display_name ?? alias.name}</Text><Text block size={200} className="font-mono text-fui-fg2 overflow-hidden text-ellipsis whitespace-nowrap" title={alias.name} wrap={false}>{alias.name}</Text></div>{warnings.length > 0 && <Tooltip content={warnings.map(warning => t(`dashboard.modelAliases.warnings.${warning.key}`, warning.values)).join('\n')} relationship="description"><WarningRegular aria-label={t('dashboard.modelAliases.warnings.label')} className="flex-none" /></Tooltip>}</div></TableCell><TableCentredCell>{t(`dashboard.modelAliases.kind.${alias.kind}`)}</TableCentredCell><TableCentredCell>{t('dashboard.modelAliases.target.count', { count: alias.targets.length })}</TableCentredCell><TableCentredCell>{t(`dashboard.modelAliases.selection.${alias.selection === 'first-available' ? 'first' : 'random'}`)}</TableCentredCell><TableCentredCell>{alias.visible_in_models_list ? t('dashboard.modelAliases.visibility.visible') : t('dashboard.modelAliases.visibility.hidden')}</TableCentredCell><TableCell><TableActions><TooltipIconButton disabled={refreshing || mutating} icon={<EditRegular />} label={t('dashboard.modelAliases.actions.editNamed', { name: alias.name })} onClick={() => editorDialog.open(alias)} /><TooltipIconButton danger disabled={refreshing || mutating} icon={<DeleteRegular />} label={t('dashboard.modelAliases.actions.deleteNamed', { name: alias.name })} onClick={() => openDeleteDialog(alias)} /></TableActions></TableCell></TableRow>;
      })}</TableBody></Table></ScrollArea>}
    </ResourceListPanel>
    {editorDialog.invocation && <AliasDialog open={editorDialog.isOpen} aliases={aliases} key={editorDialog.invocation.key} models={models} onOpenChange={open => { if (!open) editorDialog.close(); }} onSaved={refresh} record={editorDialog.invocation.value} />}
    {deleteDialog.invocation && <ConfirmDialog open={deleteDialog.isOpen} busy={mutating} error={deleteError} key={deleteDialog.invocation.key} onDismissError={() => setDeleteError(null)} onOpenChange={open => { if (!open) deleteDialog.close(); }} title={t('dashboard.modelAliases.delete.title')} message={t('dashboard.modelAliases.delete.message', { name: deleteDialog.invocation.value.name })} actionLabel={mutating ? t('dashboard.modelAliases.actions.deleting') : t('dashboard.modelAliases.actions.delete')} onConfirm={() => void deleteAlias(deleteDialog.invocation!.value)} />}
  </section>;
}
