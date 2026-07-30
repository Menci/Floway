import {
  AddRegular,
  ArrowSyncRegular,
  CheckmarkCircleRegular,
  CodeRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { lazy, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import { BackNavigationButton } from './back-navigation-button';
import type { UpstreamEditorValues } from './editor-data';
import { publicModelId } from './editor-data';
import { FeatureFlagsEditor } from './feature-flags';
import { ModelDetail } from './model-detail';
import { parseModels, serializeModels } from './models-yaml';
import type { UpstreamModelConfig, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useNow } from '../../lib/use-now';
import { formatFullTime, formatRelativeTime } from '../requests/format';
import { ContentLoadingScreen } from '../ui/app-loading-screen';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Input } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';
import { TableActions, TableActionsHeader } from '../ui/table-actions';
import { TooltipIconButton } from '../ui/tooltip-icon-button';

const {
  Button,
  MessageBar,
  MessageBarBody,
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

interface ModelRow {
  key: string;
  source: 'auto' | 'manual';
  config: UpstreamModelConfig;
  manualIndex: number | null;
  hasAuto: boolean;
}

type ModelView = 'list' | 'detail' | 'yaml';
type ModelDetailTab = 'details' | 'flags';

const ModelsYamlEditor = lazy(() => import('./models-yaml-editor'));

export function UpstreamWorkspace({
  discovered,
  loadingModels,
  modelsError,
  onRefreshModels,
  record,
}: {
  discovered: UpstreamModelConfig[];
  loadingModels: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  record: UpstreamRecord;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'models' | 'flags'>('models');
  const [modelView, setModelView] = useState<ModelView>('list');
  const [modelDetailTab, setModelDetailTab] = useState<ModelDetailTab>('details');
  const [yaml, setYaml] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const workspaceScrollRef = useRef<HTMLDivElement>(null);
  const showModelDetail = modelView === 'detail';
  const changeModelView = (next: ModelView) => {
    setModelView(next);
    if (next === 'detail') setModelDetailTab('details');
  };
  useLayoutEffect(() => {
    workspaceScrollRef.current?.scrollTo({ left: 0, top: 0 });
  }, [modelDetailTab, modelView, tab]);
  const modelsWorkspace = <ModelsWorkspace detailSection={modelDetailTab} discovered={discovered} loading={loadingModels} error={modelsError} onRefresh={onRefreshModels} onViewChange={changeModelView} record={record} view={modelView} yaml={yaml} yamlError={yamlError} onYamlChange={setYaml} onYamlErrorChange={setYamlError} />;
  return <section className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] h-full min-h-0 min-w-0 max-[1050px]:h-auto">
    <div className="flex items-center gap-2 border-b border-b-solid border-fui-stroke1 px-5 pt-2">
      {showModelDetail
        ? <>
            <BackNavigationButton onClick={() => setModelView('list')}>{t('dashboard.upstreamEditor.models.back')}</BackNavigationButton>
            <TabList selectedValue={modelDetailTab} onTabSelect={(_, data) => setModelDetailTab(data.value as ModelDetailTab)}>
              <Tab value="details">{t('dashboard.upstreamEditor.models.details')}</Tab>
              <Tab value="flags">{t('dashboard.upstreamEditor.models.flags')}</Tab>
            </TabList>
          </>
        : <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(data.value as typeof tab)}>
            <Tab value="models">{t('dashboard.upstreamEditor.tabs.models')}</Tab>
            <Tab value="flags">{t('dashboard.upstreamEditor.tabs.flags')}</Tab>
          </TabList>}
    </div>
    <ScrollArea ref={workspaceScrollRef} axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" contentClassName={tab === 'models' && modelView === 'yaml' ? 'h-full min-w-0' : ''} noTabIndex>
      {tab === 'models' && modelView === 'yaml'
        ? modelsWorkspace
        : <div className="px-5 py-4">
            {tab === 'models' ? modelsWorkspace : <div className="grid gap-5">
              <Text size={300} className="text-fui-fg2 leading-[1.45]">
                {t('dashboard.upstreamEditor.flags.intro')}
              </Text>
              <Controller name="flagOverrides" render={({ field }) => <FeatureFlagsEditor defaults={record.flag_defaults} value={field.value} onChange={field.onChange} />} />
            </div>}
          </div>}
    </ScrollArea>
  </section>;
}

function ModelsWorkspace({ detailSection, discovered, error, loading, onRefresh, onViewChange, onYamlChange, onYamlErrorChange, record, view, yaml, yamlError }: {
  detailSection: ModelDetailTab;
  discovered: UpstreamModelConfig[];
  error: string | null;
  loading: boolean;
  onRefresh: () => void;
  onViewChange: (view: ModelView) => void;
  onYamlChange: (value: string) => void;
  onYamlErrorChange: (value: string | null) => void;
  record: UpstreamRecord;
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
  const [selected, setSelected] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelRow | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [pendingManualId, setPendingManualId] = useState<string | null>(null);
  const [pendingManualConfig, setPendingManualConfig] = useState<UpstreamModelConfig | null>(null);
  const [search, setSearch] = useState('');
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
  const selectedRow = rows.find(row => row.key === selected) ?? null;
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
  // Once the row the pending manual model produced exists, hand selection to
  // it and drop the placeholder — a one-shot handoff, not synchronised state.
  const settledManualRow = pendingManualId === null
    ? undefined
    : rows.find(row => row.source === 'manual' && row.config.upstreamModelId === pendingManualId);
  if (settledManualRow) {
    setSelected(settledManualRow.key);
    setPendingManualId(null);
    setPendingManualConfig(null);
  }

  const setModelSource = (row: ModelRow, source: 'auto' | 'manual') => {
    if (source === row.source || readOnly) return;
    if (source === 'manual' && row.source === 'auto') {
      setPendingManualId(row.config.upstreamModelId);
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
      const autoKey = `auto:${row.config.upstreamModelId}`;
      remove(row.manualIndex);
      setSelected(autoKey);
    }
  };

  const deleteModel = (target: ModelRow & { manualIndex: number }) => {
    remove(target.manualIndex);
    if (selected === target.key) {
      setSelected(null);
      onViewChange('list');
    }
    setDeleteOpen(false);
  };

  const manualDeleteTarget = deleteTarget?.manualIndex === null || deleteTarget === null
    ? null
    : { ...deleteTarget, manualIndex: deleteTarget.manualIndex };
  const deleteDialog = deleteOpen && manualDeleteTarget && <ConfirmDialog
    actionLabel={t('dashboard.upstreamEditor.models.deleteConfirm')}
    message={t('dashboard.upstreamEditor.models.deleteMessage', { name: manualDeleteTarget.config.display_name ?? publicModelId(manualDeleteTarget.config) })}
    onConfirm={() => deleteModel(manualDeleteTarget)}
    onOpenChange={setDeleteOpen}
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
        <div className="grid gap-0.5">
          <Text as="h2" size={500} weight="semibold" className="!m-0">{t('dashboard.upstreamEditor.models.yamlTitle')}</Text>
          <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.yamlHint')}</Text>
        </div>
        <Button appearance="secondary" className="!min-w-[160px]" icon={<CheckmarkCircleRegular />} onClick={applyAndLeave}>
          {t('dashboard.upstreamEditor.models.editWithUi')}
        </Button>
      </div>
      <div className="h-full min-h-0 overflow-hidden border-0 border-y border-solid border-fui-stroke1">
        <Suspense fallback={<ContentLoadingScreen label={t('common.loading')} />}>
          <ModelsYamlEditor value={yaml} onChange={value => { onYamlChange(value); onYamlErrorChange(null); }} />
        </Suspense>
      </div>
      {yamlError && <div className="px-5 py-3"><MessageBar intent="error"><MessageBarBody>{yamlError}</MessageBarBody></MessageBar></div>}
    </div>;
  }

  if (view === 'detail' && activeDetailRow) return <><ModelDetail section={detailSection} row={activeDetailRow} readOnly={readOnly} onDelete={() => { setDeleteTarget(activeDetailRow); setDeleteOpen(true); }} onSourceChange={source => setModelSource(activeDetailRow, source)} onUpdate={value => {
    if (activeDetailRow.manualIndex === null) return;
    setValue(`manualModels.${activeDetailRow.manualIndex}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }} record={record} upstreamFlags={upstreamFlags} />{deleteDialog}</>;

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-w-0">
    <div className="flex flex-wrap items-center gap-3">
      <div className="grid gap-0.5"><Text size={500} weight="semibold">{t('dashboard.upstreamEditor.models.title')}</Text><Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.summary', { total: rows.length, manual: manual.length, auto: rows.length - manual.length })}</Text></div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {!readOnly && <Button appearance="primary" icon={<AddRegular />} onClick={() => append({ upstreamModelId: '', kind: 'chat', endpoints: { chatCompletions: {} } })}>{t('dashboard.upstreamEditor.models.add')}</Button>}
        {!readOnly && <Button appearance="secondary" className="!min-w-[160px]" icon={<CodeRegular />} onClick={() => { onYamlChange(serializeModels(manual)); onYamlErrorChange(null); onViewChange('yaml'); }}>{t('dashboard.upstreamEditor.models.editAsYaml')}</Button>}
        {record.kind !== 'azure' && <>
          <ModelsCacheStatus cache={record.modelsCache} />
          <Button disabled={loading || !autoFetchEnabled} icon={loading ? <Spinner size="tiny" /> : <ArrowSyncRegular />} onClick={onRefresh}>{t('dashboard.upstreamEditor.models.refresh')}</Button>
        </>}
      </div>
    </div>
    {error && <MessageBar
      className="min-w-0"
      icon={<WarningRegular />}
      intent="warning"
    >
      <MessageBarBody className="min-w-0 [overflow-wrap:anywhere]">
        {error === 'Upstream model listing failed'
          ? t('dashboard.upstreamEditor.models.listingFailed')
          : t('dashboard.upstreamEditor.models.listingFailedWithDetail', { message: error })}
      </MessageBarBody>
    </MessageBar>}
    <Input value={search} onChange={(_, data) => setSearch(data.value)} placeholder={t('dashboard.upstreamEditor.models.search')} />
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table className="w-full min-w-[640px]" style={{ tableLayout: 'fixed' }}>
        <colgroup><col style={{ width: 80 }} /><col style={{ width: '25%' }} /><col style={{ width: 88 }} /><col /><col style={{ width: 80 }} /><col style={{ width: 80 }} /></colgroup>
        <TableHeader><TableRow><TableHeaderCell>{t('dashboard.upstreamEditor.models.enabled')}</TableHeaderCell><TableHeaderCell>{t('dashboard.upstreamEditor.models.name')}</TableHeaderCell><TableHeaderCell>{t('dashboard.upstreamEditor.models.kind')}</TableHeaderCell><TableHeaderCell>{t('dashboard.upstreamEditor.models.id')}</TableHeaderCell><TableHeaderCell>{t('dashboard.upstreamEditor.models.source')}</TableHeaderCell><TableActionsHeader>{t('dashboard.upstreamEditor.models.actions')}</TableActionsHeader></TableRow></TableHeader>
        <TableBody>{filtered.map(row => {
          const id = publicModelId(row.config); return <TableRow className="h-14" key={row.key}>
            <TableCell><Switch checked={!disabled.includes(id)} onChange={(_, data) => setEnabled(id, data.checked)} size="small" /></TableCell>
            <TableCell className="!overflow-hidden">
              <button
                className="block bg-transparent border-0 cursor-pointer min-w-0 max-w-full overflow-hidden p-0 text-ellipsis text-fui-base300 text-fui-fg1 text-left whitespace-nowrap hover:underline"
                onClick={() => { setSelected(row.key); onViewChange('detail'); }}
                title={row.config.display_name ?? id}
                type="button"
              >
                {row.config.display_name ?? id}
              </button>
            </TableCell>
            <TableCell><Text size={300}>{t(`dashboard.upstreamEditor.models.kindValue.${row.config.kind}`)}</Text></TableCell>
            <TableCell className="!overflow-hidden"><span className="flex items-center gap-1 min-w-0 max-w-full overflow-hidden"><code className="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap leading-[var(--lineHeightBase300)]" style={{ maxWidth: 'calc(100% - 36px)' }} title={id}>{id}</code><Tooltip content={t('dashboard.upstreamEditor.models.copy')} relationship="label"><Button appearance="subtle" className="flex-none" icon={<CopyRegular />} size="small" onClick={() => void navigator.clipboard.writeText(id)} /></Tooltip></span></TableCell>
            <TableCell><Text size={300}>{t(`dashboard.upstreamEditor.models.${row.source}`)}</Text></TableCell>
            <TableCell><TableActions><TooltipIconButton icon={<EditRegular />} label={t('dashboard.upstreamEditor.models.edit')} onClick={() => { setSelected(row.key); onViewChange('detail'); }} />{row.manualIndex !== null && <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.models.delete')} onClick={() => { setDeleteTarget(row); setDeleteOpen(true); }} />}</TableActions></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
    </ScrollArea>
    {deleteDialog}
  </div>;
}

function ModelsCacheStatus({ cache }: { cache: UpstreamRecord['modelsCache'] }) {
  const { t } = useTranslation();
  const now = useNow(10_000);
  const elapsed = cache.fetchedAt === null ? null : formatRelativeTime(cache.fetchedAt);
  const label = elapsed === null
    ? t('dashboard.upstreamEditor.models.cacheNever')
    : now - cache.fetchedAt! < 10_000
      ? t('dashboard.upstreamEditor.models.cacheFetchedNow')
      : t('dashboard.upstreamEditor.models.cacheFetched', { time: elapsed });
  const detail = cache.lastError
    ? t('dashboard.upstreamEditor.models.cacheErrorDetail', { message: cache.lastError.message, time: formatFullTime(cache.lastError.at) })
    : cache.fetchedAt === null ? label : formatFullTime(cache.fetchedAt);
  return <Tooltip content={detail} relationship="description">
    <span className="inline-flex items-center gap-1 text-fui-fg2" tabIndex={0}>
      {cache.lastError ? <WarningRegular /> : <CheckmarkCircleRegular />}
      <Text size={200}>{cache.lastError ? t('dashboard.upstreamEditor.models.cacheFailed') : label}</Text>
    </span>
  </Tooltip>;
}
