import { SaveRegular } from '@fluentui/react-icons';
import { zodResolver } from '@hookform/resolvers/zod';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FormProvider, useForm, useWatch } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import { useBlocker, useNavigate } from 'react-router';
import { z } from 'zod';

import { UpstreamConfigSidebar } from './config-sidebar';
import {
  createBody,
  discoveredModelsFromResponse,
  modelPrefixIsValid,
  previewRecord,
  updateBody,
  valuesFromRecord,
  type UpstreamEditorLoaderData,
  type UpstreamEditorValues,
} from './editor-data';
import { modelsAreValid } from './model-detail';
import { UpstreamWorkspace } from './workspace';
import { api, callApi } from '../../api/client';
import type { UpstreamRecord } from '../../api/types';
import { fluentComponents } from '../../fluent';
import { pageNavigation } from '../../lib/page-navigation';
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
  const toasts = useOutcomeToasts();
  const [record, setRecord] = useState(data.record);
  const [discovered, setDiscovered] = useState(data.discovered);
  const [modelsError, setModelsError] = useState<string | null>(data.modelsError);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // The colour picker never writes a malformed hex into the form -- it holds
  // the half-typed draft itself and commits only what parses. The draft is
  // still an edit the operator made and expects saving to keep, so the page
  // holds the fact that one is outstanding: it is what the schema rejects on,
  // and what the leave prompt counts as an unsaved change.
  const [colorDraftInvalid, setColorDraftInvalid] = useState(false);
  const allowNavigation = useRef(false);
  const initialValues = valuesFromRecord(data.record);
  const [savedBaseline, setSavedBaseline] = useState(() => comparableValues(initialValues));
  const schema = useMemo(() => z.object({
    name: z.string().trim().min(1, 'dashboard.upstreamEditor.validation.name'),
    enabled: z.boolean(),
    color: z.any(),
    proxyFallbackList: z.any(),
    modelPrefix: z.any(),
    disabledPublicModelIds: z.array(z.string()),
    flagOverrides: z.any(),
    config: z.any(),
    state: z.any(),
    manualModels: z.any(),
  }).superRefine((values, ctx) => {
    if (colorDraftInvalid) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.color', path: ['color'] });
    if (values.modelPrefix && !modelPrefixIsValid(values.modelPrefix.prefix)) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.prefixInvalid', path: ['modelPrefix'] });
    if (values.modelPrefix?.addressable.length === 0) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.prefix', path: ['modelPrefix'] });
    if (!modelsAreValid(values.manualModels)) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.models', path: ['manualModels'] });
    // A credential is a create-time gate only: an upstream that already exists
    // keeps the one it was created with, and the editor never sends it back.
    if (data.mode !== 'create') return;
    if (record.kind === 'copilot' && !values.config.githubToken) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.copilot', path: ['config'] });
    if ((record.kind === 'codex' || record.kind === 'claude-code') && values.config.accounts.length === 0) ctx.addIssue({ code: 'custom', message: 'dashboard.upstreamEditor.validation.credential', path: ['config'] });
  }), [colorDraftInvalid, data.mode, record.kind]);
  const form = useForm<UpstreamEditorValues>({
    defaultValues: initialValues,
    mode: 'onBlur',
    resolver: zodResolver(schema),
  });
  const { control, getValues, handleSubmit, reset, setValue } = form;
  const currentValues = useWatch({ control }) as UpstreamEditorValues;
  const hasUnsavedChanges = comparableValues(currentValues) !== savedBaseline || colorDraftInvalid;

  const blocker = useBlocker(useCallback(
    () => hasUnsavedChanges && !allowNavigation.current,
    [hasUnsavedChanges],
  ));

  // The blocker owns whether the navigation is held; the dialog only follows
  // it, which is what gives a close something to change rather than an unmount
  // to be removed by. Following alone is not enough, though: releasing the
  // blocker on confirm commits the route change, and the route takes this
  // surface with it part-way through the exit -- the surface is portaled to the
  // body, where the page transition's held leaving frame does not cover it. So
  // confirming only closes the dialog, and the blocker is released once the
  // exit reports itself finished. A dismissal resets the blocker first, which
  // is what tells the two apart by then.
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

  // The listing is reachable from two controls -- the workspace's refresh
  // button and the custom provider's fetch switch -- so two runs can overlap
  // and the older one lands last. `useRefresh` is what the rest of the
  // dashboard uses for that: it aborts the superseded run at the transport,
  // owns the in-flight flag, and aborts on unmount.
  const { refresh: refreshModels, refreshing: modelsLoading } = useRefresh(useCallback(async (signal: AbortSignal) => {
    if (record.kind === 'azure') return;
    setModelsError(null);
    const values = getValues();
    const result = await callApi(() => api.api.upstreams['list-models'].$post({
      json: { record: previewRecord(record, values) },
    }, { init: { signal } }));
    if (signal.aborted) return;
    if (result.error) {
      setModelsError(result.error.message);
      return;
    }
    const endpoints = record.kind === 'custom' ? (values.config as typeof record.config).endpoints : {};
    setDiscovered(discoveredModelsFromResponse(result.data, endpoints));
    if (record.id !== '') {
      const refreshed = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }, { init: { signal } }));
      if (signal.aborted) return;
      if (refreshed.error) {
        setModelsError(refreshed.error.message);
      } else {
        setRecord(current => ({ ...current, modelsCache: refreshed.data.modelsCache } as UpstreamRecord));
      }
    }
  }, [getValues, record]));

  const applyProviderPatch = (patch: { config?: unknown; state?: unknown }, persisted = false) => {
    if (patch.config !== undefined) setValue('config', patch.config as UpstreamEditorValues['config'], { shouldDirty: !persisted });
    if (patch.state !== undefined) setValue('state', patch.state as UpstreamEditorValues['state'], { shouldDirty: !persisted });
    if (persisted) {
      setSavedBaseline(baseline => {
        const parsed = JSON.parse(baseline) as UpstreamEditorValues;
        if (patch.config !== undefined) parsed.config = patch.config as UpstreamEditorValues['config'];
        if (patch.state !== undefined) parsed.state = patch.state as UpstreamEditorValues['state'];
        return comparableValues(parsed);
      });
    }
    setRecord(current => ({ ...current, ...(patch.config !== undefined ? { config: patch.config } : {}), ...(patch.state !== undefined ? { state: patch.state } : {}) } as UpstreamRecord));
  };

  const submitForm = () => handleSubmit(async values => {
    setSaving(true); setSaveError(null);
    const result = data.mode === 'create'
      ? await callApi(() => api.api.upstreams.$post({ json: createBody(record, values) }))
      : await callApi(() => api.api.upstreams[':id'].$patch({ param: { id: record.id }, json: updateBody(record, values) }));
    // `saving` means a save is in progress, not that the write returned. What
    // follows the write is a second round trip in edit mode and a navigation in
    // create mode -- and the create route's loader probes the provider for its
    // catalog, so the page stays mounted and interactive for as long as that
    // takes. Clearing the flag here left Save live across that window with a
    // form the dirty gate no longer covers, and a second click there posts a
    // second create.
    if (result.error) { setSaving(false); setSaveError(result.error.message); return; }
    let saved: UpstreamRecord = result.data;
    if (data.mode === 'edit') {
      const full = await callApi(() => api.api.upstreams[':id'].$get({ param: { id: record.id } }));
      if (!full.error) saved = full.data;
    }
    setRecord(saved);
    const savedValues = valuesFromRecord(saved);
    setSavedBaseline(comparableValues(savedValues));
    reset(savedValues);
    // The dashboard's toaster sits above the outlet, so one call serves both
    // branches: the create branch's toast outlives the navigation that follows
    // it instead of having to be handed across to the page that lands.
    toasts.succeed(t('dashboard.upstreamEditor.toast.saved'));
    if (data.mode === 'create') {
      allowNavigation.current = true;
      // Left set: the editor unmounts when the target route commits, and the
      // button reads as busy for the whole hand-off rather than going live
      // again a beat before the page changes underneath it.
      void navigate(`/dashboard/providers/upstreams/${encodeURIComponent(saved.id)}`, { replace: true });
    } else {
      setSaving(false);
    }
  }, () => {
    // Every rejection is rendered on the control that produced it, so the
    // page-level bar stays what it is elsewhere: where a server says no.
    setSaveError(null);
  })();

  const leave = () => void navigate('/dashboard/providers/upstreams', pageNavigation);

  return <FormProvider {...form}>
    {/* A column rather than a row template: the error bar is only sometimes
        there, and a template that names a row for it leaves an empty one and a
        gap under everything else when it is not. */}
    <div className="flex flex-col gap-[14px] h-full min-h-0">
      <header className="flex items-center gap-3 min-w-0">
        <BackNavigationButton onClick={leave}>{t('dashboard.upstreamEditor.actions.back')}</BackNavigationButton>
        {hasUnsavedChanges && <Text size={200} className="text-fui-fg2">{t('dashboard.upstreamEditor.unsaved')}</Text>}
        {/* Save is the same flag the unsaved hint reads: with nothing to send
            it would post an identical payload, so it says so rather than doing
            it. An invalid colour draft counts as a change, which keeps the
            button live for the one press that surfaces the field's own error.
            Only in edit mode, where the baseline is the saved record. A create
            form opens on a prefilled blueprint and is therefore clean at first
            render, but "not dirty" there does not mean "nothing to send" -- and
            the credential gates are submit-time schema issues, so Save is the
            only thing that can raise them. */}
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
            onColorValidityChange={setColorDraftInvalid}
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

const comparableValues = (values: UpstreamEditorValues): string => JSON.stringify(values);
