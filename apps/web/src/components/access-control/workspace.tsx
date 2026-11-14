import { AddRegular, ChevronLeftRegular, ChevronRightRegular, SearchRegular } from '@fluentui/react-icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigation, useSearchParams } from 'react-router';

import { loadPermissionsData, type PermissionsData } from './data';
import { permissionSearchText, selectPermissionRules } from './effective';
import { normalizeFilters } from './filters';
import { orderedRecords, recordSegments, reorderModelRecords } from './order';
import { PrincipalPicker } from './principal';
import { principalKey } from './principals';
import { AccessRecordDialog } from './record-dialog';
import { useAccessResolution } from './resolution';
import { RulesTable } from './rules-table';
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

const { Button, Field, Text } = fluentComponents;
const PAGE_SIZE = 20;

export function PermissionsWorkspace({ admin, initial }: { admin: boolean; initial: PermissionsData }) {
  const { t, i18n } = useTranslation();
  const toasts = useOutcomeToasts();
  const [data, setData] = useState(initial);
  const [error, setError] = useState(initial.error);
  const [reordering, setReordering] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [scopeEditorState, setScopeEditorState] = useState({ revision: 0, invalidScope: false });
  const [committedParams, setParams] = useSearchParams();
  const location = useLocation();
  const navigation = useNavigation();
  // The loading destination keeps native controls current before URL commit.
  // https://reactrouter.com/api/hooks/useNavigation#navigationlocation
  const pendingSearch = navigation.location?.pathname === location.pathname ? navigation.location.search : null;
  const { params, principal, scope, invalidScope } = useMemo(
    () => normalizeFilters(pendingSearch === null ? committedParams : new URLSearchParams(pendingSearch)),
    [committedParams, pendingSearch],
  );
  if (scopeEditorState.invalidScope !== invalidScope) {
    setScopeEditorState({ invalidScope, revision: scopeEditorState.revision + (invalidScope ? 1 : 0) });
  }
  const editor = useDialogInvocation<{ record?: AccessRecord; principal?: AccessPrincipal; scope?: AccessScope }>();
  const reload = async (signal: AbortSignal) => {
    const next = await loadPermissionsData(data, signal);
    if (!signal.aborted) { setData(next); setError(next.error); }
  };
  const { refresh, refreshInBackground, backgroundRefreshing, refreshing } = useRefresh(reload);
  const query = params.get('q') ?? '';
  const scopeData = useMemo<ScopeExpressionData>(() => ({
    users: data.directory?.users ?? [], groups: data.directory?.groups ?? [],
    models: data.models ?? [], upstreams: data.upstreams ?? [],
  }), [data]);
  const principalData = useMemo<ScopeExpressionData>(() => ({
    ...scopeData,
    users: scopeData.users.filter(user => data.directory?.principalUserIds.includes(user.id)),
    groups: scopeData.groups.filter(group => data.directory?.principalGroupIds.includes(group.id)),
  }), [data.directory, scopeData]);
  const effectiveUnavailable = principal === null || scope === null || scope.kind === 'self';
  const showEffective = !effectiveUnavailable && params.get('effective') === 'true';
  useEffect(() => {
    if (navigation.location !== undefined) return;
    const normalized = normalizeFilters(committedParams);
    if (!admin && principal !== null && normalized.params.has('principal')
      && (principal.kind === 'user'
        ? !principalData.users.some(user => user.id === principal.id)
        : !principalData.groups.some(group => group.id === principal.id))) {
      const next = new URLSearchParams(normalized.params);
      next.delete('principal');
      next.delete('effective');
      setParams(next, { replace: true, state: location.state });
      return;
    }
    if (normalized.params.toString() === committedParams.toString()) return;
    setParams(normalized.params, { replace: true, state: location.state });
  }, [admin, committedParams, location.state, navigation.location, principal, principalData.groups, principalData.users, setParams]);
  const updateParams = (change: (next: URLSearchParams) => void, replace = false) => {
    const next = new URLSearchParams(params);
    if (effectiveUnavailable) next.delete('effective');
    change(next);
    setParams(normalizeFilters(next).params, { replace, flushSync: true, ...(replace ? { state: location.state } : {}) });
  };
  const setFilter = (name: 'q' | 'effective', value: string | null, replace = false) => updateParams(next => {
    if (value === null) next.delete(name); else next.set(name, value);
    next.delete('page');
  }, replace);
  const selectScope = (scope: AccessScope | null) => updateParams(next => {
    if (scope === null) next.delete('scope'); else next.set('scope', JSON.stringify(scope));
    next.delete('page');
  });
  const navigateScope = (scope: AccessScope | null) => {
    setScopeEditorState(current => ({ ...current, revision: current.revision + 1 }));
    selectScope(scope);
  };
  const loaded = data.records !== null && data.directory !== null && data.models !== null && data.upstreams !== null;
  const resolution = useAccessResolution({ enabled: showEffective && loaded && !refreshing, principal, scope, revision: data.records });
  const loading = refreshing || resolution.pending;
  const busy = loading || reordering || removing || resolution.error !== null;
  const search = params.toString();
  const view = useMemo(() => {
    const selection = selectPermissionRules({ records: data.records ?? [], principal, scope, showEffective, data: scopeData, resolution: resolution.data });
    const filtered = selection.records.filter(record => permissionSearchText(record, scopeData, t).includes(query.trim().toLowerCase()));
    const viewParams = new URLSearchParams(search);
    const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const requestedPage = Number(viewParams.get('page') ?? 1);
    const page = Number.isInteger(requestedPage) && requestedPage > 0 ? Math.min(requestedPage, totalPages) : 1;
    return { records: filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), decisions: selection.decisions, data: scopeData, params: viewParams, page, totalPages, total: filtered.length, empty: data.records?.length === 0 };
  }, [data.records, principal, query, resolution.data, scope, scopeData, search, showEffective, t]);
  const snapshot = { view, source: { data, search, resolution: resolution.data, language: i18n.language } };
  const [displayed, setDisplayed] = useState<typeof snapshot | null>(loaded ? snapshot : null);
  // A background refresh keeps the table on screen while its request is in
  // flight, but the arrival of new data still replaces it; `loading` covers
  // the foreground case where the old snapshot must survive until the new one
  // is ready.
  const keepDisplayed = loading || resolution.error !== null;
  if (loaded && !keepDisplayed && (displayed?.source.data !== data || displayed?.source.search !== search
    || displayed?.source.resolution !== resolution.data || displayed?.source.language !== i18n.language)) setDisplayed(snapshot);
  const results = (keepDisplayed || (backgroundRefreshing && displayed !== null)) && displayed !== null ? displayed.view : view;
  const administrator = showEffective && principal?.kind === 'user' && scopeData.users.some(user => user.id === principal.id && user.isAdmin);
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
    // A settled drop keeps its acknowledged order while effective values reload.
    setDisplayed(current => current === null ? null : {
      ...current,
      view: {
        ...current.view,
        records: orderedRecords(current.view.records.map(record => {
          const acknowledged = updated.get(record.id);
          return acknowledged ? { ...record, sortOrder: acknowledged.sortOrder } : record;
        })),
      },
    });
    setReordering(false);
  }, []);
  const rejectReorder = async (error: unknown) => {
    await refresh();
    setError(error instanceof Error ? error.message : String(error));
    setReordering(false);
  };
  const remove = async (record: AccessRecord): Promise<string | null> => {
    setRemoving(true);
    try {
      const handle = toasts.start(t('dashboard.accessControl.toast.delete.pending'));
      const result = await callApi(() => api.api['access-records'][':id'].$delete({ param: { id: String(record.id) } }));
      if (result.error) { handle.settle(); return result.error.message; }
      handle.succeed(t('dashboard.accessControl.toast.delete.success'));
      await refreshInBackground();
      return null;
    } finally {
      setRemoving(false);
    }
  };

  return <section aria-busy={loading || reordering || removing} className="dashboard-page">
    <DashboardPageHeader
      actions={<ResourceListActions disabled={reordering || removing} onRefresh={() => void refresh()} refreshLabel={t('dashboard.accessControl.actions.refresh')} refreshing={loading} />}
      description={t('dashboard.accessControl.description')}
      title={t('dashboard.nav.permissions')}
    />
    {error && <OutcomeMessageBar onDismiss={() => setError(null)}>{error}</OutcomeMessageBar>}
    {resolution.error && <OutcomeMessageBar>{resolution.error}</OutcomeMessageBar>}
    <div className="flex items-end gap-3 flex-wrap" data-permission-filters="">
      <Field className="w-[240px] max-w-full" label={t('dashboard.accessControl.fields.principal')}><PrincipalPicker
        clearable={principal !== null}
        data={principalData} disabled={!loaded} includeAll label={t('dashboard.accessControl.fields.principal')} onChange={next => updateParams(nextParams => {
          if (next === null) nextParams.delete('principal'); else nextParams.set('principal', principalKey(next));
          nextParams.delete('page');
        })} value={principal}
      /></Field>
      <div className="flex flex-wrap items-end gap-3 flex-[1_1_auto] min-w-0 max-w-full">
        <Field className="w-max min-w-0 max-w-full" label={t('dashboard.accessControl.fields.scope')}>
          <ScopeEditor data={scopeData} key={scopeEditorState.revision} onChange={selectScope} purpose="filter" readOnly={!loaded} value={scope} />
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
        {admin && <Button appearance="primary" className="flex-none whitespace-nowrap" disabled={!loaded || busy} icon={<AddRegular />} onClick={create}>{t('dashboard.accessControl.actions.add')}</Button>}
      </div>
    </div>
    {administrator && <OutcomeMessageBar intent="info">{t('dashboard.accessControl.administratorBypass')}</OutcomeMessageBar>}
    {!loaded ? <EmptyState title={t('dashboard.pages.unavailable')} /> : <>
      <ResourceListPanel>
        {results.records.length === 0 ? <EmptyState
          action={results.empty ? admin ? <Button appearance="primary" disabled={busy} icon={<AddRegular />} onClick={create}>{t('dashboard.accessControl.actions.add')}</Button> : null : <Button disabled={busy} onClick={() => updateParams(next => { for (const key of ['q', 'principal', 'scope', 'effective', 'page']) next.delete(key); })}>{t('dashboard.accessControl.actions.clearFilters')}</Button>}
          title={t(results.empty ? 'dashboard.accessControl.empty' : 'dashboard.accessControl.noMatches')}
        /> : <RulesTable admin={admin} busy={busy} data={results.data} decisions={results.decisions} onEdit={record => editor.open({ record })} onRemove={remove} onReorder={reorder} onReordered={commitReorder} onReorderError={rejectReorder} onScopeSelect={navigateScope} params={results.params} records={results.records} />}
      </ResourceListPanel>
      {results.totalPages > 1 && <div className="flex items-center justify-end gap-3">
        <Text className="text-fui-fg2" size={200}>{t('dashboard.accessControl.pagination.range', { from: (results.page - 1) * PAGE_SIZE + 1, to: Math.min(results.page * PAGE_SIZE, results.total), total: results.total })}</Text>
        <TooltipIconButton disabled={busy || results.page === 1} icon={<ChevronLeftRegular />} label={t('dashboard.accessControl.pagination.previous')} onClick={() => updateParams(next => next.set('page', String(results.page - 1)))} />
        <TooltipIconButton disabled={busy || results.page === results.totalPages} icon={<ChevronRightRegular />} label={t('dashboard.accessControl.pagination.next')} onClick={() => updateParams(next => next.set('page', String(results.page + 1)))} />
      </div>}
    </>}
    {admin && editor.invocation && <AccessRecordDialog data={scopeData} principalData={principalData} initialPrincipal={editor.invocation.value.principal} initialScope={editor.invocation.value.scope} key={editor.invocation.key} onOpenChange={open => { if (!open) editor.close(); }} onSaved={refreshInBackground} open={editor.isOpen} record={editor.invocation.value.record} suggestedSortOrder={Math.max(-1, ...(data.records ?? []).map(record => record.sortOrder)) + 1} />}
  </section>;
}
