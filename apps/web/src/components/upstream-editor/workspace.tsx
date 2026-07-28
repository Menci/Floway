import {
  AddRegular,
  ArrowLeftRegular,
  ArrowSyncRegular,
  CheckmarkCircleRegular,
  CodeRegular,
  CopyRegular,
  DeleteRegular,
  EditRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { lazy, Suspense, useMemo, useState } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';

import type { UpstreamEditorValues } from './editor-data';
import { publicModelId } from './editor-data';
import { FeatureFlagsEditor } from './feature-flags';
import { ModelDetail } from './model-detail';
import { parseModels, serializeModels } from './models-yaml';
import type { UpstreamModelConfig, UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { formatFullTime, formatRelativeTime } from '../requests/format';
import { Input } from '../ui/fluent-form-controls';
import { ScrollArea } from '../ui/scroll-area';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import type { Flag } from '@floway-dev/provider/flags';

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
  flags,
  loadingModels,
  modelsError,
  onRefreshModels,
  record,
}: {
  discovered: UpstreamModelConfig[];
  flags: Flag[];
  loadingModels: boolean;
  modelsError: string | null;
  onRefreshModels: () => void;
  record: UpstreamRecord;
}) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'models' | 'flags'>('models');
  const [modelView, setModelView] = useState<ModelView>('list');
  const [modelDetailTab, setModelDetailTab] = useState<ModelDetailTab>('details');
  const showModelDetail = modelView === 'detail';
  const changeModelView = (next: ModelView) => {
    setModelView(next);
    if (next === 'detail') setModelDetailTab('details');
  };
  return <section className="grid grid-rows-[auto_minmax(0,1fr)] h-full min-h-0 max-[1050px]:h-auto">
    <div className="border-b border-b-solid border-fui-stroke1 px-5 pt-2">
      {showModelDetail
        ? <TabList selectedValue={modelDetailTab} onTabSelect={(_, data) => {
            if (data.value === 'back') setModelView('list');
            else setModelDetailTab(data.value as ModelDetailTab);
          }}>
              <Tab icon={<ArrowLeftRegular />} value="back">{t('dashboard.upstreamEditor.models.back')}</Tab>
              <Tab value="details">{t('dashboard.upstreamEditor.models.details')}</Tab>
              <Tab value="flags">{t('dashboard.upstreamEditor.models.flags')}</Tab>
            </TabList>
        : <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(data.value as typeof tab)}>
            <Tab value="models">{t('dashboard.upstreamEditor.tabs.models')}</Tab>
            <Tab value="flags">{t('dashboard.upstreamEditor.tabs.flags')}</Tab>
          </TabList>}
    </div>
    <ScrollArea axes="vertical" className="min-h-0 max-[1050px]:h-auto" contentClassName="p-5" noTabIndex>
      {tab === 'models' ? <ModelsWorkspace detailSection={modelDetailTab} discovered={discovered} flags={flags} loading={loadingModels} error={modelsError} onRefresh={onRefreshModels} onViewChange={changeModelView} record={record} view={modelView} /> : <div className="grid gap-5">
        <Text size={300} className="text-fui-fg2 leading-[1.45]">
          {t('dashboard.upstreamEditor.flags.intro')}
        </Text>
        <Controller name="flagOverrides" render={({ field }) => <FeatureFlagsEditor defaults={record.flag_defaults} flags={flags} value={field.value} onChange={field.onChange} />} />
      </div>}
    </ScrollArea>
  </section>;
}

function ModelsWorkspace({ detailSection, discovered, error, flags, loading, onRefresh, onViewChange, record, view }: {
  detailSection: ModelDetailTab;
  discovered: UpstreamModelConfig[];
  error: string | null;
  flags: Flag[];
  loading: boolean;
  onRefresh: () => void;
  onViewChange: (view: ModelView) => void;
  record: UpstreamRecord;
  view: ModelView;
}) {
  const { t } = useTranslation();
  const { control, setValue } = useFormContext<UpstreamEditorValues>();
  const { append, fields, remove, replace } = useFieldArray({ control, name: 'manualModels' });
  const manual = useWatch({ control, name: 'manualModels' });
  const config = useWatch({ control, name: 'config' });
  const disabled = useWatch({ control, name: 'disabledPublicModelIds' });
  const upstreamFlags = useWatch({ control, name: 'flagOverrides' });
  const [yaml, setYaml] = useState('');
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelRow | null>(null);
  const [pendingManualId, setPendingManualId] = useState<string | null>(null);
  const [pendingManualConfig, setPendingManualConfig] = useState<UpstreamModelConfig | null>(null);
  const [search, setSearch] = useState('');
  const readOnly = record.kind === 'copilot' || record.kind === 'codex' || record.kind === 'claude-code';
  if (fields.length !== manual.length) throw new Error('Manual model fields are out of sync with form values');
  const autoFetchEnabled = record.kind !== 'custom'
    || (config as Extract<UpstreamRecord, { kind: 'custom' }>['config']).modelsFetch.enabled;
  const rows = useMemo<ModelRow[]>(() => {
    const visibleDiscovered = autoFetchEnabled ? discovered : [];
    const autoById = new Map(visibleDiscovered.map(item => [item.upstreamModelId, item]));
    const result: ModelRow[] = manual.map((item, index) => ({ key: `manual:${fields[index]!.id}`, source: 'manual', config: item, manualIndex: index, hasAuto: autoById.has(item.upstreamModelId) }));
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

  const deleteModel = () => {
    if (deleteTarget?.manualIndex === null || deleteTarget === null) return;
    remove(deleteTarget.manualIndex);
    if (selected === deleteTarget.key) {
      setSelected(null);
      onViewChange('list');
    }
    setDeleteTarget(null);
  };

  const deleteDialog = <ConfirmDialog
    actionLabel={t('dashboard.upstreamEditor.models.deleteConfirm')}
    message={t('dashboard.upstreamEditor.models.deleteMessage', { name: deleteTarget?.config.display_name ?? (deleteTarget ? publicModelId(deleteTarget.config) : '') })}
    onConfirm={deleteModel}
    onOpenChange={open => { if (!open) setDeleteTarget(null); }}
    open={deleteTarget !== null}
    title={t('dashboard.upstreamEditor.models.deleteTitle')}
  />;

  if (view === 'yaml') {
    // Leaving YAML mode has to validate first; refusing to leave on a parse
    // error is what keeps the operator's unsaved text on screen.
    const applyAndLeave = () => {
      const parsed = parseModels(yaml, { allowRerank: record.kind === 'custom' });
      if (!parsed.ok) { setYamlError(parsed.message); return; }
      replace(parsed.models);
      setYamlError(null);
      onViewChange('list');
    };
    return <div className="grid gap-4 min-w-0">
      <div className="flex flex-wrap items-center gap-3">
        <div className="grid gap-0.5">
          <Text size={500} weight="semibold">{t('dashboard.upstreamEditor.models.yamlTitle')}</Text>
          <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.yamlHint')}</Text>
        </div>
        <Button appearance="secondary" className="!min-w-[160px] ml-auto" icon={<CheckmarkCircleRegular />} onClick={applyAndLeave}>
          {t('dashboard.upstreamEditor.models.editWithUi')}
        </Button>
      </div>
      <div className="h-[max(480px,calc(100vh-330px))] min-h-[480px] overflow-hidden border border-solid border-fui-stroke1 rounded-md">
        <Suspense fallback={<div className="h-full" />}>
          <ModelsYamlEditor value={yaml} onChange={value => { setYaml(value); setYamlError(null); }} />
        </Suspense>
      </div>
      {yamlError && <MessageBar intent="error"><MessageBarBody>{yamlError}</MessageBarBody></MessageBar>}
    </div>;
  }

  if (view === 'detail' && activeDetailRow) return <><ModelDetail section={detailSection} row={activeDetailRow} readOnly={readOnly} onDelete={() => setDeleteTarget(activeDetailRow)} onSourceChange={source => setModelSource(activeDetailRow, source)} onUpdate={value => {
    if (activeDetailRow.manualIndex === null) return;
    setValue(`manualModels.${activeDetailRow.manualIndex}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }} record={record} flags={flags} upstreamFlags={upstreamFlags} />{deleteDialog}</>;

  return <div className="grid gap-4 min-w-0">
    <div className="flex flex-wrap items-center gap-3">
      <div className="grid gap-0.5"><Text size={500} weight="semibold">{t('dashboard.upstreamEditor.models.title')}</Text><Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.models.summary', { total: rows.length, manual: manual.length, auto: rows.length - manual.length })}</Text></div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {!readOnly && <Button appearance="primary" icon={<AddRegular />} onClick={() => append({ upstreamModelId: '', kind: 'chat', endpoints: { chatCompletions: {} } })}>{t('dashboard.upstreamEditor.models.add')}</Button>}
        {!readOnly && <Button appearance="secondary" className="!min-w-[160px]" icon={<CodeRegular />} onClick={() => { setYaml(serializeModels(manual)); setYamlError(null); onViewChange('yaml'); }}>{t('dashboard.upstreamEditor.models.editAsYaml')}</Button>}
        {record.kind !== 'azure' && <>
          <ModelsCacheStatus cache={record.modelsCache} />
          <Button disabled={loading || !autoFetchEnabled} icon={loading ? <Spinner size="tiny" /> : <ArrowSyncRegular />} onClick={onRefresh}>{t('dashboard.upstreamEditor.models.refresh')}</Button>
        </>}
      </div>
    </div>
    {error && <MessageBar
      icon={<WarningRegular />}
      intent="warning"
    >
      <MessageBarBody>
        {error === 'Upstream model listing failed'
          ? t('dashboard.upstreamEditor.models.listingFailed')
          : t('dashboard.upstreamEditor.models.listingFailedWithDetail', { message: error })}
      </MessageBarBody>
    </MessageBar>}
    <Input value={search} onChange={(_, data) => setSearch(data.value)} placeholder={t('dashboard.upstreamEditor.models.search')} />
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table className="w-full min-w-[640px] table-fixed">
        <TableHeader><TableRow><TableHeaderCell className="!w-[88px]">{t('dashboard.upstreamEditor.models.enabled')}</TableHeaderCell><TableHeaderCell className="!w-[25%]">{t('dashboard.upstreamEditor.models.name')}</TableHeaderCell><TableHeaderCell className="!w-[96px]">{t('dashboard.upstreamEditor.models.kind')}</TableHeaderCell><TableHeaderCell>{t('dashboard.upstreamEditor.models.id')}</TableHeaderCell><TableHeaderCell className="!w-[96px]">{t('dashboard.upstreamEditor.models.source')}</TableHeaderCell><TableHeaderCell className="!w-[88px] !text-right">{t('dashboard.upstreamEditor.models.actions')}</TableHeaderCell></TableRow></TableHeader>
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
            <TableCell className="!overflow-hidden"><span className="flex items-center gap-1 min-w-0 max-w-full overflow-hidden"><code className="block text-fui-base300 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap" title={id}>{id}</code><Tooltip content={t('dashboard.upstreamEditor.models.copy')} relationship="label"><Button appearance="subtle" className="flex-none" icon={<CopyRegular />} size="small" onClick={() => void navigator.clipboard.writeText(id)} /></Tooltip></span></TableCell>
            <TableCell><Text size={300}>{t(`dashboard.upstreamEditor.models.${row.source}`)}</Text></TableCell>
            <TableCell><div className="flex justify-end gap-1"><TooltipIconButton icon={<EditRegular />} label={t('dashboard.upstreamEditor.models.edit')} onClick={() => { setSelected(row.key); onViewChange('detail'); }} />{row.manualIndex !== null && <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.models.delete')} onClick={() => setDeleteTarget(row)} />}</div></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
    </ScrollArea>
    {deleteDialog}
  </div>;
}

function ModelsCacheStatus({ cache }: { cache: UpstreamRecord['modelsCache'] }) {
  const { t } = useTranslation();
  const elapsed = cache.fetchedAt === null ? null : formatRelativeTime(cache.fetchedAt);
  const label = elapsed === null
    ? t('dashboard.upstreamEditor.models.cacheNever')
    : elapsed === 'now'
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
