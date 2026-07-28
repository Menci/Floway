import { AddRegular, ArrowClockwiseRegular, DeleteRegular, EditRegular, WarningRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { redirect } from 'react-router';

import type { Route } from './+types/dashboard-providers-model-aliases';
import { useDashboardOutletContext } from './dashboard';
import { callApi } from '../api/auth';
import { api } from '../api/client';
import type { ControlPlaneModel, ModelAlias } from '../api/types';
import { getSessionToken } from '../auth/session';
import { AliasDialog } from '../components/model-alias/alias-dialog';
import { mergeModelAliasesPageData } from '../components/model-alias/load-data';
import { computeAliasWarnings } from '../components/model-alias/warnings';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { DashboardPageHeader } from '../components/ui/dashboard-page-header';
import { PageLoadingPanel } from '../components/ui/page-loading-panel';
import { Panel } from '../components/ui/panel';
import { fluentComponents } from '../fluent';

const { Button, MessageBar, MessageBarBody, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Tooltip } = fluentComponents;

interface ModelsResponse { data: ControlPlaneModel[] }

export async function clientLoader() {
  if (!getSessionToken()) throw redirect('/');
  return null;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: 'Model Aliases | Floway' }];
}

export default function DashboardProvidersModelAliases() {
  const { t } = useTranslation();
  const { user } = useDashboardOutletContext();
  const [catalog, setCatalog] = useState<{
    aliases: ModelAlias[];
    models: ControlPlaneModel[] | null;
  }>({ aliases: [], models: null });
  const { aliases, models } = catalog;
  const [loading, setLoading] = useState(user.isAdmin);
  const [error, setError] = useState<string | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<ModelAlias | null>(null);
  const [deleting, setDeleting] = useState<ModelAlias | null>(null);
  const [mutating, setMutating] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setModelsError(null);
    const [aliasResult, modelResult] = await Promise.all([
      callApi<ModelAlias[]>(() => api.api.aliases.$get()),
      callApi<ModelsResponse>(() => api.api.models.$get({ query: { aliases: 'false', include_unlisted: 'true' } })),
    ]);
    setCatalog(current => {
      const next = mergeModelAliasesPageData(current, aliasResult, modelResult);
      return { aliases: next.aliases, models: next.models };
    });
    setError(aliasResult.error?.message ?? null);
    setModelsError(modelResult.error?.message ?? null);
    setLoading(false);
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- Loading the alias list on mount; the pending flag begins that work.
  useEffect(() => { if (user.isAdmin) void load(); }, [load, user.isAdmin]);

  const header = <DashboardPageHeader description={t('dashboard.modelAliases.description')} eyebrow={t('dashboard.groups.providers')} title={t('dashboard.modelAliases.heading')} />;
  if (!user.isAdmin) return <section className="grid gap-[18px] max-w-[960px]">{header}<Panel className="!p-[22px_24px]"><Text weight="semibold">{t('dashboard.pages.adminOnly')}</Text><Text block className="text-fui-fg2 mt-2">{t('dashboard.pages.adminOnlyDescription')}</Text></Panel></section>;

  const openCreate = () => { setEditing(null); setDialogOpen(true); };
  const openEdit = (alias: ModelAlias) => { setEditing(alias); setDialogOpen(true); };
  const deleteAlias = async () => {
    if (!deleting) return;
    setMutating(true); setError(null);
    try {
      const response = await api.api.aliases[':name'].$delete({ param: { name: deleting.name } });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try { const body = await response.json() as { error?: string }; message = body.error ?? message; } catch { /* status fallback */ }
        setError(message);
      } else {
        setDeleting(null); await load();
      }
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
    setMutating(false);
  };

  return <section className="grid gap-[18px] max-w-[1120px] min-w-0">
    {header}
    {error && <MessageBar intent="error"><MessageBarBody>{t('dashboard.modelAliases.errors.message', { message: error })}</MessageBarBody></MessageBar>}
    {modelsError && <MessageBar intent="warning"><MessageBarBody>{t('dashboard.modelAliases.errors.models', { message: modelsError })}</MessageBarBody></MessageBar>}
    {loading ? <PageLoadingPanel label={t('common.loading')} /> : <Panel className="overflow-hidden">
      <div className="flex items-center justify-between gap-3 max-[560px]:items-start">
        <div><Text size={400} weight="semibold">{t('dashboard.modelAliases.listTitle')}</Text><Text block size={200} className="text-fui-fg2 mt-1">{t('dashboard.modelAliases.count', { count: aliases.length })}</Text></div>
        <div className="flex gap-2"><Tooltip content={t('dashboard.modelAliases.actions.refresh')} relationship="label"><Button aria-label={t('dashboard.modelAliases.actions.refresh')} icon={<ArrowClockwiseRegular />} onClick={() => { setLoading(true); void load(); }} /></Tooltip><Button appearance="primary" icon={<AddRegular />} onClick={openCreate}>{t('dashboard.modelAliases.actions.create')}</Button></div>
      </div>
      {aliases.length === 0 ? <Text className="text-fui-fg2">{t('dashboard.modelAliases.empty')}</Text> : <div className="overflow-x-auto"><Table aria-label={t('dashboard.modelAliases.listTitle')} className="w-full min-w-[760px] table-fixed"><TableHeader><TableRow><TableHeaderCell>{t('dashboard.modelAliases.columns.alias')}</TableHeaderCell><TableHeaderCell className="!w-[88px]">{t('dashboard.modelAliases.columns.kind')}</TableHeaderCell><TableHeaderCell className="!w-[88px]">{t('dashboard.modelAliases.columns.targets')}</TableHeaderCell><TableHeaderCell className="!w-[120px]">{t('dashboard.modelAliases.columns.selection')}</TableHeaderCell><TableHeaderCell className="!w-[96px]">{t('dashboard.modelAliases.columns.visibility')}</TableHeaderCell><TableHeaderCell className="!w-[88px]">{t('dashboard.modelAliases.columns.actions')}</TableHeaderCell></TableRow></TableHeader><TableBody>{aliases.map(alias => {
        const warnings = computeAliasWarnings(alias, models);
        return <TableRow key={alias.name}><TableCell className="!overflow-hidden"><div className="flex items-center gap-2 min-w-0 max-w-full"><div className="min-w-0 flex-1 overflow-hidden"><Text block className="overflow-hidden text-ellipsis whitespace-nowrap" title={alias.display_name ?? alias.name} weight="semibold" wrap={false}>{alias.display_name ?? alias.name}</Text><Text block size={200} className="font-mono text-fui-fg2 overflow-hidden text-ellipsis whitespace-nowrap" title={alias.name} wrap={false}>{alias.name}</Text></div>{warnings.length > 0 && <Tooltip content={warnings.map(warning => t(`dashboard.modelAliases.warnings.${warning.key}`, warning.values)).join('\n')} relationship="description"><WarningRegular aria-label={t('dashboard.modelAliases.warnings.label')} className="flex-none" /></Tooltip>}</div></TableCell><TableCell>{t(`dashboard.modelAliases.kind.${alias.kind}`)}</TableCell><TableCell>{t('dashboard.modelAliases.target.count', { count: alias.targets.length })}</TableCell><TableCell>{t(`dashboard.modelAliases.selection.${alias.selection === 'first-available' ? 'first' : 'random'}`)}</TableCell><TableCell>{alias.visible_in_models_list ? t('dashboard.modelAliases.visibility.visible') : t('dashboard.modelAliases.visibility.hidden')}</TableCell><TableCell><div className="flex gap-1"><Button appearance="subtle" aria-label={t('dashboard.modelAliases.actions.editNamed', { name: alias.name })} icon={<EditRegular />} onClick={() => openEdit(alias)} /><Button appearance="subtle" aria-label={t('dashboard.modelAliases.actions.deleteNamed', { name: alias.name })} icon={<DeleteRegular />} onClick={() => setDeleting(alias)} /></div></TableCell></TableRow>;
      })}</TableBody></Table></div>}
    </Panel>}
    <AliasDialog key={dialogOpen ? (editing?.name ?? 'new') : 'closed'} aliases={aliases} models={models} onOpenChange={setDialogOpen} onSaved={load} open={dialogOpen} record={editing} />
    <ConfirmDialog busy={mutating} open={deleting !== null} onOpenChange={open => !open && !mutating && setDeleting(null)} title={t('dashboard.modelAliases.delete.title')} message={t('dashboard.modelAliases.delete.message', { name: deleting?.name ?? '' })} actionLabel={mutating ? t('dashboard.modelAliases.actions.deleting') : t('dashboard.modelAliases.actions.delete')} onConfirm={() => void deleteAlias()} />
  </section>;
}
