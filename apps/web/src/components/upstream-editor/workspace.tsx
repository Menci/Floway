import {
  AddRegular,
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  CodeRegular,
  DeleteRegular,
  EditRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { BackNavigationButton } from './back-navigation-button';
import type { ModelRow, UpstreamEditorValues } from './editor-data';
import { publicModelId } from './editor-data';
import { FeatureFlagsEditor } from './feature-flags';
import { ModelDetail } from './model-detail';
import { parseModels, serializeModels } from './models-yaml';
import type { UpstreamModelConfig, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { dateTime, relativeTime } from '../../lib/format-time';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { ContentLoadingScreen } from '../ui/app-loading-screen';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useDangerTextClass } from '../ui/danger';
import { Input } from '../ui/fluent-form-controls';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { ScrollArea } from '../ui/scroll-area';
import { SectionHeader } from '../ui/section-header';
import { TableActions, TableActionsHeader, TableCentredCell, TableCentredHeader } from '../ui/table-actions';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import { useDialogInvocation } from '../ui/use-dialog-invocation';

const {
  Button,
  Spinner,
  Switch,
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Tooltip,
} = fluentComponents;

type ModelView = 'list' | 'detail' | 'yaml';
type WorkspaceTab = 'models' | 'flags';
interface WorkspaceLocation {
  tab: WorkspaceTab;
  model: string | null;
  section: ModelDetailTab;
  view: 'list' | 'yaml';
}

const TAB_PARAM = 'tab';
const MODEL_PARAM = 'model';
const SECTION_PARAM = 'section';
const VIEW_PARAM = 'view';
type ModelDetailTab = 'details' | 'flags';

const ModelsYamlEditor = lazy(() => import('./models-yaml-editor'));

export function UpstreamWorkspace({
  discovered,
  modelsError,
  modelsLoading,
  onRefreshModels,
  record,
}: {
  discovered: UpstreamModelConfig[];
  modelsError: string | null;
  modelsLoading: boolean;
  onRefreshModels: () => void;
  record: UpstreamRecord;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const { formState: { errors } } = useFormContext<UpstreamEditorValues>();
  const [params, setParams] = useSearchParams();
  const [yaml, setYaml] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const workspaceScrollRef = useRef<HTMLDivElement>(null);

  // Where the operator is, is in the URL: which tab, which model, and which
  // side of that model. A model is named by its upstream id, the one thing
  // about a row that survives a reload -- the row keys the table works in are
  // rebuilt per render for the manual entries.
  const tab = params.get(TAB_PARAM) === 'flags' ? 'flags' : 'models';
  const selectedUpstreamModelId = params.get(MODEL_PARAM);
  const modelView: ModelView = selectedUpstreamModelId !== null
    ? 'detail'
    : params.get(VIEW_PARAM) === 'yaml' ? 'yaml' : 'list';
  const modelDetailTab: ModelDetailTab = params.get(SECTION_PARAM) === 'flags' ? 'flags' : 'details';
  const showModelDetail = modelView === 'detail';

  // Replace rather than push: moving around inside one editor is not a place
  // the back button should have to walk out of a step at a time.
  const navigate = useCallback((next: WorkspaceLocation) => {
    setParams(previous => {
      const search = new URLSearchParams(previous);
      for (const [key, value] of Object.entries({
        [TAB_PARAM]: next.tab === 'models' ? null : next.tab,
        [MODEL_PARAM]: next.model,
        [SECTION_PARAM]: next.model !== null && next.section === 'flags' ? 'flags' : null,
        [VIEW_PARAM]: next.model === null && next.view === 'yaml' ? 'yaml' : null,
      })) {
        if (value === null) search.delete(key); else search.set(key, value);
      }
      return search;
    }, { replace: true });
  }, [setParams]);

  const changeModelView = (next: ModelView) => navigate({
    tab,
    model: next === 'detail' ? selectedUpstreamModelId : null,
    section: 'details',
    view: next === 'yaml' ? 'yaml' : 'list',
  });
  const selectModel = (id: string | null) => navigate({ tab, model: id, section: 'details', view: 'list' });
  useLayoutEffect(() => {
    workspaceScrollRef.current?.scrollTo({ left: 0, top: 0 });
  }, [modelDetailTab, modelView, tab]);
  const modelsWorkspace = <ModelsWorkspace detailSection={modelDetailTab} onSelectUpstreamModel={selectModel} selectedUpstreamModelId={selectedUpstreamModelId} discovered={discovered} modelsLoading={modelsLoading} modelsError={modelsError} onRefreshModels={onRefreshModels} onViewChange={changeModelView} record={record} view={modelView} yaml={yaml} yamlError={yamlError} onYamlChange={setYaml} onYamlErrorChange={setYamlError} />;
  return <section className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] h-full min-h-0 min-w-0 max-[1050px]:h-auto">
    <div className="flex items-center gap-2 border-0 border-b border-solid border-fui-stroke1 px-5 pt-2">
      {showModelDetail
        ? <>
            <BackNavigationButton onClick={() => selectModel(null)}>{t('dashboard.upstreamEditor.models.back')}</BackNavigationButton>
            <TabList selectedValue={modelDetailTab} onTabSelect={(_, data) => navigate({ tab, model: selectedUpstreamModelId, section: data.value as ModelDetailTab, view: 'list' })}>
              <Tab value="details">{t('dashboard.upstreamEditor.models.details')}</Tab>
              <Tab value="flags">{t('dashboard.upstreamEditor.models.flags')}</Tab>
            </TabList>
          </>
        : <TabList selectedValue={tab} onTabSelect={(_, data) => navigate({ tab: data.value as WorkspaceTab, model: null, section: 'details', view: 'list' })}>
            <Tab value="models">{t('dashboard.upstreamEditor.tabs.models')}</Tab>
            <Tab value="flags">{t('dashboard.upstreamEditor.tabs.flags')}</Tab>
          </TabList>}
    </div>
    <ScrollArea ref={workspaceScrollRef} axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" contentClassName={tab === 'models' && modelView === 'yaml' ? 'h-full min-w-0' : ''} noTabIndex>
      {tab === 'models' && modelView === 'yaml'
        ? modelsWorkspace
        : <div className="px-5 py-4">
            {tab === 'models' ? <div className="grid gap-4">
              {/* The list and the detail are both here, so a model the schema
                  refused stays named while the operator walks into it. */}
              {errors.manualModels?.message && <Text className={dangerText} role="alert" size={200}>{t(errors.manualModels.message)}</Text>}
              {modelsWorkspace}
            </div> : <div className="grid gap-5">
              <Text size={300} className="text-fui-fg2">
                {t('dashboard.upstreamEditor.flags.intro')}
              </Text>
              <Controller name="flagOverrides" render={({ field }) => <FeatureFlagsEditor defaults={record.flag_defaults} value={field.value} onChange={field.onChange} />} />
            </div>}
          </div>}
    </ScrollArea>
  </section>;
}

function ModelsWorkspace({ detailSection, discovered, modelsError, modelsLoading, onRefreshModels, onSelectUpstreamModel, onViewChange, onYamlChange, onYamlErrorChange, record, selectedUpstreamModelId, view, yaml, yamlError }: {
  detailSection: ModelDetailTab;
  discovered: UpstreamModelConfig[];
  modelsError: string | null;
  modelsLoading: boolean;
  onRefreshModels: () => void;
  onSelectUpstreamModel: (id: string | null) => void;
  onViewChange: (view: ModelView) => void;
  onYamlChange: (value: string) => void;
  onYamlErrorChange: (value: string | null) => void;
  record: UpstreamRecord;
  selectedUpstreamModelId: string | null;
  view: ModelView;
  yaml: string;
  yamlError: string | null;
}) {
  const { t } = useTranslation();
  const { control, setValue } = useFormContext<UpstreamEditorValues>();
  const { append, fields, remove, replace } = useFieldArray({ control, name: 'manualModels' });
  const manual = useWatch({ control, name: 'manualModels' });
  const config = useWatch({ control, name: 'config' });
  const disabled = useWatch({ control, name: 'disabledPublicModelIds' });
  const upstreamFlags = useWatch({ control, name: 'flagOverrides' });
  const deleteDialog = useDialogInvocation<ModelRow>();
  const [pendingManualUpstreamModelId, setPendingManualUpstreamModelId] = useState<string | null>(null);
  const [pendingManualConfig, setPendingManualConfig] = useState<UpstreamModelConfig | null>(null);
  const [search, setSearch] = useState('');
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const readOnly = record.kind === 'copilot' || record.kind === 'codex' || record.kind === 'claude-code';
  const autoFetchEnabled = record.kind !== 'custom'
    || (config as Extract<UpstreamRecord, { kind: 'custom' }>['config']).modelsFetch.enabled;
  const rows = useMemo<ModelRow[]>(() => {
    const visibleDiscovered = autoFetchEnabled ? discovered : [];
    const autoById = new Map(visibleDiscovered.map(item => [item.upstreamModelId, item]));
    const result: ModelRow[] = manual.map((item, index) => ({ key: `manual:${fields[index]?.id ?? `pending:${index}`}`, source: 'manual', config: item, manualIndex: index, hasAuto: autoById.has(item.upstreamModelId) }));
    const manualIds = new Set(manual.map(item => item.upstreamModelId));
    for (const item of visibleDiscovered) if (!manualIds.has(item.upstreamModelId)) result.push({ key: `auto:${item.upstreamModelId}`, source: 'auto', config: item, manualIndex: null, hasAuto: true });
    return result;
  }, [autoFetchEnabled, discovered, fields, manual]);
  const selectedRow = rows.find(row => row.config.upstreamModelId === selectedUpstreamModelId) ?? null;
  const pendingManualRow: ModelRow | null = pendingManualConfig === null ? null : {
    key: 'pending-manual',
    source: 'manual',
    config: pendingManualConfig,
    manualIndex: manual.length - 1,
    hasAuto: true,
  };
  const activeDetailRow = selectedRow ?? pendingManualRow;
  const filtered = rows.filter(row => `${row.config.display_name ?? ''} ${publicModelId(row.config)} ${row.config.upstreamModelId}`.toLowerCase().includes(search.toLowerCase()));

  const setEnabled = (id: string, enabled: boolean) => setValue('disabledPublicModelIds', enabled ? disabled.filter(item => item !== id) : [...new Set([...disabled, id])], { shouldDirty: true });
  // Once the row the pending manual model produced exists, drop the
  // placeholder — a one-shot handoff, not synchronised state. The selection
  // needs no handing over: it names the model, and the model is the same one.
  const settledManualRow = pendingManualUpstreamModelId === null
    ? undefined
    : rows.find(row => row.source === 'manual' && row.config.upstreamModelId === pendingManualUpstreamModelId);
  if (settledManualRow) {
    setPendingManualUpstreamModelId(null);
    setPendingManualConfig(null);
  }

  const setModelSource = (row: ModelRow, source: 'auto' | 'manual') => {
    if (source === row.source || readOnly) return;
    if (source === 'manual' && row.source === 'auto') {
      setPendingManualUpstreamModelId(row.config.upstreamModelId);
      const manualConfig = structuredClone(row.config);
      if (manualConfig.kind === 'rerank') {
        manualConfig.endpoints = { rerank: {} };
        manualConfig.rerankTarget = { protocol: 'cohere-v2' };
      }
      setPendingManualConfig(manualConfig);
      append(manualConfig);
      return;
    }
    if (source === 'auto' && row.manualIndex !== null && row.hasAuto) {
      remove(row.manualIndex);
    }
  };

  const deleteModel = (target: ModelRow & { manualIndex: number }) => {
    remove(target.manualIndex);
    if (selectedRow?.key === target.key) onSelectUpstreamModel(null);
    deleteDialog.close();
  };

  const deleteTarget = deleteDialog.invocation?.value;
  const manualDeleteTarget = deleteTarget?.manualIndex == null
    ? null
    : { ...deleteTarget, manualIndex: deleteTarget.manualIndex };
  const deleteConfirmation = manualDeleteTarget && <ConfirmDialog
    open={deleteDialog.isOpen}
    actionLabel={t('dashboard.upstreamEditor.models.deleteConfirm')}
    key={deleteDialog.invocation!.key}
    message={t('dashboard.upstreamEditor.models.deleteMessage', { name: manualDeleteTarget.config.display_name ?? publicModelId(manualDeleteTarget.config) })}
    onConfirm={() => deleteModel(manualDeleteTarget)}
    onOpenChange={open => { if (!open) deleteDialog.close(); }}
    title={t('dashboard.upstreamEditor.models.deleteTitle')}
  />;

  if (view === 'yaml') {
    // Leaving YAML mode has to validate first; refusing to leave on a parse
    // error is what keeps the operator's unsaved text on screen.
    const applyAndLeave = () => {
      const parsed = parseModels(yaml, { allowRerank: record.kind === 'custom' });
      if (!parsed.ok) { onYamlErrorChange(parsed.message); return; }
      replace(parsed.models);
      onYamlErrorChange(null);
      onViewChange('list');
    };
    return <div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] h-full min-h-[480px] min-w-0">
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-5 py-4">
        <SectionHeader
          description={t('dashboard.upstreamEditor.models.yamlHint')}
          level={2}
          title={t('dashboard.upstreamEditor.models.yamlTitle')}
          actions={<Button appearance="secondary" className="!min-w-[160px]" icon={<CheckmarkCircleRegular />} onClick={applyAndLeave}>
            {t('dashboard.upstreamEditor.models.editWithUi')}
          </Button>}
        />
      </div>
      <div className="h-full min-h-0 overflow-hidden border-0 border-y border-solid border-fui-stroke1">
        <Suspense fallback={<ContentLoadingScreen label={t('common.loading')} />}>
          <ModelsYamlEditor value={yaml} onChange={value => { onYamlChange(value); onYamlErrorChange(null); }} />
        </Suspense>
      </div>
      {yamlError && <div className="px-5 py-3"><OutcomeMessageBar>{yamlError}</OutcomeMessageBar></div>}
    </div>;
  }

  if (view === 'detail' && activeDetailRow) return <><ModelDetail section={detailSection} row={activeDetailRow} readOnly={readOnly} onDelete={() => deleteDialog.open(activeDetailRow)} onSourceChange={source => setModelSource(activeDetailRow, source)} onChange={value => {
    if (activeDetailRow.manualIndex === null) return;
    setValue(`manualModels.${activeDetailRow.manualIndex}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }} record={record} upstreamFlags={upstreamFlags} />{deleteConfirmation}</>;

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-w-0">
    <div className="flex flex-wrap items-center gap-3">
      <SectionHeader
        description={t('dashboard.upstreamEditor.models.summary', { total: rows.length, manual: manual.length, auto: rows.length - manual.length })}
        level={2}
        title={t('dashboard.upstreamEditor.models.title')}
      />
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {!readOnly && <Button appearance="primary" icon={<AddRegular />} onClick={() => append({ upstreamModelId: '', kind: 'chat', endpoints: { chatCompletions: {} } })}>{t('dashboard.upstreamEditor.models.add')}</Button>}
        {!readOnly && <Button appearance="secondary" className="!min-w-[160px]" icon={<CodeRegular />} onClick={() => { onYamlChange(serializeModels(manual)); onYamlErrorChange(null); onViewChange('yaml'); }}>{t('dashboard.upstreamEditor.models.editAsYaml')}</Button>}
        {record.kind !== 'azure' && <>
          <ModelsCacheStatus cache={record.modelsCache} />
          <Button disabled={modelsLoading || !autoFetchEnabled} icon={modelsLoading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={onRefreshModels}>{t('dashboard.upstreamEditor.models.refresh')}</Button>
        </>}
      </div>
    </div>
    {modelsError && <OutcomeMessageBar
      bodyClassName="min-w-0 [overflow-wrap:anywhere]"
      className="min-w-0"
      icon={<WarningRegular />}
      intent="warning"
    >
      {modelsError === 'Upstream model listing failed'
        ? t('dashboard.upstreamEditor.models.listingFailed')
        : t('dashboard.upstreamEditor.models.listingFailedWithDetail', { message: modelsError })}
    </OutcomeMessageBar>}
    <Input value={search} onChange={(_, data) => setSearch(data.value)} placeholder={t('dashboard.upstreamEditor.models.search')} />
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table className="w-full min-w-[640px]">
        <colgroup><col className="w-[80px]" /><col className="w-[25%]" /><col className="w-[88px]" /><col /><col className="w-[80px]" /><col className="w-[80px]" /></colgroup>
        <TableHeader><TableRow><TableCentredHeader>{t('dashboard.upstreamEditor.models.enabled')}</TableCentredHeader><TableHeaderCell>{t('dashboard.upstreamEditor.models.name')}</TableHeaderCell><TableCentredHeader>{t('dashboard.upstreamEditor.models.kind')}</TableCentredHeader><TableHeaderCell>{t('dashboard.upstreamEditor.models.id')}</TableHeaderCell><TableCentredHeader>{t('dashboard.upstreamEditor.models.source')}</TableCentredHeader><TableActionsHeader>{t('dashboard.upstreamEditor.models.actions')}</TableActionsHeader></TableRow></TableHeader>
        <TableBody>{filtered.map(row => {
          const id = publicModelId(row.config); return <TableRow className="h-14" key={row.key}>
            <TableCentredCell><Switch checked={!disabled.includes(id)} onChange={(_, data) => setEnabled(id, data.checked)} /></TableCentredCell>
            <TableCell className="overflow-hidden">
              <button
                className="block bg-transparent border-0 cursor-pointer min-w-0 max-w-full truncate p-0 text-fui-base300 text-fui-fg1 text-left hover:underline"
                onClick={() => onSelectUpstreamModel(row.config.upstreamModelId)}
                title={row.config.display_name ?? id}
                type="button"
              >
                {row.config.display_name ?? id}
              </button>
            </TableCell>
            <TableCentredCell><Text size={300}>{t(`dashboard.upstreamEditor.models.kindValue.${row.config.kind}`)}</Text></TableCentredCell>
            <TableCell className="overflow-hidden"><span className="flex items-center gap-1 min-w-0 max-w-full overflow-hidden"><code className="block min-w-0 max-w-[calc(100%-36px)] truncate leading-[var(--lineHeightBase300)]" title={id}>{id}</code><TooltipIconButton className="flex-none" icon={copyOutcomeIcon(outcomeFor(id))} label={copyLabel(outcomeFor(id), t('dashboard.upstreamEditor.models.copy'))} onClick={() => copy(id, id)} /></span></TableCell>
            <TableCentredCell><Text size={300}>{t(`dashboard.upstreamEditor.models.${row.source}`)}</Text></TableCentredCell>
            <TableCell><TableActions><TooltipIconButton icon={<EditRegular />} label={t('dashboard.upstreamEditor.models.edit')} onClick={() => onSelectUpstreamModel(row.config.upstreamModelId)} />{row.manualIndex !== null && <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.models.delete')} onClick={() => deleteDialog.open(row)} />}</TableActions></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
    </ScrollArea>
    {deleteConfirmation}
  </div>;
}

function ModelsCacheStatus({ cache }: { cache: UpstreamRecord['modelsCache'] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow(10_000);
  const label = cache.fetchedAt === null
    ? t('dashboard.upstreamEditor.models.cacheNever')
    : now - cache.fetchedAt < 10_000
      ? t('dashboard.upstreamEditor.models.cacheFetchedNow')
      : t('dashboard.upstreamEditor.models.cacheFetched', {
          time: relativeTime(cache.fetchedAt, locale, { now }) ?? dateTime(cache.fetchedAt, locale),
        });
  const detail = cache.lastError
    ? t('dashboard.upstreamEditor.models.cacheErrorDetail', { message: cache.lastError.message, time: dateTime(cache.lastError.at, locale) })
    : cache.fetchedAt === null ? label : dateTime(cache.fetchedAt, locale);
  return <Tooltip content={detail} relationship="description">
    <span className="inline-flex items-center gap-1 text-fui-fg2" tabIndex={0}>
      {cache.lastError ? <WarningRegular /> : <CheckmarkCircleRegular />}
      <Text size={200}>{cache.lastError ? t('dashboard.upstreamEditor.models.cacheFailed') : label}</Text>
    </span>
  </Tooltip>;
}
