import { DeleteRegular, EditRegular, WarningRegular } from '@fluentui/react-icons';
import { useCallback, useMemo, useState } from 'react';

import { useTranslation } from '../i18n/translation';
import type { Route } from './+types/dashboard-providers-model-aliases';
import { requireDashboardAdmin } from './guards';
import { api, callApi, callApiNoContent } from '../api/client';
import { mapResult, mergeResults } from '../api/partial-results';
import type { ControlPlaneModel } from '../api/types';
import { AliasDialog } from '../components/model-alias/dialog';
import { computeAliasWarnings, modelAliasWarningText } from '../components/model-alias/warnings';
import { indexCatalog } from '../components/models/catalog-index';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { EmptyStateLine } from '../components/ui/empty-state';
import { OutcomeMessageBar } from '../components/ui/outcome-message-bar';
import { useOutcomeToasts } from '../components/ui/outcome-toast';
import { Panel } from '../components/ui/panel';
import { ResourceListActions, ResourceListEmptyState, ResourceListPanel } from '../components/ui/resource-list';
import { ScrollArea } from '../components/ui/scroll-area';
import { TABLE_ACTIONS_WIDTH, TableActions, TableCentredCell, TableCentredHeader, TableTrailingHeader } from '../components/ui/table-actions';
import { TableColumns } from '../components/ui/table-columns';
import { TooltipIconButton } from '../components/ui/tooltip-icon-button';
import { TruncationTooltip } from '../components/ui/truncation-tooltip';
import { useDialogInvocation } from '../components/ui/use-dialog-invocation';
import { useRefresh } from '../components/ui/use-refresh';
import { fluentComponents } from '../fluent';
import type { ModelAlias } from '@floway-dev/protocols/common';

const { Table, TableBody, TableCell, TableCellLayout, TableHeader, TableHeaderCell, TableRow, Text, Tooltip } = fluentComponents;

// `null` is a fetch that failed, distinct from a deployment that genuinely has
// no alias: an empty table invites a second copy of an alias that already
// exists.
interface LoaderData {
  catalog: { aliases: ModelAlias[] | null; models: ControlPlaneModel[] | null };
  error: string | null;
  modelsError: string | null;
}

const loadPageData = async (current: LoaderData['catalog'], signal?: AbortSignal): Promise<LoaderData> => {
  const [aliasResult, modelResult] = await Promise.all([
    callApi(() => api.api.aliases.$get(undefined, { init: { signal } })),
    callApi(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } }, { init: { signal } })),
  ]);
  const { values, errors } = mergeResults(current, {
    aliases: aliasResult,
    models: mapResult(modelResult, body => body.data),
  });
  return { catalog: values, error: errors.aliases, modelsError: errors.models };
};

export async function clientLoader(): Promise<LoaderData> {
  await requireDashboardAdmin();
  return await loadPageData({ aliases: null, models: null });
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

  // The error belongs to the attempt that produced it, not to the dialog.
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
    <DashboardPageHeader
      actions={<ResourceListActions
        createDisabled={aliases === null}
        createLabel={t('dashboard.modelAliases.actions.create')}
        disabled={mutating}
        onCreate={() => editorDialog.open(null)}
        onRefresh={() => void refresh()}
        refreshLabel={t('dashboard.modelAliases.actions.refresh')}
        refreshing={refreshing}
      />}
      description={t('dashboard.modelAliases.description')}
      title={t('dashboard.nav.modelAliases')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{t('dashboard.modelAliases.errors.message', { message: error })}</OutcomeMessageBar>}
    {modelsError && <OutcomeMessageBar intent="warning" onDismiss={() => setModelsError(null)}>{t('dashboard.modelAliases.errors.models', { message: modelsError })}</OutcomeMessageBar>}
    {aliases === null ? <Panel><EmptyStateLine>{t('dashboard.pages.unavailable')}</EmptyStateLine></Panel> : <>
      <ResourceListPanel rowHeight="56px">
        {aliases.length === 0 ? <ResourceListEmptyState>{t('dashboard.modelAliases.empty')}</ResourceListEmptyState> : <ScrollArea axes="horizontal" className="min-w-0"><Table aria-label={t('dashboard.modelAliases.listTitle')} className="min-w-[780px]"><TableColumns widths={[null, '88px', '88px', '120px', '96px', TABLE_ACTIONS_WIDTH]} /><TableHeader><TableRow><TableHeaderCell>{t('dashboard.modelAliases.columns.alias')}</TableHeaderCell><TableCentredHeader>{t('dashboard.modelAliases.columns.kind')}</TableCentredHeader><TableCentredHeader>{t('dashboard.modelAliases.columns.targets')}</TableCentredHeader><TableCentredHeader>{t('dashboard.modelAliases.columns.selection')}</TableCentredHeader><TableCentredHeader>{t('dashboard.modelAliases.columns.visibility')}</TableCentredHeader><TableTrailingHeader>{t('dashboard.modelAliases.columns.actions')}</TableTrailingHeader></TableRow></TableHeader><TableBody>{aliases.map(alias => {
          const warnings = computeAliasWarnings(alias, modelIndex);
          return <TableRow key={alias.name}><TableCell className="overflow-hidden"><div className="flex items-center gap-2 min-w-0 max-w-full"><TableCellLayout description={<TruncationTooltip content={alias.name} relationship="label">{measureRef => <Text block className="winui-focus-rect font-mono" ref={measureRef} tabIndex={0} truncate wrap={false}>{alias.name}</Text>}</TruncationTooltip>} truncate><TruncationTooltip content={alias.display_name ?? alias.name} relationship="label">{measureRef => <Text block className="winui-focus-rect" ref={measureRef} truncate tabIndex={0} wrap={false}>{alias.display_name ?? alias.name}</Text>}</TruncationTooltip></TableCellLayout>{warnings.length > 0 && <Tooltip content={warnings.map(warning => modelAliasWarningText(warning, t)).join('\n')} relationship="description"><WarningRegular aria-label={t('dashboard.modelAliases.warnings.label')} className="winui-focus-rect flex-none" tabIndex={0} /></Tooltip>}</div></TableCell><TableCentredCell>{t(`dashboard.modelAliases.kind.${alias.kind}`)}</TableCentredCell><TableCentredCell>{t('dashboard.modelAliases.target.count', { count: alias.targets.length })}</TableCentredCell><TableCentredCell>{t(`dashboard.modelAliases.selection.${alias.selection === 'first-available' ? 'first' : 'random'}`)}</TableCentredCell><TableCentredCell>{alias.visible_in_models_list ? t('dashboard.modelAliases.visibility.visible') : t('dashboard.modelAliases.visibility.hidden')}</TableCentredCell><TableCell><TableActions><TooltipIconButton disabled={refreshing || mutating} icon={<EditRegular />} label={t('dashboard.modelAliases.actions.editNamed', { name: alias.name })} onClick={() => editorDialog.open(alias)} /><TooltipIconButton danger disabled={refreshing || mutating} icon={<DeleteRegular />} label={t('dashboard.modelAliases.actions.deleteNamed', { name: alias.name })} onClick={() => openDeleteDialog(alias)} /></TableActions></TableCell></TableRow>;
        })}</TableBody></Table></ScrollArea>}
      </ResourceListPanel>
      {editorDialog.invocation && <AliasDialog open={editorDialog.isOpen} aliases={aliases} key={editorDialog.invocation.key} models={models} onOpenChange={open => { if (!open) editorDialog.close(); }} onSaved={refresh} record={editorDialog.invocation.value} />}
      {deleteDialog.invocation && <ConfirmDialog open={deleteDialog.isOpen} busy={mutating} error={deleteError} key={deleteDialog.invocation.key} onDismissError={() => setDeleteError(null)} onOpenChange={open => { if (!open) deleteDialog.close(); }} title={t('dashboard.modelAliases.delete.title')} message={t('dashboard.modelAliases.delete.message', { name: deleteDialog.invocation.value.name })} actionLabel={t('dashboard.modelAliases.actions.delete')} onConfirm={() => void deleteAlias(deleteDialog.invocation!.value)} />}
    </>}
  </section>;
}
