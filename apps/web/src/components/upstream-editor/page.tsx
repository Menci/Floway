import { SaveRegular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormProvider, useForm } from 'react-hook-form';
import { useBlocker, useNavigate, type BlockerFunction } from 'react-router';
import { z } from 'zod';

import { UpstreamConfigSidebar } from './config-sidebar';
import {
  createBody,
  fetchModelCatalog,
  modelPrefixIsValid,
  updateBody,
  valuesFromRecord,
  type ModelListingFailure,
  type UpstreamEditorLoaderData,
  type UpstreamEditorValues,
} from './data';
import { modelsAreValid } from './model-detail';
import { UpstreamWorkspace } from './workspace';
import { api, callApi } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { useTranslation } from '../../i18n/translation';
import { useEntryRewrite } from '../../lib/page-navigation';
import { BackNavigationButton } from '../ui/back-navigation-button';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { PANE_GAP_CLASS } from '../ui/layout';
import { OutcomeMessageBar } from '../ui/outcome-message-bar';
import { useOutcomeToasts } from '../ui/outcome-toast';
import { Panel } from '../ui/panel';
import { useDialogInvocation } from '../ui/use-dialog-invocation';
import { useRefresh } from '../ui/use-refresh';

const { Button, Spinner, Text } = fluentComponents;

export function UpstreamEditorPage({ data }: { data: UpstreamEditorLoaderData }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const rewrite = useEntryRewrite();
  const toasts = useOutcomeToasts();
  const [record, setRecord] = useState(data.record);
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
  const [modelsError, setModelsError] = useState<ModelListingFailure | null>(data.modelsError);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // A create hands off to the created record's own route. The blocker reads the
  // form's saved state, so the hand-off is state rather than a call: naming the
  // id lets the navigation wait for the render that the save made clean instead
  // of racing it and having to be excused from the prompt.
  const [createdUpstreamId, setCreatedUpstreamId] = useState<string | null>(null);
  const [initialValues] = useState(() => valuesFromRecord(data.record));
  const schema = useMemo(() => z.object({
    name: z.string().trim().min(1, 'dashboard.upstreamEditor.validation.name'),
    enabled: z.boolean(),
    hue: z.number(),
    proxyFallbackList: z.any(),
    modelPrefix: z.any(),
    disabledPublicModelIds: z.array(z.string()),
    flagOverrides: z.any(),
    config: z.any(),
    state: z.any(),
    manualModels: z.any(),
  }).superRefine((values, ctx) => {
    if (values.modelPrefix && !modelPrefixIsValid(values.modelPrefix.prefix)) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.prefixInvalid', path: ['modelPrefix'] });
    if (values.modelPrefix?.addressable.length === 0) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.prefix', path: ['modelPrefix'] });
    if (!modelsAreValid(values.manualModels)) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.models', path: ['manualModels'] });
    // An upstream that already exists keeps the credential it was created
    // with, and the editor never sends it back.
    if (data.mode !== 'create') return;
    if (record.kind === 'copilot' && !values.config.githubToken) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.copilot', path: ['config'] });
    if ((record.kind === 'codex' || record.kind === 'claude-code') && values.config.accounts.length === 0) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.credential', path: ['config'] });
  }), [data.mode, record.kind]);
  const form = useForm<UpstreamEditorValues>({
    defaultValues: initialValues,
    mode: 'onBlur',
    resolver: zodResolver(schema),
  });
  const { formState, getValues, handleSubmit, reset, setValue } = form;
  const hasUnsavedChanges = formState.isDirty;

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

  // The workspace's refresh button and the custom provider's fetch switch both
  // reach this, so runs can overlap; `useRefresh` aborts the superseded one.
  const { refresh: refreshModels, refreshing: modelsLoading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    setModelsError(null);
    const catalog = await fetchModelCatalog(record, getValues(), { signal });
    if (signal.aborted) return;
    setModelsError(catalog.modelsError);
    if (catalog.discovered) setDiscovered(catalog.discovered);
    if (catalog.refreshed) updateRecord({ ...recordRef.current, modelsCache: catalog.refreshed.modelsCache } as UpstreamRecord);
  }, [getValues, record, updateRecord]));

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

  const submitForm = () => handleSubmit(async values => {
    setSaving(true); setSaveError(null);
    // A save is one round-trip on create and two on edit, so it announces
    // itself while it runs. The dashboard's toaster sits above the outlet, so
    // the create branch's toast outlives the navigation that follows it.
    const handle = toasts.start(t('dashboard.upstreamEditor.toast.saving', { name: values.name }));
    const result = data.mode === 'create'
      ? await callApi(() => api.api.upstreams.$post({ json: createBody(record, values) }))
      : await callApi(() => api.api.upstreams[':id'].$patch({ param: { id: record.id }, json: updateBody(record, values) }));
    if (result.error) { handle.settle(); setSaving(false); setSaveError(result.error.message); return; }
    let saved: UpstreamRecord = result.data;
    if (data.mode === 'edit') {
      const full = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }));
      if (!full.error) saved = full.data;
    }
    updateRecord(saved);
    reset(valuesFromRecord(saved));
    handle.succeed(t('dashboard.upstreamEditor.toast.saved'));
    // `saving` is left set on create: the created record's loader probes the
    // provider for its catalog, so the page stays mounted and interactive
    // across the hand-off, and a Save left live there posts a second create.
    if (data.mode === 'create') setCreatedUpstreamId(saved.id); else setSaving(false);
  }, () => {
    // Field rejections render on the control that produced them; the
    // page-level bar is only where a server says no.
    setSaveError(null);
  })();

  return <FormProvider {...form}>
    {/* A column rather than a row template: the error bar is only sometimes
        there, and a named row for it leaves an empty one and a gap when it
        is not. */}
    <div className="flex flex-col gap-[14px] h-full min-h-0">
      <header className="flex items-center gap-3 min-w-0">
        <BackNavigationButton to="/dashboard/providers/upstreams">{t('dashboard.upstreamEditor.actions.back')}</BackNavigationButton>
        {hasUnsavedChanges && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.unsaved')}</Text>}
        {/* Disabled on a clean form only in edit mode: a create form opens on a
            prefilled blueprint and is clean at first render, yet still has
            something to send, and its credential gates are submit-time schema
            issues that only Save can raise. An invalid colour draft counts as a
            change, keeping the button live for the press that surfaces the
            field's own error. */}
        <div className="ml-auto flex items-center gap-2">
          <Button appearance="primary" disabled={data.mode === 'edit' && !hasUnsavedChanges} disabledFocusable={saving} icon={saving ? <Spinner size="tiny" /> : <SaveRegular />} onClick={() => void submitForm()}>{t('dashboard.upstreamEditor.actions.save')}</Button>
        </div>
      </header>
      {saveError && <OutcomeMessageBar onDismiss={() => setSaveError(null)}>{saveError}</OutcomeMessageBar>}
      <div className={`grid grid-cols-[380px_minmax(0,1fr)] ${PANE_GAP_CLASS} min-h-0 min-w-0 flex-1 max-[1050px]:grid-cols-1`}>
        <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
          <UpstreamConfigSidebar
            catalogAvailable={modelsError === null}
            discovered={discovered}
            onPatch={applyProviderPatch}
            onRefreshModels={() => void refreshModels()}
            proxies={data.proxies}
            record={record}
            runtime={data.runtime}
          />
        </Panel>
        <Panel className="min-h-0 min-w-0 overflow-hidden" padding="flush">
          <UpstreamWorkspace record={record} discovered={discovered} modelsLoading={modelsLoading} modelsError={modelsError} onRefreshModels={() => void refreshModels()} />
        </Panel>
      </div>
    </div>
    {leaveDialog.invocation && <ConfirmDialog
      open={leaveDialog.isOpen}
      actionLabel={t('dashboard.upstreamEditor.leave.leave')}
      cancelLabel={t('dashboard.upstreamEditor.leave.stay')}
      key={leaveDialog.invocation.key}
      message={t('dashboard.upstreamEditor.leave.message')}
      onCancel={() => blocker.state === 'blocked' && blocker.reset()}
      onConfirm={() => leaveDialog.close()}
      onExited={() => { if (blocker.state === 'blocked') blocker.proceed(); }}
      onOpenChange={open => { if (!open && blocker.state === 'blocked') blocker.reset(); }}
      title={t('dashboard.upstreamEditor.leave.title')}
    />}
  </FormProvider>;
}
