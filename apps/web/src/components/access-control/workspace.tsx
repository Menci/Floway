import { AddRegular, ChevronLeftRegular, ChevronRightRegular, SearchRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigation, useSearchParams } from 'react-router';

import { loadPermissionsData, type PermissionsData } from './data';
import { permissionSearchText, selectPermissionRules } from './effective';
import { recordSegments, reorderModelRecords } from './order';
import { PrincipalPicker } from './principal';
import { parsePrincipal, principalKey } from './principals';
import { AccessRecordDialog } from './record-dialog';
import { useAccessResolution } from './resolution';
import { RulesTable } from './rules-table';
import { parseScope } from './scope';
import { ScopeEditor, type ScopeExpressionData } from './scope-expression';
import { api, callApi } from '../../api/client';
import type { AccessRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { DashboardPageHeader } from '../ui/dashboard-page-header';
import { EmptyState } from '../ui/empty-state';
import { Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { ResourceListActions, ResourceListPanel } from '../ui/resource-list';
import { SwitchSetting } from '../ui/switch-setting';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useRefresh } from '../ui/use-refresh';
import type { AccessPrincipal, AccessScope } from '@floway-dev/gateway/browser';

const { Button, Field, Spinner, Text } = fluentComponents;
const PAGE_SIZE = 20;

export function PermissionsWorkspace({ initial }: { initial: PermissionsData }) {
  const { t } = useTranslation();
  const toasts = useOutcomeToasts();
  const [data, setData] = useState(initial);
  const [error, setError] = useState(initial.error);
  const [reordering, setReordering] = useState(false);
  const [scopeEditorRevision, setScopeEditorRevision] = useState(0);
  const [committedParams, setParams] = useSearchParams();
  const location = useLocation();
  const navigation = useNavigation();
  // The loading destination keeps native controls current before URL commit.
  // https://reactrouter.com/api/hooks/useNavigation#navigationlocation
  const params = navigation.location?.pathname === location.pathname ? new URLSearchParams(navigation.location.search) : committedParams;
  const editor = useDialogInvocation<{ record?: AccessRecord; principal?: AccessPrincipal; scope?: AccessScope }>();
  const reload = async (signal: AbortSignal) => {
    const next = await loadPermissionsData(data, signal);
    if (!signal.aborted) { setData(next); setError(next.error); }
  };
  const { refresh, refreshing } = useRefresh(reload);
  const query = params.get('q') ?? '';
  const principal = parsePrincipal(params.get('principal') ?? '');
  const scope = parseScope(params.get('scope'));
  const scopeKind = params.get('scopeKind') === 'group' && scope === null ? 'group' : undefined;
  const effectiveUnavailable = principal === null || scope === null;
  const showEffective = !effectiveUnavailable && params.get('effective') === 'true';
  useEffect(() => {
    if (!committedParams.has('effective') || (parsePrincipal(committedParams.get('principal') ?? '') !== null && parseScope(committedParams.get('scope')) !== null)) return;
    const next = new URLSearchParams(committedParams);
    next.delete('effective');
    setParams(next, { replace: true, state: location.state });
  }, [committedParams, location.state, setParams]);
  const updateParams = (change: (next: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(params);
    if (effectiveUnavailable) next.delete('effective');
    change(next);
    if (parsePrincipal(next.get('principal') ?? '') === null || parseScope(next.get('scope')) === null) next.delete('effective');
    setParams(next, { replace, flushSync: true, ...(replace ? { state: location.state } : {}) });
  };
  const setFilter = (name: 'q' | 'effective', value: string | null, replace = false) => updateParams(next => {
    if (value === null) next.delete(name); else next.set(name, value);
    next.delete('page');
  }, replace);
  const selectScope = (scope: AccessScope | null, kindHint?: 'group') => updateParams(next => {
    if (scope === null) next.delete('scope'); else next.set('scope', JSON.stringify(scope));
    if (kindHint === undefined) next.delete('scopeKind'); else next.set('scopeKind', kindHint);
    next.delete('page');
  });
  const navigateScope = (scope: AccessScope | null, kindHint?: 'group') => {
    setScopeEditorRevision(revision => revision + 1);
    selectScope(scope, kindHint);
  };
  const scopeData = useMemo<ScopeExpressionData>(() => ({
    users: data.directory?.users ?? [], groups: data.directory?.groups ?? [],
    models: data.models ?? [], upstreams: data.upstreams ?? [],
  }), [data]);
  const loaded = data.records !== null && data.directory !== null && data.models !== null && data.upstreams !== null;
  const resolution = useAccessResolution({ enabled: showEffective && loaded, principal, scope, revision: data.records });
  const needle = query.trim().toLowerCase();
  const selection = selectPermissionRules({ records: (data.records ?? []).filter(record => scopeKind !== 'group' || record.scope.kind === 'group'), principal, scope, showEffective, data: scopeData, resolution: resolution.data });
  const filtered = selection.records.filter(record => permissionSearchText(record, scopeData, t).includes(needle));
  const administrator = showEffective && principal?.kind === 'user' && scopeData.users.some(user => user.id === principal.id && user.isAdmin);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const requestedPage = Number(params.get('page') ?? 1);
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalPages) : 1;
  const shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const create = () => editor.open({ ...(principal === null ? {} : { principal }), ...(scope === null ? {} : { scope }) });
  const reorder = async (ids: number[], from: number, to: number) => {
    const originalSegment = recordSegments(data.records!).find(segment => segment.records.some(record => record.id === ids[0]))!;
    const records = reorderModelRecords(data.records!, ids, from, to);
    const segment = recordSegments(records).find(segment => segment.records.some(record => record.id === ids[0]))!;
    setReordering(true);
    const result = await callApi(() => api.api['access-records'].reorder.$post({
      json: { expectedIds: originalSegment.records.map(record => record.id), ids: segment.records.map(record => record.id) },
    }));
    if (result.error) throw new Error(result.error.message, { cause: result.error });
    return result.data.records;
  };
  const commitReorder = useCallback((records: AccessRecord[]) => {
    const updated = new Map(records.map(record => [record.id, record]));
    setData(current => ({ ...current, records: current.records!.map(record => updated.get(record.id) ?? record) }));
    setReordering(false);
  }, []);
  const rejectReorder = async (error: unknown) => {
    await refresh();
    setError(error instanceof Error ? error.message : String(error));
    setReordering(false);
  };
  const remove = async (record: AccessRecord): Promise<string | null> => {
    const handle = toasts.start(t('dashboard.accessControl.toast.delete.pending'));
    const result = await callApi(() => api.api['access-records'][':id'].$delete({ param: { id: String(record.id) } }));
    if (result.error) { handle.settle(); return result.error.message; }
    handle.succeed(t('dashboard.accessControl.toast.delete.success'));
    await refresh();
    return null;
  };

  return <section className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions disabled={reordering} onRefresh={() => void refresh()} refreshLabel={t('dashboard.accessControl.actions.refresh')} refreshing={refreshing} />}
      description={t('dashboard.accessControl.description')}
      title={t('dashboard.nav.permissions')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    {resolution.error && <OutcomeMessageBar>{resolution.error}</OutcomeMessageBar>}
    <div className="flex items-end gap-3 flex-wrap" data-permission-filters="">
      <Field className="w-[240px] max-w-full" label={t('dashboard.accessControl.fields.principal')}><PrincipalPicker
        data={scopeData} disabled={!loaded} includeAll label={t('dashboard.accessControl.fields.principal')} onChange={next => updateParams(nextParams => {
          if (next === null) nextParams.delete('principal'); else nextParams.set('principal', principalKey(next));
          nextParams.delete('page');
        })} value={principal}
      /></Field>
      <div className="flex flex-wrap items-end gap-3 flex-[1_1_auto] min-w-0 max-w-full">
        <Field className="w-max min-w-0 max-w-full" label={t('dashboard.accessControl.fields.scope')}>
          <ScopeEditor data={scopeData} key={scopeEditorRevision} kindHint={scopeKind} onChange={selectScope} purpose="filter" readOnly={!loaded} value={scope} />
        </Field>
        <div className="min-h-[34px] flex items-center flex-none"><SwitchSetting
          checked={showEffective}
          disabled={effectiveUnavailable || !loaded}
          label={t('dashboard.accessControl.effective.label')}
          onChange={checked => setFilter('effective', checked ? 'true' : null)}
          description={<div className="grid gap-3 max-w-[420px]">
            <p className="m-0"><strong>{t('dashboard.accessControl.effective.checked')}</strong>{' '}{t('dashboard.accessControl.effective.checkedDescription')}</p>
            <p className="m-0"><strong>{t('dashboard.accessControl.effective.unchecked')}</strong>{' '}{t('dashboard.accessControl.effective.uncheckedDescription')}</p>
          </div>}
        /></div>
      </div>
      <div className="flex items-center gap-2 max-w-full ml-auto">
        <Input aria-label={t('dashboard.accessControl.search')} autoComplete="off" className="w-[220px]" contentBefore={<SearchRegular />} onChange={(_, event) => setFilter('q', event.value || null, true)} placeholder={t('dashboard.accessControl.search')} spellCheck={false} value={query} />
        <Button appearance="primary" className="flex-none whitespace-nowrap" disabled={!loaded || refreshing || reordering} icon={<AddRegular />} onClick={create}>{t('dashboard.accessControl.actions.add')}</Button>
      </div>
    </div>
    {administrator && <OutcomeMessageBar intent="info">{t('dashboard.accessControl.administratorBypass')}</OutcomeMessageBar>}
    {!loaded ? <EmptyState title={t('dashboard.pages.unavailable')} /> : <>
      <ResourceListPanel>
        {resolution.pending ? <div className="p-8"><Spinner label={t('common.loading')} /></div> : resolution.error ? <EmptyState title={t('dashboard.pages.unavailable')} /> : shown.length === 0 ? <EmptyState
          action={data.records!.length === 0 ? <Button appearance="primary" icon={<AddRegular />} onClick={create}>{t('dashboard.accessControl.actions.add')}</Button> : <Button onClick={() => updateParams(next => { for (const key of ['q', 'principal', 'scope', 'scopeKind', 'effective', 'page']) next.delete(key); })}>{t('dashboard.accessControl.actions.clearFilters')}</Button>}
          title={t(data.records!.length === 0 ? 'dashboard.accessControl.empty' : 'dashboard.accessControl.noMatches')}
        /> : <RulesTable busy={refreshing || reordering} data={scopeData} decisions={selection.decisions} onEdit={record => editor.open({ record })} onRemove={remove} onReorder={reorder} onReordered={commitReorder} onReorderError={rejectReorder} onScopeSelect={navigateScope} params={params} records={shown} />}
      </ResourceListPanel>
      {totalPages > 1 && <div className="flex items-center justify-end gap-3">
        <Text className="text-fui-fg2" size={200}>{t('dashboard.accessControl.pagination.range', { from: (page - 1) * PAGE_SIZE + 1, to: Math.min(page * PAGE_SIZE, filtered.length), total: filtered.length })}</Text>
        <TooltipIconButton disabled={page === 1} icon={<ChevronLeftRegular />} label={t('dashboard.accessControl.pagination.previous')} onClick={() => updateParams(next => next.set('page', String(page - 1)))} />
        <TooltipIconButton disabled={page === totalPages} icon={<ChevronRightRegular />} label={t('dashboard.accessControl.pagination.next')} onClick={() => updateParams(next => next.set('page', String(page + 1)))} />
      </div>}
    </>}
    {editor.invocation && <AccessRecordDialog data={scopeData} initialPrincipal={editor.invocation.value.principal} initialScope={editor.invocation.value.scope} key={editor.invocation.key} onOpenChange={open => { if (!open) editor.close(); }} onSaved={refresh} open={editor.isOpen} record={editor.invocation.value.record} suggestedSortOrder={Math.max(-1, ...(data.records ?? []).map(record => record.sortOrder)) + 1} />}
  </section>;
}
