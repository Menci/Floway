import { SaveRegular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { useBlocker, useNavigate, useSearchParams, type BlockerFunction } from 'react-router';
import { z } from 'zod';

import { UpstreamConfigSidebar } from './config-sidebar';
import { refineCustomIngressHeaderRules } from './custom-ingress-header-rules-validation';
import {
  canFetchModelCatalog,
  createBody,
  fetchSavedModelCatalog,
  hasUnsavedDiscoveryInputs,
  isPersisted,
  isOAuthUpstream,
  modelPrefixIsValid,
  modelsEditable,
  updateBody,
  valuesFromRecord,
  type ModelListingFailure,
  type UpstreamEditorLoaderData,
  type UpstreamEditorValues,
} from './data';
import { modelsAreValid } from './model-validation';
import { parseModels } from './models-yaml';
import { configSectionSearch, isConfigSectionError, UpstreamWorkspace, type ModelsYamlDraft } from './workspace';
import { api, callApi } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { canonicalJson } from '../../lib/canonical-json';
import { useEntryRewrite } from '../../lib/page-navigation';
import { useMediaQuery } from '../../lib/use-media-query';
import { BackNavigationButton } from '../ui/back-navigation-button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { PANE_GAP_CLASS, PINNED_CARD_FILL_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { Panel } from '../ui/panel';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useRefresh } from '../ui/use-refresh';

const { Button, Spinner, Text } = fluentComponents;

// Where the editor's two panes stop sitting side by side, which every
// max-[1050px] class below restates: UnoCSS reads class names from the source
// text, so the number cannot be composed into them.
const SINGLE_COLUMN_QUERY = '(max-width: 1050px)';

export function UpstreamEditorPage({ data }: { data: UpstreamEditorLoaderData }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  // One column has no room to keep the configuration beside the models, so it
  // becomes a section of the workspace instead of a pane stacked above it.
  const singleColumn = useMediaQuery(SINGLE_COLUMN_QUERY);
  const rewrite = useEntryRewrite();
  const toasts = useOutcomeToasts();
  const [record, setRecord] = useState(data.record);
  const editLevel = data.editLevel;
  // Audit-only access is a read of the record's configuration, not an edit at
  // level `off`; the editor has to withdraw every mutation control either way.
  const readOnly = editLevel === 'off' && data.audit;
  // Two provider patches can be in flight at once -- refreshing a credential
  // and probing a quota are separate buttons, neither disabling the other -- so
  // the second one's continuation holds the render the first was dispatched
  // from. The ref is written where the record is, so a patch merges into what
  // the previous one recorded rather than into what its own render captured.
  const recordRef = useRef(record);
  const updateRecord = useCallback((next: UpstreamRecord) => {
    recordRef.current = next;
    setRecord(next);
  }, []);
  const [discovered, setDiscovered] = useState(data.discovered);
  const catalogAvailable = discovered !== null;
  const [modelsError, setModelsError] = useState<ModelListingFailure | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [modelsYamlDraft, setModelsYamlDraft] = useState<ModelsYamlDraft | null>(null);
  // A create hands off to the created record's own route. The blocker reads the
  // form's saved state, so the hand-off is state rather than a call: naming the
  // id lets the navigation wait for the render that the save made clean instead
  // of racing it and having to be excused from the prompt.
  const [createdUpstreamId, setCreatedUpstreamId] = useState<string | null>(null);
  const [initialValues] = useState(() => valuesFromRecord(data.record));
  const schema = useMemo(() => z.object({
    name: z.string().trim().min(1, 'upstreams.editor.validation.name'),
    enabled: z.boolean(),
    usageRefreshIntervalMinutes: z.number({ error: 'upstreams.editor.usageRefresh.invalid' }).int('upstreams.editor.usageRefresh.invalid').nonnegative('upstreams.editor.usageRefresh.invalid'),
    hue: z.number(),
    proxyFallbackList: z.any(),
    modelPrefix: z.any(),
    disabledPublicModelIds: z.array(z.string()),
    flagOverrides: z.any(),
    config: z.any(),
    state: z.any(),
    manualModels: z.any(),
  }).superRefine((values, ctx) => {
    if (values.modelPrefix && !modelPrefixIsValid(values.modelPrefix.prefix)) ctx.addIssue({ code: 'custom', message: 'upstreams.editor.prefixInvalid', path: ['modelPrefix'] });
    if (values.modelPrefix?.addressable.length === 0) ctx.addIssue({ code: 'custom', message: 'upstreams.editor.validation.prefix', path: ['modelPrefix'] });
    if (!modelsAreValid(values.manualModels)) ctx.addIssue({ code: 'custom', message: 'upstreams.editor.validation.models', path: ['manualModels'] });
    if (record.kind === 'custom') {
      const config = values.config as Extract<UpstreamRecord, { kind: 'custom' }>['config'];
      refineCustomIngressHeaderRules(config.ingressHeadersRules, ctx);
    }
    // An upstream that already exists keeps the credential it was created
    // with, and the editor never sends it back.
    if (data.mode !== 'create') return;
    if (record.kind === 'copilot' && !values.config.githubToken) ctx.addIssue({ code: 'custom', message: 'upstreams.editor.validation.copilot', path: ['config'] });
    if ((record.kind === 'chatgpt' || record.kind === 'claude-code') && values.config.accounts.length === 0) ctx.addIssue({ code: 'custom', message: 'upstreams.editor.validation.credential', path: ['config'] });
  }), [data.mode, record.kind]);
  const form = useForm<UpstreamEditorValues>({
    defaultValues: initialValues,
    mode: 'onBlur',
    resolver: zodResolver(schema),
  });
  const { formState, getValues, handleSubmit, reset, setValue } = form;
  const hasPendingModelsYaml = modelsYamlDraft !== null && modelsYamlDraft.text !== modelsYamlDraft.baseline;
  const hasUnsavedChanges = formState.isDirty || hasPendingModelsYaml;

  // The editor carries its own position — workspace tab, selected model, model
  // section, YAML view — in the search params of one route, so a move between
  // any of those is this record still being edited, through another view of
  // itself. Only a change of pathname leaves the record and is worth a prompt.
  const blocker = useBlocker(useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => currentLocation.pathname !== nextLocation.pathname && hasUnsavedChanges,
    [hasUnsavedChanges],
  ));

  // Declared after the blocker so that within the commit the save produces, the
  // blocker is re-registered against the now-clean form before this runs.
  useEffect(() => {
    if (createdUpstreamId === null) return;
    void navigate(`/dashboard/providers/upstreams/${encodeURIComponent(createdUpstreamId)}`, rewrite);
  }, [createdUpstreamId, navigate, rewrite]);

  // Releasing the blocker commits the route change, which would unmount this
  // body-portaled dialog mid-exit. So confirm only closes it and the blocker is
  // released from the exit; a dismissal resets the blocker before that. The
  // blocker owns whether the navigation is held and the dialog only follows it,
  // which is what gives a close something to change rather than an unmount to
  // be removed by.
  const leaveDialog = useDialogInvocation<void>();
  const blocked = blocker.state === 'blocked';
  const [dialogFollowsBlocked, setDialogFollowsBlocked] = useState(blocked);
  if (dialogFollowsBlocked !== blocked) {
    setDialogFollowsBlocked(blocked);
    if (blocked) leaveDialog.open(); else leaveDialog.close();
  }

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [hasUnsavedChanges]);

  const manualModelsDirty = Boolean(formState.dirtyFields.manualModels);
  const discoveryInputsDirty = hasUnsavedDiscoveryInputs(formState.dirtyFields)
    || (record.kind === 'ollama' && manualModelsDirty);
  const oauth = isOAuthUpstream(record);
  const fetchDialog = useDialogInvocation<void>();
  // Save resets the form and record in one commit. The immediately following
  // Fetch must use that saved record even before React commits the new render.
  const savedFetchAfterSave = useRef<UpstreamRecord | null>(null);
  const { refresh: refreshModels, cancel: cancelModelsRefresh, refreshing: modelsLoading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setModelsError(null);
    const target = savedFetchAfterSave.current ?? recordRef.current;
    savedFetchAfterSave.current = null;
    const catalog = await fetchSavedModelCatalog(target, signal);
    if (signal.aborted) return;
    setModelsError(catalog.modelsError);
    if (catalog.discovered !== null) {
      setDiscovered(catalog.discovered);
    } else if (catalog.modelsCache?.fetchedAt === null) setDiscovered(null);
    if (catalog.modelsCache) updateRecord({ ...recordRef.current, modelsCache: catalog.modelsCache } as UpstreamRecord);
  }, [updateRecord]));

  // After creating an upstream (or opening one whose initial background refresh
  // has not populated the catalog yet), trigger one fetch on mount so the
  // models table fills without requiring a manual reload.
  const initialAutoFetchStarted = useRef(false);
  useEffect(() => {
    if (initialAutoFetchStarted.current) return;
    if (
      data.mode !== 'edit'
      || !modelsEditable(editLevel)
      || data.discovered !== null
      || data.record.modelsCache.fetchedAt !== null
      || data.record.modelsCache.lastError !== null
      || !canFetchModelCatalog(data.record, data.record.config)
    ) return;
    initialAutoFetchStarted.current = true;
    void refreshModels();
  }, [data.discovered, data.mode, data.record, editLevel, refreshModels]);

  const requestModels = () => {
    if (saving || !isPersisted(record)) return;
    if (discoveryInputsDirty) fetchDialog.open();
    else void refreshModels();
  };

  const applyProviderPatch = (patch: { config?: unknown; state?: unknown }, persisted = false) => {
    if (patch.config !== undefined) setValue('config', patch.config as UpstreamEditorValues['config'], { shouldDirty: !persisted });
    if (patch.state !== undefined) setValue('state', patch.state as UpstreamEditorValues['state'], { shouldDirty: !persisted });
    const changes = { ...(patch.config !== undefined ? { config: patch.config } : {}), ...(patch.state !== undefined ? { state: patch.state } : {}) };
    const patched = { ...recordRef.current, ...changes } as UpstreamRecord;
    updateRecord(patched);
    // A patch the provider has already stored is not an edit, so it moves the
    // saved state the form measures itself against instead of counting as one.
    // Everything but that baseline is held: the fields keep what the operator
    // has typed into them, and only the dirty flag is re-derived.
    if (persisted) reset(valuesFromRecord(patched), {
      keepDirtyValues: true,
      keepErrors: true,
      keepIsSubmitSuccessful: true,
      keepIsSubmitted: true,
      keepSubmitCount: true,
      keepTouched: true,
      keepValues: true,
    });
  };

  const submitForm = async (options?: { fetchAfterSave?: boolean }): Promise<UpstreamRecord | null> => {
    if (oauth && isPersisted(record) && (formState.dirtyFields.config || formState.dirtyFields.state)) {
      setSaveError(t('upstreams.editor.fetchDirty.unsavedCredential'));
      return null;
    }
    let yamlModelsChanged = false;
    if (modelsYamlDraft !== null) {
      const parsed = parseModels(modelsYamlDraft.text, { allowRerank: record.kind === 'custom' });
      if (!parsed.ok) {
        setModelsYamlDraft({ ...modelsYamlDraft, error: parsed.message });
        return null;
      }
      yamlModelsChanged = canonicalJson(parsed.models) !== canonicalJson(getValues('manualModels'));
      setValue('manualModels', parsed.models, { shouldDirty: true, shouldTouch: true });
      setModelsYamlDraft(null);
    }
    const invalidatesPendingFetch = hasUnsavedDiscoveryInputs(formState.dirtyFields) || manualModelsDirty || yamlModelsChanged;
    const invalidatesDiscovered = discoveryInputsDirty || (record.kind === 'ollama' && yamlModelsChanged);
    let savedRecord: UpstreamRecord | null = null;
    await handleSubmit(async values => {
      setSaving(true); setSaveError(null);
      // The dashboard's toaster sits above the outlet, so
      // the create branch's toast outlives the navigation that follows it.
      const handle = toasts.start(t('upstreams.editor.toast.saving', { name: values.name }));
      const result = data.mode === 'create'
        ? await callApi(() => api.api.upstreams.$post({ json: createBody(record, values) }))
        : await callApi(() => api.api.upstreams[':id'].$patch({ param: { id: record.id }, json: updateBody(record, values, editLevel === 'full' ? 'full' : 'models') }));
      if (result.error) { handle.settle(); setSaving(false); setSaveError(result.error.message); return; }
      const saved: UpstreamRecord = result.data;
      if (invalidatesPendingFetch) cancelModelsRefresh();
      updateRecord(saved);
      reset(valuesFromRecord(saved));
      if (invalidatesDiscovered) { setModelsError(null); setDiscovered(null); }
      handle.succeed(t('upstreams.editor.toast.saved'));
      savedRecord = saved;
      // `saving` stays set during the route handoff; the old form is still
      // mounted until navigation commits, and another Save would create twice.
      if (data.mode === 'create') {
        setCreatedUpstreamId(saved.id);
      } else {
        setSaving(false);
        if ((invalidatesDiscovered || options?.fetchAfterSave) && canFetchModelCatalog(saved, saved.config)) {
          savedFetchAfterSave.current = saved;
          void refreshModels();
        }
      }
    }, errors => {
      // Field rejections render on the control that produced them; the
      // page-level bar is only where a server says no.
      setSaveError(null);
      // Sectioned, the control that rejected may be on a section not shown.
      if (singleColumn && Object.keys(errors).some(isConfigSectionError)) setSearchParams(configSectionSearch(searchParams), rewrite);
    })();
    return savedRecord;
  };

  const saveButton = !readOnly && <Button appearance="primary" disabled={data.mode === 'edit' && !hasUnsavedChanges} disabledFocusable={saving} icon={saving ? <Spinner size="tiny" /> : <SaveRegular />} onClick={() => void submitForm()}>{t('upstreams.editor.actions.save')}</Button>;
  const unsavedNote = hasUnsavedChanges && <Text size={200} className="text-fui-fg2">{t('upstreams.editor.unsaved')}</Text>;
  const configSidebar = <UpstreamConfigSidebar
    catalogAvailable={catalogAvailable}
    discovered={discovered ?? []}
    onPatch={applyProviderPatch}
    editLevel={editLevel}
    proxies={data.proxies}
    record={record}
    runtime={data.runtime}
  />;
  const workspace = <UpstreamWorkspace configPane={singleColumn ? configSidebar : undefined} editLevel={editLevel} record={record} discovered={discovered ?? []} modelsLoading={modelsLoading} modelsError={modelsError} modelsYamlDraft={modelsYamlDraft} onModelsYamlDraftChange={setModelsYamlDraft} onRefreshModels={requestModels} />;

  return <FormProvider {...form}>
    {/* A column rather than a row template: the error bar is only sometimes
        there, and a named row for it leaves an empty one and a gap when it
        is not. */}
    {/* One column grows with its content and the page scrolls it: held to the
        viewport, the panes became two short windows each scrolling alone. */}
    <div className="flex flex-col gap-[14px] h-full min-h-0 max-[1050px]:h-auto">
      <header className="flex flex-wrap items-center gap-3 min-w-0">
        <BackNavigationButton to="/dashboard/providers/upstreams">{t('upstreams.editor.actions.back')}</BackNavigationButton>
        {!singleColumn && unsavedNote}
        {/* Disabled on a clean form only in edit mode: a create form opens on a
            prefilled blueprint and is clean at first render, yet still has
            something to send, and its credential gates are submit-time schema
            issues that only Save can raise. An invalid colour draft counts as a
            change, keeping the button live for the press that surfaces the
            field's own error. */}
        <div className="ml-auto flex items-center gap-2">
          {!singleColumn && saveButton}
        </div>
      </header>
      {saveError && <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>}
      {singleColumn
        // Clipped rather than hidden: a hidden overflow makes the panel the
        // scroll container its sticky section bar resolves against, and the
        // page, not the panel, is what scrolls here.
        ? <Panel className="min-w-0 !overflow-clip" padding="flush">{workspace}</Panel>
        : <div className={`grid grid-cols-[380px_minmax(0,1fr)] ${PANE_GAP_CLASS} min-h-0 min-w-0 flex-1 max-[1050px]:grid-cols-1 max-[1050px]:flex-none`}>
            <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
              {configSidebar}
            </Panel>
            <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
              {workspace}
            </Panel>
          </div>}
      {/* The header scrolls away with the page in one column, so Save follows
          the reader down instead, for as long as there is something to save
          or a save under way: a clean saved record leaves nothing for it.
          Held the page inset clear of the scrollport's bottom, which is where
          the page's own padding leaves it at rest, so it does not jump on
          reaching the end. `!` because Fluent's Card positions itself
          relative from a sheet injected after the utility sheet. */}
      {singleColumn && !readOnly && (data.mode !== 'edit' || hasUnsavedChanges || saving) && <Panel className={`!sticky bottom-[var(--floway-page-inset)] z-[1] !flex-row !items-center !justify-end !gap-3 min-w-0 ${PINNED_CARD_FILL_CLASS}`}>
        {unsavedNote}
        {saveButton}
      </Panel>}
    </div>
    {leaveDialog.invocation && <ConfirmDialog
      open={leaveDialog.isOpen}
      actionLabel={t('upstreams.editor.leave.leave')}
      cancelLabel={t('upstreams.editor.leave.stay')}
      key={leaveDialog.invocation.key}
      message={t('upstreams.editor.leave.message')}
      onCancel={() => blocker.state === 'blocked' && blocker.reset()}
      onConfirm={() => leaveDialog.close()}
      onExited={() => { if (blocker.state === 'blocked') blocker.proceed(); }}
      onOpenChange={open => { if (!open && blocker.state === 'blocked') blocker.reset(); }}
      title={t('upstreams.editor.leave.title')}
    />}
    {fetchDialog.invocation && <ConfirmDialog
      actionIntent="primary"
      actionLabel={t('upstreams.editor.fetchDirty.saveAndFetch')}
      key={fetchDialog.invocation.key}
      message={t('upstreams.editor.fetchDirty.message')}
      onConfirm={() => {
        fetchDialog.close();
        void submitForm({ fetchAfterSave: true });
      }}
      onOpenChange={open => { if (!open) fetchDialog.close(); }}
      open={fetchDialog.isOpen}
      title={t('upstreams.editor.fetchDirty.title')}
    />}
  </FormProvider>;
}
