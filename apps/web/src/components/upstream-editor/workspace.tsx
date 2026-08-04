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
import { useSearchParams } from 'react-router';

import type { ModelListingFailure, ModelRow, UpstreamEditorValues } from './data';
import { canFetchModelCatalog, manualModelsSupported, publicModelId } from './data';
import { shapeForKind } from './endpoints';
import { FeatureFlagsEditor } from './feature-flags';
import { ModelDetail } from './model-detail';
import { parseModels, serializeModels } from './models-yaml';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, relativeTime } from '../../lib/format-time';
import { useEntryRewrite } from '../../lib/page-navigation';
import { useLocale } from '../../lib/use-locale';
import { useNow } from '../../lib/use-now';
import { BackNavigationButton } from '../ui/back-navigation-button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useDangerTextClass } from '../ui/danger';
import { EmptyStateLine } from '../ui/empty-state';
import { Input } from '../ui/fluent-form-controls';
import { ContentLoadingScreen } from '../ui/loading-screen';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { RowTitleButton } from '../ui/row-title';
import { ScrollArea } from '../ui/scroll-area';
import { SectionHeader } from '../ui/section-header';
import { TABLE_ACTIONS_WIDTH, TableActions, TableCentredCell, TableCentredHeader, TableTrailingHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import type { UpstreamModelConfig } from '@floway-dev/provider';

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
/** An edit typed into the YAML view and not yet applied, with whatever the last apply said about it. */
interface YamlDraft {
  text: string;
  error: string | null;
}
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
  modelsError: ModelListingFailure | null;
  modelsLoading: boolean;
  onRefreshModels: () => void;
  record: UpstreamRecord;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const { formState: { errors } } = useFormContext<UpstreamEditorValues>();
  const [params, setParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  // The YAML text is a projection of the manual models — serialized on the way
  // in, parsed back on the way out — so the only thing that has to be state is
  // an edit that has not been applied yet. Holding just that draft is what lets
  // every entrance into the view show the same text: there is nothing for a
  // link, a reload or the button to remember to seed.
  const [yamlDraft, setYamlDraft] = useState<YamlDraft | null>(null);
  const workspaceScrollRef = useRef<HTMLDivElement>(null);

  // A model is named in the URL by its upstream id: row keys are rebuilt per
  // render for manual entries and do not survive a reload.
  const tab = params.get(TAB_PARAM) === 'flags' ? 'flags' : 'models';
  const selectedUpstreamModelId = params.get(MODEL_PARAM);
  // A provider-owned catalog has no manual models to write, so its editor is
  // not addressable either — a typed `?view=yaml` lands on the list rather than
  // on an editable buffer the upstream would never store.
  const editableCatalog = manualModelsSupported(record);
  const modelView: ModelView = selectedUpstreamModelId !== null
    ? 'detail'
    : params.get(VIEW_PARAM) === 'yaml' && editableCatalog ? 'yaml' : 'list';
  const modelDetailTab: ModelDetailTab = params.get(SECTION_PARAM) === 'flags' ? 'flags' : 'details';
  const showModelDetail = modelView === 'detail';

  // The draft lives exactly as long as the view it belongs to, and the view is
  // the URL rather than any mounted component. Leaving drops it, so re-entering
  // projects the models again instead of resurrecting an abandoned edit.
  if (modelView !== 'yaml' && yamlDraft !== null) setYamlDraft(null);

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
    }, rewrite);
  }, [rewrite, setParams]);

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
  const modelsWorkspace = <ModelsWorkspace detailSection={modelDetailTab} onSelectUpstreamModel={selectModel} selectedUpstreamModelId={selectedUpstreamModelId} discovered={discovered} modelsLoading={modelsLoading} modelsError={modelsError} onRefreshModels={onRefreshModels} onViewChange={changeModelView} readOnly={!editableCatalog} record={record} view={modelView} yamlDraft={yamlDraft} onYamlDraftChange={setYamlDraft} />;
  return <section className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] h-full min-h-0 min-w-0 max-[1050px]:h-auto">
    <div className="flex items-center gap-2 border-0 border-b border-solid border-fui-divider px-5 pt-2">
      {showModelDetail
        ? <>
            <BackNavigationButton onClick={() => selectModel(null)}>{t('dashboard.upstreamEditor.models.back')}</BackNavigationButton>
            <TabList aria-label={t('dashboard.upstreamEditor.models.sections')} selectedValue={modelDetailTab} onTabSelect={(_, data) => navigate({ tab, model: selectedUpstreamModelId, section: data.value as ModelDetailTab, view: 'list' })}>
              <Tab value="details">{t('dashboard.upstreamEditor.models.details')}</Tab>
              <Tab value="flags">{t('dashboard.upstreamEditor.models.flags')}</Tab>
            </TabList>
          </>
        // The models view is carried across tab switches rather than reset,
        // because the YAML draft belongs to the view's presence in the URL: a
        // reset here would leave the view and discard whatever had been typed
        // and not yet applied.
        : <TabList aria-label={t('dashboard.upstreamEditor.tabs.label')} selectedValue={tab} onTabSelect={(_, data) => navigate({ tab: data.value as WorkspaceTab, model: null, section: 'details', view: modelView === 'yaml' ? 'yaml' : 'list' })}>
            <Tab value="models">{t('dashboard.upstreamEditor.tabs.models')}</Tab>
            <Tab value="flags">{t('dashboard.upstreamEditor.tabs.flags')}</Tab>
          </TabList>}
    </div>
    <ScrollArea ref={workspaceScrollRef} axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" contentClassName={tab === 'models' && modelView === 'yaml' ? 'h-full min-w-0' : ''} noTabIndex>
      {tab === 'models' && modelView === 'yaml'
        ? modelsWorkspace
        : <div className="px-5 py-4">
            {tab === 'models' ? <div className="grid gap-4">
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

function ModelsWorkspace({ detailSection, discovered, modelsError, modelsLoading, onRefreshModels, onSelectUpstreamModel, onViewChange, onYamlDraftChange, readOnly, record, selectedUpstreamModelId, view, yamlDraft }: {
  detailSection: ModelDetailTab;
  discovered: UpstreamModelConfig[];
  modelsError: ModelListingFailure | null;
  modelsLoading: boolean;
  onRefreshModels: () => void;
  onSelectUpstreamModel: (id: string | null) => void;
  onViewChange: (view: ModelView) => void;
  onYamlDraftChange: (draft: YamlDraft) => void;
  readOnly: boolean;
  record: UpstreamRecord;
  selectedUpstreamModelId: string | null;
  view: ModelView;
  yamlDraft: YamlDraft | null;
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
  const autoFetchEnabled = record.kind !== 'custom'
    || (config as Extract<UpstreamRecord, { kind: 'custom' }>['config']).modelsFetch.enabled;
  const canFetch = canFetchModelCatalog(record, config);
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
  // A one-shot handoff, not synchronised state: the placeholder is dropped
  // once the row the pending manual model produced exists.
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
  // Every branch below returns this in the same position under a fragment, so
  // the view switch does not reparent it: a dialog hung off a branch's own
  // root unmounts in the same commit that asks it to close, leaving the exit
  // no frames to run in.
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
    const text = yamlDraft?.text ?? serializeModels(manual);
    // A failed apply keeps the text as the draft, so the message stays attached
    // to the buffer that produced it.
    const applyAndLeave = () => {
      const parsed = parseModels(text, { allowRerank: record.kind === 'custom' });
      if (!parsed.ok) { onYamlDraftChange({ text, error: parsed.message }); return; }
      replace(parsed.models);
      onViewChange('list');
    };
    return <><div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] h-full min-h-[480px] min-w-0">
      <div className="px-5 py-4">
        <SectionHeader
          description={t('dashboard.upstreamEditor.models.yamlHint')}
          level={2}
          title={t('dashboard.upstreamEditor.models.yamlTitle')}
          actions={<Button className="!min-w-[160px]" icon={<CheckmarkCircleRegular />} onClick={applyAndLeave}>
            {t('dashboard.upstreamEditor.models.editWithUi')}
          </Button>}
        />
      </div>
      <div className="h-full min-h-0 overflow-hidden border-0 border-y border-solid border-fui-divider">
        <Suspense fallback={<ContentLoadingScreen label={t('common.loading')} />}>
          <ModelsYamlEditor value={text} onChange={value => onYamlDraftChange({ text: value, error: null })} />
        </Suspense>
      </div>
      {yamlDraft?.error && <div className="px-5 py-3"><OutcomeMessageBar>{yamlDraft.error}</OutcomeMessageBar></div>}
    </div>{deleteConfirmation}</>;
  }

  if (view === 'detail' && activeDetailRow) return <><ModelDetail section={detailSection} row={activeDetailRow} readOnly={readOnly} onDelete={() => deleteDialog.open(activeDetailRow)} onSourceChange={source => setModelSource(activeDetailRow, source)} onChange={value => {
    if (activeDetailRow.manualIndex === null) return;
    setValue(`manualModels.${activeDetailRow.manualIndex}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }} record={record} upstreamFlags={upstreamFlags} />{deleteConfirmation}</>;

  return <><div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-w-0">
    <SectionHeader
      description={t('dashboard.upstreamEditor.models.summary', { total: rows.length, manual: manual.length, auto: rows.length - manual.length })}
      level={2}
      title={t('dashboard.upstreamEditor.models.title')}
      actions={<>
        {!readOnly && <Button appearance="primary" icon={<AddRegular />} onClick={() => append({ upstreamModelId: '', kind: 'chat', ...shapeForKind('chat', { endpoints: {} }) })}>{t('dashboard.upstreamEditor.models.add')}</Button>}
        {!readOnly && <Button className="!min-w-[160px]" icon={<CodeRegular />} onClick={() => onViewChange('yaml')}>{t('dashboard.upstreamEditor.models.editAsYaml')}</Button>}
        {record.kind !== 'azure' && <>
          <ModelsCacheStatus cache={record.modelsCache} />
          <Button disabled={!canFetch} disabledFocusable={modelsLoading} icon={modelsLoading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={onRefreshModels}>{t('dashboard.upstreamEditor.models.refresh')}</Button>
        </>}
      </>}
    />
    {modelsError && <OutcomeMessageBar intent="warning">
      {modelsError.upstreamListingFailed
        ? t('dashboard.upstreamEditor.models.listingFailed')
        : t('dashboard.upstreamEditor.models.listingFailedWithDetail', { message: modelsError.message })}
    </OutcomeMessageBar>}
    <Input value={search} onChange={(_, data) => setSearch(data.value)} placeholder={t('dashboard.upstreamEditor.models.search')} />
    <ScrollArea axes="horizontal" className="min-w-0">
      <Table aria-label={t('dashboard.upstreamEditor.models.title')} className="w-full min-w-[664px]">
        <TableColumns widths={['80px', '25%', '88px', null, '80px', TABLE_ACTIONS_WIDTH]} />
        <TableHeader><TableRow><TableCentredHeader>{t('dashboard.upstreamEditor.models.enabled')}</TableCentredHeader><TableHeaderCell>{t('dashboard.upstreamEditor.models.name')}</TableHeaderCell><TableCentredHeader>{t('dashboard.upstreamEditor.models.kind')}</TableCentredHeader><TableHeaderCell>{t('dashboard.upstreamEditor.models.id')}</TableHeaderCell><TableCentredHeader>{t('dashboard.upstreamEditor.models.source')}</TableCentredHeader><TableTrailingHeader>{t('dashboard.upstreamEditor.models.actions')}</TableTrailingHeader></TableRow></TableHeader>
        <TableBody>{filtered.length === 0 ? <TableRow><TableCell colSpan={6}><EmptyStateLine>{t('dashboard.upstreamEditor.models.noMatches')}</EmptyStateLine></TableCell></TableRow> : filtered.map(row => {
          const id = publicModelId(row.config); return <TableRow className="h-14" key={row.key}>
            <TableCentredCell><Switch aria-label={t('dashboard.upstreamEditor.models.enabledFor', { name: row.config.display_name ?? id })} checked={!disabled.includes(id)} onChange={(_, data) => setEnabled(id, data.checked)} /></TableCentredCell>
            <TableCell className="overflow-hidden">
              <TruncationTooltip content={row.config.display_name ?? id} relationship="label">
                {measureRef => <RowTitleButton onClick={() => onSelectUpstreamModel(row.config.upstreamModelId)} ref={measureRef}>
                  {row.config.display_name ?? id}
                </RowTitleButton>}
              </TruncationTooltip>
            </TableCell>
            <TableCentredCell>{t(`dashboard.upstreamEditor.models.kindValue.${row.config.kind}`)}</TableCentredCell>
            <TableCell className="overflow-hidden"><span className="flex items-center gap-1 min-w-0 max-w-full"><TruncationTooltip content={id} relationship="label">{measureRef => <code className="winui-focus-rect block min-w-0 max-w-[calc(100%-36px)] truncate leading-[var(--lineHeightBase300)]" ref={measureRef} tabIndex={0}>{id}</code>}</TruncationTooltip><TooltipIconButton className="flex-none" icon={copyOutcomeIcon(outcomeFor(id))} label={copyLabel(outcomeFor(id), t('dashboard.upstreamEditor.models.copy'))} onClick={() => copy(id, id)} /></span></TableCell>
            <TableCentredCell>{t(`dashboard.upstreamEditor.models.${row.source}`)}</TableCentredCell>
            <TableCell><TableActions><TooltipIconButton icon={<EditRegular />} label={t('dashboard.upstreamEditor.models.editNamed', { name: row.config.display_name ?? id })} onClick={() => onSelectUpstreamModel(row.config.upstreamModelId)} />{row.manualIndex !== null && <TooltipIconButton danger icon={<DeleteRegular />} label={t('dashboard.upstreamEditor.models.deleteNamed', { name: row.config.display_name ?? id })} onClick={() => deleteDialog.open(row)} />}</TableActions></TableCell>
          </TableRow>;
        })}</TableBody>
      </Table>
    </ScrollArea>
  </div>{deleteConfirmation}</>;
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
    <span className="winui-focus-rect inline-flex items-center gap-1 text-fui-fg2" tabIndex={0}>
      {cache.lastError ? <WarningRegular /> : <CheckmarkCircleRegular />}
      <Text size={200}>{cache.lastError ? t('dashboard.upstreamEditor.models.cacheFailed') : label}</Text>
    </span>
  </Tooltip>;
}
