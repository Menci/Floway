import {
  AddRegular,
  ArrowClockwiseRegular,
  CheckmarkCircleRegular,
  ChevronRightRegular,
  CodeRegular,
  DeleteRegular,
  EditRegular,
  WarningRegular,
} from '@fluentui/react-icons';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Controller, useFieldArray, useFormContext, useWatch } from 'react-hook-form';
import { useSearchParams } from 'react-router';

import type { ModelListingFailure, ModelRow, UpstreamEditLevel, UpstreamEditorValues } from './data';
import { canFetchModelCatalog, manualModelsSupported, modelsEditable, publicModelId } from './data';
import { shapeForKind } from './endpoints';
import { FeatureFlagsEditor } from './feature-flags';
import { ModelDetail } from './model-detail';
import { modelValidationIssues } from './model-validation';
import { parseModels, serializeModels } from './models-yaml';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { dateTime, relativeTime } from '../../lib/format-time';
import { useEntryRewrite } from '../../lib/page-navigation';
import { useLocale } from '../../lib/use-locale';
import { useMediaQuery } from '../../lib/use-media-query';
import { useNow } from '../../lib/use-now';
import { BackNavigationButton } from '../ui/back-navigation-button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { useDangerTextClass } from '../ui/danger';
import { EmptyStateLine } from '../ui/empty-state';
import { Input, Switch } from '../ui/fluent-form-controls';
import { PINNED_CARD_FILL_CLASS } from '../ui/layout';
import { ContentLoadingScreen } from '../ui/loading-screen';
import { useNarrowListItemClass } from '../ui/narrow-list-item';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { RowTitleButton } from '../ui/row-title';
import { ScrollArea } from '../ui/scroll-area';
import { SectionHeader } from '../ui/section-header';
import { stopRowSelection, TABLE_ACTIONS_WIDTH, TableActions, TableActionsHeader, TableCentredCell, TableCentredHeader } from '../ui/table-actions';
import { TableColumns } from '../ui/table-columns';
import { TooltipIconButton } from '../ui/tooltip-icon-button';
import { TruncationTooltip } from '../ui/truncation-tooltip';
import { copyOutcomeIcon, useCopyLabel, useCopyToClipboard } from '../ui/use-copy-to-clipboard';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { MODEL_ERROR_EDITOR_LENGTH, modelErrorExcerpt } from '../upstreams/model-error';
import type { UpstreamModelConfig } from '@floway-dev/upstream/browser';

const {
  Button,
  List,
  ListItem,
  Spinner,
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
type WorkspaceTab = 'config' | 'models' | 'flags';
/** An edit typed into the YAML view and not yet applied, with whatever the last apply said about it. */
export interface ModelsYamlDraft {
  baseline: string;
  text: string;
  error: string | null;
}
interface WorkspaceLocation {
  tab: WorkspaceTab;
  model: string | null;
  section: ModelDetailTab;
  view: 'list' | 'yaml';
}
interface ModelSelection {
  locator: string;
  manualIndex: number | null;
  rowKey: string | null;
}

const TAB_PARAM = 'tab';
const MODEL_PARAM = 'model';
const SECTION_PARAM = 'section';
const VIEW_PARAM = 'view';
type ModelDetailTab = 'details' | 'flags';

// The form fields the models and flags sections edit; every other field is
// shown by the configuration section.
const WORKSPACE_FIELDS: ReadonlySet<string> = new Set(['manualModels', 'disabledPublicModelIds', 'flagOverrides']);
export const isConfigSectionError = (field: string): boolean => !WORKSPACE_FIELDS.has(field);

/** The editor's address with the configuration section open. */
export const configSectionSearch = (current: URLSearchParams): URLSearchParams => {
  const search = new URLSearchParams(current);
  search.set(TAB_PARAM, 'config');
  search.delete(MODEL_PARAM);
  search.delete(SECTION_PARAM);
  return search;
};

// A sectioned workspace opens on the configuration, the pane a two-column
// editor puts first; an address naming a model or the YAML view is still a
// models address, whichever layout reads it.
const workspaceTab = (params: URLSearchParams, sectioned: boolean): WorkspaceTab => {
  const requested = params.get(TAB_PARAM);
  if (requested === 'flags' || requested === 'models') return requested;
  if (requested === 'config' && sectioned) return 'config';
  if (!sectioned || params.has(MODEL_PARAM) || params.get(VIEW_PARAM) === 'yaml') return 'models';
  return 'config';
};

// Where the model table no longer fits beside the card's inset and gives way
// to a list, as the API key table does at the same width.
const MODEL_LIST_QUERY = '(max-width: 760px)';

const ModelsYamlEditor = lazy(() => import('./models-yaml-editor'));

export function UpstreamWorkspace({
  configPane,
  discovered,
  editLevel,
  modelsYamlDraft,
  modelsError,
  modelsLoading,
  onModelsYamlDraftChange,
  onRefreshModels,
  record,
}: {
  /** Given, the configuration is a section of this workspace rather than a pane beside it. */
  configPane?: ReactNode | undefined;
  discovered: UpstreamModelConfig[];
  editLevel: UpstreamEditLevel;
  modelsYamlDraft: ModelsYamlDraft | null;
  modelsError: ModelListingFailure | null;
  modelsLoading: boolean;
  onModelsYamlDraftChange: (draft: ModelsYamlDraft | null) => void;
  onRefreshModels: () => void;
  record: UpstreamRecord;
}) {
  const { t } = useTranslation();
  const dangerText = useDangerTextClass();
  const { formState: { errors, submitCount }, getValues } = useFormContext<UpstreamEditorValues>();
  const [params, setParams] = useSearchParams();
  const rewrite = useEntryRewrite();
  // The YAML text is a projection of the manual models — serialized on the way
  // in, parsed back on the way out — so the only thing that has to be state is
  // an edit that has not been applied yet. Holding just that draft is what lets
  // every entrance into the view show the same text: there is nothing for a
  // link, a reload or the button to remember to seed.
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);
  const [modelValidationAttempted, setModelValidationAttempted] = useState(false);
  const workspaceScrollRef = useRef<HTMLDivElement>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const sectioned = configPane !== undefined;

  // `model` is only a reloadable locator. The mounted editor uses the
  // field-array row id, so renames and temporary duplicate ids cannot retarget
  // or remount it.
  const tab = workspaceTab(params, sectioned);
  const selectedUpstreamModelId = params.get(MODEL_PARAM);
  // A provider-owned catalog has no manual models to write, so its editor is
  // not addressable either — a typed `?view=yaml` lands on the list rather than
  // on an editable buffer the upstream would never store. The same applies to
  // an audit-only editor, which may read the list but not edit it.
  const editableCatalog = manualModelsSupported(record);
  const editableModels = modelsEditable(editLevel);
  const modelView: ModelView = selectedUpstreamModelId !== null
    ? 'detail'
    : params.get(VIEW_PARAM) === 'yaml' && editableCatalog && editableModels ? 'yaml' : 'list';
  const modelDetailTab: ModelDetailTab = params.get(SECTION_PARAM) === 'flags' ? 'flags' : 'details';
  const showModelDetail = modelView === 'detail';

  // The draft lives exactly as long as the view it belongs to, and the view is
  // the URL rather than any mounted component. Leaving drops it, so re-entering
  // projects the models again instead of resurrecting an abandoned edit.
  useEffect(() => {
    if (modelView !== 'yaml' && modelsYamlDraft !== null) onModelsYamlDraftChange(null);
  }, [modelView, modelsYamlDraft, onModelsYamlDraftChange]);

  // Replace rather than push: moving around inside one editor is not a place
  // the back button should have to walk out of a step at a time.
  const navigate = useCallback((next: WorkspaceLocation) => {
    setParams(previous => {
      const search = new URLSearchParams(previous);
      for (const [key, value] of Object.entries({
        // Sectioned, every tab is written out: a bare address opens the
        // configuration there, but a model or the YAML view would read as models.
        [TAB_PARAM]: !sectioned && next.tab === 'models' ? null : next.tab,
        [MODEL_PARAM]: next.model,
        [SECTION_PARAM]: next.model !== null && next.section === 'flags' ? 'flags' : null,
        [VIEW_PARAM]: next.model === null && next.view === 'yaml' ? 'yaml' : null,
      })) {
        if (value === null) search.delete(key); else search.set(key, value);
      }
      return search;
    }, rewrite);
  }, [rewrite, sectioned, setParams]);

  const changeModelView = (next: ModelView) => navigate({
    tab,
    model: next === 'detail' ? selectedUpstreamModelId : null,
    section: 'details',
    view: next === 'yaml' ? 'yaml' : 'list',
  });
  const openModel = (selection: ModelSelection | null) => {
    setModelSelection(selection);
    setModelValidationAttempted(false);
    navigate({ tab, model: selection?.locator ?? null, section: 'details', view: 'list' });
  };
  const selectedManualIndex = modelSelection
    ? modelSelection.manualIndex
    : selectedUpstreamModelId === null
      ? null
      : getValues('manualModels').findIndex(model => model.upstreamModelId === selectedUpstreamModelId);
  const leaveModel = () => {
    if (selectedManualIndex !== null && selectedManualIndex >= 0) {
      const model = getValues('manualModels')[selectedManualIndex];
      if (model && modelValidationIssues(model).length > 0) {
        setModelValidationAttempted(true);
        return;
      }
    }
    openModel(null);
  };
  const commitModelLocator = (upstreamModelId: string) => {
    if (!modelSelection || upstreamModelId === modelSelection.locator) return;
    setModelSelection({ ...modelSelection, locator: upstreamModelId });
    navigate({ tab, model: upstreamModelId, section: modelDetailTab, view: 'list' });
  };
  useLayoutEffect(() => {
    workspaceScrollRef.current?.scrollTo({ left: 0, top: 0 });
    // Sectioned, the page scrolls instead, and a section opened from far down
    // the previous one would otherwise open at that depth.
    const section = sectionRef.current;
    if (sectioned && section && section.getBoundingClientRect().top < 0) section.scrollIntoView({ block: 'start' });
  }, [modelDetailTab, modelView, sectioned, tab]);
  const modelsWorkspace = <ModelsWorkspace detailSection={modelDetailTab} modelSelection={modelSelection} onModelLocatorCommit={commitModelLocator} onModelSelectionChange={setModelSelection} onOpenModel={openModel} selectedUpstreamModelId={selectedUpstreamModelId} discovered={discovered} modelsLoading={modelsLoading} modelsError={modelsError} onRefreshModels={onRefreshModels} onViewChange={changeModelView} editableModels={editableModels} readOnly={!editableCatalog} record={record} revealValidation={modelValidationAttempted || submitCount > 0} view={modelView} yamlDraft={modelsYamlDraft} onYamlDraftChange={onModelsYamlDraftChange} />;
  return <section className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] h-full min-h-0 min-w-0 max-[1050px]:h-auto" ref={sectionRef}>
    {/* Sectioned, the page scrolls the whole card, so the bar that switches
        sections stays pinned to the top of the scrollport. */}
    <div className={`flex flex-wrap items-center gap-2 border-0 border-b border-solid border-fui-divider px-5 pt-2 ${sectioned ? `sticky top-0 z-[1] ${PINNED_CARD_FILL_CLASS}` : ''}`}>
      {showModelDetail
        ? <>
            <BackNavigationButton onClick={leaveModel}>{t('models.editor.back')}</BackNavigationButton>
            <TabList aria-label={t('models.editor.sections')} selectedValue={modelDetailTab} onTabSelect={(_, data) => navigate({ tab, model: selectedUpstreamModelId, section: data.value as ModelDetailTab, view: 'list' })}>
              <Tab value="details">{t('models.editor.details')}</Tab>
              <Tab value="flags">{t('models.editor.flags')}</Tab>
            </TabList>
          </>
        // The models view is carried across tab switches rather than reset,
        // because the YAML draft belongs to the view's presence in the URL: a
        // reset here would leave the view and discard whatever had been typed
        // and not yet applied.
        : <TabList aria-label={t('upstreams.editor.tabs.label')} selectedValue={tab} onTabSelect={(_, data) => navigate({ tab: data.value as WorkspaceTab, model: null, section: 'details', view: modelView === 'yaml' ? 'yaml' : 'list' })}>
            {sectioned && <Tab value="config">{t('upstreams.editor.tabs.config')}</Tab>}
            <Tab value="models">{t('upstreams.editor.tabs.models')}</Tab>
            <Tab value="flags">{t('upstreams.editor.tabs.flags')}</Tab>
          </TabList>}
    </div>
    {tab === 'config' ? configPane : <ScrollArea ref={workspaceScrollRef} axes="vertical" className="h-full min-h-0 max-[1050px]:h-auto" contentClassName={tab === 'models' && modelView === 'yaml' ? 'h-full min-w-0' : ''} noTabIndex>
      {tab === 'models' && modelView === 'yaml'
        ? modelsWorkspace
        : <div className="px-5 py-4">
            {tab === 'models' ? <div className="grid gap-4">
              {errors.manualModels?.message && <Text className={dangerText} role="alert" size={200}>{t(errors.manualModels.message)}</Text>}
              {modelsWorkspace}
            </div> : <div className="grid gap-5">
              <Text size={300} className="text-fui-fg2">
                {t('upstreams.editor.flags.intro')}
              </Text>
              <Controller name="flagOverrides" render={({ field }) => <FeatureFlagsEditor defaults={record.flag_defaults} readOnly={editLevel !== 'full'} value={field.value} onChange={field.onChange} />} />
            </div>}
          </div>}
    </ScrollArea>}
  </section>;
}

function ModelsWorkspace({ detailSection, discovered, editableModels, modelSelection, modelsError, modelsLoading, onModelLocatorCommit, onModelSelectionChange, onOpenModel, onRefreshModels, onViewChange, onYamlDraftChange, readOnly, record, revealValidation, selectedUpstreamModelId, view, yamlDraft }: {
  detailSection: ModelDetailTab;
  discovered: UpstreamModelConfig[];
  // Catalog-level edit permission: the caller may set which listed models are
  // enabled and may refresh the catalog. Independent of the shape-based
  // restriction below, which is only about the provider owning the rows.
  editableModels: boolean;
  modelSelection: ModelSelection | null;
  modelsError: ModelListingFailure | null;
  modelsLoading: boolean;
  onModelLocatorCommit: (upstreamModelId: string) => void;
  onRefreshModels: () => void;
  onModelSelectionChange: (selection: ModelSelection) => void;
  onOpenModel: (selection: ModelSelection | null) => void;
  onViewChange: (view: ModelView) => void;
  onYamlDraftChange: (draft: ModelsYamlDraft | null) => void;
  // Shape-based read-only: this provider's catalog is owned by the upstream,
  // so rows cannot be added, removed, or edited structurally. Enabling or
  // disabling a listed model and refreshing the catalog are still edits the
  // caller may hold, so those follow editableModels.
  readOnly: boolean;
  record: UpstreamRecord;
  revealValidation: boolean;
  selectedUpstreamModelId: string | null;
  view: ModelView;
  yamlDraft: ModelsYamlDraft | null;
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
  const listLayout = useMediaQuery(MODEL_LIST_QUERY);
  const narrowItem = useNarrowListItemClass();
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
  const sessionRow = modelSelection
    ? rows.find(row => row.key === modelSelection.rowKey)
      ?? (modelSelection.manualIndex === null ? undefined : rows.find(row => row.manualIndex === modelSelection.manualIndex))
    : undefined;
  const selectedRow = sessionRow ?? rows.find(row => row.config.upstreamModelId === selectedUpstreamModelId) ?? null;
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
  const addModel = () => {
    const manualIndex = manual.length;
    append({
      upstreamModelId: '',
      kind: 'chat',
      ...shapeForKind('chat', { endpoints: {} }, record.kind),
      opaqueBlobCompatibilityScope: { bindToUpstream: true },
    });
    onOpenModel({ locator: '', manualIndex, rowKey: null });
  };
  useEffect(() => {
    if (view !== 'detail' || selectedUpstreamModelId === null || !activeDetailRow) return;
    if (modelSelection?.rowKey === activeDetailRow.key && modelSelection.manualIndex === activeDetailRow.manualIndex) return;
    onModelSelectionChange({ locator: selectedUpstreamModelId, manualIndex: activeDetailRow.manualIndex, rowKey: activeDetailRow.key });
  }, [activeDetailRow, modelSelection, onModelSelectionChange, selectedUpstreamModelId, view]);
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
      onModelSelectionChange({ locator: row.config.upstreamModelId, manualIndex: manual.length, rowKey: null });
      append(manualConfig);
      return;
    }
    if (source === 'auto' && row.manualIndex !== null && row.hasAuto) {
      onModelSelectionChange({ locator: row.config.upstreamModelId, manualIndex: null, rowKey: `auto:${row.config.upstreamModelId}` });
      remove(row.manualIndex);
    }
  };

  const deleteModel = (target: ModelRow & { manualIndex: number }) => {
    remove(target.manualIndex);
    if (selectedRow?.key === target.key) onOpenModel(null);
    deleteDialog.close();
  };

  const sourceLabel = (row: ModelRow) => t(`models.editor.${row.source}`);
  const openRow = (row: ModelRow) => onOpenModel({ locator: row.config.upstreamModelId, manualIndex: row.manualIndex, rowKey: row.key });
  const enabledSwitch = (row: ModelRow, id: string) => <Switch aria-label={t('models.editor.enabledFor', { name: row.config.display_name ?? id })} checked={!disabled.includes(id)} readOnly={!editableModels} onChange={(_, data) => setEnabled(id, data.checked)} />;
  const deleteButton = (row: ModelRow, id: string) => editableModels && !readOnly && row.manualIndex !== null && <TooltipIconButton danger icon={<DeleteRegular />} label={t('models.editor.deleteNamed', { name: row.config.display_name ?? id })} onClick={() => deleteDialog.open(row)} />;

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
    actionLabel={t('models.editor.deleteConfirm')}
    key={deleteDialog.invocation!.key}
    message={t('models.editor.deleteMessage', { name: manualDeleteTarget.config.display_name ?? publicModelId(manualDeleteTarget.config) })}
    onConfirm={() => deleteModel(manualDeleteTarget)}
    onOpenChange={open => { if (!open) deleteDialog.close(); }}
    title={t('models.editor.deleteTitle')}
  />;

  if (view === 'yaml') {
    const baseline = yamlDraft?.baseline ?? serializeModels(manual);
    const text = yamlDraft?.text ?? baseline;
    // A failed apply keeps the text as the draft, so the message stays attached
    // to the buffer that produced it.
    const applyAndLeave = () => {
      const parsed = parseModels(text, { allowRerank: record.kind === 'custom' });
      if (!parsed.ok) { onYamlDraftChange({ baseline, text, error: parsed.message }); return; }
      replace(parsed.models);
      onYamlDraftChange(null);
      onViewChange('list');
    };
    return <><div className="grid grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] h-full min-h-[480px] min-w-0">
      <div className="px-5 py-4">
        <SectionHeader
          description={t('models.editor.yamlHint')}
          level={2}
          title={t('models.editor.yamlTitle')}
          actions={<Button className="!min-w-[160px]" icon={<CheckmarkCircleRegular />} onClick={applyAndLeave}>
            {t('models.editor.editWithUi')}
          </Button>}
        />
      </div>
      <div className="h-full min-h-0 overflow-hidden border-0 border-y border-solid border-fui-divider">
        <Suspense fallback={<ContentLoadingScreen label={t('common.loading')} />}>
          <ModelsYamlEditor value={text} onChange={value => onYamlDraftChange({ baseline, text: value, error: null })} />
        </Suspense>
      </div>
      {yamlDraft?.error && <div className="px-5 py-3"><OutcomeMessageBar>{yamlDraft.error}</OutcomeMessageBar></div>}
    </div>{deleteConfirmation}</>;
  }

  if (view === 'detail' && activeDetailRow) return <><ModelDetail section={detailSection} row={activeDetailRow} readOnly={!editableModels || readOnly} revealValidation={revealValidation} onDelete={() => deleteDialog.open(activeDetailRow)} onSourceChange={source => setModelSource(activeDetailRow, source)} onUpstreamModelIdCommit={onModelLocatorCommit} onChange={value => {
    if (activeDetailRow.manualIndex === null) return;
    setValue(`manualModels.${activeDetailRow.manualIndex}`, value, {
      shouldDirty: true,
      shouldTouch: true,
    });
  }} record={record} upstreamFlags={upstreamFlags} />{deleteConfirmation}</>;

  return <><div className="grid grid-cols-[minmax(0,1fr)] gap-4 min-w-0">
    <SectionHeader
      description={t('models.editor.summary', { total: rows.length, manual: manual.length, auto: rows.length - manual.length })}
      level={2}
      title={t('models.editor.title')}
      actions={<>
        {editableModels && !readOnly && <Button appearance="primary" icon={<AddRegular />} onClick={addModel}>{t('models.editor.add')}</Button>}
        {editableModels && !readOnly && <Button className="!min-w-[160px]" icon={<CodeRegular />} onClick={() => onViewChange('yaml')}>{t('models.editor.editAsYaml')}</Button>}
        {record.kind !== 'azure' && <>
          <ModelsCacheStatus cache={record.modelsCache} />
          <Button disabled={!canFetch || !editableModels} disabledFocusable={modelsLoading} icon={modelsLoading ? <Spinner size="tiny" /> : <ArrowClockwiseRegular />} onClick={onRefreshModels}>{t('models.editor.refresh')}</Button>
        </>}
      </>}
    />
    {modelsError && <OutcomeMessageBar intent="warning">
      <div className="flex min-w-0 flex-col gap-2 whitespace-normal">
        <div className="flex min-w-0 items-start justify-between gap-2">
          <span className="min-w-0">{modelsError.upstreamResponse === null
            ? t('models.editor.listingFailedWithDetail', { message: modelErrorExcerpt(modelsError.message, MODEL_ERROR_EDITOR_LENGTH) })
            : t('models.editor.listingFailed')}</span>
          <TooltipIconButton
            className="flex-none"
            icon={copyOutcomeIcon(outcomeFor('models-error'))}
            label={copyLabel(outcomeFor('models-error'), t('models.editor.copyError'))}
            onClick={() => copy(modelsError.message, 'models-error')}
          />
        </div>
        {modelsError.upstreamResponse !== null && <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-[var(--winui-control-corner-radius)] border border-solid border-fui-stroke1 bg-fui-bg2 p-3 font-mono mono-size-xs">
          {`HTTP ${modelsError.upstreamResponse.status}\n${modelsError.upstreamResponse.headers.map(([name, value]) => `${name}: ${value}`).join('\n')}\n\n${modelErrorExcerpt(modelsError.upstreamResponse.body, MODEL_ERROR_EDITOR_LENGTH)}`}
        </pre>}
      </div>
    </OutcomeMessageBar>}
    <Input value={search} onChange={(_, data) => setSearch(data.value)} placeholder={t('models.editor.search')} />
    {listLayout ? filtered.length === 0
      ? <EmptyStateLine>{t('models.editor.noMatches')}</EmptyStateLine>
      // The same rows in the same order as the table. The row opens its model,
      // which the table offers through the name and the edit action; the
      // controls inside keep their own clicks.
      : <List aria-label={t('models.editor.title')} navigationMode="composite">
          {filtered.map(row => {
            const id = publicModelId(row.config);
            return <ListItem aria-label={row.config.display_name ?? id} className={narrowItem.item} key={row.key} onAction={() => openRow(row)}>
              <div className="flex items-center gap-3 min-w-0 w-full">
                <span className="flex-none" {...stopRowSelection}>{enabledSwitch(row, id)}</span>
                <div className="grid gap-0.5 min-w-0 flex-1">
                  <Text block truncate size={300} wrap={false}>{row.config.display_name ?? id}</Text>
                  <span className="flex items-center gap-1 min-w-0" {...stopRowSelection}>
                    <code className="block min-w-0 truncate leading-[var(--lineHeightBase300)]">{id}</code>
                    <TooltipIconButton className="flex-none" icon={copyOutcomeIcon(outcomeFor(id))} label={copyLabel(outcomeFor(id), t('models.editor.copy'))} onClick={() => copy(id, id)} />
                  </span>
                  <Text size={200} className="text-fui-fg3">{t(`models.editor.kindValue.${row.config.kind}`)} · {sourceLabel(row)}</Text>
                </div>
                <span className="flex flex-none items-center gap-1" {...stopRowSelection}>{deleteButton(row, id)}</span>
                <ChevronRightRegular aria-hidden="true" className="flex-none text-fui-fg3" fontSize={16} />
              </div>
            </ListItem>;
          })}
        </List>
      : <ScrollArea axes="horizontal" className="min-w-0">
          <Table aria-label={t('models.editor.title')} className="w-full min-w-[664px]">
            <TableColumns widths={['80px', '25%', '88px', null, '80px', TABLE_ACTIONS_WIDTH]} />
            <TableHeader><TableRow><TableCentredHeader>{t('models.editor.enabled')}</TableCentredHeader><TableHeaderCell>{t('models.editor.name')}</TableHeaderCell><TableCentredHeader>{t('models.editor.kind')}</TableCentredHeader><TableHeaderCell>{t('models.editor.id')}</TableHeaderCell><TableCentredHeader>{t('models.editor.source')}</TableCentredHeader><TableActionsHeader /></TableRow></TableHeader>
            <TableBody>{filtered.length === 0 ? <TableRow><TableCell colSpan={6}><EmptyStateLine>{t('models.editor.noMatches')}</EmptyStateLine></TableCell></TableRow> : filtered.map(row => {
              const id = publicModelId(row.config); return <TableRow className="h-14" key={row.key}>
                <TableCentredCell>{enabledSwitch(row, id)}</TableCentredCell>
                <TableCell className="overflow-hidden">
                  <TruncationTooltip content={row.config.display_name ?? id} relationship="label">
                    {measureRef => <RowTitleButton onClick={() => openRow(row)} ref={measureRef}>
                      {row.config.display_name ?? id}
                    </RowTitleButton>}
                  </TruncationTooltip>
                </TableCell>
                <TableCentredCell>{t(`models.editor.kindValue.${row.config.kind}`)}</TableCentredCell>
                <TableCell className="overflow-hidden"><span className="flex items-center gap-1 min-w-0 max-w-full"><TruncationTooltip content={id} relationship="label">{measureRef => <code className="winui-focus-rect block min-w-0 max-w-[calc(100%-36px)] truncate leading-[var(--lineHeightBase300)]" ref={measureRef} tabIndex={0}>{id}</code>}</TruncationTooltip><TooltipIconButton className="flex-none" icon={copyOutcomeIcon(outcomeFor(id))} label={copyLabel(outcomeFor(id), t('models.editor.copy'))} onClick={() => copy(id, id)} /></span></TableCell>
                <TableCentredCell>{sourceLabel(row)}</TableCentredCell>
                <TableCell><TableActions><TooltipIconButton icon={<EditRegular />} label={t('models.editor.editNamed', { name: row.config.display_name ?? id })} onClick={() => openRow(row)} />{deleteButton(row, id)}</TableActions></TableCell>
              </TableRow>;
            })}</TableBody>
          </Table>
        </ScrollArea>}
  </div>{deleteConfirmation}</>;
}

function ModelsCacheStatus({ cache }: { cache: UpstreamRecord['modelsCache'] }) {
  const { t } = useTranslation();
  const locale = useLocale();
  const now = useNow(10_000);
  const { copy, outcomeFor } = useCopyToClipboard();
  const copyLabel = useCopyLabel();
  const lastError = cache.lastError;
  const label = cache.fetchedAt === null
    ? t('models.editor.cacheNever')
    : now - cache.fetchedAt < 10_000
      ? t('models.editor.cacheFetchedNow')
      : t('models.editor.cacheFetched', {
          time: relativeTime(cache.fetchedAt, locale, { now }) ?? dateTime(cache.fetchedAt, locale),
        });
  const detail = lastError
    ? t('models.editor.cacheErrorDetail', { message: modelErrorExcerpt(lastError.message, MODEL_ERROR_EDITOR_LENGTH), time: dateTime(lastError.at, locale) })
    : cache.fetchedAt === null ? label : dateTime(cache.fetchedAt, locale);
  return <span className="inline-flex items-center gap-1">
    <Tooltip content={detail} relationship="description">
      <span className="winui-focus-rect inline-flex items-center gap-1 text-fui-fg2" tabIndex={0}>
        {lastError ? <WarningRegular /> : <CheckmarkCircleRegular />}
        <Text size={200}>{lastError ? t('models.editor.cacheFailed') : label}</Text>
      </span>
    </Tooltip>
    {lastError && <TooltipIconButton
      icon={copyOutcomeIcon(outcomeFor('cache-error'))}
      label={copyLabel(outcomeFor('cache-error'), t('models.editor.copyError'))}
      onClick={() => copy(lastError.message, 'cache-error')}
    />}
  </span>;
}
